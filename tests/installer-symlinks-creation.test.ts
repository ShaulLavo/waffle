import { afterEach, expect, test } from "bun:test";
import { SharedFilesystem } from "../browser/shared-fs.js";
import { FilesystemError } from "../core/filesystem.js";
import { Wasi } from "../core/wasi.js";
import { MemFS, type Node } from "../fs/memory.js";
import {
  filesystemServiceFixture,
  symlinkSnapshotValue,
} from "./fixtures/installer-symlinks-support.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

const cleanup: (() => void | Promise<void>)[] = [];
const encoder = new TextEncoder();
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
function resolved(fs: MemFS, path: string) {
  const value = fs.resolveAbsolute(path);
  if (typeof value === "number") throw new FilesystemError(value);
  return value;
}
function link(fs: MemFS, path: string, target: string) {
  expect(fs.symlink(resolved(fs, path), target)).toBe(0);
}
function seed() {
  const fs = new MemFS();
  fs.writeFile("/a/b/note.txt", "ordinary text");
  fs.mkdirp("/a/base");
  link(fs, "/link", "a/b");
  link(fs, "/relay", "a");
  link(fs, "/nested", "relay/base");
  link(fs, "/nested-bad", "relay/target-missing");
  link(fs, "/bad", "a/missing/dir");
  link(fs, "/last", "a/missing");
  link(fs, "/file-leaf", "./a//b/../new.txt");
  link(fs, "/file-bad", "a/absent/new.txt");
  link(fs, "/file-link", "a/b/note.txt");
  const reset = (node: Node) => {
    node.mtime = 1;
    if (node.kind === "dir") for (const child of node.children.values()) reset(child);
  };
  reset(fs.root);
  return fs;
}
function snapshot(fs: MemFS) {
  const entries: unknown[] = [];
  const counts = new Map<number, number>();
  const visit = (node: Node, path: string) => {
    counts.set(node.ino, (counts.get(node.ino) ?? 0) + 1);
    entries.push({
      path,
      ino: node.ino,
      mode: node.mode,
      mtime: node.mtime,
      identity: node.identity && { ...node.identity },
      kind: node.kind,
      value: symlinkSnapshotValue(node),
    });
    if (node.kind !== "dir") return;
    for (const [name, child] of node.children) visit(child, `${path}/${name}`);
  };
  visit(fs.root, "");
  return { entries, links: Array.from(counts) };
}
function service(fs: MemFS) {
  return filesystemServiceFixture(fs, (stop) => cleanup.push(stop));
}
function fixture(mode: "direct" | "planned" | "service") {
  const fs = seed();
  const remote = mode === "service" ? service(fs) : undefined;
  const changes: number[] = [],
    links: { ino: number; delta: number }[] = [];
  const oldChange = fs.onChange,
    oldLink = fs.onLinkChange;
  fs.onChange = (node) => {
    changes.push(node.ino);
    oldChange?.(node);
  };
  fs.onLinkChange = (node, delta) => {
    links.push({ ino: node.ino, delta });
    oldLink?.(node, delta);
  };
  const mkdirp = async (path: string) => {
    if (remote) return remote.client.asyncCall("mkdirp", [path]);
    if (mode === "direct") return fs.mkdirp(path);
    const prepared = fs.planMkdirp(path, 1000);
    fs.applyNamespace(prepared.plan);
    return prepared.node;
  };
  const write = async (path: string, exclusive = false) => {
    if (remote)
      return remote.client.asyncCall(
        "writeFile",
        [path, false, exclusive],
        encoder.encode("new text"),
      );
    if (!exclusive && mode === "direct") return fs.writeFile(path, "new text");
    const prepared = fs.planHostFile(path, exclusive, 1000);
    fs.applyNamespace(prepared.plan);
    prepared.node.data = encoder.encode("new text");
  };
  const preopen = async (path: string) =>
    remote ? remote.client.asyncCall("preopen", [path]) : fs.preopen(path);
  const state = () => ({
    tree: snapshot(fs),
    shared:
      remote &&
      fs.listFiles().map((path) => {
        const node = fs.lookup(path);
        if (node?.kind !== "file") throw new Error("missing snapshot file");
        const handle = fs.handleForNode(node);
        if (!remote.backend.shared.hasFile(handle))
          return { kind: "seed", stat: fs.stat(handle), bytes: Array.from(node.data) };
        const stat = remote.backend.shared.stat(handle);
        if (!stat) throw new Error("missing shared file stat");
        const bytes = new Uint8Array(stat.size);
        expect(remote.backend.shared.read(handle, [bytes], 0)).toBe(stat.size);
        return { kind: "shared", stat, bytes: Array.from(bytes) };
      }),
  });
  const read = async (path: string): Promise<Uint8Array | undefined> =>
    remote ? remote.client.asyncCall("readFile", [path]) : fs.readFile(path);
  return { fs, remote, mkdirp, write, preopen, read, changes, links, state };
}
type Fixture = ReturnType<typeof fixture>;
async function expectErrno(action: () => Promise<unknown>, errno: number) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ errno });
}
async function rejected(f: Fixture, action: () => Promise<unknown>, errno: number) {
  const before = f.state(),
    changes = f.changes.slice(),
    links = f.links.slice();
  await expectErrno(action, errno);
  expect(f.state()).toEqual(before);
  expect(f.changes).toEqual(changes);
  expect(f.links).toEqual(links);
}
const modes = ["direct", "planned", "service"] satisfies ("direct" | "planned" | "service")[];

test.each(modes)(
  "D3 %s refuses missing target directories with no attached pending nodes",
  async (mode) => {
    const f = fixture(mode);
    for (const path of ["/last", "/bad", "/bad/explicit", "/nested-bad/new", "/fresh/../bad"])
      await rejected(f, () => f.mkdirp(path), 44);
    expect(f.fs.lookup("/fresh")).toBeUndefined();
    expect(f.fs.lookup("/a/missing")).toBeUndefined();
    expect(f.fs.lookup("/a/target-missing")).toBeUndefined();
  },
);

test.each(modes)("D3 %s creates explicit suffixes after existing nested targets", async (mode) => {
  const f = fixture(mode),
    original = f.fs.lookup("/link", false),
    file = f.fs.lookup("/a/b/note.txt");
  await f.mkdirp("/nested/new/deep");
  await f.mkdirp("/link/../fresh/leaf");
  await f.write("/link/explicit/child.txt");
  expect(f.fs.lookup("/a/base/new/deep")?.kind).toBe("dir");
  expect(f.fs.lookup("/a/fresh/leaf")?.kind).toBe("dir");
  expect(f.fs.lookup("/fresh")).toBeUndefined();
  expect(new TextDecoder().decode(await f.read("/a/b/explicit/child.txt"))).toBe("new text");
  expect(f.fs.lookup("/link", false)).toBe(original);
  expect(f.fs.lookup("/a/b/note.txt")).toBe(file);
  expect(new TextDecoder().decode(f.fs.readFile("/a/b/note.txt"))).toBe("ordinary text");
  expect(original?.kind === "symlink" && original.target).toBe("a/b");
  expect(original?.mtime).toBe(1);
  expect(file?.mtime).toBe(1);
  expect(f.links).toHaveLength(6);
  expect(f.links.every((entry) => entry.delta === 1)).toBe(true);
  expect(new Set(f.links.map((entry) => entry.ino)).size).toBe(6);
  expect(f.fs.lookup("/a/base/new")?.mtime).toBeGreaterThan(1);
  expect(f.fs.lookup("/a/base")?.mtime).toBeGreaterThan(1);
});

test.each(modes)(
  "D3 %s permits a final file referent but not its missing parent chain",
  async (mode) => {
    const f = fixture(mode),
      leaf = f.fs.lookup("/file-leaf", false);
    await f.write("/file-leaf");
    expect(new TextDecoder().decode(await f.read("/a/new.txt"))).toBe("new text");
    expect(f.fs.lookup("/file-leaf", false)).toBe(leaf);
    expect(leaf?.kind === "symlink" && leaf.target).toBe("./a//b/../new.txt");
    expect(leaf?.mtime).toBe(1);
    await rejected(f, () => f.write("/file-bad"), 44);
    await rejected(f, () => f.write("/bad/explicit.txt"), 44);
    await rejected(f, () => f.write("/file-link", true), 20);
    await rejected(f, () => f.write("/file-bad", true), 20);
    await rejected(f, () => f.mkdirp("/file-link/child"), 54);
    await rejected(f, () => f.write("/file-link/child"), 54);
    await rejected(f, () => f.mkdirp("/file-link"), 54);
  },
);

test.each(modes)("D3 %s configured preopen uses the directory rule", async (mode) => {
  const f = fixture(mode);
  await rejected(f, () => f.preopen("/last"), 44);
  await rejected(f, () => f.preopen("/nested-bad/new"), 44);
  await f.preopen("/nested/configured");
  expect(f.fs.lookup("/a/base/configured")?.kind).toBe("dir");
});

test.each(modes)(
  "D3 %s keeps target suffix provenance across dotdot and absolute expansion",
  async (mode) => {
    const f = fixture(mode);
    link(f.fs, "/target-dot", "./a//b/../missing");
    link(f.fs, "/absolute-bad", "/a/absent");
    link(f.fs, "/absolute", "/a/b");
    await rejected(f, () => f.mkdirp("/target-dot/explicit"), 44);
    await rejected(f, () => f.mkdirp("/absolute-bad/explicit"), 44);
    link(f.fs, "/a/second", "base");
    await f.mkdirp("/link/../second/input");
    expect(f.fs.lookup("/a/base/input")?.kind).toBe("dir");
    await f.mkdirp("/absolute/../input");
    expect(f.fs.lookup("/a/input")?.kind).toBe("dir");
    expect(f.fs.lookup("/input")).toBeUndefined();
  },
);

test.each(modes)(
  "D3 %s preserves one 40-expansion allowance with explicit creation",
  async (mode) => {
    const f = fixture(mode);
    for (let index = 0; index < 41; index++)
      link(f.fs, `/chain${index}`, index === 40 ? "a/b" : `chain${index + 1}`);
    await f.mkdirp("/chain1/new");
    expect(f.fs.lookup("/a/b/new")?.kind).toBe("dir");
    await f.write("/chain1/new/explicit.txt");
    expect(new TextDecoder().decode(await f.read("/a/b/new/explicit.txt"))).toBe("new text");
    await rejected(f, () => f.mkdirp("/chain0/other"), 32);
    await rejected(f, () => f.write("/chain0/other/file.txt"), 32);
    link(f.fs, "/nested-limit", "chain1/target-missing");
    await rejected(f, () => f.mkdirp("/nested-limit/explicit"), 32);
  },
);

test("D3 planner keeps effect and access bounds before attachment", async () => {
  const f = fixture("planned");
  await rejected(f, async () => f.fs.planMkdirp("/fresh/deep", 3), 6);
  const parent = resolved(f.fs, "/a/base").node;
  if (parent === undefined) throw new Error("missing parent");
  expect(f.fs.setMode(parent, 0o500)).toBe(0);
  await rejected(f, () => f.mkdirp("/nested/new"), 2);
  await rejected(f, () => f.write("/nested/new.txt"), 2);
});

test("D3 direct explicit dot-parent convenience does not bypass the service missing-parent guard", async () => {
  const direct = fixture("direct"),
    remote = fixture("service");
  await direct.write("/explicit/../a/new.txt");
  expect(direct.fs.lookup("/explicit")?.kind).toBe("dir");
  expect(new TextDecoder().decode(direct.fs.readFile("/a/new.txt"))).toBe("new text");
  await rejected(remote, () => remote.write("/explicit/../a/new.txt"), 44);
});

function wasiFixture() {
  const fs = seed(),
    memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/sandbox": "/a" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  cleanup.push(() => wasi.descriptors.dispose());
  const module = guestModule("wasi_snapshot_preview1", [
    { name: "path_create_directory", parameters: ["i32", "i32", "i32"] },
    {
      name: "path_open",
      parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
    },
  ]);
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const bytes = new Uint8Array(memory.buffer),
    view = new DataView(memory.buffer);
  const put = (path: string) => {
    const value = encoder.encode(path);
    bytes.set(value, 2048);
    return value.length;
  };
  const mkdir = (path: string) =>
    guestFunction(instance, "path_create_directory")(3, 2048, put(path));
  const open = (path: string, flags = 1) =>
    guestFunction(instance, "path_open")(3, 1, 2048, put(path), flags, 66n, 0n, 0, 128);
  return { fs, wasi, bytes, view, mkdir, open };
}

test("D3 ordinary Wasm mkdir stays nonrecursive under an actual nonroot preopen", () => {
  const f = wasiFixture();
  link(f.fs, "/a/dir-link", "b");
  link(f.fs, "/a/dir-bad", "absent/dir");
  const before = snapshot(f.fs);
  expect(f.mkdir("dir-bad/child")).toBe(44);
  expect(f.mkdir("dir-link/missing/child")).toBe(44);
  expect(f.mkdir("dir-bad")).toBe(20);
  expect(f.mkdir("../outside")).toBe(63);
  expect(snapshot(f.fs)).toEqual(before);
  expect(f.mkdir("dir-link/explicit")).toBe(0);
  expect(f.fs.lookup("/a/b/explicit")?.kind).toBe("dir");
});

test("D3 ordinary Wasm may create only a final file referent in its authorized existing parent", () => {
  const f = wasiFixture();
  link(f.fs, "/a/leaf", "b/new.txt");
  link(f.fs, "/a/missing-parent", "absent/new.txt");
  link(f.fs, "/a/outside", "../outside.txt");
  const before = snapshot(f.fs),
    descriptors = Array.from({ length: 12 }, (_unused, fd) => f.wasi.descriptors.get(fd));
  f.bytes.fill(0xcc, 128, 132);
  expect(f.open("missing-parent")).toBe(44);
  expect(f.open("outside")).toBe(63);
  expect(f.open("leaf", 5)).toBe(20);
  expect(f.bytes.slice(128, 132)).toEqual(new Uint8Array(4).fill(0xcc));
  expect(Array.from({ length: 12 }, (_unused, fd) => f.wasi.descriptors.get(fd))).toEqual(
    descriptors,
  );
  expect(snapshot(f.fs)).toEqual(before);
  expect(f.open("leaf")).toBe(0);
  expect(f.fs.lookup("/a/b/new.txt")?.kind).toBe("file");
  expect(f.fs.lookup("/a/leaf", false)?.kind).toBe("symlink");
});

test("D3 real page memory worker preserves creation policy and queued writes after refusal", async () => {
  const page = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  });
  cleanup.push(() => page.dispose());
  await page.writeFile("/a/b/note.txt", "ordinary text");
  const root: unknown = await page.client.asyncCall("preopen", ["/"]);
  if (typeof root !== "number") throw new Error("missing root handle");
  for (const [name, target] of [
    ["link", "a/b"],
    ["bad", "a/missing/dir"],
    ["leaf", "a/new.txt"],
  ]) {
    const path = await page.client.asyncCall("resolve", [root, name, false]);
    expect(await page.client.asyncCall("symlink", [path, target])).toBe(0);
  }
  const before = await page.lookup("/a");
  await expectErrno(() => page.mkdirp("/bad/explicit"), 44);
  await expectErrno(() => page.drain(), 44);
  expect(await page.lookup("/a")).toEqual(before);
  expect(await page.lookup("/a/missing")).toBeUndefined();
  expect(await page.lookup("/bad")).toMatchObject({ kind: "symlink", target: "a/missing/dir" });
  expect(new TextDecoder().decode(await page.readFile("/a/b/note.txt"))).toBe("ordinary text");
  await page.writeFile("/link/explicit/child.txt", "page text");
  await page.writeFile("/leaf", "leaf text");
  expect(new TextDecoder().decode(await page.readFile("/a/b/explicit/child.txt"))).toBe(
    "page text",
  );
  expect(new TextDecoder().decode(await page.readFile("/a/new.txt"))).toBe("leaf text");
  expect(await page.lookup("/link")).toMatchObject({ kind: "symlink", target: "a/b" });
  expect(new TextDecoder().decode(await page.readFile("/a/b/note.txt"))).toBe("ordinary text");
}, 10000);
