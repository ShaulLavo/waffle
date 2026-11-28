import { afterEach, expect, test } from "bun:test";
import { openInode } from "../core/fd-reopen.js";
import { DescriptorTable } from "../core/descriptors.js";
import { type FileStat, type FileSystem } from "../core/filesystem.js";
import { RIGHT_FD_READ, RIGHT_FD_WRITE } from "../core/rights.js";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { withStrictDecoder } from "./fixtures/buffer-boundaries.js";
import { countingFs, createPathOpenHost } from "./fixtures/wasi-path-open-host.js";

const O_CREAT = 1;
const O_DIRECTORY = 2;
const O_EXCL = 4;
const O_TRUNC = 8;
const FDFLAG_NONBLOCK = 4;

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

test("root path_open uses one stat and one permissions call; non-root drops duplicate stats", () => {
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
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 1, resolve: 1, create: 0 });
  expect(host.readAll(fromRoot.fd)).toBe("hello");
  expect(host.close(fromRoot.fd)).toBe(0);

  // A rooted guest needs no root-identity check for a non-root open: just the open's own stat.
  wrapped.reset();
  const fromSub = host.openRaw(subDir.fd, "hello.txt");
  expect(fromSub.errno).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 1, resolve: 1, create: 0 });
  expect(host.readAll(fromSub.fd)).toBe("hello");
  expect(host.close(fromSub.fd)).toBe(0);

  wrapped.reset();
  const nestedDir = host.openRaw(3, "work/sub/nested", { oflags: O_DIRECTORY });
  expect(nestedDir.errno).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 1, resolve: 1, create: 0 });
  expect(host.close(nestedDir.fd)).toBe(0);

  wrapped.reset();
  const created = host.openRaw(3, "work/sub/created.txt", { oflags: O_CREAT | O_EXCL });
  expect(created.errno).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 1, resolve: 1, create: 1 });
  expect(host.close(created.fd)).toBe(0);

  const fileForReopen = host.openRaw(3, "work/sub/hello.txt");
  expect(fileForReopen.errno).toBe(0);
  wrapped.reset();
  expect(host.wasi.fdReopen(fileForReopen.fd, 0, 0, RIGHT_FD_READ, 128)).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 1, resolve: 0, create: 0 });
});

test("path_open preserves WASI error codes, permission denials, and high-bit fdOut bounds checks", () => {
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

  wrapped.reset();
  expect(host.openRaw(3, "work/sub/missing.txt").errno).toBe(44);
  expect(wrapped.counts).toEqual({ stat: 0, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(3, "work/sub/file.txt", { oflags: O_CREAT | O_EXCL }).errno).toBe(20);
  expect(wrapped.counts).toEqual({ stat: 0, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(3, "work/sub/link", { dirflags: 0 }).errno).toBe(32);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(3, "work/sub/sock").errno).toBe(60);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 0, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(3, "work/sub/file.txt", { oflags: O_DIRECTORY }).errno).toBe(54);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 1, resolve: 1, create: 0 });

  wrapped.reset();
  expect(host.openRaw(3, "work/sub/dir", { oflags: O_TRUNC }).errno).toBe(31);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 1, resolve: 1, create: 0 });

  // Signed i32 pointers above 2^31 (negative in JS i32) must coerce unsigned and fail with EFAULT.
  for (const fdOut of [0x80000000 | 0, 0xfffffff0 | 0, -1]) {
    expect(host.openRaw(3, "work/sub/file.txt", { oflags: O_TRUNC, fdOut }).errno).toBe(21);
    expect(host.openRaw(3, "work/sub/not-created.txt", { oflags: O_CREAT, fdOut }).errno).toBe(21);
  }
  expect(mem.lookup("/work/sub/not-created.txt")).toBeUndefined();
  expect(new TextDecoder().decode(mem.readFile("/work/sub/file.txt"))).toBe("data");

  const fileHandle = mem.handleForNode(mem.lookup("/work/sub/file.txt")!);
  expect(mem.setMode(fileHandle, 0o400)).toBe(0);
  wrapped.reset();
  expect(host.openRaw(3, "work/sub/file.txt", { base: RIGHT_FD_WRITE }).errno).toBe(2);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 1, resolve: 1, create: 0 });

  wrapped.reset();
  const readOnly = host.openRaw(3, "work/sub/file.txt", { base: RIGHT_FD_READ });
  expect(readOnly.errno).toBe(0);
  expect(wrapped.counts).toEqual({ stat: 1, preopen: 0, permissions: 1, resolve: 1, create: 0 });
  expect(host.close(readOnly.fd)).toBe(0);
});

test("openInode respects adapter effective permissions even when stat.mode differs or is absent", () => {
  const mem = new MemFS();
  mem.writeFile("/file", "hello");
  const fileHandle = mem.handleForNode(mem.lookup("/file")!);
  let statMode: number | undefined = 0o600;
  const effectiveAccess = 4;
  const fs = Object.create(mem) as FileSystem;
  fs.stat = (h): FileStat => (h === fileHandle ? { ...mem.stat(h), mode: statMode } : mem.stat(h));
  fs.permissions = (h) =>
    h === fileHandle
      ? { mode: statMode ?? 0, modeSupported: 0o600, access: effectiveAccess, accessSupported: 6 }
      : mem.permissions(h);

  const host = makeHost(fs);
  expect(host.openRaw(3, "file", { base: RIGHT_FD_WRITE }).errno).toBe(2);
  const readable = host.openRaw(3, "file", { base: RIGHT_FD_READ });
  expect(readable.errno).toBe(0);
  expect(host.wasi.fdReopen(readable.fd, 0, 0, RIGHT_FD_WRITE, 128)).toBe(2);

  statMode = 0o044;
  const opened = host.openRaw(3, "file", { base: RIGHT_FD_READ });
  expect(opened.errno).toBe(0);
  expect(host.wasi.fdReopen(readable.fd, 0, 0, RIGHT_FD_READ, 128)).toBe(0);
  expect(host.close(opened.fd)).toBe(0);
  expect(host.close(readable.fd)).toBe(0);

  statMode = undefined;
  const table = new DescriptorTable();
  try {
    expect(openInode(table, fs, fileHandle, "file", 0, 0, RIGHT_FD_WRITE, 0n)).toBe(-2);
    expect(
      openInode(table, fs, fileHandle, "file", 0, 0, RIGHT_FD_READ, 0n),
    ).toBeGreaterThanOrEqual(0);
  } finally {
    table.dispose();
  }
});

test("str uses a zero-copy view on fixed unshared memory and copies resizable or shared memory", () => {
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

  // Shared memory snapshots into a fixed unshared ArrayBuffer.
  const sharedMemory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const sharedWasi = new Wasi({
    args: [],
    env: {},
    fs: mem,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  cleanup.push(() => sharedWasi.descriptors.dispose());
  sharedWasi.bindMemory(sharedMemory);
  const encoded = new TextEncoder().encode("fixed.txt");
  new Uint8Array(sharedMemory.buffer).set(encoded, 512);
  const sharedOpen = sharedWasi["functions"]().path_open;
  withStrictDecoder((backings) => {
    expect(sharedOpen(3, 1, 512, encoded.length, 0, RIGHT_FD_READ, 0n, 0, 128)).toBe(0);
    const fd = new DataView(sharedMemory.buffer).getUint32(128, true);
    expect(sharedWasi.descriptors.close(fd)).toBe(true);
    expect(backings.length).toBeGreaterThan(0);
    expect(
      backings.every(
        (b) =>
          b instanceof ArrayBuffer &&
          !(b instanceof SharedArrayBuffer) &&
          !Reflect.get(b, "resizable"),
      ),
    ).toBe(true);
  });
});

test("an empty path over detached memory still fails with EIO", () => {
  const mem = new MemFS();
  const memory = new WebAssembly.Memory({ initial: 4 });
  if (typeof Reflect.get(memory, "toFixedLengthBuffer") !== "function") return;
  const host = makeHost(mem, { "/": "/" }, memory);
  // Detach the resizable buffer WASI cached at start, then decode an empty path at offset 0.
  Reflect.apply(Reflect.get(memory, "toFixedLengthBuffer"), memory, []);
  expect(host.pathOpen(3, 1, 0, 0, 0, RIGHT_FD_READ, 0n, 0, 128)).toBe(29);
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
    expect(host.words()).toEqual([0o600, 0o777, 6, 6]);
    new Uint8Array(host.memory.buffer).set([0xff], 256);
    expect(Number(host.query(3, 256, 1, 0, 512))).toBe(28);
    expect(host.call("\ufefffile")).toBe(0);
    expect(host.words()).toEqual([0o600, 0o777, 6, 6]);
    expect(host.call("file")).toBe(0);
    expect(constructed).toBe(0);
  } finally {
    globalThis.TextDecoder = Original;
  }
});

test("path_open accepts O_DIRECTORY with FDFLAG_NONBLOCK and enumerates entries via fd_readdir", () => {
  const mem = new MemFS();
  mem.writeFile("/home/user/src/App.tsx", "export default function App() { return null; }\n");
  mem.writeFile("/home/user/index.html", "<!doctype html>\n");
  const host = makeHost(mem);

  // wasi-libc opendir() and Rust std::fs::read_dir open directories with O_DIRECTORY | FDFLAG_NONBLOCK.
  const dir = host.openRaw(3, "home/user", {
    oflags: O_DIRECTORY,
    fdflags: FDFLAG_NONBLOCK,
  });
  expect(dir.errno).toBe(0);
  expect(host.readDirNames(dir.fd).toSorted()).toEqual([".", "..", "index.html", "src"]);
  expect(host.close(dir.fd)).toBe(0);

  // Regular files opened with FDFLAG_NONBLOCK retain the flag in fd_fdstat_get and remain readable.
  const file = host.openRaw(3, "home/user/index.html", {
    fdflags: FDFLAG_NONBLOCK,
    base: RIGHT_FD_READ,
  });
  expect(file.errno).toBe(0);
  expect(host.fdFlags(file.fd) & FDFLAG_NONBLOCK).toBe(FDFLAG_NONBLOCK);
  expect(host.readAll(file.fd)).toBe("<!doctype html>\n");
  expect(host.close(file.fd)).toBe(0);

  // Opening without FDFLAG_NONBLOCK clears the bit in fd_fdstat_get.
  const blockingFile = host.openRaw(3, "home/user/index.html", { base: RIGHT_FD_READ });
  expect(blockingFile.errno).toBe(0);
  expect(host.fdFlags(blockingFile.fd) & FDFLAG_NONBLOCK).toBe(0);
  expect(host.close(blockingFile.fd)).toBe(0);

  // O_DIRECTORY | FDFLAG_NONBLOCK still rejects a regular file with ENOTDIR (54).
  expect(
    host.openRaw(3, "home/user/index.html", {
      oflags: O_DIRECTORY,
      fdflags: FDFLAG_NONBLOCK,
    }).errno,
  ).toBe(54);
});
