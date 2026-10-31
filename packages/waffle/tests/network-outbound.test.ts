import { expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { NetHelper, NetNamespace, type NetConnect } from "../browser/net/helper.js";
import { NetConnectError, type NetOutboundStream } from "../browser/net/outbound.js";
import { NetHost } from "../browser/net/host.js";
import { CAPACITY, createRing, RingReader, RingWriter } from "../browser/net/ring.js";
import { Kind, MAX_RECORD } from "../browser/net/protocol.js";
import { networkPeer } from "./network-worker-peer.js";

const WINDOW = 1 << 20;
const EMPTY = new Uint8Array();
type Peer = ReturnType<typeof networkPeer>;
const bytes = (value: string) => new TextEncoder().encode(value);
const turn = () => new Promise((resolve) => setTimeout(resolve, 1));

async function until<T>(operation: () => Promise<T>, done: (result: T) => boolean): Promise<T> {
  for (let n = 0; n < 500; n++) {
    const result = await operation();
    if (done(result)) return result;
    await turn();
  }
  throw Error("Outbound worker did not make progress");
}

async function withPeer(connect: NetConnect | undefined, run: (client: Peer) => Promise<void>) {
  const namespace = await NetNamespace.create();
  const client = networkPeer(namespace, {}, connect);
  try {
    await client.ready;
    await run(client);
    expect(client.failures).toEqual([]);
  } finally {
    client.close();
    namespace.dispose();
  }
}

function scripted(holdWrites = false) {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let sink!: WritableStreamDefaultController;
  let cancelled = 0;
  let aborted = 0;
  let finished = 0;
  const gate = Promise.withResolvers<void>();
  const writes: Uint8Array[] = [];
  const stream: NetOutboundStream = {
    remote: { address: "203.0.113.7", port: 4321, family: "IPv4" },
    readable: new ReadableStream<Uint8Array>(
      {
        start(controller) {
          source = controller;
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
    writable: new WritableStream<Uint8Array>({
      start(controller) {
        sink = controller;
        controller.signal.addEventListener("abort", () => gate.resolve(), { once: true });
      },
      write(value) {
        writes.push(value.slice());
        if (holdWrites) return gate.promise;
      },
      close() {
        finished++;
      },
      abort() {
        aborted++;
      },
    }),
  };
  return {
    stream,
    writes,
    gate,
    data: (value: Uint8Array) => source.enqueue(value),
    end: () => source.close(),
    error: (reason: unknown) => source.error(reason),
    get cancelled() {
      return cancelled;
    },
    get aborted() {
      return aborted;
    },
    get finished() {
      return finished;
    },
    get sinkAborted() {
      return sink.signal.aborted;
    },
  };
}

async function opened(client: Peer, handle: number) {
  expect(
    await until(
      () => client.call({ op: "write", handle, bytes: EMPTY }),
      (value) => value !== -2,
    ),
  ).toBe(0);
}

async function connect(client: Peer, host = "database.example", port = 5432) {
  const handle = await client.call({ op: "connect", host, port });
  if (typeof handle !== "number" || handle <= 0) throw Error(`connect failed: ${handle}`);
  return handle;
}

async function read(client: Peer, handle: number, cap = 65536) {
  return until(
    () => client.call({ op: "read", handle, cap }),
    (value) => value !== -2,
  );
}

test("pending worker connects wait for Open and report only the connected endpoint", async () => {
  const pending = Promise.withResolvers<NetOutboundStream>();
  let target: unknown;
  const fixture = scripted();
  await withPeer(
    (value) => {
      target = value;
      return pending.promise;
    },
    async (client) => {
      const handle = await connect(client);
      expect(target).toEqual({ host: "database.example", port: 5432 });
      expect(Object.isFrozen(target)).toBe(true);
      expect(await client.call({ op: "poll", handle: 0 })).toBe(0);
      expect(await client.call({ op: "read", handle, cap: 1 })).toBe(-2);
      expect(await client.call({ op: "write", handle, bytes: EMPTY })).toBe(-2);
      expect(await client.call({ op: "write", handle, bytes: bytes("pending") })).toBe(-2);
      for (const op of ["peer", "addr"] as const) {
        expect(await client.call({ op, handle })).toBe(-1);
        expect(JSON.parse(String(await client.call({ op: "error", handle: 0 })))).toMatchObject({
          code: "ENOTCONN",
        });
      }
      expect(fixture.writes).toEqual([]);
      pending.resolve(fixture.stream);
      await opened(client, handle);
      expect(JSON.parse(String(await client.call({ op: "peer", handle })))).toEqual(
        fixture.stream.remote,
      );
      expect(JSON.parse(String(await client.call({ op: "addr", handle })))).toEqual({
        address: "0.0.0.0",
        family: "IPv4",
        port: 0,
      });
      expect(await client.call({ op: "write", handle, bytes: bytes("open") })).toBe(4);
      await until(
        async () => fixture.writes.length,
        (count) => count === 1,
      );
      expect(fixture.writes).toEqual([bytes("open")]);
    },
  );
});

for (const code of [
  "EACCES",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
] as const) {
  test(`worker preserves pre-open ${code} in the handle and last error`, async () => {
    const pending = Promise.withResolvers<NetOutboundStream>();
    await withPeer(
      () => pending.promise,
      async (client) => {
        const handle = await connect(client);
        pending.reject(new NetConnectError(code, "private connector details"));
        expect(
          await until(
            () => client.call({ op: "write", handle, bytes: EMPTY }),
            (value) => value !== -2,
          ),
        ).toBe(-1);
        for (const id of [handle, 0]) {
          expect(JSON.parse(String(await client.call({ op: "error", handle: id })))).toMatchObject({
            code,
            hostname: "database.example",
            address: "database.example",
            port: 5432,
            syscall: "connect",
          });
          expect(String(await client.call({ op: "error", handle: id }))).not.toContain(
            "private connector details",
          );
        }
        expect(await read(client, handle)).toBe(-1);
      },
    );
  });
}

test("a synchronous connector failure becomes a terminal ring error", async () => {
  await withPeer(
    () => {
      throw Error("unclassified failure");
    },
    async (client) => {
      const handle = await connect(client);
      expect(await read(client, handle)).toBe(-1);
      expect(String(await client.call({ op: "error", handle }))).toContain("ECONNRESET");
    },
  );
});

test("paused worker reader pulls exactly 1 MiB, then a guest read restores credit", async () => {
  let pulled = 0;
  let cancelled = false;
  const stream: NetOutboundStream = {
    remote: { address: "2001:db8::7", family: "IPv6", port: 443 },
    readable: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 65536;
          controller.enqueue(new Uint8Array(65536).fill(pulled / 65536));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    writable: new WritableStream<Uint8Array>(),
  };
  await withPeer(
    async () => stream,
    async (client) => {
      const handle = await connect(client);
      await opened(client, handle);
      expect(JSON.parse(String(await client.call({ op: "addr", handle })))).toEqual({
        address: "::",
        port: 0,
        family: "IPv6",
      });
      await until(
        async () => {
          await client.call({ op: "poll", handle: 0 });
          return pulled;
        },
        (size) => size === WINDOW,
      );
      // Ring drains are not guest read acknowledgements.
      for (let n = 0; n < 10; n++) {
        await client.call({ op: "poll", handle: 0 });
        await turn();
      }
      expect(pulled).toBe(WINDOW);
      const first = await read(client, handle);
      expect(first).toEqual(new Uint8Array(65536).fill(1));
      await until(
        async () => pulled,
        (size) => size === WINDOW + 65536,
      );
      expect(pulled).toBe(WINDOW + 65536);
    },
  );
  expect(cancelled).toBe(true);
});

test("unsettled writes accept a partial prefix up to 1 MiB and publish Writable after settling", async () => {
  const fixture = scripted(true);
  await withPeer(
    async () => fixture.stream,
    async (client) => {
      const handle = await connect(client);
      await opened(client, handle);
      await client.call({ op: "poll", handle: 0 });
      expect(
        await client.call({ op: "write", handle, bytes: new Uint8Array(WINDOW - 17).fill(1) }),
      ).toBe(WINDOW - 17);
      expect(await client.call({ op: "write", handle, bytes: new Uint8Array(32).fill(2) })).toBe(
        17,
      );
      expect(await client.call({ op: "write", handle, bytes: bytes("blocked") })).toBe(-2);
      await until(
        () => client.call({ op: "poll", handle: 0 }),
        (value) => value === 0,
      );
      fixture.gate.resolve();
      expect(
        await until(
          () => client.call({ op: "poll", handle: 0 }),
          (value) => value === 1,
        ),
      ).toBe(1);
      expect(await client.call({ op: "write", handle, bytes: bytes("ready") })).toBe(5);
      await until(
        async () => fixture.writes.length,
        (count) => count === 3,
      );
      expect(fixture.writes.map((chunk) => chunk.length)).toEqual([WINDOW - 17, 17, 5]);
    },
  );
});

test("shutdown while pending closes the writer once after Open and keeps replies flowing", async () => {
  const pending = Promise.withResolvers<NetOutboundStream>();
  const fixture = scripted();
  await withPeer(
    () => pending.promise,
    async (client) => {
      const handle = await connect(client);
      expect(await client.call({ op: "shutdown", handle })).toBe(0);
      expect(await client.call({ op: "shutdown", handle })).toBe(0);
      expect(await client.call({ op: "write", handle, bytes: EMPTY })).toBe(-2);
      pending.resolve(fixture.stream);
      await until(
        async () => fixture.finished,
        (count) => count === 1,
      );
      fixture.data(bytes("reply after FIN"));
      expect(await read(client, handle)).toEqual(bytes("reply after FIN"));
      expect(await client.call({ op: "close", handle })).toBe(0);
      await until(
        async () => fixture.cancelled,
        (count) => count === 1,
      );
      expect(fixture.finished).toBe(1);
    },
  );
});

test("target EOF leaves the guest write direction open", async () => {
  const fixture = scripted();
  await withPeer(
    async () => fixture.stream,
    async (client) => {
      const handle = await connect(client);
      await opened(client, handle);
      fixture.data(bytes("last reply"));
      fixture.end();
      expect(await read(client, handle)).toEqual(bytes("last reply"));
      expect(await read(client, handle)).toBe(0);
      expect(await client.call({ op: "write", handle, bytes: bytes("still writable") })).toBe(14);
      await until(
        async () => fixture.writes.length,
        (count) => count === 1,
      );
      expect(fixture.writes).toEqual([bytes("still writable")]);
    },
  );
});

test("full close flushes queued writes and cancels reads without aborting the connected signal", async () => {
  const fixture = scripted(true);
  let signal!: AbortSignal;
  await withPeer(
    async (_target, value) => {
      signal = value;
      return fixture.stream;
    },
    async (client) => {
      const handle = await connect(client);
      await opened(client, handle);
      expect(await client.call({ op: "write", handle, bytes: bytes("flush me") })).toBe(8);
      await client.call({ op: "close", handle });
      await until(
        async () => fixture.cancelled,
        (count) => count === 1,
      );
      expect(signal.aborted).toBe(false);
      expect(fixture.finished).toBe(0);
      fixture.gate.resolve();
      await until(
        async () => fixture.finished,
        (count) => count === 1,
      );
      expect(fixture.writes).toEqual([bytes("flush me")]);
      expect(fixture.aborted).toBe(0);
    },
  );
});

test.each([false, true])(
  "helper disposal resets established streams, draining close=%s",
  async (closing) => {
    const fixture = scripted(true);
    let signal!: AbortSignal;
    await withPeer(
      async (_target, value) => {
        signal = value;
        return fixture.stream;
      },
      async (client) => {
        const handle = await connect(client);
        await opened(client, handle);
        expect(await client.call({ op: "write", handle, bytes: bytes("pending write") })).toBe(13);
        if (closing) await client.call({ op: "close", handle });
        client.helper.dispose();
        expect(signal.aborted).toBe(true);
        expect(fixture.sinkAborted).toBe(true);
        await until(
          async () => fixture.cancelled,
          (count) => count === 1,
        );
        fixture.gate.resolve();
        await until(
          async () => fixture.aborted + fixture.finished,
          (count) => count > 0,
        );
      },
    );
  },
);

test.each(["close", "dispose"] as const)(
  "%s aborts pending connects and resets a late returned stream",
  async (operation) => {
    const pending = Promise.withResolvers<NetOutboundStream>();
    const fixture = scripted();
    let signal!: AbortSignal;
    await withPeer(
      (_target, value) => {
        signal = value;
        return pending.promise;
      },
      async (client) => {
        const handle = await connect(client);
        if (operation === "close") await client.call({ op: "close", handle });
        else client.helper.dispose();
        expect(signal.aborted).toBe(true);
        pending.resolve(fixture.stream);
        await until(
          async () => fixture.cancelled + fixture.aborted,
          (count) => count === 2,
        );
        expect(fixture.writes).toEqual([]);
      },
    );
  },
);

test("post-open source failure maps to ECONNRESET and resets both directions", async () => {
  const fixture = scripted();
  await withPeer(
    async () => fixture.stream,
    async (client) => {
      const handle = await connect(client);
      await opened(client, handle);
      fixture.error(new NetConnectError("EACCES", "private post-open error"));
      expect(await read(client, handle)).toBe(-1);
      expect(JSON.parse(String(await client.call({ op: "error", handle })))).toMatchObject({
        code: "ECONNRESET",
      });
      expect(fixture.sinkAborted).toBe(true);
    },
  );
});

test("all loopback spellings bypass the injected connector", async () => {
  let calls = 0;
  await withPeer(
    async () => {
      calls++;
      throw Error("unexpected connector call");
    },
    async (client) => {
      const listener = await client.call({ op: "listen", host: "::", port: 0 });
      if (typeof listener !== "number") throw Error("listener failed");
      const address = JSON.parse(String(await client.call({ op: "addr", handle: listener })));
      for (const host of [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::",
        "::1",
        "0:0:0:0:0:0:0:0",
        "0:0:0:0:0:0:0:1",
        "[::1]",
        "[::]",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
      ]) {
        const handle = await connect(client, host, address.port);
        await client.call({ op: "close", handle });
      }
      expect(calls).toBe(0);
    },
  );
});

test("no connector retains ENOTSUP and its existing message, standalone hosts also stay unsupported", async () => {
  await withPeer(undefined, async (client) => {
    expect(await client.call({ op: "connect", host: "database.example", port: 5432 })).toBe(-4);
    expect(JSON.parse(String(await client.call({ op: "error", handle: 0 })))).toEqual({
      name: "Error",
      code: "ENOTSUP",
      message: "connect database.example:5432: TCP connections are not available in the browser",
    });
  });
  const host = new NetHost(createRing(), () => {
    throw Error("standalone host must not send outbound connect");
  });
  try {
    expect(host.connect("database.example", 5432)).toBe(-4);
  } finally {
    host.dispose();
  }
});

async function withTcpTarget(
  accept: (socket: Socket) => void,
  run: (port: number) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    accept(socket);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("TCP target did not bind");
    await run(address.port);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
    await until(
      async () => sockets.size,
      (size) => size === 0,
    );
    expect(server.listening).toBe(false);
  }
}

/** Test-only native connector. Production core never imports node:net or node:stream. */
function nativeConnect(port: number, gate: Promise<void> = Promise.resolve()): NetConnect {
  return async (_target, signal) => {
    await gate;
    signal.throwIfAborted();
    const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true, signal });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    if (!socket.remoteAddress || !socket.remotePort)
      throw Error("Connected TCP socket has no peer");
    return {
      ...nativeStreams(socket),
      remote: { address: socket.remoteAddress, port: socket.remotePort, family: "IPv4" },
    };
  };
}

function nativeStreams(socket: Socket) {
  let reading = true;
  socket.pause();
  const readable = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        socket.on("data", (chunk) => {
          socket.pause();
          if (reading)
            controller.enqueue(typeof chunk === "string" ? bytes(chunk) : new Uint8Array(chunk));
        });
        socket.on("end", () => {
          if (reading) controller.close();
        });
        socket.on("error", (error) => {
          if (reading) controller.error(error);
        });
      },
      pull() {
        socket.resume();
      },
      cancel() {
        reading = false;
        socket.resume();
      },
    },
    { highWaterMark: 0 },
  );
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        socket.write(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => socket.end(resolve));
    },
    abort() {
      socket.destroy();
    },
  });
  return { readable, writable };
}

async function receiveText(client: Peer, handle: number): Promise<string> {
  const decoder = new TextDecoder();
  let result = "";
  for (let n = 0; n < 200; n++) {
    const chunk = await read(client, handle);
    if (chunk === 0) return result;
    if (!(chunk instanceof Uint8Array)) throw Error(`TCP read failed: ${chunk}`);
    result += decoder.decode(chunk, { stream: true });
  }
  throw Error("TCP response did not end");
}

test("real TCP connector echoes worker bytes and receives a reply after SHUT_WR", async () => {
  await withTcpTarget(
    (socket) => {
      socket.on("data", (data) => socket.write(data));
      socket.on("end", () => socket.end("after-fin"));
    },
    async (port) => {
      const gate = Promise.withResolvers<void>();
      await withPeer(nativeConnect(port, gate.promise), async (client) => {
        const handle = await connect(client, "echo.example", 1234);
        expect(await client.call({ op: "write", handle, bytes: EMPTY })).toBe(-2);
        gate.resolve();
        await opened(client, handle);
        expect(JSON.parse(String(await client.call({ op: "peer", handle })))).toEqual({
          address: "127.0.0.1",
          family: "IPv4",
          port,
        });
        expect(await client.call({ op: "write", handle, bytes: bytes("echo-me") })).toBe(7);
        expect(await client.call({ op: "shutdown", handle })).toBe(0);
        expect(await receiveText(client, handle)).toBe("echo-meafter-fin");
        await client.call({ op: "close", handle });
      });
    },
  );
});

test("real target EOF leaves its receive direction open for the worker's final write", async () => {
  const received = Promise.withResolvers<string>();
  await withTcpTarget(
    (socket) => {
      socket.end("target-fin");
      socket.on("data", (data) => received.resolve(data.toString()));
    },
    async (port) => {
      await withPeer(nativeConnect(port), async (client) => {
        const handle = await connect(client);
        await opened(client, handle);
        expect(await receiveText(client, handle)).toBe("target-fin");
        expect(await client.call({ op: "write", handle, bytes: bytes("guest-after-eof") })).toBe(
          15,
        );
        await client.call({ op: "close", handle });
        expect(await received.promise).toBe("guest-after-eof");
      });
    },
  );
});

async function withDirect(
  run: (fixture: {
    host: NetHost;
    helper: NetHelper;
    ring: SharedArrayBuffer;
    stream: ReturnType<typeof scripted>;
    signal(): AbortSignal;
  }) => Promise<void>,
) {
  const namespace = await NetNamespace.create();
  const ring = createRing();
  const stream = scripted();
  let signal!: AbortSignal;
  const helper = new NetHelper(
    ring,
    async () => {
      throw Error("unexpected fetch");
    },
    {},
    namespace,
    undefined,
    undefined,
    undefined,
    async (_target, value) => {
      signal = value;
      return stream.stream;
    },
  );
  const host = new NetHost(ring, (request) => helper.handle(request), undefined, { shared: true });
  try {
    await run({ host, helper, ring, stream, signal: () => signal });
  } finally {
    host.dispose();
    helper.dispose();
    namespace.dispose();
  }
}

async function fillRing(ring: SharedArrayBuffer) {
  const filler = new RingWriter(ring);
  try {
    const record = new Uint8Array(MAX_RECORD);
    for (let n = 0; n < 15; n++) await filler.write(0, Kind.Data, record);
    await filler.write(0, Kind.Data, new Uint8Array(CAPACITY - 15 * (MAX_RECORD + 12) - 12));
  } finally {
    filler.dispose();
  }
}

test("close while Open is blocked behind a full ring still aborts the pending connect", async () => {
  await withDirect(async ({ host, ring, stream, signal }) => {
    await fillRing(ring);
    const handle = host.connect("pending.example", 443);
    expect(handle).toBeGreaterThan(0);
    await turn();
    expect(signal().aborted).toBe(false);
    host.close(handle);
    expect(signal().aborted).toBe(true);
    await until(
      async () => stream.cancelled + stream.aborted,
      (count) => count === 2,
    );
    // A queued publication cannot re-open a handle the guest already closed.
    new RingReader(ring).drain();
    await turn();
    expect(host.peerAddr(handle)).toBe(-3);
    expect(stream.writes).toEqual([]);
  });
});

test("writes preserve ECONNRESET even while the error record is blocked by a full ring", async () => {
  await withDirect(async ({ host, ring, stream }) => {
    const handle = host.connect("reset.example", 443);
    await until(
      async () => host.write(handle, EMPTY),
      (value) => value === 0,
    );
    await fillRing(ring);
    stream.error(new NetConnectError("ECONNRESET", "target reset"));
    await turn();
    expect(host.write(handle, bytes("racing write"))).toBe(-1);
    expect(JSON.parse(String(host.error(handle)))).toMatchObject({ code: "ECONNRESET" });
  });
});
