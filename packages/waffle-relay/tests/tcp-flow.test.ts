import { afterEach, expect, test } from "bun:test";
import { TcpFlow, type FrameTransport, type CleanupBudget } from "../src/tcp-flow.js";
import { StreamFrameDecoder, encodeStreamFrame } from "../src/tcp-frame-stream.js";
import { ByteChannel } from "../src/tcp-byte-channel.js";
import { createRelayConnect } from "../src/tcp-client.js";
import { tcpPolicy } from "../src/tcp-policy.js";
import {
  TcpFailure,
  checkedWindow,
  encodeOpenHeader,
  frameData,
  frameCredit,
  parseFrame,
  parseOpen,
  parseReply,
} from "../src/tcp-protocol.js";

const owned = new Set<TcpFlow>();
afterEach(async () => {
  await Promise.allSettled(
    Array.from(owned, (flow) => flow.reset(new Error("fixture cleanup"), 1)),
  );
  owned.clear();
});
function makeFlow(receiveWindow = 16384, sendWindow = 65536, transport?: FrameTransport) {
  const flow = new TcpFlow(
    receiveWindow,
    sendWindow,
    transport ?? {
      kind: "webtransport",
      write: async (_frame, handoff) => handoff(),
      finish: async () => {},
      reset: async () => {},
    },
  );
  owned.add(flow);
  return flow;
}
const tick = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
const remote = { address: "8.8.8.8", port: 80, family: "IPv4" } as const;
const request = { v: 1, token: "page-only", host: "echo.example", port: 80 } as const;
function joined(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of parts) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}
function pair(kind: FrameTransport["kind"]) {
  const transport = (peer: () => TcpFlow): FrameTransport => ({
    kind,
    async write(frame, handoff) {
      handoff();
      if (kind === "webtransport") new StreamFrameDecoder(peer()).push(encodeStreamFrame(frame));
      else
        peer().receive(
          parseFrame(
            frame.kind === "data"
              ? frameData(frame.bytes)
              : frame.kind === "credit"
                ? frameCredit(frame.bytes)
                : Uint8Array.of(1),
          ),
        );
    },
    finish: async () => {},
    reset: async () => {},
  });
  const left = makeFlow(
    16384,
    65536,
    transport(() => right),
  );
  const right = makeFlow(
    65536,
    16384,
    transport(() => left),
  );
  return { left, right };
}
function conservation(sender: TcpFlow, receiver: TcpFlow): void {
  const s = sender.counters;
  const r = receiver.counters;
  expect(s.sendOutstandingBytes).toBe(s.payloadHandedToCarrier - s.creditApplied);
  expect(r.receiveQueuedBytes).toBe(r.payloadReceived - r.consumerReleased);
  expect(r.consumerReleased).toBe(s.creditApplied + r.creditPending);
  expect(s.payloadHandedToCarrier).toBe(r.payloadReceived);
  expect(s.sendOutstandingBytes).toBe(r.receiveQueuedBytes + r.creditPending);
}

test("both local options and remote headers require an integer receive window", () => {
  for (const window of [undefined, 0, 16383, 262145, 16384.5, NaN, Infinity]) {
    expect(() => checkedWindow(window)).toThrow(TcpFailure);
    expect(() => parseOpen(JSON.stringify({ ...request, window }))).toThrow(TcpFailure);
    expect(() => parseReply(JSON.stringify({ v: 1, ok: true, remote, window }))).toThrow(
      TcpFailure,
    );
  }
  for (const windowBytes of [0, 16383, 262145, 16384.5]) {
    expect(() =>
      createRelayConnect({ endpoint: "https://relay.example", getToken: () => "", windowBytes }),
    ).toThrow();
    expect(() =>
      tcpPolicy({ tokenSecret: new Uint8Array(32), destinations: [], limits: { windowBytes } }, [
        "https://page.example",
      ]),
    ).toThrow();
  }
  expect(parseOpen(JSON.stringify({ ...request, window: 16384 })).window).toBe(16384);
  expect(parseReply(JSON.stringify({ v: 1, ok: true, remote, window: 65536 }))).toHaveProperty(
    "window",
    65536,
  );
});

test("WT decodes every split and merged DATA, CREDIT and FIN without borrowed payload", async () => {
  const wire = joined([
    encodeStreamFrame({ kind: "data", bytes: Uint8Array.of(11, 12, 13) }),
    frameCredit(3),
    Uint8Array.of(1),
  ]);
  for (let split = 0; split <= wire.length; split++) {
    const flow = makeFlow();
    flow.state.send(3);
    const decoder = new StreamFrameDecoder(flow);
    const input = wire.slice();
    decoder.push(input.subarray(0, split));
    decoder.push(input.subarray(split));
    input.fill(99);
    decoder.eof();
    expect(Array.from((await flow.read())!)).toEqual([11, 12, 13]);
    expect(flow.counters.creditApplied).toBe(3);
    flow.consume(3);
    expect(await flow.read()).toBeUndefined();
  }
});

test("request header rest rejects before admission, client ok rest enters frames", async () => {
  const payload = encodeStreamFrame({ kind: "data", bytes: Uint8Array.of(4, 5) });
  const channel = (bytes: Uint8Array) =>
    new ByteChannel(
      {
        readable: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        writable: new WritableStream(),
      },
      (code) => ({ code }),
      16384,
    );
  const server = channel(joined([encodeOpenHeader({ ...request, window: 16384 }), payload]));
  try {
    await expect(server.header(8192, false)).rejects.toBeInstanceOf(TcpFailure);
  } finally {
    await server.reset(3);
    server.release();
  }
  const client = channel(
    joined([
      encodeOpenHeader({ v: 1, ok: true, remote, window: 65536 }),
      payload,
      Uint8Array.of(1),
    ]),
  );
  try {
    expect(parseReply(await client.header(8192, true))).toHaveProperty("ok", true);
    const flow = makeFlow();
    const decoder = new StreamFrameDecoder(flow);
    decoder.push((await client.read())!);
    expect(Array.from((await flow.read())!)).toEqual([4, 5]);
    flow.consume(2);
    expect(await flow.read()).toBeUndefined();
    decoder.eof();
  } finally {
    await client.reset(3);
    client.release();
  }
});

test("invalid declarations and transitions reject before ungranted payload is stored", () => {
  const invalid = [
    Uint8Array.of(0, 0, 0, 0, 0),
    Uint8Array.of(0, 0, 1, 0, 1),
    frameCredit(0),
    frameCredit(1),
    Uint8Array.of(9),
    Uint8Array.of(1, 1),
    Uint8Array.of(1, 0, 0, 0, 0, 1),
  ];
  for (const bytes of invalid) {
    const flow = makeFlow();
    expect(() => new StreamFrameDecoder(flow).push(bytes)).toThrow(TcpFailure);
    expect(flow.counters.payloadReceived).toBe(0);
  }
  const flow = makeFlow();
  const decoder = new StreamFrameDecoder(flow);
  decoder.push(encodeStreamFrame({ kind: "data", bytes: new Uint8Array(16384) }));
  expect(() => decoder.push(Uint8Array.of(0, 0, 0, 0, 1))).toThrow(TcpFailure);
  expect(flow.counters.payloadReceived).toBe(16384);
  expect(() => flow.eof()).toThrow(TcpFailure);
});

test("partial-frame EOF and native EOF with outstanding send credit reject", () => {
  for (const bytes of [Uint8Array.of(0), Uint8Array.of(2, 0, 0), Uint8Array.of(0, 0, 0, 0, 2, 3)]) {
    const flow = makeFlow();
    const decoder = new StreamFrameDecoder(flow);
    decoder.push(bytes);
    expect(() => decoder.eof()).toThrow(TcpFailure);
  }
  const flow = makeFlow();
  flow.state.send(1);
  flow.receive({ kind: "fin" });
  expect(() => flow.eof()).toThrow(TcpFailure);
  flow.receive({ kind: "credit", bytes: 1 });
  expect(() => flow.eof()).not.toThrow();
});

for (const kind of ["webtransport", "websocket"] as const) {
  test(`${kind} asymmetric windows stop each paused direction and conserve at fixture barriers`, async () => {
    const { left, right } = pair(kind);
    const upload = left.write(new Uint8Array(65537).fill(7));
    const download = right.write(new Uint8Array(16385).fill(8));
    let upDone = false;
    let downDone = false;
    void upload.then(() => {
      upDone = true;
    });
    void download.then(() => {
      downDone = true;
    });
    await tick();
    expect(left.counters.sendOutstandingBytes).toBe(65536);
    expect(right.counters.sendOutstandingBytes).toBe(16384);
    expect(upDone || downDone).toBe(false);
    conservation(left, right);
    conservation(right, left);
    expect((await right.read())!.every((byte) => byte === 7)).toBe(true);
    expect((await left.read())!.every((byte) => byte === 8)).toBe(true);
    right.consume(65536);
    left.consume(16384);
    await Promise.all([upload, download]);
    await Promise.all([left.fin(), right.fin()]);
    right.consume((await right.read())!.length);
    left.consume((await left.read())!.length);
    await Promise.all([left.done, right.done]);
    conservation(left, right);
    conservation(right, left);
    expect(left.counters.sendOutstandingBytes + right.counters.sendOutstandingBytes).toBe(0);
  });

  test(`${kind} one-byte frames use a fixed byte store and conservative metadata`, async () => {
    const { left, right } = pair(kind);
    const amount = 16384;
    const leftDecoder = new StreamFrameDecoder(left);
    const rightDecoder = new StreamFrameDecoder(right);
    const receive = (flow: TcpFlow, decoder: StreamFrameDecoder, index: number) => {
      const bytes = Uint8Array.of(index % 251);
      if (kind === "webtransport") decoder.push(encodeStreamFrame({ kind: "data", bytes }));
      else flow.receive(parseFrame(frameData(bytes)));
    };
    for (let index = 0; index < amount; index++) {
      left.state.send(1);
      receive(right, rightDecoder, index);
      right.state.send(1);
      receive(left, leftDecoder, index);
    }
    expect(left.counters.dataMetadataUpperBound).toBe(amount * (kind === "webtransport" ? 5 : 1));
    expect(right.counters.receiveQueuedBytes).toBe(amount);
    const copy = (await left.read())!;
    expect(copy.every((byte, index) => byte === index % 251)).toBe(true);
    left.consume(amount);
    right.consume((await right.read())!.length);
    await tick();
    conservation(left, right);
    conservation(right, left);
    expect(left.counters.creditPendingSlotBytes).toBeLessThanOrEqual(5);
    expect(left.counters.encodedSlotBytes).toBeLessThanOrEqual(65541);
  });
}

test("native close waits for final credit settlement even though pending credit is zero", async () => {
  const held = Promise.withResolvers<void>();
  let nativeCloses = 0;
  const frames: string[] = [];
  const flow = makeFlow(16384, 16384, {
    kind: "webtransport",
    async write(frame, handoff) {
      handoff();
      frames.push(frame.kind);
      if (frame.kind === "credit") await held.promise;
    },
    async finish() {
      nativeCloses++;
    },
    reset: async () => {},
  });
  try {
    await flow.fin();
    flow.receive({ kind: "data", bytes: Uint8Array.of(1) });
    flow.consume((await flow.read())!.length);
    flow.receive({ kind: "fin" });
    await tick();
    expect(flow.counters.creditPending).toBe(0);
    expect(flow.counters.writeInFlight).toBe("credit");
    expect(nativeCloses).toBe(0);
    held.resolve();
    await flow.done;
    expect(nativeCloses).toBe(1);
    expect(frames).toEqual(["fin", "credit"]);
  } finally {
    held.resolve();
  }
});

test("revoke inherits 1.2 seconds and retains failed cleanup and frozen payload counters", async () => {
  const late = Promise.withResolvers<void>();
  const end = performance.now() + 1200;
  const budget: CleanupBudget = { remaining: () => Math.max(0, end - performance.now()) };
  let inherited: CleanupBudget | undefined;
  const flow = makeFlow(16384, 16384, {
    kind: "webtransport",
    write: async (_frame, handoff) => handoff(),
    finish: async () => {},
    reset(_code, actual) {
      inherited = actual;
      return late.promise;
    },
  });
  flow.receive({ kind: "data", bytes: Uint8Array.of(1, 2, 3) });
  const started = performance.now();
  const resetting = flow.reset(new Error("recycle"), 4, budget);
  expect(flow.reset(new Error("again"), 4)).toBe(resetting);
  await expect(resetting).rejects.toThrow("cleanup is unsettled");
  expect(inherited).toBe(budget);
  expect(performance.now() - started).toBeLessThan(1700);
  expect(flow.counters.failedReceiveBytes).toBe(3);
  expect(flow.counters.payloadReceived).toBe(3);
  expect(flow.counters.consumerReleased).toBe(0);
  late.resolve();
  await expect(flow.closed).rejects.toThrow("cleanup is unsettled");
}, 3000);

test("ordinary reader rejects oversized backing and copies before a reused read buffer changes", async () => {
  const limit = 8192 + 2 + 6 * 16384 + 32;
  const channel = new ByteChannel(
    {
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(new ArrayBuffer(limit + 1), 0, 1));
        },
      }),
      writable: new WritableStream(),
    },
    (code) => ({ code }),
    16384,
  );
  try {
    await expect(channel.read()).rejects.toBeInstanceOf(TcpFailure);
  } finally {
    await channel.reset(3);
    channel.release();
  }
});

test("writer abort wakes an upload blocked on peer credit", async () => {
  const { clientFlow } = await import("../src/tcp-client-flow.js");
  const { left } = pair("webtransport");
  const client = clientFlow(left, remote, new AbortController().signal);
  const writer = client.stream.writable.getWriter();
  const blocked = writer.write(new Uint8Array(65537));
  void blocked.catch(() => {});
  await tick();
  const aborting = writer.abort();
  await expect(
    Promise.race([
      aborting.then(() => "aborted"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]),
  ).resolves.toBe("aborted");
  await expect(blocked).rejects.toHaveProperty("code", "ECONNRESET");
});

test("full close preserves a pending upload and discards reverse data under credit", async () => {
  const { clientFlow } = await import("../src/tcp-client-flow.js");
  const { left, right } = pair("webtransport");
  const client = clientFlow(left, remote, new AbortController().signal);
  const writer = client.stream.writable.getWriter();
  const writing = writer.write(new Uint8Array(65537));
  void writing.catch(() => {});
  await tick();
  const shutdown = writer.close();
  void shutdown.catch(() => {});
  const closing = client.stream.readable.cancel();
  void closing.catch(() => {});
  right.consume((await right.read())!.length);
  await expect(writing).resolves.toBeUndefined();
  right.consume((await right.read())!.length);
  await shutdown;
  await right.write(new Uint8Array(32768).fill(5));
  await right.fin();
  await closing;
  expect(left.counters.discardedBytes).toBe(32768);
  expect(right.counters.consumerReleased).toBe(65537);
  await Promise.all([left.done, right.done]);
});

test("reset wins an in-flight FIN and its late completion cannot close twice", async () => {
  const late = Promise.withResolvers<void>();
  let resets = 0;
  let finishes = 0;
  const flow = makeFlow(16384, 16384, {
    kind: "webtransport",
    async write(_frame, handoff) {
      handoff();
      await late.promise;
    },
    async finish() {
      finishes++;
    },
    async reset() {
      resets++;
    },
  });
  const fin = flow.fin();
  void fin.catch(() => {});
  flow.receive({ kind: "fin" });
  await flow.reset(new Error("cancel during FIN"), 4);
  await expect(fin).rejects.toThrow("cancel during FIN");
  late.resolve();
  await tick();
  expect(resets).toBe(1);
  expect(finishes).toBe(0);
  await flow.reset(new Error("again"), 4);
  expect(resets).toBe(1);
});
