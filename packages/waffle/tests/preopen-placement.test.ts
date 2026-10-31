import { expect, test } from "bun:test";
import { Wasi, type WasiOptions } from "../core/wasi.ts";
import { DescriptorTable, OpenDescription } from "../core/descriptors.ts";
import { MemFS } from "../fs/memory.ts";
import {
  createWorkerProcessTransport,
  installWorkerBindings,
  type WorkerDescriptorCodec,
} from "../proc/worker-client.ts";

const all = (1n << 29n) - 1n;
function options(fs = new MemFS()): WasiOptions {
  return { args: [], env: {}, fs, preopens: { "/": "/" }, stdout() {}, stderr() {}, sleep() {} };
}
function memory(wasi: Wasi) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.start({ exports: { memory, _start() {} } } as unknown as WebAssembly.Instance);
  // Link declared imports through the same public seam as a real guest. Each tiny
  // module declares one function; tests invoke the resulting JS wrapper directly.
  const text = (value: string) => {
    const bytes = Array.from(new TextEncoder().encode(value));
    return [bytes.length].concat(bytes);
  };
  const calls = Object.fromEntries(
    ["path_open", "fd_prestat_get", "fd_prestat_dir_name", "fd_read", "fd_close", "fd_write"].map(
      (name) => {
        const payload = [1].concat(text("wasi_snapshot_preview1"), text(name), [0, 0]);
        const module = new WebAssembly.Module(
          Uint8Array.from(
            [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, payload.length].concat(payload),
          ),
        );
        return [name, wasi.imports(module).wasi_snapshot_preview1![name]];
      },
    ),
  ) as Record<string, (...args: (number | bigint)[]) => number>;
  return { bytes: new Uint8Array(memory.buffer), view: new DataView(memory.buffer), calls };
}

for (const reserved of [
  [3, 3],
  [3, -1],
  [3, 1.5],
  [3, NaN],
  [3, Infinity],
  [3, 0x80000000],
]) {
  test(`reserved target validation is atomic: ${reserved}`, () => {
    const fs = new MemFS();
    let touched = 0;
    fs.preopen = () => {
      touched++;
      return 0;
    };
    fs.retain = () => {
      touched++;
    };
    expect(() => new Wasi({ ...options(fs), reservedFds: reserved })).toThrow(RangeError);
    expect(touched).toBe(0);
  });
}

for (const target of [3, -1, 1.5, NaN, Infinity, 0x80000000])
  test(`worker validates every target before importing or replacing: ${target}`, () => {
    const transport = createWorkerProcessTransport();
    transport.resources.push({});
    transport.bindings.push(
      { fd: 3, reference: 0, rightsBase: all, rightsInheriting: all },
      { fd: target, reference: 0, rightsBase: all, rightsInheriting: all },
    );
    const table = new DescriptorTable();
    let imported = 0,
      released = 0;
    table.openAt(
      3,
      { kind: "directory", handle: 1 },
      all,
      all,
      () => {
        released++;
      },
      "/",
    );
    const root = table.get(3);
    const codec: WorkerDescriptorCodec = {
      export() {
        throw new Error("unused");
      },
      discard() {},
      import() {
        imported++;
        return new OpenDescription({ kind: "directory", handle: 2 });
      },
    };
    try {
      expect(() => installWorkerBindings(transport, table, codec)).toThrow(
        "invalid descriptor binding",
      );
      expect(table.get(3)).toBe(root);
      expect(imported).toBe(0);
      expect(released).toBe(0);
    } finally {
      table.dispose();
    }
    expect(released).toBe(1);
  });

test("inherited descriptors are a numeric snapshot without preopens", () => {
  const wasi = new Wasi({
    ...options(),
    stdio: { 0: null, 1: null, 2: null },
    reservedFds: [3, 7],
  });
  const stream = {
    kind: "pipe" as const,
    read: () => 0,
    write: () => 0,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
  wasi.descriptors.openAt(7, stream, all, all);
  const snapshot = wasi.descriptors.inheritable();
  expect(snapshot).toEqual([7]);
  wasi.descriptors.close(7);
  wasi.descriptors.openAt(2, stream, all, all);
  expect(snapshot).toEqual([7]);
  expect(wasi.descriptors.inheritable()).toEqual([2]);
  wasi.descriptors.dispose();
});

test("closed stdio does not acquire callback terminals", () => {
  const wasi = new Wasi({ ...options(), stdio: { 0: null, 1: null, 2: null } });
  expect([0, 1, 2].map((fd) => wasi.descriptors.get(fd))).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  expect(wasi.descriptors.get(3)?.preopen).toBe("/");
  wasi.descriptors.dispose();
});

test("moved preopens preserve names, rights and lifetime while inherited files share offsets", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "abcd");
  let retained = 0,
    released = 0;
  fs.retain = () => {
    retained++;
  };
  fs.release = () => {
    released++;
  };
  const parent = new Wasi(options(fs));
  const child = new Wasi({ ...options(fs), reservedFds: [3] });
  const p = memory(parent),
    c = memory(child);
  try {
    p.bytes.set(new TextEncoder().encode("file"), 256);
    expect(p.calls.path_open!(3, 0, 256, 4, 0, all, all, 0, 1024)).toBe(0);
    const parentFd = p.view.getUint32(1024, true);
    child.descriptors.inherit(3, parent.descriptors.get(parentFd)!);
    expect(child.descriptors.get(3)?.preopen).toBeUndefined();
    child.descriptors.get(3)!.rightsBase = 1n << 1n; // FD_READ only.
    expect(parent.descriptors.get(parentFd)?.rightsBase).toBe(all);
    expect(c.calls.fd_prestat_get!(3, 0)).toBe(8);
    expect(c.calls.fd_prestat_get!(4, 0)).toBe(0);
    expect(c.view.getUint32(4, true)).toBe(1);
    expect(c.calls.fd_prestat_dir_name!(4, 128, 1)).toBe(0);
    expect(c.bytes[128]).toBe(47);
    expect(child.descriptors.get(4)?.rightsBase).toBe(all);
    expect(child.descriptors.get(4)?.rightsInheriting).toBe(all);
    for (const m of [p, c]) {
      m.view.setUint32(0, 512, true);
      m.view.setUint32(4, 1, true);
    }
    expect(p.calls.fd_read!(parentFd, 0, 1, 1024)).toBe(0);
    expect(p.bytes[512]).toBe(97);
    expect(c.calls.fd_read!(3, 0, 1, 1024)).toBe(0);
    expect(c.bytes[512]).toBe(98);
    expect(parent.descriptors.get(parentFd)!.resource).toBe(child.descriptors.get(3)!.resource);
    expect(p.calls.fd_close!(parentFd)).toBe(0);
    expect(released).toBe(0); // Neither shared file nor moved root was released.
    expect(c.calls.fd_read!(3, 0, 1, 1024)).toBe(0);
    expect(c.bytes[512]).toBe(99);
    expect(c.calls.fd_write!(3, 0, 1, 1024)).toBe(76); // NOTCAPABLE.
    expect(retained - released).toBe(3); // Two roots, one file description.
    child.descriptors.dispose();
    expect(released).toBe(2);
    expect(parent.descriptors.get(3)?.preopen).toBe("/");
  } finally {
    child.descriptors.dispose();
    parent.descriptors.dispose();
  }
  expect(retained).toBe(released);
});
