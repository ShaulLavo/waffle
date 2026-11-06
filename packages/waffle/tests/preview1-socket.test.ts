import { expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import {
  NetConnectError,
  type NetConnect,
  type NetOutboundStream,
} from "../browser/net/outbound.js";
import { createPreview1Network } from "../browser/preview1-network.js";
import {
  socketGuest,
  socketModule,
  scriptedSocket,
  bytes,
  words,
  uint,
  type SocketGuest,
} from "./preview1-socket-support.js";

async function iovec(guest: SocketGuest, data: Uint8Array, capacity = data.length) {
  await guest.write(0, words(128, capacity));
  await guest.write(128, data);
}
async function opened(guest: SocketGuest) {
  await guest.write(0, words(128, 0));
  const errno = await guest.call("sock_send", 3, 0, 1, 0, 32);
  expect(errno).toBe(0);
}
async function poll(guest: SocketGuest, type: 1 | 2, timeout = 10_000_000n) {
  const data = new Uint8Array(96);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 11n, true);
  view.setUint8(8, type);
  view.setUint32(16, 3, true);
  view.setBigUint64(48, 22n, true);
  view.setUint32(64, 1, true);
  view.setBigUint64(72, timeout, true);
  await guest.write(512, data);
  expect(await guest.call("poll_oneoff", 512, 640, 2, 720)).toBe(0);
  const count = uint(await guest.read(720, 4));
  const result = await guest.read(640, count * 32);
  const events = new DataView(result.buffer, result.byteOffset, result.byteLength);
  return Array.from({ length: count }, (_, index) => ({
    type: events.getUint8(index * 32 + 10),
    error: events.getUint16(index * 32 + 8, true),
    nbytes: events.getBigUint64(index * 32 + 16, true),
    flags: events.getUint16(index * 32 + 24, true),
  }));
}

for (const [code, errno] of [
  ["EACCES", 2],
  ["ECONNREFUSED", 14],
  ["ENOTFOUND", 23],
  ["ETIMEDOUT", 73],
  ["EHOSTUNREACH", 23],
  ["ENETUNREACH", 40],
  ["ECONNRESET", 15],
] as const)
  test(`Preview 1 preserves ${code} before open, then sends fail with PIPE`, async () => {
    const pending = Promise.withResolvers<NetOutboundStream>();
    const guest = await socketGuest({ connect: () => pending.promise });
    try {
      expect(await guest.call("fd_fdstat_set_flags", 3, 4)).toBe(0);
      await iovec(guest, bytes("pending"));
      expect(await guest.call("sock_send", 3, 0, 1, 0, 32)).toBe(6);
      expect(await guest.call("sock_recv", 3, 0, 1, 0, 32, 36)).toBe(6);
      expect(await poll(guest, 2)).toEqual([{ type: 0, error: 0, nbytes: 0n, flags: 0 }]);
      pending.reject(new NetConnectError(code, "must not enter guest state"));
      const ready = await poll(guest, 2, 1_000_000_000n);
      expect(ready[0]).toMatchObject({ type: 2, error: errno });
      expect(await guest.call("sock_send", 3, 0, 1, 0, 32)).toBe(errno);
      expect(await guest.call("sock_send", 3, 0, 1, 0, 32)).toBe(64);
      expect(await guest.call("sock_recv", 3, 0, 1, 0, 32, 36)).toBe(errno);
    } finally {
      await guest.close();
    }
  });

test("Preview 1 socket flags, filetypes, inherited list and preopen placement preserve the trampoline", async () => {
  const stream = scriptedSocket();
  const guest = await socketGuest({ connect: async () => stream.stream });
  try {
    expect(await guest.call("fd_kind", 3)).toBe(5);
    expect(await guest.call("inherited_fd", 3)).toBe(3);
    expect(await guest.call("inherited_fd", 4)).toBe(-44);
    expect(await guest.call("fd_prestat_get", 3, 64)).toBe(8);
    expect(await guest.call("fd_prestat_get", 4, 64)).toBe(0);
    expect(await guest.call("fd_fdstat_get", 3, 64)).toBe(0);
    expect((await guest.read(64, 1))[0]).toBe(6);
    expect(await guest.call("fd_filestat_get", 3, 64)).toBe(0);
    expect((await guest.read(80, 1))[0]).toBe(6);
    expect(await guest.call("sock_accept", 3, 0, 32)).toBe(28);
    expect(await guest.call("fd_fdstat_set_flags", 3, 1)).toBe(58);
    for (const fd of [0, 1, 2, 4]) {
      expect(await guest.call("sock_send", fd, 0, 0, 0, 32)).toBe(57);
      expect(await guest.call("sock_recv", fd, 0, 0, 0, 32, 36)).toBe(57);
      expect(await guest.call("sock_shutdown", fd, 2)).toBe(57);
      expect(await guest.call("sock_accept", fd, 0, 32)).toBe(57);
    }
    expect(await guest.call("sock_send", 999, 0, 0, 0, 32)).toBe(8);
    await guest.write(128, words(10, 1, 2, 3, 4));
    expect(await guest.call("sock_send", 0x7ffffffe, 128, 5, 0, 32)).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(20);
    expect(await guest.call("sock_send", 3, 0, 0, 1, 32)).toBe(58);
    expect(await guest.call("sock_recv", 3, 0, 0, 1, 32, 36)).toBe(58);
    expect(await guest.call("sock_shutdown", 3, 0)).toBe(28);
    expect(await guest.call("sock_shutdown", 3, 4)).toBe(28);
    expect(await guest.call("sock_recv", 3, 0, 1, 0, 4 * 1024 * 1024, 36)).toBe(21);
    expect(await guest.call("sock_send", 3, 4 * 1024 * 1024 - 4, 1, 0, 32)).toBe(21);
  } finally {
    await guest.close();
  }
});

test("blocking recv waits across fragments, fd I/O shares the socket, and read shutdown has no FIN", async () => {
  const stream = scriptedSocket();
  const guest = await socketGuest({ connect: async () => stream.stream });
  try {
    await opened(guest);
    await iovec(guest, new Uint8Array(), 6);
    const receiving = guest.call("sock_recv", 3, 0, 1, 2, 32, 36);
    stream.data(bytes("abc"));
    stream.data(bytes("def"));
    expect(await receiving).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(6);
    expect(await guest.read(128, 6)).toEqual(bytes("abcdef"));
    expect(await guest.read(36, 2)).toEqual(new Uint8Array(2));
    await iovec(guest, bytes("out"));
    expect(await guest.call("fd_write", 3, 0, 1, 32)).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(3);
    expect(stream.writes).toEqual([bytes("out")]);
    stream.data(bytes("discard"));
    expect(await guest.call("sock_shutdown", 3, 1)).toBe(0);
    expect(stream.finished).toBe(0);
    expect(await guest.call("fd_read", 3, 0, 1, 32)).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(0);
    expect(await guest.call("sock_shutdown", 3, 2)).toBe(0);
    expect(await guest.call("fd_write", 3, 0, 1, 32)).toBe(64);
    expect(await guest.call("sock_shutdown", 3, 3)).toBe(0);
    expect(await guest.call("fd_close", 3)).toBe(0);
    expect(await guest.call("fd_kind", 3)).toBe(-8);
  } finally {
    await guest.close();
  }
});

test("socket nonblocking WAITALL returns partial bytes, EOF permits writes, and poll reports buffered bytes", async () => {
  const stream = scriptedSocket();
  const guest = await socketGuest({ connect: async () => stream.stream });
  try {
    await opened(guest);
    expect(await guest.call("fd_fdstat_set_flags", 3, 4)).toBe(0);
    await iovec(guest, new Uint8Array(), 8);
    expect(await guest.call("fd_read", 3, 0, 1, 32)).toBe(6);
    stream.data(bytes("abc"));
    expect((await poll(guest, 1, 1_000_000_000n))[0]).toMatchObject({ type: 1, nbytes: 3n });
    expect(await guest.call("sock_recv", 3, 0, 1, 2, 32, 36)).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(3);
    stream.end();
    expect((await poll(guest, 1, 1_000_000_000n))[0]).toMatchObject({ type: 1, flags: 1 });
    expect(await guest.call("sock_recv", 3, 0, 1, 0, 32, 36)).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(0);
    await iovec(guest, bytes("after FIN"));
    expect(await guest.call("sock_send", 3, 0, 1, 0, 32)).toBe(0);
  } finally {
    await guest.close();
  }
});

test("partial send and full-credit AGAIN clear FD_WRITE until Writable, then blocked writes resume", async () => {
  const stream = scriptedSocket(true);
  const guest = await socketGuest({ connect: async () => stream.stream });
  try {
    await opened(guest);
    expect(await guest.call("fd_fdstat_set_flags", 3, 4)).toBe(0);
    const payload = new Uint8Array((1 << 20) + 17).fill(42);
    await iovec(guest, payload);
    expect(await guest.call("sock_send", 3, 0, 1, 0, 32)).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(1 << 20);
    expect(await guest.call("fd_write", 3, 0, 1, 32)).toBe(6);
    expect(await poll(guest, 2)).toEqual([{ type: 0, error: 0, nbytes: 0n, flags: 0 }]);
    expect(await guest.call("fd_fdstat_set_flags", 3, 0)).toBe(0);
    const writing = guest.call("fd_write", 3, 0, 1, 32);
    stream.gate.resolve();
    expect(await writing).toBe(0);
    expect(uint(await guest.read(32, 4))).toBeGreaterThan(0);
  } finally {
    stream.gate.resolve();
    await guest.close();
  }
});

test("target reset appears in poll and worker disposal resets the responsive owner's stream", async () => {
  const stream = scriptedSocket();
  const guest = await socketGuest({ connect: async () => stream.stream });
  try {
    await opened(guest);
    stream.error();
    expect((await poll(guest, 1, 1_000_000_000n))[0]).toMatchObject({ type: 1, error: 15 });
  } finally {
    await guest.close();
  }
  expect(stream.aborted).toBe(1);
});

test("disposal aborts pending opens and no-connector sockets report NOTSUP", async () => {
  let signal: AbortSignal | undefined;
  const pending = Promise.withResolvers<NetOutboundStream>();
  const guest = await socketGuest({
    connect: (_target, value) => {
      signal = value;
      return pending.promise;
    },
  });
  await guest.close();
  expect(signal?.aborted).toBe(true);
  const fixture = scriptedSocket();
  pending.resolve(fixture.stream);
  const disconnected = await socketGuest({});
  try {
    await iovec(disconnected, bytes("x"));
    expect(await disconnected.call("sock_send", 3, 0, 1, 0, 32)).toBe(58);
  } finally {
    await disconnected.close();
  }
});

test("empty socket bindings never activate the network owner", async () => {
  let loads = 0;
  const network = await createPreview1Network(
    {
      network: async () => {
        loads++;
        throw Error("must stay lazy");
      },
    },
    { sockets: [] },
  );
  expect(network).toBeUndefined();
  expect(loads).toBe(0);
});

const directConnector: NetConnect = (target, signal) =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: target.port, allowHalfOpen: true });
    const abort = () => socket.destroy();
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", abort));
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            socket.on("data", (chunk) =>
              controller.enqueue(typeof chunk === "string" ? bytes(chunk) : new Uint8Array(chunk)),
            );
            socket.on("end", () => controller.close());
            socket.on("error", (error) => controller.error(error));
          },
          cancel() {
            socket.destroy();
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write(chunk) {
            return new Promise<void>((resolve, reject) =>
              socket.write(chunk, (error) => (error ? reject(error) : resolve())),
            );
          },
          close() {
            return new Promise<void>((resolve) => socket.end(resolve));
          },
          abort() {
            socket.destroy();
          },
        }),
        remote: { address: socket.remoteAddress!, port: socket.remotePort!, family: "IPv4" },
      }),
    );
  });

test("WAT Preview 1 line fixture exchanges real TCP bytes through the injected connector", async () => {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (data) => socket.write(data));
    socket.on("end", () => socket.end());
  });
  let guest: SocketGuest | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("missing test address");
    guest = await socketGuest({
      module: await socketModule("preview1-socket.wat"),
      interactive: false,
      connect: (target, signal) => directConnector({ ...target, port: address.port }, signal),
    });
    expect(await guest.exit).toMatchObject({ type: "exit", code: 0 });
    expect(Buffer.concat(guest.output).toString()).toBe("waffle echo\n");
  } finally {
    await guest?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(sockets.size).toBe(0);
});

test("scripted SSLRequest is transport coverage, not a Postgres query", async () => {
  const stream = scriptedSocket();
  const guest = await socketGuest({ connect: async () => stream.stream });
  try {
    await opened(guest);
    await iovec(guest, new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47]));
    expect(await guest.call("sock_send", 3, 0, 1, 0, 32)).toBe(0);
    expect(stream.writes[0]).toEqual(new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47]));
    stream.data(bytes("N"));
    await guest.write(0, words(128, 1));
    expect(await guest.call("sock_recv", 3, 0, 1, 0, 32, 36)).toBe(0);
    expect(await guest.read(128, 1)).toEqual(bytes("N"));
  } finally {
    await guest.close();
  }
});

test("socket duplication shares flags and closes only the last descriptor reference", async () => {
  const stream = scriptedSocket();
  const guest = await socketGuest({ connect: async () => stream.stream });
  try {
    await opened(guest);
    expect(await guest.call("fd_reopen", 3, 0, 0, 0x1820_004an, 32)).toBe(0);
    const duplicate = uint(await guest.read(32, 4));
    expect(await guest.call("fd_kind", duplicate)).toBe(5);
    expect(await guest.call("fd_fdstat_set_flags", duplicate, 4)).toBe(0);
    expect(await guest.call("fd_fdstat_get", 3, 64)).toBe(0);
    expect((await guest.read(66, 2))[0]).toBe(4);
    expect(await guest.call("fd_close", 3)).toBe(0);
    expect(stream.cancelled).toBe(0);
    await iovec(guest, bytes("duplicate"));
    expect(await guest.call("sock_send", duplicate, 0, 1, 0, 32)).toBe(0);
    expect(await guest.call("fd_close", duplicate)).toBe(0);
    expect(stream.cancelled).toBe(1);
    expect(await guest.call("fd_close", duplicate)).toBe(8);
  } finally {
    await guest.close();
  }
});

test("blocking send waits for open and WAITALL returns a short result at EOF", async () => {
  const pending = Promise.withResolvers<NetOutboundStream>();
  const stream = scriptedSocket();
  const guest = await socketGuest({ connect: () => pending.promise });
  try {
    await iovec(guest, bytes("open"));
    const sending = guest.call("sock_send", 3, 0, 1, 0, 32);
    expect(stream.writes).toEqual([]);
    pending.resolve(stream.stream);
    expect(await sending).toBe(0);
    await iovec(guest, new Uint8Array(), 8);
    const receiving = guest.call("sock_recv", 3, 0, 1, 2, 32, 36);
    stream.data(bytes("short"));
    stream.end();
    expect(await receiving).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(5);
  } finally {
    await guest.close();
  }
});

test("responsive-owner disposal resets an established stream before the guest is terminated", async () => {
  const stream = scriptedSocket();
  const guest = await socketGuest({ connect: async () => stream.stream });
  try {
    await opened(guest);
    guest.network.dispose();
    await stream.reset;
    expect(stream.aborted).toBe(1);
    expect(stream.cancelled).toBe(1);
  } finally {
    await guest.close();
  }
});

test("closing a connecting descriptor aborts the page connector without disposing the worker", async () => {
  let signal: AbortSignal | undefined;
  const aborted = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<NetOutboundStream>();
  const guest = await socketGuest({
    connect: (_target, value) => {
      signal = value;
      value.addEventListener("abort", () => aborted.resolve(), { once: true });
      return pending.promise;
    },
  });
  try {
    expect(await guest.call("fd_close", 3)).toBe(0);
    expect(await guest.call("fd_kind", 3)).toBe(-8);
    await aborted.promise;
    expect(signal?.aborted).toBe(true);
  } finally {
    await guest.close();
    pending.resolve(scriptedSocket().stream);
  }
});

test("a launch socket can replace default stdin without moving the root preopen", async () => {
  const stream = scriptedSocket();
  const guest = await socketGuest({ sockets: [0], connect: async () => stream.stream });
  try {
    expect(await guest.call("fd_kind", 0)).toBe(5);
    expect(await guest.call("fd_prestat_get", 3, 64)).toBe(0);
    stream.data(bytes("stdin"));
    await guest.write(0, words(128, 5));
    expect(await guest.call("fd_read", 0, 0, 1, 32)).toBe(0);
    expect(await guest.read(128, 5)).toEqual(bytes("stdin"));
  } finally {
    await guest.close();
  }
});
