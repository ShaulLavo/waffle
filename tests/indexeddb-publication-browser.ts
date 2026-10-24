import { IdentityAllocator } from "../fs/file-identity.js";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import {
  PublicationDomain,
  createPublicationBuffers,
  snapshotPublicationCheckpoint,
} from "../fs/publication.js";
import {
  decodeRecord,
  encodeRecord,
  type CheckpointPublication,
  type PersistenceBatch,
} from "../fs/storage.js";
import { VfsError } from "../fs/vfs.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function publicationFile(history: string) {
  const allocator = new IdentityAllocator(new Int32Array(9));
  allocator.configure({ workspace: crypto.randomUUID(), era: 1n });
  return { birthHistory: history, ino: 2, ...allocator.create() };
}
function publicationFixture(): CheckpointPublication {
  const buffers = createPublicationBuffers({
    sessions: 4,
    operations: 8,
    inputBytes: 64,
    argumentBytes: 512,
    effectBytes: 2048,
    effects: 16,
    resultBytes: 128,
    logRecords: 2,
    logBytes: 4096,
    pins: 2,
    pinBytes: 128,
  });
  const domain = new PublicationDomain(buffers),
    session = domain.openSession();
  const file = publicationFile(buffers.history);
  const admitted = domain.admit(
    session,
    domain.next(session),
    { kind: "write", handle: 2, offset: 0 },
    new Uint8Array([0, 255, 23, 128]),
  );
  assert(admitted.kind === "admitted", "real publication fixture admits");
  const prepared = domain.prepare(admitted.admission, { kind: "number", value: 4 }, [
    { kind: "bytes", file, offset: 0, bytes: admitted.input, size: 4, version: 1 },
  ]);
  const receipt = domain.commit(prepared);
  return snapshotPublicationCheckpoint({
    kind: "settled-publication-v1",
    cut: domain.cut(),
    sessionSerial: session.serial + 65536,
    limits: buffers.limits,
    receipts: [receipt],
    changes: [prepared.effects],
    contentVersions: [{ ino: file.ino, version: domain.contentVersion(file.ino) }],
  });
}
function publicationBatch(
  generation: number,
  publication?: CheckpointPublication,
): PersistenceBatch {
  return {
    generation,
    publication,
    root: 1,
    removes: [],
    upserts: [
      { ino: 1, kind: "dir", size: 0, mtime: generation, children: [["file", 2]] },
      { ino: 2, kind: "file", size: 4, mtime: generation, data: `pub:${generation}` },
    ],
    data: new Map([[`pub:${generation}`, new Uint8Array([generation, 0, 128, 255])]]),
  };
}
function metadataBatch(generation: number, publication?: CheckpointPublication): PersistenceBatch {
  return { generation, root: 1, upserts: [], removes: [], data: new Map(), publication };
}
function assertPublication(
  actual: CheckpointPublication | undefined,
  expected: CheckpointPublication,
): void {
  assert(actual !== undefined, "selected publication survives normal persist/load");
  assert(
    actual.changes.every((change) => change instanceof Uint8Array),
    "owned typed change bytes",
  );
  assert(JSON.stringify(actual) === JSON.stringify(expected), "exact selected publication record");
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
class DatabaseFixture {
  readonly name = `publication-adapter-${crypto.randomUUID()}`;
  private readonly opened = new Set<IndexedDBStorage>();
  constructor(readonly compactEvery: number) {}
  async open(): Promise<IndexedDBStorage> {
    const storage = await IndexedDBStorage.open(this.name, {
      compactEvery: this.compactEvery,
      whenBusy: "wait",
    });
    this.opened.add(storage);
    return storage;
  }
  async raw<T>(work: (database: IDBDatabase) => Promise<T>): Promise<T> {
    const database = await request(indexedDB.open(this.name));
    try {
      return await work(database);
    } finally {
      database.close();
    }
  }
  read(store: string, key: IDBValidKey): Promise<unknown> {
    return this.raw((db) => request(db.transaction(store).objectStore(store).get(key)));
  }
  async record(store: string, key: IDBValidKey): Promise<Record<string, unknown>> {
    const value = await decodeRecord(await this.read(store, key));
    assert(value && typeof value === "object", "checksummed native record exists");
    return Object.fromEntries(Object.entries(value));
  }
  async write(store: string, key: IDBValidKey, value: unknown): Promise<void> {
    await this.raw(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(store, "readwrite", { durability: "strict" });
          tx.objectStore(store).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        }),
    );
  }
  async close(): Promise<void> {
    await Promise.all(Array.from(this.opened, (storage) => storage.close()));
    await request(indexedDB.deleteDatabase(this.name));
  }
}
async function roundtrip(owned: DatabaseFixture): Promise<void> {
  let storage = await owned.open();
  const publication = publicationFixture(),
    expected = structuredClone(publication),
    pending = storage.persist(publicationBatch(1, publication));
  publication.changes[0]!.fill(9);
  await pending;
  const loaded = await storage.load();
  assertPublication(loaded?.publication, expected);
  loaded!.publication!.changes[0]!.fill(0);
  assertPublication((await storage.load())?.publication, expected);
  await storage.close();
  storage = await owned.open();
  assertPublication((await storage.load())?.publication, expected);
  const next = snapshotPublicationCheckpoint({
    ...expected,
    sessionSerial: expected.sessionSerial + 65536,
    receipts: expected.receipts.concat([
      {
        id: { session: expected.sessionSerial + 1, sequence: 1 },
        cut: expected.cut,
        result: { kind: "void" },
        durability: { kind: "untracked" },
      },
    ]),
  });
  await storage.persist(metadataBatch(2, next));
  const journal = await owned.record("journal", 2);
  assert(
    JSON.stringify(journal.publication) ===
      JSON.stringify({ ...next, changes: next.changes.map((change) => Array.from(change)) }),
    "journal owns byte arrays and exact reserved frontier",
  );
  await storage.close();
  storage = await owned.open();
  assertPublication((await storage.load())?.publication, next);
  await storage.persist(metadataBatch(3, next));
  await storage.close();
  storage = await owned.open();
  assertPublication((await storage.load())?.publication, next);
  const keys = await owned.raw((db) =>
    request(db.transaction("metadata").objectStore("metadata").getAllKeys()),
  );
  const allowed = new Set<IDBValidKey>([0, 1, "epoch", "active", "format", "identity"]);
  assert(
    keys.every((key) => allowed.has(key)),
    "no parallel publication store",
  );
  assert((await owned.read("data", "pub:1")) !== undefined, "metadata-only save retains payload");
}
async function clearing(owned: DatabaseFixture): Promise<void> {
  let storage = await owned.open();
  await storage.persist(publicationBatch(1, publicationFixture()));
  await storage.persist(metadataBatch(2));
  assert((await storage.load())?.publication === undefined, "untracked selection clears memory");
  await storage.close();
  storage = await owned.open();
  const journal = await storage.load();
  assert(journal?.generation === 2, "untracked journal is selected");
  assert(journal.publication === undefined, "untracked journal clears prior record");
  await storage.persist(metadataBatch(3));
  await storage.close();
  storage = await owned.open();
  const snapshot = await storage.load();
  assert(snapshot?.generation === 3, "untracked compacted snapshot is selected");
  assert(snapshot.publication === undefined, "untracked snapshot clears prior record");
}
function abortAfterJournal(cause: unknown) {
  const put = IDBObjectStore.prototype.put;
  let payloadPuts = 0;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === "data") payloadPuts++;
    const operation = put.apply(this, args);
    if (this.name === "journal") throw cause;
    return operation;
  };
  return {
    get payloadPuts() {
      return payloadPuts;
    },
    restore() {
      IDBObjectStore.prototype.put = put;
    },
  };
}
async function atomicAbort(owned: DatabaseFixture): Promise<void> {
  const storage = await owned.open(),
    previous = publicationFixture();
  await storage.persist(publicationBatch(1, previous));
  const cause = { exact: "abort after real payload and journal puts" },
    injection = abortAfterJournal(cause);
  let failure: unknown;
  try {
    await storage.persist(publicationBatch(2, publicationFixture())).catch((error) => {
      failure = error;
    });
    assert(failure === cause, "native abort preserves exact cause");
    assert(injection.payloadPuts > 0, "abort follows actual native payload puts");
  } finally {
    injection.restore();
  }
  assertPublication((await storage.load())?.publication, previous);
  assert((await owned.read("journal", 2)) === undefined, "aborted record is absent");
  assert((await owned.read("data", "pub:2")) === undefined, "aborted payload is absent");
  assert((await owned.read("metadata", "active")) === 1, "aborted selection is absent");
  await storage.close();
  const recovered = await owned.open();
  assert((await recovered.load())?.generation === 1, "abort recovery selects prior namespace");
  assertPublication((await recovered.load())?.publication, previous);
}
async function epochFence(owned: DatabaseFixture): Promise<void> {
  const storage = await owned.open(),
    previous = publicationFixture();
  await storage.persist(publicationBatch(1, previous));
  const epoch = await owned.read("metadata", "epoch");
  assert(typeof epoch === "number", "real epoch exists");
  await owned.write("metadata", "epoch", epoch + 1);
  let failure: unknown;
  await storage.persist(publicationBatch(2, publicationFixture())).catch((error) => {
    failure = error;
  });
  assert(String(failure).includes("another tab"), "epoch fences publication with namespace");
  assert((await owned.read("journal", 2)) === undefined, "fenced publication rolls back");
  assert((await owned.read("data", "pub:2")) === undefined, "fenced payload rolls back");
  await storage.close();
  const recovered = await owned.open();
  assertPublication((await recovered.load())?.publication, previous);
}
async function corruption(owned: DatabaseFixture): Promise<void> {
  let storage = await owned.open();
  const previous = publicationFixture();
  await storage.persist(publicationBatch(1, previous));
  await storage.persist(publicationBatch(2, publicationFixture()));
  await storage.close();
  const compact = owned.compactEvery === 1,
    store = compact ? "metadata" : "journal",
    key = compact ? 1 : 2,
    original = await owned.record(store, key);
  assert(original.publication && typeof original.publication === "object", "record is coupled");
  const mutations = [
    { changes: [[256]] },
    { changes: [[-1]] },
    { changes: [[1.5]] },
    { changes: [{}] },
    { changes: Array(3).fill([]) },
    { changes: [Array(2049).fill(0)] },
    { contentVersions: [{ ino: 0, version: 1 }] },
    { sessionSerial: 0 },
  ];
  for (const mutation of mutations) {
    const encoded = await encodeRecord({
      ...original,
      publication: { ...original.publication, ...mutation },
    });
    await owned.write(store, key, encoded);
    if (compact) await owned.write("journal", 2, encoded);
    storage = await owned.open();
    const loaded = await storage.load();
    assert(loaded?.generation === 1, "invalid record rejects whole selected generation");
    assertPublication(loaded.publication, previous);
    await storage.close();
    assert(
      JSON.stringify(await owned.read(store, key)) === JSON.stringify(encoded),
      "no repair write",
    );
  }
  await owned.write("metadata", 0, { json: "broken", checksum: "broken" });
  storage = await owned.open();
  let failure: unknown;
  await storage.load().catch((error) => {
    failure = error;
  });
  assert(
    failure instanceof VfsError && failure.code === "INVALID_VFS_FORMAT",
    "no valid coupled chain fails closed",
  );
  assert((await owned.read("data", "pub:1")) !== undefined, "corruption preserves old payload");
}
function terminalGate() {
  const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete")!;
  const seen = Promise.withResolvers<void>();
  let deliver: (() => void) | undefined;
  Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
    ...descriptor,
    set(callback: IDBTransaction["oncomplete"]) {
      if (this.mode !== "readwrite" || !this.objectStoreNames.contains("journal")) {
        descriptor.set!.call(this, callback);
        return;
      }
      descriptor.set!.call(this, (event: Event) => {
        deliver = () => callback?.call(this, event);
        seen.resolve();
      });
    },
  });
  return {
    seen: seen.promise,
    release() {
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", descriptor);
      deliver?.();
    },
  };
}
async function holdSelectedRecord(name: string): Promise<void> {
  const storage = await IndexedDBStorage.open(name, { compactEvery: 128, whenBusy: "wait" });
  await storage.persist(publicationBatch(1));
  const publication = publicationFixture(),
    gate = terminalGate();
  let replied = false;
  const pending = storage.persist(publicationBatch(2, publication)).then(() => {
    replied = true;
  });
  try {
    await gate.seen;
    assert(!replied, "normal persist waits for native complete delivery");
    globalThis.postMessage({ publication });
    await pending;
  } finally {
    gate.release();
    await storage.close();
  }
}
function crashOwner({ name, path }: { name: string; path: string }): void {
  void import(path)
    .then(async (suite: typeof import("./indexeddb-publication-browser.js")) => {
      await suite.publicationAdapter.holdOwner(name);
    })
    .catch((error: unknown) => globalThis.postMessage({ error: String(error) }));
}
async function lostReply(owned: DatabaseFixture): Promise<void> {
  const source = `(${crashOwner.toString()})(${JSON.stringify({ name: owned.name, path: new URL("/tests.js", location.href).href })});`,
    url = URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
    worker = new Worker(url, { type: "module" });
  try {
    const publication = await new Promise<CheckpointPublication>((resolve, reject) => {
      worker.onmessage = (
        event: MessageEvent<{ publication: CheckpointPublication; error?: string }>,
      ) => {
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.publication);
      };
      worker.onerror = (event) => reject(new Error(event.message));
    });
    assert((await owned.read("metadata", "active")) === 2, "native selection commits before reply");
    const journal = await owned.record("journal", 2);
    assert(journal.publication !== undefined, "native record commits before reply");
    worker.terminate();
    const recovered = await owned.open();
    assert((await recovered.load())?.generation === 2, "worker death releases native lock");
    assertPublication((await recovered.load())?.publication, publication);
    assert(
      Array.from(await recovered.read("pub:2")).join(",") === "2,0,128,255",
      "lost reply recovery pairs selected bytes with exact record",
    );
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}
async function runPublicationAdapterControls(filter = ""): Promise<string[]> {
  const cases = [
    {
      label: "snapshot, journal, metadata-only, byte ownership and compaction",
      compact: 2,
      run: roundtrip,
    },
    { label: "untracked journal and snapshot clear prior record", compact: 2, run: clearing },
    {
      label: "journal abort atomically preserves exact cause and prior selection",
      compact: 128,
      run: atomicAbort,
    },
    {
      label: "compaction abort atomically preserves exact cause and prior selection",
      compact: 1,
      run: atomicAbort,
    },
    { label: "existing epoch fences payload, namespace and record", compact: 1, run: epochFence },
    {
      label: "corrupt journal rejects whole candidate and fails closed without valid chain",
      compact: 128,
      run: corruption,
    },
    {
      label: "corrupt snapshot rejects whole candidate and fails closed without valid chain",
      compact: 1,
      run: corruption,
    },
    {
      label: "commit before reply survives actual worker termination",
      compact: 128,
      run: lostReply,
    },
  ];
  const passed: string[] = [];
  const selected = cases.filter((test) => test.label.includes(filter));
  assert(selected.length > 0, "native filter selects a real control");
  for (const test of selected) {
    const owned = new DatabaseFixture(test.compact);
    try {
      await test.run(owned);
      passed.push(test.label);
      console.log(`PASS ${test.label}`);
    } finally {
      await owned.close();
    }
  }
  return passed;
}

export const publicationAdapter = {
  fixture: publicationFixture,
  batch: publicationBatch,
  run: runPublicationAdapterControls,
  holdOwner: holdSelectedRecord,
};
