import { afterEach, expect, test } from "bun:test";
import { FilesystemError } from "../core/filesystem.js";
import { Wasi } from "../core/wasi.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { MemFS, type Node } from "../fs/memory.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

const cleanup: (() => void)[] = [];
const encoder = new TextEncoder();
const READ = 2n,
  WRITE = 64n;
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

function resolved(fs: MemFS, path: string, follow = false) {
  const value = fs.resolveAbsolute(path, follow);
  if (typeof value === "number") throw new FilesystemError(value);
  return value;
}
function handle(fs: MemFS, path: string) {
  const value = resolved(fs, path).node;
  if (value === undefined) throw new Error(`missing ${path}`);
  return value;
}
function link(fs: MemFS, path: string, target: string) {
  expect(fs.symlink(resolved(fs, path), target)).toBe(0);
}
function seed() {
  const fs = new MemFS();
  fs.writeFile("/a/b/note.txt", "ordinary text");
  fs.writeFile("/a/sibling.txt", "sibling text");
  fs.mkdirp("/empty");
  link(fs, "/link", "a/b");
  for (const path of ["/", "/a", "/a/b", "/a/b/note.txt", "/a/sibling.txt", "/empty", "/link"])
    expect(fs.setMtime(handle(fs, path), 1)).toBe(0);
  return fs;
}
function snapshot(fs: MemFS) {
  const entries: { path: string; node: number; kind: string; mtime: number; value: unknown }[] = [];
  const counts = new Map<number, number>();
  const visit = (node: Node, path: string) => {
    counts.set(node.ino, (counts.get(node.ino) ?? 0) + 1);
    entries.push({
      path,
      node: node.ino,
      kind: node.kind,
      mtime: node.mtime,
      value:
        node.kind === "file"
          ? Array.from(node.data)
          : node.kind === "symlink"
            ? node.target
            : Array.from(node.children.keys()),
    });
    if (node.kind !== "dir") return;
    for (const [name, child] of node.children) visit(child, `${path}/${name}`);
  };
  visit(fs.root, "");
  return { entries, links: Array.from(counts) };
}
function service(fs: MemFS) {
  const backend = new MemoryBackend(fs);
  const owner = new FilesystemService(backend);
  cleanup.push(() => owner.dispose());
  const connection = createFilesystemConnection();
  cleanup.push(
    () => connection.server.port.close(),
    () => connection.client.port.close(),
  );
  const client = new FilesystemClient(connection.client);
  cleanup.push(() => client.dispose());
  owner.connect(connection.server);
  return { client, backend };
}

test.each(["/link/", "/link///"])(
  "D1 no-follow metadata rejects final separators %s without effects",
  (path) => {
    const fs = seed(),
      before = snapshot(fs),
      root = fs.preopen("/");
    const linkHandle = handle(fs, "/link"),
      referent = handle(fs, "/a/b");
    expect(fs.resolve(root, path.slice(1), false)).toBe(54);
    expect(() => fs.lookup(path, false)).toThrow(new FilesystemError(54));
    expect(resolved(fs, path, true).node).toBe(referent);
    expect(resolved(fs, "/link").node).toBe(linkHandle);
    expect(fs.readlink(linkHandle)).toBe("a/b");
    expect(resolved(fs, "/link/.").node).toBe(referent);
    expect(resolved(fs, "/link/..").node).toBe(handle(fs, "/a"));
    expect(resolved(fs, "/a/b/..").node).toBe(handle(fs, "/a"));
    expect(snapshot(fs)).toEqual(before);
  },
);

test.each(["direct", "plan", "service"])(
  "D1 %s removal rejects link slash before selecting an edge",
  async (mode) => {
    const fs = seed();
    const remote = mode === "service" ? service(fs) : undefined;
    const changes: number[] = [],
      links: number[] = [];
    if (!remote) {
      fs.onChange = (node) => changes.push(node.ino);
      fs.onLinkChange = (_node, delta) => links.push(delta);
    }
    const before = snapshot(fs);
    const remove = async (path: string) => {
      if (remote) return remote.client.asyncCall("remove", [path]);
      if (mode === "direct") return fs.remove(path);
      const prepared = fs.planRemove(path, 100);
      fs.applyNamespace(prepared.plan);
      return prepared.result;
    };
    await expect(remove("/link///")).rejects.toMatchObject({ errno: 54 });
    expect(snapshot(fs)).toEqual(before);
    expect(changes).toEqual([]);
    expect(links).toEqual([]);
    expect(await remove("/missing/child")).toBe(false);
    expect(await remove("/missing")).toBe(false);
    expect(await remove("/")).toBe(false);
    expect(await remove("/link/.")).toBe(false);
    expect(await remove("/link/..")).toBe(false);
    expect(snapshot(fs)).toEqual(before);
    expect(await remove("/empty///")).toBe(true);
    expect(await remove("/link/../sibling.txt")).toBe(true);
    expect(fs.lookup("/a/sibling.txt")).toBeUndefined();
    expect(await remove("/link")).toBe(true);
    expect(fs.lookup("/link", false)).toBeUndefined();
    expect(new TextDecoder().decode(fs.readFile("/a/b/note.txt"))).toBe("ordinary text");
  },
);

test("D1 real service metadata and both move operands reject final link slash atomically", async () => {
  const fs = seed(),
    { client } = service(fs);
  const before = snapshot(fs);
  await expect(client.asyncCall("resolvePath", ["/link/"])).rejects.toMatchObject({ errno: 54 });
  await expect(client.asyncCall("lookup", ["/link///"])).rejects.toMatchObject({ errno: 54 });
  expect(await client.asyncCall("move", ["/link/", "/empty/moved"])).toBe(54);
  expect(snapshot(fs)).toEqual(before);
  expect(await client.asyncCall("move", ["/empty", "/link///"])).toBe(54);
  expect(snapshot(fs)).toEqual(before);
  expect(await client.asyncCall("resolvePath", ["/link/../sibling.txt"])).toEqual({
    path: "/a/sibling.txt",
    kind: "file",
  });
  expect(await client.asyncCall("move", ["/link", "/moved"])).toBe(0);
  expect(fs.readlink(handle(fs, "/moved"))).toBe("a/b");
  expect(fs.lookup("/link", false)).toBeUndefined();
  expect(new TextDecoder().decode(fs.readFile("/a/b/note.txt"))).toBe("ordinary text");
});

test("D1 bare rename replaces only the link edge and preserves its former referent", async () => {
  const fs = seed(),
    { client } = service(fs);
  const referent = fs.stat(handle(fs, "/a/b"));
  const contents = fs.stat(handle(fs, "/a/b/note.txt"));
  const source = fs.lookup("/a/sibling.txt");
  const beforeLinks = snapshot(fs).links;
  expect(await client.asyncCall("move", ["/a/sibling.txt", "/link"])).toBe(0);
  expect(fs.lookup("/link", false)).toBe(source);
  expect(fs.lookup("/a/sibling.txt")).toBeUndefined();
  expect(fs.stat(handle(fs, "/a/b"))).toEqual(referent);
  expect(fs.stat(handle(fs, "/a/b/note.txt"))).toEqual(contents);
  expect(snapshot(fs).links.find(([ino]) => ino === referent.ino)).toEqual(
    beforeLinks.find(([ino]) => ino === referent.ino),
  );
  expect(new TextDecoder().decode(fs.readFile("/a/b/note.txt"))).toBe("ordinary text");
});

function wasiFixture(preopens: Record<string, string> = { "/": "/" }) {
  const fs = seed(),
    memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens,
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  cleanup.push(() => wasi.descriptors.dispose());
  const module = guestModule("wasi_snapshot_preview1", [
    {
      name: "path_open",
      parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
    },
    { name: "path_filestat_get", parameters: ["i32", "i32", "i32", "i32", "i32"] },
    { name: "path_readlink", parameters: ["i32", "i32", "i32", "i32", "i32", "i32"] },
    { name: "path_unlink_file", parameters: ["i32", "i32", "i32"] },
    { name: "path_remove_directory", parameters: ["i32", "i32", "i32"] },
    { name: "path_rename", parameters: ["i32", "i32", "i32", "i32", "i32", "i32"] },
    { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
  ]);
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const call = (name: string, ...args: (number | bigint)[]) =>
    guestFunction(instance, name)(...args);
  const view = new DataView(memory.buffer),
    bytes = new Uint8Array(memory.buffer);
  const put = (path: string, at = 2048) => {
    const encoded = encoder.encode(path);
    bytes.set(encoded, at);
    return encoded.length;
  };
  const open = (path: string, follow = false, oflags = 0, flags = 0, dir = 3) =>
    call("path_open", dir, Number(follow), 2048, put(path), oflags, READ | WRITE, 0n, flags, 128);
  const read = (fd: number, length: number) => {
    view.setUint32(256, 4096, true);
    view.setUint32(260, length, true);
    expect(call("fd_read", fd, 256, 1, 264)).toBe(0);
    return new TextDecoder().decode(bytes.slice(4096, 4096 + view.getUint32(264, true)));
  };
  return { fs, wasi, call, view, bytes, put, open, read };
}
type WasiFixture = ReturnType<typeof wasiFixture>;
function fileResource(f: WasiFixture, fd: number) {
  const resource = f.wasi.descriptors.get(fd)?.resource;
  if (resource?.kind !== "file") throw new Error(`missing file descriptor ${fd}`);
  return resource;
}
function aliasFixture() {
  const f = wasiFixture();
  expect(f.open("a/b/note.txt")).toBe(0);
  const fd = f.view.getUint32(128, true);
  f.fs.mkdirp("/a/dev/fd");
  link(f.fs, "/deep", "a/b");
  link(f.fs, `/a/dev/fd/${fd}`, `../../../dev/fd/${fd}`);
  return { ...f, fd, candidate: `deep/../dev/fd/${fd}` };
}
function rejectOpen(f: WasiFixture, path: string, follow: boolean, oflags: number, errno: number) {
  const before = snapshot(f.fs);
  const descriptors = Array.from({ length: 16 }, (_unused, fd) => f.wasi.descriptors.get(fd));
  f.bytes.fill(0xcc, 128, 132);
  expect(f.open(path, follow, oflags)).toBe(errno);
  expect(f.bytes.slice(128, 132)).toEqual(new Uint8Array(4).fill(0xcc));
  expect(Array.from({ length: 16 }, (_unused, fd) => f.wasi.descriptors.get(fd))).toEqual(
    descriptors,
  );
  expect(snapshot(f.fs)).toEqual(before);
}

test("D1 Preview1 no-follow metadata and readlink slash leave output and namespace unchanged", () => {
  const f = wasiFixture(),
    before = snapshot(f.fs);
  f.bytes.fill(0xcc, 512, 1024);
  expect(f.call("path_filestat_get", 3, 0, 2048, f.put("link///"), 512)).toBe(54);
  expect(f.bytes.slice(512, 576)).toEqual(new Uint8Array(64).fill(0xcc));
  expect(f.call("path_readlink", 3, 2048, f.put("link/"), 640, 64, 768)).toBe(54);
  expect(f.bytes.slice(640, 704)).toEqual(new Uint8Array(64).fill(0xcc));
  expect(f.view.getUint32(768, true)).toBe(0xcccccccc);
  expect(f.call("path_filestat_get", 3, 1, 2048, f.put("link///"), 512)).toBe(0);
  expect(f.view.getUint8(528)).toBe(3);
  expect(f.call("path_readlink", 3, 2048, f.put("link"), 640, 64, 768)).toBe(0);
  expect(new TextDecoder().decode(f.bytes.slice(640, 643))).toBe("a/b");
  expect(snapshot(f.fs)).toEqual(before);
});

test("D1 Preview1 rejects slash unlink, rmdir and either rename operand before effects", () => {
  const f = wasiFixture(),
    before = snapshot(f.fs);
  expect(f.call("path_unlink_file", 3, 2048, f.put("link/"))).toBe(54);
  expect(f.call("path_remove_directory", 3, 2048, f.put("link///"))).toBe(54);
  expect(f.call("path_rename", 3, 2048, f.put("link/"), 3, 3072, f.put("empty/moved", 3072))).toBe(
    54,
  );
  expect(snapshot(f.fs)).toEqual(before);
  expect(f.call("path_rename", 3, 2048, f.put("empty"), 3, 3072, f.put("link/", 3072))).toBe(54);
  expect(snapshot(f.fs)).toEqual(before);
  expect(f.call("path_remove_directory", 3, 2048, f.put("link/.."))).toBe(28);
  expect(f.call("path_remove_directory", 3, 2048, f.put("empty///"))).toBe(0);
  expect(f.call("path_unlink_file", 3, 2048, f.put("link"))).toBe(0);
  expect(new TextDecoder().decode(f.fs.readFile("/a/b/note.txt"))).toBe("ordinary text");
});

test.each([
  { suffix: "", follow: false, oflags: 8, errno: 32 },
  { suffix: "", follow: false, oflags: 5, errno: 20 },
  { suffix: "", follow: true, oflags: 5, errno: 20 },
  { suffix: "///", follow: false, oflags: 8, errno: 54 },
  { suffix: "/", follow: false, oflags: 5, errno: 54 },
])("D2 actual-final real alias link policy %j", ({ suffix, follow, oflags, errno }) => {
  const f = aliasFixture();
  const source = fileResource(f, f.fd),
    description = f.wasi.descriptors.get(f.fd)?.description;
  rejectOpen(f, f.candidate + suffix, follow, oflags, errno);
  expect(fileResource(f, f.fd)).toBe(source);
  expect(f.wasi.descriptors.get(f.fd)?.description).toBe(description);
  expect(source.offset).toBe(0);
  expect(source.fdflags).toBe(0);
});

test("D2 ordinary real-final text link has matching no-follow and exclusive errors", () => {
  const f = wasiFixture();
  link(f.fs, "/text-link", "a/b/note.txt");
  rejectOpen(f, "text-link", false, 8, 32);
  rejectOpen(f, "text-link", false, 5, 20);
  rejectOpen(f, "text-link", true, 5, 20);
  rejectOpen(f, "text-link///", false, 8, 54);
  expect(f.open("text-link", true)).toBe(0);
  expect(f.read(f.view.getUint32(128, true), 64)).toBe("ordinary text");
});

test("D2 explicit follow and direct virtual aliases keep identity, flags and independent offsets", () => {
  const f = aliasFixture();
  expect(f.read(f.fd, 2)).toBe("or");
  expect(f.open(f.candidate, true, 0, 5)).toBe(0);
  const followed = f.view.getUint32(128, true);
  expect(fileResource(f, followed).handle).toBe(fileResource(f, f.fd).handle);
  expect(fileResource(f, followed).fdflags).toBe(5);
  expect(fileResource(f, f.fd).fdflags).toBe(0);
  expect(f.wasi.descriptors.get(followed)?.description).not.toBe(
    f.wasi.descriptors.get(f.fd)?.description,
  );
  expect(f.read(followed, 8)).toBe("ordinary");
  expect(fileResource(f, f.fd).offset).toBe(2);
  expect(f.open(`dev/fd/${f.fd}`, false)).toBe(0);
  expect(f.read(f.view.getUint32(128, true), 8)).toBe("ordinary");
  rejectOpen(f, `dev/fd/${f.fd}`, false, 5, 28);
});

test("D2 a real link with dot suffix remains intermediate and shares the 40 expansion budget", () => {
  const f = aliasFixture();
  const intermediate = `deep/./../../dev/fd/${f.fd}`;
  expect(f.open(intermediate, false)).toBe(0);
  for (let index = 0; index < 40; index++)
    link(f.fs, `/chain${index}`, index === 39 ? "a/b" : `chain${index + 1}`);
  expect(f.open(`chain1/../dev/fd/${f.fd}`, true)).toBe(0);
  rejectOpen(f, `chain0/../dev/fd/${f.fd}`, true, 8, 32);
});

test("D2 no-follow slash rejects a real final link to a virtual directory alias", () => {
  const f = aliasFixture();
  expect(f.open("a/b")).toBe(0);
  const directory = f.view.getUint32(128, true);
  link(f.fs, `/a/dev/fd/${directory}`, `../../../dev/fd/${directory}`);
  rejectOpen(f, `deep/../dev/fd/${directory}///`, false, 0, 54);
});

test.each([0, 1, 2])(
  "r34 ordinary explicit-follow final directory-link slash opens without namespace effects, oflags=%i",
  (oflags) => {
    const f = wasiFixture(),
      before = snapshot(f.fs),
      referent = handle(f.fs, "/a/b");
    f.bytes.fill(0xcc, 128, 132);
    expect(f.open("link///", true, oflags)).toBe(0);
    const fd = f.view.getUint32(128, true);
    expect(fd).toBe(4);
    expect(f.wasi.descriptors.get(fd)?.resource).toEqual({ kind: "directory", handle: referent });
    expect(f.wasi.descriptors.get(fd)?.rightsBase).toBe(READ | WRITE);
    expect(f.wasi.descriptors.get(fd)?.rightsInheriting).toBe(0n);
    expect(snapshot(f.fs)).toEqual(before);
  },
);

test.each([
  { path: "link/", follow: false, oflags: 0, errno: 54 },
  { path: "link///", follow: false, oflags: 2, errno: 54 },
  { path: "link/", follow: false, oflags: 5, errno: 54 },
  { path: "link/", follow: true, oflags: 5, errno: 54 },
  { path: "link", follow: false, oflags: 0, errno: 32 },
  { path: "link", follow: false, oflags: 8, errno: 32 },
  { path: "link", follow: false, oflags: 5, errno: 20 },
  { path: "link", follow: true, oflags: 5, errno: 20 },
  { path: "link/", follow: true, oflags: 8, errno: 31 },
])("r34 ordinary final-directory-link flags retain errno and reject before effects %j", (row) => {
  const f = wasiFixture();
  rejectOpen(f, row.path, row.follow, row.oflags, row.errno);
});

test.each([
  { path: "a/b///", target: "/a/b", follow: false },
  { path: "a/b///", target: "/a/b", follow: true },
  { path: "link/.", target: "/a/b", follow: false },
  { path: "link/..", target: "/a", follow: false },
])("r34 ordinary directories and actual-parent suffixes retain open identity %j", (row) => {
  const f = wasiFixture(),
    before = snapshot(f.fs);
  expect(f.open(row.path, row.follow, 2)).toBe(0);
  expect(f.wasi.descriptors.get(f.view.getUint32(128, true))?.resource).toEqual({
    kind: "directory",
    handle: handle(f.fs, row.target),
  });
  expect(snapshot(f.fs)).toEqual(before);
});

test("r34 ordinary explicit-follow slash uses the existing 40-expansion bound", () => {
  const f = wasiFixture();
  for (let index = 0; index < 41; index++)
    link(f.fs, `/ordinary${index}`, index === 40 ? "a/b" : `ordinary${index + 1}`);
  const before = snapshot(f.fs);
  expect(f.open("ordinary1/", true, 2)).toBe(0);
  expect(f.wasi.descriptors.get(f.view.getUint32(128, true))?.resource).toEqual({
    kind: "directory",
    handle: handle(f.fs, "/a/b"),
  });
  expect(snapshot(f.fs)).toEqual(before);
  rejectOpen(f, "ordinary0/", true, 8, 32);
});
