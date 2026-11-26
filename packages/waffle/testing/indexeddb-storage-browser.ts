import { storageReleaseCases } from "./storage-release-browser.js";
import {
  assert,
  rejects,
  bytes,
  batch,
  type BrowserStorageTest,
  type StorageContractCase,
} from "./storage-browser-helpers.js";
export {
  assert,
  rejects,
  bytes,
  batch,
  type BrowserStorageTest,
  type StorageContractCase,
} from "./storage-browser-helpers.js";
import { withStorageCleanup, type StorageAllocationHooks } from "./storage-allocation.js";
import { idleWorkspaceCases } from "./idle-workspace-browser.js";
import { checkpointFailureCases } from "./checkpoint-failure-browser.js";
import { hostFilesystemClient } from "./fixtures/filesystem-host.js";
import { permissionStorageCase } from "./fixtures/permissions-storage.js";
import { rootedSymlinkStorageCase } from "./fixtures/rooted-symlinks-storage.js";
import { fileTimesStorageCase } from "./fixtures/file-times-storage.js";
import { withVfsImplementation, type VfsImplementation } from "../fs/vfs-internal.js";
/** Real browser storage tests. Shared contract cases run unchanged against both backends. */
import { createRuntime, VfsError, type RuntimeStartupStage } from "../index.js";
import {
  FilesystemClient,
  FilesystemService,
  PersistentBackend,
  createFilesystemConnection,
} from "../fs/index.js";
import { INDEXEDDB_FORMAT } from "../fs/vfs-format.js";
import { CHUNK_SIZE } from "../fs/indexeddb-chunks.js";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import { FilesystemError, PAGE } from "../fs/protocol.js";
import { gatedIndexedDB } from "./gated-indexeddb.js";
import { assertRuntimeStartupTrace } from "./runtime-startup-proof.js";
import type {
  ChecksummedRecord,
  PersistenceBatch,
  PersistedNode,
  StorageBackend,
} from "../fs/storage.js";
import { storedTimes } from "./fixtures/file-times.js";
import {
  busyDeletesNothingCase,
  isChecksummedRecord,
  oldFormatRecord,
  startFreshCase,
} from "./fixtures/workspace-recovery.js";

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}
/** One directory of `files` small files, each with its own payload. */
function wideBatch(generation: number, files: number): PersistenceBatch {
  const saved = batch(generation);
  const file = saved.upserts[1]!;
  const root = { ...saved.upserts[0]!, children: [] as [string, number][] };
  const upserts: PersistedNode[] = [root];
  const data = new Map<string, Uint8Array>();
  for (let index = 0; index < files; index++) {
    const content = bytes(`file ${index}`);
    const key = `wide:${generation}:${index}`;
    root.children.push([`f${index}`, index + 2]);
    upserts.push({ ...file, ino: index + 2, size: content.length, data: key });
    data.set(key, content);
  }
  return { ...saved, upserts, data };
}
async function countTransactions<T>(
  action: () => Promise<T>,
): Promise<{ result: T; count: number }> {
  const transaction = IDBDatabase.prototype.transaction;
  let count = 0;
  IDBDatabase.prototype.transaction = function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    count++;
    return transaction.apply(this, args);
  } as IDBDatabase["transaction"];
  try {
    return { result: await action(), count };
  } finally {
    IDBDatabase.prototype.transaction = transaction;
  }
}
/** One file of `size` bytes, each byte its index modulo 251. */
function chunkedBatch(size: number): PersistenceBatch {
  const saved = batch(1);
  saved.upserts[1]!.size = size;
  saved.data = new Map([["file:1", Uint8Array.from({ length: size }, (_, index) => index % 251)]]);
  return saved;
}
/** Chunk gets the action placed, and the most that were unanswered at once. */
async function observeChunkGets<T>(
  action: () => Promise<T>,
): Promise<{ result: T; gets: number; inFlight: number }> {
  const get = IDBObjectStore.prototype.get;
  let gets = 0;
  let open = 0;
  let inFlight = 0;
  const answered = () => open--;
  IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
    const request = get.call(this, key);
    if (this.name !== "data" || !Array.isArray(key)) return request;
    gets++;
    inFlight = Math.max(inFlight, ++open);
    request.addEventListener("success", answered);
    request.addEventListener("error", answered);
    return request;
  };
  try {
    return { result: await action(), gets, inFlight };
  } finally {
    IDBObjectStore.prototype.get = get;
  }
}
/** Runs a read, closes the storage as soon as it returns, and reports whether every readonly
 * transaction had settled when the connection closed. */
async function settledBeforeClose(
  storage: IndexedDBStorage,
  read: () => Promise<unknown>,
): Promise<boolean> {
  const transaction = IDBDatabase.prototype.transaction;
  const close = IDBDatabase.prototype.close;
  let unsettled = 0;
  let settled = true;
  const done = () => unsettled--;
  IDBDatabase.prototype.transaction = function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const tx = transaction.apply(this, args);
    if (tx.mode !== "readonly") return tx;
    unsettled++;
    tx.addEventListener("complete", done);
    tx.addEventListener("abort", done);
    return tx;
  } as IDBDatabase["transaction"];
  IDBDatabase.prototype.close = function (this: IDBDatabase) {
    settled &&= unsettled === 0;
    close.call(this);
  };
  try {
    await read();
    await storage.close();
    return settled;
  } finally {
    IDBDatabase.prototype.transaction = transaction;
    IDBDatabase.prototype.close = close;
  }
}
function binaryBytes(values: readonly unknown[]): number {
  let total = 0;
  for (const value of values) if (value instanceof Uint8Array) total += value.byteLength;
  return total;
}
/** Bytes of Uint8Array values that bulk data-store reads returned while `action` ran. */
async function bulkBytesDuring(
  action: () => Promise<unknown>,
): Promise<{ bytes: number; failure: unknown }> {
  const getAll = IDBObjectStore.prototype.getAll;
  let bytes = 0;
  IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) {
    const request = getAll.apply(this, args);
    if (this.name !== "data") return request;
    request.addEventListener("success", () => (bytes += binaryBytes(request.result)));
    return request;
  };
  try {
    const failure = await action().then(
      () => undefined,
      (error: unknown) => error,
    );
    return { bytes, failure };
  } finally {
    IDBObjectStore.prototype.getAll = getAll;
  }
}
async function raw(name: string, work: (db: IDBDatabase) => Promise<void>): Promise<void> {
  const db = await request(indexedDB.open(name));
  try {
    await work(db);
  } finally {
    db.close();
  }
}
async function change(
  name: string,
  store: string,
  key: IDBValidKey,
  value?: unknown,
): Promise<void> {
  await raw(
    name,
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite", { durability: "strict" });
        if (value === undefined) tx.objectStore(store).delete(key);
        else tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/** Rewrites every saved snapshot and journal record into the record shape Waffle wrote before
 * nanosecond file times. Re-encoding awaits, so records are read and written in two steps. */
async function ageIndexedDbStore(name: string): Promise<void> {
  const stored: [store: string, key: IDBValidKey, value: unknown][] = [];
  await raw(name, async (db) => {
    const tx = db.transaction(["metadata", "journal"]);
    for (const store of ["metadata", "journal"]) {
      const [keys, values] = await Promise.all([
        request(tx.objectStore(store).getAllKeys()),
        request(tx.objectStore(store).getAll()),
      ]);
      keys.forEach((key, index) => stored.push([store, key, values[index]]));
    }
  });
  const aged = await Promise.all(
    stored
      .filter(([, , value]) => isChecksummedRecord(value))
      .map(async ([store, key, value]) => {
        const record = await oldFormatRecord(value as ChecksummedRecord);
        return [store, key, record] as const;
      }),
  );
  assert(aged.length > 0, "the saved workspace has records to age");
  for (const [store, key, record] of aged) await change(name, store, key, record);
}

async function reseedLegacy(name: string): Promise<void> {
  await raw(name, async (db) => {
    const tx = db.transaction(["metadata", "data"], "readwrite", { durability: "strict" });
    tx.objectStore("metadata").delete("format");
    tx.objectStore("data").put(bytes("legacy data"), "file:1");
    tx.objectStore("data").delete(["file:1", 0]);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  });
}

type Register = (label: string, run: StorageContractCase["run"], compactEvery?: number) => void;

async function exclusiveFilesystemCase(open: () => Promise<StorageBackend>): Promise<void> {
  const storage = await open();
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = hostFilesystemClient(service, connection);
  const sibling = new FilesystemClient(client.fork());
  try {
    await client.asyncCall("writeFile", ["/created", false, true], bytes("winner"));
    await rejects(client.asyncCall("writeFile", ["/created", false, true], bytes("clobber")), "20");
    await client.asyncCall("mkdirp", ["/directory"]);
    await rejects(
      client.asyncCall("writeFile", ["/directory", false, true], bytes("not a directory")),
      "20",
    );
    await rejects(client.asyncCall("writeFile", ["/new/", false, true], bytes("not a file")), "54");
    await rejects(
      client.asyncCall("writeFile", ["/fresh/file/", false, true], bytes("not a file")),
      "54",
    );
    assert(
      (await client.asyncCall("lookup", ["/fresh"])) === undefined,
      "failed trailing slash does not create parents",
    );
    await rejects(
      client.asyncCall("writeFile", ["/directory/.", false, true], bytes("not a directory")),
      "20",
    );
    await rejects(client.asyncCall("writeFile", ["/", false, true], bytes("not root")), "20");
    await rejects(
      client.asyncCall("writeFile", ["/created/child", false, true], bytes("not nested")),
      "54",
    );
    await rejects(
      client.asyncCall("writeFile", ["/created", true, true], bytes("invalid modes")),
      "28",
    );
    await client.asyncCall("mkdirp", ["/a"]);
    await client.asyncCall("writeFile", ["/a/../canonical", false, true], bytes("canonical"));
    assert(
      new TextDecoder().decode(await client.asyncCall("readFile", ["/canonical"])) === "canonical",
      "canonical target receives bytes",
    );
    const canonical = await client.asyncCall("lookup", ["/canonical"]);
    const throughDots = await client.asyncCall("lookup", ["/a/../canonical"]);
    assert(
      canonical?.kind === "file" &&
        throughDots?.kind === "file" &&
        throughDots.ino === canonical.ino,
      "dot path resolves the canonical inode",
    );
    const traversed = await client.asyncCall("lookup", ["/a"]);
    assert(
      traversed?.kind === "dir" && traversed.children.size === 0,
      "raw dot path is not a duplicate entry",
    );
    assert(
      (await client.asyncCall("listFiles", ["/"])).join("\n") === "/canonical\n/created",
      "only canonical file entries are present",
    );
    await rejects(
      client.asyncCall("writeFile", ["/a/../canonical", false, true], bytes("clobber")),
      "20",
    );
    assert(
      new TextDecoder().decode(await client.asyncCall("readFile", ["/canonical"])) === "canonical",
      "exclusive dot-path refusal preserves canonical bytes",
    );
    await client.asyncCall("writeFile", ["/a/./nested/file", false, true], bytes("nested"));
    assert(
      new TextDecoder().decode(await client.asyncCall("readFile", ["/a/nested/file"])) === "nested",
      "dot path writes its canonical target",
    );
    await client.asyncCall("writeFile", ["/a/./nested/file", false, false], bytes("ordinary"));
    assert(
      new TextDecoder().decode(await client.asyncCall("readFile", ["/a/nested/file"])) ===
        "ordinary",
      "ordinary write uses the canonical target",
    );
    assert(
      new TextDecoder().decode(await client.asyncCall("readFile", ["/a/./nested/file"])) ===
        "ordinary",
      "canonical target is readable through dot path",
    );
    await client.asyncCall("writeFile", ["/a/../other/file", false, true], bytes("other"));
    assert(
      new TextDecoder().decode(await client.asyncCall("readFile", ["/other/file"])) === "other",
      "parent traversal writes its canonical target",
    );
    await rejects(
      client.asyncCall("writeFile", ["/new/.", false, true], bytes("not a file")),
      "44",
    );
    assert(
      (await client.asyncCall("lookup", ["/new"])) === undefined,
      "failed dot path does not create parents",
    );
    await rejects(
      client.asyncCall("writeFile", ["/missing/../x", false, true], bytes("not a file")),
      "44",
    );
    assert(
      (await client.asyncCall("lookup", ["/missing"])) === undefined,
      "failed parent traversal does not create parents",
    );

    const outcomes = await Promise.allSettled([
      client.asyncCall("writeFile", ["/race", false, true], bytes("first")),
      sibling.asyncCall("writeFile", ["/race", false, true], bytes("second")),
    ]);
    assert(
      outcomes.filter((result) => result.status === "fulfilled").length === 1,
      "one exclusive writer must win",
    );
    assert(
      outcomes.filter((result) => result.status === "rejected").length === 1,
      "one exclusive writer must lose",
    );
    const rejected = outcomes.find((result) => result.status === "rejected");
    assert(rejected && String(rejected.reason).includes("20"), "losing writer must receive EEXIST");
    assert(
      /^(first|second)$/.test(
        new TextDecoder().decode(await client.asyncCall("readFile", ["/race"])),
      ),
      "winner bytes survive",
    );

    await client.asyncCall("writeFile", ["/created", false, false], bytes("updated"));
    assert(
      new TextDecoder().decode(await client.asyncCall("readFile", ["/created"])) === "updated",
      "ordinary writes still replace",
    );
  } finally {
    sibling.dispose();
    client.dispose();
    service.dispose();
    await backend.close();
  }
}

/** A page served from the owner's verified cold cache is still fenced by storage ownership. */
async function warmColdReadTakeoverCase(open: () => Promise<StorageBackend>): Promise<void> {
  const page = new Uint8Array(PAGE).fill(7);
  const seeded = await PersistentBackend.open(await open(), { intervalMs: 0 });
  const seedService = new FilesystemService(seeded);
  const seedConnection = createFilesystemConnection();
  seedService.connect(seedConnection.server);
  const seed = hostFilesystemClient(seedService, seedConnection);
  try {
    await seed.asyncCall("writeFile", ["/cold"], page);
    await seeded.flush();
  } finally {
    seed.dispose();
    seedService.dispose();
    await seeded.close();
  }
  const backend = await PersistentBackend.open(await open(), { intervalMs: 0 });
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = hostFilesystemClient(service, connection);
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    const handle: number = (await client.asyncCall("resolve", [root, "cold"])).node;
    for (let pass = 0; pass < 2; pass++) {
      const read: Uint8Array = await client.asyncCall("read", [handle, PAGE, 0]);
      assert(read.length === PAGE && read[0] === 7, "cold page reads before takeover");
    }
    // Opening the same workspace again takes ownership away from the first storage.
    await open();
    const outcome = await client.asyncCall("read", [handle, PAGE, 0]).then(
      () => "served",
      (error: unknown) => String(error),
    );
    assert(outcome !== "served", "a warm cached page is not served after takeover");
  } finally {
    client.dispose();
    service.dispose();
    await backend.close().catch(() => {});
  }
}

/** Backend-independent behavior, with no assumptions about the physical persistence layout. */
export function storageContractCases(): StorageContractCase[] {
  const cases: StorageContractCase[] = [];
  const test: Register = (label, run, compactEvery) => {
    cases.push({ label, run, compactEvery });
  };
  test("inode permissions persist across replacement and reopen", async (_name, open) => {
    await permissionStorageCase(open);
  });
  test("absolute symlink targets resolve in the root namespace after reopen", async (_name, open) => {
    await rootedSymlinkStorageCase(open);
  });
  test("nanosecond file times persist across reopen", async (_name, open) => {
    await fileTimesStorageCase(open);
  });
  test("deleteWorkspace deletes nothing while either store's writer lock is held", (name, open) =>
    busyDeletesNothingCase(name, open, batch(1)));
  test("host writeFile exclusive creation is atomic", async (_name, open) => {
    await exclusiveFilesystemCase(open);
  });
  test("empty, atomic save, reload, payload copies", async (_name, open) => {
    const storage = await open();
    assert((await storage.load()) === undefined, "fresh storage must be empty");
    const first = batch(1);
    const saved = storage.persist(first);
    first.data.get("file:1")!.fill(0);
    first.upserts[1]!.size = 1000;
    await saved;
    await storage.flush();
    await storage.close();
    const reopened = await open();
    const loaded = await reopened.load();
    assert(loaded?.generation === 1, "generation survives reopen");
    loaded.nodes.length = 0;
    assert((await reopened.load())?.nodes.length === 2, "load must return owned metadata");
    assert(
      new TextDecoder().decode(await reopened.read("file:1")) === "v1",
      "caller mutation cannot change queued payload",
    );
    const copy = await reopened.read("file:1");
    copy.fill(0);
    assert(
      new TextDecoder().decode(await reopened.read("file:1")) === "v1",
      "read must return owned bytes",
    );
    await rejects(reopened.read("missing"), /Missing|ENOENT|NotFound/);
  });

  test("storage close is idempotent", async (_name, open) => {
    const storage = await open();
    await storage.close();
    await storage.close();
    await rejects(storage.load(), "closed");
    await rejects(storage.persist(batch(1)), "closed");
    await rejects(storage.read("file:1"), "closed");
    await rejects(storage.flush(), "closed");
    const next = await open();
    assert((await next.load()) === undefined, "lock released on close");
  });

  test("immutable keys, missing payloads, monotonic generations, and flush errors", async (_name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    const collision = batch(2);
    collision.upserts[1]!.data = "file:1";
    collision.data = new Map([["file:1", bytes("xx")]]);
    await rejects(storage.persist(collision), "immutable");
    await rejects(storage.flush(), "immutable");
    const missing = batch(2);
    missing.data.clear();
    await rejects(storage.persist(missing), "Missing");
    await rejects(storage.persist(batch(1)), "generation");
    assert(
      (await storage.load())?.generation === 1,
      "failed saves leave committed index untouched",
    );
    await storage.persist(batch(2));
    await storage.flush();
    const metadataOnly = batch(3);
    metadataOnly.upserts = [metadataOnly.upserts[1]!];
    metadataOnly.upserts[0]!.data = "file:2";
    metadataOnly.data.clear();
    await storage.persist(metadataOnly);
    await storage.flush();
    await storage.close();
    const reopened = await open();
    assert(
      (await reopened.load())?.generation === 3,
      "incremental metadata can reuse an existing immutable payload without resending it",
    );
    assert(
      new TextDecoder().decode(await reopened.read("file:2")) === "v2",
      "unchanged payload remains intact after metadata-only update",
    );
    const duplicate = batch(4);
    duplicate.upserts[1]!.data = "file:2";
    duplicate.data = new Map([["file:2", bytes("v2")]]);
    await reopened.persist(duplicate);
    await reopened.flush();
    assert(
      new TextDecoder().decode(await reopened.read("file:2")) === "v2",
      "resubmitting identical immutable bytes works even after a cached read",
    );
  });

  test("runtime payload pins survive collection but expire without a new pin", async (_name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    for (let n = 2; n <= 5; n++) await storage.persist({ ...batch(n), retainedData: ["file:1"] });
    assert(
      new TextDecoder().decode(await storage.read("file:1")) === "v1",
      "cold detached descriptor payload must stay pinned",
    );
    for (let n = 6; n <= 7; n++) await storage.persist(batch(n));
    await rejects(storage.read("file:1"), /Missing|ENOENT|NotFound/);
  });

  test("incremental removals and directory validation", async (_name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    await rejects(
      storage.persist({ generation: 2, root: 999, upserts: [], removes: [], data: new Map() }),
      "metadata",
    );
    await rejects(
      storage.persist({ generation: 2, root: 999, upserts: [], removes: [1, 2], data: new Map() }),
      "metadata",
    );
    await storage.persist({ generation: 2, root: 1, upserts: [], removes: [999], data: new Map() });
    await rejects(
      storage.persist({ generation: 3, root: 1, upserts: [], removes: [2], data: new Map() }),
      "metadata",
    );
    const root: PersistedNode = { ino: 1, kind: "dir", size: 0, ...storedTimes(3), children: [] };
    await storage.persist({
      generation: 3,
      root: 1,
      upserts: [root],
      removes: [2],
      data: new Map(),
    });
    assert((await storage.load())?.nodes.length === 1, "removed inode disappears");
  });
  return cases;
}

export async function runtimeStartupCase(
  name: string,
  storage: "indexeddb" | "opfs" | false,
  workerURL: string | URL,
): Promise<void> {
  const seen: [RuntimeStartupStage, number][] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const runtime = createRuntime({
    filesystem: withVfsImplementation(
      storage === false ? "memory" : storage === "opfs" ? "opfs-memory" : "indexeddb",
      {
        name,
        mode: storage === false ? "memory" : "fast",
        workerURL: new URL(workerURL, location.href),
      },
    ),
    onStartupStage(stage, timestamp) {
      seen.push([stage, timestamp]);
      if (stage === "filesystem-ready") resolveReady();
      return Promise.reject(new Error("ignored observer rejection"));
    },
  });
  try {
    assert(
      (await runtime.filesystem.listFiles()).length === 0,
      "filesystem works despite rejected observers",
    );
    // The diagnostic and filesystem response use different ports.
    await ready;
    const expected: RuntimeStartupStage[] = [
      "filesystem-worker-created",
      "filesystem-connect-requested",
      "filesystem-connected",
    ];
    if (storage === "indexeddb")
      expected.push("indexeddb-open-requested", "indexeddb-open-resolved");
    if (storage !== false) expected.push("filesystem-lock-requested", "filesystem-lock-acquired");
    if (storage === "indexeddb")
      expected.push("filesystem-epoch-requested", "filesystem-epoch-resolved");
    expected.push("filesystem-ready");
    assertRuntimeStartupTrace(seen, expected, performance.timeOrigin);
  } finally {
    await runtime.dispose();
    // Worker.terminate() returns before Chromium releases that worker's Web Locks.
    // Fence test cleanup before the outer fixture deletes the OPFS workspace.
    if (storage === "opfs")
      await navigator.locks.request(`bun-wasm:filesystem:${name}`, { mode: "exclusive" }, () => {});
  }
}

/** Verify the selector opens existing data, not a newly named/empty workspace. */
export async function runtimeVfsCase(
  name: string,
  vfs: VfsImplementation,
  workerURL: string | URL,
  open: () => Promise<StorageBackend>,
): Promise<void> {
  const storage = await open();
  try {
    await storage.persist(batch(1, "saved before explicit VFS selection"));
    await storage.flush();
  } finally {
    await storage.close();
  }
  const runtime = createRuntime({
    filesystem: withVfsImplementation(vfs, {
      name,
      mode: vfs === "memory" ? "memory" : "fast",
      workerURL: new URL(workerURL, location.href),
    }),
  });
  try {
    assert(runtime.filesystem.vfs.implementation === vfs, "selected descriptor");
    assert(
      new TextDecoder().decode(await runtime.filesystem.readFile("/file")) ===
        "saved before explicit VFS selection",
      "existing workspace is retained",
    );
    await runtime.filesystem.writeFile("/selected", "same format");
    await runtime.filesystem.flush("/selected");
  } finally {
    await runtime.dispose();
  }
  const reopened = await open();
  try {
    const backend = await PersistentBackend.open(reopened, { intervalMs: 0 });
    try {
      await backend.prepare("readFile", ["/selected"]);
      const value = await backend.execute("readFile", ["/selected"], new Uint8Array());
      assert(
        new TextDecoder().decode(value as Uint8Array) === "same format",
        "selector preserves persisted format",
      );
    } finally {
      await backend.close();
    }
  } finally {
    await reopened.close();
  }
}

/** Assert an established invalid store fails through the production worker without a fallback. */
export async function runtimeInvalidStorageCase(
  name: string,
  vfs: VfsImplementation,
  workerURL: string | URL,
): Promise<void> {
  const runtime = createRuntime({
    filesystem: withVfsImplementation(vfs, {
      name,
      mode: vfs === "memory" ? "memory" : "fast",
      workerURL: new URL(workerURL, location.href),
    }),
  });
  const error = await runtime.filesystem.listFiles().catch((failure) => failure);
  try {
    assert(
      error instanceof VfsError && error.code === "INVALID_VFS_FORMAT" && error.vfs === vfs,
      "typed invalid format and VFS identity survive startup",
    );
    assert(runtime.filesystem.state.status === "failed", "invalid format never becomes ready");
  } finally {
    await runtime
      .dispose()
      .catch((failure) =>
        assert(failure === error, "failed-runtime disposal reports the original startup failure"),
      );
  }
}

async function runtimeInvalidFormatCase(name: string, workerURL: string | URL): Promise<void> {
  // An existing higher database version is incompatible, not a new empty workspace.
  const db = await request(indexedDB.open(name, 2));
  db.close();
  await runtimeInvalidStorageCase(name, "indexeddb", workerURL);
  const unchanged = await request(indexedDB.open(name));
  try {
    assert(unchanged.version === 2, "incompatible database was not reset");
  } finally {
    unchanged.close();
  }
}

async function runtimeInvalidSchemaCase(name: string, workerURL: string | URL): Promise<void> {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("not-a-filesystem");
  const db = await request(opening);
  db.close();
  await runtimeInvalidStorageCase(name, "indexeddb", workerURL);
  const unchanged = await request(indexedDB.open(name));
  try {
    assert(
      unchanged.objectStoreNames.length === 1 &&
        unchanged.objectStoreNames.contains("not-a-filesystem"),
      "incompatible schema was not changed",
    );
  } finally {
    unchanged.close();
  }
}

async function promptly<T>(pending: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("IndexedDB startup cancellation did not finish promptly")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function pendingRuntimeOpenCase(
  name: string,
  whenBusy: "takeover" | "wait",
  workerURL: string | URL,
  gatedWorkerURL: string | URL,
): Promise<void> {
  const NativeWorker = globalThis.Worker;
  let worker: Worker | undefined;
  let opened!: () => void, failed!: (error: Error) => void, closed!: () => void;
  const opening = new Promise<void>((resolve, reject) => {
    opened = resolve;
    failed = reject;
  });
  const lateClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const messages: string[] = [];
  const states: string[] = [];
  let terminations = 0;
  // Keep the cancelled worker alive only for the late-success probe. Count the production
  // terminate call, then physically terminate in finally after proving it cannot publish.
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      // oxlint-disable-next-line typescript/no-this-alias -- This test records the actual callback/Worker receiver.
      worker = this;
      this.addEventListener("message", (event) => {
        if (typeof event.data?.type === "string") messages.push(event.data.type);
        if (event.data?.type === "filesystem-state" && typeof event.data.status === "string")
          states.push(event.data.status);
        if (event.data?.type === "probe-open-pending") opened();
        if (event.data?.type === "probe-open-error" || event.data?.type === "filesystem-error")
          failed(new Error(event.data.message));
        if (event.data?.type === "probe-late-database-closed") closed();
      });
    }
    terminate(): void {
      terminations++;
    }
  };
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let disposal: Promise<void> | undefined;
  let restarted: ReturnType<typeof createRuntime> | undefined;
  try {
    runtime = createRuntime({
      filesystem: { name, whenBusy, workerURL: new URL(gatedWorkerURL, location.href) },
    });
    globalThis.Worker = NativeWorker;
    const operation = runtime.filesystem.mkdirp("/cancelled").catch((error) => error);
    await opening;
    disposal = runtime.dispose();
    await promptly(disposal);
    const error = await operation;
    assert(
      error instanceof FilesystemError && error.errno === 11,
      "queued host mkdirp must reject with typed ECANCELED",
    );
    assert(terminations === 1, "startup acknowledgement must terminate exactly once");
    assert(
      messages.includes("filesystem-disposed"),
      "worker must acknowledge cancellation before termination",
    );
    assert(
      runtime.filesystem.state.status === "disposed",
      "cancelled filesystem must stay disposed",
    );
    // Restart before the first open is released: neither a lock nor an epoch may escape.
    restarted = createRuntime({
      filesystem: { name, whenBusy, workerURL: new URL(workerURL, location.href) },
    });
    await promptly(restarted.filesystem.writeFile("/restarted", "new owner"));
    await restarted.filesystem.flush();
    worker!.postMessage({ probeReleaseOpen: true });
    await promptly(lateClosed);
    assert(
      messages.filter((message) => message === "probe-late-database-closed").length === 1,
      "late database must close once",
    );
    assert(!states.includes("ready"), "cancelled worker must never publish a ready backend");
    assert(
      (await restarted.filesystem.lookup("/cancelled")) === undefined,
      "cancelled mkdirp must never replay",
    );
    assert(
      new TextDecoder().decode(await restarted.filesystem.readFile("/restarted")) === "new owner",
      "late open must not displace the restarted owner",
    );
  } finally {
    globalThis.Worker = NativeWorker;
    try {
      worker?.postMessage({ probeReleaseOpen: true });
      await (disposal ?? runtime?.dispose())?.catch(() => {});
    } finally {
      if (worker) NativeWorker.prototype.terminate.call(worker);
      await restarted?.dispose();
    }
  }
}

function indexedDBCases(
  filesystemWorkerURL?: string | URL,
  gatedWorkerURL?: string | URL,
  allocation?: StorageAllocationHooks,
): StorageContractCase[] {
  const cases: StorageContractCase[] = [];
  const test: Register = (label, run, compactEvery) => {
    cases.push({ label, run, compactEvery });
  };
  test("IndexedDB takeover fences cold pages served from memory", async (_name, open) =>
    warmColdReadTakeoverCase(open));
  test("IndexedDB persists format identity and adopts validated unmarked data", async (name, open) => {
    const storage = await open();
    await storage.persist(batch(1, "legacy data"));
    await storage.close();
    await raw(name, async (db) => {
      assert(
        (await request(db.transaction("metadata").objectStore("metadata").get("format"))) ===
          INDEXEDDB_FORMAT,
        "new workspace has format identity",
      );
    });
    await reseedLegacy(name);
    const adopted = await open();
    assert((await adopted.load())?.generation === 1, "legacy namespace survives adoption");
    assert(
      new TextDecoder().decode(await adopted.read("file:1")) === "legacy data",
      "legacy payload survives adoption",
    );
    await adopted.close();
    await raw(name, async (db) => {
      assert(
        (await request(db.transaction("metadata").objectStore("metadata").get("format"))) ===
          INDEXEDDB_FORMAT,
        "validated legacy data receives identity",
      );
    });
  });
  for (const identity of ["another-format-v9", undefined])
    test(`IndexedDB rejects identity ${String(identity)} without replacing saved data`, async (name, open) => {
      const storage = await open();
      await storage.persist(batch(1, "preserved"));
      await storage.close();
      await raw(
        name,
        (db) =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction("metadata", "readwrite", { durability: "strict" });
            tx.objectStore("metadata").put(identity, "format");
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          }),
      );
      const reopened = await open();
      const error = await reopened.load().catch((failure) => failure);
      await reopened.close();
      assert(
        error instanceof VfsError && error.code === "INVALID_VFS_FORMAT",
        "malformed identity produces the typed format error",
      );
      if (filesystemWorkerURL !== undefined)
        await runtimeInvalidStorageCase(name, "indexeddb", filesystemWorkerURL);
      await raw(name, async (db) => {
        const metadata = db.transaction("metadata").objectStore("metadata");
        const [keys, value] = await Promise.all([
          request(metadata.getAllKeys()),
          request(metadata.get("format")),
        ]);
        assert(keys.includes("format") && value === identity, "malformed marker remains untouched");
        assert(
          new TextDecoder().decode(
            (await request(db.transaction("data").objectStore("data").get(["file:1", 0]))).bytes,
          ) === "preserved",
          "foreign workspace payload remains untouched",
        );
      });
      await change(name, "metadata", "format", INDEXEDDB_FORMAT);
      const restored = await open();
      assert(
        (await restored.load())?.generation === 1,
        "rejected open preserves the saved namespace",
      );
      assert(
        new TextDecoder().decode(await restored.read("file:1")) === "preserved",
        "saved payload remains recoverable",
      );
      await restored.close();
    });
  test("IndexedDB does not adopt unmarked unknown metadata", async (name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    await storage.close();
    await change(name, "metadata", "format");
    await change(name, "metadata", "foreign-layout", "untouched");
    const reopened = await open();
    await rejects(reopened.load(), "metadata layout");
    await reopened.close();
    if (filesystemWorkerURL !== undefined)
      await runtimeInvalidStorageCase(name, "indexeddb", filesystemWorkerURL);
    await raw(name, async (db) => {
      assert(
        (await request(db.transaction("metadata").objectStore("metadata").get("format"))) ===
          undefined,
        "unknown layout is not stamped",
      );
      assert(
        (await request(
          db.transaction("metadata").objectStore("metadata").get("foreign-layout"),
        )) === "untouched",
        "unknown metadata is preserved",
      );
    });
  });
  // Backend-suite consumers need not serve a Waffle runtime worker. Its URL opts in to runtime probes.
  if (filesystemWorkerURL !== undefined) {
    test("runtime VFS selection preserves existing IndexedDB workspaces", (name, open) =>
      runtimeVfsCase(name, "indexeddb", filesystemWorkerURL, open));
    test("runtime VFS selection reports incompatible formats without resetting data", (name) =>
      runtimeInvalidFormatCase(name, filesystemWorkerURL));
    test("runtime VFS selection reports incompatible schemas without changing their stores", (name) =>
      runtimeInvalidSchemaCase(name, filesystemWorkerURL));
    test("runtime startup milestones cross the actual filesystem worker boundary", (name) =>
      runtimeStartupCase(name, "indexeddb", filesystemWorkerURL));
    test("deleteWorkspace lets an old-format IndexedDB workspace start fresh", (name) =>
      startFreshCase(name, "indexeddb", filesystemWorkerURL, ageIndexedDbStore));
    test("memory startup milestones exclude storage stages across the actual filesystem worker boundary", (name) =>
      runtimeStartupCase(name, false, filesystemWorkerURL));
  }
  if (filesystemWorkerURL !== undefined && gatedWorkerURL !== undefined) {
    test("pending IndexedDB constructor failure restores the native Worker", async (name) => {
      const NativeWorker = globalThis.Worker;
      const owner = createRuntime({
        filesystem: {
          name,
          mode: "memory",
          workerURL: new URL(filesystemWorkerURL, location.href),
        },
      });
      try {
        await rejects(
          pendingRuntimeOpenCase(name, "takeover", filesystemWorkerURL, gatedWorkerURL),
          "live page runtime",
        );
        assert(
          globalThis.Worker === NativeWorker,
          "constructor failure must restore the Worker override",
        );
      } finally {
        await owner.dispose();
      }
    });
  }
  for (const whenBusy of ["takeover", "wait"] as const) {
    test(`pending IndexedDB ${whenBusy} open cancels before a late success`, async (name) => {
      const gate = gatedIndexedDB(indexedDB);
      const controller = new AbortController();
      let lockRequests = 0;
      const pending = IndexedDBStorage.open(name, {
        indexedDB: gate.factory,
        whenBusy,
        signal: controller.signal,
        locks: {
          query: () => navigator.locks.query(),
          request(...args) {
            if (args[0] === `bun-wasm:filesystem:indexeddb:${name}`) lockRequests++;
            return navigator.locks.request(...args);
          },
        },
      }).catch((error) => error);
      try {
        await gate.ready;
        controller.abort();
        const outcome = await promptly(pending);
        assert(
          outcome instanceof DOMException && outcome.name === "AbortError",
          "pending open must reject with its abort reason",
        );
        gate.release();
        assert(gate.closed === 1, "late open success must close its database");
        assert(
          lockRequests === 0,
          "cancelled open must never request ownership or publish storage",
        );
        const restarted = await IndexedDBStorage.open(name, { whenBusy });
        await restarted.close();
      } finally {
        gate.release();
        const result = await pending;
        if (result instanceof IndexedDBStorage) await result.close();
      }
    });
    if (filesystemWorkerURL !== undefined && gatedWorkerURL !== undefined) {
      test(`runtime pending IndexedDB ${whenBusy} open cancels and restarts`, (name) =>
        pendingRuntimeOpenCase(name, whenBusy, filesystemWorkerURL, gatedWorkerURL));
    }
  }
  test("IndexedDB whenBusy wait queues ownership without takeover", async (name) => {
    const owner = await IndexedDBStorage.open(name);
    const controller = new AbortController();
    let waiting: Promise<IndexedDBStorage> | undefined;
    try {
      await owner.persist(batch(1, "durable marker"));
      await owner.flush();
      let reportWaiting!: () => void;
      const reported = new Promise<void>((resolve) => {
        reportWaiting = resolve;
      });
      waiting = IndexedDBStorage.open(name, {
        whenBusy: "wait",
        signal: controller.signal,
        onWaiting: reportWaiting,
      });
      await reported;
      await owner.close();
      const next = await waiting;
      assert(
        (await next.load())?.generation === 1,
        "IndexedDB waiter did not recover the saved generation",
      );
      assert(
        new TextDecoder().decode(await next.read("file:1")) === "durable marker",
        "IndexedDB waiter did not recover saved bytes",
      );
    } finally {
      controller.abort();
      await owner.close();
      await waiting?.then(
        (storage) => storage.close(),
        () => {},
      );
    }
  });

  test("IndexedDB waiters close on versionchange instead of blocking database deletion", async (name) => {
    let releaseOwner!: () => void, reportOwner!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      reportOwner = resolve;
    });
    const lockName = `bun-wasm:filesystem:indexeddb:${name}`;
    // Hold ownership independently of an IDB connection, so versionchange cannot
    // release it and accidentally turn this queued-waiter case into a grant race.
    const owner = navigator.locks.request(lockName, { mode: "exclusive" }, async () => {
      reportOwner();
      await held;
    });
    const controller = new AbortController();
    let result: Promise<{ storage?: IndexedDBStorage; error?: unknown }> | undefined;
    try {
      await acquired;
      let reportWaiting!: () => void;
      const reported = new Promise<void>((resolve) => {
        reportWaiting = resolve;
      });
      let ownershipLost = false;
      result = IndexedDBStorage.open(name, {
        whenBusy: "wait",
        signal: controller.signal,
        onWaiting: reportWaiting,
        onOwnershipLost() {
          ownershipLost = true;
        },
      }).then(
        (storage) => ({ storage }),
        (error) => ({ error }),
      );
      await reported;
      const before = await navigator.locks.query();
      assert(
        before.pending?.filter((lock) => lock.name === lockName).length === 1,
        "deletion test must hold the waiter in the queue",
      );
      await request(indexedDB.deleteDatabase(name));
      const outcome = await result;
      assert(
        outcome.storage === undefined && String(outcome.error).includes("database changed"),
        "waiting connection did not reject versionchange",
      );
      assert(!ownershipLost, "database deletion was misreported as a takeover");
      const snapshot = await navigator.locks.query();
      assert(
        !snapshot.pending?.some((lock) => lock.name === lockName),
        "versionchange left an abandoned lock request",
      );
    } finally {
      controller.abort();
      releaseOwner();
      await owner;
      await result?.then((outcome) => outcome.storage?.close());
    }
  });

  test("epoch fencing rejects a stale writer before payload, journal and compaction writes", async (name) => {
    // No loss notification simulates a frozen tab waking while its hash was pending.
    const locks = {
      query: () => Promise.resolve(undefined),
      async request<T>(_name: string, _options: unknown, callback: (lock: unknown) => Promise<T>) {
        return callback({});
      },
    };
    for (const compactEvery of [1, 128]) {
      const database = `${name}-${compactEvery}`;
      await allocation?.allocate({ kind: "indexeddb", name: database });
      const stale = await IndexedDBStorage.open(database, { locks, compactEvery });
      await stale.persist(batch(1));
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let entered!: () => void, resume!: () => void;
      const hashing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        resume = resolve;
      });
      crypto.subtle.digest = async (...args) => {
        entered();
        await held;
        return original(...args);
      };
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
        resume();
        await rejected;
        await raw(database, async (db) => {
          const tx = db.transaction(["data", "metadata", "journal"], "readonly");
          const payload = (await request(tx.objectStore("data").get(["file:2", 0]))).bytes;
          assert(new TextDecoder().decode(payload) === "newest", "latest payload remains durable");
          assert(
            (await request(tx.objectStore("data").get("stale-only"))) === undefined,
            "stale payload never commits",
          );
        });
        assert(
          (await newest.load())?.generation === 2,
          "stale compaction cannot replace latest snapshot",
        );
        await rejects(stale.persist(batch(3)), "opened in another tab");
      } finally {
        crypto.subtle.digest = original;
        resume();
        await stale.close();
        await newest?.close();
        await request(indexedDB.deleteDatabase(database));
      }
    }
  });

  test("epoch fencing stops queued persistence when the lock is stolen", async (name) => {
    let losses = 0;
    const stale = await IndexedDBStorage.open(name, {
      onOwnershipLost() {
        losses++;
      },
    });
    await stale.persist(batch(1));
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let entered!: () => void, resume!: () => void;
    const hashing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    crypto.subtle.digest = async (...args) => {
      entered();
      await held;
      return original(...args);
    };
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
      resume();
      await Promise.all([pending, queued]);
      assert(
        new TextDecoder().decode(await newest.read("file:2")) === "new owner",
        "queued old writes never replace new data",
      );
    } finally {
      crypto.subtle.digest = original;
      resume();
      await stale.close();
      await newest?.close();
    }
  });

  test("epoch fencing serializes concurrent takeovers and stops displaced queues", async (name) => {
    const first = await IndexedDBStorage.open(name);
    await first.persist(batch(1));
    const opened = await Promise.allSettled(
      Array.from({ length: 4 }, () => IndexedDBStorage.open(name)),
    );
    const owners = opened.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    let writers = 0;
    try {
      for (const result of opened)
        if (result.status === "rejected") {
          assert(
            String(result.reason).includes(
              "This workspace was opened in another tab. Reload to continue here.",
            ),
            "startup takeover reports the complete ownership message",
          );
        }
      await rejects(first.persist(batch(2)), "opened in another tab");
      for (const owner of owners) {
        try {
          await owner.persist(batch(2));
          writers++;
        } catch (error) {
          assert(String(error).includes("opened in another tab"), String(error));
        }
      }
      assert(writers === 1, `exactly one concurrent contender writes, got ${writers}`);
    } finally {
      await first.close();
      await Promise.all(owners.map((owner) => owner.close()));
    }
  });

  test("incremental journal without full metadata rewrites", async (name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    await storage.persist({ ...batch(2), upserts: [batch(2).upserts[1]!] });
    await raw(name, async (db) => {
      const tx = db.transaction(["metadata", "journal"], "readonly");
      const [snapshots, journal] = await Promise.all([
        request(tx.objectStore("metadata").get(0)),
        request(tx.objectStore("journal").get(2)),
      ]);
      assert(
        snapshots.json.includes('"generation":1'),
        "ordinary save must not rewrite base snapshot",
      );
      assert(JSON.parse(journal.json).upserts.length === 1, "only changed inode is journaled");
    });
    await storage.close();
    const reopened = await open();
    assert(
      (await reopened.load())?.nodes.find((node) => node.ino === 2)?.data === "file:2",
      "journal replay restores changed inode",
    );
  });

  test("corrupt journal recovers previous generation, never an empty tree", async (name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    await storage.persist(batch(2));
    await storage.close();
    await change(name, "journal", 2, { json: "corrupt", checksum: "wrong" });
    const reopened = await open();
    assert((await reopened.load())?.generation === 1, "bad journal must fall back to intact base");
    assert(
      new TextDecoder().decode(await reopened.read("file:1")) === "v1",
      "previous data retained",
    );
    await reopened.persist(batch(3));
    await reopened.close();
    assert(
      (await (await open()).load())?.generation === 3,
      "recovery can append a new valid chain",
    );
  });

  test(
    "generation reuse cannot resurrect abandoned journal successors",
    async (name, open) => {
      const original = await open();
      for (let n = 1; n <= 3; n++) await original.persist(batch(n));
      await original.close();
      await change(name, "journal", 2, { json: "corrupt middle journal", checksum: "wrong" });
      const recovered = await open();
      assert(
        (await recovered.load())?.generation === 1,
        "broken chain must recover generation one",
      );
      const replacement = batch(2, "new recovery edit");
      replacement.upserts[1]!.data = "recovered:2";
      replacement.data = new Map([["recovered:2", bytes("new recovery edit")]]);
      await recovered.persist(replacement);
      await recovered.close();
      const reopened = await open();
      const index = await reopened.load();
      assert(
        index?.generation === 2,
        "abandoned journal three must not reconnect to reused generation two",
      );
      assert(
        index.nodes.find((node) => node.ino === 2)?.data === "recovered:2",
        "new recovered edit must remain current",
      );
      assert(
        new TextDecoder().decode(await reopened.read("recovered:2")) === "new recovery edit",
        "recovered edit bytes survive",
      );
      await raw(name, async (db) => {
        assert(
          (await request(db.transaction("journal").objectStore("journal").get(3))) === undefined,
          "abandoned successor must be discarded",
        );
      });
    },
    128,
  );

  test("IndexedDB reopen reads every payload manifest in one transaction", async (_name, open) => {
    const files = 300;
    const storage = await open();
    await storage.persist(wideBatch(1, files));
    await storage.close();
    const cold = await open();
    const result = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result")!;
    let resultReads = 0;
    Object.defineProperty(IDBRequest.prototype, "result", {
      ...result,
      get(this: IDBRequest) {
        resultReads++;
        return result.get!.call(this);
      },
    });
    const reopen = await countTransactions(() => cold.load()).finally(() =>
      Object.defineProperty(IDBRequest.prototype, "result", result),
    );
    assert(reopen.result?.nodes.length === files + 1, "every file survives reopen");
    assert(reopen.count === 1, `reopen used ${reopen.count} transactions for ${files} payloads`);
    // WebKit rebuilds a request's whole result array on every read of `result`.
    assert(resultReads < files, `reopen read IDBRequest.result ${resultReads} times`);
    for (const index of [0, 150, files - 1])
      assert(
        new TextDecoder().decode(await cold.read(`wide:1:${index}`)) === `file ${index}`,
        "payload bytes survive reopen",
      );
    await cold.close();
  });

  test("IndexedDB cold reads take one transaction and verify every chunk", async (name, open) => {
    const size = 3 * CHUNK_SIZE + 100;
    const content = Uint8Array.from({ length: size }, (_, index) => index % 251);
    const saved = batch(1);
    saved.upserts[1]!.size = size;
    saved.data = new Map([["file:1", content]]);
    const storage = await open();
    await storage.persist(saved);
    await storage.close();
    const cold = await open();
    await cold.load();
    const full = await countTransactions(() => cold.read("file:1"));
    assert(full.count === 1, `a full read used ${full.count} transactions`);
    assert(
      full.result.length === size && full.result.every((byte, index) => byte === index % 251),
      "full read bytes match",
    );
    const part = await countTransactions(() =>
      cold.readRange("file:1", { offset: 10, length: 2 * CHUNK_SIZE }),
    );
    assert(part.count === 1, `a range read used ${part.count} transactions`);
    assert(
      part.result.length === 2 * CHUNK_SIZE &&
        part.result.every((byte, index) => byte === (index + 10) % 251),
      "range bytes match",
    );
    await cold.close();
    // Damage a chunk that a range covers whole, keeping its stored checksum.
    let middle: { bytes: Uint8Array; checksum: string } | undefined;
    await raw(name, async (db) => {
      middle = await request(db.transaction("data").objectStore("data").get(["file:1", 1]));
    });
    middle!.bytes[7] = middle!.bytes[7]! ^ 1;
    await change(name, "data", ["file:1", 1], middle);
    const damaged = await open();
    await damaged.load();
    await rejects(
      damaged.readRange("file:1", { offset: 0, length: 3 * CHUNK_SIZE }),
      "Invalid filesystem payload chunks",
    );
    await rejects(damaged.read("file:1"), "Invalid filesystem payload chunks");
    const edge = await damaged.readRange("file:1", { offset: 5, length: 100 });
    assert(
      edge.every((byte, index) => byte === (index + 5) % 251),
      "an undamaged chunk still reads",
    );
    await damaged.close();
  });

  test("IndexedDB cold reads of empty ranges and large files stay bounded", async (_name, open) => {
    const chunks = 40;
    const size = chunks * CHUNK_SIZE + 10;
    const storage = await open();
    await storage.persist(chunkedBatch(size));
    await storage.close();
    const cold = await open();
    await cold.load();
    const empty = await observeChunkGets(() =>
      Promise.all([
        cold.readRange("file:1", { offset: 17, length: 0 }),
        cold.readRange("file:1", { offset: size, length: 1 }),
        cold.readRange("file:1", { offset: size + 5 * CHUNK_SIZE, length: 1 }),
      ]),
    );
    assert(
      empty.result.every((bytes) => bytes.length === 0),
      "empty ranges return no bytes",
    );
    assert(empty.gets === 0, `empty ranges requested ${empty.gets} chunks`);
    const whole = await observeChunkGets(() => cold.read("file:1"));
    assert(
      whole.result.length === size && whole.result.every((byte, index) => byte === index % 251),
      "large read bytes match",
    );
    assert(whole.gets === chunks + 1, `large read requested ${whole.gets} chunks`);
    assert(
      whole.inFlight < chunks / 2,
      `large read kept ${whole.inFlight} of ${chunks + 1} chunk requests in flight`,
    );
    await cold.close();
  });

  test("IndexedDB cold reads stop checksums on takeover and settle before close", async (name) => {
    const chunks = 40;
    const stale = await IndexedDBStorage.open(name);
    await stale.persist(chunkedBatch(chunks * CHUNK_SIZE));
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let digests = 0;
    crypto.subtle.digest = async (...args) => {
      if (++digests === 1) {
        entered.resolve();
        await held.promise;
      }
      return original(...args);
    };
    const reading = stale.read("file:1").then(
      () => undefined,
      (error: unknown) => error,
    );
    let newest: IndexedDBStorage | undefined;
    try {
      await entered.promise;
      newest = await IndexedDBStorage.open(name);
      held.resolve();
      const outcome = await reading;
      assert(
        String(outcome).includes("opened in another tab"),
        `stale read got ${String(outcome)}`,
      );
      assert(digests < chunks, `the displaced read still hashed ${digests} of ${chunks} chunks`);
    } finally {
      crypto.subtle.digest = original;
      held.resolve();
      await reading;
      await stale.close();
    }
    const settled = await settledBeforeClose(newest!, () =>
      newest!.readRange("file:1", { offset: 0, length: 0 }),
    );
    assert(settled, "close released the connection before a returned read settled");
  });

  test("IndexedDB payload sizes follow commits, recovery bases and journals", async (_name, open) => {
    const storage = await open();
    const retain = (key: string, size: number) => storage.retainPayload(key, size).release();
    await storage.persist(batch(1, "one"));
    retain("file:1", 3);
    await rejects(
      Promise.resolve().then(() => retain("file:1", 4)),
      "size mismatch",
    );
    for (let generation = 2; generation <= 4; generation++)
      await storage.persist(batch(generation, "x".repeat(generation)));
    // Replaced in the tree, file:3 is still named by a recovery base or a kept journal.
    retain("file:3", 3);
    retain("file:4", 4);
    for (let generation = 5; generation <= 8; generation++)
      await storage.persist(batch(generation, "x".repeat(generation)));
    await rejects(
      Promise.resolve().then(() => retain("file:1", 3)),
      "Missing",
    );
    retain("file:8", 8);
    await storage.close();
    const reopened = await open();
    await reopened.load();
    reopened.retainPayload("file:8", 8).release();
    await rejects(
      Promise.resolve().then(() => reopened.retainPayload("file:8", 7)),
      "size mismatch",
    );
    await reopened.close();
  });

  test("IndexedDB reopen rejects binary data keys without loading their values", async (name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    await storage.close();
    const binary = new Uint8Array([1, 2, 3]).buffer;
    await change(name, "data", binary, new Uint8Array(8 * 1024 * 1024));
    const reopened = await open();
    const loaded = await bulkBytesDuring(() => reopened.load());
    await reopened.close();
    assert(
      String(loaded.failure).includes("Invalid"),
      `binary key must stay fatal, got ${String(loaded.failure)}`,
    );
    assert(loaded.bytes === 0, `reopen loaded ${loaded.bytes} bytes under invalid keys`);
    await raw(name, async (db) => {
      const kept = await request(db.transaction("data").objectStore("data").getKey(binary));
      assert(kept !== undefined, "fatal reopen keeps the invalid record");
    });
  });

  test("IndexedDB pin validation does not hydrate cold payloads", async (_name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
      if (this.name === "data" && key === "file:1")
        throw new Error("pin validation must not hydrate cold payload bytes");
      return originalGet.call(this, key);
    };
    try {
      for (let n = 2; n <= 5; n++) await storage.persist({ ...batch(n), retainedData: ["file:1"] });
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }
    assert(
      new TextDecoder().decode(await storage.read("file:1")) === "v1",
      "cold detached descriptor payload must stay pinned",
    );
    for (let n = 6; n <= 7; n++) await storage.persist(batch(n));
    await rejects(storage.read("file:1"), "Missing");
  });

  test("both corrupt base snapshots reject instead of erasing existing storage", async (name, open) => {
    const storage = await open();
    for (let n = 1; n <= 3; n++) await storage.persist(batch(n));
    await storage.close();
    await change(name, "metadata", 0, { json: "bad", checksum: "bad" });
    await change(name, "metadata", 1, { json: "bad", checksum: "bad" });
    const reopened = await open();
    await rejects(reopened.load(), "corrupt");
    await rejects(reopened.persist(batch(4)), "corrupt");
    await reopened.close();
    if (filesystemWorkerURL !== undefined)
      await runtimeInvalidStorageCase(name, "indexeddb", filesystemWorkerURL);
  });

  test("compaction keeps both snapshots and collects only unreachable old data", async (_name, open) => {
    const storage = await open();
    for (let n = 1; n <= 5; n++) await storage.persist(batch(n));
    assert(
      new TextDecoder().decode(await storage.read("file:3")) === "v3",
      "previous compacted snapshot data survives",
    );
    assert(
      new TextDecoder().decode(await storage.read("file:4")) === "v4",
      "retained journal payload survives",
    );
    assert(
      new TextDecoder().decode(await storage.read("file:5")) === "v5",
      "current data survives",
    );
    await rejects(storage.read("file:1"), "Missing");
    await rejects(storage.read("file:2"), "Missing");
  });

  test("missing latest snapshot payload recovers older valid copy", async (name, open) => {
    const storage = await open();
    for (let n = 1; n <= 3; n++) await storage.persist(batch(n));
    await storage.close();
    await change(name, "data", "file:3");
    const reopened = await open();
    assert(
      (await reopened.load())?.generation === 2,
      "invalid payload reference must not win recovery",
    );
  });

  test("strict write transactions abort payload and metadata together", async (name, open) => {
    const storage = await open();
    await storage.persist(batch(1));
    const originalPut = IDBObjectStore.prototype.put;
    const originalTransaction = IDBDatabase.prototype.transaction;
    let strict = false;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
      if (args[1] === "readwrite") {
        assert(args[2]?.durability === "strict", "durability must be strict");
        strict = true;
      }
      return originalTransaction.apply(this, args);
    };
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === "journal") throw new DOMException("injected quota", "QuotaExceededError");
      return originalPut.call(this, value, key);
    };
    try {
      await rejects(storage.persist(batch(2)), "quota");
    } finally {
      IDBObjectStore.prototype.put = originalPut;
      IDBDatabase.prototype.transaction = originalTransaction;
    }
    assert(strict, "strict transaction observed");
    await storage.close();
    const reopened = await open();
    assert((await reopened.load())?.generation === 1, "abort retains prior commit");
    await rejects(reopened.read("file:2"), "Missing");
    await raw(name, async (db) => {
      assert(
        (await request(db.transaction("metadata").objectStore("metadata").get("active"))) === 1,
        "commit marker must remain old generation",
      );
    });
  });

  return cases;
}

/** Pass the consumer-owned worker URL to include runtime startup probes. Omit it for backend-only tests. */
export function storageTests(
  filesystemWorkerURL?: string | URL,
  gatedWorkerURL?: string | URL,
  allocation?: StorageAllocationHooks,
): BrowserStorageTest[] {
  return storageContractCases()
    .concat(
      indexedDBCases(filesystemWorkerURL, gatedWorkerURL, allocation),
      idleWorkspaceCases(filesystemWorkerURL, allocation),
      storageReleaseCases(allocation),
      checkpointFailureCases(),
    )
    .map(({ label, run, compactEvery = 2 }) => ({
      label,
      async run() {
        const name = allocation?.name() ?? `bun-wasm-storage-test-${crypto.randomUUID()}`;
        await allocation?.allocate({ kind: "indexeddb", name });
        const opened: IndexedDBStorage[] = [];
        const open = async () => {
          const backend = await IndexedDBStorage.open(name, { compactEvery });
          opened.push(backend);
          return backend;
        };
        await withStorageCleanup(
          () => run(name, open),
          async () => {
            for (const backend of opened) await backend.close().catch(() => {});
            await request(indexedDB.deleteDatabase(name));
          },
        );
      },
    }));
}

/** @public Exposed by the package testing/storage-browser export for external browser runners. */
export async function runStorageTests(filter?: string): Promise<string[]> {
  const passed: string[] = [];
  for (const test of storageTests())
    if (!filter || test.label.includes(filter)) {
      await test.run();
      passed.push(test.label);
    }
  return passed;
}
