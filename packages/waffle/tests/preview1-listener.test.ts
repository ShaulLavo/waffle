import { expect, test } from "bun:test";
import { createRuntimeNetwork } from "../browser/net/runtime.js";
import { createPreview1Network } from "../browser/preview1-network.js";
import { networkPeer } from "./network-worker-peer.js";
import {
  socketGuest,
  socketModule,
  bytes,
  words,
  uint,
  type SocketGuest,
} from "./preview1-socket-support.js";

const binding = (port = 32161, host = "127.0.0.1", fd = 3) => ({
  fd,
  socket: { listen: { host, port } },
});
async function fixture(host = "127.0.0.1", sockets = [binding(32161, host)]) {
  const owner = await createRuntimeNetwork(() => {});
  const peer = networkPeer(owner.network);
  let guest: SocketGuest;
  try {
    await peer.ready;
    guest = await socketGuest({ network: owner.network, bindings: sockets });
  } catch (error) {
    peer.close();
    await owner.dispose();
    throw error;
  }
  return {
    owner,
    peer,
    guest,
    connect: () => peer.call({ op: "connect", host, port: 32161 }).then(Number),
    async close() {
      try {
        await guest.close();
      } finally {
        peer.close();
        await owner.dispose();
      }
    },
  };
}
async function accepted(guest: SocketGuest, fd = 3, flags = 0) {
  expect(await guest.call("sock_accept", fd, flags, 32)).toBe(0);
  return uint(await guest.read(32, 4));
}
async function io(guest: SocketGuest, text = "", capacity = 8) {
  await guest.write(0, words(128, capacity));
  if (text) await guest.write(128, bytes(text));
}
async function poll(guest: SocketGuest, fd = 3, type = 1, timeout = 0n) {
  const data = new Uint8Array(96);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 11n, true);
  view.setUint8(8, type);
  view.setUint32(16, fd, true);
  view.setBigUint64(48, 22n, true);
  view.setUint32(64, 1, true);
  view.setBigUint64(72, timeout, true);
  await guest.write(512, data);
  expect(await guest.call("poll_oneoff", 512, 640, 2, 720)).toBe(0);
  const count = uint(await guest.read(720, 4));
  const result = await guest.read(640, count * 32);
  const events = new DataView(result.buffer, result.byteOffset, result.byteLength);
  return Array.from({ length: count }, (_, i) => ({
    type: events.getUint8(i * 32 + 10),
    error: events.getUint16(i * 32 + 8, true),
    bytes: events.getBigUint64(i * 32 + 16, true),
    flags: events.getUint16(i * 32 + 24, true),
  })).filter((event) => event.type !== 0);
}
async function readPeer(peer: ReturnType<typeof networkPeer>, handle: number) {
  for (let i = 0; i < 100; i++) {
    const result = await peer.call({ op: "read", handle, cap: 65536 });
    if (result !== -2) return result;
    await Bun.sleep(1);
  }
  throw Error("loopback peer did not receive bytes or EOF");
}

test("listener pending readiness is non-consuming, nonblocking accept does not change accepted flags", async () => {
  const f = await fixture();
  const { guest, peer } = f;
  try {
    expect(await guest.call("fd_fdstat_set_flags", 3, 4)).toBe(0);
    expect(await guest.call("sock_accept", 3, 0, 32)).toBe(6);
    expect(await poll(guest)).toEqual([]);
    expect(await poll(guest, 3, 2)).toEqual([]);
    expect(await f.connect()).toBeGreaterThan(0);
    expect((await poll(guest))[0]).toEqual({ type: 1, error: 0, bytes: 0n, flags: 0 });
    expect((await poll(guest))[0]?.type).toBe(1);
    const fd = await accepted(guest);
    expect(fd).toBe(5);
    expect(await guest.call("fd_kind", fd)).toBe(5);
    expect(await guest.call("fd_fdstat_get", fd, 64)).toBe(0);
    expect((await guest.read(66, 2))[0]).toBe(0);
    expect(await guest.call("inherited_fd", 4)).toBe(-44);
    expect(await poll(guest)).toEqual([]);
    expect(await guest.call("sock_accept", 3, 4, 32)).toBe(6);
    expect(peer.failures).toEqual([]);
  } finally {
    await f.close();
  }
});

test("blocking accept and poll wake on same-runtime connection and accepted sockets honor NONBLOCK", async () => {
  const f = await fixture();
  const { guest, peer } = f;
  try {
    const waiting = guest.call("sock_accept", 3, 4, 32);
    await Bun.sleep(10);
    const conn = await f.connect();
    expect(conn).toBeGreaterThan(0);
    expect(await waiting).toBe(0);
    const fd = uint(await guest.read(32, 4));
    await io(guest);
    expect(await guest.call("sock_recv", fd, 0, 1, 0, 32, 36)).toBe(6);
    expect(await guest.call("fd_fdstat_get", fd, 64)).toBe(0);
    expect((await guest.read(66, 2))[0]).toBe(4);
    const pending = poll(guest, 3, 1, 2_000_000_000n);
    await Bun.sleep(10);
    const second = await f.connect();
    expect(second).toBeGreaterThan(0);
    expect((await pending)[0]?.type).toBe(1);
    const blocking = await accepted(guest);
    const receiving = guest.call("sock_recv", blocking, 0, 1, 0, 32, 36);
    await peer.call({ op: "write", handle: second, bytes: bytes("accepted") });
    expect(await receiving).toBe(0);
    expect(await guest.read(128, 8)).toEqual(bytes("accepted"));
    expect(await guest.call("sock_accept", fd, 0, 32)).toBe(28);
    expect(await guest.call("sock_accept", blocking, 0, 32)).toBe(28);
  } finally {
    await f.close();
  }
});

test("invalid accept pointers and flags preserve the queued connection and descriptor allocation", async () => {
  const f = await fixture();
  const { guest } = f;
  try {
    expect(await f.connect()).toBeGreaterThan(0);
    await guest.write(32, words(0xabcdef));
    for (const flags of [1, 2, 8, 16, 0x10000, -1])
      expect(await guest.call("sock_accept", 3, flags, 32)).toBe(28);
    for (const out of [-1, 4 * 1024 * 1024 - 3, 4 * 1024 * 1024])
      expect(await guest.call("sock_accept", 3, 0, out)).toBe(21);
    expect(uint(await guest.read(32, 4))).toBe(0xabcdef);
    expect((await poll(guest))[0]?.type).toBe(1);
    expect(await accepted(guest)).toBe(5);
    expect(await guest.call("fd_kind", 6)).toBe(-8);
    for (const fd of [0, 1, 2, 4]) expect(await guest.call("sock_accept", fd, 0, 32)).toBe(57);
    expect(await guest.call("sock_accept", 123, 0, 32)).toBe(8);
    expect(await guest.call("sock_accept", 5, -1, -1)).toBe(28);
    for (const op of ["sock_recv", "sock_send"])
      expect(await guest.call(op, 3, 0, 0, 0, 32, 36)).toBe(53);
    expect(await guest.call("sock_shutdown", 3, 2)).toBe(53);
    await guest.write(128, words(10, 1, 2, 3, 4));
    expect(await guest.call("sock_send", 0x7ffffffe, 128, 5, 0, 32)).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(20);
  } finally {
    await f.close();
  }
});

test("listener and accepted descriptor duplication preserve final-close, EOF and half-close lifetime", async () => {
  const f = await fixture();
  const { guest, peer } = f;
  try {
    expect(await guest.call("fd_fdstat_get", 3, 64)).toBe(0);
    const stat = await guest.read(64, 24);
    const rights = new DataView(stat.buffer, stat.byteOffset, stat.byteLength).getBigUint64(
      8,
      true,
    );
    expect(rights & 0x2000_0000n).toBe(0x2000_0000n);
    expect(await guest.call("fd_reopen", 3, 0, 0, rights, 32)).toBe(0);
    const listener = uint(await guest.read(32, 4));
    expect(await guest.call("fd_fdstat_set_flags", listener, 4)).toBe(0);
    expect(await guest.call("sock_accept", 3, 0, 32)).toBe(6);
    expect(await guest.call("fd_close", 3)).toBe(0);
    const conn = await f.connect();
    expect(conn).toBeGreaterThan(0);
    const fd = await accepted(guest, listener);
    expect(await guest.call("fd_fdstat_get", fd, 64)).toBe(0);
    const acceptedStat = await guest.read(64, 24);
    const acceptedRights = new DataView(
      acceptedStat.buffer,
      acceptedStat.byteOffset,
      acceptedStat.byteLength,
    ).getBigUint64(8, true);
    expect(acceptedRights & 0x2000_0000n).toBe(0n);
    expect(await guest.call("fd_reopen", fd, 0, 0, acceptedRights, 32)).toBe(0);
    const duplicate = uint(await guest.read(32, 4));
    expect(await guest.call("fd_close", fd)).toBe(0);
    await io(guest, "response", 8);
    expect(await guest.call("fd_write", duplicate, 0, 1, 32)).toBe(0);
    expect(await readPeer(peer, conn)).toEqual(bytes("response"));
    await peer.call({ op: "write", handle: conn, bytes: bytes("request!") });
    await peer.call({ op: "shutdown", handle: conn });
    expect(await guest.call("sock_recv", duplicate, 0, 1, 2, 32, 36)).toBe(0);
    expect(await guest.read(128, 8)).toEqual(bytes("request!"));
    expect(await guest.call("fd_read", duplicate, 0, 1, 32)).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(0);
    expect(await guest.call("sock_shutdown", duplicate, 2)).toBe(0);
    expect(await readPeer(peer, conn)).toBe(0);
    expect(await guest.call("fd_write", duplicate, 0, 1, 32)).toBe(64);
    expect(await guest.call("fd_close", duplicate)).toBe(0);
    expect(await guest.call("fd_close", listener)).toBe(0);
    expect(await f.connect()).toBe(-1);
  } finally {
    await f.close();
  }
});

test("last listener close ends unaccepted peers but accepted descriptors survive", async () => {
  const f = await fixture();
  try {
    const first = await f.connect();
    const fd = await accepted(f.guest);
    const queued = await f.connect();
    expect(await f.guest.call("fd_close", 3)).toBe(0);
    expect(await readPeer(f.peer, queued)).toBe(0);
    await io(f.guest, "survives", 8);
    expect(await f.guest.call("fd_write", fd, 0, 1, 32)).toBe(0);
    expect(await readPeer(f.peer, first)).toEqual(bytes("survives"));
    expect(await f.connect()).toBe(-1);
  } finally {
    await f.close();
  }
});

test("listen failures retain ENOTSUP and ADDRINUSE without invoking an outbound connector", async () => {
  const owner = await createRuntimeNetwork(() => {});
  let calls = 0;
  const guests: SocketGuest[] = [];
  try {
    for (const host of ["127.0.0.1", "127.0.0.1", "example.invalid"])
      guests.push(
        await socketGuest({
          network: owner.network,
          connect: async () => {
            calls++;
            throw Error("listener invoked connector");
          },
          bindings: [binding(32161, host)],
        }),
      );
    expect(await guests[1]!.call("sock_accept", 3, 0, 32)).toBe(3);
    expect(await guests[2]!.call("sock_accept", 3, 0, 32)).toBe(58);
    expect((await poll(guests[1]!))[0]?.error).toBe(3);
    expect(calls).toBe(0);
  } finally {
    for (const guest of guests) await guest.close();
    await owner.dispose();
  }
});

test("listener bindings reserve sparse numbers and stdio without moving unrelated preopens", async () => {
  const f = await fixture("127.0.0.1", [binding(32161, "127.0.0.1", 0), binding(32162, "::1", 9)]);
  try {
    expect(await f.guest.call("fd_prestat_get", 3, 64)).toBe(0);
    expect(await f.guest.call("fd_kind", 0)).toBe(5);
    expect(await f.guest.call("fd_kind", 9)).toBe(5);
    expect(await f.guest.call("inherited_fd", 3)).toBe(9);
    expect(await f.connect()).toBeGreaterThan(0);
    expect(await accepted(f.guest, 0)).toBe(4);
  } finally {
    await f.close();
  }
});

test("same WAT accept, poll, shutdown fixture runs through the normal Preview 1 executor", async () => {
  const owner = await createRuntimeNetwork(() => {});
  const peer = networkPeer(owner.network);
  let guest: SocketGuest | undefined;
  try {
    await peer.ready;
    guest = await socketGuest({
      network: owner.network,
      bindings: [binding()],
      interactive: false,
      module: await socketModule("preview1-listener.wat"),
    });
    await guest.stdout;
    const conn = Number(await peer.call({ op: "connect", port: 32161 }));
    expect(conn).toBeGreaterThan(0);
    await peer.call({ op: "write", handle: conn, bytes: bytes("loopback") });
    await peer.call({ op: "shutdown", handle: conn });
    expect(await readPeer(peer, conn)).toEqual(bytes("loopback"));
    expect(await readPeer(peer, conn)).toBe(0);
    expect(await guest.exit).toMatchObject({ type: "exit", code: 0 });
  } finally {
    await guest?.close();
    peer.close();
    await owner.dispose();
  }
});

test("binding snapshot rejects contradictory variants before activating networking", async () => {
  let activations = 0;
  const runtime = {
    network: async () => {
      activations++;
      throw Error("must not activate");
    },
  };
  await expect(
    createPreview1Network(runtime, {
      sockets: [
        {
          fd: 3,
          socket: {
            connect: { host: "localhost", port: 1 },
            listen: { host: "localhost", port: 2 },
          },
        },
      ],
    }),
  ).rejects.toThrow("either connect or listen");
  expect(activations).toBe(0);
});

test("listener accept rights are checked without consuming a pending connection", async () => {
  const f = await fixture();
  try {
    expect(await f.connect()).toBeGreaterThan(0);
    expect(await f.guest.call("fd_fdstat_get", 3, 64)).toBe(0);
    const stat = await f.guest.read(64, 24);
    const rights = new DataView(stat.buffer, stat.byteOffset, stat.byteLength).getBigUint64(
      8,
      true,
    );
    expect(await f.guest.call("fd_fdstat_set_rights", 3, rights & ~0x2000_0000n, 0n)).toBe(0);
    expect(await f.guest.call("sock_accept", 3, 0, 32)).toBe(76);
    expect((await poll(f.guest))[0]?.type).toBe(1);
    expect(await f.guest.call("fd_kind", 5)).toBe(-8);
  } finally {
    await f.close();
  }
});

test("revocation interrupts a blocking accept and teardown releases the virtual port", async () => {
  const f = await fixture();
  const waiting = f.guest.call("sock_accept", 3, 0, 32).then(
    () => false,
    () => true,
  );
  try {
    await Bun.sleep(10);
    f.guest.cancel();
    expect(await waiting).toBe(true);
  } finally {
    await f.guest.close();
  }
  try {
    const listener = Number(await f.peer.call({ op: "listen", port: 32161 }));
    expect(listener).toBeGreaterThan(0);
    await f.peer.call({ op: "close", handle: listener });
  } finally {
    await f.close();
  }
});

test("accepted descriptors skip the executor's reserved host-call trampoline", async () => {
  const owner = await createRuntimeNetwork(() => {});
  const peer = networkPeer(owner.network);
  let guest: SocketGuest | undefined;
  try {
    await peer.ready;
    guest = await socketGuest({ network: owner.network, bindings: [binding()], hostCallFd: 5 });
    expect(await peer.call({ op: "connect", port: 32161 })).toBeGreaterThan(0);
    expect(await accepted(guest)).toBe(6);
    await guest.write(128, words(10, 1, 2, 3, 4));
    expect(await guest.call("sock_send", 5, 128, 5, 0, 32)).toBe(0);
    expect(uint(await guest.read(32, 4))).toBe(20);
    expect(await guest.call("fd_kind", 5)).toBe(-8);
  } finally {
    await guest?.close();
    peer.close();
    await owner.dispose();
  }
});

test("listener binding collisions fail before a virtual port is allocated", async () => {
  const owner = await createRuntimeNetwork(() => {});
  const peer = networkPeer(owner.network);
  let guest: SocketGuest | undefined;
  try {
    await peer.ready;
    guest = await socketGuest({
      network: owner.network,
      bindings: [binding(32161, "localhost", 0x7ffffffe)],
    });
    expect((await guest.exit).message).toContain("collides with executor.hostCallFd");
    const listener = Number(await peer.call({ op: "listen", port: 32161 }));
    expect(listener).toBeGreaterThan(0);
    expect(await peer.call({ op: "close", handle: listener })).toBe(0);
  } finally {
    await guest?.close();
    peer.close();
    await owner.dispose();
  }
});

test("accepted nonblocking writes stop at real loopback credit and resume after a peer read", async () => {
  const f = await fixture();
  try {
    const conn = await f.connect();
    const fd = await accepted(f.guest, 3, 4);
    const payload = new Uint8Array(1 << 20).fill(85);
    await f.guest.write(128, payload);
    await f.guest.write(0, words(128, payload.length));
    expect(await f.guest.call("sock_send", fd, 0, 1, 0, 32)).toBe(0);
    expect(uint(await f.guest.read(32, 4))).toBe(payload.length);
    expect(await f.guest.call("sock_send", fd, 0, 1, 0, 32)).toBe(6);
    expect(await poll(f.guest, fd, 2)).toEqual([]);
    expect(await readPeer(f.peer, conn)).toEqual(payload.subarray(0, 65536));
    expect((await poll(f.guest, fd, 2, 1_000_000_000n))[0]?.type).toBe(2);
    await f.guest.write(0, words(128, 1));
    expect(await f.guest.call("fd_write", fd, 0, 1, 32)).toBe(0);
    expect(uint(await f.guest.read(32, 4))).toBe(1);
    expect(await f.guest.call("sock_shutdown", fd, 1)).toBe(0);
    expect(await f.guest.call("sock_recv", fd, 0, 1, 0, 32, 36)).toBe(0);
    expect(uint(await f.guest.read(32, 4))).toBe(0);
  } finally {
    await f.close();
  }
});
