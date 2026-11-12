import { expect, test } from "bun:test";
import { Collector } from "./collector.js";
import { dispatchReports } from "./collector-fetch.js";
import { OrderedReporter } from "./ordered-reporter.js";
import type { Body } from "./protocol.js";

async function control(
  mode: "live" | "unbound" | "timeout" | "malformed",
  use: (reporter: OrderedReporter<Body>, collector: Collector, requests: string[]) => Promise<void>,
): Promise<void> {
  const collector = new Collector("control-run", [], [], { listIds: () => [], check() {} });
  collector.expect({ id: "list", role: "list", caseIds: [] }, "token", "http://fixture/", "root");
  const held = Promise.withResolvers<Response>();
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/heartbeat" && mode === "timeout") return held.promise;
      if (path === "/heartbeat" && mode === "malformed")
        return new Response("PRIVATE_RESPONSE_CANARY");
      return (
        (await dispatchReports(request, {
          receive: (body) => collector.receive(body),
          heartbeat: (body) => collector.heartbeat(body),
          retirement: () => collector.reply(),
          fail: (category, detail) => collector.fail(category, detail),
        })) ?? new Response(null, { status: 404 })
      );
    },
  });
  const reporter = new OrderedReporter<Body>("control-run", (url, init) =>
    fetch(new URL(url, server.url), init),
  );
  try {
    if (mode !== "unbound") await reporter.send({ kind: "hello", token: "token", group: "list" });
    await use(reporter, collector, requests);
  } finally {
    held.resolve(Response.json({ kind: "live", retire: false }));
    await reporter.stop();
    await server.stop(true);
  }
}

for (const mode of ["unbound", "timeout", "malformed"] as const) {
  test(`heartbeat control failure retains request evidence for ${mode}`, () =>
    control(mode, async (reporter, collector, requests) => {
      const aborted = Promise.withResolvers<void>();
      reporter.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      reporter.startHeartbeat();
      await aborted.promise;
      await reporter.stop();
      expect(reporter.observation.failure).toBe(
        mode === "timeout" ? "Collector heartbeat failed" : "Invalid collector control reply",
      );
      expect(reporter.observation.controlFailure).toMatchObject({
        run: "control-run",
        doc: reporter.observation.doc,
        method: "POST",
        path: "/heartbeat",
        phase: mode === "timeout" ? "transport" : "reply",
        status: mode === "timeout" ? null : mode === "unbound" ? 409 : 200,
        abort: mode === "timeout" ? expect.stringContaining("TimeoutError") : null,
        error: expect.stringContaining(
          mode === "timeout" ? "TimeoutError" : "Invalid collector control reply",
        ),
      });
      expect(requests.filter((path) => path === "/heartbeat")).toHaveLength(1);
      expect(reporter.controlsPending).toBe(0);
      expect(JSON.stringify(reporter.observation.controlFailure)).not.toContain(
        "PRIVATE_RESPONSE_CANARY",
      );
      expect(collector.failures.map((failure) => failure.category)).toEqual(
        mode === "unbound" ? ["protocol"] : [],
      );
      const first = reporter.observation.controlFailure;
      await expect(
        reporter.control("/retire?doc=private-query", { method: "POST" }),
      ).rejects.toThrow("Invalid collector control reply");
      expect(reporter.observation.controlFailure).toBe(first);
    }));
}

test("a healthy heartbeat and collector cancellation do not fabricate a request failure", () =>
  control("live", async (reporter, collector) => {
    const init = {
      method: "POST",
      body: JSON.stringify({
        kind: "heartbeat",
        run: reporter.run,
        doc: reporter.observation.doc,
        failure: null,
      }),
      signal: AbortSignal.timeout(1500),
    };
    expect(await reporter.control("/heartbeat", init)).toEqual({ kind: "live", retire: false });
    collector.abandon("control cancellation");
    expect(await reporter.control("/heartbeat", init)).toEqual({ kind: "cancelled" });
    expect(reporter.observation.failure).toBe("Collector cancelled reporting");
    expect(reporter.observation.controlFailure).toBeNull();
  }));

test("diagnostic formatting cannot replace the original control rejection", async () => {
  const rejected = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("diagnostic inspection refused");
      },
    },
  );
  const reporter = new OrderedReporter("control-run", async () => {
    throw rejected;
  });
  await expect(reporter.control("/heartbeat", { method: "POST" })).rejects.toBe(rejected);
  expect(reporter.controlsPending).toBe(0);
});
