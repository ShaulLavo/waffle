/** Real browser storage tests. Shared contract cases run unchanged against both backends. */
import { createRuntime, type RuntimeStartupStage } from "../index.js";
import { FilesystemClient, FilesystemService, PersistentBackend, createFilesystemConnection } from "../fs/index.js";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import type { PersistenceBatch, PersistedNode, StorageBackend } from "../fs/storage.js";
export { opfsStorageTests, runOpfsStorageTests } from "./opfs-storage-browser.js";

export function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export async function rejects(action: Promise<unknown>, match: string | RegExp): Promise<void> {
  try { await action; } catch (error) {
    assert(typeof match === "string" ? String(error).includes(match) : match.test(String(error)), `Expected ${match}, got ${error}`); return;
  }
  throw new Error(`Expected rejection containing ${match}`);
}
export const bytes = (value: string) => new TextEncoder().encode(value);
export function batch(generation: number, text = `v${generation}`): PersistenceBatch {
  return { generation, root: 1, removes: [], upserts: [
    { ino: 1, kind: "dir", mtime: generation, size: 0, children: [["file", 2]] },
    { ino: 2, kind: "file", mtime: generation, size: bytes(text).length, data: `file:${generation}` },
  ], data: new Map([[`file:${generation}`, bytes(text)]]) };
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
async function raw(name: string, work: (db: IDBDatabase) => Promise<void>): Promise<void> {
  const db = await request(indexedDB.open(name));
  try { await work(db); } finally { db.close(); }
}
async function change(name: string, store: string, key: IDBValidKey, value?: unknown): Promise<void> {
  await raw(name, db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite", { durability: "strict" });
    if (value === undefined) tx.objectStore(store).delete(key); else tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  }));
}

export interface BrowserStorageTest { label: string; run(): Promise<void> }
export interface StorageContractCase {
  label: string;
  run(name: string, open: () => Promise<StorageBackend>): Promise<void>;
  compactEvery?: number;
}
type Register = (label: string, run: StorageContractCase["run"], compactEvery?: number) => void;

async function exclusiveFilesystemCase(open: () => Promise<StorageBackend>): Promise<void> {
  const storage = await open();
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  const sibling = new FilesystemClient(client.fork());
  try {
    await client.asyncCall("writeFile", ["/created", false, true], bytes("winner"));
    await rejects(client.asyncCall("writeFile", ["/created", false, true], bytes("clobber")), "20");
    await client.asyncCall("mkdirp", ["/directory"]);
    await rejects(client.asyncCall("writeFile", ["/directory", false, true], bytes("not a directory")), "20");
    await rejects(client.asyncCall("writeFile", ["/new/", false, true], bytes("not a file")), "54");
    await rejects(client.asyncCall("writeFile", ["/fresh/file/", false, true], bytes("not a file")), "54");
    assert(await client.asyncCall("lookup", ["/fresh"]) === undefined, "failed trailing slash does not create parents");
    await rejects(client.asyncCall("writeFile", ["/directory/.", false, true], bytes("not a directory")), "20");
    await rejects(client.asyncCall("writeFile", ["/", false, true], bytes("not root")), "20");
    await rejects(client.asyncCall("writeFile", ["/created/child", false, true], bytes("not nested")), "54");
    await rejects(client.asyncCall("writeFile", ["/created", true, true], bytes("invalid modes")), "28");
    await client.asyncCall("mkdirp", ["/a"]);
    await client.asyncCall("writeFile", ["/a/../canonical", false, true], bytes("canonical"));
    assert(new TextDecoder().decode(await client.asyncCall("readFile", ["/canonical"])) === "canonical", "canonical target receives bytes");
    assert(await client.asyncCall("lookup", ["/a/../canonical"]) === undefined, "raw dot path is not a duplicate entry");
    await client.asyncCall("writeFile", ["/a/./nested/file", false, true], bytes("nested"));
    assert(new TextDecoder().decode(await client.asyncCall("readFile", ["/a/nested/file"])) === "nested", "dot path writes its canonical target");
    await client.asyncCall("writeFile", ["/a/./nested/file", false, false], bytes("ordinary"));
    assert(new TextDecoder().decode(await client.asyncCall("readFile", ["/a/nested/file"])) === "ordinary", "ordinary write uses the canonical target");
    assert(new TextDecoder().decode(await client.asyncCall("readFile", ["/a/./nested/file"])) === "ordinary", "canonical target is readable through dot path");
    await client.asyncCall("writeFile", ["/a/../other/file", false, true], bytes("other"));
    assert(new TextDecoder().decode(await client.asyncCall("readFile", ["/other/file"])) === "other", "parent traversal writes its canonical target");
    await rejects(client.asyncCall("writeFile", ["/new/.", false, true], bytes("not a file")), "44");
    assert(await client.asyncCall("lookup", ["/new"]) === undefined, "failed dot path does not create parents");
    await rejects(client.asyncCall("writeFile", ["/missing/../x", false, true], bytes("not a file")), "44");
    assert(await client.asyncCall("lookup", ["/missing"]) === undefined, "failed parent traversal does not create parents");

    const outcomes = await Promise.allSettled([
      client.asyncCall("writeFile", ["/race", false, true], bytes("first")),
      sibling.asyncCall("writeFile", ["/race", false, true], bytes("second")),
    ]);
    assert(outcomes.filter(result => result.status === "fulfilled").length === 1, "one exclusive writer must win");
    assert(outcomes.filter(result => result.status === "rejected").length === 1, "one exclusive writer must lose");
    const rejected = outcomes.find(result => result.status === "rejected");
    assert(rejected && String(rejected.reason).includes("20"), "losing writer must receive EEXIST");
    assert(/^(first|second)$/.test(new TextDecoder().decode(await client.asyncCall("readFile", ["/race"]))), "winner bytes survive");

    await client.asyncCall("writeFile", ["/created", false, false], bytes("updated"));
    assert(new TextDecoder().decode(await client.asyncCall("readFile", ["/created"])) === "updated", "ordinary writes still replace");
  } finally {
    sibling.dispose(); client.dispose(); service.dispose();
    await backend.close();
  }
}

/** Backend-independent behavior, with no assumptions about the physical persistence layout. */
export function storageContractCases(): StorageContractCase[] {
  const cases: StorageContractCase[] = [];
  const test: Register = (label, run, compactEvery) => { cases.push({ label, run, compactEvery }); };
  test("host writeFile exclusive creation is atomic", async (_name, open) => {
    await exclusiveFilesystemCase(open);
  });
  test("empty, atomic save, reload, payload copies", async (_name, open) => {
    const storage = await open();
    assert(await storage.load() === undefined, "fresh storage must be empty");
    const first = batch(1);
    const saved = storage.persist(first);
    first.data.get("file:1")!.fill(0);
    first.upserts[1]!.size = 1000;
    await saved; await storage.flush(); await storage.close();
    const reopened = await open();
    const loaded = await reopened.load();
    assert(loaded?.generation === 1, "generation survives reopen");
    loaded.nodes.length = 0;
    assert((await reopened.load())?.nodes.length === 2, "load must return owned metadata");
    assert(new TextDecoder().decode(await reopened.read("file:1")) === "v1", "caller mutation cannot change queued payload");
    const copy = await reopened.read("file:1"); copy.fill(0);
    assert(new TextDecoder().decode(await reopened.read("file:1")) === "v1", "read must return owned bytes");
    await rejects(reopened.read("missing"), /Missing|ENOENT|NotFound/);
  });

  test("storage close is idempotent", async (_name, open) => {
    const storage = await open();
    await storage.close(); await storage.close();
    await rejects(storage.load(), "closed"); await rejects(storage.persist(batch(1)), "closed");
    await rejects(storage.read("file:1"), "closed"); await rejects(storage.flush(), "closed");
    const next = await open(); assert(await next.load() === undefined, "lock released on close");
  });

  test("immutable keys, missing payloads, monotonic generations, and flush errors", async (_name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    const collision = batch(2); collision.upserts[1]!.data = "file:1"; collision.data = new Map([["file:1", bytes("xx")]]);
    await rejects(storage.persist(collision), "immutable"); await rejects(storage.flush(), "immutable");
    const missing = batch(2); missing.data.clear();
    await rejects(storage.persist(missing), "Missing");
    await rejects(storage.persist(batch(1)), "generation");
    assert((await storage.load())?.generation === 1, "failed saves leave committed index untouched");
    await storage.persist(batch(2)); await storage.flush();
    const metadataOnly = batch(3);
    metadataOnly.upserts = [metadataOnly.upserts[1]!];
    metadataOnly.upserts[0]!.data = "file:2"; metadataOnly.data.clear();
    await storage.persist(metadataOnly); await storage.flush(); await storage.close();
    const reopened = await open();
    assert((await reopened.load())?.generation === 3, "incremental metadata can reuse an existing immutable payload without resending it");
    assert(new TextDecoder().decode(await reopened.read("file:2")) === "v2", "unchanged payload remains intact after metadata-only update");
    const duplicate = batch(4);
    duplicate.upserts[1]!.data = "file:2"; duplicate.data = new Map([["file:2", bytes("v2")]]);
    await reopened.persist(duplicate); await reopened.flush();
    assert(new TextDecoder().decode(await reopened.read("file:2")) === "v2", "resubmitting identical immutable bytes works even after a cached read");
  });

  test("runtime payload pins survive collection but expire without a new pin", async (_name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    for (let n = 2; n <= 5; n++) await storage.persist({ ...batch(n), retainedData: ["file:1"] });
    assert(new TextDecoder().decode(await storage.read("file:1")) === "v1", "cold detached descriptor payload must stay pinned");
    for (let n = 6; n <= 7; n++) await storage.persist(batch(n));
    await rejects(storage.read("file:1"), /Missing|ENOENT|NotFound/);
  });

  test("incremental removals and directory validation", async (_name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    await rejects(storage.persist({ generation: 2, root: 999, upserts: [], removes: [], data: new Map() }), "metadata");
    await rejects(storage.persist({ generation: 2, root: 999, upserts: [], removes: [1, 2], data: new Map() }), "metadata");
    await storage.persist({ generation: 2, root: 1, upserts: [], removes: [999], data: new Map() });
    await rejects(storage.persist({ generation: 3, root: 1, upserts: [], removes: [2], data: new Map() }), "metadata");
    const root: PersistedNode = { ino: 1, kind: "dir", size: 0, mtime: 3, children: [] };
    await storage.persist({ generation: 3, root: 1, upserts: [root], removes: [2], data: new Map() });
    assert((await storage.load())?.nodes.length === 1, "removed inode disappears");
  });
  return cases;
}

export async function runtimeStartupCase(name: string, storage: "indexeddb" | "opfs" | false, workerURL: string | URL): Promise<void> {
  const seen: [RuntimeStartupStage, number][] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const runtime = createRuntime({ filesystem: { name, persistence: storage !== false,
    storage: storage === false ? undefined : storage, workerURL: new URL(workerURL, location.href) },
    onStartupStage(stage, timestamp) {
      seen.push([stage, timestamp]);
      if (stage === "filesystem-ready") resolveReady();
      return Promise.reject(new Error("ignored observer rejection"));
    } });
  try {
    assert((await runtime.filesystem.listFiles()).length === 0, "filesystem works despite rejected observers");
    // The diagnostic and filesystem response use different ports.
    await ready;
    const expected: RuntimeStartupStage[] = ["filesystem-worker-created", "filesystem-connect-requested", "filesystem-connected"];
    if (storage === "indexeddb") expected.push("indexeddb-open-requested", "indexeddb-open-resolved");
    if (storage !== false) expected.push("filesystem-lock-requested", "filesystem-lock-acquired");
    if (storage === "indexeddb") expected.push("filesystem-epoch-requested", "filesystem-epoch-resolved");
    expected.push("filesystem-ready");
    assert(JSON.stringify(seen.map(([stage]) => stage)) === JSON.stringify(expected), `unexpected startup sequence: ${JSON.stringify(seen)}`);
    assert(seen.every(([, timestamp]) => Number.isFinite(timestamp) && timestamp >= performance.timeOrigin), "comparable epoch clocks");
    assert(seen.every(([, timestamp], index) => index === 0 || timestamp >= seen[index - 1]![1]), "milestone clocks follow operation order");
  } finally {
    await runtime.dispose();
    // Worker.terminate() returns before Chromium releases that worker's Web Locks.
    // Fence test cleanup before the outer fixture deletes the OPFS workspace.
    if (storage === "opfs") await navigator.locks.request(`bun-wasm:filesystem:${name}`, { mode: "exclusive" }, () => {});
  }
}

function indexedDBCases(filesystemWorkerURL?: string | URL): StorageContractCase[] {
  const cases: StorageContractCase[] = [];
  const test: Register = (label, run, compactEvery) => { cases.push({ label, run, compactEvery }); };
  // Backend-suite consumers need not serve a Waffle runtime worker. Its URL opts in to runtime probes.
  if (filesystemWorkerURL !== undefined) {
    test("runtime startup milestones cross the actual filesystem worker boundary", name => runtimeStartupCase(name, "indexeddb", filesystemWorkerURL));
    test("memory startup milestones exclude storage stages across the actual filesystem worker boundary", name => runtimeStartupCase(name, false, filesystemWorkerURL));
  }
  test("IndexedDB whenBusy wait queues ownership without takeover", async (name) => {
    const owner = await IndexedDBStorage.open(name);
    const controller = new AbortController();
    let waiting: Promise<IndexedDBStorage> | undefined;
    try {
      await owner.persist(batch(1, "durable marker")); await owner.flush();
      let reportWaiting!: () => void;
      const reported = new Promise<void>(resolve => { reportWaiting = resolve; });
      waiting = IndexedDBStorage.open(name, { whenBusy: "wait", signal: controller.signal, onWaiting: reportWaiting });
      await reported;
      await owner.close();
      const next = await waiting;
      assert((await next.load())?.generation === 1, "IndexedDB waiter did not recover the saved generation");
      assert(new TextDecoder().decode(await next.read("file:1")) === "durable marker", "IndexedDB waiter did not recover saved bytes");
    } finally {
      controller.abort();
      await owner.close();
      await waiting?.then(storage => storage.close(), () => {});
    }
  });

  test("IndexedDB waiters close on versionchange instead of blocking database deletion", async name => {
    let releaseOwner!: () => void, reportOwner!: () => void;
    const held = new Promise<void>(resolve => { releaseOwner = resolve; });
    const acquired = new Promise<void>(resolve => { reportOwner = resolve; });
    const lockName = `bun-wasm:filesystem:indexeddb:${name}`;
    // Hold ownership independently of an IDB connection, so versionchange cannot
    // release it and accidentally turn this queued-waiter case into a grant race.
    const owner = navigator.locks.request(lockName, { mode: "exclusive" }, async () => { reportOwner(); await held; });
    const controller = new AbortController();
    let result: Promise<{ storage?: IndexedDBStorage; error?: unknown }> | undefined;
    try {
      await acquired;
      let reportWaiting!: () => void;
      const reported = new Promise<void>(resolve => { reportWaiting = resolve; });
      let ownershipLost = false;
      result = IndexedDBStorage.open(name, {
        whenBusy: "wait", signal: controller.signal, onWaiting: reportWaiting,
        onOwnershipLost() { ownershipLost = true; },
      }).then(storage => ({ storage }), error => ({ error }));
      await reported;
      const before = await navigator.locks.query();
      assert(before.pending?.filter(lock => lock.name === lockName).length === 1, "deletion test must hold the waiter in the queue");
      await request(indexedDB.deleteDatabase(name));
      const outcome = await result;
      assert(outcome.storage === undefined && String(outcome.error).includes("database changed"), "waiting connection did not reject versionchange");
      assert(!ownershipLost, "database deletion was misreported as a takeover");
      const snapshot = await navigator.locks.query();
      assert(!snapshot.pending?.some(lock => lock.name === lockName), "versionchange left an abandoned lock request");
    } finally {
      controller.abort();
      releaseOwner(); await owner;
      await result?.then(outcome => outcome.storage?.close());
    }
  });

  test("epoch fencing rejects a stale writer before payload, journal and compaction writes", async (name) => {
    // No loss notification simulates a frozen tab waking while its hash was pending.
    const locks = { async request<T>(_name: string, _options: unknown, callback: (lock: unknown) => Promise<T>) { return callback({}); } };
    for (const compactEvery of [1, 128]) {
      const database = `${name}-${compactEvery}`;
      const stale = await IndexedDBStorage.open(database, { locks, compactEvery });
      await stale.persist(batch(1));
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let entered!: () => void, resume!: () => void;
      const hashing = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { resume = resolve; });
      crypto.subtle.digest = async (...args) => { entered(); await held; return original(...args); };
      const obsolete = batch(2, "stale");
      obsolete.upserts[1]!.data = "stale-only";
      obsolete.data = new Map([["stale-only", bytes("stale")]]);
      const pending = stale.persist(obsolete);
      const rejected = rejects(pending, "opened in another tab");
      let newest: IndexedDBStorage | undefined;
      try {
        await hashing;
        crypto.subtle.digest = original;
        newest = await IndexedDBStorage.open(database, { locks, compactEvery });
        assert((await newest.load())?.generation === 1, "takeover reloads acknowledged state");
        await newest.persist(batch(2, "newest"));
        resume(); await rejected;
        await raw(database, async db => {
          const tx = db.transaction(["data", "metadata", "journal"], "readonly");
          const payload = await request(tx.objectStore("data").get("file:2"));
          assert(new TextDecoder().decode(payload) === "newest", "latest payload remains durable");
          assert(await request(tx.objectStore("data").get("stale-only")) === undefined, "stale payload never commits");
        });
        assert((await newest.load())?.generation === 2, "stale compaction cannot replace latest snapshot");
        await rejects(stale.persist(batch(3)), "opened in another tab");
      } finally { crypto.subtle.digest = original; resume(); await stale.close(); await newest?.close(); await request(indexedDB.deleteDatabase(database)); }
    }
  });

  test("epoch fencing stops queued persistence when the lock is stolen", async (name) => {
    let losses = 0;
    const stale = await IndexedDBStorage.open(name, { onOwnershipLost() { losses++; } });
    await stale.persist(batch(1));
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let entered!: () => void, resume!: () => void;
    const hashing = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { resume = resolve; });
    crypto.subtle.digest = async (...args) => { entered(); await held; return original(...args); };
    const pending = rejects(stale.persist(batch(2)), "opened in another tab");
    const queued = rejects(stale.persist(batch(3)), "opened in another tab");
    let newest: IndexedDBStorage | undefined;
    try {
      await hashing;
      crypto.subtle.digest = original;
      newest = await IndexedDBStorage.open(name);
      assert(losses === 1, "lock loss is reported without waiting for queued writes");
      assert((await newest.load())?.generation === 1, "new holder loads only acknowledged state");
      await newest.persist(batch(2, "new owner"));
      resume(); await Promise.all([pending, queued]);
      assert(new TextDecoder().decode(await newest.read("file:2")) === "new owner", "queued old writes never replace new data");
    } finally { crypto.subtle.digest = original; resume(); await stale.close(); await newest?.close(); }
  });

  test("epoch fencing serializes concurrent takeovers and stops displaced queues", async (name) => {
    const first = await IndexedDBStorage.open(name);
    await first.persist(batch(1));
    const opened = await Promise.allSettled(Array.from({ length: 4 }, () => IndexedDBStorage.open(name)));
    const owners = opened.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    let writers = 0;
    try {
      for (const result of opened) if (result.status === "rejected") {
        assert(String(result.reason).includes("This workspace was opened in another tab. Reload to continue here."), "startup takeover reports the complete ownership message");
      }
      await rejects(first.persist(batch(2)), "opened in another tab");
      for (const owner of owners) {
        try { await owner.persist(batch(2)); writers++; }
        catch (error) { assert(String(error).includes("opened in another tab"), String(error)); }
      }
      assert(writers === 1, `exactly one concurrent contender writes, got ${writers}`);
    } finally { await first.close(); await Promise.all(owners.map(owner => owner.close())); }
  });

  test("incremental journal without full metadata rewrites", async (name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    await storage.persist({ ...batch(2), upserts: [batch(2).upserts[1]!] });
    await raw(name, async db => {
      const tx = db.transaction(["metadata", "journal"], "readonly");
      const [snapshots, journal] = await Promise.all([
        request(tx.objectStore("metadata").get(0)), request(tx.objectStore("journal").get(2)),
      ]);
      assert(snapshots.json.includes('"generation":1'), "ordinary save must not rewrite base snapshot");
      assert(JSON.parse(journal.json).upserts.length === 1, "only changed inode is journaled");
    });
    await storage.close();
    const reopened = await open();
    assert((await reopened.load())?.nodes.find(node => node.ino === 2)?.data === "file:2", "journal replay restores changed inode");
  });

  test("corrupt journal recovers previous generation, never an empty tree", async (name, open) => {
    const storage = await open(); await storage.persist(batch(1)); await storage.persist(batch(2)); await storage.close();
    await change(name, "journal", 2, { json: "corrupt", checksum: "wrong" });
    const reopened = await open();
    assert((await reopened.load())?.generation === 1, "bad journal must fall back to intact base");
    assert(new TextDecoder().decode(await reopened.read("file:1")) === "v1", "previous data retained");
    await reopened.persist(batch(3)); await reopened.close();
    assert((await (await open()).load())?.generation === 3, "recovery can append a new valid chain");
  });

  test("generation reuse cannot resurrect abandoned journal successors", async (name, open) => {
    const original = await open();
    for (let n = 1; n <= 3; n++) await original.persist(batch(n));
    await original.close();
    await change(name, "journal", 2, { json: "corrupt middle journal", checksum: "wrong" });
    const recovered = await open();
    assert((await recovered.load())?.generation === 1, "broken chain must recover generation one");
    const replacement = batch(2, "new recovery edit");
    replacement.upserts[1]!.data = "recovered:2";
    replacement.data = new Map([["recovered:2", bytes("new recovery edit")]]);
    await recovered.persist(replacement); await recovered.close();
    const reopened = await open();
    const index = await reopened.load();
    assert(index?.generation === 2, "abandoned journal three must not reconnect to reused generation two");
    assert(index.nodes.find(node => node.ino === 2)?.data === "recovered:2", "new recovered edit must remain current");
    assert(new TextDecoder().decode(await reopened.read("recovered:2")) === "new recovery edit", "recovered edit bytes survive");
    await raw(name, async db => {
      assert(await request(db.transaction("journal").objectStore("journal").get(3)) === undefined, "abandoned successor must be discarded");
    });
  }, 128);

  test("IndexedDB pin validation does not hydrate cold payloads", async (_name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key: IDBValidKey | IDBKeyRange) {
      if (this.name === "data" && key === "file:1") throw new Error("pin validation must not hydrate cold payload bytes");
      return originalGet.call(this, key);
    };
    try { for (let n = 2; n <= 5; n++) await storage.persist({ ...batch(n), retainedData: ["file:1"] }); }
    finally { IDBObjectStore.prototype.get = originalGet; }
    assert(new TextDecoder().decode(await storage.read("file:1")) === "v1", "cold detached descriptor payload must stay pinned");
    for (let n = 6; n <= 7; n++) await storage.persist(batch(n));
    await rejects(storage.read("file:1"), "Missing");
  });

  test("both corrupt base snapshots reject instead of erasing existing storage", async (name, open) => {
    const storage = await open(); for (let n = 1; n <= 3; n++) await storage.persist(batch(n)); await storage.close();
    await change(name, "metadata", 0, { json: "bad", checksum: "bad" });
    await change(name, "metadata", 1, { json: "bad", checksum: "bad" });
    const reopened = await open(); await rejects(reopened.load(), "corrupt"); await rejects(reopened.persist(batch(4)), "corrupt");
  });

  test("compaction keeps both snapshots and collects only unreachable old data", async (_name, open) => {
    const storage = await open(); for (let n = 1; n <= 5; n++) await storage.persist(batch(n));
    assert(new TextDecoder().decode(await storage.read("file:3")) === "v3", "previous compacted snapshot data survives");
    assert(new TextDecoder().decode(await storage.read("file:4")) === "v4", "retained journal payload survives");
    assert(new TextDecoder().decode(await storage.read("file:5")) === "v5", "current data survives");
    await rejects(storage.read("file:1"), "Missing"); await rejects(storage.read("file:2"), "Missing");
  });

  test("missing latest snapshot payload recovers older valid copy", async (name, open) => {
    const storage = await open(); for (let n = 1; n <= 3; n++) await storage.persist(batch(n)); await storage.close();
    await change(name, "data", "file:3");
    const reopened = await open(); assert((await reopened.load())?.generation === 2, "invalid payload reference must not win recovery");
  });

  test("strict write transactions abort payload and metadata together", async (name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    const originalPut = IDBObjectStore.prototype.put;
    const originalTransaction = IDBDatabase.prototype.transaction;
    let strict = false;
    IDBDatabase.prototype.transaction = function(...args: Parameters<IDBDatabase["transaction"]>) {
      if (args[1] === "readwrite") { assert(args[2]?.durability === "strict", "durability must be strict"); strict = true; }
      return originalTransaction.apply(this, args);
    };
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      if (this.name === "journal") throw new DOMException("injected quota", "QuotaExceededError");
      return originalPut.call(this, value, key);
    };
    try { await rejects(storage.persist(batch(2)), "quota"); }
    finally { IDBObjectStore.prototype.put = originalPut; IDBDatabase.prototype.transaction = originalTransaction; }
    assert(strict, "strict transaction observed"); await storage.close();
    const reopened = await open(); assert((await reopened.load())?.generation === 1, "abort retains prior commit");
    await rejects(reopened.read("file:2"), "Missing");
    await raw(name, async db => {
      assert(await request(db.transaction("metadata").objectStore("metadata").get("active")) === 1, "commit marker must remain old generation");
    });
  });

  return cases;
}

/** Pass the consumer-owned worker URL to include runtime startup probes. Omit it for backend-only tests. */
export function storageTests(filesystemWorkerURL?: string | URL): BrowserStorageTest[] {
  return storageContractCases().concat(indexedDBCases(filesystemWorkerURL)).map(({ label, run, compactEvery = 2 }) => ({
    label,
    async run() {
      const name = `bun-wasm-storage-test-${crypto.randomUUID()}`;
      const opened: IndexedDBStorage[] = [];
      const open = async () => {
        const backend = await IndexedDBStorage.open(name, { compactEvery }); opened.push(backend); return backend;
      };
      try { await run(name, open); }
      finally {
        for (const backend of opened) await backend.close().catch(() => {});
        await request(indexedDB.deleteDatabase(name));
      }
    },
  }));
}

export async function runStorageTests(filter?: string): Promise<string[]> {
  const passed: string[] = [];
  for (const test of storageTests()) if (!filter || test.label.includes(filter)) {
    await test.run(); passed.push(test.label);
  }
  return passed;
}
