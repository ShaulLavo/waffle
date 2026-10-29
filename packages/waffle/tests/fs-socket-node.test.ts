import { expect, test } from "bun:test";
import { MemFS, newDir, nodeMetadata } from "../fs/memory.js";

test("socket nodes have their own kind and private metadata", () => {
  const fs = new MemFS(newDir());
  const root = fs.preopen("/");
  const path = fs.resolve(root, "listener");
  if (typeof path === "number") throw new Error(`resolve: ${path}`);
  const node = fs.create(path, "socket", true);
  if (typeof node !== "number") throw new Error(`create: ${node.error}`);
  expect(fs.stat(node)).toMatchObject({ kind: "socket", mode: 0o600, size: 0, nlink: 1 });
});

import { openInode } from "../core/fd-reopen.js";
import { DescriptorTable } from "../core/descriptors.js";
import { MemoryBackend } from "../fs/backend.js";

function socketFixture() {
  const fs = new MemFS();
  const root = fs.preopen("/");
  const path = fs.resolve(root, "listener");
  if (typeof path === "number") throw new Error(`resolve: ${path}`);
  const node = fs.create(path, "socket", true);
  if (typeof node !== "number") throw new Error(`create: ${node.error}`);
  return { fs, root, node, path: { ...path, node } };
}

test("socket entries are exclusive, cannot be hard linked, and expose no bytes", () => {
  const { fs, node, path, root } = socketFixture();
  expect(fs.create(path, "socket", true)).toEqual({ error: 20 });
  expect(fs.create(path, "socket", false)).toEqual({ error: 28 });
  const target = fs.resolve(root, "hardlink");
  if (typeof target === "number") throw new Error("missing parent");
  expect(fs.link(path, target)).toBe(58);
  expect(fs.planLink(path, target, 16).result).toBe(58);
  expect(fs.read(node, [new Uint8Array(1)], 0)).toBe(-60);
  expect(fs.write(node, [new Uint8Array([1])], 0)).toBe(-60);
  expect(fs.append(node, [new Uint8Array([1])])).toBe(-60);
  expect(fs.resize(node, 1, true)).toBe(60);
  expect(nodeMetadata(fs.nodeForHandle(node))).toEqual({ kind: "socket" });
});

test("ordinary open descriptions cannot treat sockets as regular files", () => {
  const { fs, node } = socketFixture();
  const table = new DescriptorTable();
  try {
    expect(openInode(table, fs, node, "file", 0, 0, 0n, 0n)).toBe(-60);
  } finally {
    table.dispose();
  }
});

test("socket shared metadata and paginated dirents retain their classification", () => {
  const { fs, node, root } = socketFixture();
  const backend = new MemoryBackend(fs);
  expect(backend.execute("stat", [node], new Uint8Array())).toMatchObject({ kind: "socket" });
  expect(backend.shared.stat(node)).toMatchObject({ kind: "socket", size: 0, mode: 0o600 });
  expect(fs.readdir(root).find((entry) => entry.name === "listener")?.kind).toBe("socket");
  const bytes = fs.readdirPage(root, 0n, 4096);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const kinds = new Map<string, number>();
  while (offset < bytes.length) {
    const size = view.getUint32(offset + 16, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 24, offset + 24 + size));
    kinds.set(name, view.getUint8(offset + 20));
    offset += 24 + size;
  }
  expect(kinds.get("listener")).toBe(6);
});

test("rename preserves the socket inode and permissions", () => {
  const { fs, node, path, root } = socketFixture();
  const target = fs.resolve(root, "renamed");
  if (typeof target === "number") throw new Error("missing parent");
  const ino = fs.stat(node).ino;
  expect(fs.setMode(node, 0o400)).toBe(0);
  expect(fs.rename(path, target)).toBe(0);
  expect(fs.nodeForHandle(node) === fs.lookup("/renamed")).toBe(true);
  expect(fs.stat(node)).toMatchObject({ ino, kind: "socket", mode: 0o400, nlink: 1 });
});

import { metadataGuest } from "./fixtures/metadata-enumeration-r173-wasi.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { publicReadFixture } from "./fixtures/workspace-read.js";
import { exportWorkspaceArchive } from "../fs/workspace-export.js";

test("preview1 reports SOCKET_STREAM and rejects ordinary path_open", () => {
  const { fs } = socketFixture();
  const guest = metadataGuest(fs);
  try {
    guest.stat("listener");
    expect(guest.view.getUint8(4112)).toBe(6);
    expect(guest.call("path_open", 3, 0, 512, 8, 0, 0n, 0n, 0, 4096)).toBe(60);
  } finally {
    guest.wasi.descriptors.dispose();
  }
});

test("socket archive export explicitly returns ENOTSUP", async () => {
  const { fs } = socketFixture();
  const value = publicReadFixture(new MemoryBackend(fs));
  try {
    const consume = async () => {
      for await (const _chunk of exportWorkspaceArchive(value.workspace)) void _chunk;
    };
    const error = await consume().catch((error: unknown) => error);
    expect(error).toMatchObject({ errno: 58 });
  } finally {
    await value.close();
  }
});

test("the executable registry rejects sockets without reading their bytes", async () => {
  const registry = new ExecutableRegistry(
    (path) => ({ path, kind: "socket" }),
    () => {
      throw new Error("socket bytes must not be read");
    },
  );
  const error = await registry.resolve("/listener").catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "EACCES" });
});
