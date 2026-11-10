import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { dispatchReports } from "./collector-fetch.js";
import { FrameworkCollector } from "./framework-collector.js";
import { frameworkMiddleware } from "./framework-middleware.js";
import { OrderedReporter } from "./ordered-reporter.js";
import { reportChunk, reportChunkLength } from "./report-chunks.js";
import { record, resultByteLimit } from "./protocol.js";
import type {
  ExpectedCase,
  FrameworkEvent,
  FrameworkTask,
  FrameworkUpdate,
} from "./framework-types.js";
import { largeAssertion } from "./fixtures/large-assertion.js";

type Body = { token: string } & (
  | { kind: "hello"; role: string; url: string }
  | { kind: "event"; event: FrameworkEvent }
  | { kind: "retire-ready" }
);
async function fixture(
  run: (value: {
    collector: FrameworkCollector;
    reporter: OrderedReporter<Body>;
    document: ReturnType<FrameworkCollector["expect"]>;
    send: (event: FrameworkEvent) => Promise<void>;
    bodies: string[];
  }) => Promise<void>,
  delivery: (response: Response, init: RequestInit) => Promise<Response> = async (response) =>
    response,
  cleanup: () => void = () => {},
) {
  const expected: ExpectedCase[] = Array.from({ length: 3 }, (_, index) => ({
    file: "original.test.ts",
    fullName: `case ${index}`,
    sourceKey: `original:${index}`,
    timeoutMs: 15000,
    retries: 0,
  }));
  const collector = new FrameworkCollector(expected);
  const document = collector.expect("tester", "http://fixture/tester");
  const middleware = frameworkMiddleware(collector);
  const server = createServer((request, response) =>
    middleware(request, response, () => response.writeHead(404).end()),
  );
  const bodies: string[] = [];
  let reporter: OrderedReporter<Body> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    reporter = new OrderedReporter<Body>(
      collector.run,
      async (url, init) => {
        bodies.push(String(init.body));
        return delivery(await fetch(`http://127.0.0.1:${address.port}${url}`, init), init);
      },
      500,
      { token: document.token, role: document.kind },
    );
    const active = reporter;
    const send = (event: FrameworkEvent) =>
      active.send({ token: document.token, kind: "event", event });
    await active.send({
      token: document.token,
      kind: "hello",
      role: document.kind,
      url: document.url,
    });
    document.admitted = true;
    collector.viewportConsumed = true;
    const tasks: FrameworkTask[] = expected.map((item, index) => ({
      ...item,
      id: String(index),
      parentId: null,
      type: "test",
      mode: "run",
    }));
    await send({ kind: "collected", tasks });
    await run({ collector, reporter: active, document, send, bodies });
  } finally {
    cleanup();
    reporter?.cancelDelivery("Test fixture cleanup");
    await reporter?.drain().catch(() => {});
    await reporter?.stop();
    collector.cancel();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
function settled(id: string, errors: FrameworkUpdate["errors"]): FrameworkUpdate {
  return { id, state: errors.length ? "fail" : "pass", errors, hooks: null, retryCount: 0 };
}
test("large assertion survives real reporter and framework HTTP collector before later real records", () =>
  fixture(async ({ collector, reporter, document, send, bodies }) => {
    const assertion = largeAssertion();
    const original = JSON.stringify(assertion);
    expect(new TextEncoder().encode(original).byteLength).toBeGreaterThan(285207);
    await send({ kind: "task-started", id: "0" });
    await send({ kind: "case-settled", updates: [settled("0", [assertion])] });
    await send({ kind: "task-started", id: "1" });
    await send({ kind: "case-settled", updates: [settled("1", [])] });
    expect(JSON.stringify(collector.cases[0]?.outcome?.errors[0])).toBe(original);
    expect(collector.cases[0]?.outcome?.state).toBe("fail");
    expect(collector.cases[1]?.started).toBe(true);
    expect(collector.cases[1]?.outcome?.state).toBe("pass");
    expect(collector.cases[2]?.started).toBe(false);
    expect(collector.cases[2]?.outcome).toBeNull();
    expect(collector.events.map((event) => event.kind)).toEqual([
      "collected",
      "task-started",
      "case-settled",
      "task-started",
      "case-settled",
    ]);
    expect(document.messages).toHaveLength(6);
    expect(reporter.observation.ackedThrough).toBe(5);
    expect(reporter.observation.pending).toBe(0);
    expect(reporter.signal.aborted).toBe(false);
    expect(collector.failures).toEqual([]);
    expect(
      bodies.every((body) => new TextEncoder().encode(body).byteLength <= resultByteLimit),
    ).toBe(true);
  }));

test("Unicode snapshot is frozen at call and lost chunk ACKs never reapply", async () => {
  const attempts: string[] = [];
  const lost = new Set<number>();
  await fixture(
    async ({ collector, reporter, document, send }) => {
      await send({ kind: "task-started", id: "0" });
      const assertion = largeAssertion();
      assertion.actual = '😀漢字\u0000"\\'.repeat(12000);
      const original = JSON.stringify(assertion);
      const sending = send({ kind: "case-settled", updates: [settled("0", [assertion])] });
      assertion.actual = "mutation after reporting call";
      const later = send({ kind: "task-started", id: "1" });
      await Promise.all([sending, later]);
      expect(JSON.stringify(collector.cases[0]?.outcome?.errors[0])).toBe(original);
      expect(collector.events.filter((event) => event.kind === "case-settled")).toHaveLength(1);
      expect(collector.cases[1]?.started).toBe(true);
      expect(document.messages).toHaveLength(5);
      expect(reporter.observation.ackedThrough).toBe(4);
      expect(reporter.observation.pending).toBe(0);
      expect(lost.size).toBe(2);
      expect(attempts.length - new Set(attempts).size).toBe(2);
      expect(
        attempts.every((body) => new TextEncoder().encode(body).byteLength <= resultByteLimit),
      ).toBe(true);
    },
    async (response, init) => {
      const text = String(init.body);
      const body = JSON.parse(text);
      attempts.push(text);
      if (body.kind !== "report-chunk" || lost.has(body.offset)) return response;
      if (body.offset !== 0 && body.offset + body.data.length !== body.length) return response;
      lost.add(body.offset);
      await response.arrayBuffer();
      throw new Error("Lost actual accepted ACK");
    },
  );
});

test("malformed intermediate ACKs fail closed and reject queued later real events", async () => {
  let chunks = 0;
  await fixture(
    async ({ collector, reporter, send }) => {
      await send({ kind: "task-started", id: "0" });
      const sending = send({ kind: "case-settled", updates: [settled("0", [largeAssertion()])] });
      const later = send({ kind: "task-started", id: "1" });
      const results = await Promise.allSettled([sending, later]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(reporter.signal.aborted).toBe(true);
      expect(reporter.observation.ackedThrough).toBe(2);
      expect(reporter.observation.pending).toBe(0);
      expect(collector.cases[0]?.outcome).toBeNull();
      expect(collector.cases[1]?.started).toBe(false);
      expect(chunks).toBeGreaterThan(0);
    },
    async (response, init) => {
      const body = JSON.parse(String(init.body));
      if (body.kind !== "report-chunk") return response;
      chunks++;
      // Refuse every ACK for this partial transfer, including replay, after real acceptance.
      await response.arrayBuffer();
      return Response.json({ ackedThrough: 99 });
    },
  );
});

test("retirement waits for the complete large event ACK and rejects requests after cutoff", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await fixture(
      async ({ collector, reporter, document, send }) => {
        await send({ kind: "task-started", id: "0" });
        const sending = send({ kind: "case-settled", updates: [settled("0", [largeAssertion()])] });
        await entered.promise;
        expect(collector.cases[0]?.outcome?.state).toBe("fail");
        expect(reporter.observation.ackedThrough).toBe(2);
        document.retiring = true;
        const retiring = reporter.send({ kind: "retire-ready", token: document.token });
        await Bun.sleep(0);
        expect(document.ready).toBe(false);
        expect(reporter.observation.pending).toBe(2);
        release.resolve();
        await Promise.all([sending, retiring]);
        expect(document.ready).toBe(true);
        expect(reporter.observation.pending).toBe(0);
        expect(reporter.observation.ackedThrough).toBe(4);
        document.cutoff = 4;
        const response = await reporter.post("/report", {
          method: "POST",
          body: document.messages[4],
        });
        expect(response.status).toBe(410);
        await response.arrayBuffer();
        expect(document.messages).toHaveLength(5);
      },
      async (response, init) => {
        const body = JSON.parse(String(init.body));
        if (body.kind === "report-chunk" && body.offset + body.data.length === body.length) {
          entered.resolve();
          await release.promise;
        }
        return response;
      },
      () => release.resolve(),
    );
  } finally {
    release.resolve();
  }
});

test("HTTP chunk sequence failure cancels collection instead of accepting a later event", () =>
  fixture(async ({ collector, reporter, document, send }) => {
    await send({ kind: "task-started", id: "0" });
    const identity = {
      run: collector.run,
      doc: reporter.observation.doc,
      seq: 3,
      token: document.token,
    };
    const encoded = JSON.stringify({
      ...identity,
      kind: "event",
      event: { kind: "case-settled", updates: [settled("0", [largeAssertion()])] },
    });
    const bytes = new TextEncoder().encode(encoded).byteLength;
    const first = await reporter.post("/report", {
      method: "POST",
      body: reportChunk(encoded, identity, bytes, 0),
    });
    expect(await first.json()).toEqual({ ackedThrough: 2, offset: reportChunkLength });
    const gap = await reporter.post("/report", {
      method: "POST",
      body: reportChunk(encoded, identity, bytes, 2 * reportChunkLength),
    });
    expect(gap.status).toBe(409);
    await gap.arrayBuffer();
    expect(collector.failures.some((failure) => failure.detail.includes("offset gap"))).toBe(true);
    await expect(send({ kind: "task-started", id: "1" })).rejects.toThrow();
    expect(reporter.observation.pending).toBe(0);
    expect(reporter.observation.ackedThrough).toBe(2);
    expect(collector.cases[0]?.outcome).toBeNull();
    expect(collector.cases[1]?.started).toBe(false);
    expect(document.messages).toHaveLength(3);
  }));

test("collector response observation sees the complete source event, never transport chunks", () =>
  fixture(async ({ collector, reporter, document, send }) => {
    await send({ kind: "task-started", id: "0" });
    const event: FrameworkEvent = {
      kind: "case-settled",
      updates: [settled("0", [largeAssertion()])],
    };
    const identity = {
      run: collector.run,
      doc: reporter.observation.doc,
      seq: 3,
      token: document.token,
    };
    const encoded = JSON.stringify({ ...identity, kind: "event", event });
    const bytes = new TextEncoder().encode(encoded).byteLength;
    const observed: FrameworkEvent[] = [];
    let last = "";
    for (let offset = 0; offset < encoded.length; offset += reportChunkLength) {
      expect(observed).toHaveLength(0);
      last = chunkWithEvent(reportChunk(encoded, identity, bytes, offset));
      const response = await dispatchReports(
        new Request("http://fixture/report", { method: "POST", body: last }),
        collector,
        (value) => observed.push(value.event),
      );
      expect(response?.status).toBe(200);
    }
    expect(observed).toEqual([event]);
    expect(document.messages).toHaveLength(4);
    const retry = await dispatchReports(
      new Request("http://fixture/report", { method: "POST", body: last }),
      collector,
      (value) => observed.push(value.event),
    );
    expect(retry?.status).toBe(200);
    expect(observed).toEqual([event, event]);
    expect(collector.events.filter((value) => value.kind === "case-settled")).toHaveLength(1);
  }));

test("chunk cancellation joins the actual held response before releasing queued events", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await fixture(
    async ({ collector, reporter, document, send }) => {
      await send({ kind: "task-started", id: "0" });
      const sending = send({ kind: "case-settled", updates: [settled("0", [largeAssertion()])] });
      const later = send({ kind: "task-started", id: "1" });
      const joining = Promise.allSettled([sending, later]);
      await entered.promise;
      collector.cancel();
      reporter.cancelDelivery("Actual chunk cancellation");
      await Bun.sleep(0);
      expect(reporter.observation.pending).toBe(2);
      expect(reporter.observation.ackedThrough).toBe(2);
      expect(document.messages).toHaveLength(3);
      release.resolve();
      expect((await joining).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(reporter.observation.pending).toBe(0);
      expect(reporter.observation.ackedThrough).toBe(2);
      expect(collector.cases[0]?.outcome).toBeNull();
      expect(collector.cases[1]?.started).toBe(false);
    },
    async (response, init) => {
      if (JSON.parse(String(init.body)).kind === "report-chunk") {
        entered.resolve();
        await release.promise;
      }
      return response;
    },
    () => release.resolve(),
  );
});

function chunkWithEvent(encoded: string): string {
  const chunk: unknown = JSON.parse(encoded);
  if (!record(chunk)) throw new Error("Missing transport chunk");
  return JSON.stringify({ ...chunk, event: { kind: "task-started", id: "never-applied" } });
}
