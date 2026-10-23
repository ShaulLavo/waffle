import { expect, test } from "bun:test";
import { parseFileIdentity } from "../fs/file-identity.js";
import {
  NamespaceProjectionTable,
  NamespaceProjectionPressure,
} from "../fs/namespace-projection-table.js";
import type { PublicationEffect } from "../fs/publication.js";
import { NamespaceIndex } from "../fs/workspace-index.js";
import type { NamespaceRecord } from "../fs/workspace-protocol.js";
import { SIZES } from "../tooling/vfs-workloads.js";

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
    expect(error.component).toBe(component);
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
    seedW1(table);
    expect(observed).toBe(0);
    expect(table.allocation()).toMatchObject({ nodes: 55033, edges: 55032, nameBytes: 330160 });
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

test("matches the accepted projection for deterministic ordered mutation groups", () => {
  const table = small({ nodes: 128, nameBytes: 4096, edges: 128, extraLinks: 64 });
  const oracle = new NamespaceIndex();
  oracle.add(record(1, null, "", true));
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
    expect(table.project(effects, budget())).toEqual(oracle.project(effects, budget()));
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

test("W1 forward, reversed and mixed identity builds and compaction stay bounded", () => {
  const timings: { order: string; ms: number }[] = [];
  const orders = [
    { name: "forward", id: (value: number) => value },
    { name: "reverse", id: (value: number) => 55034 - value },
    {
      name: "permuted",
      id: (value: number) => (Math.imul(value ^ 0x57ac12, 2654435761) >>> 0) + 1,
    },
  ];
  for (const order of orders) {
    const start = performance.now(),
      table = new NamespaceProjectionTable();
    expect(seedW1(table, order.id)).toBe(55033);
    timings.push({ order: order.name, ms: performance.now() - start });
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
