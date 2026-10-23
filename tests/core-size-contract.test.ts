import { expect, test } from "bun:test";
import { DescriptorTable, type Resource, type Stream } from "../core/descriptors.js";
import { FilesystemError } from "../core/filesystem.js";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

const allRights = (1n << 29n) - 1n;
const encoder = new TextEncoder();
const module = guestModule("wasi_snapshot_preview1", [
  { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
  { name: "fd_write", parameters: ["i32", "i32", "i32", "i32"] },
  { name: "fd_pread", parameters: ["i32", "i32", "i32", "i64", "i32"] },
  { name: "fd_pwrite", parameters: ["i32", "i32", "i32", "i64", "i32"] },
  { name: "fd_sync", parameters: ["i32"] },
  { name: "fd_datasync", parameters: ["i32"] },
  { name: "fd_fdstat_set_rights", parameters: ["i32", "i64", "i64"] },
  {
    name: "path_open",
    parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
  },
]);

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const fs = new MemFS();
  fs.writeFile("/data", encoder.encode("abcdef"));
  const traces: string[] = [];
  const diagnostics: string[] = [];
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
    trace: (line) => traces.push(line),
    diagnostic: (bytes) => diagnostics.push(new TextDecoder().decode(bytes)),
  });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const call = (name: string, ...args: (number | bigint)[]) =>
    guestFunction(instance, name)(...args);
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  bytes().set(encoder.encode("data"), 1024);
  expect(call("path_open", 3, 0, 1024, 4, 0, allRights, 0n, 0, 128)).toBe(0);
  const fd = view().getUint32(128, true);
  const file = wasi.descriptors.get(fd)?.resource;
  if (file?.kind !== "file") throw new Error("missing fixture file");
  view().setUint32(256, 4096, true);
  view().setUint32(260, 2, true);
  const transfer = (name: string, target = fd, offset = 0n, out = 128, iovs = 256, count = 1) =>
    name === "fd_pread" || name === "fd_pwrite"
      ? call(name, target, iovs, count, offset, out)
      : call(name, target, iovs, count, out);
  traces.length = 0;
  return { fs, wasi, fd, file, call, view, bytes, transfer, traces, diagnostics };
}

type Fixture = ReturnType<typeof fixture>;
function using(run: (f: Fixture) => void): void {
  const f = fixture();
  try {
    run(f);
  } finally {
    f.wasi.descriptors.dispose();
  }
}

const transfers = ["fd_read", "fd_write", "fd_pread", "fd_pwrite"];
for (const name of transfers) {
  test(`${name} preserves missing-fd, rights and directory errno precedence`, () => {
    using((f) => {
      expect(f.transfer(name, 999, -1n, -1, -1)).toBe(8);
      const descriptor = f.wasi.descriptors.get(f.fd)!;
      descriptor.rightsBase = 0n;
      expect(f.transfer(name, f.fd, -1n, -1, -1)).toBe(76);
      const directory = f.wasi.descriptors.get(3)!;
      directory.rightsBase = 0n;
      expect(f.transfer(name, 3, -1n, -1, -1)).toBe(76);
      directory.rightsBase = allRights;
      expect(f.transfer(name, 3, -1n, -1, -1)).toBe(31);
      expect(f.traces).toHaveLength(4);
      expect(f.diagnostics).toEqual([]);
    });
  });
}

test("positioned transfers require seek rights and reject streams before negative offsets", () => {
  using((f) => {
    const descriptor = f.wasi.descriptors.get(f.fd)!;
    descriptor.rightsBase = allRights & ~4n;
    for (const name of ["fd_pread", "fd_pwrite"]) {
      expect(f.transfer(name, f.fd, -1n, -1, -1)).toBe(76);
      expect(f.transfer(name, 0, -1n, -1, -1)).toBe(76);
    }
    f.wasi.descriptors.get(0)!.rightsBase = allRights;
    for (const name of ["fd_pread", "fd_pwrite"]) expect(f.transfer(name, 0, -1n, -1, -1)).toBe(70);
    descriptor.rightsBase = allRights;
    expect(f.transfer("fd_pread", f.fd, -1n, -1, -1)).toBe(28);
    expect(f.transfer("fd_pwrite", f.fd, -1n, -1, -1)).toBe(28);
  });
});

test("positioned reads and writes leave the offset and append selection independent", () => {
  using((f) => {
    f.file.offset = 3;
    f.file.append = true;
    expect(f.transfer("fd_pread", f.fd, 1n)).toBe(0);
    expect(f.view().getUint32(128, true)).toBe(2);
    expect(new TextDecoder().decode(f.bytes().slice(4096, 4098))).toBe("bc");
    expect(f.file.offset).toBe(3);
    f.bytes().set(encoder.encode("XY"), 4096);
    expect(f.transfer("fd_pwrite", f.fd, 1n)).toBe(0);
    expect(f.file.offset).toBe(3);
    expect(f.transfer("fd_write")).toBe(0);
    expect(f.file.offset).toBe(8);
    expect(new TextDecoder().decode(f.fs.readFile("/data"))).toBe("aXYdefXY");
    f.file.offset = 3;
    expect(f.transfer("fd_read")).toBe(0);
    expect(f.file.offset).toBe(5);
    expect(new TextDecoder().decode(f.bytes().slice(4096, 4098))).toBe("de");
  });
});

test("zero-count file writes skip invalid iovecs but still write the result count", () => {
  using((f) => {
    for (const name of ["fd_write", "fd_pwrite"]) {
      f.view().setUint32(128, 0xabcdef, true);
      expect(f.transfer(name, f.fd, 0n, 128, -1, 0)).toBe(0);
      expect(f.view().getUint32(128, true)).toBe(0);
      expect(f.transfer(name, f.fd, 0n, 128, -1, 1)).toBe(29);
    }
    expect(f.file.offset).toBe(0);
    expect(new TextDecoder().decode(f.fs.readFile("/data"))).toBe("abcdef");
  });
});

function stream(read: Stream["read"], write: Stream["write"]): Stream {
  return {
    kind: "pipe",
    read,
    write,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
}
function openStream(f: Fixture, resource: Resource): number {
  return f.wasi.descriptors.open(resource, allRights, 0n);
}

test("sequential stream counts and errors preserve output and preview1 dispatch", () => {
  using((f) => {
    const fd = openStream(
      f,
      stream(
        (chunks) => {
          expect(chunks).toHaveLength(1);
          expect(chunks[0]?.length).toBe(2);
          chunks[0]?.set([65]);
          return 1;
        },
        () => -6,
      ),
    );
    expect(f.transfer("fd_read", fd)).toBe(0);
    expect(f.view().getUint32(128, true)).toBe(1);
    expect(f.bytes()[4096]).toBe(65);
    f.view().setUint32(128, 0xabcdef, true);
    expect(f.transfer("fd_write", fd)).toBe(6);
    expect(f.view().getUint32(128, true)).toBe(0xabcdef);
    expect(f.traces).toHaveLength(2);
    expect(f.diagnostics).toEqual([]);
  });
});

test("transfer exceptions keep filesystem errno and unknown diagnostic tracing distinct", () => {
  using((f) => {
    const fd = openStream(
      f,
      stream(
        () => {
          throw new FilesystemError(2);
        },
        () => {
          throw new Error("fixture write");
        },
      ),
    );
    expect(f.transfer("fd_read", fd)).toBe(2);
    expect(f.transfer("fd_write", fd)).toBe(29);
    expect(f.traces).toEqual([]);
    expect(f.diagnostics).toHaveLength(1);
    expect(f.diagnostics[0]).toContain("fd_write failed: Error: fixture write");
  });
});

test("ordinary output faults still occur after I/O, unlike reopen validation", () => {
  using((f) => {
    f.bytes().set(encoder.encode("XY"), 4096);
    expect(f.transfer("fd_write", f.fd, 0n, f.bytes().length - 1)).toBe(29);
    expect(f.file.offset).toBe(2);
    expect(new TextDecoder().decode(f.fs.readFile("/data"))).toBe("XYcdef");
    expect(f.traces).toEqual([]);
    expect(f.diagnostics).toHaveLength(1);
  });
});

for (const fixed of [false, true]) {
  test(`${fixed ? "openAt" : "open"} shares default stream release only until the last close`, () => {
    const table = new DescriptorTable();
    let released = 0;
    const resource = stream(
      () => 0,
      () => 0,
    );
    resource.close = () => released++;
    const fd = fixed ? table.openAt(9, resource, 7n, 3n) : table.open(resource, 7n, 3n);
    try {
      const duplicate = table.dup(fd);
      expect(table.get(fd)?.resource).toBe(resource);
      expect(table.get(duplicate)?.description).toBe(table.get(fd)?.description);
      expect(table.close(fd)).toBe(true);
      expect(released).toBe(0);
      resource.close = () => {
        released += 10;
      };
      expect(table.close(duplicate)).toBe(true);
      expect(released).toBe(10);
    } finally {
      table.dispose();
    }
  });

  test(`${fixed ? "openAt" : "open"} preserves explicit release, binding rights and preopen`, () => {
    const table = new DescriptorTable();
    let released = 0;
    const resource = stream(
      () => 0,
      () => 0,
    );
    resource.close = () => {
      throw new Error("explicit release must win");
    };
    const release = () => released++;
    const fd = fixed
      ? table.openAt(9, resource, 7n, 3n, release, "/fixture")
      : table.open(resource, 7n, 3n, release, "/fixture");
    try {
      expect(fd).toBe(fixed ? 9 : 0);
      expect(table.get(fd)).toMatchObject({
        rightsBase: 7n,
        rightsInheriting: 3n,
        preopen: "/fixture",
      });
      expect(table.close(fd)).toBe(true);
      expect(released).toBe(1);
    } finally {
      table.dispose();
    }
  });
}
