import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemService } from "../fs/service.js";
import { MemoryBudget, type MemoryAllocator } from "../fs/memory-budget.js";
import {
  RootWatchAccount,
  WATCH_CONTROL_UNITS,
  type WatchResourceLimits,
} from "../fs/watch-account.js";
import { WatchIndex } from "../fs/watch-index.js";

const limits: WatchResourceLimits = {
  backingBytes: 8 * 1024 * 1024,
  controlUnits: 65536,
  workBytes: 65536,
  slabBytes: 64,
  eventBytes: 65536,
};
function account(overrides: Partial<WatchResourceLimits> = {}) {
  return new RootWatchAccount({
    ...limits,
    ...overrides,
    eventBytes:
      overrides.eventBytes ??
      Math.min(limits.eventBytes, overrides.backingBytes ?? limits.backingBytes),
  });
}
function budget(allocator?: MemoryAllocator) {
  return new MemoryBudget(
    {
      bytes: 65536,
      producers: { allocations: 16, references: 16, leases: 16 },
      progress: { bytes: 0, allocations: 0, references: 0, leases: 0 },
      waiters: 0,
      serialLimit: Number.MAX_SAFE_INTEGER,
    },
    allocator,
  );
}
function aliases(index: WatchIndex, id: bigint) {
  const result: { parent: bigint; name: string }[] = [];
  index.forEachParent(id, (parent, name) => result.push({ parent, name }));
  return result;
}

test("ordinary backends own the lazy default account and wrappers borrow its authority", async () => {
  const backend = new MemoryBackend();
  const wrapper = new MemoryBackend(undefined, undefined, backend);
  const service = new FilesystemService(backend);
  try {
    expect(wrapper.watchAccount).toBe(backend.watchAccount);
    expect(backend.watchAccount.resources()).toMatchObject({
      backingBytes: 0,
      liveBytes: 0,
      controlUnits: WATCH_CONTROL_UNITS.root,
    });
    backend.watchAccount.reserve(4).cancel();
    expect(() => new MemoryBackend(undefined, undefined, backend, limits)).toThrow(TypeError);
  } finally {
    await service.shutdown();
  }
  expect(backend.watchAccount.resources()).toMatchObject({
    stopped: true,
    backingBytes: 0,
    controlUnits: 0,
  });
});

test("watch reservations distinguish pending, committed, padding and reusable backing", () => {
  const a = account({ backingBytes: 128, slabBytes: 64, workBytes: 64 });
  try {
    const first = a.reserve(40);
    expect(a.resources()).toMatchObject({
      backingBytes: 64,
      liveBytes: 0,
      reservedBytes: 40,
      paddingBytes: 24,
    });
    first.array.fill(71);
    first.cancel();
    first.cancel();
    expect(a.resources()).toMatchObject({ liveBytes: 0, reservedBytes: 0, reusableBytes: 64 });
    const second = a.reserve(32).commit();
    expect(second.array.every((byte) => byte === 0)).toBe(true);
    expect(a.resources()).toMatchObject({
      backingBytes: 64,
      liveBytes: 32,
      reservedBytes: 0,
      paddingBytes: 32,
    });
    expect(() => second.commit()).toThrow(expect.objectContaining({ errno: 11 }));
    second.cancel();
    expect(a.resources().liveBytes).toBe(32);
    second.release();
    second.release();
    expect(a.resources().reusableBytes).toBe(64);
  } finally {
    a.close();
  }
  expect(a.resources()).toMatchObject({
    backingBytes: 0,
    liveBytes: 0,
    reservedBytes: 0,
    controlUnits: 0,
  });
  expect(() => a.reserve(4)).toThrow(expect.objectContaining({ errno: 11 }));
});

test("scratch and declared control units are independent admission limits", () => {
  const a = account({ backingBytes: 128, workBytes: 16, controlUnits: 448 });
  try {
    const scratch = a.reserve(16, "scratch");
    expect(a.resources().workBytes).toBe(16);
    expect(() => a.reserve(1, "scratch")).toThrow(expect.objectContaining({ errno: 6 }));
    expect(() => a.reserve(1)).toThrow(expect.objectContaining({ errno: 6 }));
    scratch.cancel();
    expect(a.resources().workBytes).toBe(0);
    a.reserve(16, "scratch").commit().release();
  } finally {
    a.close();
  }
});

test("a real parent is additionally charged and close returns its exact allocation baseline", () => {
  const parent = budget();
  const baseline = parent.snapshot();
  const a = new RootWatchAccount(
    { ...limits, backingBytes: 1024, controlUnits: 2048, workBytes: 64, eventBytes: 64 },
    parent,
  );
  try {
    expect(parent.snapshot().allocated).toBe(baseline.allocated);
    const first = a.reserve(40).commit();
    expect(parent.snapshot().backingBytes - baseline.backingBytes).toBe(64);
    expect(parent.snapshot().metadataUnits - baseline.metadataUnits).toBe(2048);
    first.release();
    expect(parent.snapshot().backingBytes - baseline.backingBytes).toBe(64);
    a.close();
    expect(parent.snapshot().allocated).toBe(baseline.allocated);
    expect(parent.snapshot().producerFree).toEqual(baseline.producerFree);
  } finally {
    a.close();
    parent.close();
  }
});

test("parent allocation failure rolls back declared control and leaves no watch backing", () => {
  const failure = new Error("controlled allocation failure");
  const parent = budget({
    allocate() {
      throw failure;
    },
    grow() {
      throw new Error("unexpected grow");
    },
  });
  const baseline = parent.snapshot();
  const a = new RootWatchAccount(
    { ...limits, backingBytes: 1024, controlUnits: 2048, workBytes: 64, eventBytes: 64 },
    parent,
  );
  try {
    expect(() => a.reserve(40)).toThrow(failure);
    expect(a.resources()).toMatchObject({ backingBytes: 0, liveBytes: 0, reservedBytes: 0 });
    expect(parent.snapshot().allocated).toBe(baseline.allocated);
    expect(parent.snapshot().producerFree).toEqual(baseline.producerFree);
  } finally {
    a.close();
    parent.close();
  }
});

test("root close racing allocation cannot publish backing or retain parent credit", () => {
  const parent = budget({
    allocate(spec) {
      a.close();
      return new ArrayBuffer(spec.bytes);
    },
    grow() {
      throw new Error("unexpected grow");
    },
  });
  const baseline = parent.snapshot();
  const a = new RootWatchAccount(
    { ...limits, backingBytes: 1024, controlUnits: 2048, workBytes: 64, eventBytes: 64 },
    parent,
  );
  try {
    expect(() => a.reserve(40)).toThrow(expect.objectContaining({ errno: 11 }));
    expect(a.resources()).toMatchObject({
      stopped: true,
      backingBytes: 0,
      liveBytes: 0,
      reservedBytes: 0,
      controlUnits: 0,
    });
    expect(parent.snapshot().allocated).toBe(baseline.allocated);
    expect(parent.snapshot().producerFree).toEqual(baseline.producerFree);
  } finally {
    a.close();
    parent.close();
  }
});

test("failed node rehash cancels staged growth without publishing a new identity", () => {
  const a = account({ backingBytes: 256, slabBytes: 32, workBytes: 64 });
  const index = new WatchIndex(a);
  try {
    index.upsert(1n, 0o700, true);
    index.setRoot(1n);
    const before = a.resources();
    expect(() => index.upsert(2n, 0o600, false)).toThrow(expect.objectContaining({ errno: 6 }));
    expect(index.has(1n)).toBe(true);
    expect(index.has(2n)).toBe(false);
    expect(index.resources()).toMatchObject({ nodes: 1, buckets: 2, nodeCapacityBytes: 40 });
    expect(a.resources()).toMatchObject({ liveBytes: before.liveBytes, reservedBytes: 0 });
    expect(a.resources().reusableBytes).toBeGreaterThan(0);
  } finally {
    index.close();
    a.close();
  }
});

test("packed reverse edges retain aliases, moves, permissions and pinned detached identities", () => {
  const a = account();
  const index = new WatchIndex(a);
  try {
    index.upsert(1n, 0o700, true);
    index.setRoot(1n);
    index.upsert(2n, 0o700, true);
    index.upsert(3n, 0o600, false);
    index.link(1n, 2n, "sub");
    index.link(2n, 3n, "a");
    index.link(2n, 3n, "b");
    const beforeMove = aliases(index, 2n);
    index.unlink(1n, "sub");
    index.link(1n, 2n, "moved");
    index.collect(2n);
    expect(beforeMove).toEqual([{ parent: 1n, name: "sub" }]);
    expect(aliases(index, 2n)).toEqual([{ parent: 1n, name: "moved" }]);
    expect(
      aliases(index, 3n)
        .map((edge) => edge.name)
        .sort(),
    ).toEqual(["a", "b"]);
    index.upsert(2n, 0o200, true);
    expect(index.metadata(2n)).toMatchObject({ mode: 0o200, directory: true });
    index.pin(3n);
    index.unlink(2n, "a");
    index.unlink(2n, "b");
    index.collect(3n);
    expect(index.metadata(3n)).toMatchObject({ pins: 1, links: 0 });
    index.upsert(4n, 0o600, false);
    index.link(2n, 4n, "a");
    expect(aliases(index, 3n)).toEqual([]);
    index.unpin(3n);
    expect(index.has(3n)).toBe(false);
    expect(index.has(4n)).toBe(true);
  } finally {
    index.close();
    a.close();
  }
});

test("collected nodes, edges and name holes are reused across namespace churn", () => {
  const a = account();
  const index = new WatchIndex(a);
  try {
    index.upsert(1n, 0o700, true);
    index.setRoot(1n);
    let highWater = 0;
    for (let turn = 0; turn < 5000; turn++) {
      const id = BigInt(turn + 2);
      index.upsert(id, 0o600, false);
      index.link(1n, id, "reused-name");
      index.unlink(1n, "reused-name");
      index.collect(id);
      highWater = turn === 100 ? a.resources().backingBytes : highWater;
    }
    expect(index.resources()).toMatchObject({
      nodes: 1,
      edges: 0,
      nameBytes: 0,
      nameBlockBytes: 0,
      buckets: 4,
    });
    expect(a.resources().backingBytes).toBe(highWater);
    expect(a.resources().reservedBytes).toBe(0);
    index.close();
    expect(a.resources()).toMatchObject({ liveBytes: 0, reservedBytes: 0 });
    expect(a.resources().reusableBytes).toBe(a.resources().backingBytes);
  } finally {
    index.close();
    a.close();
  }
});

function populateShape(index: WatchIndex, shape: "nodes" | "edges"): void {
  if (shape === "nodes") {
    for (let slot = 2; slot <= 4097; slot++) {
      index.upsert(BigInt(slot), 0o600, false);
      index.link(1n, BigInt(slot), String(slot));
    }
    return;
  }
  index.upsert(2n, 0o600, false);
  for (let alias = 0; alias < 16385; alias++) index.link(1n, 2n, `alias${alias}`);
}
test.each(["nodes", "edges"] as const)(
  "packed index admits the independent %s shape under an injected byte plan",
  (shape) => {
    const a = account();
    const index = new WatchIndex(a);
    try {
      index.upsert(1n, 0o700, true);
      index.setRoot(1n);
      populateShape(index, shape);
      expect(index.resources()).toMatchObject({
        nodes: shape === "nodes" ? 4097 : 2,
        edges: shape === "nodes" ? 4096 : 16385,
      });
      expect(a.resources().backingBytes).toBeLessThan(limits.backingBytes);
      expect(a.resources().reservedBytes).toBe(0);
    } finally {
      index.close();
      a.close();
    }
  },
);

test("default accounts allocate nothing before index use and closing invalidates every index allocation", () => {
  const unselected = new RootWatchAccount();
  const dormant = new WatchIndex(unselected);
  try {
    expect(unselected.resources().backingBytes).toBe(0);
    dormant.upsert(1n, 0o700, true);
    expect(unselected.resources().backingBytes).toBeGreaterThan(0);
  } finally {
    dormant.close();
    unselected.close();
  }
  const a = account();
  const index = new WatchIndex(a);
  index.upsert(1n, 0o700, true);
  a.close();
  expect(() => index.has(1n)).toThrow(expect.objectContaining({ errno: 11 }));
  expect(() => index.upsert(2n, 0o600, false)).toThrow(expect.objectContaining({ errno: 11 }));
  index.close();
  expect(a.resources()).toMatchObject({
    backingBytes: 0,
    liveBytes: 0,
    reservedBytes: 0,
    controlUnits: 0,
  });
});

test("name reservations serialize, merge freed holes and preserve UTF8 without truncation", async () => {
  const { WatchNames } = await import("../fs/watch-names.js");
  const a = account();
  const names = new WatchNames(a);
  try {
    const pending = names.stage("é\uFEFF");
    expect(() => names.stage("second")).toThrow("already staged");
    pending.cancel();
    const first = names.stage("é\uFEFF");
    const at = first.commit();
    expect(names.read(at, first.length)).toBe("é\uFEFF");
    const second = names.stage("abcdefghijkl");
    const secondAt = second.commit();
    names.release(at, first.length);
    names.release(secondAt, second.length);
    const prior = a.resources().backingBytes;
    const merged = names.stage("abcdefghijklmnopqrst");
    const mergedAt = merged.commit();
    expect(mergedAt).toBe(at);
    expect(a.resources().backingBytes).toBe(prior);
    expect(names.read(mergedAt, merged.length)).toBe("abcdefghijklmnopqrst");
    expect(() => names.stage("bad\ud800")).toThrow(expect.objectContaining({ errno: 6 }));
    expect(() => names.stage("é".repeat(513))).toThrow(expect.objectContaining({ errno: 6 }));
  } finally {
    names.close();
    a.close();
  }
});

const matchesSlot = (slot: number) => (candidate: number) => candidate === slot;

test("equal hash keys retain distinct edge slots through rehash and deletion", async () => {
  const { WatchIdIndex } = await import("../fs/watch-id-index.js");
  const a = account();
  const table = new WatchIdIndex(a);
  try {
    for (let slot = 1; slot <= 100; slot++) {
      table.stage().commit();
      table.add(3n, slot);
    }
    for (let slot = 1; slot <= 100; slot++) expect(table.get(3n, matchesSlot(slot))).toBe(slot);
    for (let slot = 1; slot <= 100; slot += 2) table.delete(3n, matchesSlot(slot));
    expect(table.get(3n, (candidate) => candidate === 1)).toBe(0);
    expect(table.get(3n, (candidate) => candidate === 100)).toBe(100);
    table.stage().commit();
    table.add(4n, 101);
    expect(table.get(3n, (candidate) => candidate === 100)).toBe(100);
  } finally {
    table.close();
    a.close();
  }
});

test("different names with the same FNV key remain independent live edges", () => {
  const a = account();
  const index = new WatchIndex(a);
  try {
    index.upsert(1n, 0o700, true);
    index.setRoot(1n);
    index.upsert(2n, 0o600, false);
    index.upsert(3n, 0o600, false);
    index.link(1n, 2n, "costarring");
    index.link(1n, 3n, "liquid");
    for (let id = 4; id < 100; id++) {
      index.upsert(BigInt(id), 0o600, false);
      index.link(1n, BigInt(id), `other${id}`);
    }
    expect(index.unlink(1n, "costarring")).toBe(2n);
    expect(aliases(index, 3n)).toEqual([{ parent: 1n, name: "liquid" }]);
    expect(index.unlink(1n, "liquid")).toBe(3n);
  } finally {
    index.close();
    a.close();
  }
});

function modelStep(index: WatchIndex, model: Map<string, bigint>, random: () => number): void {
  const name = `${"é".repeat(random() % 10)}name${random() % 31}`;
  expect(index.unlink(1n, name)).toBe(model.get(name));
  model.delete(name);
  if (random() % 3) {
    const id = BigInt(2 + (random() % 31));
    index.link(1n, id, name);
    model.set(name, id);
  }
  expect(index.resources().edges).toBe(model.size);
}
function modelNames(model: Map<string, bigint>, id: bigint): string[] {
  return Array.from(model)
    .filter((entry) => entry[1] === id)
    .map((entry) => entry[0])
    .sort();
}
function indexedNames(index: WatchIndex, id: bigint): string[] {
  return aliases(index, id)
    .map((entry) => entry.name)
    .sort();
}
test("packed links and reusable name storage match a namespace model through replacements", () => {
  const a = account();
  const index = new WatchIndex(a);
  const model = new Map<string, bigint>();
  let seed = 912341;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  try {
    index.upsert(1n, 0o700, true);
    index.setRoot(1n);
    for (let id = 2; id <= 32; id++) index.upsert(BigInt(id), 0o600, false);
    for (let step = 0; step < 1000; step++) modelStep(index, model, random);
    for (let id = 2; id <= 32; id++)
      expect(indexedNames(index, BigInt(id))).toEqual(modelNames(model, BigInt(id)));
    expect(index.resources().nameBytes).toBe(
      Array.from(model.keys(), (name) => new TextEncoder().encode(name).length).reduce(
        (a, b) => a + b,
        0,
      ),
    );
  } finally {
    index.close();
    a.close();
  }
});

test("root backing and declared control units remain separate in backend resources", async () => {
  const backend = new MemoryBackend(undefined, undefined, undefined, limits);
  const service = new FilesystemService(backend);
  try {
    const before = backend.resources();
    const allocation = backend.watchAccount.reserve(40).commit();
    const during = backend.resources();
    expect(during.bytes! - before.bytes!).toBe(64);
    expect(during.metadataBytes! - before.metadataBytes!).toBe(64);
    expect(during.watchControlUnits!).toBeGreaterThan(before.watchControlUnits!);
    allocation.release();
    expect(backend.resources().watchReusableBytes).toBe(64);
    expect(backend.resources().watchBackingBytes).toBe(64);
  } finally {
    await service.shutdown();
  }
  expect(backend.resources().watchBackingBytes).toBe(0);
});

test("packed subscriptions admit 256 ordinary file watches and account held event batches until release", async () => {
  const { WatchSubscriptions } = await import("../fs/watch-subscriptions.js");
  const a = account({ eventBytes: 65536 });
  const index = new WatchIndex(a);
  const subscriptions = new WatchSubscriptions(a, index);
  const ids: number[] = [];
  try {
    index.upsert(1n, 0o700, true);
    index.setRoot(1n);
    for (let slot = 2; slot <= 257; slot++) {
      index.upsert(BigInt(slot), 0o600, false);
      index.link(1n, BigInt(slot), String(slot));
      ids.push(subscriptions.open(1, BigInt(slot), false));
    }
    expect(subscriptions.size).toBe(256);
    for (let at = 0; at < ids.length; at++)
      subscriptions.enqueue(1, ids[at]!, { type: "change", id: BigInt(at + 2), name: null });
    expect(subscriptions.resources().queuedEvents).toBe(256);
    const batch = subscriptions.batch(1, ids[0]!);
    expect(batch.batch.events).toEqual([{ type: "change", id: 2n, name: null }]);
    expect(subscriptions.resources().queuedEvents).toBe(256);
    batch.release();
    batch.release();
    expect(subscriptions.resources().queuedEvents).toBe(255);
    expect(subscriptions.closeOwner(1)).toBe(256);
    expect(subscriptions.resources().queuedEvents).toBe(0);
    index.clear();
    subscriptions.dispose();
    expect(a.resources()).toMatchObject({ liveBytes: 0, reservedBytes: 0, eventBytes: 0 });
  } finally {
    a.close();
  }
});

function fillQueue(
  subscriptions: import("../fs/watch-subscriptions.js").WatchSubscriptions,
  id: number,
): void {
  for (let record = 0; record < 128; record++)
    subscriptions.enqueue(1, id, { type: "change", id: BigInt(record + 1), name: null });
}
test("global event storage saturation remains bounded and terminally overflows only refused queues", async () => {
  const { WatchSubscriptions } = await import("../fs/watch-subscriptions.js");
  const a = account({ eventBytes: 65536 });
  const index = new WatchIndex(a);
  const subscriptions = new WatchSubscriptions(a, index);
  const ids: number[] = [];
  try {
    index.upsert(1n, 0o700, true);
    index.setRoot(1n);
    for (let at = 0; at < 256; at++) ids.push(subscriptions.open(1, 1n, false));
    for (const id of ids) fillQueue(subscriptions, id);
    const ended = ids.filter((id) => subscriptions.overflowed(1, id));
    expect(ended.length).toBeGreaterThan(0);
    expect(ended.length).toBeLessThan(256);
    expect(a.resources().eventBytes).toBeLessThanOrEqual(65536);
    expect(a.resources().peakEventBytes).toBeLessThanOrEqual(65536);
    expect(a.resources().backingBytes).toBeLessThanOrEqual(limits.backingBytes);
    for (const id of ended)
      expect(subscriptions.batch(1, id).batch).toEqual({ kind: "overflow", events: [] });
    expect(subscriptions.closeOwner(1)).toBe(256);
    expect(subscriptions.resources().queuedEvents).toBe(0);
    subscriptions.dispose();
    index.close();
    expect(a.resources()).toMatchObject({
      liveBytes: 0,
      reservedBytes: 0,
      workBytes: 0,
      eventBytes: 0,
    });
  } finally {
    a.close();
  }
});

test("batch rollback restores queue order and owner close releases an unconsumed held batch", async () => {
  const { WatchSubscriptions } = await import("../fs/watch-subscriptions.js");
  const a = account();
  const index = new WatchIndex(a);
  const subscriptions = new WatchSubscriptions(a, index);
  try {
    index.upsert(1n, 0o700, true);
    index.setRoot(1n);
    const id = subscriptions.open(1, 1n, false);
    subscriptions.enqueue(1, id, { type: "change", id: 2n, name: "first" });
    const first = subscriptions.batch(1, id);
    subscriptions.enqueue(1, id, { type: "change", id: 3n, name: "second" });
    first.rollback();
    first.release();
    const restored = subscriptions.batch(1, id);
    expect(restored.batch.events.map((event) => event.name)).toEqual(["first", "second"]);
    subscriptions.closeOwner(1);
    index.clear();
    restored.rollback();
    subscriptions.dispose();
    expect(a.resources()).toMatchObject({
      liveBytes: 0,
      reservedBytes: 0,
      workBytes: 0,
      eventBytes: 0,
    });
  } finally {
    a.close();
  }
});
