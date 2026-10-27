import { afterEach, expect, test } from "bun:test";
import { FilesystemError } from "../core/filesystem.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { DirectoryPages, MAX_DIRECTORY_PAGE_BYTES } from "../fs/directory-pages.js";
import { MemFS, newDir, newFile } from "../fs/memory.js";
import { createFilesystemConnection, revokeFilesystem } from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";
import { metadataWorker } from "./fixtures/metadata-enumeration-r173-service.js";
import {
  directoryPage,
  enumerateDirectory,
  metadataGuest,
} from "./fixtures/metadata-enumeration-r173-wasi.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});
function guest(fs: MemFS, root = "/") {
  const h = metadataGuest(fs, root);
  cleanup.push(() => h.wasi.descriptors.dispose());
  return h;
}
function path(fs: MemFS, name: string) {
  const result = fs.resolveAbsolute(name);
  if (typeof result === "number") throw new FilesystemError(result);
  return result;
}
function records(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: { name: string; cookie: bigint; ino: bigint; kind: number }[] = [];
  for (let at = 0; at + 24 <= bytes.length;) {
    const length = view.getUint32(at + 16, true);
    if (at + 24 + length > bytes.length) break;
    result.push({
      name: new TextDecoder().decode(bytes.subarray(at + 24, at + 24 + length)),
      cookie: view.getBigUint64(at, true),
      ino: view.getBigUint64(at + 8, true),
      kind: view.getUint8(at + 20),
    });
    at += 24 + length;
  }
  return result;
}
async function failure(done: Promise<unknown>): Promise<number> {
  try {
    await done;
    return 0;
  } catch (error) {
    if (!(error instanceof FilesystemError)) throw error;
    return error.errno;
  }
}

function fixture() {
  const backend = new MemoryBackend();
  backend.fs.writeFile("/file", "data");
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  cleanup.push(() => {
    client.dispose();
    service.dispose();
    pair.server.port.close();
    expect(service.resources()).toMatchObject({ clients: 0, retained: 0, responses: 0 });
  });
  return { backend, service, client, pair };
}

for (const planned of [false, true]) {
  test(`#118 cookies follow live edges after delete, link and replacement, planned=${planned}`, () => {
    const backend = new MemoryBackend();
    const fs = backend.fs;
    fs.writeFile("/a", "a");
    fs.writeFile("/b", "b");
    fs.writeFile("/c", "c");
    const h = guest(fs);
    expect(directoryPage(h, 0n, 76).entries.map((entry) => entry.name)).toEqual([".", "..", "a"]);
    const unlink = (name: string) =>
      planned
        ? backend.execute("removePath", [path(fs, name), false], new Uint8Array())
        : fs.removePath(path(fs, name), false);
    const rename = (from: string, to: string) =>
      planned
        ? backend.execute("rename", [path(fs, from), path(fs, to)], new Uint8Array())
        : fs.rename(path(fs, from), path(fs, to));
    expect(unlink("/b")).toBe(0);
    expect(rename("/a", "/z")).toBe(0);
    fs.writeFile("/d", "d");
    expect(
      planned
        ? backend.execute("link", [path(fs, "/c"), path(fs, "/alias")], new Uint8Array())
        : fs.link(path(fs, "/c"), path(fs, "/alias")),
    ).toBe(0);
    expect(rename("/d", "/c")).toBe(0);
    const remaining = directoryPage(h, 3n).entries;
    expect(remaining.map((entry) => entry.name)).toEqual(["z", "alias", "c"]);
    expect(remaining.map((entry) => entry.cookie)).toEqual([6n, 8n, 9n]);
    expect(directoryPage(h, 4n).entries).toEqual(remaining);
    expect(directoryPage(h, 0n).entries.map((entry) => entry.name)).toEqual([
      ".",
      "..",
      "z",
      "alias",
      "c",
    ]);
    expect(unlink("/z")).toBe(0);
    expect(directoryPage(h, 6n).entries.map((entry) => entry.name)).toEqual(["alias", "c"]);
    expect(directoryPage(h, (1n << 64n) - 1n).used).toBe(0);
  });
}

test("#118 partial UTF-8 dirents are exact byte prefixes and retry the same cookie", () => {
  const fs = new MemFS();
  const name = "é雪🙂".repeat(40);
  fs.writeFile(`/${name}`, "");
  const h = guest(fs);
  const root = fs.preopen("/");
  const full = fs.readdirPage(root, 2n, 1024);
  expect(records(full).map((entry) => entry.name)).toEqual([name]);
  for (const size of [0, 1, 7, 23, 24, 25, 26, 27, 29, 100, full.length]) {
    const page = directoryPage(h, 2n, size);
    expect(h.bytes.slice(8192, 8192 + page.used)).toEqual(full.slice(0, size));
    expect(page.used).toBe(Math.min(size, full.length));
  }
  expect(directoryPage(h, 2n, 1024).entries[0]?.name).toBe(name);
});

test("#118 a long UTF-8 name can complete in a larger guest page", () => {
  const fs = new MemFS();
  const name = "雪".repeat(24000);
  fs.writeFile(`/${name}`, "");
  const h = guest(fs);
  expect(directoryPage(h, 2n, 64 * 1024).entries).toEqual([]);
  expect(directoryPage(h, 2n, 80 * 1024).entries[0]?.name).toBe(name);
  expect(directoryPage(h, 3n, 80 * 1024).used).toBe(0);
});

test("#118 actual Worker WASI completes a long dirent through binary overflow replies", async () => {
  const backend = new MemoryBackend();
  const name = "雪".repeat(24000);
  backend.fs.writeFile(`/${name}`, "");
  const result = await metadataWorker<ReturnType<typeof enumerateDirectory>>(backend, {
    scenario: "directory",
    count: 1,
    capacity: 80 * 1024,
  });
  expect(result).not.toHaveProperty("error");
  expect(result.names).toEqual([".", "..", name]);
  expect(result.cookies).toEqual([1n, 2n, 3n]);
  expect(result.eof).toBe(0);
});

test("#118 WASI fills guest buffers larger than one service page", () => {
  const fs = new MemFS();
  for (let index = 0; index < 4000; index++) fs.writeFile(`/entry-${index}`, "");
  const h = guest(fs);
  const size = 64 * 1024 + 4096;
  const first = directoryPage(h, 0n, size);
  expect(first.used).toBe(size);
  const last = first.entries.at(-1)!;
  const rest = directoryPage(h, last.cookie, size);
  expect(new Set(first.entries.concat(rest.entries).map((entry) => entry.name)).size).toBe(4002);
});

test("#118 reconstructed directories, moved parent and removed-open directory keep their lifetime", () => {
  const root = newDir();
  const directory = newDir();
  directory.children.set("file", newFile());
  root.children.set("dir", directory);
  const fs = new MemFS(root);
  const h = guest(fs);
  const fd = h.open("dir");
  const handle = path(fs, "/dir").node!;
  const before = records(fs.readdirPage(handle, 0n, 4096));
  expect(before.map((entry) => entry.name)).toEqual([".", "..", "file"]);
  fs.mkdirp("/parent");
  expect(fs.rename(path(fs, "/dir"), path(fs, "/parent/moved"))).toBe(0);
  expect(records(fs.readdirPage(handle, 1n, 26))[0]?.ino).toBe(BigInt(fs.lookup("/parent")!.ino));
  expect(fs.remove("/parent/moved")).toBe(true);
  expect(records(fs.readdirPage(handle, 0n, 4096)).map((entry) => entry.name)).toEqual([".", ".."]);
  expect(fs["directoryPages"](directory)["names"].size).toBe(0);
  fs.mkdirp("/parent/moved");
  expect(path(fs, "/parent/moved").node).not.toBe(handle);
  h.checked("fd_close", fd);
  expect(() => fs.readdirPage(handle, 0n, 4096)).toThrow("unknown filesystem handle");
});

test("#118 dot entries preserve namespace metadata without granting parent traversal", () => {
  const fs = new MemFS();
  fs.writeFile("/sandbox/inside", "");
  fs.writeFile("/outside", "");
  const h = guest(fs, "/sandbox");
  const entries = directoryPage(h, 0n).entries;
  expect(entries.map((entry) => entry.name)).toEqual([".", "..", "inside"]);
  expect(entries[0]?.ino).toBe(BigInt(fs.lookup("/sandbox")!.ino));
  expect(entries[1]?.ino).toBe(BigInt(fs.root.ino));
  const handle = h.wasi.descriptors.get(3)!.resource;
  if (handle.kind !== "directory") throw new Error("expected directory");
  expect(fs.resolve(handle.handle, "../outside")).toBe(63);
  expect(directoryPage(h, 1n, 26).entries[0]?.name).toBe("..");
});

test("#118 WASI retains live mode, rights, wrong-kind and closed-fd errors", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "");
  const h = guest(fs);
  const fd = h.open("file");
  expect(h.call("fd_readdir", 3, 8192, -1, 0n, 4096)).toBe(21);
  expect(h.call("fd_readdir", 3, 8192, 4096, 0n, -1)).toBe(21);
  expect(h.call("fd_readdir", fd, 8192, 4096, 0n, 4096)).toBe(54);
  const root = fs.preopen("/");
  fs.setMode(root, 0o300);
  expect(h.call("fd_readdir", 3, 8192, 4096, 0n, 4096)).toBe(2);
  h.wasi.descriptors.get(3)!.rightsBase = 0n;
  expect(h.call("fd_readdir", 3, 8192, 4096, 0n, 4096)).toBe(76);
  h.checked("fd_close", 3);
  expect(h.call("fd_readdir", 3, 8192, 4096, 0n, 4096)).toBe(8);
});

test("#118 service rejects invalid bounds, cookies and foreign handles before backend dispatch", async () => {
  const f = fixture();
  const root = await f.client.asyncCall("preopen", ["/"]);
  let pages = 0;
  const execute = f.backend.execute.bind(f.backend);
  f.backend.execute = (operation, args, bytes) => {
    if (operation === "readdirPage") pages++;
    return execute(operation, args, bytes);
  };
  for (const [cookie, size] of [
    [-1n, 1],
    [1n << 64n, 1],
    [1, 1],
    ["0", 1],
    [0n, -1],
    [0n, 1.5],
    [0n, NaN],
    [0n, Infinity],
    [0n, "1"],
    [0n, MAX_DIRECTORY_PAGE_BYTES + 1],
  ]) {
    expect(await failure(f.client.asyncCall("readdirPage", [root, cookie, size]))).toBe(28);
  }
  const hidden = f.backend.fs.preopen("/hidden");
  expect(await failure(f.client.asyncCall("readdirPage", [hidden, 0n, 128]))).toBe(8);
  expect(pages).toBe(0);
  const result: unknown = await f.client.asyncCall("readdirPage", [root, 0n, 4096]);
  if (!(result instanceof Uint8Array)) throw new Error("expected page bytes");
  expect(records(result).map((entry) => entry.name)).toEqual([".", "..", "file", "hidden"]);
  expect(pages).toBe(1);
  const bounded: unknown = await f.client.asyncCall("readdirPage", [
    root,
    0n,
    MAX_DIRECTORY_PAGE_BYTES,
  ]);
  expect(bounded).toEqual(result);
  const file = path(f.backend.fs, "/file").node!;
  await f.client.asyncCall("resolve", [root, "file"]);
  expect(await failure(f.client.asyncCall("readdirPage", [file, 0n, 128]))).toBe(54);
});

test("#118 cancellation and revocation release page replies and forbid later enumeration", async () => {
  const f = fixture();
  const root = await f.client.asyncCall("preopen", ["/"]);
  const pending = f.client.submit("readdirPage", [root, 0n, 4096]);
  pending.cancel();
  pending.release();
  await f.client.asyncCall("listFiles", ["/"]);
  expect(f.service.resources().responses).toBe(0);
  revokeFilesystem(f.pair.client);
  expect(() => f.client.readdirPage(root, 0n, 128)).toThrow("errno 11");
});

test("#118 cookie overflow is rejected before direct and planned namespace edits", () => {
  const fs = new MemFS();
  fs.writeFile("/a", "");
  fs.writeFile("/b", "");
  const pages = fs["directoryPages"](fs.root);
  pages["next"] = (1n << 64n) - 1n;
  fs.writeFile("/last", "");
  const h = guest(fs);
  expect(directoryPage(h, 3n).entries.at(-1)?.cookie).toBe((1n << 64n) - 1n);
  expect(() => fs.rename(path(fs, "/a"), path(fs, "/b"))).toThrow("cookies exhausted");
  expect(() => fs.create(path(fs, "/new"), "file")).toThrow("cookies exhausted");
  expect(() => fs.writeFile("/new/deep", "")).toThrow("cookies exhausted");
  expect(Array.from(fs.root.children.keys())).toEqual(["a", "b", "last"]);
});

test("#118 live index remains balanced and releases removed edges without tombstones", () => {
  const pages = new DirectoryPages();
  for (let index = 0; index < 10000; index++)
    pages.set({ name: String(index), ino: index + 1, kind: "file" });
  expect(pages["root"]!.height).toBeLessThan(20);
  for (let index = 0; index < 10000; index += 2) pages.delete(String(index));
  const remaining = Array.from(pages.entriesAfter(0n));
  expect(remaining.length).toBe(5000);
  expect(pages["names"].size).toBe(5000);
  expect(remaining.every((entry, index) => entry.name === String(2 * index + 1))).toBe(true);
  expect(pages["root"]!.height).toBeLessThan(20);
  for (let index = 1; index < 10000; index += 2) pages.delete(String(index));
  expect(pages["root"]).toBeUndefined();
  expect(pages["names"].size).toBe(0);
  pages.set({ name: "again", ino: 1, kind: "file" });
  expect(Array.from(pages.entriesAfter(10002n))[0]?.cookie).toBe(10003n);
});
