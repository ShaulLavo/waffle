import { expect, test } from "bun:test";
import { OutboundSocket } from "../../waffle/browser/net/outbound-socket.js";
import { createRing, RingReader, RingWriter } from "../../waffle/browser/net/ring.js";
import { Kind, AGAIN } from "../../waffle/browser/net/protocol.js";
import { clientFlow } from "../src/tcp-client-flow.js";
import { TcpFlow, type FrameTransport } from "../src/tcp-flow.js";
import { StreamFrameDecoder, encodeStreamFrame } from "../src/tcp-frame-stream.js";
import { frameData, frameCredit, parseFrame } from "../src/tcp-protocol.js";

const TOTAL = 64 * 1024 * 1024;
const WINDOW = 1024 * 1024;
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(ready: () => boolean): Promise<void> {
  for (let n = 0; n < 1000; n++) {
    if (ready()) return;
    await turn();
  }
  throw new Error("Helper fixture did not reach its barrier");
}
function fixture(kind: FrameTransport["kind"], window: number) {
  const transport = (peer: () => TcpFlow): FrameTransport => ({
    kind,
    async write(frame, handoff) {
      handoff();
      const receiver = peer();
      if (kind === "webtransport") new StreamFrameDecoder(receiver).push(encodeStreamFrame(frame));
      else
        receiver.receive(
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
  const client = new TcpFlow(
    window,
    window,
    transport(() => server),
  );
  const server = new TcpFlow(
    window,
    window,
    transport(() => client),
  );
  const abort = new AbortController();
  const connection = clientFlow(
    client,
    { address: "8.8.8.8", port: 80, family: "IPv4" },
    abort.signal,
  );
  const ring = createRing();
  const writer = new RingWriter(ring);
  const reader = new RingReader(ring);
  const helper = new OutboundSocket(1, { host: "fixture.example", port: 80 }, writer, () => {});
  let settled = 0;
  const sink = connection.stream.writable.getWriter();
  helper.start(async () => ({
    ...connection.stream,
    writable: new WritableStream({
      async write(bytes) {
        await sink.write(bytes);
        settled += bytes.length;
      },
      close: () => sink.close(),
      abort: () => sink.abort(),
    }),
  }));
  return {
    client,
    server,
    helper,
    reader,
    settled: () => settled,
    async dispose() {
      helper.reset();
      abort.abort();
      await Promise.allSettled([
        client.reset(new Error("fixture cleanup"), 1),
        server.reset(new Error("fixture cleanup"), 1),
      ]);
      writer.dispose();
    },
  };
}
async function upload(kind: FrameTransport["kind"], window: number): Promise<void> {
  const run = fixture(kind, window);
  let accepted = 0;
  const bytes = new Uint8Array(65536).fill(7);
  try {
    await until(() => run.helper.write(new Uint8Array()) === 0);
    while (accepted < WINDOW) accepted += run.helper.write(bytes);
    expect(run.helper.write(bytes)).toBe(AGAIN);
    await turn();
    expect(run.client.counters.sendOutstandingBytes).toBeLessThanOrEqual(window);
    expect(run.server.counters.receiveQueuedBytes).toBeLessThanOrEqual(window);
    expect(accepted - run.settled()).toBeLessThanOrEqual(WINDOW);
    const received = (async () => {
      let count = 0;
      for (;;) {
        const input = await run.server.read();
        if (!input) return count;
        expect(input.every((byte) => byte === 7)).toBe(true);
        await Promise.resolve();
        run.server.consume(input.length);
        count += input.length;
      }
    })();
    void received.catch(() => {});
    while (accepted < TOTAL) {
      const count = run.helper.write(bytes.subarray(0, Math.min(bytes.length, TOTAL - accepted)));
      if (count === AGAIN) await turn();
      else accepted += count;
      expect(accepted - run.settled()).toBeLessThanOrEqual(WINDOW);
    }
    run.helper.shutdown();
    expect(await received).toBe(TOTAL);
    await run.server.fin();
    await Promise.all([run.client.done, run.server.done]);
    expect(run.server.counters.consumerReleased).toBe(TOTAL);
    expect(run.client.counters.creditApplied).toBe(TOTAL);
  } finally {
    await run.dispose();
  }
}
async function download(kind: FrameTransport["kind"], window: number): Promise<void> {
  const run = fixture(kind, window);
  let published = 0;
  let guestUnread = 0;
  let guestConsumed = 0;
  let reading = false;
  const drain = () => {
    for (const record of run.reader.drain()) {
      if (record.kind !== Kind.Data) continue;
      expect(record.payload.every((byte) => byte === 9)).toBe(true);
      published += record.payload.length;
      guestUnread += record.payload.length;
      expect(guestUnread).toBeLessThanOrEqual(WINDOW);
      if (!reading) continue;
      run.helper.consumed(record.payload.length);
      guestConsumed += record.payload.length;
      guestUnread -= record.payload.length;
    }
  };
  try {
    await until(() => run.helper.write(new Uint8Array()) === 0);
    const writing = (async () => {
      const bytes = new Uint8Array(65536).fill(9);
      for (let n = 0; n < TOTAL / bytes.length; n++) await run.server.write(bytes);
      await run.server.fin();
    })();
    void writing.catch(() => {});
    await until(() => {
      drain();
      return guestUnread === WINDOW;
    });
    await turn();
    drain();
    const staged = run.client.counters.consumerReleased - published;
    expect(staged).toBeGreaterThanOrEqual(0);
    expect(staged).toBeLessThanOrEqual(65536);
    expect(run.client.counters.receiveQueuedBytes).toBeLessThanOrEqual(window);
    expect(run.server.counters.sendOutstandingBytes).toBeLessThanOrEqual(window);
    run.helper.consumed(guestUnread);
    guestConsumed += guestUnread;
    guestUnread = 0;
    reading = true;
    const end = performance.now() + 10000;
    while (published < TOTAL && performance.now() < end) {
      drain();
      await turn();
    }
    expect(published).toBe(TOTAL);
    expect(guestConsumed).toBe(TOTAL);
    run.helper.shutdown();
    await writing;
    await Promise.all([run.client.done, run.server.done]);
    expect(run.client.counters.consumerReleased).toBe(TOTAL);
    expect(run.server.counters.creditApplied).toBe(TOTAL);
  } finally {
    await run.dispose();
  }
}
for (const kind of ["webtransport", "websocket"] as const) {
  for (const window of [65536, 262144]) {
    test(
      `${kind} ${window} helper upload keeps AGAIN and unsettled admission through 64 MiB`,
      () => upload(kind, window),
      15000,
    );
    test(
      `${kind} ${window} helper download keeps published unread and staging separate through 64 MiB`,
      () => download(kind, window),
      15000,
    );
  }
}
