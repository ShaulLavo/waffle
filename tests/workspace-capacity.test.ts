import { expect, test } from "bun:test";
import {
  createFilesystemConnection,
  createWorkspaceVfs,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  PersistentBackend,
  WORKSPACE_LIMITS,
  type NamespaceEntry,
  type SnapshotCursor,
} from "../fs";
import { MemFS, type Node } from "../fs/memory";
import type { PersistedIndex, PersistedNode } from "../fs/storage";
import { NamespaceAuthority } from "../fs/workspace-namespace";
import { SIZES } from "../tooling/vfs-workloads";

function fixture(backend = new MemoryBackend()) {
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const workspace = createWorkspaceVfs(client);
  return {
    backend,
    service,
    client,
    workspace,
    port: pair.server.port,
    async close() {
      await workspace.close();
      client.dispose();
      service.dispose();
      if (backend instanceof PersistentBackend) await backend.close();
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

function flat(count: number) {
  const fs = new MemFS();
  for (let index = 0; index < count; index++) fs.writeFile(`/f${index}`, new Uint8Array());
  return fs;
}

function resident(current: Fixture, node: Node) {
  const fs = current.backend.fs;
  const handle = fs.handleForNode(node);
  current.backend.shared.register(
    handle,
    fs.stat(handle),
    undefined,
    true,
    current.backend.ensureIdentity(node),
  );
  return handle;
}

function observe(current: Fixture) {
  const shared = current.backend.shared;
  const stat = shared.stat.bind(shared),
    identity = shared.identity.bind(shared);
  const handles = shared.registeredHandles.bind(shared);
  const register = current.backend.fs.handleForNode.bind(current.backend.fs);
  let stats = 0,
    identities = 0,
    arrays = 0,
    registrations = 0;
  shared.stat = (...args) => {
    stats++;
    return stat(...args);
  };
  shared.identity = (...args) => {
    identities++;
    return identity(...args);
  };
  shared.registeredHandles = () => {
    arrays++;
    return handles();
  };
  current.backend.fs.handleForNode = (node) => {
    registrations++;
    return register(node);
  };
  return {
    counts: () => ({ stats, identities, arrays, registrations }),
    reset() {
      stats = 0;
      identities = 0;
      arrays = 0;
      registrations = 0;
    },
    restore() {
      shared.stat = stat;
      shared.identity = identity;
      shared.registeredHandles = handles;
      current.backend.fs.handleForNode = register;
    },
  };
}

function released(current: Fixture) {
  expect(current.service.resources()).toMatchObject({ workspaceCursors: 0, responses: 0 });
  expect(current.client.completions.size).toBe(0);
}

async function collect(cursor: SnapshotCursor) {
  let entries: NamespaceEntry[] = [];
  try {
    for (;;) {
      const page = await cursor.next();
      if (page.kind === "complete") return { entries, cut: page.cut };
      if (page.kind !== "entries") throw new Error(`unexpected ${page.kind}`);
      entries = entries.concat(page.entries);
    }
  } finally {
    await cursor.close();
  }
}

function hold(port: MessagePort) {
  const post = port.postMessage.bind(port);
  const ready = Promise.withResolvers<void>();
  let response: unknown;
  port.postMessage = (value: unknown) => {
    port.postMessage = post;
    response = value;
    ready.resolve();
  };
  return {
    ready: ready.promise,
    release() {
      port.postMessage = post;
      post(response);
    },
  };
}

test("public pulls resolve only page metadata, never a resident handle census", async () => {
  const current = fixture(new MemoryBackend(flat(2048)));
  for (const node of current.backend.fs.root.children.values()) resident(current, node);
  const baseline = current.service.resources();
  const reads = observe(current);
  const cursor = current.workspace.snapshot();
  let records = 0,
    pages = 0;
  try {
    for (;;) {
      reads.reset();
      const page = await cursor.next();
      expect(reads.counts().arrays).toBe(0);
      expect(reads.counts().registrations).toBe(0);
      expect(reads.counts().stats).toBeLessThanOrEqual(WORKSPACE_LIMITS.pageEntries);
      expect(reads.counts().identities).toBeLessThanOrEqual(WORKSPACE_LIMITS.pageEntries);
      if (page.kind === "complete") break;
      if (page.kind !== "entries") throw new Error(`unexpected ${page.kind}`);
      records += page.entries.length;
      pages++;
      expect(page.entries.length).toBeLessThanOrEqual(WORKSPACE_LIMITS.pageEntries);
    }
    expect(records).toBe(2049);
    expect(pages).toBe(17);
    released(current);
    expect(current.service.resources().retained).toBe(baseline.retained);
  } finally {
    reads.restore();
    await cursor.close();
    await current.close();
  }
});

test("point metadata uses current shared identity, size, mode and timestamp for hardlinks", async () => {
  const current = fixture();
  try {
    await current.client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
    const root = await current.client.asyncCall("preopen", ["/"]);
    const from = await current.client.asyncCall("resolve", [root, "file"]);
    const to = await current.client.asyncCall("resolve", [root, "alias"]);
    expect(await current.client.asyncCall("link", [from, to])).toBe(0);
    const handle: number = from.node;
    current.client.retain(handle);
    expect(current.client.tryWrite(handle, [new Uint8Array([2, 3, 4])], 0)).toBe(3);
    expect(await current.client.asyncCall("setMtime", [handle, 123])).toBe(0);
    expect(await current.client.asyncCall("setMode", [handle, 0o400])).toBe(0);
    const expected = current.backend.shared.identity(handle);
    const node = current.backend.fs.root.children.get("file")!;
    expect(node.kind === "file" && node.data.length).toBe(0);
    const complete = await collect(current.workspace.snapshot({ includeDirs: false }));
    expect(complete.entries).toHaveLength(2);
    for (const entry of complete.entries)
      expect(entry).toMatchObject({ ...expected, size: 3, mode: 0o400, mtime: 123 });
    current.client.release(handle);
    released(current);
  } finally {
    await current.close();
  }
});

test("point lookup neither registers never-opened nodes nor reopens released handles", async () => {
  const current = fixture(new MemoryBackend(flat(3)));
  const fs = current.backend.fs;
  const cold = fs.root.children.get("f0")!;
  const releasedNode = fs.root.children.get("f1")!;
  const releasedHandle = fs.handleForNode(releasedNode);
  fs.retain(releasedHandle);
  fs.release(releasedHandle);
  const noIdentity = fs.root.children.get("f2")!;
  const withoutIdentity = fs.handleForNode(noIdentity);
  current.backend.shared.register(withoutIdentity, { ...fs.stat(withoutIdentity), size: 99 });
  const reads = observe(current);
  try {
    const complete = await collect(current.workspace.snapshot());
    expect(complete.entries).toHaveLength(4);
    expect(fs.existingHandle(cold)).toBeUndefined();
    expect(fs.existingHandle(releasedNode)).toBe(releasedHandle);
    expect(() => fs.nodeForHandle(releasedHandle)).toThrow("unknown filesystem handle");
    expect(complete.entries.find((entry) => entry.path === "/f2")?.size).toBe(0);
    expect(reads.counts()).toMatchObject({ arrays: 0, registrations: 0 });
    released(current);
  } finally {
    reads.restore();
    await current.close();
  }
});

test("narrow and missing prefixes still seed all historical paths", async () => {
  const current = fixture();
  try {
    await current.client.asyncCall("writeFile", ["/dir/file"], new Uint8Array([1]));
    await current.client.asyncCall("writeFile", ["/dir2/file"], new Uint8Array([1]));
    const narrow = await collect(
      current.workspace.snapshot({ prefix: "/dir/../dir/", includeDirs: false }),
    );
    expect(narrow.entries.map((entry) => entry.path)).toEqual(["/dir/file"]);
    const missing = await collect(current.workspace.snapshot({ prefix: "/missing" }));
    expect(missing.entries).toHaveLength(0);
    await current.client.asyncCall("writeFile", ["/dir2/file"], new Uint8Array([9]));
    const change = await current.workspace.changes(missing.cut.watermark);
    if (change.kind !== "changes") throw new Error(`unexpected ${change.kind}`);
    expect(change.batches.flatMap((batch) => batch.changes)).toContainEqual(
      expect.objectContaining({ kind: "write", paths: ["/dir2/file"] }),
    );
    released(current);
  } finally {
    await current.close();
  }
});

test("shared directory permissions reject prefix and full scans and release slots", async () => {
  const fs = new MemFS();
  fs.writeFile("/dir/file", new Uint8Array());
  const current = fixture(new MemoryBackend(fs));
  const dir = fs.root.children.get("dir")!;
  const handle = resident(current, dir);
  try {
    current.backend.shared.setMode(handle, 0);
    expect(dir.mode).toBe(0o700);
    for (const prefix of ["/dir/file", "/"]) {
      const cursor = current.workspace.snapshot({ prefix });
      await expect(cursor.next()).rejects.toMatchObject({ errno: 2 });
      expect(await cursor.next()).toEqual({ kind: "cancelled" });
      released(current);
    }
  } finally {
    await current.close();
  }
});

test("two public cursors stay bounded and release independent slots on abort and close", async () => {
  const current = fixture(new MemoryBackend(flat(512)));
  const before = new AbortController();
  before.abort();
  const abort = new AbortController();
  const first = current.workspace.snapshot(undefined, abort.signal);
  const second = current.workspace.snapshot();
  try {
    expect(await current.workspace.snapshot(undefined, before.signal).next()).toEqual({
      kind: "cancelled",
    });
    expect(await current.workspace.snapshot().next()).toEqual({
      kind: "pressure",
      resource: "cursor",
    });
    expect((await second.next()).kind).toBe("entries");
    expect((await first.next()).kind).toBe("entries");
    expect(current.service.resources().workspaceCursors).toBe(2);
    abort.abort();
    await first.close();
    expect(await first.next()).toEqual({ kind: "cancelled" });
    expect(current.service.resources().workspaceCursors).toBe(1);
    await second.close();
    released(current);
    const fresh = await collect(current.workspace.snapshot());
    expect(fresh.entries).toHaveLength(513);
    released(current);
  } finally {
    await first.close();
    await second.close();
    await current.close();
  }
});

test("held public response cancellation joins cleanup and rejects late pages", async () => {
  const current = fixture(new MemoryBackend(flat(256)));
  const abort = new AbortController();
  const cursor = current.workspace.snapshot(undefined, abort.signal);
  const response = hold(current.port);
  try {
    const pending = cursor.next();
    await response.ready;
    expect(current.service.resources().workspaceCursors).toBe(1);
    abort.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    await cursor.close();
    released(current);
    response.release();
    expect(await cursor.next()).toEqual({ kind: "cancelled" });
    expect((await collect(current.workspace.snapshot())).entries).toHaveLength(257);
    released(current);
  } finally {
    response.release();
    await cursor.close();
    await current.close();
  }
});

test("publication restart releases a partial cursor; service teardown joins stopped cursors", async () => {
  const current = fixture(new MemoryBackend(flat(256)));
  const cursor = current.workspace.snapshot();
  try {
    expect((await cursor.next()).kind).toBe("entries");
    await current.client.asyncCall("writeFile", ["/new"], new Uint8Array([1]));
    const restart = await cursor.next();
    expect(restart.kind).toBe("restart");
    expect(await cursor.next()).toEqual(restart);
    released(current);
    const first = current.workspace.snapshot(),
      second = current.workspace.snapshot();
    expect((await first.next()).kind).toBe("entries");
    expect((await second.next()).kind).toBe("entries");
    current.backend.shared.publication!.stop();
    expect(await first.next()).toEqual({ kind: "stopped" });
    expect(await second.next()).toEqual({ kind: "stopped" });
    current.service.dispose();
    released(current);
  } finally {
    await cursor.close();
    await current.close();
  }
});

function storedTree(directories: number, filesPerDirectory: number, large = 0) {
  const nodes: PersistedNode[] = [];
  const root: PersistedNode = { ino: 1, kind: "dir", size: 0, mode: 0o700, mtime: 0, children: [] };
  nodes.push(root);
  for (let index = 0; index < directories; index++) {
    const name = `d${String(index).padStart(5, "0")}`;
    const directory: PersistedNode = {
      ino: nodes.length + 1,
      kind: "dir",
      size: 0,
      mode: 0o700,
      mtime: 0,
      children: [],
    };
    root.children!.push([name, directory.ino]);
    nodes.push(directory);
    addStoredFiles(nodes, directory, index * filesPerDirectory, filesPerDirectory);
    if (index < large) {
      const ino = nodes.length + 1;
      directory.children!.push(["large", ino]);
      nodes.push({
        ino,
        kind: "file",
        size: SIZES.W1.largeBytes,
        mode: 0o600,
        mtime: 0,
        data: `p${ino}`,
      });
    }
  }
  for (const node of nodes) {
    const token = ((1n << 64n) | BigInt(node.ino)).toString(16);
    node.identity = {
      format: "waffle-file-identity-v1",
      workspace: "a110ca7e-0000-4000-8000-000000000001",
      id: token,
      version: token,
    };
  }
  return { version: 1, generation: 1, root: root.ino, nodes } satisfies PersistedIndex;
}

function addStoredFiles(
  nodes: PersistedNode[],
  directory: PersistedNode,
  start: number,
  count: number,
) {
  for (let index = start; index < start + count; index++) {
    const ino = nodes.length + 1;
    directory.children!.push([`f${String(index).padStart(5, "0")}`, ino]);
    nodes.push({ ino, kind: "file", size: SIZES.W1.bytes, mode: 0o600, mtime: 0, data: `p${ino}` });
  }
}

async function coldFixture(index: PersistedIndex) {
  let reads = 0,
    persists = 0,
    closes = 0;
  const backend = await PersistentBackend.open(
    {
      async reserveIdentity() {
        return { workspace: "a110ca7e-0000-4000-8000-000000000001", era: 2n };
      },
      async load() {
        return index;
      },
      async read() {
        reads++;
        throw new Error("namespace read a cold payload");
      },
      async readRange() {
        reads++;
        throw new Error("namespace read a cold payload range");
      },
      retainPayload() {
        throw new Error("namespace retained a cold payload");
      },
      async persist() {
        persists++;
        throw new Error("namespace changed storage");
      },
      async flush() {},
      async close() {
        closes++;
      },
    },
    { intervalMs: 0 },
  );
  return { ...fixture(backend), storageCounts: () => ({ reads, persists, closes }) };
}

test("public cold snapshot preserves logical 128 MiB size without payload or handle allocation", async () => {
  const index = storedTree(4, 128);
  index.nodes.find((node) => node.kind === "file")!.size = 128 * 1024 ** 2;
  const current = await coldFixture(index);
  const before = current.backend.shared.registeredHandles().length;
  const reads = observe(current);
  try {
    const complete = await collect(current.workspace.snapshot({ includeDirs: false }));
    expect(complete.entries).toHaveLength(512);
    expect(complete.entries[0]!.size).toBe(128 * 1024 ** 2);
    expect(reads.counts()).toMatchObject({ arrays: 0, registrations: 0, stats: 0, identities: 0 });
    expect(current.storageCounts()).toEqual({ reads: 0, persists: 0, closes: 0 });
    released(current);
    reads.restore();
    expect(current.backend.shared.registeredHandles()).toHaveLength(before);
  } finally {
    reads.restore();
    await current.close();
  }
  expect(current.storageCounts()).toEqual({ reads: 0, persists: 0, closes: 1 });
});

async function completeCounts(cursor: SnapshotCursor) {
  let records = 0,
    pages = 0,
    files = 0,
    directories = 0;
  for (;;) {
    const page = await cursor.next();
    if (page.kind === "complete") {
      expect(await cursor.next()).toEqual(page);
      return { records, pages, files, directories, cut: page.cut };
    }
    if (page.kind !== "entries") throw new Error(`unexpected ${page.kind}`);
    records += page.entries.length;
    pages++;
    expect(page.entries.length).toBeLessThanOrEqual(WORKSPACE_LIMITS.pageEntries);
    expect(
      page.entries.reduce((sum, entry) => sum + 192 + 2 * entry.path.length, 0),
    ).toBeLessThanOrEqual(WORKSPACE_LIMITS.pageBytes);
    const pageFiles = page.entries.reduce((sum, entry) => sum + Number(entry.kind === "file"), 0);
    files += pageFiles;
    directories += page.entries.length - pageFiles;
  }
}

test("public W1 topology completes the compact index without payload I/O", async () => {
  const index = storedTree(SIZES.W1.directories, 10, SIZES.W1.largeFiles);
  expect(index.nodes).toHaveLength(55_033);
  const current = await coldFixture(index);
  const before = current.backend.shared.registeredHandles().length;
  const reads = observe(current);
  const cursor = current.workspace.snapshot();
  try {
    const { records, pages, files, directories, cut } = await completeCounts(cursor);
    expect(records).toBe(55_033);
    expect(pages).toBe(430);
    expect(files).toBe(50_032);
    expect(directories).toBe(5_001);
    expect(cut.workspace).toBe(current.backend.workspaceId);
    expect(cut.watermark.history).toBe(current.backend.shared.publication!.buffers.history);
    expect(typeof cut.generation).toBe("bigint");
    expect(typeof cut.watermark.seq).toBe("bigint");
    expect(cut.generation - cut.watermark.seq).toBe(0n);
    expect(await current.workspace.changes(cut.watermark)).toEqual({
      kind: "changes",
      batches: [],
      next: cut.watermark,
    });
    expect(reads.counts()).toEqual({ stats: 0, identities: 0, arrays: 0, registrations: 0 });
    expect(current.storageCounts()).toEqual({ reads: 0, persists: 0, closes: 0 });
    released(current);
    reads.restore();
    expect(current.backend.shared.registeredHandles()).toHaveLength(before);
    console.log(
      JSON.stringify({
        cell: "public-W1-namespace-only",
        records,
        pages,
        files,
        directories,
        terminal: "complete",
      }),
    );
  } finally {
    reads.restore();
    await cursor.close();
    await current.close();
  }
  expect(current.storageCounts()).toEqual({ reads: 0, persists: 0, closes: 1 });
});

test("authority stop closes both cursor iterators and late request IDs cannot reopen", async () => {
  const current = fixture(new MemoryBackend(flat(256)));
  const authority = new NamespaceAuthority(current.backend);
  try {
    expect(authority.next(1, {}).kind).toBe("entries");
    expect(authority.next(2, {}).kind).toBe("entries");
    expect(authority.size).toBe(2);
    expect(authority.next(3, {})).toEqual({ kind: "pressure", resource: "cursor" });
    authority.close(1);
    expect(authority.next(1, {})).toEqual({ kind: "cancelled" });
    expect(authority.next(3, {})).toEqual({ kind: "cancelled" });
    expect(authority.size).toBe(1);
    current.backend.shared.publication!.stop();
    expect(authority.next(2, {})).toEqual({ kind: "stopped" });
    expect(authority.size).toBe(0);
    expect(authority.next(4, {})).toEqual({ kind: "stopped" });
  } finally {
    authority.close();
    await current.close();
  }
});

test("authority rejects replacement roots and histories without admitting a late cursor", async () => {
  const current = fixture(new MemoryBackend(flat(256)));
  const authority = new NamespaceAuthority(current.backend);
  try {
    expect(authority.next(1, {}).kind).toBe("entries");
    const original = current.backend.fs.root;
    current.backend.fs.root = new MemFS().root;
    expect(authority.next(1, {})).toEqual({ kind: "stopped" });
    expect(authority.size).toBe(0);
    current.backend.fs.root = original;
    expect(authority.next(2, {})).toEqual({ kind: "stopped" });
    const other = new NamespaceAuthority(current.backend);
    expect(other.next(1, {}).kind).toBe("entries");
    const buffers = current.backend.shared.publication!.buffers;
    const history = buffers.history;
    try {
      Object.defineProperty(buffers, "history", { value: crypto.randomUUID(), configurable: true });
      expect(other.next(1, {})).toEqual({ kind: "stopped" });
      expect(other.size).toBe(0);
    } finally {
      Object.defineProperty(buffers, "history", { value: history, configurable: true });
      other.close();
    }
  } finally {
    authority.close();
    await current.close();
  }
});
