import { expect, spyOn, test } from "bun:test";
import { resourceUsage } from "node:process";
import { parseFileIdentity } from "../fs/file-identity.js";
import {
  NamespaceProjectionTable,
  NamespaceProjectionPressure,
} from "../fs/namespace-projection-table.js";
import type { PublicationEffect } from "../fs/publication.js";
import { ChangeBudget, NamespaceIndex, ProjectionPressure } from "../fs/workspace-index.js";
import { workspacePublication, type NamespaceRecord } from "../fs/workspace-protocol.js";
import {
  createFilesystemConnection,
  createWorkspaceVfs,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  PersistentBackend,
  WORKSPACE_LIMITS,
  type SnapshotOptions,
  type WorkspaceVfs,
  type NamespaceEntry,
  type NamespaceCut,
  type WorkspaceChange,
  type Watermark,
} from "../fs/index.js";
import type { PersistedIndex, PersistedNode, StorageBackend } from "../fs/storage.js";
import { SIZES } from "../tooling/vfs-workloads.js";
import type { ResolvedPath } from "../core/filesystem.js";

function identity(serial: number) {
  const token = ((1n << 64n) | BigInt(serial)).toString(16);
  return parseFileIdentity({ id: token, version: token });
}

function record(
  serial: number,
  parent: number | null,
  name: string,
  directory = false,
): NamespaceRecord {
  return {
    ...identity(serial),
    parent: parent === null ? null : identity(parent).id,
    name,
    path: "/",
    selected: true,
    kind: directory ? "directory" : "file",
    size: 0,
    mtime: 0,
    mode: 0o700,
  };
}

function seedW1(table: NamespaceProjectionTable, reorder = (value: number) => value): number {
  const add = (serial: number, parent: number | null, name: string, directory = false) =>
    table.add(record(reorder(serial), parent === null ? null : reorder(parent), name, directory));
  let serial = 1;
  add(serial++, null, "", true);
  for (let directory = 0; directory < SIZES.W1.directories; directory++) {
    const parent = serial++;
    add(parent, 1, `d${directory.toString().padStart(5, "0")}`, true);
    for (let file = directory * 10; file < directory * 10 + 10; file++)
      add(serial++, parent, `f${file.toString().padStart(5, "0")}`);
    if (directory < SIZES.W1.largeFiles) add(serial++, parent, "large");
  }
  return serial - 1;
}

test("the W1 historical namespace fits the unchanged two MiB budget", () => {
  const table = new NamespaceProjectionTable();
  expect(seedW1(table)).toBe(55033);
});

function budget(limit = 1024 * 1024) {
  let used = 0;
  return {
    take(bytes: number) {
      used += bytes;
      if (used > limit) throw new Error("change budget");
    },
  };
}

function file(serial: number) {
  return { ...identity(serial), ino: serial, birthHistory: "fixture" };
}

function entry(
  parent: number,
  name: string,
  before: number | null,
  after: number | null,
): PublicationEffect {
  return {
    kind: "entry",
    parent: file(parent),
    name,
    before: before === null ? null : file(before),
    after: after === null ? null : file(after),
  };
}

function paths(table: NamespaceProjectionTable, serial: number): readonly string[] {
  const change = table.project(
    [{ kind: "metadata", file: file(serial), mode: 0o600, mtime: 1 }],
    budget(),
  )[0];
  if (!change || change.kind !== "metadata") throw new Error("missing metadata change");
  return change.paths;
}

function small(options: ConstructorParameters<typeof NamespaceProjectionTable>[0] = {}) {
  const table = new NamespaceProjectionTable({
    nodes: 16,
    edges: 16,
    extraLinks: 4,
    nameBytes: 256,
    scratchSlots: 2,
    ...options,
  });
  table.add(record(1, null, "", true));
  return table;
}

function pressure(action: () => void, component: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(NamespaceProjectionPressure);
    if (!(error instanceof NamespaceProjectionPressure)) throw error;
    expect(error.resource).toBe("index");
    expect(error.component === component).toBe(true);
    expect(error.required).toBeGreaterThan(error.available);
    return;
  }
  throw new Error("expected capacity pressure");
}

test("reports the actual fixed backing allocation, not cheaper per-entry charges", () => {
  const table = new NamespaceProjectionTable();
  const storage = table.allocation();
  expect(storage.backingBytes).toBe(2031592);
  expect(storage.scratchBytes).toBe(16384);
  expect(storage.chargedBytes).toBe(2039784);
  expect(storage.chargedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  const allocate = ArrayBuffer;
  let observed = 0;
  globalThis.ArrayBuffer = new Proxy(allocate, {
    construct(target, args) {
      const buffer = Reflect.construct(target, args);
      observed += buffer.byteLength;
      return buffer;
    },
  });
  try {
    const measured = new NamespaceProjectionTable();
    expect(observed).toBe(storage.backingBytes);
    const retained = Object.values(measured);
    expect(retained.some((value) => value instanceof Map || Array.isArray(value))).toBe(false);
    seedW1(measured);
    expect(observed).toBe(storage.backingBytes);
    expect(measured.allocation()).toMatchObject({ nodes: 55033, edges: 55032, nameBytes: 330160 });
  } finally {
    globalThis.ArrayBuffer = allocate;
  }
});

test("checks the byte limit before allocating a backing buffer", () => {
  const exact = small().allocation().chargedBytes;
  expect(small({ byteLimit: exact }).allocation().chargedBytes).toBe(exact);
  pressure(() => small({ byteLimit: exact - 1 }), "bytes");
});

test.each([
  "ascii",
  "café",
  "文件",
  "🧇",
  "\ud800",
  "\udc00",
  "a\ud800b\udc00",
  "\ud800🧇\udfff",
  "a\u0000b",
])("round-trips every JS code unit in %j", (name) => {
  const table = small();
  table.add(record(2, 1, name));
  expect(paths(table, 2)).toEqual([`/${name}`]);
  table.add(record(2, 1, name));
  expect(table.allocation().edges).toBe(1);
});

test("distinguishes all single UTF-16 units, including adjacent unpaired surrogates", () => {
  const table = small({ nameBytes: 1024 });
  for (let unit = 0; unit < 65536; unit++) {
    const name = String.fromCharCode(unit);
    table.add(record(2, 1, name));
    expect(paths(table, 2)).toEqual([`/${name}`]);
    table.project([entry(1, name, 2, null)], budget());
  }
  expect(table.allocation()).toMatchObject({ nodes: 1, edges: 0, nameBytes: 0 });
});

test("preserves all identity bits and arbitrary recovered eras without rank rewrites", () => {
  const table = small();
  const tokens = [
    "ffffffffffffffffffffffffffffffff",
    "10000000000000002",
    "80000000000000010000000000000001",
    "ffffffffffffffff0000000000000001",
  ];
  tokens.forEach((token, at) => {
    const value = parseFileIdentity({ id: token, version: token });
    table.add({ ...record(at + 2, 1, `n${at}`), ...value });
    const change = table.project(
      [{ kind: "metadata", file: { ...file(at + 2), ...value }, mode: 0, mtime: 0 }],
      budget(),
    )[0];
    expect(change).toMatchObject({ id: value.id, version: value.version, paths: [`/n${at}`] });
  });
});

test("admits exact node, edge, name and overflow boundaries without partial insertion", () => {
  const cases = [
    { config: { nodes: 2 }, component: "nodes", add: record(3, 1, "c") },
    { config: { edges: 1 }, component: "edges", add: record(3, 1, "c") },
    { config: { nameBytes: 1 }, component: "nameBytes", add: record(3, 1, "c") },
    { config: { extraLinks: 0 }, component: "extraLinks", add: record(2, 1, "c") },
  ];
  for (const cell of cases) {
    const table = small(cell.config);
    table.add(record(2, 1, "b"));
    const before = table.allocation();
    pressure(() => table.add(cell.add), cell.component);
    expect(table.allocation()).toEqual(before);
    expect(paths(table, 2)).toEqual(["/b"]);
    expect(paths(table, 3)).toEqual([]);
  }
});

test("hardlinks survive deleting the primary link and inserting another node", () => {
  const table = small();
  table.add(record(2, 1, "z"));
  table.add(record(2, 1, "a"));
  table.add(record(2, 1, "m"));
  expect(paths(table, 2)).toEqual(["/a", "/m", "/z"]);
  table.project([entry(1, "z", 2, null)], budget());
  table.add(record(3, 1, "new"));
  expect(paths(table, 2)).toEqual(["/a", "/m"]);
  table.project([entry(1, "a", 2, null), entry(1, "m", 2, null)], budget());
  expect(paths(table, 2)).toEqual([]);
  table.add(record(2, 1, "again"));
  expect(paths(table, 2)).toEqual(["/again"]);
});

test("reserves the entire effect group before adding inodes or removing names", () => {
  const table = small({ nameBytes: 4 });
  table.add(record(2, 1, "old"));
  const before = table.allocation();
  pressure(
    () =>
      table.project(
        [
          { kind: "inode", file: file(3), nodeKind: "file", mode: 0, mtime: 0 },
          entry(1, "old", 2, null),
          entry(1, "new", null, 3),
        ],
        budget(),
      ),
    "nameBytes",
  );
  expect(table.allocation()).toEqual(before);
  expect(paths(table, 2)).toEqual(["/old"]);
  expect(paths(table, 3)).toEqual([]);
});

test("rename projects old paths before the group and descendant paths after it", () => {
  const table = small();
  table.add(record(2, 1, "dir", true));
  table.add(record(3, 2, "file"));
  const changes = table.project(
    [
      entry(1, "dir", 2, null),
      entry(1, "renamed", null, 2),
      { kind: "resize", file: file(3), size: 12, version: 2 },
    ],
    budget(),
  );
  expect(changes).toMatchObject([
    { kind: "entry", beforePath: "/dir", afterPath: null },
    { kind: "entry", beforePath: null, afterPath: "/renamed" },
    { kind: "resize", paths: ["/renamed/file"], size: 12 },
  ]);
});

test("ordered replacement, deletion, reinsertion and unknown-file writes keep projection semantics", () => {
  const table = small();
  table.add(record(2, 1, "a"));
  table.add(record(3, 1, "b"));
  const changes = table.project(
    [
      entry(1, "a", 2, null),
      entry(1, "b", 3, 2),
      {
        kind: "bytes",
        file: file(99),
        bytes: new Uint8Array([1, 2]),
        offset: 4,
        size: 6,
        version: 1,
      },
    ],
    budget(),
  );
  expect(changes).toMatchObject([
    { beforePath: "/a", afterPath: null },
    { beforePath: "/b", afterPath: "/b" },
    { kind: "write", paths: [], range: { offset: 4, length: 2 } },
  ]);
  table.project([entry(1, "a", null, 4)], budget());
  expect(paths(table, 2)).toEqual(["/b"]);
  expect(paths(table, 3)).toEqual([]);
  expect(paths(table, 4)).toEqual(["/a"]);
});

test("compacts primary and overflow names with one scratch slot and no second buffer", () => {
  const table = small({ nameBytes: 24, scratchSlots: 1 });
  for (let serial = 2; serial <= 5; serial++) table.add(record(serial, 1, `name${serial}`));
  table.add(record(2, 1, "link"));
  table.project([entry(1, "name3", 3, null), entry(1, "name5", 5, null)], budget());
  const allocate = ArrayBuffer;
  globalThis.ArrayBuffer = new Proxy(allocate, {
    construct() {
      throw new Error("unreserved buffer");
    },
  });
  try {
    table.add(record(6, 1, "long-name"));
  } finally {
    globalThis.ArrayBuffer = allocate;
  }
  expect(paths(table, 2)).toEqual(["/link", "/name2"]);
  expect(paths(table, 4)).toEqual(["/name4"]);
  expect(paths(table, 6)).toEqual(["/long-name"]);
  expect(table.allocation()).toMatchObject({ compactions: 1, compactionPasses: 3, nameBytes: 23 });
});

test("reports missing compaction scratch before mutating logical contents", () => {
  const table = small({ nameBytes: 6, scratchSlots: 0 });
  table.add(record(2, 1, "old"));
  table.project([entry(1, "old", 2, null)], budget());
  table.add(record(3, 1, "now"));
  table.project([entry(1, "now", 3, null)], budget());
  const before = table.allocation();
  pressure(() => table.add(record(4, 1, "new")), "scratch");
  expect(table.allocation()).toEqual(before);
  expect(paths(table, 4)).toEqual([]);
});

test("reuses node slots, overflow slots and arena bytes under repeated churn", () => {
  const table = small({ nodes: 4, extraLinks: 1, nameBytes: 20, scratchSlots: 1 });
  for (let serial = 2; serial < 1002; serial++) {
    table.add(record(serial, 1, "name"));
    table.add(record(serial, 1, "link"));
    expect(paths(table, serial)).toEqual(["/link", "/name"]);
    table.project([entry(1, "name", serial, null), entry(1, "link", serial, null)], budget());
  }
  expect(table.allocation()).toMatchObject({ nodes: 1, edges: 0, extraLinks: 0, nameBytes: 0 });
});

test("matches an independent namespace model for deterministic ordered mutation groups", () => {
  const table = small({ nodes: 128, nameBytes: 4096, edges: 128, extraLinks: 64 });
  let random = 0x12345678;
  const next = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random;
  };
  const names = new Map<string, number>();
  for (let step = 0; step < 1000; step++) {
    const name = `n${next() % 32}`,
      before = names.get(name) ?? null;
    const after = next() % 4 === 0 ? null : 2 + (next() % 20);
    const effects: PublicationEffect[] = [entry(1, name, before, after)];
    if (after === null) names.delete(name);
    else names.set(name, after);
    const target = 2 + (next() % 20);
    effects.push({ kind: "metadata", file: file(target), mode: 0o600, mtime: step });
    const expectedPaths = Array.from(names, ([path, serial]) =>
      serial === target ? `/${path}` : null,
    ).filter((path) => path !== null);
    expectedPaths.sort();
    expect(table.project(effects, budget())).toEqual([
      {
        kind: "entry",
        parent: identity(1),
        name,
        before: before === null ? null : identity(before),
        after: after === null ? null : identity(after),
        beforePath: before === null ? null : `/${name}`,
        afterPath: after === null ? null : `/${name}`,
      },
      { kind: "metadata", ...identity(target), mode: 0o600, mtime: step, paths: expectedPaths },
    ]);
  }
});

test("bounded scratch compaction is independent of live-name physical order", () => {
  const table = small({ nodes: 256, edges: 256, extraLinks: 64, nameBytes: 700, scratchSlots: 3 });
  for (let serial = 2; serial <= 101; serial++)
    table.add(record(serial, 1, `f${serial.toString().padStart(3, "0")}`));
  for (let serial = 2; serial <= 101; serial += 2)
    table.project([entry(1, `f${serial.toString().padStart(3, "0")}`, serial, null)], budget());
  for (let serial = 102; serial < 130; serial++)
    table.add(record(serial, 1, `longer-name-${serial}`));
  for (let serial = 3; serial <= 101; serial += 2)
    expect(paths(table, serial)).toEqual([`/f${serial.toString().padStart(3, "0")}`]);
  expect(table.allocation().compactionPasses).toBeGreaterThan(1);
});

function shuffleIdentity(serial: number): number {
  let value = serial - 1;
  do {
    let left = value >>> 8,
      right = value & 255;
    for (let round = 0; round < 4; round++) {
      const mixed = Math.imul(right ^ (0x57ac12 + round), 1664525) + 1013904223;
      const next = left ^ ((mixed >>> 24) & 255);
      left = right;
      right = next;
    }
    value = (left << 8) | right;
  } while (value >= 55033);
  return value + 1;
}

test("W1 forward, reversed and mixed identity builds and compaction stay bounded", () => {
  const timings: { order: string; ms: number }[] = [];
  let sampledHeapPeak = process.memoryUsage().heapUsed;
  const orders = [
    { name: "forward-1", id: (value: number) => value },
    { name: "forward-2", id: (value: number) => value },
    { name: "forward-3", id: (value: number) => value },
    { name: "forward-4", id: (value: number) => value },
    { name: "forward", id: (value: number) => value },
    { name: "reverse", id: (value: number) => 55034 - value },
    {
      name: "permuted",
      id: shuffleIdentity,
    },
  ];
  for (const order of orders) {
    const start = performance.now(),
      table = new NamespaceProjectionTable();
    expect(seedW1(table, order.id)).toBe(55033);
    timings.push({ order: order.name, ms: performance.now() - start });
    sampledHeapPeak = Math.max(sampledHeapPeak, process.memoryUsage().heapUsed);
    expect(paths(table, order.id(55033))).toEqual(["/d04999/f49999"]);
    expect(table.allocation()).toMatchObject({ nodes: 55033, edges: 55032, nameBytes: 330160 });
  }
  const table = new NamespaceProjectionTable();
  seedW1(table);
  const start = performance.now();
  for (let step = 0; step < 1000; step++) {
    const from = step % 2 ? "temporary" : "f00000",
      to = step % 2 ? "f00000" : "temporary";
    table.project([entry(2, from, 3, null), entry(2, to, null, 3)], budget());
    expect(paths(table, 3)).toEqual([`/d00000/${to}`]);
  }
  const churnMs = performance.now() - start;
  const compactStart = performance.now();
  for (let step = 0; step < 256; step++) {
    const name = `x${step.toString().padStart(5, "0")}`.padEnd(4080, "x");
    table.project([entry(2, name, null, 60000)], budget());
    expect(paths(table, 60000)).toEqual([`/d00000/${name}`]);
    sampledHeapPeak = Math.max(sampledHeapPeak, process.memoryUsage().heapUsed);
    table.project([entry(2, name, 60000, null)], budget());
  }
  expect(table.allocation().compactions).toBeGreaterThan(1);
  expect(paths(table, 3)).toEqual(["/d00000/f00000"]);
  console.log(
    JSON.stringify({
      kind: "namespace-table-screen",
      timings,
      churnMs,
      compactionMs: performance.now() - compactStart,
      allocation: table.allocation(),
      memory: process.memoryUsage(),
      sampledHeapPeak,
      processMaxRssKiB: resourceUsage().maxRSS,
      runtime: Bun.version,
    }),
  );
});

test("an inline rename needs no overflow slot and a no-op replacement needs no names", () => {
  const table = small({ extraLinks: 0, nameBytes: 6 });
  table.add(record(2, 1, "old"));
  table.project([entry(1, "old", 2, null), entry(1, "new", null, 2)], budget());
  expect(paths(table, 2)).toEqual(["/new"]);
  table.project([entry(1, "new", 2, 2)], budget());
  expect(paths(table, 2)).toEqual(["/new"]);
});

test("accepts the existing maximum path-unit filename without replacement encoding", () => {
  const table = small({ nameBytes: 16384 });
  const name = "\ud800".repeat(4095);
  table.add(record(2, 1, name));
  expect(paths(table, 2)).toEqual([`/${name}`]);
  expect(table.allocation().nameBytes).toBe(12285);
});

test("a removed-and-reinserted name reserves compaction scratch before any removal", () => {
  const table = small({ nameBytes: 9, scratchSlots: 0 });
  table.add(record(2, 1, "one"));
  table.add(record(3, 1, "two"));
  table.project([entry(1, "two", 3, null)], budget());
  table.add(record(4, 1, "new"));
  const before = table.allocation();
  pressure(
    () => table.project([entry(1, "one", 2, null), entry(1, "one", null, 2)], budget()),
    "scratch",
  );
  expect(table.allocation()).toEqual(before);
  expect(paths(table, 2)).toEqual(["/one"]);
});

test.each(["nodes", "edges", "extraLinks"])(
  "rejects whole groups at the %s boundary",
  (component) => {
    const table = small({
      nodes: component === "nodes" ? 3 : 16,
      edges: component === "edges" ? 2 : 16,
      extraLinks: component === "extraLinks" ? 1 : 4,
    });
    table.add(record(2, 1, "old"));
    const target = component === "extraLinks" ? 2 : 3;
    const last = component === "extraLinks" ? 2 : 4;
    const before = table.allocation();
    pressure(
      () => table.project([entry(1, "one", null, target), entry(1, "two", null, last)], budget()),
      component,
    );
    expect(table.allocation()).toEqual(before);
    expect(paths(table, 2)).toEqual(["/old"]);
  },
);

const capacityWorkspace = "a110ca7e-0000-4000-8000-000000000001";
type IdentityOrder = "forward" | "reverse" | "permuted";

function recoveredIdentity(serial: number, order: IdentityOrder) {
  const reordered =
    order === "reverse" ? 55034 - serial : order === "permuted" ? shuffleIdentity(serial) : serial;
  const era = order === "permuted" ? 0x8000000000000001n + BigInt(reordered % 17) : 1n;
  const token = ((era << 64n) | BigInt(reordered)).toString(16);
  return {
    format: "waffle-file-identity-v1",
    workspace: capacityWorkspace,
    id: token,
    version: token,
  } as const;
}

function coldCorpus(order: IdentityOrder = "forward", flat = 0): PersistedIndex {
  const nodes: PersistedNode[] = [];
  const add = (kind: "file" | "dir", size = 0): PersistedNode => {
    const ino = nodes.length + 1;
    const node: PersistedNode = {
      ino,
      kind,
      size,
      mode: kind === "dir" ? 0o700 : 0o600,
      mtime: 0,
      identity: recoveredIdentity(ino, order),
      ...(kind === "dir" ? { children: [] } : { data: `fixture-${ino}` }),
    };
    nodes.push(node);
    return node;
  };
  const root = add("dir");
  if (!root.children) throw new Error("missing root children");
  if (flat) {
    for (let file = 0; file < flat; file++) root.children.push([`f${file}`, add("file").ino]);
    return { version: 1, generation: 1, root: root.ino, nodes };
  }
  for (let dir = 0; dir < SIZES.W1.directories; dir++) {
    const directory = add("dir");
    root.children.push([`d${String(dir).padStart(5, "0")}`, directory.ino]);
    addColdFiles(directory, dir, add);
  }
  return { version: 1, generation: 1, root: root.ino, nodes };
}

function addColdFiles(
  directory: PersistedNode,
  dir: number,
  add: (kind: "file" | "dir", size?: number) => PersistedNode,
) {
  if (!directory.children) throw new Error("missing directory children");
  for (let file = dir * 10; file < dir * 10 + 10; file++)
    directory.children.push([`f${String(file).padStart(5, "0")}`, add("file", SIZES.W1.bytes).ino]);
  if (dir < SIZES.W1.largeFiles)
    directory.children.push(["large", add("file", SIZES.W1.largeBytes).ino]);
}

async function publicCorpus(index = coldCorpus()) {
  const counters = { reads: 0, persists: 0, closes: 0 };
  const storage: StorageBackend = {
    async load() {
      return index;
    },
    async reserveIdentity() {
      return { workspace: capacityWorkspace, era: 0xffffffffffffffffn };
    },
    async read() {
      counters.reads++;
      throw new Error("namespace hydrated cold payload");
    },
    async readRange() {
      counters.reads++;
      throw new Error("namespace hydrated cold payload");
    },
    retainPayload() {
      throw new Error("namespace retained cold payload");
    },
    async persist() {
      counters.persists++;
    },
    async flush() {},
    async close() {
      counters.closes++;
    },
  };
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const workspace = createWorkspaceVfs(client);
  return {
    backend,
    pair,
    service,
    client,
    workspace,
    counters,
    async close() {
      try {
        await workspace.close();
      } finally {
        client.dispose();
        service.dispose();
        await backend.close();
      }
      expect(service.resources()).toMatchObject({ clients: 0, workspaceCursors: 0, responses: 0 });
      expect(client.completions.size).toBe(0);
      expect(counters.closes).toBe(1);
    },
  };
}

async function publicScan(
  workspace: WorkspaceVfs,
  options?: SnapshotOptions,
  inspect: (entry: NamespaceEntry) => void = () => {},
) {
  const cursor = workspace.snapshot(options);
  let entries = 0,
    pages = 0,
    files = 0,
    directories = 0;
  try {
    for (;;) {
      const page = await cursor.next();
      if (page.kind === "complete") {
        expect(await cursor.next()).toEqual(page);
        return { cut: page.cut, entries, pages, files, directories };
      }
      if (page.kind !== "entries")
        throw new Error(
          `public snapshot returned ${JSON.stringify(page)} after ${entries} entries`,
        );
      expect(page.entries.length).toBeLessThanOrEqual(WORKSPACE_LIMITS.pageEntries);
      expect(
        page.entries.reduce((sum, entry) => sum + 192 + 2 * entry.path.length, 0),
      ).toBeLessThanOrEqual(WORKSPACE_LIMITS.pageBytes);
      pages++;
      entries += page.entries.length;
      const pageFiles = page.entries.reduce((sum, entry) => sum + Number(entry.kind === "file"), 0);
      files += pageFiles;
      directories += page.entries.length - pageFiles;
      page.entries.forEach(inspect);
    }
  } finally {
    await cursor.close();
  }
}

function corpusSerial(path: string): number {
  if (path === "/") return 1;
  const [directory, name] = path.slice(1).split("/");
  const dir = Number(directory!.slice(1));
  const parent = 2 + dir * 11 + Math.min(dir, SIZES.W1.largeFiles);
  return name === undefined
    ? parent
    : name === "large"
      ? parent + 11
      : parent + 1 + (Number(name.slice(1)) % 10);
}

function inspectCorpus(order: IdentityOrder, pristine = true) {
  const seen = new Uint8Array(55034);
  return (entry: NamespaceEntry) => {
    const serial = corpusSerial(entry.path);
    expect(serial).toBeGreaterThan(0);
    expect(serial).toBeLessThan(seen.length);
    expect(seen[serial]).toBe(0);
    seen[serial] = 1;
    const expected = parseFileIdentity(recoveredIdentity(serial, order));
    expect(entry.id).toBe(expected.id);
    if (pristine) expect(entry.version).toBe(expected.version);
    else expect(entry.version).toBeGreaterThanOrEqual(expected.version);
  };
}

test("public W1 snapshot completes all 55,033 cold entries without payload hydration", async () => {
  const current = await publicCorpus();
  try {
    const result = await publicScan(current.workspace, undefined, inspectCorpus("forward"));
    expect(result).toMatchObject({ entries: 55033, files: 50032, directories: 5001 });
    expect(await current.workspace.changes(result.cut.watermark)).toMatchObject({
      kind: "changes",
      batches: [],
    });
    expect(current.counters).toMatchObject({ reads: 0, persists: 0 });
    expect(current.service.resources()).toMatchObject({ workspaceCursors: 0, responses: 0 });
  } finally {
    await current.close();
  }
}, 30000);

test("existing public index and pressure names are the exact compact implementation", () => {
  expect(NamespaceIndex).toBe(NamespaceProjectionTable);
  expect(ProjectionPressure).toBe(NamespaceProjectionPressure);
  expect(WORKSPACE_LIMITS.indexBytes).toBe(2 * 1024 * 1024);
  expect(WORKSPACE_LIMITS.indexEdges).toBe(65536);
});

test("the old 8,000-name pressure fixture now completes through the public API", async () => {
  const current = await publicCorpus(coldCorpus("forward", 8000));
  try {
    expect(await publicScan(current.workspace)).toMatchObject({
      entries: 8001,
      files: 8000,
      directories: 1,
    });
    expect(current.counters).toMatchObject({ reads: 0, persists: 0 });
  } finally {
    await current.close();
  }
});

test("public W1 scans cover recovered identity order, narrow prefixes and five complete runs", async () => {
  const timings: { order: string; ms: number; pages: number }[] = [];
  const orders: IdentityOrder[] = [
    "forward",
    "forward",
    "forward",
    "forward",
    "forward",
    "reverse",
    "permuted",
  ];
  for (const order of orders) {
    const current = await publicCorpus(coldCorpus(order));
    const registered = current.backend.shared.registeredHandles().length;
    try {
      const start = performance.now();
      const result = await publicScan(current.workspace, undefined, inspectCorpus(order));
      timings.push({ order, ms: performance.now() - start, pages: result.pages });
      expect(result).toMatchObject({ entries: 55033, files: 50032, directories: 5001 });
      expect(await current.workspace.changes(result.cut.watermark)).toMatchObject({
        kind: "changes",
        batches: [],
      });
      expect(current.backend.shared.registeredHandles().length).toBe(registered);
      expect(current.counters).toMatchObject({ reads: 0, persists: 0 });
    } finally {
      await current.close();
    }
    Bun.gc(true);
  }
  const current = await publicCorpus();
  try {
    expect(
      await publicScan(current.workspace, { prefix: "/d04999", includeDirs: false }),
    ).toMatchObject({ entries: 10, files: 10, directories: 0 });
    const missing = await publicScan(current.workspace, { prefix: "/missing", includeDirs: false });
    expect(missing.entries).toBe(0);
    expect(missing.pages).toBeGreaterThan(400);
    expect(await current.workspace.changes(missing.cut.watermark)).toMatchObject({
      kind: "changes",
      batches: [],
    });
    expect(current.counters).toMatchObject({ reads: 0, persists: 0 });
  } finally {
    await current.close();
  }
  console.log(
    JSON.stringify({
      kind: "namespace-public-scan-screen",
      timings,
      memory: process.memoryUsage(),
      processMaxRssKiB: resourceUsage().maxRSS,
      runtime: Bun.version,
    }),
  );
}, 120000);

function publicFeed(workspace: WorkspaceVfs, cut: NamespaceCut) {
  let position: Watermark = cut.watermark;
  return async () => {
    const page = await workspace.changes(position);
    if (page.kind !== "changes") throw new Error(`change pull returned ${page.kind}`);
    expect(page.batches).toHaveLength(1);
    expect(page.next.seq - position.seq).toBe(1n);
    position = page.next;
    return page.batches[0]!.changes;
  };
}

async function linkPublic(
  current: Awaited<ReturnType<typeof publicCorpus>>,
  from: string,
  to: string,
) {
  const root = await current.client.asyncCall("preopen", ["/"]);
  const source = await current.client.asyncCall("resolve", [root, from.slice(1)]);
  const destination = await current.client.asyncCall("resolve", [root, to.slice(1)]);
  expect(await current.client.asyncCall("link", [source, destination])).toBe(0);
}

function expectEntry(
  changes: readonly WorkspaceChange[],
  before: string | null,
  after: string | null,
  serial: number,
) {
  const id = identity(serial).id;
  expect(changes).toContainEqual(
    expect.objectContaining({
      kind: "entry",
      beforePath: before,
      afterPath: after,
      ...(before === null ? { before: null } : { before: expect.objectContaining({ id }) }),
      ...(after === null ? { after: null } : { after: expect.objectContaining({ id }) }),
    }),
  );
}

test("public W1 directory rename, replacement, hardlinks and 1,000 ordered operations preserve paths", async () => {
  const current = await publicCorpus();
  try {
    const initial = await publicScan(current.workspace);
    let pull = publicFeed(current.workspace, initial.cut);
    await current.client.asyncCall("move", ["/d00000", "/renamed"]);
    const moved = await pull();
    expectEntry(moved, "/d00000", null, 2);
    expectEntry(moved, null, "/renamed", 2);
    const source = moved.find(
      (change) => change.kind === "entry" && change.before?.id === identity(2).id,
    );
    const destination = moved.find(
      (change) => change.kind === "entry" && change.after?.id === identity(2).id,
    );
    if (source?.kind !== "entry" || destination?.kind !== "entry")
      throw new Error("missing directory rename effects");
    expect(source.before!.version).toBe(destination.after!.version);
    const root = await current.client.asyncCall("preopen", ["/"]);
    const child = await current.client.asyncCall("resolve", [root, "renamed/f00000"]);
    expect(await current.client.asyncCall("setMtime", [child.node, 42])).toBe(0);
    expect(await pull()).toContainEqual(
      expect.objectContaining({ kind: "metadata", id: identity(3).id, paths: ["/renamed/f00000"] }),
    );
    await current.client.asyncCall("move", ["/renamed", "/d00000"]);
    await pull();
    await linkPublic(current, "/d00000/f00000", "/d00001/linked");
    expectEntry(await pull(), null, "/d00001/linked", 3);
    await current.client.asyncCall("move", ["/d00001/linked", "/d00002/f00020"]);
    const replaced = await pull();
    expectEntry(replaced, "/d00001/linked", null, 3);
    expect(replaced).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        beforePath: "/d00002/f00020",
        afterPath: "/d00002/f00020",
        before: expect.objectContaining({ id: identity(corpusSerial("/d00002/f00020")).id }),
        after: expect.objectContaining({ id: identity(3).id }),
      }),
    );
    await current.client.asyncCall("remove", ["/d00002/f00020"]);
    expectEntry(await pull(), "/d00002/f00020", null, 3);
    await current.client.asyncCall("writeFile", ["/d00002/f00020"], new Uint8Array([1]));
    const recreated = await pull();
    expect(recreated).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        before: null,
        afterPath: "/d00002/f00020",
        after: expect.objectContaining({ id: expect.any(BigInt) }),
      }),
    );
    const restart = await publicScan(current.workspace);
    pull = publicFeed(current.workspace, restart.cut);
    await publicChurn(current, pull);
    const final = await publicScan(current.workspace);
    expect(final.entries).toBe(55033);
    expect(current.counters.reads).toBe(0);
  } finally {
    await current.close();
  }
}, 120000);

async function publicChurn(
  current: Awaited<ReturnType<typeof publicCorpus>>,
  pull: ReturnType<typeof publicFeed>,
) {
  const start = performance.now();
  let created: WorkspaceChange | undefined;
  for (let step = 0; step < 1000; step++) {
    const cell = step % 6;
    if (cell < 2) {
      const from = cell === 0 ? "/d00000/f00000" : "/d00000/tmp",
        to = cell === 0 ? "/d00000/tmp" : "/d00000/f00000";
      await current.client.asyncCall("move", [from, to]);
      const changes = await pull();
      expectEntry(changes, from, null, 3);
      expectEntry(changes, null, to, 3);
      continue;
    }
    if (cell === 2) {
      await linkPublic(current, "/d00001/f00010", "/d00001/link");
      expectEntry(await pull(), null, "/d00001/link", corpusSerial("/d00001/f00010"));
      continue;
    }
    if (cell === 3) {
      await current.client.asyncCall("remove", ["/d00001/link"]);
      expectEntry(await pull(), "/d00001/link", null, corpusSerial("/d00001/f00010"));
      continue;
    }
    if (cell === 4) {
      await current.client.asyncCall("writeFile", ["/d00002/transient"], new Uint8Array([1]));
      const changes = await pull();
      created = changes.find(
        (change) => change.kind === "entry" && change.afterPath === "/d00002/transient",
      );
      expect(created?.kind).toBe("entry");
      continue;
    }
    await current.client.asyncCall("remove", ["/d00002/transient"]);
    const changes = await pull();
    if (created?.kind !== "entry") throw new Error("missing created identity");
    expect(changes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        beforePath: "/d00002/transient",
        before: expect.objectContaining({ id: created.after!.id }),
        after: null,
      }),
    );
  }
  console.log(
    JSON.stringify({
      kind: "namespace-public-churn-screen",
      operations: 1000,
      ms: performance.now() - start,
      memory: process.memoryUsage(),
    }),
  );
}

test("public projection pressure is atomic, never rolls back the writer, and requires a fresh cut", async () => {
  const corpus = coldCorpus("forward", 1024);
  const root = corpus.nodes[0]!;
  if (!root.children) throw new Error("missing root");
  root.children = root.children.map(([name, ino]) => [name.padEnd(384, "x"), ino]);
  const extra = `/${"additional".padEnd(256, "x")}`;
  const before = root.children[0]![0],
    after = "renamed".padEnd(384, "x");
  const current = await publicCorpus(corpus);
  try {
    const initial = await publicScan(current.workspace);
    expect(initial.entries).toBe(1025);
    await current.client.asyncCall("move", [`/${before}`, `/${after}`]);
    expect(await current.workspace.changes(initial.cut.watermark)).toEqual({
      kind: "pressure",
      resource: "index",
    });
    expect((await current.workspace.changes(initial.cut.watermark)).kind).toBe("gap");
    let renamed = false;
    const fresh = await publicScan(current.workspace, undefined, (entry) => {
      if (entry.path === `/${after}`) renamed = true;
      expect(entry.path).not.toBe(`/${before}`);
    });
    expect(renamed).toBe(true);
    await current.client.asyncCall("writeFile", [extra], new Uint8Array([1]));
    const failed = current.workspace.snapshot();
    let terminal = await failed.next();
    while (terminal.kind === "entries") terminal = await failed.next();
    expect(terminal).toEqual({ kind: "pressure", resource: "index" });
    expect(await failed.next()).toEqual(terminal);
    await failed.close();
    expect(current.service.resources()).toMatchObject({ workspaceCursors: 0, responses: 0 });
    expect(await current.workspace.changes(fresh.cut.watermark)).toEqual({
      kind: "pressure",
      resource: "index",
    });
    await current.client.asyncCall("remove", [extra]);
    const recovered = await publicScan(current.workspace);
    expect(recovered.entries).toBe(1025);
    expect(await current.workspace.changes(recovered.cut.watermark)).toMatchObject({
      kind: "changes",
      batches: [],
    });
    expect(current.counters.reads).toBe(0);
  } finally {
    await current.close();
  }
});

test("two W1 scans, between-page abort, a held reply and stopped owner release public resources", async () => {
  const current = await publicCorpus();
  const release = Promise.withResolvers<() => void>();
  const port = current.pair.server.port;
  const post = port.postMessage.bind(port);
  let deliver: (() => void) | undefined;
  try {
    const accepted = await publicScan(current.workspace);
    const abort = new AbortController();
    const first = current.workspace.snapshot(undefined, abort.signal),
      second = current.workspace.snapshot();
    expect((await first.next()).kind).toBe("entries");
    expect((await second.next()).kind).toBe("entries");
    expect(current.service.resources().workspaceCursors).toBe(2);
    abort.abort();
    expect(await first.next()).toEqual({ kind: "cancelled" });
    await first.close();
    await second.close();
    expect(current.service.resources()).toMatchObject({ workspaceCursors: 0, responses: 0 });
    expect(await current.workspace.changes(accepted.cut.watermark)).toMatchObject({
      kind: "changes",
      batches: [],
    });
    port.postMessage = (message: unknown) => {
      port.postMessage = post;
      release.resolve(() => post(message));
    };
    const heldAbort = new AbortController();
    const held = current.workspace.snapshot(undefined, heldAbort.signal);
    const pending = held.next();
    deliver = await release.promise;
    expect(current.service.resources().workspaceCursors).toBe(1);
    heldAbort.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    await held.close();
    deliver();
    deliver = undefined;
    expect(await held.next()).toEqual({ kind: "cancelled" });
    await current.workspace.close();
    expect(await current.workspace.snapshot().next()).toEqual({ kind: "stopped" });
    expect(current.service.resources()).toMatchObject({ workspaceCursors: 0, responses: 0 });
    expect(await current.client.asyncCall("preopen", ["/"])).toBeGreaterThanOrEqual(0);
  } finally {
    port.postMessage = post;
    deliver?.();
    await current.close();
  }
}, 30000);

test("a real W1 change-ring overrun yields a gap and a full fresh resnapshot", async () => {
  const current = await publicCorpus();
  try {
    const initial = await publicScan(current.workspace);
    const root = await current.client.asyncCall("preopen", ["/"]);
    const node = await current.client.asyncCall("resolve", [root, "d00000"]);
    for (let step = 1; step <= 40; step++)
      expect(await current.client.asyncCall("setMtime", [node.node, step])).toBe(0);
    const page = await current.workspace.changes(initial.cut.watermark);
    expect(page.kind).toBe("gap");
    if (page.kind !== "gap") throw new Error("missing real ring gap");
    expect(page.current.watermark.seq - page.oldestAvailable.seq).toBe(31n);
    expect((await current.workspace.changes(page.current.watermark)).kind).toBe("gap");
    const fresh = await publicScan(current.workspace, undefined, inspectCorpus("forward", false));
    expect(fresh.entries).toBe(55033);
    expect(await current.workspace.changes(fresh.cut.watermark)).toMatchObject({
      kind: "changes",
      batches: [],
    });
  } finally {
    await current.close();
  }
}, 30000);

test("the public wire and accepted projection preserve valid lone-surrogate filenames", async () => {
  const corpus = coldCorpus("forward", 1);
  const name = "a\ud800b\udc00🧇";
  corpus.nodes[0]!.children = [[name, 2]];
  const current = await publicCorpus(corpus);
  try {
    const initial = await publicScan(current.workspace, undefined, (entry) => {
      if (entry.kind === "file") expect(entry.path).toBe(`/${name}`);
    });
    const root = await current.client.asyncCall("preopen", ["/"]);
    const child = await current.client.asyncCall("resolve", [root, name]);
    await current.client.asyncCall("setMtime", [child.node, 42]);
    expect(await publicFeed(current.workspace, initial.cut)()).toContainEqual(
      expect.objectContaining({ kind: "metadata", id: identity(2).id, paths: [`/${name}`] }),
    );
  } finally {
    await current.close();
  }
});

function linkInode(serial: number, target: string): PublicationEffect {
  return { kind: "inode", file: file(serial), nodeKind: "symlink", target, mode: 0o700, mtime: 7 };
}

function recordedBudget() {
  const debits: number[] = [];
  return {
    debits,
    take: (bytes: number) => {
      debits.push(bytes);
    },
  };
}

test("compact symlink projection preserves raw leaf metadata and ordinary variants", () => {
  const table = small();
  table.add(record(2, 1, "referent"));
  const target = "./referent//../missing/.",
    before = table.allocation();
  const changes = table.project(
    [
      linkInode(3, target),
      entry(1, "alias", null, 3),
      { kind: "inode", file: file(4), nodeKind: "file", mode: 0o600, mtime: 8 },
      { kind: "inode", file: file(5), nodeKind: "directory", mode: 0o700, mtime: 9 },
    ],
    budget(),
  );
  expect(changes[0]).toEqual({
    kind: "inode",
    ...identity(3),
    nodeKind: "symlink",
    target,
    mode: 0o700,
    mtime: 7,
    paths: ["/alias"],
  });
  expect(changes[2]).not.toHaveProperty("target");
  expect(changes[3]).not.toHaveProperty("target");
  expect(paths(table, 2)).toEqual(["/referent"]);
  expect(paths(table, 3)).toEqual(["/alias"]);
  expect(table.allocation().nameBytes - before.nameBytes).toBe(5);
  expect(Object.values(table).includes(target)).toBe(false);
});

test("compact symlink projection debits exact UTF16 and UTF8 including repeated long targets", () => {
  const targets = [
    "ascii",
    "café",
    "文件",
    "🧇",
    "\ud800",
    "\udc00",
    "a\ud800b\udc00",
    "é".repeat(32768),
  ];
  for (const target of targets) {
    const table = small(),
      charges = recordedBudget();
    table.project([linkInode(2, target)], charges);
    expect(charges.debits).toEqual([
      256,
      2 * target.length,
      new TextEncoder().encode(target).length,
    ]);
    expect(table.allocation().nameBytes).toBe(0);
  }
  const target = "🧇/\ud800",
    charges = recordedBudget();
  small().project([linkInode(2, target), linkInode(3, target)], charges);
  const each = [256, 2 * target.length, new TextEncoder().encode(target).length];
  expect(charges.debits).toEqual(each.concat(each));
});

function refusingTargetBudget(at: number, refusal: Error) {
  const debits: number[] = [];
  return {
    debits,
    take(bytes: number) {
      debits.push(bytes);
      if (debits.length === at) throw refusal;
    },
  };
}

function refuseTargetDebit(debit: 1 | 2) {
  const table = small({ nameBytes: 11, scratchSlots: 1 });
  table.add(record(2, 1, "old"));
  table.add(record(6, 1, "gone"));
  table.project([entry(1, "gone", 6, null)], budget());
  const before = table.allocation(),
    target = "raw//🧇/\ud800";
  const effects = [
    entry(1, "old", 2, null),
    {
      kind: "inode",
      file: file(3),
      nodeKind: "file",
      mode: 0,
      mtime: 0,
    } satisfies PublicationEffect,
    entry(1, "new", null, 3),
    linkInode(4, target),
    entry(1, "alias", null, 4),
  ];
  const refusal = new Error(`target debit ${debit}`);
  const charges = refusingTargetBudget(4 + debit, refusal);
  const charCodeAt = String.prototype.charCodeAt;
  let scanned = 0;
  String.prototype.charCodeAt = function (this: string, at: number) {
    if (this.valueOf() === target) scanned++;
    return charCodeAt.call(this, at);
  };
  try {
    expect(() => table.project(effects, charges)).toThrow(refusal);
  } finally {
    String.prototype.charCodeAt = charCodeAt;
  }
  const expected = [256, 256, 256, 256, 2 * target.length];
  if (debit === 2) expected.push(new TextEncoder().encode(target).length);
  expect(charges.debits).toEqual(expected);
  expect(scanned === 0).toBe(debit === 1);
  expect(table.allocation()).toEqual(before);
  expect(paths(table, 2)).toEqual(["/old"]);
  expect(paths(table, 3)).toEqual([]);
  expect(paths(table, 4)).toEqual([]);
  const changes = table.project(effects, budget());
  expect(changes[3]).toMatchObject({ nodeKind: "symlink", target, paths: ["/alias"] });
  expect(paths(table, 2)).toEqual([]);
  expect(paths(table, 3)).toEqual(["/new"]);
  expect(paths(table, 4)).toEqual(["/alias"]);
  expect(table.allocation()).toMatchObject({ nodes: 3, edges: 2, nameBytes: 8 });
  expect(table.allocation().compactions).toBeGreaterThan(before.compactions);
}

test("compact symlink projection refuses each target debit before effects and retries fresh", () => {
  refuseTargetDebit(1);
  refuseTargetDebit(2);
});

function expectChangePressure(action: () => void) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionPressure);
    expect(error).toBeInstanceOf(NamespaceProjectionPressure);
    if (!(error instanceof NamespaceProjectionPressure)) throw error;
    expect(error.resource).toBe("changes");
    return;
  }
  throw new Error("expected change pressure");
}

test("compact symlink projection honors the real ChangeBudget boundary and pressure identity", () => {
  const target = "🧇/\ud800",
    cost = 2 * target.length + new TextEncoder().encode(target).length;
  const table = small(),
    before = table.allocation(),
    charges = new ChangeBudget();
  charges.take(WORKSPACE_LIMITS.changeBytes - 256 - cost + 1);
  expectChangePressure(() => table.project([linkInode(2, target)], charges));
  expect(table.allocation()).toEqual(before);
  expect(paths(table, 2)).toEqual([]);
  for (const spare of [0, 1]) {
    const charges = new ChangeBudget();
    charges.take(WORKSPACE_LIMITS.changeBytes - 256 - cost - spare);
    expect(small().project([linkInode(2, target)], charges)[0]).toMatchObject({
      target,
      paths: [],
    });
  }
  const pathBudget = new ChangeBudget(),
    alias = "/alias",
    pathCost = alias.length * 2 + 32;
  pathBudget.take(WORKSPACE_LIMITS.changeBytes - 512 - cost - 2 * pathCost);
  expect(
    small().project([linkInode(2, target), entry(1, "alias", null, 2)], pathBudget)[0],
  ).toMatchObject({ target, paths: [alias] });
  expect(() => pathBudget.take(1)).toThrow(ProjectionPressure);
});

async function symlinkProjectionFixture(logRecords = workspacePublication.limits.logRecords) {
  const backend = new MemoryBackend();
  const pair = createFilesystemConnection(undefined, {
    ...workspacePublication,
    limits: {
      ...workspacePublication.limits,
      logRecords,
      logBytes: Math.max(
        workspacePublication.limits.logBytes,
        workspacePublication.limits.effectBytes * logRecords,
      ),
    },
  });
  const service = new FilesystemService(backend);
  let client: FilesystemClient | undefined, workspace: WorkspaceVfs | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    for (const release of [
      () => workspace?.close(),
      () => client?.dispose(),
      () => service.drainForOwner(),
      () => service.dispose(),
      () => pair.client.port.close(),
      () => pair.server.port.close(),
      () =>
        expect(service.resources()).toMatchObject({
          clients: 0,
          workspaceCursors: 0,
          responses: 0,
        }),
      () => expect(client?.completions.size ?? 0).toBe(0),
    ]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Projection fixture cleanup failed");
  };
  try {
    service.connect(pair.server);
    client = new FilesystemClient(pair.client);
    workspace = createWorkspaceVfs(client);
    return { backend, client, service, workspace, close, pair };
  } catch (error) {
    await close();
    throw error;
  }
}

type SymlinkProjectionFixture = Awaited<ReturnType<typeof symlinkProjectionFixture>>;
async function projectionPath(
  current: SymlinkProjectionFixture,
  name: string,
): Promise<ResolvedPath> {
  const root: number = await current.client.asyncCall("preopen", ["/"]);
  const found: ResolvedPath | number = await current.client.asyncCall("resolve", [
    root,
    name,
    false,
  ]);
  if (typeof found === "number") throw new Error(`resolve errno ${found}`);
  return found;
}
async function projectionLink(current: SymlinkProjectionFixture, name: string, target: string) {
  expect(
    await current.client.asyncCall("symlink", [await projectionPath(current, name), target]),
  ).toBe(0);
  const path = await projectionPath(current, name);
  if (path.node === undefined) throw new Error("missing link handle");
  return current.backend.identity(path.node);
}
async function projectionChanges(current: SymlinkProjectionFixture, watermark: Watermark) {
  const page = await current.workspace.changes(watermark);
  if (page.kind !== "changes") throw new Error(`change pull returned ${page.kind}`);
  return { page, changes: page.batches.flatMap((batch) => batch.changes) };
}

test("compact symlink projection public history keeps raw targets and rename unlink reinsert identities", async () => {
  const current = await symlinkProjectionFixture();
  try {
    const bytes = new Uint8Array([65, 66]);
    await current.client.asyncCall("writeFile", ["/referent"], bytes);
    const initial = await publicScan(current.workspace),
      target = "./referent//../missing/.";
    const original = await projectionLink(current, "alias", target);
    const created = await projectionChanges(current, initial.cut.watermark);
    expect(created.page.next.seq - initial.cut.watermark.seq).toBe(1n);
    expect(created.changes).toContainEqual({
      kind: "inode",
      ...original,
      nodeKind: "symlink",
      target,
      mode: 0o600,
      mtime: expect.any(Number),
      paths: ["/alias"],
    });
    expect(
      await current.client.asyncCall("rename", [
        await projectionPath(current, "alias"),
        await projectionPath(current, "moved"),
      ]),
    ).toBe(0);
    const movedPath = await projectionPath(current, "moved");
    if (movedPath.node === undefined) throw new Error("missing moved link");
    const movedIdentity = current.backend.identity(movedPath.node);
    expect(movedIdentity.id).toBe(original.id);
    expect(movedIdentity.version).toBeGreaterThan(original.version);
    const renamed = await projectionChanges(current, created.page.next);
    expect(renamed.changes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        before: movedIdentity,
        beforePath: "/alias",
        afterPath: null,
      }),
    );
    expect(renamed.changes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        after: movedIdentity,
        beforePath: null,
        afterPath: "/moved",
      }),
    );
    expect(
      await current.client.asyncCall("removePath", [await projectionPath(current, "moved"), false]),
    ).toBe(0);
    const removed = await projectionChanges(current, renamed.page.next);
    expect(removed.changes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        before: expect.objectContaining({ id: original.id }),
        beforePath: "/moved",
        after: null,
      }),
    );
    const removedEdge = removed.changes.find(
      (change) => change.kind === "entry" && change.before?.id === original.id,
    );
    if (!removedEdge || removedEdge.kind !== "entry" || !removedEdge.before)
      throw new Error("missing removed identity");
    expect(removedEdge.before.version).toBeGreaterThan(movedIdentity.version);
    const replacement = await projectionLink(current, "moved", "../raw//target");
    expect(replacement.id).not.toBe(original.id);
    const reinserted = await projectionChanges(current, removed.page.next);
    expect(reinserted.changes).toContainEqual(
      expect.objectContaining({
        kind: "inode",
        ...replacement,
        nodeKind: "symlink",
        target: "../raw//target",
        paths: ["/moved"],
      }),
    );
    expect(await current.workspace.read("/referent")).toMatchObject({
      kind: "ok",
      value: { bytes },
    });
  } finally {
    await current.close();
  }
});

async function removeProjectedWriterLink(
  current: SymlinkProjectionFixture,
  name: string,
  expected: ReturnType<MemoryBackend["identity"]>,
  target: string,
) {
  const path = await projectionPath(current, name);
  if (path.node === undefined) throw new Error("writer link disappeared");
  expect(current.backend.identity(path.node)).toEqual(expected);
  expect(current.backend.fs.lookup(`/${name}`, false)).toMatchObject({ kind: "symlink", target });
  expect(await current.client.asyncCall("removePath", [path, false])).toBe(0);
}

test("compact symlink projection public target pressure keeps writer links and recovers with a fresh cut", async () => {
  const current = await symlinkProjectionFixture(64);
  try {
    const initial = await publicScan(current.workspace),
      target = "x".repeat(8000);
    const identities = [];
    for (let at = 0; at < 48; at++)
      identities.push(await projectionLink(current, `l${at}`, target));
    expect(await current.workspace.changes(initial.cut.watermark)).toEqual({
      kind: "pressure",
      resource: "changes",
    });
    expect((await current.workspace.changes(initial.cut.watermark)).kind).toBe("gap");
    for (let at = 0; at < 48; at++)
      await removeProjectedWriterLink(current, `l${at}`, identities[at]!, target);
    const fresh = await publicScan(current.workspace);
    expect(fresh.entries).toBe(1);
    expect(await current.workspace.changes(fresh.cut.watermark)).toMatchObject({
      kind: "changes",
      batches: [],
    });
    const next = await projectionLink(current, "after", "raw");
    const recovered = await projectionChanges(current, fresh.cut.watermark);
    expect(recovered.page.next.seq - fresh.cut.watermark.seq).toBe(1n);
    expect(recovered.changes).toContainEqual(
      expect.objectContaining({
        kind: "inode",
        ...next,
        nodeKind: "symlink",
        target: "raw",
        paths: ["/after"],
      }),
    );
  } finally {
    await current.close();
  }
});

type ProjectionCloseFailure = readonly ["workspace" | "drain", unknown];

async function projectionCloseFailure(failures: readonly ProjectionCloseFailure[]) {
  const current = await symlinkProjectionFixture();
  const workspaceClose = current.workspace.close.bind(current.workspace),
    serviceDrain = current.service.drainForOwner.bind(current.service);
  const fail = (step: ProjectionCloseFailure[0]) => {
    const failure = failures.find(([where]) => where === step);
    if (failure) throw failure[1];
  };
  const workspace = spyOn(current.workspace, "close").mockImplementation(async () => {
    await workspaceClose();
    fail("workspace");
  });
  const drain = spyOn(current.service, "drainForOwner").mockImplementation(async () => {
    await serviceDrain();
    fail("drain");
  });
  const client = spyOn(current.client, "dispose"),
    service = spyOn(current.service, "dispose"),
    clientPort = spyOn(current.pair.client.port, "close"),
    serverPort = spyOn(current.pair.server.port, "close");
  try {
    const cursor = current.workspace.snapshot();
    expect((await cursor.next()).kind).toBe("entries");
    expect(current.service.resources()).toMatchObject({ clients: 1, workspaceCursors: 1 });
    const observed: unknown[] = [];
    try {
      await current.close();
    } catch (error) {
      observed.push(error);
    }
    expect(client).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(service).toHaveBeenCalledTimes(1);
    expect(clientPort).toHaveBeenCalledTimes(2);
    expect(serverPort).toHaveBeenCalledTimes(2);
    expect(current.service.resources()).toMatchObject({
      clients: 0,
      workspaceCursors: 0,
      responses: 0,
    });
    expect(current.client.completions.size).toBe(0);
    expect(observed).toHaveLength(1);
    assertProjectionCloseErrors(observed[0], failures);
  } finally {
    for (const spy of [workspace, drain, client, service, clientPort, serverPort])
      spy.mockRestore();
    await current.close();
  }
}

function assertProjectionCloseErrors(error: unknown, failures: readonly ProjectionCloseFailure[]) {
  if (failures.length === 1) {
    expect(Object.is(error, failures[0]?.[1])).toBe(true);
    return;
  }
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw error;
  expect(error.errors).toHaveLength(failures.length);
  for (const [index, failure] of failures.entries())
    expect(Object.is(error.errors[index], failure[1])).toBe(true);
}

test("compact projection fixture cleanup attempts every release after workspace close rejects", async () => {
  await projectionCloseFailure([["workspace", new Error("workspace close refusal")]]);
});

test("compact projection fixture cleanup preserves each falsy drain rejection", async () => {
  for (const failure of [undefined, null, false, "", 0, -0, NaN])
    await projectionCloseFailure([["drain", failure]]);
});

test("compact projection fixture cleanup retains multiple error identities including signed zero", async () => {
  await projectionCloseFailure([
    ["workspace", 0],
    ["drain", -0],
  ]);
  await projectionCloseFailure([
    ["workspace", undefined],
    ["drain", null],
  ]);
  const same = new Error("same cleanup error twice");
  await projectionCloseFailure([
    ["workspace", same],
    ["drain", same],
  ]);
});
