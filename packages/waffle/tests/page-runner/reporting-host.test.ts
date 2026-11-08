import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PageFrameworkHost } from "./framework-host.js";
import { OrderedReporter } from "./ordered-reporter.js";
import { record } from "./protocol.js";
import { waitUntil } from "./reporting-fixture.js";

for (const origin of ["capacity-heartbeat", "collector"] as const) {
  test(`actual host ${origin} fault cancels a held root without a queued probe and joins its physical owner`, async () => {
    const root = await mkdtemp(
      join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-reporting-host-"),
    );
    const previous = process.env.STORAGE_SCRATCH_ROOT;
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const holdAck = Promise.withResolvers<void>();
    const host = new PageFrameworkHost({
      suite: "reporting-cpu",
      native: { udid: "not-launched" },
      expected: [
        { file: "synthetic.ts", fullName: "cpu", sourceKey: "cpu:1", timeoutMs: 15000, retries: 0 },
      ],
      scope: { kind: "root-selection", command: "test:browser", files: ["synthetic.ts"] },
      resultPath: join(root, "result.json"),
    });
    const server = createServer((request, response) =>
      host.middleware(request, response, () => {
        response.writeHead(404);
        response.end();
      }),
    );
    let running: ReturnType<PageFrameworkHost["run"]> | undefined;
    let reporter:
      | OrderedReporter<{ token: string; kind: string; role?: string; url?: string }>
      | undefined;
    const pending: Promise<void>[] = [];
    let closed = false,
      settled = false,
      request: RequestInit | undefined,
      physicalDone = false;
    try {
      process.env.STORAGE_SCRATCH_ROOT = root;
      server.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing CPU listener");
      host.mount({ stack: [], use() {} });
      let config: Record<string, unknown> | undefined;
      running = host.run(async (registerClose) => {
        registerClose(async () => {
          closed = true;
          await release.promise;
        });
        const html = host.instrumentDocument({
          kind: "tester",
          url: "http://fixture/tester",
          html: "<head></head>",
        });
        const encoded = html.match(/__waffleFrameworkConfiguration=(\{[^\n]+\});/u)?.[1];
        const value: unknown = encoded && JSON.parse(encoded);
        if (!record(value)) throw new Error("Missing actual instrumented identity");
        config = value;
        await host
          .provider("framework-cleanup", async () => {
            request = host.guardRequest<RequestInit>({});
            entered.resolve();
            await release.promise;
            host.observeResponse({ statusCode: 200, body: { value: null } }, request);
            physicalDone = true;
          })
          .catch(() => {});
        return { status: "interrupted", errors: ["CPU infrastructure negative"] };
      });
      void running.finally(() => {
        settled = true;
      });
      await entered.promise;
      if (!config || typeof config.run !== "string" || typeof config.token !== "string")
        throw new Error("Missing identity");
      const token = config.token;
      let hold = false;
      reporter = new OrderedReporter(
        config.run,
        async (url, init) => {
          if (hold && url === "/report") await holdAck.promise;
          return fetch(`http://127.0.0.1:${address.port}${url}`, init);
        },
        undefined,
        { token, role: "tester" },
      );
      await reporter.send({ token, kind: "hello", role: "tester", url: "http://fixture/tester" });
      if (origin === "capacity-heartbeat") {
        hold = true;
        // Hold the actual page transport before host acceptance. Heartbeat bypasses this occupied lane.
        for (let index = 0; index < 64; index++)
          pending.push(
            reporter.sendSnapshot(() => ({ token, kind: "retire-ready" })).catch(() => {}),
          );
        await expect(reporter.send({ token, kind: "retire-ready" })).rejects.toThrow("capacity");
        reporter.startHeartbeat(2);
      } else {
        const malformed = await fetch(`http://127.0.0.1:${address.port}/report`, {
          method: "POST",
          body: "{",
        });
        expect(malformed.status).toBe(409);
        reporter.startHeartbeat(2);
      }
      await waitUntil(() => closed);
      expect(request?.signal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(physicalDone).toBe(false);
      expect((await readdir(root)).some((entry) => entry.startsWith("waffle-framework-"))).toBe(
        true,
      );
      await waitUntil(() => reporter?.signal.aborted === true);
      expect(reporter.signal.aborted).toBe(true);
      release.resolve();
      holdAck.resolve();
      await Promise.all(pending);
      const result = await running;
      expect(result.exit).toBe(2);
      expect(result.fileComplete).toBe(false);
      expect(physicalDone).toBe(true);
      expect(result.cleanup.callbacks.status).toBe("confirmed");
      expect(result.cleanup.context.status).toBe("confirmed");
      expect(result.cleanup.scratch.status).toBe("confirmed");
      if (origin === "capacity-heartbeat")
        expect(result.failures.filter((item) => item.category === "page-reporting")).toHaveLength(
          1,
        );
    } finally {
      release.resolve();
      holdAck.resolve();
      reporter?.stop();
      await Promise.all(pending);
      if (running) {
        await host.abort("CPU fixture teardown");
        await running;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.STORAGE_SCRATCH_ROOT;
      else process.env.STORAGE_SCRATCH_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
