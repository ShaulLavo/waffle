import { afterEach, describe, expect, test } from "bun:test";
import { FilesystemError } from "../core/filesystem.js";
import { RIGHT_PATH_FILESTAT_GET } from "../core/rights.js";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";
import { openVfsBackend, VFS_BACKEND_KINDS } from "./fixtures/vfs-backends.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

function link(fs: MemFS, path: string, target: string): void {
  const resolved = fs.resolveAbsolute(path);
  if (typeof resolved === "number") throw new FilesystemError(resolved);
  expect(fs.symlink(resolved, target)).toBe(0);
}

/** /real/dir/file.txt, /real/dir/sub/, and links that reach them relatively and absolutely. */
function tree(): { fs: MemFS; root: number } {
  const fs = new MemFS();
  fs.mkdirp("/real/dir/sub");
  fs.writeFile("/real/dir/file.txt", "x");
  fs.mkdirp("/home/user/node_modules");
  link(fs, "/home/user/node_modules/pkg", "../../../real/dir");
  link(fs, "/home/user/abs", "/real/dir");
  link(fs, "/home/user/chain", "abs/file.txt");
  link(fs, "/home/user/loop", "loop");
  link(fs, "/home/user/dangling", "missing/file");
  return { fs, root: fs.preopen("/") };
}

describe("MemFS.realpath", () => {
  test.each([
    ["home/user/node_modules/pkg/file.txt", "/real/dir/file.txt"],
    ["home/user/node_modules/pkg", "/real/dir"],
    ["home/user/abs/sub/", "/real/dir/sub"],
    ["home/user/chain", "/real/dir/file.txt"],
    // `..` after a link climbs from where the link led, as on Linux, not lexically.
    ["home/user/node_modules/pkg/../dir/./file.txt", "/real/dir/file.txt"],
    ["home/user/abs/..", "/real"],
    [".", "/"],
    ["..", "/"],
    ["real//dir/", "/real/dir"],
  ])("rooted %s is %s", (path, expected) => {
    const { fs, root } = tree();
    expect(fs.realpath(root, path, true)).toBe(expected);
  });

  test.each([
    ["home/user/missing", 44],
    ["home/user/missing/file", 44],
    ["home/user/dangling", 44],
    ["real/dir/file.txt/more", 54],
    ["real/dir/file.txt/", 54],
    ["home/user/loop", 32],
    ["/real/dir", 63],
    ["", 44],
  ])("rooted %s fails with errno %d", (path, errno) => {
    const { fs, root } = tree();
    expect(fs.realpath(root, path, true)).toBe(errno);
  });

  test("a directory without search permission is EACCES", () => {
    const { fs, root } = tree();
    const dir = fs.resolveAbsolute("/real/dir");
    if (typeof dir === "number" || dir.node === undefined) throw new Error("fixture");
    fs.setMode(dir.node, 0o600);
    expect(fs.realpath(root, "real/dir/file.txt", true)).toBe(2);
  });

  test("a rooted lookup from a nested directory answers from the root", () => {
    const { fs } = tree();
    const user = fs.preopen("/home/user");
    expect(fs.realpath(user, "node_modules/pkg/file.txt", true)).toBe("/real/dir/file.txt");
    expect(fs.realpath(user, "node_modules", true)).toBe("/home/user/node_modules");
    expect(fs.realpath(user, ".", true)).toBe("/home/user");
    // `..` above the start directory, then down again.
    expect(fs.realpath(user, "../user/node_modules/../abs", true)).toBe("/real/dir");
    expect(fs.realpath(user, "../../real/dir/file.txt", true)).toBe("/real/dir/file.txt");
    expect(fs.realpath(user, "../..", true)).toBe("/");
  });

  test("an unrooted lookup answers relative to its directory and cannot leave it", () => {
    const { fs } = tree();
    const real = fs.preopen("/real");
    expect(fs.realpath(real, "dir/sub/../file.txt")).toBe("dir/file.txt");
    expect(fs.realpath(real, ".")).toBe(".");
    expect(fs.realpath(real, "..")).toBe(63);
    const user = fs.preopen("/home/user");
    expect(fs.realpath(user, "abs")).toBe(63);
  });
});

describe.each(VFS_BACKEND_KINDS)("realpath through the filesystem client (%s)", (kind) => {
  test("answers in one request with the backend's tree", async () => {
    const env = await openVfsBackend(kind);
    try {
      await env.client.asyncCall("mkdirp", ["/real/dir"]);
      await env.client.asyncCall(
        "writeFile",
        ["/real/dir/file.txt", false, false],
        encoder.encode("x"),
      );
      await env.client.asyncCall("mkdirp", ["/home/user/node_modules"]);
      const root: number = await env.client.asyncCall("preopen", ["/"]);
      const at = await env.client.asyncCall("resolve", [root, "home/user/node_modules/pkg", false]);
      expect(await env.client.asyncCall("symlink", [at, "../../../real/dir"])).toBe(0);
      const realpath = (path: string) => env.client.asyncCall("realpath", [root, path, true]);
      expect(await realpath("home/user/node_modules/pkg/file.txt")).toBe("/real/dir/file.txt");
      expect(await realpath("home/user/node_modules/pkg/missing")).toBe(44);
      expect(await realpath("real/dir/file.txt/x")).toBe(54);
    } finally {
      await env.close();
    }
  });
});

describe("runtime_fs.path_realpath", () => {
  class CountingFS extends MemFS {
    realpaths = 0;
    readlinks = 0;
    override realpath(directory: number, path: string, rooted?: boolean): string | number {
      this.realpaths++;
      return super.realpath(directory, path, rooted);
    }
    override readlink(handle: number): string {
      this.readlinks++;
      return super.readlink(handle);
    }
  }

  function guest(rights?: bigint) {
    const fs = new CountingFS();
    fs.mkdirp("/real/dir");
    fs.writeFile("/real/dir/file.txt", "x");
    fs.mkdirp("/home/user/node_modules");
    link(fs, "/home/user/node_modules/pkg", "/real/dir");
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
    stops.push(() => wasi.descriptors.dispose());
    const module = guestModule("runtime_fs", [
      { name: "path_realpath", parameters: ["i32", "i32", "i32", "i32", "i32", "i32"] },
    ]);
    const instance = new WebAssembly.Instance(module, wasi.imports(module));
    wasi.start(instance);
    if (rights !== undefined) {
      const entry = wasi.descriptors.get(3)!;
      (entry as { rightsBase: bigint }).rightsBase = rights;
    }
    const call = guestFunction(instance, "path_realpath");
    const realpath = (path: string, fd = 3, capacity = 256) => {
      const input = encoder.encode(path);
      new Uint8Array(memory.buffer).set(input, 64);
      const errno = call(fd, 64, input.length, 1024, capacity, 32);
      const used = new DataView(memory.buffer).getUint32(32, true);
      const text = decoder.decode(new Uint8Array(memory.buffer, 1024, Math.min(used, capacity)));
      return { errno, used, text };
    };
    return { fs, memory, call, realpath };
  }

  test("writes the canonical path with one filesystem request", () => {
    const g = guest();
    expect(g.realpath("home/user/node_modules/pkg/file.txt")).toEqual({
      errno: 0,
      used: 18,
      text: "/real/dir/file.txt",
    });
    expect(g.fs.realpaths).toBe(1);
    expect(g.fs.readlinks).toBe(0);
  });

  test("a short buffer is ENOBUFS with the needed length and an untouched buffer", () => {
    const g = guest();
    new Uint8Array(g.memory.buffer).fill(7, 1024, 1040);
    const result = g.realpath("home/user/node_modules/pkg/file.txt", 3, 8);
    expect(result.errno).toBe(42);
    expect(result.used).toBe(18);
    expect(Array.from(new Uint8Array(g.memory.buffer, 1024, 8))).toEqual(Array(8).fill(7));
  });

  test("lookup errors, descriptor errors and bad pointers", () => {
    const g = guest();
    expect(g.realpath("home/user/missing").errno).toBe(44);
    expect(g.realpath("real/dir/file.txt/").errno).toBe(54);
    expect(g.realpath("real", 99).errno).toBe(8);
    expect(g.call(3, g.memory.buffer.byteLength - 2, 4, 1024, 16, 32)).toBe(21);
    expect(g.call(3, 64, 4, 1024, 16, g.memory.buffer.byteLength - 2)).toBe(21);
    expect(guest(0n).realpath("real").errno).toBe(76);
    expect(guest(RIGHT_PATH_FILESTAT_GET).realpath("real").errno).toBe(0);
  });
});
