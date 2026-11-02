import { afterEach, expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { withStrictDecoder } from "./fixtures/buffer-boundaries.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

const cleanup: Wasi[] = [];
const encoder = new TextEncoder();

afterEach(() => {
  for (const wasi of cleanup.splice(0).reverse()) wasi.descriptors.dispose();
});

function fixture(seed: (fs: MemFS) => void = () => {}) {
  const fs = new MemFS();
  seed(fs);
  const memory = new WebAssembly.Memory({ initial: 4 });
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
  cleanup.push(wasi);
  const module = guestModule("wasi_snapshot_preview1", [
    {
      name: "path_open",
      parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
    },
    { name: "path_symlink", parameters: ["i32", "i32", "i32", "i32", "i32"] },
  ]);
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const call = (name: string, ...args: (number | bigint)[]) =>
    guestFunction(instance, name)(...args);
  const put = (value: string, at = 2048) => {
    const bytes = encoder.encode(value);
    new Uint8Array(memory.buffer).set(bytes, at);
    return bytes.length;
  };
  return { fs, memory, wasi, call, put };
}

test("WAF-001 CREATE rejects an invalid result span before filesystem effects", () => {
  for (const output of [262141, 262144, -1, -2147483648]) {
    const f = fixture();
    const bytes = new Uint8Array(f.memory.buffer);
    bytes.fill(0xa5);
    const pathLength = f.put("created.txt");
    const before = bytes.slice();
    const descriptors = f.wasi.descriptors.inheritable();
    const result = f.call("path_open", 3, 0, 2048, pathLength, 1, 66n, 0n, 0, output);
    expect(result).toBe(21);
    expect(f.fs.lookup("/created.txt")).toBeUndefined();
    expect(f.wasi.descriptors.inheritable()).toEqual(descriptors);
    expect(new Uint8Array(f.memory.buffer)).toEqual(before);
  }
});

test("WAF-001 TRUNC rejects an invalid result span before resizing or allocation", () => {
  const f = fixture((fs) => fs.writeFile("/existing.txt", "keep"));
  const pathLength = f.put("existing.txt");
  const bytes = new Uint8Array(f.memory.buffer);
  const before = bytes.slice();
  const descriptors = f.wasi.descriptors.inheritable();
  expect(f.call("path_open", 3, 0, 2048, pathLength, 8, 66n, 0n, 0, bytes.length - 3)).toBe(21);
  expect(new TextDecoder().decode(f.fs.readFile("/existing.txt"))).toBe("keep");
  expect(f.wasi.descriptors.inheritable()).toEqual(descriptors);
  expect(new Uint8Array(f.memory.buffer)).toEqual(before);
});

test("WAF-001 ordinary open rejects an invalid result span without a descriptor leak", () => {
  const f = fixture((fs) => fs.writeFile("/existing.txt", "keep"));
  const pathLength = f.put("existing.txt");
  const descriptors = f.wasi.descriptors.inheritable();
  expect(f.call("path_open", 3, 0, 2048, pathLength, 0, 2n, 0n, 0, -1)).toBe(21);
  expect(f.wasi.descriptors.inheritable()).toEqual(descriptors);
});

test("WAF-001 invalid pathname spans are not clipped into a created path", () => {
  const f = fixture();
  const end = f.memory.buffer.byteLength;
  new Uint8Array(f.memory.buffer)[end - 1] = "n".charCodeAt(0);
  expect(f.call("path_open", 3, 0, end - 1, 2, 1, 66n, 0n, 0, 128)).toBe(21);
  expect(f.fs.lookup("/n")).toBeUndefined();
});

test("WAF-001 invalid symlink targets return EFAULT without creating a link", () => {
  const f = fixture();
  const pathLength = f.put("bad-link");
  const end = f.memory.buffer.byteLength;
  new Uint8Array(f.memory.buffer)[end - 1] = "t".charCodeAt(0);
  expect(f.call("path_symlink", end - 1, 2, 3, 2048, pathLength)).toBe(21);
  expect(f.fs.lookup("/bad-link", false)).toBeUndefined();
});

test("WAF-001 valid edge-aligned spans work after memory growth", () => {
  const f = fixture();
  f.memory.grow(1);
  const end = f.memory.buffer.byteLength;
  const bytes = new Uint8Array(f.memory.buffer);
  const path = end - 8;
  const output = end - 4;
  bytes.set(encoder.encode("edge"), path);
  expect(f.call("path_open", 3, 0, path, 4, 1, 66n, 0n, 0, output)).toBe(0);
  expect(new DataView(f.memory.buffer).getUint32(output, true)).toBeGreaterThanOrEqual(4);
  expect(f.fs.lookup("/edge")?.kind).toBe("file");
});

test("WAF-001 range-valid empty paths keep the filesystem errno", () => {
  const f = fixture();
  const end = f.memory.buffer.byteLength;
  expect(f.call("path_open", 3, 0, end, 0, 0, 2n, 0n, 0, 128)).toBe(44);
  expect(f.call("path_open", 3, 0, end + 1, 0, 0, 2n, 0n, 0, 128)).toBe(21);
});

function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return bytes;
}

function text(value: string): number[] {
  const bytes = Array.from(encoder.encode(value));
  return leb(bytes.length).concat(bytes);
}

function section(id: number, payload: number[]): number[] {
  return [id].concat(leb(payload.length), payload);
}

function sharedPathOpenModule(): WebAssembly.Module {
  const parameters = [0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f];
  const type = [0x60].concat([parameters.length], parameters, [1, 0x7f]);
  const body = [0].concat(
    Array.from({ length: parameters.length }, (_unused, index) => [0x20].concat(leb(index))).flat(),
    [0x10, 0, 0x0b],
  );
  return new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1].concat(type)),
        section(2, [1].concat(text("wasi_snapshot_preview1"), text("path_open"), [0, 0])),
        section(3, [1, 0]),
        section(7, [1].concat(text("path_open"), [0, 1])),
        section(10, [1].concat(leb(body.length), body)),
      ),
    ),
  );
}

test("WAF-001 shared memory path decoding keeps a fixed backing snapshot", () => {
  const fs = new MemFS();
  fs.writeFile("/shared.txt", "shared");
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 8, shared: true });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  cleanup.push(wasi);
  wasi.bindMemory(memory);
  memory.grow(1);
  const module = sharedPathOpenModule();
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  const path = encoder.encode("shared.txt");
  new Uint8Array(memory.buffer).set(path, 256);
  withStrictDecoder((backings) => {
    expect(guestFunction(instance, "path_open")(3, 0, 256, path.length, 0, 2n, 0n, 0, 128)).toBe(0);
    expect(backings.length).toBeGreaterThan(0);
    expect(
      backings.every(
        (backing) => !Reflect.get(backing, "resizable") && !Reflect.get(backing, "growable"),
      ),
    ).toBe(true);
  });
});
