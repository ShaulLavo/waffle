import { describe, expect, test } from "bun:test";
import { Wasi } from "../core/index.js";
import {
  F_GETLK,
  F_OFD_GETLK,
  F_OFD_SETLK,
  F_RDLCK,
  F_SETLK,
  F_SETLKW,
  F_UNLCK,
  F_WRLCK,
  LOCK_EX,
  LOCK_NB,
  LOCK_SH,
  LOCK_UN,
} from "../core/filesystem.js";
import { markOriginOfdClosed, resourceOfdLockState } from "../core/open-file.js";
import { RIGHTS_ALL, RIGHT_FD_READ, RIGHT_FD_WRITE } from "../core/rights.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { LockContentionError, LockTable } from "../fs/locks.js";
import { MemFS } from "../fs/memory.js";
import {
  createFilesystemConnection,
  createFilesystemIdentity,
  revokeFilesystem,
  type FilesystemConnection,
} from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";
import {
  createFilesystemDescriptorCodec,
  type FilesystemDescriptorToken,
} from "../proc/filesystem-codec.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

const EAGAIN = 6;
const EBADF = 8;
const EDEADLK = 16;
const EFAULT = 21;
const EINTR = 27;
const EINVAL = 28;
const EOVERFLOW = 61;

function lockGuestModule() {
  return guestModule("runtime_fs", [
    { name: "fd_flock", parameters: ["i32", "i32"] },
    { name: "fd_lock", parameters: ["i32", "i32", "i32", "i32", "i64", "i64", "i32"] },
  ]);
}

function makeMemWasi(fs: MemFS, pid = 42) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    pid,
    args: ["lock-guest"],
    env: {},
    fs,
    preopens: { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const mod = lockGuestModule();
  const instance = new WebAssembly.Instance(mod, wasi.imports(mod));
  wasi.start(instance);
  const fdFlock = guestFunction(instance, "fd_flock");
  const fdLock = guestFunction(instance, "fd_lock");
  const closeMod = guestModule("wasi_snapshot_preview1", [
    { name: "fd_close", parameters: ["i32"] },
  ]);
  const closeInst = new WebAssembly.Instance(closeMod, wasi.imports(closeMod));
  const fdClose = guestFunction(closeInst, "fd_close");
  return { wasi, memory, fdFlock, fdLock, fdClose };
}

function openMemFile(wasi: Wasi, fs: MemFS, path: string, rights: bigint = RIGHTS_ALL): number {
  const root = fs.preopen("/");
  const resolved = fs.resolve(root, path, true, true);
  if (typeof resolved === "number" || resolved.node === undefined)
    throw new Error(`failed to resolve ${path}: ${String(resolved)}`);
  const handle = resolved.node;
  fs.retain(handle);
  const resource = { kind: "file" as const, handle, offset: 0, append: false, fdflags: 0 };
  return wasi.descriptors.open(resource, rights, 0n, () => {
    markOriginOfdClosed(resource);
    const lock = resourceOfdLockState(resource);
    if (lock) fs.locks.releaseOfd(handle, lock.id);
    fs.release(handle);
  });
}

function readConflict(memory: WebAssembly.Memory, ptr: number) {
  const view = new DataView(memory.buffer);
  return {
    type: view.getUint32(ptr, true),
    pid: view.getInt32(ptr + 4, true),
    start: view.getBigInt64(ptr + 8, true),
    len: view.getBigInt64(ptr + 16, true),
  };
}

interface GuestWorkerHandle {
  readonly connection: FilesystemConnection;
  readonly interrupt: Int32Array;
  call<T = unknown>(payload: Record<string, unknown>): Promise<T>;
  terminate(): void;
}

function createServiceFixture() {
  const mem = new MemFS();
  mem.writeFile("/lock.dat", new Uint8Array(100));
  const backend = new MemoryBackend(mem);
  const service = new FilesystemService(backend);
  const rootPair = createFilesystemConnection();
  service.connect(rootPair.server);
  const rootClient = new FilesystemClient(rootPair.client);
  const clients: FilesystemClient[] = [rootClient];
  const workers: GuestWorkerHandle[] = [];

  const connectClient = (): FilesystemClient => {
    const pair = createFilesystemConnection(rootPair.client);
    service.connect(pair.server);
    const client = new FilesystemClient(pair.client);
    clients.push(client);
    return client;
  };

  const spawnWorker = async (
    pid: number,
    existingPair?: ReturnType<typeof createFilesystemConnection>,
  ): Promise<GuestWorkerHandle> => {
    const pair = existingPair ?? createFilesystemConnection(rootPair.client);
    if (!existingPair) service.connect(pair.server);
    const interruptBuf = new SharedArrayBuffer(4);
    const interrupt = new Int32Array(interruptBuf);
    const worker = new Worker(new URL("./fixtures/advisory-lock-worker.ts", import.meta.url).href, {
      type: "module",
    });
    const ready = Promise.withResolvers<void>();
    const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
    let nextId = 1;
    worker.onmessage = ({ data }) => {
      if (data.ready) {
        ready.resolve();
        return;
      }
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if ("error" in data) entry.reject(new Error(data.error));
      else entry.resolve(data.value);
    };
    worker.postMessage({ init: true, connection: pair.client, pid, interrupt: interruptBuf }, [
      pair.client.port,
    ]);
    await ready.promise;
    const handle: GuestWorkerHandle = {
      connection: pair.client,
      interrupt,
      call<T = unknown>(payload: Record<string, unknown>): Promise<T> {
        const id = nextId++;
        const deferred = Promise.withResolvers<unknown>();
        pending.set(id, deferred);
        worker.postMessage({ ...payload, id });
        return deferred.promise as Promise<T>;
      },
      terminate() {
        worker.terminate();
      },
    };
    workers.push(handle);
    return handle;
  };

  const cleanup = async () => {
    for (const w of workers) {
      revokeFilesystem(w.connection);
      w.terminate();
    }
    for (const client of clients) client.dispose();
    await service.shutdown();
    service.dispose();
  };

  return {
    mem,
    backend,
    service,
    rootConnection: rootPair.client,
    connectClient,
    spawnWorker,
    cleanup,
  };
}

describe("LockTable unit semantics", () => {
  test("flock shared/exclusive compatibility, downgrade, upgrade, and unlock", () => {
    const table = new LockTable();
    expect(table.flock(1, "1:1", 1, LOCK_SH | LOCK_NB).errno).toBe(0);
    expect(table.flock(1, "2:1", 2, LOCK_SH | LOCK_NB).errno).toBe(0);
    expect(table.flock(1, "3:1", 3, LOCK_EX | LOCK_NB).errno).toBe(EAGAIN);
    expect(table.flock(1, "1:1", 1, LOCK_EX | LOCK_NB).errno).toBe(EAGAIN);
    expect(table.flock(1, "3:1", 3, LOCK_EX | LOCK_NB).errno).toBe(EAGAIN);
    expect(table.flock(1, "2:1", 2, LOCK_UN).errno).toBe(0);
    expect(table.flock(1, "1:1", 1, LOCK_EX | LOCK_NB).errno).toBe(0);
    expect(table.flock(1, "2:1", 2, LOCK_SH | LOCK_NB).errno).toBe(EAGAIN);
    expect(table.flock(1, "1:1", 1, LOCK_SH | LOCK_NB).errno).toBe(0);
    expect(table.flock(1, "2:1", 2, LOCK_SH | LOCK_NB).errno).toBe(0);
    expect(table.flock(1, "1:1", 1, 0).errno).toBe(EINVAL);
    expect(table.flock(1, "1:1", 1, LOCK_SH | LOCK_EX).errno).toBe(EINVAL);
    expect(table.flock(1, "1:1", 1, 16).errno).toBe(EINVAL);
  });

  test("blocking flock upgrade drops prior shared lock before sleeping so two upgraders do not deadlock", () => {
    const table = new LockTable();
    expect(table.flock(1, "1:1", 1, LOCK_SH).errno).toBe(0);
    expect(table.flock(1, "2:1", 2, LOCK_SH).errno).toBe(0);
    let waitA: LockContentionError | undefined;
    try {
      table.flock(1, "1:1", 1, LOCK_EX, true);
    } catch (error) {
      if (error instanceof LockContentionError) waitA = error;
      else throw error;
    }
    expect(waitA).toBeDefined();
    expect(table.flock(1, "2:1", 2, LOCK_EX, true).errno).toBe(0);
    table.dispose();
  });

  test("POSIX range splitting, coalescing, upgrading, downgrading, and F_GETLK", () => {
    const table = new LockTable();
    expect(
      table.setRangeLock(7, undefined, 1, 101, { type: F_WRLCK, start: 0, len: 100 }, false).errno,
    ).toBe(0);
    expect(
      table.setRangeLock(7, undefined, 1, 101, { type: F_UNLCK, start: 30, len: 30 }, false).errno,
    ).toBe(0);
    expect(
      table.setRangeLock(7, undefined, 2, 202, { type: F_WRLCK, start: 30, len: 30 }, false).errno,
    ).toBe(0);
    expect(table.getRangeLock(7, undefined, 2, { type: F_RDLCK, start: 10, len: 10 })).toEqual({
      type: F_WRLCK,
      pid: 101,
      start: 0,
      len: 30,
    });
    expect(table.getRangeLock(7, undefined, 2, { type: F_RDLCK, start: 70, len: 0 })).toEqual({
      type: F_WRLCK,
      pid: 101,
      start: 60,
      len: 40,
    });
    expect(
      table.setRangeLock(7, undefined, 1, 101, { type: F_RDLCK, start: 0, len: 30 }, false).errno,
    ).toBe(0);
    expect(
      table.setRangeLock(7, undefined, 2, 202, { type: F_RDLCK, start: 0, len: 20 }, false).errno,
    ).toBe(0);
    expect(
      table.setRangeLock(7, undefined, 2, 202, { type: F_RDLCK, start: 20, len: 10 }, false).errno,
    ).toBe(0);
    expect(table.getRangeLock(7, undefined, 1, { type: F_WRLCK, start: 5, len: 1 })).toEqual({
      type: F_RDLCK,
      pid: 202,
      start: 0,
      len: 30,
    });
  });

  test("POSIX F_SETLKW detects 2-way and 3-way deadlocks with EDEADLK", () => {
    const table = new LockTable();
    expect(
      table.setRangeLock(9, undefined, 1, 11, { type: F_WRLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    expect(
      table.setRangeLock(9, undefined, 2, 22, { type: F_WRLCK, start: 10, len: 10 }, false).errno,
    ).toBe(0);
    expect(
      table.setRangeLock(9, undefined, 3, 33, { type: F_WRLCK, start: 20, len: 10 }, false).errno,
    ).toBe(0);
    expect(() =>
      table.setRangeLock(9, undefined, 1, 11, { type: F_WRLCK, start: 10, len: 10 }, true, true),
    ).toThrow(LockContentionError);
    expect(() =>
      table.setRangeLock(9, undefined, 2, 22, { type: F_WRLCK, start: 20, len: 10 }, true, true),
    ).toThrow(LockContentionError);
    expect(
      table.setRangeLock(9, undefined, 3, 33, { type: F_WRLCK, start: 0, len: 10 }, true, true)
        .errno,
    ).toBe(EDEADLK);
    table.dispose();
  });
});

describe("runtime_fs advisory locks over WASI", () => {
  test("fd_flock and fd_lock work over MemFS with dup, rights, whence, negative len, and unlink", () => {
    const fs = new MemFS();
    fs.writeFile("/a.txt", new Uint8Array(64));
    const { wasi, memory, fdFlock, fdLock, fdClose } = makeMemWasi(fs, 42);

    const fd1 = openMemFile(wasi, fs, "a.txt", RIGHTS_ALL);
    const fd2 = openMemFile(wasi, fs, "a.txt", RIGHTS_ALL);
    const roFd = openMemFile(wasi, fs, "a.txt", RIGHT_FD_READ);
    const woFd = openMemFile(wasi, fs, "a.txt", RIGHT_FD_WRITE);

    expect(fdFlock(fd1, LOCK_EX | LOCK_NB)).toBe(0);
    expect(fdFlock(fd2, LOCK_EX | LOCK_NB)).toBe(EAGAIN);
    expect(fdFlock(fd2, LOCK_SH | LOCK_NB)).toBe(EAGAIN);

    // dup shares OFD: closing one dup keeps flock held until the last dup closes.
    const dupFd = wasi.descriptors.dup(fd1);
    expect(dupFd).toBeGreaterThanOrEqual(0);
    expect(fdClose(fd1)).toBe(0);
    expect(fdFlock(fd2, LOCK_EX | LOCK_NB)).toBe(EAGAIN);
    expect(fdClose(dupFd)).toBe(0);
    expect(fdFlock(fd2, LOCK_EX | LOCK_NB)).toBe(0);

    // flock works on read-only fd and directory fd (fd 3 is `/` preopen).
    expect(fdFlock(fd2, LOCK_UN)).toBe(0);
    expect(fdFlock(roFd, LOCK_EX | LOCK_NB)).toBe(0);
    expect(fdFlock(3, LOCK_EX | LOCK_NB)).toBe(0);
    expect(fdFlock(3, LOCK_UN)).toBe(0);

    // Non-lockable streams return EINVAL; bad fd returns EBADF.
    expect(fdFlock(1, LOCK_EX | LOCK_NB)).toBe(EINVAL);
    expect(fdFlock(999, LOCK_EX | LOCK_NB)).toBe(EBADF);

    // POSIX fcntl rights checks.
    expect(fdLock(roFd, F_SETLK, F_WRLCK, 0, 0n, 10n, 0)).toBe(EBADF);
    expect(fdLock(woFd, F_SETLK, F_RDLCK, 0, 0n, 10n, 0)).toBe(EBADF);
    expect(fdLock(roFd, F_SETLK, F_RDLCK, 0, 0n, 10n, 0)).toBe(0);

    // OFD byte-range locks with SEEK_END + negative length.
    expect(fdLock(fd2, F_OFD_SETLK, F_WRLCK, 2, 0n, -16n, 0)).toBe(0);
    const conflictPtr = 128;
    expect(fdLock(roFd, F_OFD_GETLK, F_RDLCK, 0, 50n, 4n, conflictPtr)).toBe(0);
    expect(readConflict(memory, conflictPtr)).toEqual({
      type: F_WRLCK,
      pid: -1,
      start: 48n,
      len: 16n,
    });

    // Invalid ranges and out-of-bounds out_ptr.
    expect(fdLock(fd2, F_SETLK, F_WRLCK, 0, -5n, 10n, 0)).toBe(EINVAL);
    expect(fdLock(fd2, F_SETLK, F_WRLCK, 0, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0n, 0)).toBe(
      EOVERFLOW,
    );
    expect(fdLock(fd2, F_GETLK, F_WRLCK, 0, 0n, 10n, memory.buffer.byteLength - 8)).toBe(EFAULT);

    // Unlink keeps lock on old inode; new file at same path has independent locks.
    const root = fs.preopen("/");
    const target = fs.resolve(root, "a.txt", false, true);
    if (typeof target === "number") throw new Error("resolve failed");
    expect(fs.removePath(target, false)).toBe(0);
    fs.writeFile("/a.txt", new Uint8Array(16));
    const freshFd = openMemFile(wasi, fs, "a.txt", RIGHTS_ALL);
    expect(fdFlock(freshFd, LOCK_EX | LOCK_NB)).toBe(0);

    wasi.releasePosixLocks();
    wasi.descriptors.dispose();
  });

  test("closing ANY fd to an inode releases POSIX record locks while keeping flock on other OFDs", async () => {
    const f = createServiceFixture();
    try {
      const workerA = await f.spawnWorker(10);
      const workerB = await f.spawnWorker(20);

      const a1 = await workerA.call<number>({ op: "open", path: "lock.dat" });
      const a2 = await workerA.call<number>({ op: "open", path: "lock.dat" });
      const b1 = await workerB.call<number>({ op: "open", path: "lock.dat" });

      expect(
        await workerA.call<{ errno: number }>({
          op: "lock",
          fd: a1,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "50",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await workerA.call<number>({ op: "flock", fd: a1, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);

      expect(
        await workerB.call<{ errno: number }>({
          op: "lock",
          fd: b1,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "50",
        }),
      ).toEqual({ errno: EAGAIN });
      expect(
        await workerB.call<number>({ op: "flock", fd: b1, operation: LOCK_EX | LOCK_NB }),
      ).toBe(EAGAIN);
      expect(
        await workerB.call<{ errno: number; conflict: unknown }>({
          op: "lock",
          fd: b1,
          cmd: F_GETLK,
          type: F_WRLCK,
          whence: 0,
          start: "10",
          len: "10",
        }),
      ).toEqual({
        errno: 0,
        conflict: { type: F_WRLCK, pid: 10, start: "0", len: "50" },
      });

      // Closing a2 (a different fd to the same inode) releases POSIX record locks, NOT flock on a1.
      expect(await workerA.call<number>({ op: "close", fd: a2 })).toBe(0);
      expect(
        await workerB.call<{ errno: number }>({
          op: "lock",
          fd: b1,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "50",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await workerB.call<number>({ op: "flock", fd: b1, operation: LOCK_EX | LOCK_NB }),
      ).toBe(EAGAIN);

      // Closing a1 finally releases the flock.
      expect(await workerA.call<number>({ op: "close", fd: a1 })).toBe(0);
      expect(
        await workerB.call<number>({ op: "flock", fd: b1, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("session revocation / process exit releases flock and POSIX locks and wakes blocked workers", async () => {
    const f = createServiceFixture();
    try {
      const holder = await f.spawnWorker(100);
      const flockWaiter = await f.spawnWorker(200);
      const posixWaiter = await f.spawnWorker(300);

      const hFd = await holder.call<number>({ op: "open", path: "lock.dat" });
      const fFd = await flockWaiter.call<number>({ op: "open", path: "lock.dat" });
      const pFd = await posixWaiter.call<number>({ op: "open", path: "lock.dat" });

      expect(
        await holder.call<number>({ op: "flock", fd: hFd, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);
      expect(
        await holder.call<{ errno: number }>({
          op: "lock",
          fd: hFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "0",
        }),
      ).toEqual({ errno: 0 });

      // Start blocking flock and blocking F_SETLKW in separate real Worker threads.
      const blockingFlock = flockWaiter.call<number>({ op: "flock", fd: fFd, operation: LOCK_EX });
      const blockingPosix = posixWaiter.call<{ errno: number }>({
        op: "lock",
        fd: pFd,
        cmd: F_SETLKW,
        type: F_WRLCK,
        whence: 0,
        start: "0",
        len: "0",
      });

      // Wait briefly so waiters park, then verify service stays responsive to unrelated ops!
      await new Promise((resolve) => setTimeout(resolve, 30));
      const probeClient = f.connectClient();
      const root = await probeClient.asyncCall("preopen", ["/"]);
      const stat = await probeClient.asyncCall("stat", [root]);
      expect(stat.kind).toBe("directory");

      // Simulate holder crash / SIGKILL: revoke without closing fds or unlocking.
      revokeFilesystem(holder.connection);
      holder.terminate();

      expect(await blockingFlock).toBe(0);
      expect(await blockingPosix).toEqual({ errno: 0 });
    } finally {
      await f.cleanup();
    }
  });

  test("inherited fd via filesystem-codec shares OFD flock until last live holder closes or exits", async () => {
    const f = createServiceFixture();
    try {
      const parent = await f.spawnWorker(1);
      const contender = await f.spawnWorker(3);

      const parentFd = await parent.call<number>({ op: "open", path: "lock.dat" });
      const contenderFd = await contender.call<number>({ op: "open", path: "lock.dat" });

      expect(
        await parent.call<number>({ op: "flock", fd: parentFd, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);
      expect(
        await contender.call<number>({
          op: "flock",
          fd: contenderFd,
          operation: LOCK_EX | LOCK_NB,
        }),
      ).toBe(EAGAIN);

      // Export parent fd to child before connecting child to service (exact spawn sequence).
      const childPair = createFilesystemConnection(f.rootConnection);
      const token = await parent.call<FilesystemDescriptorToken>({
        op: "export",
        fd: parentFd,
        target: {
          ...childPair.client,
          port: undefined as unknown as MessagePort,
        },
      });
      childPair.client.reservations.push(token.reservation);
      childPair.server.reservations.push(token.reservation);
      f.service.connect(childPair.server);
      const child = await f.spawnWorker(2, childPair);
      const childFd = await child.call<number>({ op: "import", token });

      // Parent closes its fd AND is revoked/terminated: child still holds the OFD so lock stays held!
      expect(await parent.call<number>({ op: "close", fd: parentFd })).toBe(0);
      await parent.call({ op: "dispose" });
      revokeFilesystem(parent.connection);
      parent.terminate();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        await contender.call<number>({
          op: "flock",
          fd: contenderFd,
          operation: LOCK_EX | LOCK_NB,
        }),
      ).toBe(EAGAIN);

      // Child can downgrade/upgrade the shared OFD seamlessly.
      expect(
        await child.call<number>({ op: "flock", fd: childFd, operation: LOCK_SH | LOCK_NB }),
      ).toBe(0);
      expect(
        await contender.call<number>({
          op: "flock",
          fd: contenderFd,
          operation: LOCK_SH | LOCK_NB,
        }),
      ).toBe(0);
      expect(
        await contender.call<number>({ op: "flock", fd: contenderFd, operation: LOCK_UN }),
      ).toBe(0);
      expect(
        await child.call<number>({ op: "flock", fd: childFd, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);

      // Closing child's fd releases the OFD lock -> contender acquires immediately.
      expect(await child.call<number>({ op: "close", fd: childFd })).toBe(0);
      expect(
        await contender.call<number>({
          op: "flock",
          fd: contenderFd,
          operation: LOCK_EX | LOCK_NB,
        }),
      ).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("blocking F_SETLKW is interrupted by pending signal with EINTR and cleans up service waiter", async () => {
    const f = createServiceFixture();
    try {
      const holder = await f.spawnWorker(1);
      const waiter = await f.spawnWorker(2);

      const hFd = await holder.call<number>({ op: "open", path: "lock.dat" });
      const wFd = await waiter.call<number>({ op: "open", path: "lock.dat" });
      expect(
        await holder.call<{ errno: number }>({
          op: "lock",
          fd: hFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "0",
        }),
      ).toEqual({ errno: 0 });

      // Start blocking F_SETLKW in waiter, then deliver signal after it parks!
      const blocked = waiter.call<{ errno: number }>({
        op: "lock",
        fd: wFd,
        cmd: F_SETLKW,
        type: F_WRLCK,
        whence: 0,
        start: "0",
        len: "0",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      Atomics.store(waiter.interrupt, 0, 2); // SIGINT pending
      expect(await blocked).toEqual({ errno: EINTR });

      // Clear signal, unlock in holder, and verify waiter acquires cleanly.
      Atomics.store(waiter.interrupt, 0, 0);
      expect(
        await holder.call<{ errno: number }>({
          op: "lock",
          fd: hFd,
          cmd: F_SETLK,
          type: F_UNLCK,
          whence: 0,
          start: "0",
          len: "0",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await waiter.call<{ errno: number }>({
          op: "lock",
          fd: wFd,
          cmd: F_SETLKW,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "0",
        }),
      ).toEqual({ errno: 0 });
    } finally {
      await f.cleanup();
    }
  });

  test("blocking F_SETLKW detects deadlock across two real Worker threads with EDEADLK", async () => {
    const f = createServiceFixture();
    try {
      const workerA = await f.spawnWorker(11);
      const workerB = await f.spawnWorker(22);

      const aFd = await workerA.call<number>({ op: "open", path: "lock.dat" });
      const bFd = await workerB.call<number>({ op: "open", path: "lock.dat" });

      // A locks [0, 10), B locks [10, 20).
      expect(
        await workerA.call<{ errno: number }>({
          op: "lock",
          fd: aFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "10",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await workerB.call<{ errno: number }>({
          op: "lock",
          fd: bFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "10",
          len: "10",
        }),
      ).toEqual({ errno: 0 });

      // A blocks waiting for [10, 20).
      const waitA = workerA.call<{ errno: number }>({
        op: "lock",
        fd: aFd,
        cmd: F_SETLKW,
        type: F_WRLCK,
        whence: 0,
        start: "10",
        len: "10",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      // B tries to block waiting for [0, 10) -> immediate EDEADLK!
      expect(
        await workerB.call<{ errno: number }>({
          op: "lock",
          fd: bFd,
          cmd: F_SETLKW,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "10",
        }),
      ).toEqual({ errno: EDEADLK });

      // B unlocks [10, 20) -> A immediately unblocks and succeeds!
      expect(
        await workerB.call<{ errno: number }>({
          op: "lock",
          fd: bFd,
          cmd: F_SETLK,
          type: F_UNLCK,
          whence: 0,
          start: "10",
          len: "10",
        }),
      ).toEqual({ errno: 0 });
      expect(await waitA).toEqual({ errno: 0 });
    } finally {
      await f.cleanup();
    }
  });

  test("inherited flock survives child close and releases immediately when last live fd closes", async () => {
    const f = createServiceFixture();
    try {
      const parent = await f.spawnWorker(31);
      const other = await f.spawnWorker(32);

      const pFd = await parent.call<number>({ op: "open", path: "lock.dat" });
      const oFd = await other.call<number>({ op: "open", path: "lock.dat" });
      expect(
        await parent.call<number>({ op: "flock", fd: pFd, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);

      const childPair = createFilesystemConnection(f.rootConnection);
      const token = await parent.call<FilesystemDescriptorToken>({
        op: "export",
        fd: pFd,
        target: {
          ...childPair.client,
          port: undefined as unknown as MessagePort,
        },
      });
      childPair.client.reservations.push(token.reservation);
      childPair.server.reservations.push(token.reservation);
      f.service.connect(childPair.server);
      const child = await f.spawnWorker(33, childPair);
      const cFd = await child.call<number>({ op: "import", token });

      // Simulate broker/controller holding a proxy copy of the same reservation token.
      const controllerCodec = createFilesystemDescriptorCodec(childPair.client, undefined, () =>
        f.service.sweep(),
      );

      // Child closes first: parent still holds the OFD, so lock stays held.
      expect(await child.call<number>({ op: "close", fd: cFd })).toBe(0);
      // Redundant controller discard on the same token must be idempotent and never drop parent's lock.
      controllerCodec.discard(token);
      expect(await other.call<number>({ op: "flock", fd: oFd, operation: LOCK_EX | LOCK_NB })).toBe(
        EAGAIN,
      );

      // Parent closes last live descriptor: lock must release immediately even while child stays alive.
      expect(await parent.call<number>({ op: "close", fd: pFd })).toBe(0);
      expect(await other.call<number>({ op: "flock", fd: oFd, operation: LOCK_EX | LOCK_NB })).toBe(
        0,
      );
    } finally {
      await f.cleanup();
    }
  });

  test("lock acquired after inheriting an unlocked fd survives locker revocation while peer stays open", async () => {
    const f = createServiceFixture();
    try {
      const parent = await f.spawnWorker(41);
      const other = await f.spawnWorker(42);

      const pFd = await parent.call<number>({ op: "open", path: "lock.dat" });
      const oFd = await other.call<number>({ op: "open", path: "lock.dat" });

      // Export BEFORE acquiring any lock.
      const childPair = createFilesystemConnection(f.rootConnection);
      const token = await parent.call<FilesystemDescriptorToken>({
        op: "export",
        fd: pFd,
        target: {
          ...childPair.client,
          port: undefined as unknown as MessagePort,
        },
      });
      childPair.client.reservations.push(token.reservation);
      childPair.server.reservations.push(token.reservation);
      f.service.connect(childPair.server);
      const child = await f.spawnWorker(43, childPair);
      const cFd = await child.call<number>({ op: "import", token });

      // Parent locks after sharing, then crashes/revokes without closing pFd.
      expect(
        await parent.call<number>({ op: "flock", fd: pFd, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);
      revokeFilesystem(parent.connection);
      f.service.sweep();

      // Child still holds the inherited OFD -> lock MUST remain held.
      expect(await other.call<number>({ op: "flock", fd: oFd, operation: LOCK_EX | LOCK_NB })).toBe(
        EAGAIN,
      );

      // Child closes the last live descriptor -> lock MUST release immediately.
      expect(await child.call<number>({ op: "close", fd: cFd })).toBe(0);
      expect(await other.call<number>({ op: "flock", fd: oFd, operation: LOCK_EX | LOCK_NB })).toBe(
        0,
      );
    } finally {
      await f.cleanup();
    }
  });

  test("inherited F_OFD_SETLK byte-range lock survives originator revocation until child closes", async () => {
    const f = createServiceFixture();
    try {
      const parent = await f.spawnWorker(51);
      const other = await f.spawnWorker(52);

      const pFd = await parent.call<number>({ op: "open", path: "lock.dat" });
      const oFd = await other.call<number>({ op: "open", path: "lock.dat" });
      expect(
        await parent.call<{ errno: number }>({
          op: "lock",
          fd: pFd,
          cmd: F_OFD_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "64",
        }),
      ).toEqual({ errno: 0 });

      const childPair = createFilesystemConnection(f.rootConnection);
      const token = await parent.call<FilesystemDescriptorToken>({
        op: "export",
        fd: pFd,
        target: {
          ...childPair.client,
          port: undefined as unknown as MessagePort,
        },
      });
      childPair.client.reservations.push(token.reservation);
      childPair.server.reservations.push(token.reservation);
      f.service.connect(childPair.server);
      const child = await f.spawnWorker(53, childPair);
      const cFd = await child.call<number>({ op: "import", token });

      revokeFilesystem(parent.connection);
      f.service.sweep();

      // Child still holds the OFD -> F_OFD_SETLK range lock MUST stay held.
      expect(
        await other.call<{ errno: number }>({
          op: "lock",
          fd: oFd,
          cmd: F_OFD_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "64",
        }),
      ).toEqual({ errno: EAGAIN });

      // Child closes -> OFD range lock releases immediately.
      expect(await child.call<number>({ op: "close", fd: cFd })).toBe(0);
      expect(
        await other.call<{ errno: number }>({
          op: "lock",
          fd: oFd,
          cmd: F_OFD_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "64",
        }),
      ).toEqual({ errno: 0 });
    } finally {
      await f.cleanup();
    }
  });

  test("unadopted exported OFD lock releases when controller discards token without a client", async () => {
    const f = createServiceFixture();
    try {
      const parent = await f.spawnWorker(61);
      const other = await f.spawnWorker(62);

      const pFd = await parent.call<number>({ op: "open", path: "lock.dat" });
      const oFd = await other.call<number>({ op: "open", path: "lock.dat" });
      expect(
        await parent.call<number>({ op: "flock", fd: pFd, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);

      // Export to a child identity that never connects (simulates failed spawn).
      const childIdentity = createFilesystemIdentity(f.rootConnection);
      const token = await parent.call<FilesystemDescriptorToken>({
        op: "export",
        fd: pFd,
        target: childIdentity,
      });

      // Parent closes its own fd while the reservation is still in flight -> lock stays held.
      expect(await parent.call<number>({ op: "close", fd: pFd })).toBe(0);
      expect(await other.call<number>({ op: "flock", fd: oFd, operation: LOCK_EX | LOCK_NB })).toBe(
        EAGAIN,
      );

      // Controller (identity-only, no FilesystemClient) discards the token -> lock releases.
      const controllerCodec = createFilesystemDescriptorCodec(childIdentity, undefined, () =>
        f.service.sweep(),
      );
      controllerCodec.discard(token);
      expect(await other.call<number>({ op: "flock", fd: oFd, operation: LOCK_EX | LOCK_NB })).toBe(
        0,
      );
    } finally {
      await f.cleanup();
    }
  });

  test("fd_renumber replacing an open fd releases POSIX locks on that inode while keeping flock", async () => {
    const f = createServiceFixture();
    try {
      f.backend.fs.writeFile("/other.dat", new Uint8Array(16));
      const workerA = await f.spawnWorker(71);
      const workerB = await f.spawnWorker(72);

      const a1 = await workerA.call<number>({ op: "open", path: "lock.dat" });
      const a2 = await workerA.call<number>({ op: "open", path: "lock.dat" });
      const aOther = await workerA.call<number>({ op: "open", path: "other.dat" });
      const b1 = await workerB.call<number>({ op: "open", path: "lock.dat" });

      expect(
        await workerA.call<{ errno: number }>({
          op: "lock",
          fd: a1,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "32",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await workerA.call<number>({ op: "flock", fd: a1, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);

      // Replacing a2 via fd_renumber closes a2 -> POSIX locks release, flock on a1 stays held.
      expect(await workerA.call<number>({ op: "renumber", from: aOther, to: a2 })).toBe(0);
      expect(
        await workerB.call<{ errno: number }>({
          op: "lock",
          fd: b1,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "32",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await workerB.call<number>({ op: "flock", fd: b1, operation: LOCK_EX | LOCK_NB }),
      ).toBe(EAGAIN);
    } finally {
      await f.cleanup();
    }
  });
});
