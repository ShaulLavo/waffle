import { expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { withStrictDecoder } from "./fixtures/buffer-boundaries.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

const encoder = new TextEncoder();
const READ = 2n;
const WRITE = 64n;
const O_CREAT = 1;
const O_TRUNC = 8;
const EFAULT = 21;
const ENOENT = 44;
const ROOT = 3;
const BASE_FDS = [0, 1, 2];

function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return bytes;
}

function text(value: string): number[] {
  return leb(value.length).concat(Array.from(encoder.encode(value)));
}

function section(id: number, payload: number[]): number[] {
  return [id].concat(leb(payload.length), payload);
}

function functionImportModule(namespace: string): WebAssembly.Module {
  const type = [0x60, 9].concat(Array(5).fill(0x7f), [0x7e, 0x7e, 0x7f, 0x7f], [1, 0x7f]);
  const importEntry = text(namespace).concat(text("path_open"), [0, 0]);
  const callArguments = [
    0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3, 0x20, 4, 0x20, 5, 0x20, 6, 0x20, 7, 0x20, 8,
  ];
  const body = [0].concat(callArguments, [0x10, 0, 0x0b]);
  return new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1].concat(type)),
        section(2, [1].concat(importEntry)),
        section(3, [1, 0]),
        section(7, [1].concat(text("path_open"), [0, 1])),
        section(10, [1].concat(leb(body.length), body)),
      ),
    ),
  );
}

function fixture(memory = new WebAssembly.Memory({ initial: 4 })) {
  const fs = new MemFS();
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const module = guestModule("wasi_snapshot_preview1", [
    {
      name: "path_open",
      parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
    },
    { name: "path_symlink", parameters: ["i32", "i32", "i32", "i32", "i32"] },
    { name: "fd_close", parameters: ["i32"] },
  ]);
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const call = (name: string, ...args: (number | bigint)[]) =>
    guestFunction(instance, name)(...args);
  const put = (value: string, at: number) => {
    const bytes = encoder.encode(value);
    new Uint8Array(memory.buffer).set(bytes, at);
    return bytes.length;
  };
  const pathOpen = (ptr: number, len: number, flags: number, out: number) =>
    call("path_open", ROOT, 0, ptr, len, flags, READ | WRITE, 0n, 0, out);
  const pathSymlink = (targetPtr: number, targetLen: number, ptr: number, len: number) =>
    call("path_symlink", targetPtr, targetLen, ROOT, ptr, len);
  const close = (fd: number) => call("fd_close", fd);
  return { fs, wasi, memory, call, close, pathOpen, pathSymlink, put };
}

function withFixture(run: (value: ReturnType<typeof fixture>) => void): void {
  const value = fixture();
  try {
    run(value);
  } finally {
    value.wasi.descriptors.dispose();
  }
}

function fileText(fs: MemFS, path: string): string {
  return new TextDecoder().decode(fs.readFile(path));
}

test("WAF-001 CREATE with an invalid result span has no filesystem or descriptor effect", () => {
  withFixture((f) => {
    const end = f.memory.buffer.byteLength;
    const length = f.put("created", 1024);
    const before = new Uint8Array(f.memory.buffer).slice();
    expect(f.pathOpen(1024, length, O_CREAT, end - 3)).toBe(EFAULT);
    expect(f.fs.lookup("/created")).toBeUndefined();
    expect(f.wasi.descriptors.inheritable()).toEqual(BASE_FDS);
    expect(new Uint8Array(f.memory.buffer)).toEqual(before);
  });
});

test("WAF-001 TRUNC with an invalid result span preserves data and descriptors", () => {
  withFixture((f) => {
    f.fs.writeFile("/existing", "abcdef");
    const end = f.memory.buffer.byteLength;
    const length = f.put("existing", 1024);
    const before = new Uint8Array(f.memory.buffer).slice();
    expect(f.pathOpen(1024, length, O_TRUNC, end - 3)).toBe(EFAULT);
    expect(fileText(f.fs, "/existing")).toBe("abcdef");
    expect(f.wasi.descriptors.inheritable()).toEqual(BASE_FDS);
    expect(new Uint8Array(f.memory.buffer)).toEqual(before);
  });
});

test("WAF-001 ordinary invalid output does not allocate a descriptor", () => {
  withFixture((f) => {
    f.fs.writeFile("/existing", "abcdef");
    const end = f.memory.buffer.byteLength;
    const length = f.put("existing", 1024);
    const before = new Uint8Array(f.memory.buffer).slice();
    for (const out of [end - 3, -1]) expect(f.pathOpen(1024, length, 0, out)).toBe(EFAULT);
    expect(f.wasi.descriptors.inheritable()).toEqual(BASE_FDS);
    expect(fileText(f.fs, "/existing")).toBe("abcdef");
    expect(new Uint8Array(f.memory.buffer)).toEqual(before);
  });
});

test("WAF-001 invalid pathname spans are not clipped into a different path", () => {
  withFixture((f) => {
    f.fs.writeFile("/existing", "abcdef");
    const end = f.memory.buffer.byteLength;
    const path = f.put("existing", end - "existing".length);
    expect(f.pathOpen(end - path, path + 1, 0, 128)).toBe(EFAULT);
    expect(f.wasi.descriptors.inheritable()).toEqual(BASE_FDS);
    expect(f.pathOpen(-1, 1, 0, 128)).toBe(EFAULT);
    expect(f.pathOpen(end + 1, 0, 0, 128)).toBe(EFAULT);
    expect(f.pathOpen(end, 0, 0, 128)).toBe(ENOENT);
  });
});

test("WAF-001 invalid symlink target spans do not create a link", () => {
  withFixture((f) => {
    const end = f.memory.buffer.byteLength;
    const target = f.put("target", end - "target".length);
    const link = f.put("link", 1024);
    expect(f.pathSymlink(end - target, target + 1, 1024, link)).toBe(EFAULT);
    expect(f.fs.lookup("/link", false)).toBeUndefined();
  });
});

test("WAF-001 valid edge-aligned spans survive memory growth", () => {
  withFixture((f) => {
    f.fs.writeFile("/edge", "ok");
    const openAtEdge = () => {
      const end = f.memory.buffer.byteLength;
      const pathAt = end - 8;
      const resultAt = end - 4;
      const path = f.put("edge", pathAt);
      const result = f.pathOpen(pathAt, path, 0, resultAt);
      expect(result).toBe(0);
      const fd = new DataView(f.memory.buffer).getUint32(resultAt, true);
      expect(f.close(fd)).toBe(0);
    };
    openAtEdge();
    f.memory.grow(1);
    openAtEdge();
  });
});

test("WAF-001 shared guest decoding snapshots fixed unshared bytes", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
  const fs = new MemFS();
  fs.writeFile("/shared", "ok");
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  wasi.bindMemory(memory);
  const module = functionImportModule("wasi_snapshot_preview1");
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  const open = guestFunction(instance, "path_open");
  try {
    withStrictDecoder((backings) => {
      const end = memory.buffer.byteLength;
      const path = encoder.encode("shared");
      new Uint8Array(memory.buffer).set(path, end - path.length);
      expect(open(ROOT, 0, end - path.length, path.length, 0, READ, 0n, 0, end - 4)).toBe(0);
      const fd = new DataView(memory.buffer).getUint32(end - 4, true);
      expect(wasi.descriptors.close(fd)).toBe(true);
      expect(backings.length).toBeGreaterThan(0);
      expect(backings.every((backing) => backing instanceof ArrayBuffer)).toBe(true);
      memory.grow(1);
      const grownEnd = memory.buffer.byteLength;
      new Uint8Array(memory.buffer).set(path, grownEnd - path.length);
      expect(open(ROOT, 0, grownEnd - path.length, path.length, 0, READ, 0n, 0, grownEnd - 4)).toBe(
        0,
      );
      const grownFd = new DataView(memory.buffer).getUint32(grownEnd - 4, true);
      expect(wasi.descriptors.close(grownFd)).toBe(true);
    });
  } finally {
    wasi.descriptors.dispose();
  }
});
