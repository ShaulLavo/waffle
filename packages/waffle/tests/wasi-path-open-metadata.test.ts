import { afterEach, expect, test } from "bun:test";
import { openInode } from "../core/fd-reopen.js";
import { DescriptorTable } from "../core/descriptors.js";
import { type FileStat, type FileSystem } from "../core/filesystem.js";
import { RIGHTS_ALL, RIGHT_FD_READ, RIGHT_FD_WRITE } from "../core/rights.js";
import { MemoryBackend } from "../fs/backend.js";
import { MemFS } from "../fs/memory.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";
import { withStrictDecoder } from "./fixtures/buffer-boundaries.js";
import { countingFs, createPathOpenHost } from "./fixtures/wasi-path-open-host.js";

const O_CREAT = 1;
const O_DIRECTORY = 2;
const O_EXCL = 4;
const O_TRUNC = 8;

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

function makeHost(
  fs: FileSystem,
  preopens: Record<string, string> = { "/": "/" },
  memory?: WebAssembly.Memory,
) {
  const host = createPathOpenHost(fs, preopens, memory);
  cleanup.push(() => host.wasi.descriptors.dispose());
  return host;
}

test("path_open uses one stat and zero preopen or permissions calls from root and non-root dirfds", () => {
  const mem = new MemFS();
  mem.writeFile("/work/sub/hello.txt", "hello");
  mem.mkdirp("/work/sub/nested");
  const wrapped = countingFs(mem);
  const host = makeHost(wrapped.fs);

  const subDir = host.openRaw(3, "work/sub", { oflags: O_DIRECTORY });
  expect(subDir.errno).toBe(0);

  wrapped.reset();
  const fromRoot = host.openRaw(3, "work/sub/hello.txt");
  expect(fromRoot.errno).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });
  expect(host.readAll(fromRoot.fd)).toBe("hello");
  expect(host.close(fromRoot.fd)).toBe(0);

  wrapped.reset();
  const fromSub = host.openRaw(subDir.fd, "hello.txt");
  expect(fromSub.errno).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });
  expect(host.readAll(fromSub.fd)).toBe("hello");
  expect(host.close(fromSub.fd)).toBe(0);

  wrapped.reset();
  const nestedDir = host.openRaw(subDir.fd, "nested", { oflags: O_DIRECTORY });
  expect(nestedDir.errno).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });
  expect(host.close(nestedDir.fd)).toBe(0);

  wrapped.reset();
  const created = host.openRaw(subDir.fd, "created.txt", { oflags: O_CREAT | O_EXCL });
  expect(created.errno).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 1 });
  expect(host.close(created.fd)).toBe(0);

  wrapped.reset();
  const reopened = host.wasi.fdReopen(subDir.fd, 0, 0, RIGHTS_ALL, 128);
  expect(reopened).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 0, preopen: 0, permissions: 0, resolve: 0, create: 0 });

  const fileForReopen = host.openRaw(subDir.fd, "hello.txt");
  expect(fileForReopen.errno).toBe(0);
  wrapped.reset();
  expect(host.wasi.fdReopen(fileForReopen.fd, 0, 0, RIGHT_FD_READ, 128)).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 0, create: 0 });
});

test("path_open preserves WASI error codes and permission denials without extra metadata calls", () => {
  const mem = new MemFS();
  mem.writeFile("/work/sub/file.txt", "data");
  mem.mkdirp("/work/sub/dir");
  const rootHandle = mem.preopen("/");
  const linkPath = mem.resolve(rootHandle, "work/sub/link", false);
  if (typeof linkPath === "number") throw new Error(`resolve: ${linkPath}`);
  expect(mem.symlink(linkPath, "file.txt")).toBe(0);
  const sockPath = mem.resolve(rootHandle, "work/sub/sock", false);
  if (typeof sockPath === "number") throw new Error(`resolve: ${sockPath}`);
  expect(typeof mem.create(sockPath, "socket", true)).toBe("number");

  const wrapped = countingFs(mem);
  const host = makeHost(wrapped.fs);
  const subDir = host.openRaw(3, "work/sub", { oflags: O_DIRECTORY });
  expect(subDir.errno).toBe(0);

  wrapped.reset();
  expect(host.openRaw(subDir.fd, "missing.txt").errno).toBe(44);
  expect(wrapped.counts).toEqual({ stat: 0, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  // First deep ENOENT lazily caches root's ino once; repeated misses do zero stats and zero preopens.
  wrapped.reset();
  expect(host.openRaw(subDir.fd, "no-such-dir/child").errno).toBe(44);
  expect(wrapped.counts.preopen).toBe(0);
  expect(wrapped.counts.permissions).toBe(0);
  expect(wrapped.counts.resolve).toBe(1);
  expect(wrapped.counts.stat).toBeLessThanOrEqual(1);

  wrapped.reset();
  expect(host.openRaw(subDir.fd, "another-missing/child").errno).toBe(44);
  expect(wrapped.counts).toEqual({ stat: 0, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(subDir.fd, "file.txt", { oflags: O_CREAT | O_EXCL }).errno).toBe(20);
  expect(wrapped.counts).toEqual({ stat: 0, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(subDir.fd, "link", { dirflags: 0 }).errno).toBe(32);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(subDir.fd, "sock").errno).toBe(60);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(subDir.fd, "file.txt", { oflags: O_DIRECTORY }).errno).toBe(54);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(subDir.fd, "dir", { oflags: O_TRUNC }).errno).toBe(31);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  const fileHandle = mem.handleForNode(mem.lookup("/work/sub/file.txt")!);
  expect(mem.setMode(fileHandle, 0o400)).toBe(0);
  wrapped.reset();
  expect(host.openRaw(subDir.fd, "file.txt", { base: RIGHT_FD_WRITE }).errno).toBe(2);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  const readOnly = host.openRaw(subDir.fd, "file.txt", { base: RIGHT_FD_READ });
  expect(readOnly.errno).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });
  expect(host.close(readOnly.fd)).toBe(0);

  expect(mem.setMode(mem.handleForNode(mem.lookup("/work/sub/file.txt")!), 0o200)).toBe(0);
  wrapped.reset();
  expect(host.openRaw(subDir.fd, "file.txt", { base: RIGHT_FD_READ }).errno).toBe(2);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });
});

test("openInode falls back to fs.permissions when stat omits mode", () => {
  const statWithoutMode: FileStat = {
    kind: "file",
    ino: 7,
    nlink: 1,
    size: 0,
    atime: 0n,
    mtime: 0n,
    ctime: 0n,
  };
  let permissionCalls = 0;
  const mem = new MemFS();
  mem.writeFile("/f", "ok");
  const handle = mem.handleForNode(mem.lookup("/f")!);
  const fs = Object.create(mem) as FileSystem;
  fs.stat = () => statWithoutMode;
  fs.permissions = () => {
    permissionCalls++;
    return { mode: 0o400, modeSupported: 0o600, access: 4, accessSupported: 6 };
  };
  const table = new DescriptorTable();
  try {
    expect(openInode(table, fs, handle, "file", 0, 0, RIGHT_FD_WRITE, 0n)).toBe(-2);
    expect(permissionCalls).toBe(1);
    const fd = openInode(table, fs, handle, "file", 0, 0, RIGHT_FD_READ, 0n);
    expect(fd).toBeGreaterThanOrEqual(0);
    expect(permissionCalls).toBe(2);
  } finally {
    table.dispose();
  }
});

test("root, opened-root, non-root and sandboxed dirfds keep alias isolation without fs.preopen", () => {
  const mem = new MemFS();
  mem.writeFile("/file", "root-file");
  mem.writeFile("/other/null", "physical-null");
  const wrapped = countingFs(mem);
  const host = makeHost(wrapped.fs);

  const source = host.openRaw(3, "file", { base: RIGHT_FD_READ });
  expect(source.errno).toBe(0);
  mem.writeFile(`/other/dev/fd/${source.fd}`, "physical-fd");

  const openedRoot = host.openRaw(3, ".", { oflags: O_DIRECTORY });
  expect(openedRoot.errno).toBe(0);
  const otherDir = host.openRaw(3, "other", { oflags: O_DIRECTORY });
  expect(otherDir.errno).toBe(0);

  wrapped.reset();
  const aliasFromOpenedRoot = host.openRaw(openedRoot.fd, `proc/self/fd/${source.fd}`, {
    base: RIGHT_FD_READ,
  });
  expect(aliasFromOpenedRoot.errno).toBe(0);
  expect(wrapped.counts.preopen).toBe(0);
  expect(host.readAll(aliasFromOpenedRoot.fd)).toBe("root-file");

  wrapped.reset();
  const devNullFromOpenedRoot = host.openRaw(openedRoot.fd, "dev/null", { base: RIGHT_FD_READ });
  expect(devNullFromOpenedRoot.errno).toBe(0);
  expect(wrapped.counts.preopen).toBe(0);
  expect(host.wasi.descriptors.get(devNullFromOpenedRoot.fd)?.resource.kind).toBe("device");

  wrapped.reset();
  const physicalFd = host.openRaw(otherDir.fd, `dev/fd/${source.fd}`, { base: RIGHT_FD_READ });
  expect(physicalFd.errno).toBe(0);
  expect(wrapped.counts.preopen).toBe(0);
  expect(host.readAll(physicalFd.fd)).toBe("physical-fd");

  wrapped.reset();
  const physicalNull = host.openRaw(otherDir.fd, "null", { base: RIGHT_FD_READ });
  expect(physicalNull.errno).toBe(0);
  expect(wrapped.counts.preopen).toBe(0);
  expect(host.readAll(physicalNull.fd)).toBe("physical-null");

  wrapped.reset();
  expect(host.openRaw(otherDir.fd, `/dev/fd/${source.fd}`, { base: RIGHT_FD_READ }).errno).toBe(63);
  expect(wrapped.counts.preopen).toBe(0);

  // Sandboxed guest with no "/" preopen never touches fs.preopen or fs.stat on misses.
  const sandboxMem = new MemFS();
  sandboxMem.writeFile("/sandbox/a.txt", "inside");
  const sandboxWrapped = countingFs(sandboxMem);
  const sandboxHost = makeHost(sandboxWrapped.fs, { "/sandbox": "/sandbox" });
  sandboxWrapped.reset();
  expect(sandboxHost.openRaw(3, "dev/fd/0", { base: RIGHT_FD_READ }).errno).toBe(44);
  expect(sandboxHost.openRaw(3, "missing/child", { base: RIGHT_FD_READ }).errno).toBe(44);
  expect(sandboxWrapped.counts).toEqual({
    stat: 0,
    preopen: 0,
    permissions: 0,
    resolve: 2,
    create: 0,
  });
});

test("FilesystemClient non-root path_open does not call preopen or bump the global epoch", async () => {
  const backend = new MemoryBackend();
  backend.fs.writeFile("/work/sub/hello.txt", "ipc-hello");
  backend.fs.writeFile("/work/sub/readonly.txt", "locked");
  backend.fs.setMode(backend.fs.handleForNode(backend.fs.lookup("/work/sub/readonly.txt")!), 0o400);
  const service = new FilesystemService(backend);
  cleanup.push(() => service.dispose());
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const worker = new Worker(new URL("./fixtures/wasi-path-open-worker.ts", import.meta.url).href);
  cleanup.push(() => worker.terminate());

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data as Record<string, unknown>);
    worker.onerror = reject;
    worker.postMessage(pair.client, [pair.client.port]);
  });

  expect(result.subDirErrno).toBe(0);
  expect(result.openedRootErrno).toBe(0);
  expect(result.epochAfter).toBe(result.epochBefore);
  expect(result.opens).toEqual(
    Array.from({ length: 4 }, () => ({
      errno: 0,
      text: "ipc-hello",
      counts: { stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 },
    })),
  );
  expect(result.deniedErrno).toBe(2);
  expect(result.deniedCounts).toEqual({
    stat: 1,
    preopen: 0,
    permissions: 0,
    resolve: 1,
    create: 0,
  });
  expect(result.devNullErrno).toBe(0);
  expect(result.devNullKind).toBe("device");
  expect((result.devNullCounts as { preopen: number }).preopen).toBe(0);
});

test("str uses a zero-copy view on fixed unshared memory and copies resizable memory", () => {
  const mem = new MemFS();
  mem.writeFile("/fixed.txt", "ok");

  // Force a fixed unshared backing buffer (as on hosts without toResizableBuffer).
  const fixedMemory = new WebAssembly.Memory({ initial: 4 });
  Object.defineProperty(fixedMemory, "toResizableBuffer", { value: undefined });
  const fixedHost = makeHost(mem, { "/": "/" }, fixedMemory);
  withStrictDecoder((backings) => {
    const opened = fixedHost.openRaw(3, "fixed.txt", { base: RIGHT_FD_READ });
    expect(opened.errno).toBe(0);
    expect(backings).toEqual([fixedMemory.buffer]);
    expect(fixedHost.close(opened.fd)).toBe(0);
  });

  // Default memory (resizable when supported) snapshots into a fixed ArrayBuffer.
  const defaultMemory = new WebAssembly.Memory({ initial: 4 });
  const defaultHost = makeHost(mem, { "/": "/" }, defaultMemory);
  withStrictDecoder((backings) => {
    const opened = defaultHost.openRaw(3, "fixed.txt", { base: RIGHT_FD_READ });
    expect(opened.errno).toBe(0);
    expect(backings.length).toBeGreaterThan(0);
    expect(backings.every((b) => b instanceof ArrayBuffer && !Reflect.get(b, "resizable"))).toBe(
      true,
    );
    expect(defaultHost.close(opened.fd)).toBe(0);
  });
});

test("path_permissions_get reuses its decoder across invalid UTF-8, BOM and valid paths", async () => {
  const { permissionsHost } = await import("./fixtures/permissions-guest.js");
  const mem = new MemFS();
  mem.writeFile("/file", "a");
  mem.writeFile("/\ufefffile", "b");
  const host = permissionsHost(mem);
  cleanup.push(() => host.wasi.descriptors.dispose());

  const Original = globalThis.TextDecoder;
  let constructed = 0;
  class CountingTextDecoder extends Original {
    constructor(...args: ConstructorParameters<typeof TextDecoder>) {
      super(...args);
      constructed++;
    }
  }
  globalThis.TextDecoder = CountingTextDecoder;
  try {
    expect(host.call("file")).toBe(0);
    expect(host.words()).toEqual([0o600, 0o600, 6, 6]);
    new Uint8Array(host.memory.buffer).set([0xff], 256);
    expect(Number(host.query(3, 256, 1, 0, 512))).toBe(28);
    expect(host.call("\ufefffile")).toBe(0);
    expect(host.words()).toEqual([0o600, 0o600, 6, 6]);
    expect(host.call("file")).toBe(0);
    expect(constructed).toBe(0);
  } finally {
    globalThis.TextDecoder = Original;
  }
});
