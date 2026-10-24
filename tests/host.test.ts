import { expect, test } from "bun:test";
import { Wasi } from "../core/index";
import type { FileSystem } from "../core/filesystem.js";
import type { Resource, Stream } from "../core/descriptors.js";
import type { WasiOptions } from "../core/wasi.js";
import assert from "node:assert/strict";
import { MemFS } from "../fs/memory";
const ALL = (1n << 29n) - 1n;
function host(fs: FileSystem = new MemFS(), options: Partial<WasiOptions> = {}, fallback = false) {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
    ...options,
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  if (fallback) Object.defineProperty(memory, "toResizableBuffer", { value: undefined });
  wasi.start({ exports: { memory, _start() {} } });
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const calls = wasi["functions"]();
  function open(path: string, flags = 0) {
    const data = new TextEncoder().encode(path);
    bytes.set(data, 256);
    expect(calls.path_open(3, 0, 256, data.length, flags, ALL, ALL, 0, 1024)).toBe(0);
    return view.getUint32(1024, true);
  }
  return { wasi, memory, view, bytes, calls, open };
}
test("WASI preopens fill the lowest unreserved descriptor gaps", () => {
  for (const [reserved, expected] of [
    [[], [3, 4]],
    [[3], [4, 5]],
    [
      [3, 4, 5, 6, 7, 8, 9],
      [10, 11],
    ],
    [[5], [3, 4]],
    [
      [3, 10, 11, 12],
      [4, 5],
    ],
    [
      [3, 1_000_000],
      [4, 5],
    ],
  ] satisfies [number[], number[]][]) {
    const wasi = new Wasi({
      args: [],
      env: {},
      fs: new MemFS(),
      preopens: { "/": "/", "/tmp": "/tmp" },
      reservedFds: reserved,
      stdout() {},
      stderr() {},
      sleep() {},
    });
    expect(expected.map((fd) => wasi.descriptors.get(fd)?.preopen)).toEqual(["/", "/tmp"]);
    wasi.descriptors.dispose();
  }
});

test("WASI validates all reserved targets before opening stdio or filesystem preopens", () => {
  let preopens = 0;
  const fs = new MemFS();
  const preopen = fs.preopen.bind(fs);
  fs.preopen = (path) => {
    preopens++;
    return preopen(path);
  };
  expect(
    () =>
      new Wasi({
        args: [],
        env: {},
        fs,
        preopens: { "/": "/" },
        reservedFds: [3, 3],
        stdout() {},
        stderr() {},
        sleep() {},
      }),
  ).toThrow(RangeError);
  expect(preopens).toBe(0);
});

test("WASI reports inherited descriptors as non-preopens", () => {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: { "/": "/" },
    reservedFds: [3],
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const calls = wasi["functions"]();
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.start({ exports: { memory, _start() {} } });
  expect(calls.fd_prestat_get(0, 0)).toBe(8);
  expect(calls.fd_prestat_get(3, 0)).toBe(8);
  expect(wasi.descriptors.get(4)?.preopen).toBe("/");
  wasi.descriptors.dispose();
});

test("WASI duplicates really share the seek cursor, append flags, and lifetime", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "hello");
  const h = host(fs);
  const fd = h.open("file");
  const dup = h.wasi.descriptors.dup(fd);
  expect(h.calls.fd_seek(dup, 2n, 0, 1024)).toBe(0);
  expect(h.calls.fd_tell(fd, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(2n);
  expect(h.calls.fd_fdstat_set_flags(fd, 1)).toBe(0);
  h.bytes.set(new TextEncoder().encode("!"), 512);
  h.view.setUint32(0, 512, true);
  h.view.setUint32(4, 1, true);
  expect(h.calls.fd_write(dup, 0, 1, 1024)).toBe(0);
  expect(fileResource(h.wasi, fd).offset).toBe(6);
  expect(new TextDecoder().decode(fs.readFile("/file"))).toBe("hello!");
  expect(h.calls.fd_close(fd)).toBe(0);
  expect(h.calls.fd_tell(dup, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(6n);
});
test("core uses only the filesystem contract and accepts a zero-valued opaque handle", () => {
  const record = { kind: "file", ino: 89, size: 4, mtime: 0 } as const;
  const unexpected = (): never => {
    throw new Error("unexpected filesystem call");
  };
  const fs: FileSystem = {
    write: unexpected,
    append: unexpected,
    resize: unexpected,
    setMtime: unexpected,
    readdir: unexpected,
    create: unexpected,
    link: unexpected,
    symlink: unexpected,
    readlink: unexpected,
    removePath: unexpected,
    rename: unexpected,
    preopen: () => 99,
    retain() {},
    release() {},
    resolve: () => ({
      parent: 99,
      name: "file",
      node: 0,
      trailingSlash: false,
      terminalDot: false,
    }),
    stat: (handle: number) => {
      expect(handle).toBe(0);
      return record;
    },
    read: (_handle: number, chunks: readonly Uint8Array[]) => {
      chunks[0]!.set([1, 2, 3, 4]);
      return 4;
    },
  };
  const h = host(fs);
  const fd = h.open("file");
  h.view.setUint32(0, 512, true);
  h.view.setUint32(4, 4, true);
  expect(h.calls.fd_read(fd, 0, 1, 1024)).toBe(0);
  expect(Array.from(h.bytes.subarray(512, 516))).toEqual([1, 2, 3, 4]);
});
test("injected stdio are descriptors with real stream readiness and errno results", () => {
  const state = { readable: false, writable: false, hangup: false };
  const stdin: Stream = { kind: "pipe", read: () => -6, write: () => -64, readiness: () => state };
  const h = host(new MemFS(), { stdio: { 0: stdin } });
  expect(h.wasi.descriptors.get(0)!.resource).toBe(stdin);
  h.view.setUint32(0, 512, true);
  h.view.setUint32(4, 1, true);
  expect(h.calls.fd_read(0, 0, 1, 1024)).toBe(6);
  expect(h.calls.fd_write(0, 0, 1, 1024)).toBe(64);
});

test("filesystem handles live once per open description, not once per duplicate", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "data");
  let retains = 0,
    releases = 0;
  fs.retain = () => retains++;
  fs.release = () => releases++;
  const h = host(fs);
  const fd = h.open("file");
  const dup = h.wasi.descriptors.dup(fd);
  expect(retains).toBe(2); // preopen + one file description
  expect(h.calls.fd_close(fd)).toBe(0);
  expect(releases).toBe(0);
  expect(h.calls.fd_close(dup)).toBe(0);
  expect(releases).toBe(1);
  h.wasi.descriptors.dispose();
  expect(releases).toBe(2);
});

test("opaque handles distinguish separate nodes with the same serialized inode", () => {
  const fs = new MemFS();
  fs.writeFile("/first", "first");
  fs.writeFile("/second", "other");
  // Worker snapshots can contain independently allocated nodes with colliding inode metadata.
  fs.lookup("/second")!.ino = fs.lookup("/first")!.ino;
  const h = host(fs);
  const first = h.open("first");
  const second = h.open("second");
  h.view.setUint32(0, 512, true);
  h.view.setUint32(4, 5, true);
  expect(h.calls.fd_read(first, 0, 1, 1024)).toBe(0);
  expect(new TextDecoder().decode(h.bytes.subarray(512, 517))).toBe("first");
  expect(fileResource(h.wasi, first).handle).not.toBe(fileResource(h.wasi, second).handle);
  expect(h.calls.fd_close(second)).toBe(0);
  h.wasi.descriptors.dispose();
});

for (const operation of ["read", "write"] as const) {
  test(`positioned ${operation} reacquires fallback memory after filesystem reentry`, () => {
    const fs = new MemFS();
    fs.writeFile("/file", "abc");
    const h = host(fs, {}, true);
    const fd = h.open("file");
    h.bytes.set(new TextEncoder().encode("xyz"), 512);
    h.view.setUint32(0, 512, true);
    h.view.setUint32(4, 3, true);
    const original = fs[operation].bind(fs);
    fs[operation] = (...args) => {
      const result = original(...args);
      h.memory.grow(1);
      return result;
    };
    expect(h.calls[operation === "read" ? "fd_pread" : "fd_pwrite"](fd, 0, 1, 0n, 1024)).toBe(0);
    expect(new DataView(h.memory.buffer).getUint32(1024, true)).toBe(3);
    if (operation === "read")
      expect(new TextDecoder().decode(new Uint8Array(h.memory.buffer, 512, 3))).toBe("abc");
    else expect(new TextDecoder().decode(fs.readFile("/file"))).toBe("xyz");
    h.wasi.descriptors.dispose();
  });
}

for (const operation of ["read", "write"] as const)
  for (const positioned of [false, true]) {
    test(`filesystem ${operation} errno preserves cursor and output count (positioned=${positioned})`, () => {
      const fs = new MemFS();
      fs.writeFile("/file", "abc");
      const h = host(fs);
      const fd = h.open("file");
      fileResource(h.wasi, fd).offset = 2;
      fs[operation] = () => -51;
      h.view.setUint32(0, 512, true);
      h.view.setUint32(4, 3, true);
      h.view.setUint32(1024, 1234, true);
      expect(
        positioned
          ? h.calls[operation === "read" ? "fd_pread" : "fd_pwrite"](fd, 0, 1, 0n, 1024)
          : h.calls[operation === "read" ? "fd_read" : "fd_write"](fd, 0, 1, 1024),
      ).toBe(51);
      expect(fileResource(h.wasi, fd).offset).toBe(2);
      expect(h.view.getUint32(1024, true)).toBe(1234);
      h.wasi.descriptors.dispose();
    });
  }

test("filesystem resize errors propagate through allocation, resize and path truncation", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "abc");
  const h = host(fs);
  const fd = h.open("file");
  fs.resize = () => 51;
  expect(h.calls.fd_allocate(fd, 0n, 10n)).toBe(51);
  expect(h.calls.fd_filestat_set_size(fd, 10n)).toBe(51);
  expect(h.calls.path_open(3, 0, 256, 4, 8, ALL, ALL, 0, 1024)).toBe(51);
  expect(h.wasi.descriptors.get(fd + 1)).toBeUndefined();
  expect(new TextDecoder().decode(fs.readFile("/file"))).toBe("abc");
  h.wasi.descriptors.dispose();
});

test("filesystem timestamp errors propagate for descriptor and path operations", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "abc");
  const h = host(fs);
  const fd = h.open("file");
  fs.setMtime = () => 69;
  expect(h.calls.fd_filestat_set_times(fd, 0n, 1n, 4)).toBe(69);
  expect(h.calls.path_filestat_set_times(3, 0, 256, 4, 0n, 1n, 4)).toBe(69);
  h.wasi.descriptors.dispose();
});

test("append writes reacquire guest iovecs after filesystem stat reentry", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "abc");
  const h = host(fs, {}, true);
  const fd = h.open("file");
  expect(h.calls.fd_fdstat_set_flags(fd, 1)).toBe(0);
  h.bytes[512] = 33;
  h.view.setUint32(0, 512, true);
  h.view.setUint32(4, 1, true);
  const stat = fs.stat.bind(fs);
  fs.stat = (handle) => {
    const result = stat(handle);
    h.memory.grow(1);
    return result;
  };
  expect(h.calls.fd_write(fd, 0, 1, 1024)).toBe(0);
  expect(new DataView(h.memory.buffer).getUint32(1024, true)).toBe(1);
  expect(new TextDecoder().decode(fs.readFile("/file"))).toBe("abc!");
  expect(fileResource(h.wasi, fd).offset).toBe(4);
  h.wasi.descriptors.dispose();
});
test("fd_sync and fd_datasync invoke the filesystem durability barrier and report failure", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "saved");
  const calls: number[] = [];
  const withSync: FileSystem = Object.assign(fs, {
    sync(handle: number) {
      calls.push(handle);
      return 29;
    },
  });
  const h = host(withSync);
  const fd = h.open("file");
  expect(h.calls.fd_sync(fd)).toBe(29);
  expect(h.calls.fd_datasync(fd)).toBe(29);
  expect(calls.length).toBe(2);
  expect(h.calls.fd_sync(999)).toBe(8);
});

function fileResource(wasi: Wasi, fd: number): Extract<Resource, { kind: "file" }> {
  const resource = wasi.descriptors.get(fd)?.resource;
  assert.ok(resource?.kind === "file");
  return resource;
}
