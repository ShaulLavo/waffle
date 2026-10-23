import { afterEach, expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

const READ = 2n, WRITE = 64n;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const owners: Wasi[] = [];
afterEach(() => {
  for (const wasi of owners.splice(0)) wasi.descriptors.dispose();
});

function fixture(preopens: Record<string, string> = { "/": "/" }) {
  const fs = new MemFS();
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [], env: {}, fs, preopens, namespaces: { env: { memory } },
    stdout() {}, stderr() {}, sleep() {},
  });
  owners.push(wasi);
  const module = guestModule("wasi_snapshot_preview1", [
    { name: "path_open", parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"] },
    { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
    { name: "fd_write", parameters: ["i32", "i32", "i32", "i32"] },
    { name: "fd_fdstat_get", parameters: ["i32", "i32"] },
  ]);
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const call = (name: string, ...args: (number | bigint)[]) => guestFunction(instance, name)(...args);
  const view = () => new DataView(memory.buffer);
  const put = (text: string, at = 2048) => {
    const bytes = encoder.encode(text);
    new Uint8Array(memory.buffer).set(bytes, at);
    return bytes.length;
  };
  const tryOpen = (path: string, base = READ, flags = 0, oflags = 0, dir = 3) =>
    call("path_open", dir, 1, 2048, put(path), oflags, base, 0n, flags, 128);
  const open = (path: string, base = READ, flags = 0, oflags = 0, dir = 3) => {
    expect(tryOpen(path, base, flags, oflags, dir)).toBe(0);
    return view().getUint32(128, true);
  };
  const io = (name: string, fd: number, length: number) => {
    view().setUint32(256, 4096, true);
    view().setUint32(260, length, true);
    expect(call(name, fd, 256, 1, 264)).toBe(0);
    return view().getUint32(264, true);
  };
  const read = (fd: number, length = 64) => {
    const count = io("fd_read", fd, length);
    return decoder.decode(new Uint8Array(memory.buffer, 4096, count));
  };
  const write = (fd: number, text: string) => expect(io("fd_write", fd, put(text, 4096))).toBe(text.length);
  return { fs, wasi, open, tryOpen, read, write, call, view };
}
type Fixture = ReturnType<typeof fixture>;
function pathAt(fs: MemFS, path: string) {
  const found = fs.resolveAbsolute(path);
  if (typeof found === "number") throw new Error(`resolve errno ${found}`);
  return found;
}
function handle(fs: MemFS, path: string) {
  const node = pathAt(fs, path).node;
  if (node === undefined) throw new Error(`missing inode ${path}`);
  return node;
}
function link(fs: MemFS, path: string, target: string) {
  expect(fs.symlink(pathAt(fs, path), target)).toBe(0);
}
function resource(f: Fixture, fd: number) {
  const entry = f.wasi.descriptors.get(fd);
  if (entry?.resource.kind !== "file") throw new Error(`not a file ${fd}`);
  return entry.resource;
}
function seed(f: Fixture) {
  f.fs.writeFile("/file", "abcdef");
  f.fs.mkdirp("/directory");
  link(f.fs, "/link", "directory");
  return f.open("file", READ | WRITE);
}
function chain(fs: MemFS, prefix: string, count: number, target = "directory") {
  for (let i = 0; i < count; i++) link(fs, `/${prefix}${i}`, i + 1 === count ? target : `${prefix}${i + 1}`);
}

test("alias follows an intermediate directory link instead of returning errno 54", () => {
  const f = fixture(), fd = seed(f);
  expect(f.tryOpen(`directory/../dev/fd/${fd}`)).toBe(0);
  expect(f.tryOpen(`link/../dev/fd/${fd}`)).toBe(0);
});

test("link dotdot uses the expanded actual parent, not the lexical link parent", () => {
  const f = fixture(), fd = seed(f);
  f.fs.mkdirp("/a/b");
  f.fs.writeFile(`/a/dev/fd/${fd}`, "actual-parent");
  link(f.fs, "/deep", "a/b");
  const actual = f.open(`deep/../dev/fd/${fd}`);
  expect(f.read(actual)).toBe("actual-parent");
  expect(resource(f, actual).handle).toBe(handle(f.fs, `/a/dev/fd/${fd}`));
  const alias = f.open(`deep/../../dev/fd/${fd}`);
  expect(resource(f, alias).handle).toBe(resource(f, fd).handle);
  expect(f.read(alias)).toBe("abcdef");
});

test("relative targets keep raw dot and empty components and resolve from their actual parent", () => {
  const f = fixture(), fd = seed(f);
  f.fs.mkdirp("/a/b");
  link(f.fs, "/a/up", "../a/b");
  link(f.fs, "/raw", "a//./b/../../directory");
  expect(f.tryOpen(`a/up/../../dev/fd/${fd}`)).toBe(0);
  expect(f.tryOpen(`raw/../dev/fd/${fd}`)).toBe(0);
  expect(f.fs.readlink(handle(f.fs, "/raw"))).toBe("a//./b/../../directory");
});

test.each([
  { target: "missing", errno: 44 }, { target: "file", errno: 54 },
  { target: "../directory", errno: 63 }, { target: "/directory", errno: 63 },
])("alias rejects invalid targets without reopening a descriptor", ({ target, errno }) => {
  const f = fixture(), fd = seed(f);
  link(f.fs, "/bad", target);
  const description = f.wasi.descriptors.get(fd)?.description;
  expect(f.tryOpen(`bad/../dev/fd/${fd}`)).toBe(errno);
  expect(f.wasi.descriptors.get(fd)?.description).toBe(description);
  expect(resource(f, fd).offset).toBe(0);
});

test("actual target directory search permission cannot be canceled by dotdot", () => {
  const f = fixture(), fd = seed(f);
  expect(f.fs.setMode(handle(f.fs, "/directory"), 0o600)).toBe(0);
  expect(f.tryOpen(`directory/../dev/fd/${fd}`)).toBe(2);
  expect(f.tryOpen(`link/../dev/fd/${fd}`)).toBe(2);
});

test("exactly 40 expansions succeed and a 41st fails with errno 32", () => {
  const f = fixture(), fd = seed(f);
  chain(f.fs, "chain", 41);
  expect(f.tryOpen(`chain1/../dev/fd/${fd}`)).toBe(0);
  expect(f.tryOpen(`chain0/../dev/fd/${fd}`)).toBe(32);
});

test("separate link chains and actual dotdot share one expansion budget", () => {
  const f = fixture(), fd = seed(f);
  chain(f.fs, "first", 20);
  chain(f.fs, "second", 21);
  expect(f.tryOpen(`first0/../second1/../dev/fd/${fd}`)).toBe(0);
  expect(f.tryOpen(`first0/../second0/../dev/fd/${fd}`)).toBe(32);
});

test("cycles fail within the expansion bound without namespace mutation", () => {
  const f = fixture(), fd = seed(f);
  link(f.fs, "/cycle-a", "cycle-b");
  link(f.fs, "/cycle-b", "cycle-a");
  const before = f.fs.readdir(f.fs.preopen("/"));
  expect(f.tryOpen(`cycle-a/../dev/fd/${fd}`)).toBe(32);
  expect(f.fs.readdir(f.fs.preopen("/"))).toEqual(before);
  expect(f.fs.readlink(handle(f.fs, "/cycle-a"))).toBe("cycle-b");
});

test("alias retains inode identity with independent offsets and descriptions", () => {
  const f = fixture(), fd = seed(f);
  expect(f.read(fd, 2)).toBe("ab");
  const alias = f.open(`link/../dev/fd/${fd}`);
  expect(resource(f, alias).handle).toBe(resource(f, fd).handle);
  expect(f.wasi.descriptors.get(alias)?.description).not.toBe(f.wasi.descriptors.get(fd)?.description);
  expect(f.read(alias, 3)).toBe("abc");
  expect(f.read(fd)).toBe("cdef");
  expect(f.read(alias)).toBe("def");
});

test("alias append and nonblock flags do not change source flags or offset", () => {
  const f = fixture(), fd = seed(f);
  const alias = f.open(`link/../proc/self/fd/${fd}`, WRITE, 5);
  f.write(alias, "g");
  f.write(fd, "X");
  expect(f.read(f.open("file"))).toBe("Xbcdefg");
  expect(f.call("fd_fdstat_get", alias, 512)).toBe(0);
  expect(f.view().getUint16(514, true)).toBe(5);
  expect(f.call("fd_fdstat_get", fd, 512)).toBe(0);
  expect(f.view().getUint16(514, true)).toBe(0);
  expect(resource(f, fd).offset).toBe(1);
});

test("alias truncation affects the inode but not the source offset", () => {
  const f = fixture(), fd = seed(f);
  expect(f.read(fd, 3)).toBe("abc");
  const alias = f.open(`link/../dev/fd/${fd}`, WRITE, 0, 8);
  f.write(alias, "x");
  expect(f.read(f.open("file"))).toBe("x");
  expect(resource(f, fd).offset).toBe(3);
});

test("alias follows live inode permissions and root rights without broadening authority", () => {
  const f = fixture(), fd = seed(f), path = `link/../dev/fd/${fd}`;
  expect(f.fs.setMode(resource(f, fd).handle, 0o200)).toBe(0);
  expect(f.tryOpen(path)).toBe(2);
  expect(f.fs.setMode(resource(f, fd).handle, 0o600)).toBe(0);
  expect(f.tryOpen(path)).toBe(0);
  const root = f.wasi.descriptors.get(3);
  if (!root) throw new Error("missing root");
  root.rightsInheriting &= ~WRITE;
  expect(f.tryOpen(path, WRITE)).toBe(76);
  root.rightsBase &= ~(1n << 19n);
  expect(f.tryOpen(path, READ, 0, 8)).toBe(76);
  root.rightsBase &= ~(1n << 13n);
  expect(f.tryOpen(path)).toBe(76);
});

test.each([false, true])("actual nonroot preopens confine links with another preopen present=%s", (multiple) => {
  const preopens: Record<string, string> = multiple
    ? { "/sandbox": "/sandbox", "/other": "/other" }
    : { "/sandbox": "/sandbox" };
  const f = fixture(preopens);
  f.fs.writeFile("/sandbox/file", "inside");
  f.fs.writeFile("/other/private", "outside");
  f.fs.mkdirp("/sandbox/a/b");
  link(f.fs, "/sandbox/link", "a/b");
  link(f.fs, "/sandbox/out", "../other");
  link(f.fs, "/sandbox/absolute", "/other");
  const fd = f.open("file");
  expect(f.read(f.open("link/../../file"))).toBe("inside");
  expect(f.tryOpen("out/private")).toBe(63);
  expect(f.tryOpen("absolute/private")).toBe(63);
  expect(f.tryOpen(`link/../../dev/fd/${fd}`)).toBe(44);
  f.fs.writeFile(`/sandbox/dev/fd/${fd}`, "physical");
  expect(f.read(f.open(`link/../../dev/fd/${fd}`))).toBe("physical");
  expect(f.tryOpen(`link/../../../other/private`)).toBe(63);
  if (!multiple) return;
  expect(f.read(f.open("private", READ, 0, 0, 4))).toBe("outside");
  const other = f.wasi.descriptors.get(4);
  if (!other) throw new Error("missing other preopen");
  other.rightsInheriting &= ~READ;
  expect(f.tryOpen("private", READ, 0, 0, 4)).toBe(76);
  expect(f.tryOpen("out/private")).toBe(63);
});
