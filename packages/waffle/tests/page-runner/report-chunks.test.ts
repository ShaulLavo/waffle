import { expect, test } from "bun:test";
import {
  ReportChunks,
  reportChunk,
  reportChunkLength,
  reportEventByteLimit,
  reportQueuedByteLimit,
} from "./report-chunks.js";
import { OrderedReporter } from "./ordered-reporter.js";
import type { ReportStream } from "./report-stream.js";
import { resultByteLimit, type Body } from "./protocol.js";
import { Collector } from "./collector.js";
import { dispatchReports } from "./collector-fetch.js";

function stream(): ReportStream {
  return { messages: [], cutoff: null };
}
function wire(value = '😀漢字\\"\u0000'.repeat(14000), seq = 0) {
  const identity = { run: "run", doc: "doc", seq, token: "token" };
  const encoded = JSON.stringify({ ...identity, kind: "event", value });
  const bytes = new TextEncoder().encode(encoded).byteLength;
  const parts = Array.from({ length: Math.ceil(encoded.length / reportChunkLength) }, (_, index) =>
    JSON.parse(reportChunk(encoded, identity, bytes, index * reportChunkLength)),
  );
  return { encoded, parts, bytes };
}

test("intermediate ACKs do not advance events, replay compares every original byte", () => {
  const receiver = new ReportChunks();
  const source = stream();
  const { encoded, parts, bytes } = wire();
  let applied = 0;
  const apply = () => applied++;
  const first = parts[0];
  expect(receiver.receive(source, first, apply)).toEqual({
    ackedThrough: -1,
    offset: reportChunkLength,
  });
  expect(receiver.receive(source, first, apply)).toEqual({
    ackedThrough: -1,
    offset: reportChunkLength,
  });
  expect(receiver.pendingBytes).toBe(bytes);
  expect(source.messages).toEqual([]);
  expect(applied).toBe(0);
  for (const part of parts.slice(1)) receiver.receive(source, part, apply);
  expect(applied).toBe(1);
  expect(source.messages).toEqual([encoded]);
  expect(receiver.pendingBytes).toBe(0);
  for (const part of parts) receiver.receive(source, part, apply);
  expect(applied).toBe(1);
  expect(() =>
    receiver.receive(source, { ...first, data: "x".repeat(reportChunkLength) }, apply),
  ).toThrow("replay conflict");
  const next = { run: "run", doc: "doc", seq: 1, kind: "later" };
  expect(receiver.receive(source, next, apply)).toEqual({ ackedThrough: 1 });
  expect(applied).toBe(2);
});

for (const fault of [
  "gap",
  "conflict",
  "metadata",
  "interrupt",
  "cutoff",
  "identity",
  "bytes",
  "apply",
] as const) {
  test(`chunk ${fault} is rejected without committing and releases partial memory`, () => {
    const receiver = new ReportChunks();
    const source = stream();
    const { parts } = wire();
    let applied = 0;
    const apply = () => {
      if (fault === "apply") throw new Error("apply refused");
      applied++;
    };
    receiver.receive(source, parts[0], apply);
    let invalid: unknown;
    if (fault === "gap") invalid = parts[2];
    if (fault === "conflict") invalid = { ...parts[0], data: "x".repeat(reportChunkLength) };
    if (fault === "metadata") invalid = { ...parts[1], length: parts[1].length + 1 };
    if (fault === "interrupt") invalid = { kind: "later", seq: 0 };
    if (fault === "cutoff") {
      source.cutoff = -1;
      invalid = parts[1];
    }
    if (fault === "identity" || fault === "bytes" || fault === "apply") {
      for (const part of parts.slice(1, -1)) receiver.receive(source, part, apply);
      invalid = parts.at(-1);
      if (fault === "identity") invalid = { ...parts.at(-1), token: "other" };
      if (fault === "bytes") invalid = { ...parts.at(-1), bytes: parts.at(-1).bytes + 1 };
    }
    expect(() => receiver.receive(source, invalid, apply)).toThrow();
    expect(source.messages).toEqual([]);
    expect(applied).toBe(0);
    expect(receiver.pendingBytes).toBe(0);
  });
}

test("collector reserves finite aggregate bytes and cancellation clears all incomplete documents", () => {
  const receiver = new ReportChunks();
  const { parts } = wire("x".repeat(reportEventByteLimit - 100));
  const apply = () => {
    throw new Error("Incomplete report applied");
  };
  receiver.receive(stream(), parts[0], apply);
  receiver.receive(stream(), parts[0], apply);
  expect(receiver.pendingBytes).toBeLessThanOrEqual(reportQueuedByteLimit);
  expect(() => receiver.receive(stream(), parts[0], apply)).toThrow("capacity");
  receiver.clear();
  expect(receiver.pendingBytes).toBe(0);
  expect(() =>
    receiver.receive(stream(), { ...parts[0], bytes: reportEventByteLimit + 1 }, apply),
  ).toThrow("budget");
});

test("raw oversized envelopes are still refused, and stream retention has a finite budget", () => {
  const receiver = new ReportChunks();
  const source = stream();
  const apply = () => {};
  expect(() =>
    receiver.receive(source, { seq: 0, value: "x".repeat(resultByteLimit) }, apply),
  ).toThrow("48 KiB");
  for (let seq = 0; seq < 8; seq++) {
    const event = wire("x".repeat(reportEventByteLimit - 100), seq);
    for (const part of event.parts) receiver.receive(source, part, apply);
  }
  expect(() => {
    for (const part of wire("x".repeat(reportEventByteLimit - 100), 8).parts)
      receiver.receive(source, part, apply);
  }).toThrow("stream byte budget");
  expect(source.messages).toHaveLength(8);
  expect(receiver.pendingBytes).toBe(0);
});

test("reporter byte capacity preserves its prefix, snapshots no later event, and drains owned buffers", async () => {
  const gate = Promise.withResolvers<void>();
  let posts = 0;
  const reporter = new OrderedReporter<object>("run", async (_url, init) => {
    posts++;
    await gate.promise;
    const body = JSON.parse(String(init.body));
    const offset = body.offset + body.data.length;
    return Response.json({
      ackedThrough: offset === body.length ? body.seq : body.seq - 1,
      offset,
    });
  });
  const large = { value: "x".repeat(3 * 1024 * 1024) };
  const pending = [reporter.send(large), reporter.send(large)];
  let reads = 0;
  try {
    await expect(reporter.send(large)).rejects.toThrow("byte capacity");
    expect(reporter.observation.pending).toBe(2);
    await expect(
      reporter.sendSnapshot(() => {
        reads++;
        return {};
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  } finally {
    gate.resolve();
    await Promise.all(pending);
    await reporter.stop();
  }
  expect(posts).toBeGreaterThan(2);
  expect(reporter.observation.pending).toBe(0);
  expect(reporter.observation.ackedThrough).toBe(1);
});

test("event application may cancel its collector without double-releasing assembly memory", () => {
  const receiver = new ReportChunks();
  const source = stream();
  const { parts } = wire();
  for (const part of parts) receiver.receive(source, part, () => receiver.clear());
  expect(receiver.pendingBytes).toBe(0);
  expect(source.messages).toHaveLength(1);
});

test("chunks share the original event retry deadline rather than renewing it", async () => {
  let elapsed = 0;
  let posts = 0;
  const reporter = new OrderedReporter<object>(
    "run",
    async (_url, init) => {
      posts++;
      const body = JSON.parse(String(init.body));
      elapsed = 2;
      return Response.json({ ackedThrough: -1, offset: body.offset + body.data.length });
    },
    1,
  );
  reporter.clock.now = () => elapsed;
  await expect(reporter.send({ value: "x".repeat(resultByteLimit) })).rejects.toThrow(
    "acknowledgement lost",
  );
  expect(posts).toBe(1);
  expect(reporter.observation.ackedThrough).toBe(-1);
  expect(reporter.observation.pending).toBe(0);
  expect(reporter.signal.aborted).toBe(true);
  await reporter.stop();
});

test("ordinary shared reporter and collector keep full failed-case text and subsequent events", async () => {
  const ids = ["first", "later"];
  const collector = new Collector("run", ids, ids, { listIds: () => ids, check() {} });
  const document = collector.expect(
    { id: "cases", role: "case", caseIds: ids },
    "token",
    "http://fixture/",
    "root",
  );
  const sink = {
    receive: collector.receive.bind(collector),
    heartbeat: collector.heartbeat.bind(collector),
    retirement() {
      throw new Error("Unexpected retirement in shared caller control");
    },
    fail: collector.fail.bind(collector),
  };
  const reporter = new OrderedReporter<Body>(collector.run, async (url, init) => {
    const response = await dispatchReports(new Request(`http://fixture${url}`, init), sink);
    if (!response) throw new Error("Missing collector route");
    return response;
  });
  const error = "original assertion 😀漢字\n".repeat(20000);
  try {
    await reporter.send({ kind: "hello", token: "token", group: "cases" });
    await reporter.send({ kind: "case-start", caseId: "first" });
    await reporter.send({ kind: "case-end", caseId: "first", status: "fail", error });
    await reporter.send({ kind: "case-start", caseId: "later" });
    await reporter.send({ kind: "case-end", caseId: "later", status: "pass" });
    expect(collector.outcomes.first).toEqual({ status: "fail", detail: error });
    expect(collector.outcomes.later).toEqual({ status: "pass", provisional: true });
    expect(document.messages).toHaveLength(5);
    expect(reporter.observation.ackedThrough).toBe(4);
    expect(reporter.observation.pending).toBe(0);
    expect(collector.failures).toEqual([]);
  } finally {
    reporter.cancelDelivery("CPU shared caller cleanup");
    await reporter.drain().catch(() => {});
    await reporter.stop();
    collector.cancel();
  }
});
