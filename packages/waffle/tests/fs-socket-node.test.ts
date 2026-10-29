import { expect, test } from "bun:test";
import { MemFS, newDir } from "../fs/memory.js";

test("socket nodes have their own kind and private metadata", () => {
  const fs = new MemFS(newDir());
  const root = fs.preopen("/");
  const path = fs.resolve(root, "listener");
  if (typeof path === "number") throw new Error(`resolve: ${path}`);
  const node = fs.create(path, "socket", true);
  if (typeof node !== "number") throw new Error(`create: ${node.error}`);
  expect(fs.stat(node)).toMatchObject({ kind: "socket", mode: 0o600, size: 0, nlink: 1 });
});
