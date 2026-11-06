import { expect, test } from "bun:test";
import { RIGHTS_ALL } from "../core/rights.js";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

const EFBIG = 22;
const module = guestModule("wasi_snapshot_preview1", [
  { name: "fd_filestat_set_size", parameters: ["i32", "i64"] },
  { name: "fd_allocate", parameters: ["i32", "i64", "i64"] },
  { name: "fd_fdstat_set_rights", parameters: ["i32", "i64", "i64"] },
  { name: "fd_tell", parameters: ["i32", "i32"] },
  {
    name: "path_open",
    parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
  },
]);

function fixture() {
  const fs = new MemFS();
  fs.writeFile("/data", "abcdef");
  const memory = new WebAssembly.Memory({ initial: 4 });
  const diagnostics: string[] = [];
  const calls: { size: number; truncate: boolean }[] = [];
  const resize = fs.resize.bind(fs);
  let response: number | undefined;
  fs.resize = (handle, size, truncate) => {
    calls.push({ size, truncate });
    if (response !== undefined) return response;
    if (Math.abs(size) > 64) throw new Error("fixture refuses large real resize");
    return resize(handle, size, truncate);
  };
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
    diagnostic: (bytes) => diagnostics.push(new TextDecoder().decode(bytes)),
  });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const call = (name: string, ...args: (number | bigint)[]) =>
    guestFunction(instance, name)(...args);
  new Uint8Array(memory.buffer).set(new TextEncoder().encode("data"), 1024);
  expect(call("path_open", 3, 0, 1024, 4, 0, RIGHTS_ALL, 0n, 0, 128)).toBe(0);
  const fd = new DataView(memory.buffer).getUint32(128, true);
  const file = wasi.descriptors.get(fd)?.resource;
  if (file?.kind !== "file") throw new Error("missing fixture file");
  file.offset = 3;
  fs.setMtime(file.handle, 1234);
  const snapshot = () => ({
    text: new TextDecoder().decode(fs.readFile("/data")),
    stat: fs.stat(file.handle),
    offset: file.offset,
    fds: wasi.descriptors.inheritable(),
    diagnostics: diagnostics.slice(),
  });
  const recordResize = (errno = 0) => {
    response = errno;
  };
  return { fs, wasi, memory, fd, call, calls, snapshot, recordResize };
}

type Fixture = ReturnType<typeof fixture>;

function withFixture(run: (f: Fixture) => void): void {
  const f = fixture();
  try {
    run(f);
  } finally {
    f.wasi.descriptors.dispose();
  }
}

test("all-one WASI size cannot truncate an authorized file from the end", () => {
  withFixture((f) => {
    const before = f.snapshot();
    const errno = f.call("fd_filestat_set_size", f.fd, -1n);
    expect({ errno, after: f.snapshot(), calls: f.calls }).toEqual({
      errno: EFBIG,
      after: before,
      calls: [],
    });
  });
});

test("unsigned allocation operands cannot cancel to zero", () => {
  withFixture((f) => {
    const before = f.snapshot();
    const errno = f.call("fd_allocate", f.fd, 1n, -1n);
    expect({ errno, after: f.snapshot(), calls: f.calls }).toEqual({
      errno: EFBIG,
      after: before,
      calls: [],
    });
  });
});

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

function expectRejected(f: Fixture, name: string, args: readonly bigint[]): void {
  const before = f.snapshot();
  const errno = f.call(name, f.fd, ...args);
  expect({ errno, after: f.snapshot(), calls: f.calls }).toEqual({
    errno: EFBIG,
    after: before,
    calls: [],
  });
}

for (const size of [maxSafe + 1n, maxSafe + 2n, (1n << 63n) - 1n, -(1n << 63n)]) {
  test(`truncate rejects unsupported unsigned size ${size} before resize`, () => {
    withFixture((f) => {
      f.recordResize();
      expectRejected(f, "fd_filestat_set_size", [size]);
    });
  });
}

const invalidAllocations: readonly (readonly [bigint, bigint])[] = [
  [-1n, 1n],
  [-1n, -1n],
  [-1n, 9n],
  [maxSafe + 1n, 0n],
  [0n, maxSafe + 1n],
  [maxSafe + 2n, 0n],
  [0n, maxSafe + 2n],
  [maxSafe, 1n],
  [maxSafe, 2n],
  [maxSafe, maxSafe],
];
for (const [offset, length] of invalidAllocations) {
  test(`allocation rejects unsupported operands or endpoint ${offset}, ${length}`, () => {
    withFixture((f) => {
      f.recordResize();
      expectRejected(f, "fd_allocate", [offset, length]);
    });
  });
}

for (const name of ["fd_filestat_set_size", "fd_allocate"]) {
  test(`${name} checks descriptor, rights and kind before unsupported size`, () => {
    withFixture((f) => {
      const args = name === "fd_allocate" ? [1n, -1n] : [-1n];
      expect(f.call(name, 999, ...args)).toBe(8);
      for (const fd of [f.fd, 3, 0]) checkDescriptorPrecedence(f, name, fd, args);
      expect(f.calls).toEqual([]);
      expect(f.snapshot().diagnostics).toEqual([]);
    });
  });
}

function checkDescriptorPrecedence(
  f: Fixture,
  name: string,
  fd: number,
  args: readonly bigint[],
): void {
  const entry = f.wasi.descriptors.get(fd);
  if (!entry) throw new Error("missing fixture descriptor");
  entry.rightsBase = RIGHTS_ALL;
  const before = f.snapshot();
  if (fd !== f.fd) expect(f.call(name, fd, ...args)).toBe(28);
  expect(f.call("fd_fdstat_set_rights", fd, 0n, 0n)).toBe(0);
  expect(f.call(name, fd, ...args)).toBe(76);
  expect(f.snapshot()).toEqual(before);
}

test("truncate shrinks, grows with zeroes and accepts zero", () => {
  withFixture((f) => {
    expect(f.call("fd_filestat_set_size", f.fd, 3n)).toBe(0);
    expect(f.snapshot().text).toBe("abc");
    expect(f.call("fd_filestat_set_size", f.fd, 8n)).toBe(0);
    expect(f.snapshot().text).toBe("abc\0\0\0\0\0");
    expect(f.call("fd_filestat_set_size", f.fd, 0n)).toBe(0);
    expect(f.snapshot().text).toBe("");
    expect(f.snapshot().offset).toBe(3);
    expect(f.snapshot().diagnostics).toEqual([]);
  });
});

test("allocation below EOF and zero allocation never shrink or move the offset", () => {
  withFixture((f) => {
    const before = f.snapshot();
    expect(f.call("fd_allocate", f.fd, 1n, 1n)).toBe(0);
    expect(f.call("fd_allocate", f.fd, 0n, 0n)).toBe(0);
    expect(f.snapshot()).toEqual(before);
    expect(f.call("fd_allocate", f.fd, 6n, 2n)).toBe(0);
    expect(f.snapshot().text).toBe("abcdef\0\0");
    expect(f.call("fd_tell", f.fd, 256)).toBe(0);
    expect(new DataView(f.memory.buffer).getBigUint64(256, true)).toBe(3n);
  });
});

test("maximum safe sizes reach the backend exactly and preserve its errno", () => {
  withFixture((f) => {
    f.recordResize(2);
    const before = f.snapshot();
    expect(f.call("fd_filestat_set_size", f.fd, maxSafe)).toBe(2);
    expect(f.call("fd_allocate", f.fd, maxSafe - 1n, 1n)).toBe(2);
    expect(f.call("fd_allocate", f.fd, maxSafe, 0n)).toBe(2);
    expect(f.call("fd_allocate", f.fd, 0n, maxSafe)).toBe(2);
    expect(f.calls).toEqual([
      { size: Number.MAX_SAFE_INTEGER, truncate: true },
      { size: Number.MAX_SAFE_INTEGER, truncate: false },
      { size: Number.MAX_SAFE_INTEGER, truncate: false },
      { size: Number.MAX_SAFE_INTEGER, truncate: false },
    ]);
    expect(f.snapshot()).toEqual(before);
  });
});

test("admitted sizes still respect backend inode permissions", () => {
  withFixture((f) => {
    const node = f.fs.lookup("/data");
    if (!node) throw new Error("missing fixture inode");
    node.mode = 0o400;
    const before = f.snapshot();
    expect(f.call("fd_filestat_set_size", f.fd, 1n)).toBe(2);
    expect(f.call("fd_allocate", f.fd, 1n, 9n)).toBe(2);
    expect(f.snapshot()).toEqual(before);
  });
});
