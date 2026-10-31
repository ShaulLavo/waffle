import { expect, test } from "bun:test";
import { createRelayConnect } from "../src/tcp-client.js";
import { encodeOpenHeader, parseOpen, OpenHeaderDecoder } from "../src/tcp-protocol.js";
import { nativeResetCode, nativeResetReason } from "../src/webtransport-native.js";
import type { WebTransportFactory, WebTransportLike } from "../src/tcp-webtransport.js";
import type { ClientWebSocket } from "../src/tcp-websocket.js";

const target = { host: "echo.example", port: 80 };
const remote = { address: "8.8.8.8", port: 80, family: "IPv4" } as const;
function mockStream(reply = encodeOpenHeader({ v: 1, ok: true, remote, window: 262144 })) {
  let output: ReadableByteStreamController;
  const headers: unknown[] = [];
  const decoder = new OpenHeaderDecoder();
  const readable = new ReadableStream<Uint8Array>({
    type: "bytes",
    start(controller) {
      if (!("byobRequest" in controller)) throw new Error("Expected byte stream");
      output = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      const header = decoder.push(bytes);
      if (!header) return;
      headers.push(parseOpen(header.header));
      for (const byte of reply) output.enqueue(Uint8Array.of(byte));
    },
  });
  return { readable, writable, headers, output: () => output! };
}
function fixture(
  factory: WebTransportFactory,
  config: unknown = { v: 1, webtransport: { url: "https://127.0.0.1:4433/v1/tcp/wt" } },
) {
  let sockets = 0;
  let discoveries = 0;
  const websocket: (url: string) => ClientWebSocket = () => {
    sockets++;
    let events: Parameters<ClientWebSocket["listen"]>[0];
    return {
      bufferedAmount: 0,
      listen(value) {
        events = value;
        queueMicrotask(value.open);
        return () => {};
      },
      send(value) {
        if (typeof value === "string")
          queueMicrotask(() =>
            events.message(JSON.stringify({ v: 1, ok: true, remote, window: 262144 })),
          );
      },
      close(code) {
        queueMicrotask(() => events.close(code));
      },
    };
  };
  const relay = createRelayConnect({
    endpoint: "https://relay.example/",
    getToken: () => "page-only-token",
    webTransport: factory,
    webSocket: websocket,
    fetch: Object.assign(
      async () => {
        discoveries++;
        return Response.json(config);
      },
      { preconnect: () => {} },
    ),
  });
  return { relay, sockets: () => sockets, discoveries: () => discoveries };
}
function session(stream: ReturnType<typeof mockStream>): WebTransportLike {
  const closed = Promise.withResolvers<void>();
  return {
    ready: Promise.resolve(),
    closed: closed.promise,
    createBidirectionalStream: async () => stream,
    close() {
      closed.resolve();
    },
  };
}
test("shared parser consumes bytewise reply and retains following target bytes", async () => {
  const stream = mockStream();
  const run = fixture(() => session(stream));
  try {
    const connection = await run.relay.connect(target, new AbortController().signal);
    stream.output().enqueue(Uint8Array.of(0, 0, 0, 0, 2, 11, 12));
    const reader = connection.readable.getReader();
    expect(Array.from((await reader.read()).value!)).toEqual([11, 12]);
    expect(run.relay.carrier).toBe("webtransport");
    expect(stream.headers).toEqual([{ v: 1, token: "page-only-token", ...target, window: 262144 }]);
    expect(run.sockets()).toBe(0);
  } finally {
    await run.relay.close();
  }
});
test("a final error reply never falls back", async () => {
  const stream = mockStream(encodeOpenHeader({ v: 1, ok: false, code: "destination-denied" }));
  const run = fixture(() => session(stream));
  await expect(run.relay.connect(target, new AbortController().signal)).rejects.toHaveProperty(
    "code",
    "EACCES",
  );
  expect(run.sockets()).toBe(0);
  await run.relay.close();
});
test("invalid discovery hashes cannot allocate a session and fallback sticks", async () => {
  let factories = 0;
  const run = fixture(
    () => {
      factories++;
      throw new Error("must not allocate");
    },
    {
      v: 1,
      webtransport: {
        url: "https://127.0.0.1:4433/v1/tcp/wt",
        certificateHashes: [{ algorithm: "sha-256", value: "invalid" }],
      },
    },
  );
  try {
    await run.relay.connect(target, new AbortController().signal);
    await run.relay.connect(target, new AbortController().signal);
    expect(factories).toBe(0);
    expect(run.discoveries()).toBe(1);
    expect(run.sockets()).toBe(2);
    expect(run.relay.carrier).toBe("websocket");
  } finally {
    await run.relay.close();
  }
});
test("session readiness and stream-creation hangs fall back within the complete probe bound", async () => {
  for (const phase of ["session", "stream"]) {
    const stream = mockStream();
    const pending = Promise.withResolvers<void>();
    const run = fixture(() => ({
      ready: phase === "session" ? pending.promise : Promise.resolve(),
      closed: Promise.resolve(),
      createBidirectionalStream: () => new Promise(() => {}),
      close() {},
    }));
    const started = Date.now();
    try {
      await run.relay.connect(target, new AbortController().signal);
      expect(Date.now() - started).toBeLessThan(3600);
      expect(run.sockets()).toBe(1);
      expect(stream.headers.length).toBe(0);
    } finally {
      await run.relay.close();
    }
  }
}, 9000);
test("all native reset codes are normalized privately and other messages are carrier loss", () => {
  for (const code of [1, 2, 3, 4] as const) {
    expect(nativeResetReason(code)).toEqual({ code });
    expect(nativeResetCode(new Error(`Resetstream with code:${code}`))).toBe(code);
    expect(nativeResetCode(new Error(`StopSending with code:${code}`))).toBe(code);
  }
  for (const value of [
    "Resetstream with code:0",
    "Resetstream with code:5",
    "prefix StopSending with code:2",
    "Resetstream with code:3 token",
  ])
    expect(nativeResetCode(new Error(value))).toBeUndefined();
});

test("a caller abort after submitting the open header never creates a WebSocket", async () => {
  const raw = mockStream(new Uint8Array());
  const run = fixture(() => session(raw));
  const abort = new AbortController();
  const opening = run.relay.connect(target, abort.signal);
  void opening.catch(() => {});
  while (!raw.headers.length) await new Promise((resolve) => setTimeout(resolve, 1));
  const reason = new Error("caller stopped a submitted open");
  abort.abort(reason);
  await expect(opening).rejects.toBe(reason);
  expect(run.sockets()).toBe(0);
  await run.relay.close();
});

test("oversized discovery and more than one hash fail before allocating a native session", async () => {
  for (const config of [
    {
      v: 1,
      webtransport: {
        url: "https://127.0.0.1:4433/v1/tcp/wt",
        certificateHashes: [
          { algorithm: "sha-256", value: "A".repeat(43) },
          { algorithm: "sha-256", value: "A".repeat(43) },
        ],
      },
    },
    { v: 1, webtransport: { url: "https://127.0.0.1:4433/v1/tcp/wt", padding: "x".repeat(8192) } },
  ]) {
    let allocations = 0;
    const run = fixture(() => {
      allocations++;
      throw new Error("must not allocate");
    }, config);
    try {
      await run.relay.connect(target, new AbortController().signal);
      expect(allocations).toBe(0);
      expect(run.sockets()).toBe(1);
    } finally {
      await run.relay.close();
    }
  }
});
