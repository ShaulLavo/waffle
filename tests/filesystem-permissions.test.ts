import { afterEach, expect, test } from "bun:test";
import { MemFS } from "../fs/memory.js";
import { MemoryBackend, FilesystemClient, FilesystemService, createFilesystemConnection } from "../fs/index.js";
import { SharedFilesystemState } from "../fs/shared.js";
import { validatePersistedNode } from "../fs/storage.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});
function file(fs: MemFS, path = "/file") {
  fs.writeFile(path, "secret");
  return fs.handleForNode(fs.lookup(path)!);
}

test("inode permissions describe actual read/write and directory search, not registry execution", () => {
  const fs = new MemFS();
  const handle = file(fs);
  expect(fs.permissions(handle)).toEqual({ mode: 0o600, modeSupported: 0o600, access: 6, accessSupported: 6 });
  expect(fs.permissions(fs.preopen("/"))).toEqual({ mode: 0o700, modeSupported: 0o1700, access: 7, accessSupported: 7 });
  expect(fs.setMode(handle, 0o100)).toBe(58);
  expect(fs.setMode(handle, 0o4000)).toBe(58);
  expect(fs.setMode(handle, -1)).toBe(28);
});

test("mode denial is enforced on live handles and namespace traversal", () => {
  const fs = new MemFS();
  const handle = file(fs, "/dir/file");
  const root = fs.preopen("/");
  const dir = fs.handleForNode(fs.lookup("/dir")!);
  expect(fs.setMode(handle, 0)).toBe(0);
  expect(fs.permissions(handle).access).toBe(0);
  expect(fs.read(handle, [new Uint8Array(6)], 0)).toBe(-2);
  expect(fs.write(handle, [new Uint8Array([1])], 0)).toBe(-2);
  expect(fs.resize(handle, 0, true)).toBe(2);
  expect(fs.setMode(dir, 0o400)).toBe(0);
  expect(fs.resolve(root, "dir/file")).toBe(2);
  expect(fs.resolve(root, "missing")).toMatchObject({ node: undefined });
  expect(fs.resolve(root, "missing/file")).toBe(44);
  expect(() => fs.writeFile("/dir/new", "denied")).toThrow();
  expect(fs.setMode(dir, 0o1700)).toBe(0);
  expect(fs.permissions(dir).mode).toBe(0o1700);
  expect(fs.resolve(root, "dir/file")).toMatchObject({ node: handle });
});

test("shared stat and direct I/O carry permissions through unlink and slot reuse", () => {
  const backend = new MemoryBackend();
  const handle = file(backend.fs);
  backend.execute("stat", [handle], new Uint8Array());
  expect(backend.execute("setMode", [handle, 0], new Uint8Array())).toBe(0);
  const state = backend.shared;
  expect(state.stat(handle)?.mode).toBe(0);
  const slot = state.fileSlot(handle)!;
  expect(() => state.directRead(slot, handle, [new Uint8Array(6)], 0, () => false, 1)).toThrow("errno 2");
  expect(() => state.directWrite(slot, handle, [new Uint8Array([1])], 0, 1, new Int32Array(1), () => false, 1)).toThrow("errno 2");
  backend.retain(handle);
  backend.execute("remove", ["/file"], new Uint8Array());
  expect(state.stat(handle)?.mode).toBe(0);
  backend.release(handle);
  expect(state.stat(handle)).toBeUndefined();
  const replacement = file(backend.fs, "/replacement");
  backend.execute("stat", [replacement], new Uint8Array());
  expect(state.stat(replacement)?.mode).toBe(0o600);
  expect(state.stat(handle)).toBeUndefined();
});

test("absent mode metadata is unsupported, not a fabricated default", () => {
  const state = new SharedFilesystemState();
  state.register(42, { kind: "file", ino: 1, size: 0, mtime: 1 });
  expect(state.stat(42)?.mode).toBeUndefined();
});

test("persisted modes reject unsupported bits and retain old saved defaults explicitly", () => {
  const node = { ino: 1, kind: "file", mtime: 1, size: 0 };
  expect(() => validatePersistedNode({ ...node, mode: 0o200 })).not.toThrow();
  expect(() => validatePersistedNode({ ...node, mode: 0o777 })).toThrow();
  expect(() => validatePersistedNode({ ...node, mode: -1 })).toThrow();
  expect(() => validatePersistedNode(node)).not.toThrow();
});

test("worker service permissions are the same for distinct connection identities", async () => {
  const backend = new MemoryBackend();
  file(backend.fs);
  const service = new FilesystemService(backend);
  cleanup.push(() => service.dispose());
  const first = createFilesystemConnection();
  service.connect(first.server);
  const a = new FilesystemClient(first.client);
  cleanup.push(() => a.dispose());
  const second = createFilesystemConnection(first.client);
  service.connect(second.server);
  const b = new FilesystemClient(second.client);
  cleanup.push(() => b.dispose());
  const rootA = await a.asyncCall("preopen", ["/"]);
  const rootB = await b.asyncCall("preopen", ["/"]);
  const pathA = await a.asyncCall("resolve", [rootA, "file"]);
  const pathB = await b.asyncCall("resolve", [rootB, "file"]);
  expect(first.client.owner).not.toBe(second.client.owner);
  expect(await a.asyncCall("setMode", [pathA.node, 0o400])).toBe(0);
  expect(await a.asyncCall("permissions", [pathA.node])).toEqual(await b.asyncCall("permissions", [pathB.node]));
  expect(b.permissions(pathB.node).access).toBe(4);
  await expect(b.asyncCall("write", [pathB.node, 0], new Uint8Array([1]))).rejects.toThrow("errno 2");
  expect(b.write(pathB.node, [new Uint8Array([1])], 0)).toBe(-2);
});
