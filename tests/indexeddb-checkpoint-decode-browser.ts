import { IdentityAllocator } from "../fs/file-identity.js";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import {
  PublicationDomain,
  createPublicationBuffers,
  decodeEffects,
  encodeEffects,
  snapshotPublicationCheckpoint,
} from "../fs/publication.js";
import { decodeRecord, encodeRecord, type CheckpointPublication } from "../fs/storage.js";
import { VfsError } from "../fs/vfs.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function fixture(): CheckpointPublication {
  const buffers = createPublicationBuffers({
    sessions: 2,
    operations: 2,
    inputBytes: 16,
    argumentBytes: 256,
    effectBytes: 1024,
    effects: 2,
    resultBytes: 64,
    logRecords: 1,
    logBytes: 1024,
    pins: 1,
    pinBytes: 16,
  });
  const domain = new PublicationDomain(buffers),
    session = domain.openSession(),
    allocator = new IdentityAllocator(new Int32Array(9));
  allocator.configure({ workspace: crypto.randomUUID(), era: 1n });
  const file = { birthHistory: buffers.history, ino: 2, ...allocator.create() };
  const admitted = domain.admit(
    session,
    domain.next(session),
    { kind: "write", handle: 2, offset: 0 },
    new Uint8Array([0, 128, 255, 23]),
  );
  assert(admitted.kind === "admitted", "small fixture admits");
  const prepared = domain.prepare(admitted.admission, { kind: "number", value: 4 }, [
    { kind: "bytes", file, offset: 0, bytes: admitted.input, size: 4, version: 1 },
  ]);
  const receipt = domain.commit(prepared);
  return snapshotPublicationCheckpoint({
    kind: "settled-publication-v1",
    cut: domain.cut(),
    sessionSerial: 65536,
    limits: buffers.limits,
    receipts: [receipt],
    changes: [prepared.effects],
    contentVersions: [{ ino: file.ino, version: 1 }],
  });
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
async function raw<T>(name: string, work: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await request(indexedDB.open(name));
  try {
    return await work(database);
  } finally {
    database.close();
  }
}
async function replaceSnapshot(name: string, value: unknown): Promise<void> {
  const record = await encodeRecord(value);
  await raw(name, (database) => {
    const transaction = database.transaction("metadata", "readwrite", { durability: "strict" });
    const terminal = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    transaction.objectStore("metadata").put(record, 0);
    return terminal;
  });
}
function observeConversions() {
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, "from")!;
  const lengths: number[] = [];
  Object.defineProperty(Uint8Array, "from", {
    ...descriptor,
    value: new Proxy(Uint8Array.from, {
      apply(target, receiver, args) {
        if (Array.isArray(args[0])) lengths.push(args[0].length);
        return Reflect.apply(target, receiver, args);
      },
    }),
  });
  return { lengths, restore: () => Object.defineProperty(Uint8Array, "from", descriptor) };
}
function invalidCases(checkpoint: CheckpointPublication) {
  const changes = checkpoint.changes.map((change) => Array.from(change));
  const decoded = decodeEffects(checkpoint.changes[0]!);
  const range = (offset: number) =>
    Array.from(
      encodeEffects(
        decoded.receipt,
        decoded.changes.map((effect) => (effect.kind === "bytes" ? { ...effect, offset } : effect)),
        checkpoint.limits.effectBytes,
      ),
    );
  return [
    { label: "envelope", publication: { ...checkpoint, kind: "invalid", changes }, copies: 0 },
    { label: "count", publication: { ...checkpoint, changes: changes.concat(changes) }, copies: 0 },
    {
      label: "effect bytes",
      publication: { ...checkpoint, changes: [Array(checkpoint.limits.effectBytes + 1).fill(0)] },
      copies: 0,
    },
    { label: "fractional offset", publication: { ...checkpoint, changes: [range(0.5)] }, copies: 1 },
    { label: "tail range", publication: { ...checkpoint, changes: [range(1)] }, copies: 1 },
  ];
}
async function rejectsBeforeCopy(name: string, expected: number, label: string): Promise<void> {
  const storage = await IndexedDBStorage.open(name, { whenBusy: "wait", compactEvery: 8 });
  const observed = observeConversions();
  let failure: unknown;
  try {
    await storage.load().catch((error: unknown) => {
      failure = error;
    });
  } finally {
    observed.restore();
    await storage.close();
  }
  assert(failure instanceof VfsError && failure.code === "INVALID_VFS_FORMAT", `${label}: format error`);
  console.log(JSON.stringify({ boundary: label, conversions: observed.lengths, expected }));
  assert(observed.lengths.length === expected, `${label}: expected ${expected} conversions, got ${observed.lengths.length}`);
}
async function roundtrip(name: string, checkpoint: CheckpointPublication): Promise<void> {
  const storage = await IndexedDBStorage.open(name, { whenBusy: "wait", compactEvery: 8 });
  const observed = observeConversions();
  try {
    const loaded = await storage.load();
    assert(JSON.stringify(loaded?.publication) === JSON.stringify(checkpoint), "valid selected record roundtrip");
    assert(loaded?.publication?.changes[0] instanceof Uint8Array, "typed owned change bytes");
    assert(observed.lengths.length === 1, "valid selected record converts once");
    loaded.publication.changes[0].fill(0);
    assert(JSON.stringify((await storage.load())?.publication) === JSON.stringify(checkpoint), "load copy cannot alter selection");
    console.log(JSON.stringify({ boundary: "valid roundtrip", conversions: observed.lengths }));
  } finally {
    observed.restore();
    await storage.close();
  }
}
async function run(): Promise<void> {
  const name = `checkpoint-decoder-r30-${crypto.randomUUID()}`;
  try {
    const checkpoint = fixture();
    const storage = await IndexedDBStorage.open(name, { whenBusy: "wait", compactEvery: 8 });
    try {
      await storage.persist({
        generation: 1,
        root: 1,
        upserts: [{ ino: 1, kind: "dir", size: 0, mtime: 0, children: [] }],
        removes: [],
        data: new Map(),
        publication: checkpoint,
      });
    } finally {
      await storage.close();
    }
    const original = await raw(name, (database) =>
      request(database.transaction("metadata").objectStore("metadata").get(0)),
    );
    const snapshot = await decodeRecord(original);
    assert(snapshot && typeof snapshot === "object", "real selected snapshot exists");
    for (const control of invalidCases(checkpoint)) {
      await replaceSnapshot(name, { ...snapshot, publication: control.publication });
      await rejectsBeforeCopy(name, control.copies, control.label);
    }
    await replaceSnapshot(name, {
      ...snapshot,
      publication: { ...checkpoint, changes: checkpoint.changes.map((change) => Array.from(change)) },
    });
    await roundtrip(name, checkpoint);
  } finally {
    await request(indexedDB.deleteDatabase(name));
  }
}

export const checkpointDecodeControl = { fixture, run };
