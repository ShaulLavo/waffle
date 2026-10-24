import { afterEach, expect, test } from "bun:test";
import type { EntryMetadata } from "../browser/shared-fs.js";
import { MemoryBackend } from "../fs/backend.js";
import { MemFS } from "../fs/memory.js";
import { FilesystemClient } from "../fs/client.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection } from "../fs/protocol.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

function link(fs: MemFS, path: string, target: string) {
  const destination = fs.resolveAbsolute(path);
  if (typeof destination === "number") throw new Error(`resolve errno ${destination}`);
  expect(fs.symlink(destination, target)).toBe(0);
}
function fixture() {
  const fs = new MemFS();
  fs.mkdirp("/a/b");
  fs.writeFile("/a/note.txt", "ordinary text");
  fs.writeFile("/a/b/child.txt", "child text");
  link(fs, "/link", "a/b");
  const backend = new MemoryBackend(fs);
  const resolve = (path: string) => backend.execute("resolvePath", [path], new Uint8Array());
  return { fs, backend, resolve };
}

test("metadata reports the actual parent after an intermediate link and dotdot", () => {
  const { resolve } = fixture();
  expect(resolve("/link/../note.txt")).toEqual({ path: "/a/note.txt", kind: "file" });
  expect(resolve("/link/..")).toEqual({ path: "/a", kind: "dir" });
});

test("ordinary file, directory, root and missing metadata keep their meaning", () => {
  const { resolve } = fixture();
  expect(resolve("/a/b/../note.txt")).toEqual({ path: "/a/note.txt", kind: "file" });
  expect(resolve("/a/b/..")).toEqual({ path: "/a", kind: "dir" });
  expect(resolve("/")).toEqual({ path: "/", kind: "dir" });
  expect(resolve("/a/missing")).toBeUndefined();
});

test("final no-follow metadata keeps the link and its exact raw target", () => {
  const { fs, resolve } = fixture();
  const target = "./b//../note.txt";
  link(fs, "/a/raw", target);
  expect(resolve("/a/raw")).toEqual({ path: "/a/raw", kind: "symlink", target });
  link(fs, "/a/dangling", "./not-present");
  expect(resolve("/a/dangling")).toEqual({
    path: "/a/dangling",
    kind: "symlink",
    target: "./not-present",
  });
  expect(new TextDecoder().decode(fs.readFile("/a/raw"))).toBe("ordinary text");
});

test("an intermediate link does not change final no-follow metadata", () => {
  const { fs, resolve } = fixture();
  link(fs, "/a/final", "./note.txt");
  expect(resolve("/link/../final")).toEqual({
    path: "/a/final",
    kind: "symlink",
    target: "./note.txt",
  });
});

test("listing labels actual descendants with their canonical start path", () => {
  const { fs } = fixture();
  expect(fs.listFiles("/link/..")).toEqual(["/a/b/child.txt", "/a/note.txt"]);
  expect(fs.listFiles("/link")).toEqual(["/a/b/child.txt"]);
});

test("listing keeps regular-file-only recursion and ordinary controls", () => {
  const { fs, backend } = fixture();
  link(fs, "/a/file-link", "note.txt");
  link(fs, "/a/dir-link", "b");
  expect(fs.listFiles("/a")).toEqual(["/a/b/child.txt", "/a/note.txt"]);
  expect(fs.listFiles("a/b/../note.txt")).toEqual(["/a/note.txt"]);
  expect(fs.listFiles("/a/missing")).toEqual([]);
  expect(backend.execute("listFiles", ["/link"], new Uint8Array())).toEqual(["/a/b/child.txt"]);
});

test("relative descriptor resolution retains its existing transport shape", () => {
  const { fs, backend } = fixture();
  const directory = fs.preopen("/a");
  const child = fs.lookup("/a/note.txt");
  if (!child) throw new Error("missing fixture file");
  expect(backend.execute("resolve", [directory, "note.txt", false], new Uint8Array())).toEqual({
    parent: directory,
    node: fs.handleForNode(child),
    name: "note.txt",
    trailingSlash: false,
    terminalDot: false,
  });
});

test("service lookup returns shallow child metadata with required link targets", async () => {
  const { fs, backend } = fixture();
  link(fs, "/a/raw", "./b//../note.txt");
  const owner = new FilesystemService(backend);
  cleanup.push(() => owner.dispose());
  const connection = createFilesystemConnection();
  cleanup.push(() => connection.server.port.close());
  cleanup.push(() => connection.client.port.close());
  const client = new FilesystemClient(connection.client);
  cleanup.push(() => client.dispose());
  owner.connect(connection.server);
  const raw = fs.lookup("/a/raw", false);
  const file = fs.lookup("/a/note.txt");
  const directory = fs.lookup("/a/b");
  if (!raw || !file || !directory) throw new Error("missing fixture entries");
  const rawMetadata = {
    kind: "symlink",
    target: "./b//../note.txt",
    ino: raw.ino,
    mtime: raw.mtime,
  } satisfies EntryMetadata;
  expect(await client.asyncCall("lookup", ["/a/raw"])).toEqual(rawMetadata);
  expect(await client.asyncCall("lookup", ["/a"])).toMatchObject({
    kind: "dir",
    children: new Map<string, EntryMetadata>([
      ["b", { kind: "dir", ino: directory.ino, mtime: directory.mtime }],
      ["note.txt", { kind: "file", ino: file.ino, mtime: file.mtime }],
      ["raw", rawMetadata],
    ]),
  });
  expect(await client.asyncCall("resolvePath", ["/link/../raw"])).toEqual({
    path: "/a/raw",
    kind: "symlink",
    target: "./b//../note.txt",
  });
});
