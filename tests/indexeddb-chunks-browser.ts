import { IndexedDBStorage } from "../fs/indexeddb.js";
import { INDEXEDDB_FORMAT } from "../fs/vfs-format.js";
import { CHUNK_SIZE } from "../fs/indexeddb-chunks.js";
import { encodeRecord, encodeSnapshot, decodeSnapshot } from "../fs/storage.js";
import { assert, batch, storageTests } from "./indexeddb-storage-browser.js";

function nativeRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
async function raw<T>(name: string, work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await nativeRequest(indexedDB.open(name));
  try {
    return await work(db);
  } finally {
    db.close();
  }
}
async function edit(name: string, store: string, key: IDBValidKey, value?: unknown): Promise<void> {
  await raw(name, async (db) => {
    const tx = db.transaction(store, "readwrite", { durability: "strict" });
    const done = completion(tx);
    if (value === undefined) tx.objectStore(store).delete(key);
    else tx.objectStore(store).put(value, key);
    await done;
  });
}
async function value(name: string, store: string, key: IDBValidKey): Promise<unknown> {
  return raw(name, (db) => nativeRequest(db.transaction(store).objectStore(store).get(key)));
}
async function rejected(promise: Promise<unknown>, expected: unknown): Promise<void> {
  const outcome = await promise.then(
    () => ({ ok: true }),
    (error: unknown) => ({ error }),
  );
  assert("error" in outcome, "operation must reject");
  if (typeof expected === "string")
    assert(
      String(outcome.error).includes(expected),
      `Expected ${expected}, got ${String(outcome.error)}`,
    );
  else assert(outcome.error === expected, "exact rejection reason survives");
}
async function owned<T>(
  run: (name: string, open: () => Promise<IndexedDBStorage>) => Promise<T>,
): Promise<T> {
  const name = `waffle-indexeddb-chunks-${crypto.randomUUID()}`;
  const connections: IndexedDBStorage[] = [];
  const open = async () => {
    const storage = await IndexedDBStorage.open(name, { compactEvery: 2 });
    connections.push(storage);
    return storage;
  };
  try {
    return await run(name, open);
  } finally {
    for (const storage of connections) await storage.close();
    await nativeRequest(indexedDB.deleteDatabase(name));
  }
}
function largeBatch(generation: number, data: Uint8Array) {
  const saved = batch(generation);
  saved.upserts[1]!.size = data.length;
  saved.upserts[1]!.data = "large";
  saved.data = new Map([["large", data]]);
  return saved;
}
function pattern(size: number): Uint8Array<ArrayBuffer> {
  const input = new Uint8Array(size);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  return input;
}
interface PhysicalCounters {
  records: number;
  payloadBytes: number;
  resultByteSizes: number[];
  recordBytes: number;
  allocations: number[];
}
function countRecord(value: unknown, counters: PhysicalCounters): void {
  counters.records++;
  if (value instanceof Uint8Array) {
    counters.payloadBytes += value.length;
    counters.resultByteSizes.push(value.length);
    counters.recordBytes += value.length;
    return;
  }
  if (value && typeof value === "object" && "bytes" in value && value.bytes instanceof Uint8Array) {
    counters.payloadBytes += value.bytes.length;
    counters.resultByteSizes.push(value.bytes.length);
    counters.recordBytes += value.bytes.length + 64;
    return;
  }
  counters.resultByteSizes.push(0);
  counters.recordBytes += new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}
async function observePhysical<T>(action: () => Promise<T>) {
  const counters: PhysicalCounters = {
    records: 0,
    payloadBytes: 0,
    resultByteSizes: [],
    recordBytes: 0,
    allocations: [],
  };
  const get = IDBObjectStore.prototype.get;
  const getAll = IDBObjectStore.prototype.getAll;
  const cursor = IDBObjectStore.prototype.openCursor;
  const ArrayType = Uint8Array;
  IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
    const request = get.call(this, key);
    if (this.name === "data")
      request.addEventListener("success", () => countRecord(request.result, counters));
    return request;
  };
  IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) {
    assert(this.name !== "data", "cold range must not retrieve all physical payload values");
    return getAll.apply(this, args);
  };
  IDBObjectStore.prototype.openCursor = function (
    ...args: Parameters<IDBObjectStore["openCursor"]>
  ) {
    assert(this.name !== "data", "cold range must not scan physical payload values");
    return cursor.apply(this, args);
  };
  globalThis.Uint8Array = new Proxy(ArrayType, {
    construct(target, args) {
      const result = Reflect.construct(target, args);
      counters.allocations.push(result.byteLength);
      return result;
    },
  });
  try {
    return { result: await action(), counters };
  } finally {
    globalThis.Uint8Array = ArrayType;
    IDBObjectStore.prototype.get = get;
    IDBObjectStore.prototype.getAll = getAll;
    IDBObjectStore.prototype.openCursor = cursor;
  }
}
async function observeRange(
  storage: IndexedDBStorage,
  offset: number,
  length: number,
  fileSize: number,
) {
  const { result, counters } = await observePhysical(() =>
    storage.readRange("large", { offset, length }),
  );
  const expected = Math.max(0, Math.min(length, fileSize - offset));
  assert(
    result.length === expected && result.every((byte, i) => byte === (i + offset) % 251),
    "range bytes match",
  );
  assert(Math.max(0, ...counters.resultByteSizes) <= CHUNK_SIZE, "no whole payload get");
  assert(
    Math.max(0, ...counters.allocations) <= Math.max(expected, 32),
    "no hidden whole-file JS allocation",
  );
  const chunks = expected ? Math.ceil(((offset % CHUNK_SIZE) + expected) / CHUNK_SIZE) : 0;
  assert(counters.records === 1 + chunks, "one manifest plus intersecting chunks only");
  return { offset, length, returned: result.length, ...counters };
}
async function cancellation(storage: IndexedDBStorage): Promise<void> {
  const reason = { cancelled: "native identity" };
  const pre = new AbortController();
  pre.abort(reason);
  await rejected(storage.readRange("large", { offset: 0, length: 1, signal: pre.signal }), reason);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  crypto.subtle.digest = async (...args) => {
    entered.resolve();
    await release.promise;
    return digest(...args);
  };
  const saved = storage.persist(batch(2));
  try {
    await entered.promise;
    const queued = new AbortController();
    const read = storage.readRange("large", { offset: 0, length: 1, signal: queued.signal });
    queued.abort(reason);
    release.resolve();
    await saved;
    await rejected(read, reason);
  } finally {
    release.resolve();
    crypto.subtle.digest = digest;
  }
  const get = IDBObjectStore.prototype.get;
  const inflight = new AbortController();
  IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
    const request = get.call(this, key);
    if (this.name === "data" && Array.isArray(key))
      request.addEventListener("success", () => inflight.abort(reason), { once: true });
    return request;
  };
  try {
    await rejected(
      storage.readRange("large", { offset: 0, length: 4096, signal: inflight.signal }),
      reason,
    );
  } finally {
    IDBObjectStore.prototype.get = get;
  }
}
async function rangeControls() {
  return owned(async (name, open) => {
    let input: Uint8Array | undefined = pattern(128 * 1024 * 1024);
    const size = input.length;
    const storage = await open();
    await storage.persist(largeBatch(1, input));
    input = undefined;
    await storage.close();
    const cold = await open();
    const reopen = await observePhysical(() => cold.load());
    assert(reopen.counters.payloadBytes === 0, "cold reopen reads no physical payload bytes");
    const ranges = [];
    for (const [offset, length] of [
      [0, 4096],
      [65536, 65536],
      [65530, 4096],
      [17, 65536],
      [size - 17, 4096],
      [size, 1],
      [size + 7, 1],
      [17, 0],
    ])
      ranges.push(await observeRange(cold, offset!, length!, size));
    for (const bad of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
      await rejected(
        cold.readRange("large", { offset: bad, length: 4096 }),
        "Invalid filesystem byte range",
      );
      await rejected(
        cold.readRange("large", { offset: 4096, length: bad }),
        "Invalid filesystem byte range",
      );
    }
    await rejected(cold.readRange("missing", { offset: 0, length: 0 }), "Missing");
    const full = await observePhysical(() => cold.read("large"));
    assert(
      full.result.length === size && full.result.every((byte, index) => byte === index % 251),
      "ordinary full read assembles all immutable chunks",
    );
    assert(
      full.counters.payloadBytes === size && full.counters.records === 1 + size / CHUNK_SIZE,
      "full read gets each physical chunk once",
    );
    const fullRead = {
      returned: full.result.length,
      records: full.counters.records,
      payloadBytes: full.counters.payloadBytes,
      largestRecordBytes: Math.max(...full.counters.resultByteSizes),
      largestJSAllocation: Math.max(...full.counters.allocations),
    };
    await cancellation(cold);
    const chunk = await value(name, "data", ["large", 0]);
    assert(
      chunk && typeof chunk === "object" && "bytes" in chunk && chunk.bytes instanceof Uint8Array,
      "physical chunk exists",
    );
    chunk.bytes[0] = chunk.bytes[0]! ^ 1;
    await edit(name, "data", ["large", 0], chunk);
    await rejected(
      cold.readRange("large", { offset: 0, length: 1 }),
      "Invalid filesystem payload chunks",
    );
    await edit(name, "data", ["large", 0], { bytes: new Uint8Array(1), checksum: "0".repeat(64) });
    await rejected(
      cold.readRange("large", { offset: 0, length: 1 }),
      "Invalid filesystem payload chunks",
    );
    await edit(name, "data", ["large", 0]);
    await rejected(
      cold.readRange("large", { offset: 0, length: 1 }),
      "Invalid filesystem payload chunks",
    );
    await edit(name, "data", "large", { version: 2, size, chunkSize: 1, count: size });
    await rejected(
      cold.readRange("large", { offset: 0, length: 1 }),
      "Invalid filesystem payload chunks",
    );
    return {
      native: "Chromium IndexedDB, cold adapter reopen",
      fileSize: size,
      reopen: reopen.counters,
      fullRead,
      ranges,
      cancellation: "pre-aborted, queued, native in-flight exact reason",
      invalid: "ranges, metadata, missing payload, missing chunk, checksum corruption",
    };
  });
}
async function seedV1(name: string, marked = true): Promise<void> {
  const data = pattern(CHUNK_SIZE + 17);
  const first = largeBatch(1, data);
  first.upserts[1]!.data = "file:1";
  const second = batch(2, "second old file");
  const snapshots = await Promise.all([
    encodeSnapshot({ version: 1, generation: 1, root: 1, nodes: first.upserts }),
    encodeSnapshot({ version: 1, generation: 2, root: 1, nodes: second.upserts }),
  ]);
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    for (const store of ["metadata", "journal", "data"]) opening.result.createObjectStore(store);
  };
  const db = await nativeRequest(opening);
  try {
    const tx = db.transaction(["metadata", "data"], "readwrite", { durability: "strict" });
    const done = completion(tx);
    tx.objectStore("metadata").put(snapshots[0], 0);
    tx.objectStore("metadata").put(snapshots[1], 1);
    tx.objectStore("metadata").put(2, "active");
    if (marked) tx.objectStore("metadata").put("waffle-indexeddb-v1", "format");
    tx.objectStore("data").put(data, "file:1");
    tx.objectStore("data").put(second.data.get("file:2"), "file:2");
    await done;
  } finally {
    db.close();
  }
}
async function assertLegacy(name: string, marked: boolean): Promise<void> {
  assert(
    (await value(name, "metadata", "format")) === (marked ? "waffle-indexeddb-v1" : undefined),
    "old marker remains authoritative",
  );
  const snapshot = await decodeSnapshot(await value(name, "metadata", 1));
  assert(
    snapshot?.generation === 2 && snapshot.nodes.some((node) => node.data === "file:2"),
    "old complete namespace remains authoritative",
  );
  const first = await value(name, "data", "file:1");
  const second = await value(name, "data", "file:2");
  assert(
    first instanceof Uint8Array && first.length === CHUNK_SIZE + 17,
    "old large bytes remain complete",
  );
  assert(
    second instanceof Uint8Array && new TextDecoder().decode(second) === "second old file",
    "old second file bytes remain complete",
  );
}
async function assertMigrated(storage: IndexedDBStorage, name: string): Promise<void> {
  assert((await storage.load())?.generation === 2, "complete namespace survives migration");
  const first = await storage.readRange("file:1", { offset: CHUNK_SIZE - 3, length: 20 });
  assert(
    first.length === 20 && first.every((byte, i) => byte === (CHUNK_SIZE - 3 + i) % 251),
    "old recovery-base bytes stay available",
  );
  assert(
    new TextDecoder().decode(await storage.read("file:2")) === "second old file",
    "current bytes survive migration",
  );
  assert(
    (await value(name, "metadata", "format")) === INDEXEDDB_FORMAT,
    "new marker publishes complete root",
  );
}
async function migrationInterruption(schedule: number, marked: boolean) {
  return owned(async (name, open) => {
    await seedV1(name, marked);
    const storage = await open();
    const controller = new AbortController();
    const reason = { schedule };
    const put = IDBObjectStore.prototype.put;
    let copied = 0;
    IDBObjectStore.prototype.put = function (record: unknown, key?: IDBValidKey) {
      if (this.name === "data" && Array.isArray(key) && copied++ === schedule)
        throw new Error("injected copy interruption");
      if (this.name === "metadata" && key === "format" && schedule === 3)
        throw new Error("injected root interruption");
      if (this.name === "metadata" && key === "format" && schedule === 4)
        this.transaction.addEventListener("complete", () => controller.abort(reason), {
          once: true,
        });
      return put.call(this, record, key);
    };
    try {
      const read = storage.readRange("file:2", { offset: 0, length: 4, signal: controller.signal });
      await rejected(read, schedule === 4 ? reason : "interruption");
    } finally {
      IDBObjectStore.prototype.put = put;
      await storage.close();
    }
    if (schedule < 4) await assertLegacy(name, marked);
    const reopened = await open();
    await assertMigrated(reopened, name);
    await reopened.close();
    const twice = await open();
    await assertMigrated(twice, name);
    return {
      schedule,
      marked,
      outcome:
        schedule === 4
          ? "new complete root after committed cancellation"
          : "old complete root, interrupted copies ignored, retry complete",
    };
  });
}
async function migrationCancellation() {
  return owned(async (name, open) => {
    await seedV1(name);
    const storage = await open();
    const controller = new AbortController();
    const reason = { migration: "copy cancellation" };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (record: unknown, key?: IDBValidKey) {
      if (this.name === "data" && Array.isArray(key))
        this.transaction.addEventListener("complete", () => controller.abort(reason), {
          once: true,
        });
      return put.call(this, record, key);
    };
    try {
      await rejected(
        storage.readRange("file:2", { offset: 0, length: 4, signal: controller.signal }),
        reason,
      );
    } finally {
      IDBObjectStore.prototype.put = put;
      await storage.close();
    }
    await assertLegacy(name, true);
    const reopened = await open();
    await assertMigrated(reopened, name);
    return "cancel after first copied payload retains v1 root";
  });
}
async function breakSnapshots(name: string): Promise<void> {
  await edit(name, "metadata", 0, { json: "bad", checksum: "bad" });
  await edit(name, "metadata", 1, { json: "bad", checksum: "bad" });
}
async function corruptLegacy() {
  for (const corrupt of ["metadata", "payload", "size", "key", "snapshot"] as const)
    await owned(async (name, open) => {
      await seedV1(name);
      if (corrupt === "metadata") await edit(name, "metadata", "foreign-layout", 1);
      if (corrupt === "payload") await edit(name, "data", "file:2", { unexpected: true });
      if (corrupt === "size") await edit(name, "data", "file:2", new Uint8Array(1));
      if (corrupt === "key") await edit(name, "data", 7, new Uint8Array(1));
      if (corrupt === "snapshot") await breakSnapshots(name);
      const storage = await open();
      const expected =
        corrupt === "metadata" ? "metadata layout" : corrupt === "snapshot" ? "corrupt" : "Invalid";
      await rejected(storage.load(), expected);
      assert(
        (await value(name, "metadata", "format")) === "waffle-indexeddb-v1",
        "corrupt legacy data is never stamped v2",
      );
    });
  return "saved-v1 metadata, payload, length and key corruption rejected";
}
async function retainedRevisions() {
  return owned(async (name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    for (let generation = 2; generation <= 5; generation++)
      await storage.persist({ ...batch(generation), retainedData: ["file:1"] });
    assert(
      new TextDecoder().decode(await storage.readRange("file:1", { offset: 0, length: 2 })) ===
        "v1",
      "pinned old immutable revision survives newer generations",
    );
    for (let generation = 6; generation <= 7; generation++)
      await storage.persist(batch(generation));
    await rejected(storage.readRange("file:1", { offset: 0, length: 1 }), "Missing");
    assert(
      (await value(name, "data", ["file:1", 0])) === undefined,
      "reclaim removes old chunks, not only manifests",
    );
    await storage.close();
    const reopened = await open();
    assert((await reopened.load())?.generation === 7, "reclamation preserves recovery roots");
    return "pins survive four generations; next eligible two-base compaction deletes manifest and chunks";
  });
}
function migrationEpochFence() {
  return owned(migrationEpochFenceCase);
}
async function migrationEpochFenceCase(name: string) {
  await seedV1(name);
  const locks = {
    async request<T>(_name: string, _options: unknown, callback: (lock: unknown) => Promise<T>) {
      return callback({});
    },
  };
  const stale = await IndexedDBStorage.open(name, { locks });
  let newest: IndexedDBStorage | undefined;
  const put = IDBObjectStore.prototype.put;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let copied = false;
  IDBObjectStore.prototype.put = function (record: unknown, key?: IDBValidKey) {
    if (this.name === "data" && Array.isArray(key))
      this.transaction.addEventListener(
        "complete",
        () => {
          copied = true;
        },
        { once: true },
      );
    return put.call(this, record, key);
  };
  crypto.subtle.digest = async (...args) => {
    if (copied) {
      entered.resolve();
      await release.promise;
    }
    return digest(...args);
  };
  const pending = stale.readRange("file:2", { offset: 0, length: 4 });
  try {
    await entered.promise;
    IDBObjectStore.prototype.put = put;
    crypto.subtle.digest = digest;
    await assertLegacy(name, true);
    newest = await IndexedDBStorage.open(name, { locks });
    await assertMigrated(newest, name);
    release.resolve();
    await rejected(pending, "opened in another tab");
    await assertMigrated(newest, name);
    return "stale migration paused after first durable copy cannot write after exact epoch changes";
  } finally {
    IDBObjectStore.prototype.put = put;
    crypto.subtle.digest = digest;
    release.resolve();
    await pending.catch(() => {});
    await stale.close();
    await newest?.close();
  }
}
function migrationCloseDrain() {
  return owned(migrationCloseDrainCase);
}
async function migrationCloseDrainCase(name: string, open: () => Promise<IndexedDBStorage>) {
  await seedV1(name);
  const storage = await open();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  crypto.subtle.digest = async (...args) => {
    entered.resolve();
    await release.promise;
    return digest(...args);
  };
  const pending = storage.readRange("file:2", { offset: 0, length: 4 });
  let closed = false;
  try {
    await entered.promise;
    const closing = storage.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert(!closed, "close owns admitted migration until drain");
    await rejected(storage.readRange("file:2", { offset: 0, length: 4 }), "closed");
    crypto.subtle.digest = digest;
    release.resolve();
    assert(
      new TextDecoder().decode(await pending) === "seco",
      "admitted range finishes before close",
    );
    await closing;
    const reopened = await open();
    await assertMigrated(reopened, name);
    return "close drains admitted migration, rejects new admission, releases ownership after complete root";
  } finally {
    crypto.subtle.digest = digest;
    release.resolve();
    await pending.catch(() => {});
  }
}
async function missingChunkRecovery() {
  return owned(async (name, open) => {
    const storage = await open();
    for (let generation = 1; generation <= 3; generation++)
      await storage.persist(batch(generation));
    await storage.close();
    await edit(name, "data", ["file:3", 0]);
    const recovered = await open();
    assert(
      (await recovered.load())?.generation === 2,
      "missing newest chunk falls back to complete previous base",
    );
    assert(
      new TextDecoder().decode(await recovered.read("file:2")) === "v2",
      "previous base bytes match",
    );
    await recovered.close();
    await edit(name, "data", ["file:1", 0]);
    await edit(name, "data", ["file:2", 0]);
    const broken = await open();
    await rejected(broken.load(), "corrupt");
    return "missing latest chunks recover previous complete base; no complete base rejects, never empty";
  });
}
async function abandonedLegacyJournal(marked: boolean) {
  return owned(async (name, open) => {
    await seedV1(name, marked);
    const successor = batch(3);
    await edit(
      name,
      "journal",
      3,
      await encodeRecord({
        version: 1,
        previous: 2,
        generation: 3,
        root: 1,
        upserts: successor.upserts,
        removes: [],
      }),
    );
    await edit(name, "metadata", "active", 3);
    const storage = await open();
    await assertMigrated(storage, name);
    await storage.close();
    const reopened = await open();
    await assertMigrated(reopened, name);
    await reopened.persist(batch(3, "replacement"));
    await reopened.close();
    const current = await open();
    assert((await current.load())?.generation === 3, "replacement generation stays current");
    assert(
      new TextDecoder().decode(await current.read("file:3")) === "replacement",
      "abandoned successor cannot reconnect after migration",
    );
    return { marked, recoveredGeneration: 2, nextGeneration: 3 };
  });
}
type RevisionDamage = "missing-chunk" | "malformed-manifest" | "missing-manifest";
async function damageRevision(name: string, damage: RevisionDamage): Promise<void> {
  if (damage === "missing-chunk") return edit(name, "data", ["file:3", 0]);
  if (damage === "missing-manifest") return edit(name, "data", "file:3");
  await edit(name, "data", "file:3", { version: 2, size: CHUNK_SIZE + 1, chunkSize: 1, count: 2 });
}
async function physicalRevisionKeys(name: string, revision: string): Promise<IDBValidKey[]> {
  const keys = await raw(name, (db) =>
    nativeRequest(db.transaction("data").objectStore("data").getAllKeys()),
  );
  return keys.filter((key) => key === revision || (Array.isArray(key) && key[0] === revision));
}
async function damagedRevisionRecovery(damage: RevisionDamage) {
  return owned(async (name, open) => {
    const storage = await open();
    for (const generation of [1, 2]) await storage.persist(batch(generation));
    const large = largeBatch(3, pattern(CHUNK_SIZE + 1));
    large.upserts[1]!.data = "file:3";
    large.data = new Map([["file:3", pattern(CHUNK_SIZE + 1)]]);
    await storage.persist(large);
    await storage.close();
    await damageRevision(name, damage);
    const before = await physicalRevisionKeys(name, "file:3");
    const recovered = await open();
    const reopenedIndex = await observePhysical(() => recovered.load());
    assert(reopenedIndex.result?.generation === 2, `${damage} recovers generation 2`);
    assert(reopenedIndex.counters.payloadBytes === 0, "cold recovery does not hydrate chunk bytes");
    assert(
      new TextDecoder().decode(await recovered.read("file:2")) === "v2",
      "recovered bytes match the older complete namespace",
    );
    for (const generation of [4, 5, 6])
      await recovered.persist({ ...batch(generation), retainedData: ["file:1"] });
    assert(
      new TextDecoder().decode(await recovered.read("file:1")) === "v1",
      "runtime pin protects a detached healthy revision during damaged-revision collection",
    );
    for (const generation of [7, 8]) await recovered.persist(batch(generation));
    await recovered.close();
    const after = await physicalRevisionKeys(name, "file:3");
    assert(after.length === 0, `${damage} reclaim left ${JSON.stringify(after)}`);
    assert(
      (await physicalRevisionKeys(name, "file:1")).length === 0,
      "expired runtime pin is reclaimed after both recovery bases retire",
    );
    const reopened = await open();
    assert((await reopened.load())?.generation === 8, "collected root reopens at generation 8");
    assert(
      new TextDecoder().decode(await reopened.read("file:6")) === "v6",
      "older recovery-base bytes survive collection",
    );
    await reopened.close();
    await edit(name, "data", ["file:8", 0]);
    const older = await open();
    assert((await older.load())?.generation === 7, "older recovery base and journal remain usable");
    assert(
      new TextDecoder().decode(await older.read("file:7")) === "v7",
      "second recovery bytes survive damaged-revision reclamation",
    );
    await older.close();
    await breakSnapshots(name);
    const broken = await open();
    await rejected(broken.load(), "corrupt");
    return {
      damage,
      recoveredGeneration: 2,
      afterGeneration: 8,
      before,
      after,
      reopen: reopenedIndex.counters,
    };
  });
}
async function fatalReopen(damage: "marker" | "layout" | "key" | "manifests") {
  return owned(async (name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    await storage.close();
    if (damage === "marker") await edit(name, "metadata", "format", "foreign-format");
    if (damage === "layout") await edit(name, "metadata", "foreign-layout", 1);
    if (damage === "key") await edit(name, "data", ["file:1", -1], new Uint8Array(1));
    if (damage === "manifests") await edit(name, "data", "file:1", { invalid: true });
    const reopened = await open();
    const expected = damage === "manifests" ? "corrupt" : "Invalid";
    if (damage === "marker" || damage === "layout") await rejected(reopened.load(), "Incompatible");
    else await rejected(reopened.load(), expected);
    assert(
      (await value(name, "data", ["file:1", 0])) !== undefined,
      "fatal recovery never erases existing chunks",
    );
    return { damage, rejected: true };
  });
}
async function coldRecoveryCancellation() {
  return owned(async (_name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    await storage.close();
    const cold = await open();
    const controller = new AbortController();
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
      const request = get.call(this, key);
      if (this.name === "data" && key === "file:1")
        request.addEventListener("success", () => controller.abort(false), { once: true });
      return request;
    };
    try {
      await rejected(
        cold.readRange("file:1", { offset: 0, length: 1, signal: controller.signal }),
        false,
      );
    } finally {
      IDBObjectStore.prototype.get = get;
      await cold.close();
    }
    const reopened = await open();
    assert((await reopened.load())?.generation === 1, "cancelled validation preserves the root");
    return "false abort reason escapes cold manifest validation unchanged";
  });
}
async function boundedRangeCancellation() {
  return owned(async (_name, open) => {
    const storage = await open();
    await storage.persist(largeBatch(1, pattern(CHUNK_SIZE + 17)));
    await cancellation(storage);
    return "pre-aborted, queued and in-flight exact reasons on a 65553-byte fixture";
  });
}
export async function indexedDBReviewRepairControls() {
  const controls: [string, () => Promise<unknown>][] = [
    ["marked abandoned v1 journal", () => abandonedLegacyJournal(true)],
    ["unmarked abandoned v1 journal", () => abandonedLegacyJournal(false)],
    ["malformed newest manifest", () => damagedRevisionRecovery("malformed-manifest")],
    ["incomplete chunk reclaim", () => damagedRevisionRecovery("missing-chunk")],
    ["orphan chunk reclaim", () => damagedRevisionRecovery("missing-manifest")],
    ["unknown marker stays fatal", () => fatalReopen("marker")],
    ["unknown layout stays fatal", () => fatalReopen("layout")],
    ["unknown chunk key stays fatal", () => fatalReopen("key")],
    ["no complete manifest root stays fatal", () => fatalReopen("manifests")],
    ["cold recovery exact cancellation", coldRecoveryCancellation],
  ];
  const results = [];
  for (const [label, run] of controls) {
    const result = await run().then(
      (evidence) => ({ label, ok: true, evidence }),
      (error: unknown) => ({ label, ok: false, error: String(error) }),
    );
    results.push(result);
  }
  return results;
}
export async function indexedDBReviewPreservationControls() {
  const migration = [];
  for (const marked of [true, false])
    for (let schedule = 0; schedule <= 4; schedule++)
      migration.push(await migrationInterruption(schedule, marked));
  return {
    migration,
    cancelled: await migrationCancellation(),
    rangeCancellation: await boundedRangeCancellation(),
    corrupt: await corruptLegacy(),
    retained: await retainedRevisions(),
    epoch: await migrationEpochFence(),
    close: await migrationCloseDrain(),
    recovery: await missingChunkRecovery(),
    existing: await indexedDBExistingControls(),
  };
}
export async function indexedDBChunkControls() {
  const ranges = await rangeControls();
  const migration = [];
  for (const marked of [true, false])
    for (let schedule = 0; schedule <= 4; schedule++)
      migration.push(await migrationInterruption(schedule, marked));
  const cancelled = await migrationCancellation();
  const corrupt = await corruptLegacy();
  const retained = await retainedRevisions();
  const epoch = await migrationEpochFence();
  const close = await migrationCloseDrain();
  const recovery = await missingChunkRecovery();
  const review = await indexedDBReviewRepairControls();
  assert(
    review.every((result) => result.ok),
    JSON.stringify(review),
  );
  return { ranges, migration, cancelled, corrupt, retained, epoch, close, recovery, review };
}
export async function indexedDBExistingControls() {
  const passed: string[] = [];
  for (const test of storageTests()) {
    await test.run();
    passed.push(test.label);
  }
  return passed;
}
