import { expect, test } from "bun:test";
import { MemFS } from "../fs/memory.js";
import { Wasi } from "../core/wasi.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

test("cooperative resolution validates original components before confirming a logical alias", () => {
  const fs = new MemFS();
  const root = fs.preopen("/");
  fs.retain(root);
  fs.mkdirp("/work");
  const lookup = (path: string, expectedAlias: number | null = null) => {
    const lease = fs.resolveCooperative(root, path, true, { expectedAlias, machineId: true });
    if (typeof lease === "number") return lease;
    try {
      return lease.result;
    } finally {
      lease.release();
    }
  };
  expect(lookup("dev//./fd/4", 4)).toEqual({ kind: "alias", logical: 4 });
  expect(lookup("dev/fd/4294967295", 0xffffffff)).toEqual({ kind: "alias", logical: 0xffffffff });
  expect(lookup("dev/fd/4294967296")).toBe(44);
  expect(lookup("dev/fd/4", 3)).toBe(76);
  expect(lookup("dev/fd/4/")).toBe(54);
  expect(lookup("work/../dev/fd/4")).toBe(76);
  expect(lookup("missing/../dev/fd/4")).toBe(44);
  expect(lookup("dev/null")).toEqual({ kind: "null" });
  expect(lookup("etc/machine-id")).toEqual({ kind: "machine-id" });
  expect(lookup("dev")).toMatchObject({
    kind: "inode",
    parent: root,
    name: "dev",
    node: undefined,
  });
  expect(lookup("dev/ordinary")).toBe(44);
});

function openGuest(fs: MemFS) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    fs,
    preopens: { "/": "/" },
    args: [],
    env: {},
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const module = guestModule("runtime_fs", [
    {
      name: "path_open_cooperative",
      parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i64", "i32"],
    },
  ]);
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const call = guestFunction(instance, "path_open_cooperative");
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const open = (path: string, expected = -1n, flags = 0, output = 512) => {
    const encoded = new TextEncoder().encode(path);
    bytes.set(encoded, 256);
    return call(3, 1, 256, encoded.length, flags, 2n, 0n, 0, expected, output);
  };
  return { wasi, memory, view, open };
}

test("an unresolved reserved-directory link does not hide ordinary numeric files", () => {
  const fs = new MemFS();
  fs.mkdirp("/dev");
  fs.writeFile("/reports/2026", "ordinary");
  const link = fs.resolveAbsolute("/dev/fd");
  if (typeof link === "number") throw new Error("missing fixture parent");
  expect(fs.symlink(link, "/proc/self/fd")).toBe(0);
  const { wasi, open, view } = openGuest(fs);
  try {
    expect(open("reports/2026")).toBe(0);
    expect(view.getUint32(512, true)).toBe(0);
    expect(open("dev/fd/4", 4n)).toBe(76);
  } finally {
    wasi.descriptors.dispose();
  }
});

test("the guarded WASI import confirms direct aliases without touching unrelated descriptor slots", () => {
  const fs = new MemFS();
  fs.writeFile("/ordinary", "hello");
  const { wasi, memory, view, open } = openGuest(fs);
  const lookedUp: number[] = [];
  const get = wasi.descriptors.get.bind(wasi.descriptors);
  wasi.descriptors.get = (fd) => {
    lookedUp.push(fd);
    return get(fd);
  };
  try {
    expect(open("dev/fd/19", 19n)).toBe(0);
    expect(view.getUint32(512, true)).toBe(1);
    expect(view.getUint32(516, true)).toBe(19);
    expect(lookedUp).toEqual([3]);
    expect(open("ordinary", 19n, 8)).toBe(76);
    expect(new TextDecoder().decode(fs.readFile("/ordinary"))).toBe("hello");
    expect(open("new", -1n, 1, memory.buffer.byteLength - 4)).toBe(21);
    expect(fs.lookup("/new")).toBeUndefined();
    expect(open("new", 19n, 1)).toBe(28);
    expect(fs.lookup("/new")).toBeUndefined();
    expect(open("dev", -1n, 1)).toBe(0);
    expect(view.getUint32(512, true)).toBe(0);
    expect(fs.lookup("/dev")?.kind).toBe("file");
  } finally {
    wasi.descriptors.dispose();
  }
});

test("the guarded import fails closed without an explicit tagged resolver", () => {
  const fs = new MemFS();
  Object.defineProperty(fs, "resolveCooperative", { value: undefined });
  const { wasi, open, view } = openGuest(fs);
  view.setUint32(512, 0xdeadbeef, true);
  try {
    expect(open("new", -1n, 1)).toBe(58);
    expect(view.getUint32(512, true)).toBe(0xdeadbeef);
    expect(fs.lookup("/new")).toBeUndefined();
  } finally {
    wasi.descriptors.dispose();
  }
});
