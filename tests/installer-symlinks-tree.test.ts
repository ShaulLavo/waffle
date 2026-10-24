import { expect, test } from "bun:test";
import { MemFS, newDir, newSymlink } from "../fs/memory.js";

function at(fs: MemFS, path: string, follow = false) {
  const found = fs.resolveAbsolute(path, follow);
  if (typeof found === "number") throw new Error(`resolve errno ${found}`);
  return found;
}
function handle(fs: MemFS, path: string) {
  const node = at(fs, path).node;
  if (node === undefined) throw new Error(`missing inode ${path}`);
  return node;
}
function link(fs: MemFS, name: string, target: string) {
  expect(fs.symlink(at(fs, name), target)).toBe(0);
}

test("actual tree links preserve target spelling and editor inode identity", () => {
  const fs = new MemFS();
  fs.writeFile("/packages/member/file", "before");
  fs.mkdirp("/node_modules");
  link(fs, "/node_modules/member", "../packages//member");
  const original = at(fs, "/packages/member/file");
  expect(at(fs, "/node_modules/member/file").node).toBe(original.node);
  expect(fs.readlink(handle(fs, "/node_modules/member"))).toBe("../packages//member");
  fs.writeFile("/node_modules/member/file", "after");
  expect(new TextDecoder().decode(fs.readFile("/packages/member/file"))).toBe("after");
  expect(fs.stat(handle(fs, "/node_modules/member")).kind).toBe("symlink");
});

test("actual tree capability stacks expand links before handling dotdot", () => {
  const fs = new MemFS();
  fs.writeFile("/sandbox/a/inner/file", "yes");
  fs.writeFile("/sandbox/a/peer", "peer");
  fs.writeFile("/other/private", "secret");
  link(fs, "/sandbox/link", "a/inner");
  link(fs, "/sandbox/out", "../other");
  const root = fs.preopen("/sandbox");
  expect(fs.resolve(root, "link/../peer", true)).toEqual(fs.resolve(root, "a/peer", true));
  expect(fs.resolve(root, "out/private", true)).toBe(63);
  expect(fs.resolve(root, "missing/../a", true)).toBe(44);
  expect(fs.resolve(root, "a/peer/..", true)).toBe(54);
});

test("actual tree retains dangling and cyclic targets and enforces trailing directory", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "bytes");
  link(fs, "/dangling", "missing");
  link(fs, "/a", "b");
  link(fs, "/b", "a");
  link(fs, "/file-link", "file");
  expect(at(fs, "/dangling", true).node).toBeUndefined();
  expect(fs.resolveAbsolute("/a", true)).toBe(32);
  expect(fs.resolveAbsolute("/file-link/", false)).toBe(54);
  fs.writeFile("/dangling", "created");
  expect(new TextDecoder().decode(fs.readFile("/missing"))).toBe("created");
  expect(fs.readlink(handle(fs, "/dangling"))).toBe("missing");
});

test("host writes reject directories and trailing slashes without creating empty entries", () => {
  const fs = new MemFS();
  fs.mkdirp("/directory");
  expect(() => fs.writeFile("/", "bad")).toThrow();
  expect(() => fs.writeFile("/directory/.", "bad")).toThrow();
  expect(() => fs.writeFile("/missing/", "bad")).toThrow();
  expect(fs.root.children.has("")).toBe(false);
  expect(fs.root.children.has("missing")).toBe(false);
  fs.writeFile("relative/file", "ok");
  expect(new TextDecoder().decode(fs.readFile("/relative/file"))).toBe("ok");
});

test("supplied trees retain actual parent identity after ordinary and symlink traversal", () => {
  const root = newDir(),
    parent = newDir(),
    child = newDir();
  root.children.set("parent", parent);
  parent.children.set("child", child);
  root.children.set("alias", newSymlink("parent/child"));
  const fs = new MemFS(root);
  const direct = handle(fs, "/parent/child");
  expect(fs.readdir(direct).find((entry) => entry.name === "..")).toMatchObject({
    ino: parent.ino,
  });
  expect(at(fs, "/alias", true).node).toBe(direct);
  expect(fs.readdir(direct).find((entry) => entry.name === "..")).toMatchObject({
    ino: parent.ino,
  });
});
