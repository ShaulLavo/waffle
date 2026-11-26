import {
  STAGED_FORMAT,
  STAGING_LIMITS,
  StagingCapacity,
  NativeCommitControl,
  initialEnvelope,
  encodeCommit,
  decodeCommit,
  commitRoots,
  invalidCommit,
  sameRecord,
  validateGroup,
  type CommitEnvelope,
  type CommittedRecovery,
  type CommittedStorage,
  type NativeCommit,
  type PreparedDurableGroup,
} from "./safe-staging.js";
import { nextReservation, storeReservation, type IdentityReservation } from "./file-identity.js";
import {
  CHUNK_SIZE,
  chunkChecksum,
  chunkError,
  chunkLength,
  checkPayload,
  deletePayload,
  parseChunk,
  parseManifest,
  preparePayload,
  preparePayloads,
  copyLegacyChunks,
  validateRange,
  type ChunkManifest,
  type IndexedDBRange,
} from "./indexeddb-chunks.js";
import { snapshotPublicationCheckpoint } from "./publication.js";
import { INDEXEDDB_FORMAT } from "./vfs-format.js";
import { maintenanceLock, type StorageLockManager } from "./storage-maintenance.js";
import { attemptCleanup, throwCleanupFailures } from "./cleanup.js";
export type { StorageLockManager } from "./storage-maintenance.js";
import { VfsError } from "./vfs.js";
import { reportRuntimeStartup, type RuntimeStartupObserver } from "./startup.js";
import {
  PayloadRetentions,
  PayloadCorruption,
  type PayloadRetention,
  type ReaderMetadataBudget,
  decodeRecord,
  snapshotBatch,
  encodeRecord,
  validatePersistedIndex,
  validatePersistedNode,
  validInteger,
  type ChecksummedRecord,
  type CheckpointPublication,
  type PersistenceBatch,
  type PersistedIndex,
  type PersistedNode,
  type StorageBackend,
} from "./storage.js";

export const OWNERSHIP_LOST_MESSAGE =
  "This workspace was opened in another tab. Reload to continue here.";
export const INDEXEDDB_ARB_LOCK_PREFIX = "bun-wasm:filesystem:indexeddb-arb:";

export class ExpectedEpochMismatchError extends Error {
  override readonly name = "ExpectedEpochMismatchError";
  constructor(
    readonly expectedEpoch: number,
    readonly actualEpoch: number,
  ) {
    super(`Expected IndexedDB epoch ${expectedEpoch}, found ${actualEpoch}`);
  }
}

export class StealTargetMismatchError extends Error {
  override readonly name = "StealTargetMismatchError";
  constructor(message = "IndexedDB steal target verification failed") {
    super(message);
  }
}

export class IndexedDBStorageBusyError extends Error {
  override readonly name = "IndexedDBStorageBusyError";
  constructor(message = "IndexedDB storage lock is currently held") {
    super(message);
  }
}

export interface IndexedDBStorageOptions {
  readonly retainOpeningDebt?: (debt: Promise<void>) => void;
  indexedDB?: IDBFactory;
  locks?: StorageLockManager;
  /** Number of incremental saves between full snapshots. */
  compactEvery?: number;
  onOwnershipLost?: () => void;
  onStartupStage?: RuntimeStartupObserver;
  signal?: AbortSignal;
  /** Aborts only pre-steal setup and arbitration; disconnected synchronously when steal submits. */
  preStealSignal?: AbortSignal;
  onWaiting?: () => void;
  whenBusy?: "takeover" | "wait" | "ifAvailable";
  /** "exclusive" writes lastExclusiveEpoch; "attach" reads it without overwriting. */
  epochOwner?: "exclusive" | "attach";
  /** Atomic CAS check inside allocateEpoch; mismatch aborts with ExpectedEpochMismatchError. */
  expectedEpoch?: number;
  /** Verified under exclusive arbLock before submitting steal:true on the writer lock. */
  verifyStealTarget?: (snapshot: LockManagerSnapshot) => boolean;
}
/** Retains physical native completion independently of caller-visible startup rejection. */
class NativeDatabaseOpening {
  private readonly outcome = Promise.withResolvers<IDBDatabase>();
  readonly ready = this.outcome.promise;
  private readonly completion = Promise.withResolvers<void>();
  private database: IDBDatabase | undefined;
  private closing: Promise<void> | undefined;
  private blocked = false;
  private readonly abort = () => this.outcome.reject(this.signal?.reason);

  constructor(
    factory: IDBFactory,
    name: string,
    private readonly signal: AbortSignal | undefined,
    private readonly versionChangeAbort: AbortController | undefined,
    options: IndexedDBStorageOptions,
  ) {
    void this.completion.promise.catch(() => {});
    options.retainOpeningDebt?.(this.completion.promise);
    reportRuntimeStartup(options.onStartupStage, "indexeddb-open-requested");
    if (signal?.aborted) {
      this.outcome.reject(signal.reason);
      this.completion.resolve();
      return;
    }
    try {
      const request = factory.open(name, 1);
      signal?.addEventListener("abort", this.abort, { once: true });
      request.onupgradeneeded = () => createStores(request.result);
      request.onsuccess = () => this.delivered(request.result);
      request.onerror = () => this.failed(request.error);
      request.onblocked = () => this.blockedRequest();
      if (signal?.aborted) this.abort();
    } catch (error) {
      this.stopObserving();
      this.outcome.reject(error);
      this.completion.resolve();
    }
  }
  private stopObserving(): void {
    this.signal?.removeEventListener("abort", this.abort);
  }
  private delivered(database: IDBDatabase): void {
    this.stopObserving();
    this.database = database;
    if (this.signal?.aborted || this.blocked) {
      void this.retire().catch(() => {});
      return;
    }
    database.onversionchange = () => {
      this.versionChangeAbort?.abort(new Error("Filesystem database changed while opening"));
      void this.close().catch(() => {});
    };
    this.outcome.resolve(database);
  }
  private failed(error: DOMException | null): void {
    this.stopObserving();
    this.outcome.reject(
      error?.name === "VersionError"
        ? new VfsError("INVALID_VFS_FORMAT", "indexeddb", "Incompatible IndexedDB database version")
        : (error ?? new Error("Cannot open filesystem storage")),
    );
    this.completion.resolve();
  }
  private blockedRequest(): void {
    this.stopObserving();
    this.blocked = true;
    this.outcome.reject(new Error("Filesystem database upgrade is blocked"));
  }
  private close(): Promise<void> {
    if (this.closing) return this.closing;
    const closing = Promise.withResolvers<void>();
    this.closing = closing.promise;
    try {
      this.database?.close();
      closing.resolve();
    } catch (error) {
      closing.reject(error);
    }
    return closing.promise;
  }
  async retire(): Promise<void> {
    try {
      await this.close();
      this.completion.resolve();
    } catch (error) {
      this.completion.reject(error);
      throw error;
    }
  }
  transfer(): void {
    this.completion.resolve();
  }
}
function createStores(database: IDBDatabase): void {
  for (const store of ["metadata", "journal", "data"]) database.createObjectStore(store);
}
function validateSchema(database: IDBDatabase): void {
  if (
    database.version !== 1 ||
    database.objectStoreNames.length !== 3 ||
    !["metadata", "journal", "data"].every((name) => database.objectStoreNames.contains(name))
  )
    throw new VfsError("INVALID_VFS_FORMAT", "indexeddb", "Incompatible IndexedDB database schema");
}
function requestStorageLock<T>(
  locks: StorageLockManager,
  name: string,
  options: Parameters<StorageLockManager["request"]>[1],
  callback: (lock: unknown | null) => Promise<T>,
): Promise<T> {
  try {
    return locks.request(name, options, callback);
  } catch (error) {
    return Promise.reject(error);
  }
}
interface AllocatedEpoch {
  readonly epoch: number;
  readonly lastExclusiveEpoch: number;
}

function allocateEpoch(
  transaction: IDBTransaction,
  completedEpoch: Promise<void>,
  epochOwner: "exclusive" | "attach" = "exclusive",
  expectedEpoch?: number,
): Promise<AllocatedEpoch> {
  let epoch = 0;
  let lastExclusiveEpoch = 0;
  let mismatch: ExpectedEpochMismatchError | undefined;
  const store = transaction.objectStore("metadata");
  const request = store.get("epoch");
  const exclusiveRequest = store.get("lastExclusiveEpoch");
  let epochLoaded = false;
  let exclusiveLoaded = false;
  let previous: unknown;
  let previousExclusive: unknown;
  const finish = () => {
    if (!epochLoaded || !exclusiveLoaded) return;
    if (
      previous !== undefined &&
      (!validInteger(previous) || previous >= Number.MAX_SAFE_INTEGER)
    ) {
      transaction.abort();
      return;
    }
    if (
      previousExclusive !== undefined &&
      (!validInteger(previousExclusive) || previousExclusive >= Number.MAX_SAFE_INTEGER)
    ) {
      transaction.abort();
      return;
    }
    const prevNumber = typeof previous === "number" ? previous : 0;
    if (expectedEpoch !== undefined && prevNumber !== expectedEpoch) {
      mismatch = new ExpectedEpochMismatchError(expectedEpoch, prevNumber);
      transaction.abort();
      return;
    }
    epoch = prevNumber + 1;
    store.put(epoch, "epoch");
    if (epochOwner === "exclusive") {
      lastExclusiveEpoch = epoch;
      store.put(lastExclusiveEpoch, "lastExclusiveEpoch");
    } else {
      lastExclusiveEpoch = typeof previousExclusive === "number" ? previousExclusive : 0;
    }
  };
  request.onsuccess = () => {
    previous = request.result;
    epochLoaded = true;
    finish();
  };
  exclusiveRequest.onsuccess = () => {
    previousExclusive = exclusiveRequest.result;
    exclusiveLoaded = true;
    finish();
  };
  return completedEpoch.then(
    () => ({ epoch, lastExclusiveEpoch }),
    (error) => {
      if (mismatch) throw mismatch;
      throw error;
    },
  );
}

/** Bounded, cancellable readonly read of IndexedDB epoch and lastExclusiveEpoch metadata. */
export async function readIndexedDBEpochMetadata(
  name: string,
  options: { indexedDB?: IDBFactory; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ epoch: number; lastExclusiveEpoch: number } | undefined> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) return undefined;
  const controller = new AbortController();
  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(
          () => controller.abort(new Error("IndexedDB epoch check timed out")),
          options.timeoutMs,
        )
      : undefined;
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  let db: IDBDatabase | undefined;
  let tx: IDBTransaction | undefined;
  const onAbort = () => {
    try {
      tx?.abort();
    } catch {}
    try {
      db?.close();
    } catch {}
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const openReq = factory.open(name, 1);
      let settled = false;
      const rejectAbort = () => {
        if (settled) return;
        settled = true;
        reject(signal.reason);
      };
      signal.addEventListener("abort", rejectAbort, { once: true });
      openReq.onupgradeneeded = () => {
        try {
          openReq.transaction?.abort();
        } catch {}
      };
      openReq.onsuccess = () => {
        signal.removeEventListener("abort", rejectAbort);
        const opened = openReq.result;
        if (settled || signal.aborted) {
          try {
            opened.close();
          } catch {}
          return;
        }
        settled = true;
        resolve(opened);
      };
      openReq.onerror = () => {
        signal.removeEventListener("abort", rejectAbort);
        if (settled) return;
        settled = true;
        reject(openReq.error ?? new Error("Failed to open IndexedDB for epoch metadata"));
      };
      openReq.onblocked = () => {
        signal.removeEventListener("abort", rejectAbort);
        if (settled) return;
        settled = true;
        reject(new Error("IndexedDB blocked during epoch check"));
      };
    });
    if (signal.aborted) throw signal.reason;
    if (!db.objectStoreNames.contains("metadata")) return undefined;
    tx = db.transaction("metadata", "readonly");
    const store = tx.objectStore("metadata");
    const result = await new Promise<{ epoch: number; lastExclusiveEpoch: number }>(
      (resolve, reject) => {
        let epochVal = 0;
        let exclusiveVal = 0;
        const g1 = store.get("epoch");
        const g2 = store.get("lastExclusiveEpoch");
        g1.onsuccess = () => {
          if (typeof g1.result === "number" && validInteger(g1.result)) epochVal = g1.result;
        };
        g2.onsuccess = () => {
          if (typeof g2.result === "number" && validInteger(g2.result)) exclusiveVal = g2.result;
        };
        tx!.oncomplete = () => resolve({ epoch: epochVal, lastExclusiveEpoch: exclusiveVal });
        tx!.onerror = () => reject(tx!.error ?? new Error("Epoch metadata transaction failed"));
        tx!.onabort = () =>
          reject(
            signal.aborted
              ? signal.reason
              : (tx!.error ?? new Error("Epoch metadata transaction aborted")),
          );
      },
    );
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    try {
      db?.close();
    } catch {}
  }
}
interface Journal {
  version: 1;
  previous: number;
  generation: number;
  root: number;
  upserts: PersistedNode[];
  removes: number[];
  publication?: CheckpointPublication;
}
interface TreeState {
  publication?: CheckpointPublication;
  generation: number;
  root: number;
  nodes: Map<number, PersistedNode>;
  references: Map<number, number>;
  parents: Map<number, number>;
}
interface State extends TreeState {
  bases: [PersistedIndex | undefined, PersistedIndex | undefined];
  journals: Map<number, Journal>;
  journalKeys: IDBValidKey[];
  payloadKeys: Set<string>;
  /** Payload sizes named by `nodes`, `bases` and `journals`, kept with every change to them. */
  payloadSizes: PayloadSizes;
  sinceCompaction: number;
}
/** The size of each payload that a node of the current tree, a recovery base or a kept journal
 * names, counted per naming node so a lookup never scans the tree. Validation keeps every node
 * naming one key at the size of its stored manifest. */
class PayloadSizes {
  private readonly entries = new Map<string, { size: number; count: number }>();
  add(nodes: Iterable<PersistedNode>): void {
    for (const node of nodes) {
      if (node.data === undefined) continue;
      const entry = this.entries.get(node.data);
      if (entry) entry.count++;
      else this.entries.set(node.data, { size: node.size, count: 1 });
    }
  }
  remove(nodes: Iterable<PersistedNode>): void {
    for (const node of nodes) {
      if (node.data === undefined) continue;
      const entry = this.entries.get(node.data);
      if (entry && --entry.count === 0) this.entries.delete(node.data);
    }
  }
  size(key: string): number | undefined {
    return this.entries.get(key)?.size;
  }
}
interface CommittedTransaction {
  group: PreparedDurableGroup;
  envelope: CommitEnvelope;
  expected: ChecksummedRecord;
  control: NativeCommitControl;
}
function validateDatabaseLayout(
  committed: boolean,
  format: unknown,
  keys: IDBValidKey[],
  journalKeys: IDBValidKey[],
  dataKeys: IDBValidKey[],
): boolean {
  const empty =
    committed &&
    !keys.includes("format") &&
    keys.every((key) => key === "epoch" || key === "lastExclusiveEpoch") &&
    !journalKeys.length &&
    !dataKeys.length;
  if (committed && !empty && format !== STAGED_FORMAT) invalidCommit();
  if (
    !committed &&
    keys.includes("format") &&
    format !== INDEXEDDB_FORMAT &&
    format !== "waffle-indexeddb-v1"
  )
    throw new VfsError(
      "INVALID_VFS_FORMAT",
      "indexeddb",
      "Incompatible IndexedDB filesystem format identity",
    );
  const allowed: IDBValidKey[] = [
    0,
    1,
    "epoch",
    "lastExclusiveEpoch",
    "active",
    "format",
    "identity",
  ];
  if (committed) allowed.push("commit");
  if (keys.some((key) => !allowed.includes(key)))
    throw new VfsError("INVALID_VFS_FORMAT", "indexeddb", "Incompatible IndexedDB metadata layout");
  return empty;
}
function requiredPayloads(
  nodes: Iterable<PersistedNode>,
  durable: ReadonlyMap<string, number>,
): Map<string, number> {
  const expected = new Map(durable);
  for (const node of nodes) {
    if (node.data === undefined) continue;
    if (expected.has(node.data) && expected.get(node.data) !== node.size) metadataError();
    expected.set(node.data, node.size);
  }
  return expected;
}
function transactionFailure(
  tx: IDBTransaction,
  ownership: unknown,
  failure: { cause: unknown } | undefined,
  committed?: CommittedTransaction,
): unknown {
  if (committed && failure) return failure.cause;
  return (
    ownership ??
    failure?.cause ??
    committed?.control.abortReason ??
    tx.error ??
    new Error("Filesystem transaction aborted")
  );
}
function checkCommitHead(
  tx: IDBTransaction,
  committed: CommittedTransaction,
  checked: () => void,
  abort: (error: unknown) => void,
): void {
  const head = tx.objectStore("metadata").get("commit");
  head.onsuccess = () => {
    if (!sameRecord(head.result, committed.expected)) {
      abort(new Error("Staged commit head changed"));
      return;
    }
    checked();
  };
}
function snapshotSlot(bases: State["bases"]): 0 | 1 {
  if (!bases[0]) return 0;
  if (!bases[1]) return 1;
  return bases[0].generation <= bases[1].generation ? 0 : 1;
}
function metadataError(): never {
  throw new VfsError("INVALID_VFS_FORMAT", "indexeddb", "Invalid persisted filesystem metadata");
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  const result = new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
  void result.catch(() => {});
  return result;
}
/** Every string key in the data store, which in chunked formats names a payload manifest. Keys
 * order numbers, dates, strings, binary, arrays: the empty binary key is the least binary key, so
 * values under invalid number, date or binary keys are never loaded. Layout validation still
 * rejects those keys from the key listing. */
function manifestKeyRange(): IDBKeyRange {
  return IDBKeyRange.bound("", new ArrayBuffer(0), false, true);
}
/** Pairs a bulk manifest read; each result is read once (see formatAndManifests). */
function pairManifests(
  names: readonly IDBValidKey[],
  records: readonly unknown[],
): Map<IDBValidKey, unknown> {
  if (names.length !== records.length)
    throw new VfsError("INVALID_VFS_FORMAT", "indexeddb", "Invalid payload manifests");
  const manifests = new Map<IDBValidKey, unknown>();
  for (const [index, key] of names.entries()) manifests.set(key, records[index]);
  return manifests;
}
interface FormatRecords {
  readonly format: unknown;
  /** Manifest records by payload key, read only for chunked formats. */
  readonly manifests?: ReadonlyMap<IDBValidKey, unknown>;
}
/** Reads the format and, for chunked formats, every manifest in the same snapshot. Legacy
 * formats keep whole payloads at string keys, so those are never read here. */
function formatAndManifests(
  metadata: IDBObjectStore,
  data: IDBObjectStore,
): Promise<FormatRecords> {
  return new Promise<FormatRecords>((resolve, reject) => {
    const format = metadata.get("format");
    format.onerror = requestFailed(format, reject);
    format.onsuccess = () => {
      if (format.result !== INDEXEDDB_FORMAT && format.result !== STAGED_FORMAT) {
        resolve({ format: format.result });
        return;
      }
      // Placed from the format's success callback, so they read the same snapshot.
      placeManifestReads(data, format.result, resolve, reject);
    };
  });
}
function requestFailed(failure: IDBRequest, reject: (error: unknown) => void): () => void {
  return () => reject(failure.error ?? new Error("IndexedDB request failed"));
}
/** Requests complete in order, so the keys are ready when the values arrive. */
function placeManifestReads(
  data: IDBObjectStore,
  format: unknown,
  resolve: (records: FormatRecords) => void,
  reject: (error: unknown) => void,
): void {
  const range = manifestKeyRange();
  const keys = data.getAllKeys(range);
  const values = data.getAll(range);
  keys.onerror = requestFailed(keys, reject);
  values.onerror = requestFailed(values, reject);
  values.onsuccess = () => {
    // Read each result once: WebKit builds a new array on every `result` access, which made an
    // indexed loop over 17,000 manifests take 6.5 s.
    try {
      resolve({ format, manifests: pairManifests(keys.result, values.result) });
    } catch (error) {
      reject(error);
    }
  };
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}
interface ChunkCheck {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly checksum: string;
}
/** One range read in progress: bytes copied as chunks arrive and the checksums still owed. */
interface PayloadRead {
  readonly key: string;
  readonly range: IndexedDBRange;
  /** The payload size the read expects, when the caller or the index knows it. */
  readonly expectedSize: number | undefined;
  manifest?: ChunkManifest;
  result?: Uint8Array<ArrayBuffer>;
  readonly checks: ChunkCheck[];
  /** Chunk requests placed and not yet answered. */
  pending: number;
  failure?: { cause: unknown };
  /** Called once the manifest and every chunk have arrived. */
  arrived: () => void;
  fail: (error: unknown) => void;
}
function corruption<T>(parse: () => T, fallback: string): T {
  try {
    return parse();
  } catch (error) {
    throw new PayloadCorruption(error instanceof Error ? error.message : fallback);
  }
}
/** Places a get for every chunk the range touches in a payload of `size` bytes. */
function placeChunkReads(store: IDBObjectStore, size: number, read: PayloadRead): void {
  const { key, range } = read;
  const length = Math.max(0, Math.min(range.length, size - range.offset));
  read.result = new Uint8Array(length);
  const end = range.offset + length;
  for (let index = Math.floor(range.offset / CHUNK_SIZE); index * CHUNK_SIZE < end; index++) {
    read.pending++;
    const get = store.get([key, index]);
    get.onsuccess = () => {
      try {
        copyChunk(get.result, index, end, read);
        if (--read.pending === 0 && read.manifest) read.arrived();
      } catch (error) {
        read.fail(error);
      }
    };
  }
}
/** Runs first among the read's requests, which complete in the order they were placed. */
function acceptManifest(store: IDBObjectStore, value: unknown, read: PayloadRead): void {
  const key = read.key;
  if (value === undefined) throw new Error(`Missing filesystem payload: ${key}`);
  const manifest = corruption(() => parseManifest(value, key), "Invalid payload manifest");
  if (read.expectedSize !== undefined && manifest.size !== read.expectedSize)
    throw new PayloadCorruption("Retained payload size mismatch");
  read.manifest = manifest;
  // Without a known size, the chunk requests wait for the manifest, still in this transaction.
  if (read.expectedSize === undefined) placeChunkReads(store, manifest.size, read);
  if (read.pending === 0) read.arrived();
}
/** Copies the chunk's part of the range now and keeps what its checksum covers. A chunk the
 * range covers whole is checked from the copy, so only the two edge chunks stay alive. */
function copyChunk(record: unknown, index: number, end: number, read: PayloadRead): void {
  const offset = read.range.offset;
  const length = chunkLength(read.manifest!, index);
  const chunk = corruption(() => parseChunk(record, length, read.key), "Invalid payload chunk");
  const base = index * CHUNK_SIZE;
  const start = Math.max(offset, base);
  const stop = Math.min(end, base + length);
  const result = read.result!;
  result.set(chunk.bytes.subarray(start - base, stop - base), start - offset);
  const whole = start === base && stop === base + length;
  read.checks.push({
    checksum: chunk.checksum,
    bytes: whole ? result.subarray(start - offset, stop - offset) : chunk.bytes,
  });
}
/** Digests run concurrently in small batches: digest() copies its input, so a batch bounds the
 * extra memory while the browser overlaps the work. */
const CHECKSUM_BATCH = 16;
async function verifyChecksums(
  key: string,
  checks: readonly ChunkCheck[],
  signal?: AbortSignal,
): Promise<void> {
  for (let start = 0; start < checks.length; start += CHECKSUM_BATCH) {
    const batch = checks.slice(start, start + CHECKSUM_BATCH);
    const digests = await Promise.all(batch.map((check) => chunkChecksum(check.bytes)));
    if (digests.some((digest, index) => digest !== batch[index]!.checksum))
      throw new PayloadCorruption(`Invalid filesystem payload chunks: ${key}`);
    signal?.throwIfAborted();
  }
}
function payloads(nodes: Iterable<PersistedNode>, keys: Set<string>): void {
  for (const node of nodes) if (node.data !== undefined) keys.add(node.data);
}
function hasPayloads(nodes: readonly PersistedNode[], keys: ReadonlySet<string>): boolean {
  return nodes.every((node) => node.data === undefined || keys.has(node.data));
}
function recoveryManifest(value: unknown, key: string): ChunkManifest | undefined {
  try {
    return parseManifest(value, key);
  } catch {
    return undefined;
  }
}
/** Manifests whose chunk keys are exactly 0 to count - 1. `records` holds every manifest record
 * read in the same snapshot as `keys`. */
function validateChunks(
  keys: readonly IDBValidKey[],
  records: ReadonlyMap<IDBValidKey, unknown>,
): Map<string, ChunkManifest> {
  const manifests = new Map<string, ChunkManifest>();
  const chunks = new Map<string, Set<number>>();
  for (const key of keys) {
    if (typeof key === "string") {
      const manifest = recoveryManifest(records.get(key), key);
      if (manifest) manifests.set(key, manifest);
      continue;
    }
    if (
      !Array.isArray(key) ||
      key.length !== 2 ||
      typeof key[0] !== "string" ||
      !validInteger(key[1])
    )
      chunkError(String(key));
    const indices = chunks.get(key[0]) ?? new Set<number>();
    indices.add(key[1]);
    chunks.set(key[0], indices);
  }
  for (const [key, manifest] of manifests) {
    const indices = chunks.get(key);
    if ((indices?.size ?? 0) !== manifest.count) {
      manifests.delete(key);
      continue;
    }
    if (indices && Array.from(indices).some((index) => index >= manifest.count))
      manifests.delete(key);
  }
  return manifests;
}
function referenceIndex(nodes: Iterable<PersistedNode>): Pick<State, "references" | "parents"> {
  const references = new Map<number, number>(),
    parents = new Map<number, number>();
  for (const node of nodes)
    for (const [, ino] of node.children ?? []) {
      references.set(ino, (references.get(ino) ?? 0) + 1);
      parents.set(ino, node.ino);
    }
  return { references, parents };
}
function decodeChangeBytes(value: unknown, bound: number): Uint8Array {
  if (
    !Array.isArray(value) ||
    value.length > bound ||
    !value.every((byte: unknown) => validInteger(byte) && byte <= 255)
  )
    metadataError();
  return Uint8Array.from(value);
}
async function encodeSelection(selection: Journal | PersistedIndex): Promise<ChecksummedRecord> {
  const publication = selection.publication;
  return encodeRecord({
    ...selection,
    publication: publication && {
      ...publication,
      changes: publication.changes.map((change) => Array.from(change)),
    },
  });
}
function decodePublication(value: unknown): CheckpointPublication {
  if (!value || typeof value !== "object" || !("changes" in value)) metadataError();
  const checkpoint = snapshotPublicationCheckpoint({ ...value, changes: [] });
  if (!Array.isArray(value.changes) || value.changes.length > checkpoint.limits.logRecords)
    metadataError();
  return snapshotPublicationCheckpoint({
    ...checkpoint,
    changes: value.changes.map((change: unknown) =>
      decodeChangeBytes(change, checkpoint.limits.effectBytes),
    ),
  });
}
async function decodeSelection(value: unknown): Promise<unknown> {
  const selection = await decodeRecord(value);
  if (!selection || typeof selection !== "object" || !("publication" in selection))
    return selection;
  try {
    return { ...selection, publication: decodePublication(selection.publication) };
  } catch {
    return undefined;
  }
}
async function decodeIndex(value: unknown): Promise<PersistedIndex | undefined> {
  const index = await decodeSelection(value);
  try {
    validatePersistedIndex(index);
    return index;
  } catch {
    return undefined;
  }
}
function validateJournal(value: unknown): value is Journal {
  try {
    if (!value || typeof value !== "object") return false;
    const entry = value as Journal;
    if (
      entry.version !== 1 ||
      !validInteger(entry.previous) ||
      !validInteger(entry.generation) ||
      entry.generation <= entry.previous ||
      !validInteger(entry.root) ||
      !Array.isArray(entry.upserts) ||
      !Array.isArray(entry.removes)
    )
      return false;
    const seen = new Set<number>();
    for (const node of entry.upserts) {
      validatePersistedNode(node);
      if (seen.has(node.ino)) return false;
      seen.add(node.ino);
    }
    for (const ino of entry.removes) {
      if (!validInteger(ino) || seen.has(ino)) return false;
      seen.add(ino);
    }
    return true;
  } catch {
    return false;
  }
}

interface StagedChanges {
  upserts: Map<number, PersistedNode>;
  removes: Set<number>;
  references: Map<number, number>;
  parents: Map<number, number | undefined>;
}

/** Validate just the changed edges/inodes. Full-tree work is reserved for startup and compaction. */
function stageChanges(
  state: TreeState | undefined,
  batch: Pick<PersistenceBatch, "generation" | "root" | "upserts" | "removes">,
): StagedChanges {
  if (!validInteger(batch.generation) || (state && batch.generation <= state.generation))
    throw new Error("Filesystem generation must increase");
  if (!validInteger(batch.root)) metadataError();
  const upserts = new Map<number, PersistedNode>(),
    removes = new Set<number>();
  for (const node of batch.upserts) {
    validatePersistedNode(node);
    if (upserts.has(node.ino)) metadataError();
    upserts.set(node.ino, node);
  }
  for (const ino of batch.removes) {
    if (!validInteger(ino) || removes.has(ino) || upserts.has(ino)) metadataError();
    removes.add(ino);
  }
  const nodeAt = (ino: number) =>
    removes.has(ino) ? undefined : (upserts.get(ino) ?? state?.nodes.get(ino));
  if (nodeAt(batch.root)?.kind !== "dir") metadataError();
  const references = new Map<number, number>(),
    parents = new Map<number, number | undefined>();
  const adjust = (ino: number, delta: number) =>
    references.set(ino, (references.get(ino) ?? state?.references.get(ino) ?? 0) + delta);
  for (const ino of Array.from(upserts.keys()).concat(Array.from(removes))) {
    for (const [, child] of state?.nodes.get(ino)?.children ?? []) {
      adjust(child, -1);
      parents.set(child, undefined);
    }
  }
  for (const node of upserts.values())
    for (const [, child] of node.children ?? []) {
      adjust(child, 1);
      parents.set(child, node.ino);
    }
  const touched = new Set(
    Array.from(upserts.keys()).concat(Array.from(removes), Array.from(references.keys()), [
      batch.root,
    ]),
  );
  if (state) touched.add(state.root);
  for (const ino of touched) {
    const node = nodeAt(ino),
      count = references.get(ino) ?? state?.references.get(ino) ?? 0;
    if (!node) {
      if (count !== 0) metadataError();
      continue;
    }
    if (ino === batch.root) {
      if (node.kind !== "dir" || count !== 0) metadataError();
    } else if (count < 1 || (node.kind === "dir" && count !== 1)) metadataError();
    if (node.kind === "dir") {
      const seen = new Set<number>();
      let current: number | undefined = ino;
      while (current !== batch.root) {
        if (current === undefined || seen.has(current)) metadataError();
        seen.add(current);
        current = parents.has(current) ? parents.get(current) : state?.parents.get(current);
      }
    }
  }
  return { upserts, removes, references, parents };
}

function applyChanges(
  state: TreeState,
  staged: StagedChanges,
  selection: Pick<PersistenceBatch, "generation" | "root" | "publication">,
): void {
  for (const ino of staged.removes) state.nodes.delete(ino);
  for (const [ino, node] of staged.upserts) state.nodes.set(ino, node);
  for (const [ino, count] of staged.references) {
    if (count) state.references.set(ino, count);
    else state.references.delete(ino);
  }
  for (const [ino, parent] of staged.parents) {
    if (parent === undefined) state.parents.delete(ino);
    else state.parents.set(ino, parent);
  }
  state.generation = selection.generation;
  state.root = selection.root;
  state.publication = selection.publication;
}

/** Moves payload sizes from the nodes a commit replaces or removes to the ones it writes. */
function replaceNodes(state: State, staged: StagedChanges): void {
  for (const ino of Array.from(staged.removes).concat(Array.from(staged.upserts.keys()))) {
    const previous = state.nodes.get(ino);
    if (previous) state.payloadSizes.remove([previous]);
  }
  state.payloadSizes.add(staged.upserts.values());
}
function installBases(state: State, bases: State["bases"]): void {
  for (const slot of [0, 1] as const) {
    if (state.bases[slot] === bases[slot]) continue;
    state.payloadSizes.remove(state.bases[slot]?.nodes ?? []);
    state.payloadSizes.add(bases[slot]?.nodes ?? []);
  }
  state.bases = bases;
}
function dropJournal(state: State, generation: number): void {
  const journal = state.journals.get(generation);
  if (!journal) return;
  state.journals.delete(generation);
  state.payloadSizes.remove(journal.upserts);
}

/** Recover newest-first, copying the full tree only for a candidate with a complete chain. */
export function recoverIndex(
  bases: readonly (PersistedIndex | undefined)[],
  journals: ReadonlyMap<number, Journal>,
  payloadKeys: ReadonlySet<string>,
): PersistedIndex | undefined {
  const generations = Array.from(
    new Set(
      Array.from(journals.keys()).concat(bases.flatMap((base) => (base ? [base.generation] : []))),
    ),
  );
  generations.sort((a, b) => b - a);
  for (const generation of generations) {
    let current = generation;
    let base = bases.find((base) => base?.generation === current);
    const chain: Journal[] = [];
    while (!base) {
      const entry = journals.get(current);
      if (!entry || entry.previous >= current || !hasPayloads(entry.upserts, payloadKeys)) break;
      chain.push(entry);
      current = entry.previous;
      base = bases.find((base) => base?.generation === current);
    }
    if (!base) continue;
    const nodes = new Map(base.nodes.map((node) => [node.ino, node]));
    const tree: TreeState = {
      generation: base.generation,
      root: base.root,
      publication: base.publication,
      nodes,
      ...referenceIndex(nodes.values()),
    };
    chain.reverse();
    try {
      for (const entry of chain) applyChanges(tree, stageChanges(tree, entry), entry);
      const index: PersistedIndex = {
        version: 1,
        generation: tree.generation,
        root: tree.root,
        ...(tree.publication ? { publication: tree.publication } : {}),
        nodes: Array.from(nodes.values()),
      };
      validatePersistedIndex(index);
      return index;
    } catch {
      /* Invalid graph: try the next older committed chain, never an empty tree. */
    }
  }
  return undefined;
}

/** One lock-owning connection. Writes are strict atomic transactions, never in-place payload edits. */
export class IndexedDBStorage implements StorageBackend {
  private tail: Promise<void> = Promise.resolve();
  private readonly readers = new PayloadRetentions();
  private readonly readerWork = new Set<Promise<unknown>>();
  private readonly deletingPayloads = new Set<string>();
  private persistenceError: unknown;
  private initialized = false;
  private state?: State;
  private closed = false;
  private closing?: Promise<void>;
  private ownershipError?: Error;
  private ownershipRetirement?: Promise<void>;
  private transactions = new Set<IDBTransaction>();
  private committedEnvelope: CommitEnvelope | undefined;
  private committedRecord: ChecksummedRecord | undefined;
  private committedPending = false;
  private readOnlyLegacy = false;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly unlock: () => Promise<void>,
    private readonly compactEvery: number,
    private readonly epoch: number,
    private readonly onOwnershipLost: (() => void) | undefined,
    private readonly committedMode = false,
    private readonly readOnly = false,
    private readonly retireMaintenance: () => Promise<void> = () => Promise.resolve(),
    private readonly initialLastExclusiveEpoch = 0,
  ) {
    db.onversionchange = () => {
      if (this.readOnly) this.loseOwnership();
      void this.close().catch(() => {});
    };
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get lastExclusiveEpoch(): number {
    return this.initialLastExclusiveEpoch;
  }

  /** Readonly IndexedDB check verifying this connection still owns the latest epoch. */
  async verifyEpoch(signal?: AbortSignal): Promise<boolean> {
    if (this.closed || this.ownershipError) return false;
    signal?.throwIfAborted();
    let tx: IDBTransaction | undefined;
    const onAbort = () => {
      try {
        tx?.abort();
      } catch {}
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      tx = this.db.transaction("metadata", "readonly");
      const current = await new Promise<unknown>((resolve, reject) => {
        const req = tx!.objectStore("metadata").get("epoch");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx!.onabort = () => reject(signal?.aborted ? signal.reason : tx!.error);
      });
      if (signal?.aborted) throw signal.reason;
      return current === this.epoch && !this.closed && !this.ownershipError;
    } catch (_error) {
      if (signal?.aborted) throw signal.reason;
      return false;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  static open(name: string, options: IndexedDBStorageOptions = {}): Promise<IndexedDBStorage> {
    return IndexedDBStorage.openMode(name, options, false);
  }
  /** The caller owns the Web Lock and supplies an existing, unchanged database. */
  static readOnlyConnection(
    database: IDBDatabase,
    unlock: () => Promise<void>,
  ): { storage: IndexedDBStorage; revoke: () => void; assertOwned: () => void } {
    validateSchema(database);
    const storage = new IndexedDBStorage(database, unlock, 128, 0, undefined, false, true);
    return {
      storage,
      assertOwned: () => storage.assertOwner(),
      revoke: () => {
        storage.loseOwnership();
      },
    };
  }
  static async openCommitted(
    name: string,
    options: IndexedDBStorageOptions = {},
  ): Promise<CommittedStorage> {
    const storage = await IndexedDBStorage.openMode(name, options, true);
    try {
      await storage.recoverCommitted();
      return storage;
    } catch (error) {
      const failures: unknown[] = [error];
      await attemptCleanup(failures, () => storage.close());
      throwCleanupFailures(failures, "Committed recovery cleanup failed");
      throw error;
    }
  }
  private static async openMode(
    name: string,
    options: IndexedDBStorageOptions,
    committedMode: boolean,
  ): Promise<IndexedDBStorage> {
    const locks = options.locks ?? globalThis.navigator?.locks;
    if (!locks) throw new Error("IndexedDB storage requires IndexedDB and Web Locks");
    const preSignal =
      options.preStealSignal && options.signal
        ? AbortSignal.any([options.preStealSignal, options.signal])
        : (options.preStealSignal ?? options.signal);
    const maintenance = await maintenanceLock(locks, name, "shared", preSignal, options.onWaiting);
    if (maintenance === "busy") throw new Error("Unexpected shared maintenance lock refusal");
    const debts: Promise<void>[] = [];
    try {
      return await IndexedDBStorage.openOwned(
        name,
        {
          ...options,
          retainOpeningDebt(debt) {
            debts.push(debt);
            options.retainOpeningDebt?.(debt);
          },
        },
        committedMode,
        () => maintenance.release(),
      );
    } catch (error) {
      void Promise.all(debts)
        .then(() => maintenance.release())
        .catch(() => {});
      throw error;
    }
  }
  private static async openOwned(
    name: string,
    options: IndexedDBStorageOptions,
    committedMode: boolean,
    retireMaintenance: () => Promise<void>,
  ): Promise<IndexedDBStorage> {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    const locks: StorageLockManager | undefined = options.locks ?? globalThis.navigator?.locks;
    const compactEvery = options.compactEvery ?? 128;
    if (!factory || !locks) throw new Error("IndexedDB storage requires IndexedDB and Web Locks");
    if (!Number.isSafeInteger(compactEvery) || compactEvery < 1)
      throw new Error("Invalid compaction interval");
    // Open before requesting the lock so its callback starts epoch allocation without
    // awaiting another task. Losing a grant aborts allocation as well as later commits.
    const versionChangeAbort = options.whenBusy === "wait" ? new AbortController() : undefined;
    const postStealSignal = versionChangeAbort
      ? options.signal
        ? AbortSignal.any([options.signal, versionChangeAbort.signal])
        : versionChangeAbort.signal
      : options.signal;
    const preSignal =
      options.preStealSignal && postStealSignal
        ? AbortSignal.any([options.preStealSignal, postStealSignal])
        : (options.preStealSignal ?? postStealSignal);
    const opening = new NativeDatabaseOpening(
      factory,
      name,
      preSignal,
      versionChangeAbort,
      options,
    );
    const db = await opening.ready;
    reportRuntimeStartup(options.onStartupStage, "indexeddb-open-resolved");
    if (preSignal?.aborted) {
      await opening.retire();
      throw preSignal.reason;
    }
    try {
      validateSchema(db);
    } catch (error) {
      await opening.retire();
      throw error;
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: (storage: IndexedDBStorage) => void, refused!: (error: unknown) => void;
    const ready = new Promise<IndexedDBStorage>((resolve, reject) => {
      acquired = resolve;
      refused = reject;
    });
    let owner: IndexedDBStorage | undefined, allocation: IDBTransaction | undefined;
    let allocationDone: Promise<void> | undefined;
    let lost = false;
    let granted = false;
    let grantedResolve: (() => void) | undefined;
    const grantedPromise = new Promise<void>((resolve) => {
      grantedResolve = resolve;
    });
    // Once granted, Web Locks no longer observes abort. Retire an in-flight epoch
    // transaction through its normal completion/abort event before closing ownership.
    const abortAllocation = () => {
      try {
        allocation?.abort();
      } catch {
        /* Completion already won. */
      }
    };
    postStealSignal?.addEventListener("abort", abortAllocation, { once: true });
    const storageLockName = `bun-wasm:filesystem:indexeddb:${name}`;
    const arbLockName = `${INDEXEDDB_ARB_LOCK_PREFIX}${name}`;
    const lockOptions =
      options.whenBusy === "wait"
        ? { mode: "exclusive" as const, signal: postStealSignal }
        : options.whenBusy === "ifAvailable"
          ? { mode: "exclusive" as const, ifAvailable: true as const }
          : { mode: "exclusive" as const, steal: true as const };
    const startStorageRequest = () => {
      const lifetimePromise = requestStorageLock(
        locks,
        storageLockName,
        lockOptions,
        async (lock) => {
          if (lock === null) {
            grantedResolve?.();
            refused(new IndexedDBStorageBusyError());
            return;
          }
          granted = true;
          grantedResolve?.();
          if (lost) return;
          if (postStealSignal?.aborted) {
            refused(postStealSignal.reason);
            return;
          }
          reportRuntimeStartup(options.onStartupStage, "filesystem-lock-acquired");
          reportRuntimeStartup(options.onStartupStage, "filesystem-epoch-requested");
          if (postStealSignal?.aborted) throw postStealSignal.reason;
          allocation = db.transaction("metadata", "readwrite", { durability: "strict" });
          allocationDone = completed(allocation);
          const allocated = await allocateEpoch(
            allocation,
            allocationDone,
            options.epochOwner ?? "exclusive",
            options.expectedEpoch,
          );
          reportRuntimeStartup(options.onStartupStage, "filesystem-epoch-resolved");
          allocation = undefined;
          if (lost) return;
          if (postStealSignal?.aborted) throw postStealSignal.reason;
          owner = new IndexedDBStorage(
            db,
            async () => {
              release();
              await lifetimePromise.catch(() => {});
            },
            compactEvery,
            allocated.epoch,
            options.onOwnershipLost,
            committedMode,
            false,
            retireMaintenance,
            allocated.lastExclusiveEpoch,
          );
          acquired(owner);
          await held;
        },
      );
      reportRuntimeStartup(options.onStartupStage, "filesystem-lock-requested");
      void lifetimePromise.catch((error) => {
        lost = true;
        grantedResolve?.();
        try {
          allocation?.abort();
        } catch {
          /* A completed allocation is already durable. */
        }
        owner?.loseOwnership();
        const stolen =
          !postStealSignal?.aborted && error instanceof DOMException && error.name === "AbortError";
        refused(owner?.ownershipError ?? (stolen ? new Error(OWNERSHIP_LOST_MESSAGE) : error));
        if (stolen && !owner) options.onOwnershipLost?.();
      });
      return lifetimePromise;
    };
    let lifetime: Promise<void> | undefined;
    try {
      if (options.verifyStealTarget) {
        // Attach recovery: acquire exclusive arbitration lock, verify exact target under broker
        // snapshot, and synchronously submit steal:true before releasing arbLock.
        await requestStorageLock(
          locks,
          arbLockName,
          { mode: "exclusive", signal: preSignal },
          async () => {
            if (preSignal?.aborted) throw preSignal.reason;
            const snapshot = (await locks.query?.()) as LockManagerSnapshot | undefined;
            if (preSignal?.aborted) throw preSignal.reason;
            if (!snapshot || !options.verifyStealTarget!(snapshot)) {
              throw new StealTargetMismatchError();
            }
            // Synchronous steal submission boundary: from here on preStealSignal is disconnected;
            // only postStealSignal (dispose) can abort allocateEpoch.
            lifetime = startStorageRequest();
            await grantedPromise;
          },
        );
      } else {
        // Normal legacy writers & attach non-queuing startup: submit storageLock under shared
        // arbitration lock and confirm broker visibility before releasing arbLock.
        await requestStorageLock(
          locks,
          arbLockName,
          { mode: "shared", signal: preSignal },
          async () => {
            if (preSignal?.aborted) throw preSignal.reason;
            lifetime = startStorageRequest();
            if (options.whenBusy === "wait") {
              await Promise.race([grantedPromise, Promise.resolve().then(() => locks.query?.())]);
            } else {
              await grantedPromise;
            }
          },
        );
      }
    } catch (error) {
      release();
      await allocationDone?.catch(() => {});
      await lifetime?.catch(() => {});
      await opening.retire();
      postStealSignal?.removeEventListener("abort", abortAllocation);
      throw preSignal?.aborted && !lifetime ? preSignal.reason : error;
    }
    queueMicrotask(() => {
      if (options.whenBusy === "wait" && !granted && !lost && !postStealSignal?.aborted) {
        try {
          options.onWaiting?.();
        } catch {
          /* Observation cannot change ownership. */
        }
      }
    });
    try {
      const storage = await ready;
      if (postStealSignal?.aborted) throw postStealSignal.reason;
      opening.transfer();
      return storage;
    } catch (error) {
      release();
      await allocationDone?.catch(() => {});
      await lifetime?.catch(() => {});
      await opening.retire();
      throw postStealSignal?.aborted ? postStealSignal.reason : error;
    } finally {
      postStealSignal?.removeEventListener("abort", abortAllocation);
    }
  }

  private loseOwnership(): Error {
    if (this.ownershipError) return this.ownershipError;
    const error = new Error(OWNERSHIP_LOST_MESSAGE);
    this.ownershipError = error;
    for (const tx of this.transactions) {
      try {
        tx.abort();
      } catch {}
    }
    this.db.close();
    this.ownershipRetirement = Promise.allSettled(
      Array.from(this.readerWork).concat([this.tail]),
    ).then(() => this.retireMaintenance());
    void this.ownershipRetirement.catch(() => {});
    this.onOwnershipLost?.();
    return error;
  }
  private assertOwner(): void {
    if (this.ownershipError) throw this.ownershipError;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Filesystem storage is closed"));
    const result = this.tail.then(() => {
      this.assertOwner();
      return action();
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  load(signal?: AbortSignal): Promise<PersistedIndex | undefined> {
    return this.enqueue(async () => {
      await this.initialize(signal);
      signal?.throwIfAborted();
      if (!this.state) return;
      const index = this.index(this.state);
      return this.readOnly ? index : structuredClone(index);
    });
  }

  reserveIdentity(workspace?: string): Promise<IdentityReservation> {
    return this.enqueue(() => this.reserveCurrentIdentity(workspace));
  }
  private async reserveCurrentIdentity(workspace?: string): Promise<IdentityReservation> {
    await this.initialize();
    const observed: { value?: IdentityReservation; failure?: unknown } = {};
    await this.fencedWrite((_data, metadata) => {
      this.readIdentityReservation(metadata, workspace, observed);
    }).catch((error) => {
      throw observed.failure ?? error;
    });
    if (!observed.value) throw new Error("Missing filesystem identity reservation");
    return observed.value;
  }
  private readIdentityReservation(
    metadata: IDBObjectStore,
    workspace: string | undefined,
    observed: { value?: IdentityReservation; failure?: unknown },
  ): void {
    const previous = metadata.get("identity");
    previous.onsuccess = () => {
      try {
        observed.value = nextReservation(previous.result, workspace);
        metadata.put(storeReservation(observed.value), "identity");
      } catch (error) {
        observed.failure = error;
        metadata.transaction.abort();
      }
    };
  }

  read(key: string): Promise<Uint8Array> {
    return this.readReadonly(key);
  }
  readReadonly(key: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      await this.initialize(signal);
      if (this.readOnlyLegacy) {
        const value = await this.readRecord(key, signal);
        if (!(value instanceof Uint8Array)) chunkError(key);
        if (value.length !== this.payloadSize(key)) chunkError(key);
        return value;
      }
      return this.readPayload(
        key,
        { offset: 0, length: Number.MAX_SAFE_INTEGER, signal },
        this.knownSize(key),
      );
    });
  }

  retainPayload(
    key: string,
    expectedSize: number,
    metadata?: ReaderMetadataBudget,
  ): PayloadRetention {
    this.assertOwner();
    if (this.closed || !this.state?.payloadKeys.has(key) || this.deletingPayloads.has(key))
      throw new Error("Missing retained filesystem payload");
    if (this.payloadSize(key) !== expectedSize)
      throw new Error("Retained filesystem payload size mismatch");
    return this.readers.retain(key, expectedSize, metadata);
  }
  /** The size was verified when the caller's bytes were read; finding it again scans the index. */
  checkPayload(key: string): void {
    this.assertOwner();
    if (this.closed || !this.state?.payloadKeys.has(key) || this.deletingPayloads.has(key))
      throw new Error("Missing retained filesystem payload");
  }
  private payloadSize(key: string): number | undefined {
    return this.readers.size(key) ?? this.state!.payloadSizes.size(key);
  }
  /** The size a read can expect before its manifest arrives, when anything names the payload. */
  private knownSize(key: string): number | undefined {
    return this.readers.size(key) ?? this.state?.payloadSizes.size(key);
  }
  resources(): Record<string, number> {
    return { ...this.readers.resources(), indexeddbReaderWork: this.readerWork.size };
  }
  private retainedRange(key: string, range: IndexedDBRange): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("Filesystem storage is closed"));
    const size = this.readers.size(key);
    const work =
      size === undefined
        ? Promise.reject(new PayloadCorruption("Retained payload size mismatch"))
        : this.readPayload(key, range, size);
    this.readerWork.add(work);
    void work.then(
      () => this.readerWork.delete(work),
      () => this.readerWork.delete(work),
    );
    return work;
  }
  readRange(key: string, options: IndexedDBRange): Promise<Uint8Array> {
    const range = { offset: options.offset, length: options.length, signal: options.signal };
    try {
      validateRange(range);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.readers.has(key)) return this.retainedRange(key, range);
    return this.enqueue(async () => {
      range.signal?.throwIfAborted();
      await this.initialize(range.signal);
      return this.readPayload(key, range, this.knownSize(key));
    }).catch((error: unknown) => {
      range.signal?.throwIfAborted();
      throw error;
    });
  }

  private async readRecord(key: IDBValidKey, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    this.assertOwner();
    const tx = this.db.transaction("data", "readonly");
    this.transactions.add(tx);
    const abort = () => {
      try {
        tx.abort();
      } catch {}
    };
    signal?.addEventListener("abort", abort, { once: true });
    const settled = completed(tx);
    void settled.catch(() => {});
    try {
      const value = await request(tx.objectStore("data").get(key));
      await settled;
      signal?.throwIfAborted();
      this.assertOwner();
      return value;
    } catch (error) {
      throw signal?.aborted ? signal.reason : (this.ownershipError ?? error);
    } finally {
      await settled.catch(() => {});
      signal?.removeEventListener("abort", abort);
      this.transactions.delete(tx);
    }
  }

  /** One readonly transaction for the manifest and every chunk the range touches. With a known
   * size (`expectedSize`) all requests go out together, so the read costs one round trip; the
   * manifest must then match that size. The bytes are returned once every request has answered,
   * without waiting for the transaction's commit, and only after every checksum is verified. */
  private async readPayload(
    key: string,
    range: IndexedDBRange,
    expectedSize: number | undefined,
  ): Promise<Uint8Array> {
    const signal = range.signal;
    signal?.throwIfAborted();
    this.assertOwner();
    const tx = this.db.transaction("data", "readonly");
    this.transactions.add(tx);
    const abort = () => {
      try {
        tx.abort();
      } catch {}
    };
    signal?.addEventListener("abort", abort, { once: true });
    const settled = completed(tx);
    // Ownership loss aborts every tracked transaction until it settles.
    void settled.then(
      () => this.transactions.delete(tx),
      () => this.transactions.delete(tx),
    );
    const arrival = Promise.withResolvers<void>();
    const read: PayloadRead = {
      key,
      range,
      expectedSize,
      checks: [],
      pending: 0,
      arrived: arrival.resolve,
      fail: (error) => {
        read.failure ??= { cause: error };
        abort();
      },
    };
    const store = tx.objectStore("data");
    const manifest = store.get(key);
    manifest.onsuccess = () => {
      try {
        acceptManifest(store, manifest.result, read);
      } catch (error) {
        read.fail(error);
      }
    };
    if (expectedSize !== undefined) placeChunkReads(store, expectedSize, read);
    try {
      await Promise.race([arrival.promise, settled.then(() => arrival.promise)]);
    } catch (error) {
      throw signal?.aborted ? signal.reason : (this.ownershipError ?? read.failure?.cause ?? error);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    signal?.throwIfAborted();
    this.assertOwner();
    await verifyChecksums(key, read.checks, signal);
    this.assertOwner();
    return read.result!;
  }

  recoverCommitted(): Promise<CommittedRecovery> {
    return this.enqueue(async () => {
      if (!this.committedMode) invalidCommit();
      await this.initialize();
      if (!this.committedEnvelope) invalidCommit();
      return structuredClone({
        index: this.state && this.index(this.state),
        envelope: this.committedEnvelope,
        epoch: this.epoch,
      });
    });
  }
  beginCommit(group: PreparedDurableGroup): NativeCommit {
    const control = new NativeCommitControl();
    let copy: PreparedDurableGroup;
    try {
      if (!this.committedMode) invalidCommit();
      if (this.committedPending) throw new StagingCapacity();
      const bytes = Array.from(group.batch.data.values()).reduce(
        (sum, bytes) => sum + bytes.byteLength,
        0,
      );
      const metadata =
        JSON.stringify({
          upserts: group.batch.upserts,
          removes: group.batch.removes,
          retainedData: group.batch.retainedData,
          publication: group.batch.publication,
          keys: Array.from(group.batch.data.keys()),
        }).length * 2;
      const base = this.state ? JSON.stringify(this.index(this.state)).length * 2 : 0;
      if (
        metadata + base > STAGING_LIMITS.metadataBytes ||
        group.envelope.json.length * 2 > STAGING_LIMITS.metadataBytes ||
        bytes * 6 + (metadata + base + group.envelope.json.length * 2) * 16 > STAGING_LIMITS.bytes
      )
        throw new StagingCapacity();
      copy = {
        ...structuredClone({
          expectedHead: group.expectedHead,
          envelope: group.envelope,
          receipt: group.receipt,
        }),
        batch: snapshotBatch(group.batch),
      };
    } catch (error) {
      control.finish(error);
      return control;
    }
    this.committedPending = true;
    void this.enqueue(async () => {
      control.checkAbort();
      await this.initialize();
      if (!this.committedEnvelope || !this.committedRecord) invalidCommit();
      const envelope = await validateGroup(copy, {
        index: this.state && this.index(this.state),
        envelope: this.committedEnvelope,
        epoch: this.epoch,
      });
      await this.commit(copy.batch, {
        group: copy,
        envelope,
        expected: this.committedRecord,
        control,
      });
    }).then(
      () => {
        this.committedPending = false;
        control.finish();
      },
      (error: unknown) => {
        this.committedPending = false;
        try {
          if (control.durable) this.loseOwnership();
        } catch {}
        control.finish(error);
      },
    );
    return control;
  }

  persist(batch: PersistenceBatch): Promise<void> {
    // Snapshot at submission, not when this operation reaches the asynchronous write queue.
    let copy: PersistenceBatch;
    try {
      copy = snapshotBatch(batch);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(async () => {
      try {
        await this.initialize();
        await this.commit(copy);
        this.persistenceError = undefined;
      } catch (error) {
        this.persistenceError = error;
        throw error;
      }
    });
  }

  async flush(): Promise<void> {
    if (this.closed) throw new Error("Filesystem storage is closed");
    await this.tail;
    this.assertOwner();
    if (this.persistenceError !== undefined) throw this.persistenceError;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = Promise.all(Array.from(this.readerWork).concat([this.tail])).then(async () => {
        this.db.close();
        if (this.readOnly) {
          this.state = undefined;
          this.readers.recovery(new Set());
        }
        await this.unlock();
        await (this.ownershipRetirement ?? this.retireMaintenance());
      });
    }
    return this.closing;
  }

  private index(state: State): PersistedIndex {
    return {
      version: 1,
      generation: state.generation,
      root: state.root,
      ...(state.publication ? { publication: state.publication } : {}),
      nodes: Array.from(state.nodes.values()),
    };
  }

  private async indexRecords(signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.assertOwner();
    const tx = this.db.transaction(["metadata", "journal", "data"], "readonly");
    this.transactions.add(tx);
    const abort = () => {
      try {
        tx.abort();
      } catch {}
    };
    const settled = completed(tx);
    void settled.catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    const metadata = tx.objectStore("metadata"),
      journal = tx.objectStore("journal"),
      data = tx.objectStore("data");
    try {
      const records = await Promise.all([
        request(metadata.get(0)),
        request(metadata.get(1)),
        request(metadata.getAllKeys()),
        request(journal.getAll()),
        request(journal.getAllKeys()),
        request(data.getAllKeys()),
        formatAndManifests(metadata, data),
        request(metadata.get("commit")),
        request(metadata.get("active")),
        settled,
      ]);
      signal?.throwIfAborted();
      this.assertOwner();
      return records;
    } catch (error) {
      throw signal?.aborted ? signal.reason : (this.ownershipError ?? error);
    } finally {
      await settled.catch(() => {});
      signal?.removeEventListener("abort", abort);
      this.transactions.delete(tx);
    }
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.initialized) return;
    const [
      first,
      second,
      metadataKeys,
      journalValues,
      journalKeys,
      dataKeys,
      { format, manifests },
      storedCommit,
      active,
    ] = await this.indexRecords(signal);
    const stagedEmpty = validateDatabaseLayout(
      this.committedMode,
      format,
      metadataKeys,
      journalKeys,
      dataKeys,
    );
    const payloadKeys = new Set<string>();
    for (const key of dataKeys) {
      if (typeof key === "string") payloadKeys.add(key);
      else if (Array.isArray(key) && typeof key[0] === "string") payloadKeys.add(key[0]);
    }
    const physical = manifests && validateChunks(dataKeys, manifests);
    const available = physical ? new Set(physical.keys()) : payloadKeys;
    const decoded = await Promise.all([decodeIndex(first), decodeIndex(second)]);
    signal?.throwIfAborted();
    const bases: State["bases"] = [decoded[0], decoded[1]];
    for (const slot of [0, 1] as const)
      if (
        bases[slot] &&
        (!hasPayloads(bases[slot]!.nodes, available) ||
          !this.matchSizes(bases[slot]!.nodes, physical))
      )
        bases[slot] = undefined;
    const journals = new Map<number, Journal>();
    await Promise.all(
      journalValues.map(async (value, i) => {
        const entry = await decodeSelection(value);
        if (
          validateJournal(entry) &&
          entry.generation === journalKeys[i] &&
          hasPayloads(entry.upserts, available) &&
          this.matchSizes(entry.upserts, physical)
        )
          journals.set(entry.generation, entry);
      }),
    );
    signal?.throwIfAborted();
    const newest = recoverIndex(bases, journals, available);
    if (this.committedMode && !stagedEmpty)
      await this.recoverRequiredHead(storedCommit, active, newest, physical, journalKeys, dataKeys);
    if (
      !newest &&
      (metadataKeys.filter(
        (key) =>
          key !== "format" &&
          key !== "identity" &&
          key !== "lastExclusiveEpoch" &&
          (!this.committedMode || key !== "commit"),
      ).length > 1 ||
        journalKeys.length > 0 ||
        dataKeys.length > 0)
    ) {
      throw new VfsError(
        "INVALID_VFS_FORMAT",
        "indexeddb",
        "Existing filesystem storage is corrupt; no valid snapshot can be recovered",
      );
    }
    if (newest) {
      const nodes = new Map(newest.nodes.map((node) => [node.ino, node]));
      const payloadSizes = new PayloadSizes();
      payloadSizes.add(nodes.values());
      for (const base of bases) if (base) payloadSizes.add(base.nodes);
      for (const journal of journals.values()) payloadSizes.add(journal.upserts);
      const lastBase = Math.max(
        ...bases.filter((base): base is PersistedIndex => !!base).map((base) => base.generation),
      );
      this.state = {
        generation: newest.generation,
        root: newest.root,
        publication: newest.publication,
        nodes,
        ...referenceIndex(nodes.values()),
        bases,
        journals,
        journalKeys,
        payloadKeys,
        payloadSizes,
        sinceCompaction: Array.from(journals.values()).filter(
          (entry) => entry.generation > lastBase,
        ).length,
      };
    }
    if (stagedEmpty) {
      const envelope = initialEnvelope(this.epoch),
        encoded = await encodeCommit(envelope);
      await this.fencedWrite((_data, metadata) => {
        metadata.put(STAGED_FORMAT, "format");
        metadata.put(encoded, "commit");
      }, signal);
      this.committedEnvelope = envelope;
      this.committedRecord = encoded;
    }
    this.readOnlyLegacy = this.readOnly && format !== INDEXEDDB_FORMAT;
    if (!this.readOnly && !this.committedMode && format !== INDEXEDDB_FORMAT)
      await this.migrateLegacy(dataKeys, signal);
    if (this.state)
      this.recordRecovery(
        this.state,
        this.committedEnvelope && Array.from(commitRoots(this.committedEnvelope).keys()),
      );
    this.initialized = true;
  }

  private async recoverRequiredHead(
    storedCommit: unknown,
    active: unknown,
    newest: PersistedIndex | undefined,
    physical: Map<string, ChunkManifest> | undefined,
    journalKeys: IDBValidKey[],
    dataKeys: IDBValidKey[],
  ): Promise<void> {
    const envelope = await decodeCommit(storedCommit);
    if (
      envelope.head.epoch < 1 ||
      envelope.head.epoch > this.epoch ||
      (envelope.head.sequence === 0n ? active !== undefined : active !== envelope.head.generation)
    )
      invalidCommit();
    if (
      envelope.head.sequence === 0n
        ? !!newest || journalKeys.length > 0 || dataKeys.length > 0
        : !newest ||
          newest.generation !== envelope.head.generation ||
          newest.root !== envelope.head.root
    )
      invalidCommit();
    for (const [key, size] of commitRoots(envelope))
      if (physical?.get(key)?.size !== size) invalidCommit();
    this.committedEnvelope = envelope;
    this.committedRecord = await encodeCommit(envelope);
  }

  private recordRecovery(state: State, extra?: readonly string[]): void {
    const retained = new Set<string>(extra);
    payloads(state.nodes.values(), retained);
    for (const base of state.bases) if (base) payloads(base.nodes, retained);
    for (const journal of state.journals.values()) payloads(journal.upserts, retained);
    this.readers.recovery(retained);
  }

  private matchSizes(
    nodes: readonly PersistedNode[],
    manifests?: ReadonlyMap<string, ChunkManifest>,
  ): boolean {
    return (
      !manifests ||
      nodes.every((node) => node.data === undefined || manifests.get(node.data)?.size === node.size)
    );
  }

  private async fencedWrite(
    work: (data: IDBObjectStore, metadata: IDBObjectStore) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.assertOwner();
    const tx = this.db.transaction(["metadata", "data"], "readwrite", { durability: "strict" });
    this.transactions.add(tx);
    let failure: unknown;
    const abort = () => {
      try {
        tx.abort();
      } catch {}
    };
    signal?.addEventListener("abort", abort, { once: true });
    const done = completed(tx);
    const metadata = tx.objectStore("metadata");
    const epoch = metadata.get("epoch");
    epoch.onsuccess = () => {
      try {
        if (epoch.result !== this.epoch) throw this.loseOwnership();
        signal?.throwIfAborted();
        work(tx.objectStore("data"), metadata);
      } catch (error) {
        failure = error;
        abort();
      }
    };
    try {
      await done;
      this.assertOwner();
      signal?.throwIfAborted();
    } catch (error) {
      throw signal?.aborted ? signal.reason : (this.ownershipError ?? failure ?? error);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.transactions.delete(tx);
    }
  }

  private async migrateLegacy(keys: IDBValidKey[], signal?: AbortSignal): Promise<void> {
    const strings = new Set(keys.filter((key): key is string => typeof key === "string"));
    for (const key of keys) {
      if (typeof key === "string") continue;
      if (
        !Array.isArray(key) ||
        key.length !== 2 ||
        typeof key[0] !== "string" ||
        !strings.has(key[0]) ||
        !validInteger(key[1])
      )
        chunkError(String(key));
    }
    const manifests = new Map<string, ChunkManifest>();
    for (const key of strings) {
      const value = await this.readRecord(key, signal);
      if (!(value instanceof Uint8Array)) chunkError(key);
      const prepared = await preparePayload(value, signal);
      signal?.throwIfAborted();
      await this.fencedWrite((data) => copyLegacyChunks(data, key, prepared), signal);
      manifests.set(key, prepared.manifest);
    }
    if (this.state) {
      const nodes = Array.from(this.state.nodes.values());
      if (!this.matchSizes(nodes, manifests)) chunkError("legacy root");
      for (const base of this.state.bases)
        if (base && !this.matchSizes(base.nodes, manifests)) chunkError("legacy recovery base");
      for (const journal of this.state.journals.values())
        if (!this.matchSizes(journal.upserts, manifests)) chunkError("legacy journal");
    }
    await this.fencedWrite((data, metadata) => {
      for (const [key, manifest] of manifests) data.put(manifest, key);
      metadata.put(INDEXEDDB_FORMAT, "format");
    }, signal);
  }

  private async commit(batch: PersistenceBatch, committed?: CommittedTransaction): Promise<void> {
    if (this.committedMode !== !!committed)
      throw new Error("Committed storage requires a complete durable group");
    const prepared = await preparePayloads(batch.data);
    const staged = stageChanges(this.state, batch),
      old = this.state;
    // A recovered generation may be reused. Its abandoned successors must not reconnect
    // to the replacement journal, or an old edit could become current again on reload.
    const discarded = new Set(
      old?.journalKeys.filter((key) => typeof key !== "number" || key > old.generation),
    );
    const compact = !old || old.sinceCompaction + 1 >= this.compactEvery;
    const entry: Journal | undefined = old && {
      version: 1,
      previous: old.generation,
      generation: batch.generation,
      root: batch.root,
      upserts: batch.upserts,
      removes: batch.removes,
      publication: batch.publication,
    };
    const encodedJournal = entry && (await encodeSelection(entry));
    let snapshot: PersistedIndex | undefined;
    const bases: State["bases"] = old ? [old.bases[0], old.bases[1]] : [undefined, undefined];
    let slot: 0 | 1 = 0;
    if (compact) {
      const nodes = new Map(old?.nodes);
      for (const ino of staged.removes) nodes.delete(ino);
      for (const [ino, node] of staged.upserts) nodes.set(ino, node);
      snapshot = {
        version: 1,
        generation: batch.generation,
        root: batch.root,
        ...(batch.publication ? { publication: batch.publication } : {}),
        nodes: Array.from(nodes.values()),
      };
      validatePersistedIndex(snapshot);
      slot = snapshotSlot(bases);
      bases[slot] = snapshot;
    }
    const encodedSnapshot = snapshot && (await encodeSelection(snapshot));
    const durableRoots = committed ? commitRoots(committed.envelope) : new Map<string, number>();
    const expected = requiredPayloads(staged.upserts.values(), durableRoots);
    const checking = new Set(Array.from(expected.keys()).concat(Array.from(batch.data.keys())));
    const pinChecks = new Set(batch.retainedData?.filter((key) => !checking.has(key)));
    let cutoff = -1;
    const retained = new Set((batch.retainedData ?? []).concat(Array.from(durableRoots.keys())));
    if (compact) {
      cutoff = Math.min(
        ...bases.filter((base): base is PersistedIndex => !!base).map((base) => base.generation),
      );
      for (const base of bases) if (base) payloads(base.nodes, retained);
      for (const journal of old?.journals.values() ?? []) {
        if (journal.generation > cutoff && !discarded.has(journal.generation))
          payloads(journal.upserts, retained);
      }
      if (entry && entry.generation > cutoff) payloads(entry.upserts, retained);
    }
    const deletedReaders: string[] = [];
    // No await inside this transaction: all hashes and compaction preparation are complete.
    committed?.control.checkAbort();
    this.assertOwner();
    const tx = this.db.transaction(["metadata", "journal", "data"], "readwrite", {
      durability: "strict",
    });
    this.transactions.add(tx);
    committed?.control.attach(tx);
    const data = tx.objectStore("data");
    await new Promise<void>((resolve, reject) => {
      let failure: { cause: unknown } | undefined;
      const abort = (error: unknown) => {
        if (!committed || !failure) failure = { cause: error };
        try {
          tx.abort();
        } catch {}
      };
      tx.oncomplete = () => {
        this.transactions.delete(tx);
        committed?.control.committed(committed.group.receipt);
        resolve();
      };
      tx.onabort = () => {
        this.transactions.delete(tx);
        for (const key of deletedReaders) this.deletingPayloads.delete(key);
        const cause = transactionFailure(tx, this.ownershipError, failure, committed);
        committed?.control.aborted(cause);
        reject(cause);
      };
      const finish = () => {
        try {
          for (const key of discarded) tx.objectStore("journal").delete(key);
          for (const slot of [0, 1] as const)
            if (old && !old.bases[slot]) tx.objectStore("metadata").delete(slot);
          if (encodedJournal) tx.objectStore("journal").put(encodedJournal, batch.generation);
          if (encodedSnapshot) tx.objectStore("metadata").put(encodedSnapshot, slot);
          tx.objectStore("metadata").put(batch.generation, "active");
          if (committed) tx.objectStore("metadata").put(committed.group.envelope, "commit");
          if (compact) {
            for (const key of old?.journalKeys ?? [])
              if (typeof key === "number" && key <= cutoff) tx.objectStore("journal").delete(key);
            for (const key of Array.from(old?.payloadKeys ?? []).concat(
              Array.from(batch.data.keys()),
            ))
              if (!retained.has(key) && !this.readers.has(key)) {
                this.deletingPayloads.add(key);
                deletedReaders.push(key);
                deletePayload(data, key);
              }
          }
        } catch (error) {
          abort(error);
        }
      };
      let remaining = checking.size + pinChecks.size + (committed ? 2 : 0);
      const checked = () => {
        if (--remaining === 0) finish();
      };
      const checkEpoch = tx.objectStore("metadata").get("epoch");
      checkEpoch.onsuccess = () => {
        if (checkEpoch.result !== this.epoch) {
          abort(this.loseOwnership());
          return;
        }
        if (committed) checked();
      };
      if (committed) checkCommitHead(tx, committed, checked, abort);
      try {
        if (!remaining) finish();
        for (const key of checking) {
          const get = data.get(key);
          get.onsuccess = () => {
            try {
              checkPayload(
                data,
                key,
                get.result,
                prepared.get(key),
                expected.get(key),
                checked,
                abort,
              );
            } catch (error) {
              abort(error);
            }
          };
        }
        // Pinning cold open-but-unlinked files must never materialize their payloads.
        for (const key of pinChecks) {
          const get = data.getKey(key);
          get.onsuccess = () => {
            if (get.result === undefined) abort(new Error(`Missing filesystem payload: ${key}`));
            else if (--remaining === 0) finish();
          };
        }
      } catch (error) {
        abort(error);
      }
    });
    const state: State = old ?? {
      generation: batch.generation,
      root: batch.root,
      nodes: new Map(),
      references: new Map(),
      parents: new Map(),
      bases: [undefined, undefined],
      journals: new Map(),
      journalKeys: [],
      payloadKeys: new Set(),
      payloadSizes: new PayloadSizes(),
      sinceCompaction: 0,
    };
    for (const key of discarded) if (typeof key === "number") dropJournal(state, key);
    state.journalKeys = state.journalKeys.filter((key) => !discarded.has(key));
    replaceNodes(state, staged);
    applyChanges(state, staged, batch);
    installBases(state, bases);
    if (entry) {
      state.journals.set(entry.generation, entry);
      state.journalKeys.push(entry.generation);
      state.payloadSizes.add(entry.upserts);
    }
    for (const key of batch.data.keys()) state.payloadKeys.add(key);
    if (compact) {
      for (const key of state.journals.keys()) if (key <= cutoff) dropJournal(state, key);
      state.journalKeys = state.journalKeys.filter(
        (key) => typeof key !== "number" || key > cutoff,
      );
      for (const key of deletedReaders) {
        state.payloadKeys.delete(key);
        this.deletingPayloads.delete(key);
        this.readers.deleted(key);
      }
      this.readers.recovery(retained);
    }
    state.sinceCompaction = compact ? 0 : state.sinceCompaction + 1;
    this.installCommit(
      state,
      (batch.retainedData ?? []).concat(Array.from(durableRoots.keys())),
      committed,
    );
  }
  private installCommit(state: State, retained: string[], committed?: CommittedTransaction): void {
    if (committed) {
      this.committedEnvelope = committed.envelope;
      this.committedRecord = committed.group.envelope;
    }
    this.state = state;
    this.recordRecovery(state, retained);
  }
}
