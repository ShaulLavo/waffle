import { afterEach, expect, test } from "bun:test";
import { MemFS } from "../fs/memory.js";
import {
  MemoryBackend,
  FilesystemClient,
  FilesystemService,
  createFilesystemConnection,
} from "../fs/index.js";
import { SharedFilesystemState } from "../fs/shared.js";
import { validatePersistedNode } from "../fs/storage.js";
import { statTimes, storedTimes } from "../testing/fixtures/file-times.js";
import {
  RIGHTS_ALL,
  RIGHT_FD_FILESTAT_SET_MODE,
  RIGHT_FD_FILESTAT_SET_TIMES,
  RIGHT_FD_READ,
  RIGHT_PATH_FILESTAT_SET_MODE,
} from "../core/rights.js";
import { modeGuest } from "./fixtures/permissions-guest.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});
function file(fs: MemFS, path = "/file") {
  fs.writeFile(path, "secret");
  return fs.handleForNode(fs.lookup(path)!);
}

test("inode modes preserve execute, group and other bits with one effective principal", () => {
  const fs = new MemFS();
  const handle = file(fs);
  expect(fs.permissions(handle)).toEqual({
    mode: 0o600,
    modeSupported: 0o777,
    access: 6,
    accessSupported: 6,
  });
  expect(fs.permissions(fs.preopen("/"))).toEqual({
    mode: 0o700,
    modeSupported: 0o1777,
    access: 7,
    accessSupported: 7,
  });
  expect(fs.setMode(handle, 0o177)).toBe(0);
  expect(fs.permissions(handle).mode).toBe(0o177);
  expect(fs.permissions(handle).access).toBe(0);
  expect(fs.setMode(handle, 0o4000)).toBe(58);
  expect(fs.setMode(handle, -1)).toBe(28);
});

test("R1 directory names keep ordinary modes and sticky remains real inode policy", () => {
  const fs = new MemFS();
  const root = fs.preopen("/");
  for (const path of ["/tmp", "/bin"]) {
    const handle = fs.handleForNode(fs.mkdirp(path));
    expect(fs.permissions(handle)).toEqual({
      mode: 0o700,
      modeSupported: 0o1777,
      access: 7,
      accessSupported: 7,
    });
  }
  const directory = fs.resolve(root, "tmp");
  if (typeof directory === "number" || directory.node === undefined) throw new Error("missing tmp");
  expect(fs.setMode(directory.node, 0o1700)).toBe(0);
  file(fs, "/tmp/own-file");
  expect(fs.permissions(directory.node).mode).toBe(0o1700);
  const entry = fs.resolve(root, "tmp/own-file");
  if (typeof entry === "number") throw new Error("missing own file");
  expect(fs.removePath(entry, false)).toBe(0);
  expect(fs.resolve(root, "tmp/own-file")).toMatchObject({ node: undefined });
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
  expect(() => state.directRead(slot, handle, [new Uint8Array(6)], 0, () => false, 1)).toThrow(
    "errno 2",
  );
  expect(() =>
    state.directWrite(slot, handle, [new Uint8Array([1])], 0, 1, new Int32Array(1), () => false, 1),
  ).toThrow("errno 2");
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
  state.register(42, { kind: "file", ino: 1, nlink: 1, size: 0, ...statTimes(1) });
  expect(state.stat(42)?.mode).toBeUndefined();
});

test("persisted modes reject unsupported bits and retain old saved defaults explicitly", () => {
  const node = { ino: 1, kind: "file", ...storedTimes(1), size: 0 };
  expect(() => validatePersistedNode({ ...node, mode: 0o200 })).not.toThrow();
  expect(() => validatePersistedNode({ ...node, mode: 0o777 })).not.toThrow();
  expect(() => validatePersistedNode({ ...node, mode: 0o4777 })).toThrow();
  expect(() => validatePersistedNode({ ...node, mode: -1 })).toThrow();
  expect(() => validatePersistedNode(node)).not.toThrow();
});

function modeHost(fs: MemFS) {
  const host = modeGuest(fs);
  cleanup.push(() => host.wasi.descriptors.dispose());
  return host;
}

test("guest chmod follows symlinks and changes the shared hard-link inode", () => {
  const fs = new MemFS();
  const target = file(fs, "/target");
  const original = fs.resolveAbsolute("/target");
  const alias = fs.resolveAbsolute("/alias");
  const link = fs.resolveAbsolute("/link");
  if (typeof original === "number" || typeof alias === "number" || typeof link === "number")
    throw new Error("could not resolve fixture paths");
  expect(fs.link(original, alias)).toBe(0);
  expect(fs.symlink(link, "alias")).toBe(0);
  const host = modeHost(fs);
  expect(host.setPathMode("link", 0o754)).toBe(0);
  expect(fs.stat(target)).toMatchObject({ mode: 0o754, nlink: 2 });
  expect(fs.stat(fs.handleForNode(fs.lookup("/link", false)!)).mode).toBe(0o600);
  expect(host.setPathMode("link", 0o600, 0)).toBe(58);
  expect(host.setPathMode("target/", 0o600)).toBe(54);
  expect(host.setPathMode("target", 0o4754)).toBe(58);
  expect(host.setPathMode("target", 0o600, 2)).toBe(58);
  expect(host.setPathMode("absent", 0o600)).toBe(44);
  expect(host.setPathMode("tar\0get", 0o600)).toBe(28);
  expect(host.pathSetMode(3, 0xfffffff0, 32, 1, 0o600)).toBe(21);
  expect(fs.stat(target).mode).toBe(0o754);
  expect(host.setRights(3, RIGHTS_ALL, RIGHTS_ALL)).toBe(0);
  expect(host.setPathMode("target", 0o400)).toBe(76);
  expect(fs.stat(target).mode).toBe(0o754);
});

test("guest fchmod acts on a retained file after unlink and respects stripped rights", () => {
  const fs = new MemFS();
  const target = file(fs);
  const host = modeHost(fs);
  const fileModeRight = RIGHT_FD_FILESTAT_SET_MODE;
  const base = RIGHT_FD_READ | RIGHT_FD_FILESTAT_SET_TIMES;
  const other = host.openRaw(3, "file", { base, inheriting: 0n });
  expect(other.errno).toBe(0);
  expect(host.setFdMode(other.fd, 0o640)).toBe(76);
  const retained = host.openRaw(3, "file", { base: base | fileModeRight, inheriting: 0n });
  expect(retained.errno).toBe(0);
  const path = fs.resolveAbsolute("/file");
  if (typeof path === "number") throw new Error(`resolve errno ${path}`);
  expect(fs.removePath(path, false)).toBe(0);
  expect(host.setFdMode(retained.fd, 0o640)).toBe(0);
  expect(fs.stat(target)).toMatchObject({ mode: 0o640, nlink: 0 });
  expect(host.setRights(retained.fd, base, 0n)).toBe(0);
  expect(host.setFdMode(retained.fd, 0o600)).toBe(76);
  expect(
    host.openRaw(3, `dev/fd/${retained.fd}`, { base: fileModeRight, inheriting: 0n }).errno,
  ).toBe(76);
  expect(host.wasi.fdReopen(retained.fd, 0, 0, fileModeRight, 128)).toBe(76);
  expect(fs.stat(target).mode).toBe(0o640);
});

test("the path mode right works independently of file-stat and data access", () => {
  const fs = new MemFS();
  const target = file(fs, "/dir/file");
  const dir = fs.handleForNode(fs.lookup("/dir")!);
  const host = modeHost(fs);
  expect(host.setRights(3, RIGHT_PATH_FILESTAT_SET_MODE, 0n)).toBe(0);
  expect(host.setPathMode("dir", 0o1777)).toBe(0);
  expect(fs.stat(dir).mode).toBe(0o1777);
  expect(host.setPathMode("dir", 0o666)).toBe(0);
  expect(host.setPathMode("dir/file", 0o700)).toBe(2);
  expect(fs.stat(target).mode).toBe(0o600);
  expect(host.setPathMode("dir", 0o700)).toBe(0);
  expect(host.setPathMode("dir/file", 0o700)).toBe(0);
  expect(fs.stat(target).mode).toBe(0o700);
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
  b.retain(pathB.node);
  cleanup.push(() => b.release(pathB.node));
  expect(first.client.owner).not.toBe(second.client.owner);
  expect(await a.asyncCall("setMode", [pathA.node, 0o400])).toBe(0);
  expect(await a.asyncCall("permissions", [pathA.node])).toEqual(
    await b.asyncCall("permissions", [pathB.node]),
  );
  expect(b.permissions(pathB.node)?.access).toBe(4);
  const denied = await b
    .asyncCall("write", [pathB.node, 0], new Uint8Array([1]))
    .catch((error) => error);
  expect(denied).toMatchObject({ errno: 2 });
  expect(b.write(pathB.node, [new Uint8Array([1])], 0)).toBe(-2);
});

test("actual Wasm query distinguishes missing, denied, unsupported and capability errors", async () => {
  const { permissionsHost } = await import("./fixtures/permissions-guest.js");
  const fs = new MemFS();
  const handle = file(fs, "/dir/file");
  fs.mkdirp("/tmp");
  fs.mkdirp("/bin");
  const host = permissionsHost(fs);
  cleanup.push(() => host.wasi.descriptors.dispose());
  expect(host.call("dir/file")).toBe(0);
  expect(host.words()).toEqual([0o600, 0o777, 6, 6]);
  expect(host.call("tmp")).toBe(0);
  expect(host.words()).toEqual([0o700, 0o1777, 7, 7]);
  expect(host.call("bin")).toBe(0);
  expect(host.words()).toEqual([0o700, 0o1777, 7, 7]);
  expect(fs.setMode(handle, 0)).toBe(0);
  expect(host.call("dir/file")).toBe(0);
  expect(host.words()).toEqual([0, 0o777, 0, 6]);
  const bytes = new Uint8Array(host.memory.buffer);
  bytes.fill(0xa5, 512, 592);
  const unchanged = Array.from(bytes.subarray(512, 592));
  const failures = [
    ["absent", 0, 3, 512, 44],
    ["absent/child", 0, 3, 512, 44],
    ["dir/file", 2, 3, 512, 58],
    ["dir/file", 0, 999, 512, 8],
    ["dir/file", 0, 3, 65530, 21],
    ["dir/\0file", 0, 3, 512, 28],
    ["/dir/file", 0, 3, 512, 63],
    ["", 0, 3, 512, 28],
  ] as const;
  for (const [path, flags, fd, out, error] of failures) {
    expect(host.call(path, flags, fd, out)).toBe(error);
    expect(Array.from(bytes.subarray(512, 592))).toEqual(unchanged);
  }
  bytes.set([0xff], 256);
  expect(Number(host.query(3, 256, 1, 0, 512))).toBe(28);
  expect(Array.from(bytes.subarray(512, 592))).toEqual(unchanged);
  const dir = fs.handleForNode(fs.lookup("/dir")!);
  expect(fs.setMode(dir, 0o600)).toBe(0);
  expect(host.call("dir/file")).toBe(2);
  expect(Array.from(bytes.subarray(512, 592))).toEqual(unchanged);
  expect(host.call("dir/../tmp")).toBe(2);
  expect(Array.from(bytes.subarray(512, 592))).toEqual(unchanged);
  expect(host.call("dir")).toBe(0);
  expect(host.words()).toEqual([0o600, 0o1777, 6, 7]);
  bytes.fill(0xa5, 512, 592);
  host.wasi.descriptors.get(3)!.rightsBase = 0n;
  expect(host.call("dir/file")).toBe(76);
  expect(Array.from(bytes.subarray(512, 592))).toEqual(unchanged);
});

test("WASI permission queries use the requested final symlink lookup", async () => {
  const { permissionsHost } = await import("./fixtures/permissions-guest.js");
  const fs = new MemFS();
  const target = file(fs, "/target");
  expect(fs.setMode(target, 0o400)).toBe(0);
  for (const [path, destination] of [
    ["/link", "target"],
    ["/dangling", "absent"],
  ] as const) {
    const resolved = fs.resolveAbsolute(path);
    if (typeof resolved === "number") throw new Error(`resolve errno ${resolved}`);
    expect(fs.symlink(resolved, destination)).toBe(0);
  }
  const host = permissionsHost(fs);
  cleanup.push(() => host.wasi.descriptors.dispose());
  expect(host.call("link", 0)).toBe(0);
  expect(host.words()[0]).toBe(0o600);
  expect(host.call("link", 1)).toBe(0);
  expect(host.words()).toEqual([0o400, 0o777, 4, 6]);
  expect(host.call("dangling", 0)).toBe(0);
  expect(host.call("dangling", 1)).toBe(44);
});

test("query reports an adapter without metadata as unsupported and leaves output intact", async () => {
  const { permissionsHost } = await import("./fixtures/permissions-guest.js");
  const fs = new MemFS();
  file(fs);
  Object.defineProperty(fs, "permissions", { value: undefined });
  const host = permissionsHost(fs);
  cleanup.push(() => host.wasi.descriptors.dispose());
  new Uint8Array(host.memory.buffer).fill(0xa5, 512, 528);
  expect(host.call("file")).toBe(58);
  expect(host.words()).toEqual(Array(4).fill(0xa5a5a5a5));
});

test("a live worker cannot reuse cached direct I/O grants after mode change", async () => {
  const backend = new MemoryBackend();
  file(backend.fs);
  const service = new FilesystemService(backend);
  cleanup.push(() => service.dispose());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const worker = new Worker(
    new URL("./fixtures/filesystem-permissions-worker.ts", import.meta.url).href,
  );
  cleanup.push(() => worker.terminate());
  function next() {
    return new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = reject;
    });
  }
  const ready = next();
  worker.postMessage(connection.client, [connection.client.port]);
  const announcement = await ready;
  if (!announcement || typeof announcement !== "object" || !("cached" in announcement))
    throw new Error("missing cached worker handle");
  const { cached } = announcement;
  if (typeof cached !== "number") throw new Error("invalid cached worker handle");
  expect(backend.execute("setMode", [cached, 0], new Uint8Array())).toBe(0);
  const result = next();
  worker.postMessage({ inspect: true });
  expect(await result).toEqual({
    errno: 0,
    words: [0, 0o777, 0, 6],
    permissions: { mode: 0, modeSupported: 0o777, access: 0, accessSupported: 6 },
    read: -2,
    write: -2,
    resize: 2,
    prior: Array.from(new TextEncoder().encode("secret")),
    chmod: 0,
  });
  expect(backend.shared.snapshot(cached)?.data).toEqual(new TextEncoder().encode("secret"));
  expect(backend.shared.stat(cached)?.mode).toBe(0o001);
});

test("WASI propagates inode directory denial separately from descriptor rights", async () => {
  const { atomicHost } = await import("./fixtures/wasi-atomic-host.js");
  const fs = new MemFS();
  const handle = file(fs);
  const h = atomicHost(fs);
  cleanup.push(() => h.wasi.descriptors.dispose());
  expect(fs.setMode(handle, 0o400)).toBe(0);
  expect(h.open("file").error).toBe(2);
  const entry = h.wasi.descriptors.get(3)!;
  entry.rightsBase = 0n;
  expect(h.open("file").error).toBe(76);
});

test("permission query snapshots UTF-8 paths from shared guest memory", async () => {
  const { permissionsHost } = await import("./fixtures/permissions-guest.js");
  const fs = new MemFS();
  file(fs, "/café");
  const host = permissionsHost(fs, true);
  cleanup.push(() => host.wasi.descriptors.dispose());
  expect(host.call("café")).toBe(0);
  expect(host.words()).toEqual([0o600, 0o777, 6, 6]);
});

test("directory namespace denial retains EACCES through host creation", () => {
  const backend = new MemoryBackend();
  backend.fs.mkdirp("/locked");
  const directory = backend.fs.handleForNode(backend.fs.lookup("/locked")!);
  backend.execute("setMode", [directory, 0o500], new Uint8Array());
  expect(() =>
    backend.execute("writeFile", ["/locked/missing/file", false, true], new Uint8Array([1])),
  ).toThrow("errno 2");
});

test("WASI directory listing separates inode denial from capability denial", async () => {
  const { atomicHost } = await import("./fixtures/wasi-atomic-host.js");
  const fs = new MemFS();
  const node = fs.mkdirp("/dir");
  const host = atomicHost(fs);
  cleanup.push(() => host.wasi.descriptors.dispose());
  const opened = host.open("dir");
  expect(opened.error).toBe(0);
  expect(fs.setMode(fs.handleForNode(node), 0o300)).toBe(0);
  expect(host.calls.fd_readdir!(opened.fd, 1024, 128, 0n, 2048)).toBe(2);
  host.wasi.descriptors.get(opened.fd)!.rightsBase = 0n;
  expect(host.calls.fd_readdir!(opened.fd, 1024, 128, 0n, 2048)).toBe(76);
  expect(host.errors).toEqual([]);
});

test("denied host replacement does not grow or alter a cached shared file", () => {
  const backend = new MemoryBackend();
  const handle = file(backend.fs);
  backend.execute("stat", [handle], new Uint8Array());
  backend.execute("setMode", [handle, 0o400], new Uint8Array());
  const before = backend.shared.resources();
  expect(() => backend.execute("writeFile", ["/file"], new Uint8Array(1024 * 1024))).toThrow(
    "errno 2",
  );
  expect(backend.shared.resources()).toEqual(before);
  expect(backend.shared.snapshot(handle)?.data).toEqual(new TextEncoder().encode("secret"));
});

for (const append of [false, true]) {
  test(`host ${append ? "append" : "overwrite"} requires search on the immediate parent`, () => {
    const fs = new MemFS();
    const handle = file(fs, "/locked/file");
    const directory = fs.handleForNode(fs.lookup("/locked")!);
    expect(fs.setMode(directory, 0o600)).toBe(0);
    expect(fs.resolve(fs.preopen("/"), "locked/file")).toBe(2);
    expect(() => fs.writeFile("/locked/file", "after", append)).toThrow("errno 2");
    expect(fs.setMode(directory, 0o700)).toBe(0);
    expect(fs.read(handle, [new Uint8Array(6)], 0)).toBe(6);
    expect(new TextDecoder().decode(fs.readFile("/locked/file"))).toBe("secret");
    expect(fs.permissions(handle).mode).toBe(0o600);
  });
}

for (const shared of [false, true]) {
  test(`permission query preserves filename BOM with shared=${shared}`, async () => {
    const { permissionsHost } = await import("./fixtures/permissions-guest.js");
    const fs = new MemFS();
    file(fs, "/file");
    const handle = file(fs, "/\ufefffile");
    expect(fs.setMode(handle, 0)).toBe(0);
    const host = permissionsHost(fs, shared);
    cleanup.push(() => host.wasi.descriptors.dispose());
    expect(host.call("\ufefffile")).toBe(0);
    expect(host.words()).toEqual([0, 0o777, 0, 6]);
    expect(host.call("file")).toBe(0);
    expect(host.words()).toEqual([0o600, 0o777, 6, 6]);
  });
}
