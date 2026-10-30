import { expect, spyOn, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";

const encoder = new TextEncoder();
const ALL_RIGHTS = (1n << 29n) - 1n;
const O_CREAT = 1;
const O_DIRECTORY = 2;
const O_EXCL = 4;
const O_TRUNC = 8;

function fixture() {
  const fs = new MemFS();
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.start({ exports: { memory, _start() {} } });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const calls = wasi["functions"]();
  const open = (flags = 0, fdflags = 0, name = "dev/null") => {
    const path = encoder.encode(name);
    bytes.set(path, 256);
    const result = calls.path_open(3, 1, 256, path.length, flags, ALL_RIGHTS, 0n, fdflags, 1024);
    return { result, fd: result === 0 ? view.getUint32(1024, true) : undefined };
  };
  const io = (name: "fd_read" | "fd_write", fd: number, text = "payload") => {
    const data = encoder.encode(text);
    bytes.set(data, 2048);
    view.setUint32(2048 - 8, 2048, true);
    view.setUint32(2048 - 4, data.length, true);
    view.setUint32(1024, 0xabcdef01, true);
    const result = calls[name](fd, 2040, 1, 1024);
    return { result, count: view.getUint32(1024, true), data };
  };
  return { fs, wasi, calls, view, io, open };
}

test("actual WASI opens /dev/null without creating a MemFS node", () => {
  const f = fixture();
  try {
    const plain = f.open();
    expect(plain.result).toBe(0);
    expect(f.fs.lookup("/dev")).toBeUndefined();
    expect(f.fs.lookup("/dev/null")).toBeUndefined();

    const truncate = f.open(O_CREAT | O_TRUNC, 1);
    expect(truncate.result).toBe(0);
    expect(f.calls.fd_fdstat_get(truncate.fd!, 512)).toBe(0);
    expect(f.view.getUint16(514, true)).toBe(1);
    expect(f.wasi.descriptors.get(truncate.fd!)?.resource.kind).toBe("device");

    expect(f.open(O_CREAT | O_EXCL).result).toBe(20);
    expect(f.open(O_DIRECTORY).result).toBe(54);
  } finally {
    f.wasi.descriptors.dispose();
  }
});

test("actual WASI /dev/null reads EOF and discards repeated writes", () => {
  const f = fixture();
  try {
    const opened = f.open(0, 1);
    expect(opened.result).toBe(0);
    const fd = opened.fd!;
    const read = f.io("fd_read", fd, "ignored");
    expect(read.result).toBe(0);
    expect(read.count).toBe(0);

    for (let index = 0; index < 128; index++) {
      const write = f.io("fd_write", fd, `${index}:payload`);
      expect(write.result).toBe(0);
      expect(write.count).toBe(write.data.length);
    }
    expect(f.fs.lookup("/dev/null")).toBeUndefined();
  } finally {
    f.wasi.descriptors.dispose();
  }
});

test("actual WASI /dev/null exposes character metadata and descriptor lifetime", () => {
  const f = fixture();
  try {
    const opened = f.open();
    expect(opened.result).toBe(0);
    const fd = opened.fd!;
    const entry = f.wasi.descriptors.get(fd)!;
    expect(entry.resource.kind).toBe("device");
    expect(f.wasi.descriptors.kind(fd)).toBe(0);
    expect(f.calls.fd_fdstat_get(fd, 512)).toBe(0);
    expect(f.view.getUint8(512)).toBe(2);
    expect(f.view.getUint16(514, true)).toBe(0);
    expect(f.calls.fd_filestat_get(fd, 544)).toBe(0);
    expect(f.view.getUint8(560)).toBe(2);
    expect(f.view.getBigUint64(568, true)).toBe(1n);
    expect(f.view.getBigUint64(576, true)).toBe(0n);

    const duplicate = f.wasi.descriptors.dup(fd);
    expect(f.calls.fd_close(fd)).toBe(0);
    expect(f.io("fd_write", duplicate, "still open").count).toBe(10);
    expect(f.calls.fd_close(duplicate)).toBe(0);
    expect(f.calls.fd_close(duplicate)).toBe(8);
  } finally {
    f.wasi.descriptors.dispose();
  }
});

function makeLink(fs: MemFS, name: string, target: string) {
  const path = fs.resolve(fs.preopen("/"), name, false);
  if (typeof path === "number") throw new Error(`Cannot prepare symlink: ${path}`);
  expect(fs.symlink(path, target)).toBe(0);
}

for (const withDirectory of [false, true]) {
  test(`null device follows final and ancestor symlinks with real dev directory ${withDirectory}`, () => {
    const f = fixture();
    try {
      if (withDirectory) f.fs.mkdirp("/dev");
      const links: readonly (readonly [string, string])[] = [
        ["alias", "dev/null"],
        ["device-dir", "dev"],
      ];
      for (const [name, target] of links) {
        makeLink(f.fs, name, target);
      }
      for (const name of ["alias", "device-dir/null"]) {
        const opened = f.open(O_CREAT | O_TRUNC, 0, name);
        expect(opened.result).toBe(0);
        expect(f.wasi.descriptors.get(opened.fd!)?.resource.kind).toBe("device");
        expect(f.io("fd_write", opened.fd!, "discard me").count).toBe(10);
        expect(f.fs.lookup("/dev/null")).toBeUndefined();
      }
    } finally {
      f.wasi.descriptors.dispose();
    }
  });
}

test("ordinary root opens retain one filesystem resolution", () => {
  const f = fixture();
  f.fs.writeFile("/ordinary", "data");
  const resolve = spyOn(f.fs, "resolve");
  try {
    expect(f.open(0, 0, "ordinary").result).toBe(0);
    expect(resolve).toHaveBeenCalledTimes(1);
  } finally {
    resolve.mockRestore();
    f.wasi.descriptors.dispose();
  }
});
