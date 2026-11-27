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
import { releaseOriginOfd } from "../core/open-file.js";
import { RIGHTS_ALL, RIGHT_FD_READ, RIGHT_FD_WRITE } from "../core/rights.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { LockContentionError, LockTable } from "../fs/locks.js";
import { MemFS } from "../fs/memory.js";
import {
  connectFilesystemIdentity,
  createFilesystemConnection,
  createFilesystemIdentity,
  createProcessFilesystemIdentity,
  reapFilesystem,
  revokeFilesystem,
  type FilesystemConnection,
} from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";
import {
  createFilesystemDescriptorCodec,
  type FilesystemDescriptorToken,
} from "../proc/filesystem-codec.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";
import { openVfsBackend } from "./fixtures/vfs-backends.js";

const EAGAIN = 6;
const EBADF = 8;
const EDEADLK = 16;
const EFAULT = 21;
const EINTR = 27;
const EINVAL = 28;
const ENOLCK = 46;
const ENOTSUP = 58;
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
  return wasi.descriptors.open(resource, rights, 0n, () => releaseOriginOfd(fs, resource));
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

async function launchLockWorker(
  connection: FilesystemConnection,
  pid: number,
): Promise<GuestWorkerHandle> {
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
  worker.postMessage({ init: true, connection, pid, interrupt: interruptBuf }, [connection.port]);
  await ready.promise;
  return {
    connection,
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
    const handle = await launchLockWorker(pair.client, pid);
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
  test("flock shared/exclusive compatibility, Linux conversion drop, downgrade, and unlock", () => {
    const table = new LockTable();
    expect(table.flock(1, "1:1", 1, LOCK_SH | LOCK_NB).errno).toBe(0);
    expect(table.flock(1, "2:1", 2, LOCK_SH | LOCK_NB).errno).toBe(0);
    // Non-conversion failed acquisition leaves existing locks untouched.
    expect(table.flock(1, "3:1", 3, LOCK_EX | LOCK_NB).errno).toBe(EAGAIN);
    // Same-mode re-lock keeps the existing shared lock.
    expect(table.flock(1, "1:1", 1, LOCK_SH | LOCK_NB).errno).toBe(0);
    // Linux flock(2) conversion: failed nonblocking SH -> EX drops caller's prior LOCK_SH.
    expect(table.flock(1, "1:1", 1, LOCK_EX | LOCK_NB).errno).toBe(EAGAIN);
    expect(table.flock(1, "3:1", 3, LOCK_EX | LOCK_NB).errno).toBe(EAGAIN);
    expect(table.flock(1, "2:1", 2, LOCK_UN).errno).toBe(0);
    // Because 1:1 dropped LOCK_SH on failed conversion, 3:1 now acquires LOCK_EX immediately.
    expect(table.flock(1, "3:1", 3, LOCK_EX | LOCK_NB).errno).toBe(0);
    expect(table.flock(1, "3:1", 3, LOCK_UN).errno).toBe(0);
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

    // Invalid ranges, F_GETLK with F_UNLCK, and out-of-bounds out_ptr.
    expect(fdLock(fd2, F_GETLK, F_UNLCK, 0, 0n, 10n, conflictPtr)).toBe(EINVAL);
    expect(fdLock(fd2, F_OFD_GETLK, F_UNLCK, 0, 0n, 10n, conflictPtr)).toBe(EINVAL);
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

  test("fatal ExecutionUnwind unwinds through blocking lock wait, nonblocking flock ignores handled signals, and spoofed ofdId is rejected", async () => {
    const f = createServiceFixture();
    try {
      const holder = await f.spawnWorker(81);
      const peer = await f.spawnWorker(82);
      const hFd = await holder.call<number>({ op: "open", path: "lock.dat" });
      const pFd = await peer.call<number>({ op: "open", path: "lock.dat" });
      expect(
        await holder.call<number>({ op: "flock", fd: hFd, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);

      // Unauthorized cross-session OFD spoofing is rejected with EACCES (2).
      expect(
        await peer.call<number>({
          op: "rawFlock",
          fd: pFd,
          ofdId: `${holder.connection.owner}:1`,
          operation: LOCK_UN,
        }),
      ).toBe(2);

      // Nonblocking LOCK_NB and LOCK_UN must not fail with EINTR when a handled signal is pending.
      Atomics.store(peer.interrupt, 0, 1);
      expect(await peer.call<number>({ op: "flock", fd: pFd, operation: LOCK_EX | LOCK_NB })).toBe(
        EAGAIN,
      );
      expect(await peer.call<number>({ op: "flock", fd: pFd, operation: LOCK_UN })).toBe(0);

      // Fatal ExecutionUnwind from checkActive propagates instead of returning EIO or EINTR.
      await peer.call({ op: "setFatal", fatal: true });
      expect(await peer.call<unknown>({ op: "flock", fd: pFd, operation: LOCK_EX })).toBe(
        "FATAL_UNWIND",
      );
    } finally {
      await f.cleanup();
    }
  });

  test("inherited directory descriptor shares OFD flock identity and lifetime across workers", async () => {
    const f = createServiceFixture();
    try {
      const parent = await f.spawnWorker(91);
      const other = await f.spawnWorker(92);

      // fd 3 is the `/` preopened directory.
      expect(await parent.call<number>({ op: "flock", fd: 3, operation: LOCK_EX | LOCK_NB })).toBe(
        0,
      );
      expect(await other.call<number>({ op: "flock", fd: 3, operation: LOCK_EX | LOCK_NB })).toBe(
        EAGAIN,
      );

      const childPair = createFilesystemConnection(f.rootConnection);
      const token = await parent.call<FilesystemDescriptorToken>({
        op: "export",
        fd: 3,
        target: {
          ...childPair.client,
          port: undefined as unknown as MessagePort,
        },
      });
      childPair.client.reservations.push(token.reservation);
      childPair.server.reservations.push(token.reservation);
      f.service.connect(childPair.server);
      const child = await f.spawnWorker(93, childPair);
      const cDir = await child.call<number>({ op: "import", token });

      // Child shares the same OFD so re-locking LOCK_EX succeeds instead of EAGAIN.
      expect(
        await child.call<number>({ op: "flock", fd: cDir, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);

      // Parent revokes -> child still holds the directory OFD -> lock stays held.
      revokeFilesystem(parent.connection);
      f.service.sweep();
      expect(await other.call<number>({ op: "flock", fd: 3, operation: LOCK_EX | LOCK_NB })).toBe(
        EAGAIN,
      );

      // Child closes -> lock releases immediately.
      expect(await child.call<number>({ op: "close", fd: cDir })).toBe(0);
      expect(await other.call<number>({ op: "flock", fd: 3, operation: LOCK_EX | LOCK_NB })).toBe(
        0,
      );
    } finally {
      await f.cleanup();
    }
  });

  test("cross-inode ofdId reuse is rejected, downgrade rollback preserves mutual exclusion, and DescriptorTable.close releases POSIX locks", () => {
    const table = new LockTable();
    // Binding an ofdId to inode 1 rejects reusing the same ofdId on inode 2.
    expect(table.flock(1, "1:1", 1, LOCK_EX | LOCK_NB).errno).toBe(0);
    expect(table.flock(2, "1:1", 1, LOCK_EX | LOCK_NB).errno).toBe(2);
    expect(
      table.setRangeLock(2, "1:1", 1, 10, { type: F_WRLCK, start: 0, len: 10 }, false).errno,
    ).toBe(2);

    // Downgrade EX -> SH has no conflicting rollback after a peer acquires LOCK_SH.
    const downgrade = table.flock(1, "1:1", 1, LOCK_SH | LOCK_NB);
    expect(downgrade.errno).toBe(0);
    expect(table.flock(1, "2:1", 2, LOCK_SH | LOCK_NB).errno).toBe(0);
    downgrade.rollback?.();
    // Peer still holds LOCK_SH and a third shared locker can still acquire LOCK_SH.
    expect(table.flock(1, "3:1", 3, LOCK_SH | LOCK_NB).errno).toBe(0);

    // Same for range-lock downgrade WRLCK -> RDLCK.
    expect(
      table.setRangeLock(5, undefined, 1, 10, { type: F_WRLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    const rangeDown = table.setRangeLock(
      5,
      undefined,
      1,
      10,
      { type: F_RDLCK, start: 0, len: 10 },
      false,
    );
    expect(rangeDown.errno).toBe(0);
    expect(
      table.setRangeLock(5, undefined, 2, 20, { type: F_RDLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    rangeDown.rollback?.();
    expect(
      table.setRangeLock(5, undefined, 3, 30, { type: F_RDLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    table.dispose();

    // Closing via DescriptorTable.close directly (as ThreadService does) releases POSIX locks.
    const fs = new MemFS();
    fs.writeFile("/t.txt", new Uint8Array(16));
    const { wasi, fdLock } = makeMemWasi(fs, 77);
    const fd1 = openMemFile(wasi, fs, "t.txt", RIGHTS_ALL);
    const fd2 = openMemFile(wasi, fs, "t.txt", RIGHTS_ALL);
    expect(fdLock(fd1, F_SETLK, F_WRLCK, 0, 0n, 16n, 0)).toBe(0);
    // Invalid flock op returns EINVAL even with signal pending; F_SETLKW + F_UNLCK never returns EINTR.
    expect(wasi.descriptors.close(fd2)).toBe(true);
    // POSIX lock on inode was released by DescriptorTable.close(fd2).
    const probe = fs.locks.getRangeLock(
      (wasi.descriptors.get(fd1)!.resource as { handle: number }).handle,
      "99:1",
      { type: F_WRLCK, start: 0, len: 16 },
    );
    expect(probe).toEqual({ type: F_UNLCK, pid: 0, start: 0, len: 0 });
    wasi.descriptors.dispose();
  });

  test("F_SETLKW unlock and invalid fd_flock op do not fail with EINTR when a signal is pending", async () => {
    const f = createServiceFixture();
    try {
      const worker = await f.spawnWorker(95);
      const fd = await worker.call<number>({ op: "open", path: "lock.dat" });
      expect(
        await worker.call<{ errno: number }>({
          op: "lock",
          fd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "32",
        }),
      ).toEqual({ errno: 0 });

      Atomics.store(worker.interrupt, 0, 1);
      expect(await worker.call<number>({ op: "flock", fd, operation: 0 })).toBe(EINVAL);
      expect(
        await worker.call<{ errno: number }>({
          op: "lock",
          fd,
          cmd: F_SETLKW,
          type: F_UNLCK,
          whence: 0,
          start: "0",
          len: "32",
        }),
      ).toEqual({ errno: 0 });
    } finally {
      await f.cleanup();
    }
  });

  test("mixed downgrade/extension rollback releases newly acquired bytes even if a peer enters the downgraded range", () => {
    const table = new LockTable();
    // Case A: no peer enters [0,10) before rollback -> [0,10) restores F_WRLCK, [10,20) unlocks.
    const initA = table.setRangeLock(
      1,
      undefined,
      1,
      10,
      { type: F_WRLCK, start: 0, len: 10 },
      false,
      true,
    );
    expect(initA.errno).toBe(0);
    initA.settle?.();
    const mixedA = table.setRangeLock(
      1,
      undefined,
      1,
      10,
      { type: F_RDLCK, start: 0, len: 20 },
      false,
      true,
    );
    expect(mixedA.errno).toBe(0);
    mixedA.rollback?.();
    expect(
      table.setRangeLock(1, undefined, 2, 20, { type: F_RDLCK, start: 0, len: 10 }, false).errno,
    ).toBe(EAGAIN);
    expect(
      table.setRangeLock(1, undefined, 2, 20, { type: F_WRLCK, start: 10, len: 10 }, false).errno,
    ).toBe(0);

    // Case B: peer enters F_RDLCK on [0,10) before rollback -> [0,10) stays F_RDLCK, [10,20) unlocks.
    const initB = table.setRangeLock(
      2,
      undefined,
      1,
      10,
      { type: F_WRLCK, start: 0, len: 10 },
      false,
      true,
    );
    expect(initB.errno).toBe(0);
    initB.settle?.();
    const mixedB = table.setRangeLock(
      2,
      undefined,
      1,
      10,
      { type: F_RDLCK, start: 0, len: 20 },
      false,
      true,
    );
    expect(mixedB.errno).toBe(0);
    expect(
      table.setRangeLock(2, undefined, 2, 20, { type: F_RDLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    mixedB.rollback?.();
    // [0,10) preserves mutual exclusion (stays shared so owner 3 can also read).
    expect(
      table.setRangeLock(2, undefined, 3, 30, { type: F_RDLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    // [10,20) was newly acquired by the cancelled op and MUST be unlocked.
    expect(
      table.setRangeLock(2, undefined, 2, 20, { type: F_WRLCK, start: 10, len: 10 }, false).errno,
    ).toBe(0);

    // Case C: upgrade + extension (F_RDLCK [0,10) -> cancelled F_WRLCK [0,20)) restores F_RDLCK on [0,10) and unlocks [10,20).
    const initC = table.setRangeLock(
      3,
      undefined,
      1,
      10,
      { type: F_RDLCK, start: 0, len: 10 },
      false,
      true,
    );
    expect(initC.errno).toBe(0);
    initC.settle?.();
    const upgradeC = table.setRangeLock(
      3,
      undefined,
      1,
      10,
      { type: F_WRLCK, start: 0, len: 20 },
      false,
      true,
    );
    expect(upgradeC.errno).toBe(0);
    upgradeC.rollback?.();
    // [0,10) is back to F_RDLCK: peer gets EAGAIN for WRLCK, 0 for RDLCK.
    expect(
      table.setRangeLock(3, undefined, 2, 20, { type: F_WRLCK, start: 0, len: 10 }, false).errno,
    ).toBe(EAGAIN);
    expect(
      table.setRangeLock(3, undefined, 2, 20, { type: F_RDLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    // [10,20) is unlocked.
    expect(
      table.setRangeLock(3, undefined, 2, 20, { type: F_WRLCK, start: 10, len: 10 }, false).errno,
    ).toBe(0);
    table.dispose();
  });

  test("disjoint and overlapping edits on the same OFD do not block cancelling an earlier grant", () => {
    const table = new LockTable();
    // Disjoint edit: opA acquires [0,10), opB acquires [20,30) on same OFD "1:1", opA cancels.
    const opA = table.setRangeLock(
      3,
      "1:1",
      1,
      10,
      { type: F_WRLCK, start: 0, len: 10 },
      false,
      true,
    );
    expect(opA.errno).toBe(0);
    const opB = table.setRangeLock(
      3,
      "1:1",
      1,
      10,
      { type: F_WRLCK, start: 20, len: 10 },
      false,
      true,
    );
    expect(opB.errno).toBe(0);
    opB.settle?.();
    opA.rollback?.();
    expect(
      table.setRangeLock(3, "2:1", 2, 20, { type: F_WRLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    expect(
      table.setRangeLock(3, "2:1", 2, 20, { type: F_WRLCK, start: 20, len: 10 }, false).errno,
    ).toBe(EAGAIN);

    // Overlapping edit: opC acquires [0,20), opD overwrites [10,20) and settles, opC cancels.
    const opC = table.setRangeLock(
      4,
      "1:2",
      1,
      10,
      { type: F_WRLCK, start: 0, len: 20 },
      false,
      true,
    );
    expect(opC.errno).toBe(0);
    const opD = table.setRangeLock(
      4,
      "1:2",
      1,
      10,
      { type: F_WRLCK, start: 10, len: 10 },
      false,
      true,
    );
    expect(opD.errno).toBe(0);
    opD.settle?.();
    opC.rollback?.();
    expect(
      table.setRangeLock(4, "2:2", 2, 20, { type: F_WRLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    expect(
      table.setRangeLock(4, "2:2", 2, 20, { type: F_WRLCK, start: 10, len: 10 }, false).errno,
    ).toBe(EAGAIN);
    table.dispose();
  });

  test("cancelling two overlapping unsettled grants in either order leaves no phantom range or flock lock", () => {
    const table = new LockTable();

    // Range locks: A-then-B rollback order
    const rA1 = table.setRangeLock(
      10,
      "1:1",
      1,
      10,
      { type: F_WRLCK, start: 0, len: 20 },
      false,
      true,
    );
    const rB1 = table.setRangeLock(
      10,
      "1:1",
      1,
      10,
      { type: F_RDLCK, start: 0, len: 20 },
      false,
      true,
    );
    expect(rA1.errno).toBe(0);
    expect(rB1.errno).toBe(0);
    rA1.rollback?.();
    rB1.rollback?.();
    expect(
      table.setRangeLock(10, "2:1", 2, 20, { type: F_WRLCK, start: 0, len: 20 }, false).errno,
    ).toBe(0);
    table.releaseOfd(10, "2:1", 2);

    // Range locks: B-then-A rollback order
    const rA2 = table.setRangeLock(
      11,
      "1:2",
      1,
      10,
      { type: F_WRLCK, start: 0, len: 20 },
      false,
      true,
    );
    const rB2 = table.setRangeLock(
      11,
      "1:2",
      1,
      10,
      { type: F_RDLCK, start: 0, len: 20 },
      false,
      true,
    );
    rB2.rollback?.();
    rA2.rollback?.();
    expect(
      table.setRangeLock(11, "2:2", 2, 20, { type: F_WRLCK, start: 0, len: 20 }, false).errno,
    ).toBe(0);
    table.releaseOfd(11, "2:2", 2);

    // Range locks: A settles then B rolls back -> A's settled WRLCK is preserved
    const rA3 = table.setRangeLock(
      12,
      "1:3",
      1,
      10,
      { type: F_WRLCK, start: 0, len: 20 },
      false,
      true,
    );
    const rB3 = table.setRangeLock(
      12,
      "1:3",
      1,
      10,
      { type: F_RDLCK, start: 0, len: 20 },
      false,
      true,
    );
    rA3.settle?.();
    rB3.rollback?.();
    expect(
      table.setRangeLock(12, "2:3", 2, 20, { type: F_RDLCK, start: 0, len: 20 }, false).errno,
    ).toBe(EAGAIN);
    table.releaseOfd(12, "1:3", 1);

    // Flock: A-then-B rollback order on one OFD
    const fA1 = table.flock(20, "1:4", 1, LOCK_EX, true);
    const fB1 = table.flock(20, "1:4", 1, LOCK_SH, true);
    expect(fA1.errno).toBe(0);
    expect(fB1.errno).toBe(0);
    fA1.rollback?.();
    fB1.rollback?.();
    expect(table.flock(20, "2:4", 2, LOCK_EX | LOCK_NB).errno).toBe(0);
    table.releaseOfd(20, "2:4", 2);

    // Flock: B-then-A rollback order (even when peer enters SH while downgraded)
    const fA2 = table.flock(21, "1:5", 1, LOCK_EX, true);
    const fB2 = table.flock(21, "1:5", 1, LOCK_SH, true);
    expect(table.flock(21, "3:5", 3, LOCK_SH | LOCK_NB).errno).toBe(0);
    fB2.rollback?.();
    fA2.rollback?.();
    table.releaseOfd(21, "3:5", 3);
    expect(table.flock(21, "2:5", 2, LOCK_EX | LOCK_NB).errno).toBe(0);
    table.releaseOfd(21, "2:5", 2);

    // Flock: A settles then B rolls back -> A's settled EX is preserved
    const fA3 = table.flock(22, "1:6", 1, LOCK_EX, true);
    const fB3 = table.flock(22, "1:6", 1, LOCK_SH, true);
    fA3.settle?.();
    fB3.rollback?.();
    expect(table.flock(22, "2:6", 2, LOCK_SH | LOCK_NB).errno).toBe(EAGAIN);
    table.releaseOfd(22, "1:6", 1);

    expect(table.diagnostics()).toMatchObject({
      flocks: 0,
      ranges: 0,
      pendingTransactions: 0,
    });
    table.dispose();
  });

  test("partial middle F_UNLCK split enforces maxRangeLocks while whole-range unlock succeeds", () => {
    const capped = new LockTable({ maxRangeLocks: 1 });
    expect(
      capped.setRangeLock(1, undefined, 1, 1, { type: F_WRLCK, start: 0, len: 100 }, false).errno,
    ).toBe(0);
    // Splitting [0,100) into [0,20) and [40,100) would require 2 segments > maxRangeLocks(1)
    expect(
      capped.setRangeLock(1, undefined, 1, 1, { type: F_UNLCK, start: 20, len: 20 }, false).errno,
    ).toBe(ENOLCK);
    expect(capped.diagnostics().ranges).toBe(1);
    // Prefix unlock keeps 1 segment (deltaCount = 0) -> succeeds
    expect(
      capped.setRangeLock(1, undefined, 1, 1, { type: F_UNLCK, start: 0, len: 20 }, false).errno,
    ).toBe(0);
    expect(capped.diagnostics().ranges).toBe(1);
    // Whole-range unlock drops to 0 segments -> succeeds
    expect(
      capped.setRangeLock(1, undefined, 1, 1, { type: F_UNLCK, start: 0, len: 0 }, false).errno,
    ).toBe(0);
    expect(capped.diagnostics().ranges).toBe(0);
    capped.dispose();

    // Unsettled covering grants reserve rollback capacity so another inode cannot steal slots
    // and cause rollback in grant order to exceed maxRangeLocks.
    const cap2 = new LockTable({ maxRangeLocks: 2 });
    const s1 = cap2.setRangeLock(1, undefined, 1, 1, { type: F_WRLCK, start: 0, len: 5 }, false);
    const s2 = cap2.setRangeLock(1, undefined, 1, 1, { type: F_WRLCK, start: 10, len: 5 }, false);
    expect(s1.errno).toBe(0);
    expect(s2.errno).toBe(0);
    const coverA = cap2.setRangeLock(
      1,
      undefined,
      1,
      1,
      { type: F_WRLCK, start: 0, len: 20 },
      false,
      true,
    );
    const coverB = cap2.setRangeLock(
      1,
      undefined,
      1,
      1,
      { type: F_RDLCK, start: 0, len: 20 },
      false,
      true,
    );
    expect(coverA.errno).toBe(0);
    expect(coverB.errno).toBe(0);
    // Freed slot is reserved for rollback until the provisional edits settle.
    expect(
      cap2.setRangeLock(2, undefined, 2, 2, { type: F_WRLCK, start: 0, len: 5 }, false).errno,
    ).toBe(ENOLCK);
    coverA.rollback?.();
    // Still reserved via coverB's spliced delta until coverB settles or rolls back.
    expect(
      cap2.setRangeLock(2, undefined, 2, 2, { type: F_WRLCK, start: 0, len: 5 }, false).errno,
    ).toBe(ENOLCK);
    coverB.rollback?.();
    expect(cap2.diagnostics().ranges).toBe(2);

    // Full F_UNLCK over a pending covering grant MUST release its rollback reservation immediately.
    const coverC = cap2.setRangeLock(
      1,
      undefined,
      1,
      1,
      { type: F_WRLCK, start: 0, len: 20 },
      false,
      true,
    );
    expect(coverC.errno).toBe(0);
    expect(
      cap2.setRangeLock(1, undefined, 1, 1, { type: F_UNLCK, start: 0, len: 0 }, false).errno,
    ).toBe(0);
    expect(cap2.diagnostics()).toMatchObject({ inodes: 0, ranges: 0, pendingTransactions: 0 });
    // Both slots up to maxRangeLocks(2) are immediately usable on unrelated inodes before coverC rolls back.
    expect(
      cap2.setRangeLock(2, undefined, 2, 2, { type: F_WRLCK, start: 0, len: 5 }, false).errno,
    ).toBe(0);
    expect(
      cap2.setRangeLock(3, undefined, 3, 3, { type: F_WRLCK, start: 0, len: 5 }, false).errno,
    ).toBe(0);
    coverC.rollback?.();
    expect(cap2.diagnostics().ranges).toBe(2);
    cap2.dispose();

    // Partial F_UNLCK over the bytes covered by an earlier pending grant MUST prune that
    // unreachable dependency and release its rollback reservation even while a newer pending
    // grant remains live on non-overlapping bytes.
    const capPartial = new LockTable({ maxRangeLocks: 2 });
    expect(
      capPartial.setRangeLock(1, undefined, 1, 1, { type: F_WRLCK, start: 0, len: 5 }, false).errno,
    ).toBe(0);
    expect(
      capPartial.setRangeLock(1, undefined, 1, 1, { type: F_WRLCK, start: 10, len: 5 }, false)
        .errno,
    ).toBe(0);
    const pA = capPartial.setRangeLock(
      1,
      undefined,
      1,
      1,
      { type: F_WRLCK, start: 0, len: 15 },
      false,
      true,
    );
    const pB = capPartial.setRangeLock(
      1,
      undefined,
      1,
      1,
      { type: F_RDLCK, start: 0, len: 20 },
      false,
      true,
    );
    expect(pA.errno).toBe(0);
    expect(pB.errno).toBe(0);
    expect(
      capPartial.setRangeLock(1, undefined, 1, 1, { type: F_UNLCK, start: 0, len: 15 }, false)
        .errno,
    ).toBe(0);
    expect(capPartial.diagnostics()).toMatchObject({
      inodes: 1,
      ranges: 1,
      pendingTransactions: 1,
    });
    // The second slot is immediately available for an unrelated inode.
    expect(
      capPartial.setRangeLock(2, undefined, 2, 2, { type: F_WRLCK, start: 0, len: 5 }, false).errno,
    ).toBe(0);
    pA.rollback?.();
    pB.rollback?.();
    expect(capPartial.diagnostics()).toMatchObject({ ranges: 1, pendingTransactions: 0 });
    capPartial.dispose();

    // Overlapping tracked grants with out-of-order rollback across fragments must never exceed maxRangeLocks.
    const capFrag = new LockTable({ maxRangeLocks: 4 });
    const fA = capFrag.setRangeLock(
      1,
      undefined,
      1,
      1,
      { type: F_WRLCK, start: 0, len: 9 },
      false,
      true,
    );
    const fB = capFrag.setRangeLock(
      1,
      undefined,
      1,
      1,
      { type: F_RDLCK, start: 0, len: 6 },
      false,
      true,
    );
    const fC = capFrag.setRangeLock(
      1,
      undefined,
      1,
      1,
      { type: F_WRLCK, start: 2, len: 12 },
      false,
      true,
    );
    const fD = capFrag.setRangeLock(
      1,
      undefined,
      1,
      1,
      { type: F_WRLCK, start: 0, len: 8 },
      false,
      true,
    );
    expect([fA.errno, fB.errno, fC.errno, fD.errno]).toEqual([0, 0, 0, 0]);
    fD.rollback?.();
    const otherRes = capFrag.setRangeLock(
      2,
      undefined,
      2,
      2,
      { type: F_WRLCK, start: 0, len: 5 },
      false,
    );
    expect([0, ENOLCK]).toContain(otherRes.errno);
    fC.rollback?.();
    expect(capFrag.diagnostics().ranges).toBeLessThanOrEqual(4);
    fB.rollback?.();
    expect(capFrag.diagnostics().ranges).toBeLessThanOrEqual(4);
    fA.rollback?.();
    expect(capFrag.diagnostics().ranges).toBeLessThanOrEqual(4);
    capFrag.dispose();

    // Deterministic stress sweep: arbitrary overlapping grants, partial unlocks, competing-inode
    // allocations, and arbitrary-order rollbacks/settles never exceed maxRangeLocks.
    let seed = 0x12345678;
    const nextRand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const capStress = new LockTable({ maxRangeLocks: 4 });
    const pending: { rollback?: () => void; settle?: () => void }[] = [];
    for (let step = 0; step < 400; step++) {
      const action = nextRand() % 10;
      if (action < 4) {
        const start = nextRand() % 16;
        const len = 1 + (nextRand() % 12);
        const type = nextRand() % 2 === 0 ? F_WRLCK : F_RDLCK;
        const commit = capStress.setRangeLock(
          1,
          undefined,
          1,
          1,
          { type, start, len },
          false,
          true,
        );
        if (commit.errno === 0) pending.push(commit);
      } else if (action < 6) {
        const start = nextRand() % 16;
        const len = 1 + (nextRand() % 12);
        capStress.setRangeLock(1, undefined, 1, 1, { type: F_UNLCK, start, len }, false);
      } else if (action < 8 && pending.length > 0) {
        const idx = nextRand() % pending.length;
        const item = pending.splice(idx, 1)[0]!;
        if (nextRand() % 3 === 0) item.settle?.();
        else item.rollback?.();
      } else {
        const otherIno = 2 + (nextRand() % 4);
        const type = nextRand() % 2 === 0 ? F_WRLCK : F_UNLCK;
        capStress.setRangeLock(otherIno, undefined, 2, 2, { type, start: 0, len: 5 }, false);
      }
      expect(capStress.diagnostics().ranges).toBeLessThanOrEqual(4);
    }
    while (pending.length > 0) {
      pending.pop()!.rollback?.();
      expect(capStress.diagnostics().ranges).toBeLessThanOrEqual(4);
    }
    capStress.dispose();
  });

  test("OFD churn leaves bounded metadata and byte-range/flock/waiter caps return ENOLCK while unlock succeeds", () => {
    const churn = new LockTable();
    expect(
      churn.setRangeLock(10, "1:1", 1, 1, { type: F_RDLCK, start: 0, len: 10 }, false).errno,
    ).toBe(0);
    for (let i = 2; i <= 400; i++) {
      const ofdId = `${i}:1`;
      expect(churn.flock(10, ofdId, i, LOCK_SH | LOCK_NB).errno).toBe(0);
      expect(
        churn.setRangeLock(10, ofdId, i, i, { type: F_RDLCK, start: 0, len: 10 }, false).errno,
      ).toBe(0);
      churn.releaseOfd(10, ofdId, i);
    }
    expect(churn.diagnostics()).toEqual({
      inodes: 1,
      flocks: 0,
      ranges: 1,
      posixRanges: 0,
      waiters: 0,
      ofdRecords: 1,
      pendingTransactions: 0,
    });
    churn.dispose();

    const bounded = new LockTable({
      maxRangeLocks: 4,
      maxFlocks: 2,
      maxWaiters: 1,
      maxPendingTransactions: 2,
    });
    for (let i = 0; i < 4; i++) {
      expect(
        bounded.setRangeLock(1, undefined, 1, 1, { type: F_WRLCK, start: i * 10, len: 5 }, false)
          .errno,
      ).toBe(0);
    }
    expect(
      bounded.setRangeLock(1, undefined, 1, 1, { type: F_WRLCK, start: 100, len: 5 }, false).errno,
    ).toBe(ENOLCK);
    // Unlocking at the limit MUST succeed and free capacity.
    expect(
      bounded.setRangeLock(1, undefined, 1, 1, { type: F_UNLCK, start: 0, len: 5 }, false).errno,
    ).toBe(0);
    expect(
      bounded.setRangeLock(1, undefined, 1, 1, { type: F_WRLCK, start: 100, len: 5 }, false).errno,
    ).toBe(0);

    // Flock limit + waiter limit return ENOLCK while LOCK_UN always succeeds.
    expect(bounded.flock(2, "1:1", 1, LOCK_SH | LOCK_NB).errno).toBe(0);
    expect(bounded.flock(2, "2:1", 2, LOCK_SH | LOCK_NB).errno).toBe(0);
    expect(bounded.flock(2, "3:1", 3, LOCK_SH | LOCK_NB).errno).toBe(ENOLCK);
    expect(() => bounded.flock(2, "3:1", 3, LOCK_EX, true)).toThrow(LockContentionError);
    expect(bounded.flock(2, "4:1", 4, LOCK_EX, true).errno).toBe(ENOLCK);
    expect(bounded.flock(2, "1:1", 1, LOCK_UN).errno).toBe(0);
    expect(bounded.flock(2, "3:1", 3, LOCK_SH | LOCK_NB).errno).toBe(0);
    bounded.dispose();
  });

  test("independent Wasi instances sharing one MemFS have separate POSIX lock ownership by pid", () => {
    const fs = new MemFS();
    fs.writeFile("/shared.txt", new Uint8Array(64));
    const a = makeMemWasi(fs, 42);
    const b = makeMemWasi(fs, 43);
    try {
      const aFd = openMemFile(a.wasi, fs, "shared.txt", RIGHTS_ALL);
      const bFd1 = openMemFile(b.wasi, fs, "shared.txt", RIGHTS_ALL);
      const bFd2 = openMemFile(b.wasi, fs, "shared.txt", RIGHTS_ALL);

      expect(a.fdLock(aFd, F_SETLK, F_WRLCK, 0, 0n, 32n, 0)).toBe(0);
      expect(b.fdLock(bFd1, F_SETLK, F_WRLCK, 0, 0n, 32n, 0)).toBe(EAGAIN);
      expect(b.fdLock(bFd1, F_GETLK, F_WRLCK, 0, 0n, 32n, 128)).toBe(0);
      expect(readConflict(b.memory, 128)).toEqual({
        type: F_WRLCK,
        pid: 42,
        start: 0n,
        len: 32n,
      });

      // Closing bFd2 in process 43 must NOT release process 42's POSIX lock.
      expect(b.fdClose(bFd2)).toBe(0);
      expect(b.fdLock(bFd1, F_SETLK, F_WRLCK, 0, 0n, 32n, 0)).toBe(EAGAIN);

      // Closing aFd in process 42 releases process 42's POSIX lock -> process 43 acquires.
      expect(a.fdClose(aFd)).toBe(0);
      expect(b.fdLock(bFd1, F_SETLK, F_WRLCK, 0, 0n, 32n, 0)).toBe(0);
    } finally {
      a.wasi.releasePosixLocks();
      a.wasi.descriptors.dispose();
      b.wasi.releasePosixLocks();
      b.wasi.descriptors.dispose();
    }
  });

  test("POSIX record locks survive exec for inherited descriptors, release for CLOEXEC descriptors, and release on failed exec successor", async () => {
    const f = createServiceFixture();
    try {
      f.backend.fs.writeFile("/cloexec.dat", new Uint8Array(64));
      const oldImage = await f.spawnWorker(110);
      const rival = await f.spawnWorker(220);

      const keepFd = await oldImage.call<number>({ op: "open", path: "lock.dat" });
      const cloexecFd = await oldImage.call<number>({ op: "open", path: "cloexec.dat" });
      const rivalKeepFd = await rival.call<number>({ op: "open", path: "lock.dat" });
      const rivalCloexecFd = await rival.call<number>({ op: "open", path: "cloexec.dat" });

      expect(
        await oldImage.call<{ errno: number }>({
          op: "lock",
          fd: keepFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "40",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await oldImage.call<{ errno: number }>({
          op: "lock",
          fd: cloexecFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "40",
        }),
      ).toEqual({ errno: 0 });

      // Stage exec successor identity sharing posixOwner, export only keepFd (cloexecFd not inherited).
      const successorIdentity = createProcessFilesystemIdentity(
        f.rootConnection,
        oldImage.connection.posixOwner ?? oldImage.connection.owner,
      );
      const keepToken = await oldImage.call<FilesystemDescriptorToken>({
        op: "export",
        fd: keepFd,
        target: successorIdentity,
      });
      successorIdentity.reservations.push(keepToken.reservation);

      // Old image exits on ProcessReplaced BEFORE successor connects to FilesystemService!
      await oldImage.call({
        op: "execTeardown",
        successorOwner: successorIdentity.owner,
        keptFds: [keepFd],
      });
      f.service.sweep();

      // Non-inherited CLOEXEC fd's POSIX lock was released; inherited fd's POSIX lock SURVIVED!
      expect(
        await rival.call<{ errno: number }>({
          op: "lock",
          fd: rivalCloexecFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "40",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await rival.call<{ errno: number }>({
          op: "lock",
          fd: rivalKeepFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "40",
        }),
      ).toEqual({ errno: EAGAIN });

      // Connect successor image, import inherited fd, verify same-process ownership & post-exec close!
      const successorPair = connectFilesystemIdentity(successorIdentity);
      f.service.connect(successorPair.server);
      const newImage = await f.spawnWorker(110, successorPair);
      const newKeepFd = await newImage.call<number>({ op: "import", token: keepToken });

      // Successor owns the lock (F_GETLK reports unlocked for self; can extend range).
      expect(
        await newImage.call<{ errno: number; conflict: { type: number } }>({
          op: "lock",
          fd: newKeepFd,
          cmd: F_GETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "40",
        }),
      ).toMatchObject({ errno: 0, conflict: { type: F_UNLCK } });

      // Closing inherited fd in post-exec image releases the POSIX lock immediately!
      expect(await newImage.call<number>({ op: "close", fd: newKeepFd })).toBe(0);
      expect(
        await rival.call<{ errno: number }>({
          op: "lock",
          fd: rivalKeepFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "40",
        }),
      ).toEqual({ errno: 0 });

      // Also verify that if a staged exec successor is revoked/reaped before connecting, locks drop.
      expect(
        await rival.call<{ errno: number }>({
          op: "lock",
          fd: rivalKeepFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "20",
        }),
      ).toEqual({ errno: 0 });
      const doomedSuccessor = createProcessFilesystemIdentity(
        f.rootConnection,
        rival.connection.posixOwner ?? rival.connection.owner,
      );
      await rival.call({
        op: "execTeardown",
        successorOwner: doomedSuccessor.owner,
        keptFds: [rivalKeepFd],
      });
      f.service.sweep();
      expect(
        await newImage.call<{ errno: number }>({
          op: "lock",
          fd: await newImage.call<number>({ op: "open", path: "lock.dat" }),
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "20",
        }),
      ).toEqual({ errno: EAGAIN });
      revokeFilesystem(doomedSuccessor);
      reapFilesystem(doomedSuccessor);
      f.service.sweep();
      const probeFd = await newImage.call<number>({ op: "open", path: "lock.dat" });
      expect(
        await newImage.call<{ errno: number }>({
          op: "lock",
          fd: probeFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "20",
        }),
      ).toEqual({ errno: 0 });
    } finally {
      await f.cleanup();
    }
  });

  test("thread members sharing posixOwner share POSIX locks, survive sibling thread exit, and release on explicit fd close", async () => {
    const f = createServiceFixture();
    try {
      const leader = await f.spawnWorker(300);
      const rival = await f.spawnWorker(400);
      const posixOwner = leader.connection.posixOwner ?? leader.connection.owner;

      const thread1Pair = connectFilesystemIdentity(
        createProcessFilesystemIdentity(f.rootConnection, posixOwner),
      );
      f.service.connect(thread1Pair.server);
      const thread1 = await f.spawnWorker(300, thread1Pair);

      const thread2Pair = connectFilesystemIdentity(
        createProcessFilesystemIdentity(f.rootConnection, posixOwner),
      );
      f.service.connect(thread2Pair.server);
      const thread2 = await f.spawnWorker(300, thread2Pair);

      const leaderFd = await leader.call<number>({ op: "open", path: "lock.dat" });
      const t1Fd = await thread1.call<number>({ op: "open", path: "lock.dat" });
      const t2Fd = await thread2.call<number>({ op: "open", path: "lock.dat" });
      const rivalFd = await rival.call<number>({ op: "open", path: "lock.dat" });

      // Leader locks [0,30); thread1 does NOT conflict and extends [30,60).
      expect(
        await leader.call<{ errno: number }>({
          op: "lock",
          fd: leaderFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "30",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await thread1.call<{ errno: number }>({
          op: "lock",
          fd: t1Fd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "60",
        }),
      ).toEqual({ errno: 0 });
      expect(
        await rival.call<{ errno: number }>({
          op: "lock",
          fd: rivalFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "60",
        }),
      ).toEqual({ errno: EAGAIN });

      // Thread1 exits normally while leader + thread2 live -> POSIX lock MUST stay held!
      await thread1.call({ op: "threadExit" });
      f.service.sweep();
      expect(
        await rival.call<{ errno: number }>({
          op: "lock",
          fd: rivalFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "60",
        }),
      ).toEqual({ errno: EAGAIN });

      // Explicit close of an fd for lock.dat by sibling thread2 releases process POSIX locks!
      expect(await thread2.call<number>({ op: "close", fd: t2Fd })).toBe(0);
      expect(
        await rival.call<{ errno: number }>({
          op: "lock",
          fd: rivalFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "60",
        }),
      ).toEqual({ errno: 0 });
    } finally {
      await f.cleanup();
    }
  });

  test("transient lock-release RPC failure on fd_close retries automatically while owner stays live", async () => {
    const f = createServiceFixture();
    try {
      const owner = await f.spawnWorker(501);
      const peer = await f.spawnWorker(502);

      const oFd = await owner.call<number>({ op: "open", path: "lock.dat" });
      const pFd = await peer.call<number>({ op: "open", path: "lock.dat" });

      expect(await owner.call<number>({ op: "flock", fd: oFd, operation: LOCK_EX | LOCK_NB })).toBe(
        0,
      );
      expect(
        await owner.call<{ errno: number }>({
          op: "lock",
          fd: oFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "50",
        }),
      ).toEqual({ errno: 0 });

      // Fault-inject transient EAGAIN on both lockReleasePosix and lockReleaseOfd during fd_close.
      await owner.call({ op: "failNextRelease", operation: "lockReleasePosix", errno: EAGAIN });
      expect(await owner.call<number>({ op: "close", fd: oFd })).toBe(0);

      // Owner stays live (never exits); retry timer delivers the release and peer acquires both!
      let posixAcquired = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await peer.call<{ errno: number }>({
          op: "lock",
          fd: pFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "50",
        });
        if (res.errno === 0) {
          posixAcquired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(posixAcquired).toBe(true);
      expect(await peer.call<number>({ op: "flock", fd: pFd, operation: LOCK_EX | LOCK_NB })).toBe(
        0,
      );

      // Repeat fault injection specifically on lockReleaseOfd while owner stays live.
      expect(await peer.call<number>({ op: "flock", fd: pFd, operation: LOCK_UN })).toBe(0);
      const oFd2 = await owner.call<number>({ op: "open", path: "lock.dat" });
      expect(
        await owner.call<number>({ op: "flock", fd: oFd2, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);
      await owner.call({ op: "failNextRelease", operation: "lockReleaseOfd", errno: EAGAIN });
      expect(await owner.call<number>({ op: "close", fd: oFd2 })).toBe(0);

      let flockAcquired = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const err = await peer.call<number>({ op: "flock", fd: pFd, operation: LOCK_EX | LOCK_NB });
        if (err === 0) {
          flockAcquired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(flockAcquired).toBe(true);

      // Unlinked file POSIX lock + held EAGAIN across service.sweep() must retain handle until retry succeeds.
      f.backend.fs.writeFile("/unlinked-lock.dat", new Uint8Array(64));
      const uOwnerFd = await owner.call<number>({ op: "open", path: "unlinked-lock.dat" });
      const uPeerFd = await peer.call<number>({ op: "open", path: "unlinked-lock.dat" });
      expect(
        await owner.call<{ errno: number }>({
          op: "lock",
          fd: uOwnerFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "50",
        }),
      ).toEqual({ errno: 0 });
      const rootHandle = f.backend.fs.preopen("/");
      const unlinkedResolved = f.backend.fs.resolve(rootHandle, "unlinked-lock.dat", false);
      expect(typeof unlinkedResolved).toBe("object");
      if (typeof unlinkedResolved === "object") {
        expect(f.backend.fs.removePath(unlinkedResolved, false)).toBe(0);
      }
      // Hold EAGAIN across close + sweep so retry CANNOT run before sweep tries to evict the unlinked handle.
      await owner.call({
        op: "setReleaseFault",
        operation: "lockReleasePosix",
        errno: EAGAIN,
        active: true,
      });
      expect(await owner.call<number>({ op: "close", fd: uOwnerFd })).toBe(0);
      f.service.sweep();
      // Lock is still held while fault is active (proving sweep did not drop it).
      expect(
        await peer.call<{ errno: number }>({
          op: "lock",
          fd: uPeerFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "50",
        }),
      ).toEqual({ errno: EAGAIN });
      // Release the fault: retained handle lets queued lockReleasePosix succeed after sweep!
      await owner.call({
        op: "setReleaseFault",
        operation: "lockReleasePosix",
        errno: EAGAIN,
        active: false,
      });

      let unlinkedAcquired = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await peer.call<{ errno: number }>({
          op: "lock",
          fd: uPeerFd,
          cmd: F_SETLK,
          type: F_WRLCK,
          whence: 0,
          start: "0",
          len: "50",
        });
        if (res.errno === 0) {
          unlinkedAcquired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(unlinkedAcquired).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("unrelated descriptor transfer on same inode does not pin a closed unexported OFD lock", async () => {
    const f = createServiceFixture();
    try {
      const workerA = await f.spawnWorker(601);
      const workerB = await f.spawnWorker(602);

      // Two separate OFDs on the SAME inode (lock.dat): aLocked (unexported) and aExported.
      const aLocked = await workerA.call<number>({ op: "open", path: "lock.dat" });
      const aExported = await workerA.call<number>({ op: "open", path: "lock.dat" });
      const bFd = await workerB.call<number>({ op: "open", path: "lock.dat" });

      expect(
        await workerA.call<number>({ op: "flock", fd: aLocked, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);

      // Export unrelated aExported to an unadopted child identity so the handle has pending transfer > 0.
      const childIdentity = createFilesystemIdentity(f.rootConnection);
      const unrelatedToken = await workerA.call<FilesystemDescriptorToken>({
        op: "export",
        fd: aExported,
        target: childIdentity,
      });

      // Closing unexported aLocked MUST drop its lock immediately despite aExported's pending transfer!
      expect(await workerA.call<number>({ op: "close", fd: aLocked })).toBe(0);
      expect(
        await workerB.call<number>({ op: "flock", fd: bFd, operation: LOCK_EX | LOCK_NB }),
      ).toBe(0);

      // Clean up the unadopted transfer.
      const controllerCodec = createFilesystemDescriptorCodec(childIdentity, undefined, () =>
        f.service.sweep(),
      );
      controllerCodec.discard(unrelatedToken);
    } finally {
      await f.cleanup();
    }
  });

  test("MultiTabBackend (whenBusy: attach) returns ENOTSUP instead of granting conflicting tab-local locks", async () => {
    const vfs = await openVfsBackend("multitab-host");
    try {
      const hostRoot = await vfs.client.asyncCall("preopen", ["/"]);
      await vfs.client.asyncCall("create", [
        {
          parent: hostRoot,
          name: "mt-lock.dat",
          node: undefined,
          trailingSlash: false,
          terminalDot: false,
        },
        "file",
        false,
      ]);
      const hostWorker = await launchLockWorker(vfs.forkConnection("primary"), 701);
      const peerWorker = await launchLockWorker(vfs.forkConnection("counterpart"), 702);
      try {
        const hostFd = await hostWorker.call<number>({ op: "open", path: "mt-lock.dat" });
        const peerFd = await peerWorker.call<number>({ op: "open", path: "mt-lock.dat" });
        expect(
          await hostWorker.call<number>({ op: "flock", fd: hostFd, operation: LOCK_EX | LOCK_NB }),
        ).toBe(ENOTSUP);
        expect(
          await peerWorker.call<number>({ op: "flock", fd: peerFd, operation: LOCK_EX | LOCK_NB }),
        ).toBe(ENOTSUP);
        expect(
          await hostWorker.call<{ errno: number }>({
            op: "lock",
            fd: hostFd,
            cmd: F_SETLK,
            type: F_WRLCK,
            whence: 0,
            start: "0",
            len: "10",
          }),
        ).toEqual({ errno: ENOTSUP });
        expect(
          await peerWorker.call<{ errno: number }>({
            op: "lock",
            fd: peerFd,
            cmd: F_OFD_SETLK,
            type: F_WRLCK,
            whence: 0,
            start: "0",
            len: "10",
          }),
        ).toEqual({ errno: ENOTSUP });
        expect(
          await hostWorker.call<{ errno: number }>({
            op: "lock",
            fd: hostFd,
            cmd: F_GETLK,
            type: F_WRLCK,
            whence: 0,
            start: "0",
            len: "10",
          }),
        ).toMatchObject({ errno: ENOTSUP });
      } finally {
        revokeFilesystem(hostWorker.connection);
        revokeFilesystem(peerWorker.connection);
        hostWorker.terminate();
        peerWorker.terminate();
      }
    } finally {
      await vfs.close();
    }
  });
});
