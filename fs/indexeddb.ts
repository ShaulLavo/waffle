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
import { INDEXEDDB_FORMAT } from "./vfs-format.js";
import { VfsError } from "./vfs.js";
import { reportRuntimeStartup, type RuntimeStartupObserver } from "./startup.js";
import {
  PayloadRetentions,
  PayloadCorruption,
  type PayloadRetention,
  type ReaderMetadataBudget,
  decodeRecord,
  snapshotBatch,
  decodeSnapshot,
  encodeRecord,
  encodeSnapshot,
  validatePersistedIndex,
  validatePersistedNode,
  validInteger,
  type PersistenceBatch,
  type PersistedIndex,
  type PersistedNode,
  type StorageBackend,
} from "./storage.js";

const OWNERSHIP_LOST_MESSAGE = "This workspace was opened in another tab. Reload to continue here.";

/** The subset of Web Locks needed by this backend; injectable without an unsafe fallback. */
export interface StorageLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; steal: true } | { mode: "exclusive"; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
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
  onWaiting?: () => void;
  whenBusy?: "takeover" | "wait";
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
function allocateEpoch(
  transaction: IDBTransaction,
  completedEpoch: Promise<void>,
): Promise<number> {
  let epoch = 0;
  const request = transaction.objectStore("metadata").get("epoch");
  request.onsuccess = () => {
    const previous: unknown = request.result;
    if (
      previous !== undefined &&
      (!validInteger(previous) || previous >= Number.MAX_SAFE_INTEGER)
    ) {
      transaction.abort();
      return;
    }
    epoch = (typeof previous === "number" ? previous : 0) + 1;
    transaction.objectStore("metadata").put(epoch, "epoch");
  };
  return completedEpoch.then(() => epoch);
}
interface Journal {
  version: 1;
  previous: number;
  generation: number;
  root: number;
  upserts: PersistedNode[];
  removes: number[];
}
interface TreeState {
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
  sinceCompaction: number;
}
function metadataError(): never {
  throw new VfsError("INVALID_VFS_FORMAT", "indexeddb", "Invalid persisted filesystem metadata");
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
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
  generation: number,
  root: number,
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
  state.generation = generation;
  state.root = root;
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
      nodes,
      ...referenceIndex(nodes.values()),
    };
    chain.reverse();
    try {
      for (const entry of chain)
        applyChanges(tree, stageChanges(tree, entry), entry.generation, entry.root);
      const index: PersistedIndex = {
        version: 1,
        generation: tree.generation,
        root: tree.root,
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
  private transactions = new Set<IDBTransaction>();

  private constructor(
    private readonly db: IDBDatabase,
    private readonly unlock: () => Promise<void>,
    private readonly compactEvery: number,
    private readonly epoch: number,
    private readonly onOwnershipLost?: () => void,
  ) {
    db.onversionchange = () => {
      void this.close();
    };
  }

  static async open(
    name: string,
    options: IndexedDBStorageOptions = {},
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
    const signal = versionChangeAbort
      ? options.signal
        ? AbortSignal.any([options.signal, versionChangeAbort.signal])
        : versionChangeAbort.signal
      : options.signal;
    const opening = new NativeDatabaseOpening(factory, name, signal, versionChangeAbort, options);
    const db = await opening.ready;
    reportRuntimeStartup(options.onStartupStage, "indexeddb-open-resolved");
    if (signal?.aborted) {
      await opening.retire();
      throw signal.reason;
    }
    if (
      db.objectStoreNames.length !== 3 ||
      !["metadata", "journal", "data"].every((store) => db.objectStoreNames.contains(store))
    ) {
      await opening.retire();
      throw new VfsError(
        "INVALID_VFS_FORMAT",
        "indexeddb",
        "Incompatible IndexedDB database schema",
      );
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
    // Once granted, Web Locks no longer observes abort. Retire an in-flight epoch
    // transaction through its normal completion/abort event before closing ownership.
    const abortAllocation = () => {
      try {
        allocation?.abort();
      } catch {
        /* Completion already won. */
      }
    };
    signal?.addEventListener("abort", abortAllocation, { once: true });
    reportRuntimeStartup(options.onStartupStage, "filesystem-lock-requested");
    const lockOptions =
      options.whenBusy === "wait"
        ? { mode: "exclusive" as const, signal }
        : { mode: "exclusive" as const, steal: true as const };
    const lifetime = requestStorageLock(
      locks,
      `bun-wasm:filesystem:indexeddb:${name}`,
      lockOptions,
      async () => {
        granted = true;
        if (lost) return;
        if (signal?.aborted) {
          refused(signal.reason);
          return;
        }
        reportRuntimeStartup(options.onStartupStage, "filesystem-lock-acquired");
        reportRuntimeStartup(options.onStartupStage, "filesystem-epoch-requested");
        if (signal?.aborted) throw signal.reason;
        allocation = db.transaction("metadata", "readwrite", { durability: "strict" });
        allocationDone = completed(allocation);
        const value = await allocateEpoch(allocation, allocationDone);
        reportRuntimeStartup(options.onStartupStage, "filesystem-epoch-resolved");
        allocation = undefined;
        if (lost) return;
        if (signal?.aborted) throw signal.reason;
        owner = new IndexedDBStorage(
          db,
          async () => {
            release();
            await lifetime.catch(() => {});
          },
          compactEvery,
          value,
          options.onOwnershipLost,
        );
        acquired(owner);
        await held;
      },
    );
    queueMicrotask(() => {
      if (options.whenBusy === "wait" && !granted && !lost && !signal?.aborted) {
        try {
          options.onWaiting?.();
        } catch {
          /* Observation cannot change ownership. */
        }
      }
    });
    void lifetime.catch((error) => {
      lost = true;
      try {
        allocation?.abort();
      } catch {
        /* A completed allocation is already durable. */
      }
      owner?.loseOwnership();
      const stolen =
        !signal?.aborted && error instanceof DOMException && error.name === "AbortError";
      refused(owner?.ownershipError ?? (stolen ? new Error(OWNERSHIP_LOST_MESSAGE) : error));
      if (stolen && !owner) options.onOwnershipLost?.();
    });
    try {
      const storage = await ready;
      if (signal?.aborted) throw signal.reason;
      opening.transfer();
      return storage;
    } catch (error) {
      release();
      await allocationDone?.catch(() => {});
      await lifetime.catch(() => {});
      await opening.retire();
      throw signal?.aborted ? signal.reason : error;
    } finally {
      signal?.removeEventListener("abort", abortAllocation);
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

  load(): Promise<PersistedIndex | undefined> {
    return this.enqueue(async () => {
      await this.initialize();
      return this.state && structuredClone(this.index(this.state));
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
    return this.enqueue(async () => {
      await this.initialize();
      const manifest = await this.manifest(key);
      return this.readChunks(key, manifest, { offset: 0, length: manifest.size });
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
  private payloadSize(key: string): number | undefined {
    const retained = this.readers.size(key);
    if (retained !== undefined) return retained;
    for (const node of this.state!.nodes.values()) if (node.data === key) return node.size;
    for (const base of this.state!.bases) {
      for (const node of base?.nodes ?? []) if (node.data === key) return node.size;
    }
    for (const journal of this.state!.journals.values()) {
      for (const node of journal.upserts) if (node.data === key) return node.size;
    }
    return undefined;
  }
  resources(): Record<string, number> {
    return { ...this.readers.resources(), indexeddbReaderWork: this.readerWork.size };
  }
  private retainedRange(key: string, range: IndexedDBRange): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("Filesystem storage is closed"));
    const work = this.manifest(key, range.signal).then((manifest) => {
      if (manifest.size !== this.readers.size(key))
        throw new PayloadCorruption("Retained payload size mismatch");
      return this.readChunks(key, manifest, range);
    });
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
      const manifest = await this.manifest(key, range.signal);
      return this.readChunks(key, manifest, range);
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

  private async manifest(key: string, signal?: AbortSignal): Promise<ChunkManifest> {
    const value = await this.readRecord(key, signal);
    if (value === undefined) throw new Error(`Missing filesystem payload: ${key}`);
    try {
      return parseManifest(value, key);
    } catch (error) {
      throw new PayloadCorruption(
        error instanceof Error ? error.message : "Invalid payload manifest",
      );
    }
  }

  private async readChunks(
    key: string,
    manifest: ChunkManifest,
    range: IndexedDBRange,
  ): Promise<Uint8Array> {
    const length = Math.max(0, Math.min(range.length, manifest.size - range.offset));
    const result = new Uint8Array(length);
    range.signal?.throwIfAborted();
    if (!length) return result;
    const end = range.offset + length;
    for (let index = Math.floor(range.offset / CHUNK_SIZE); index * CHUNK_SIZE < end; index++) {
      const record = await this.readRecord([key, index], range.signal);
      const chunk = this.validChunk(record, chunkLength(manifest, index), key);
      if ((await chunkChecksum(chunk.bytes)) !== chunk.checksum)
        throw new PayloadCorruption(`Invalid filesystem payload chunks: ${key}`);
      range.signal?.throwIfAborted();
      this.assertOwner();
      const start = Math.max(range.offset, index * CHUNK_SIZE);
      const stop = Math.min(end, (index + 1) * CHUNK_SIZE);
      result.set(
        chunk.bytes.subarray(start - index * CHUNK_SIZE, stop - index * CHUNK_SIZE),
        start - range.offset,
      );
    }
    range.signal?.throwIfAborted();
    return result;
  }

  private validChunk(record: unknown, length: number, key: string) {
    try {
      return parseChunk(record, length, key);
    } catch (error) {
      throw new PayloadCorruption(error instanceof Error ? error.message : "Invalid payload chunk");
    }
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
        await this.unlock();
      });
    }
    return this.closing;
  }

  private index(state: State): PersistedIndex {
    return {
      version: 1,
      generation: state.generation,
      root: state.root,
      nodes: Array.from(state.nodes.values()),
    };
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    const tx = this.db.transaction(["metadata", "journal", "data"], "readonly");
    const metadata = tx.objectStore("metadata"),
      journal = tx.objectStore("journal");
    const [first, second, metadataKeys, journalValues, journalKeys, dataKeys, format] =
      await Promise.all([
        request(metadata.get(0)),
        request(metadata.get(1)),
        request(metadata.getAllKeys()),
        request(journal.getAll()),
        request(journal.getAllKeys()),
        request(tx.objectStore("data").getAllKeys()),
        request(metadata.get("format")),
        completed(tx),
      ]);
    const formatPresent = metadataKeys.includes("format");
    if (formatPresent && format !== INDEXEDDB_FORMAT && format !== "waffle-indexeddb-v1")
      throw new VfsError(
        "INVALID_VFS_FORMAT",
        "indexeddb",
        "Incompatible IndexedDB filesystem format identity",
      );
    if (
      metadataKeys.some(
        (key) =>
          key !== 0 &&
          key !== 1 &&
          key !== "epoch" &&
          key !== "active" &&
          key !== "format" &&
          key !== "identity",
      )
    )
      throw new VfsError(
        "INVALID_VFS_FORMAT",
        "indexeddb",
        "Incompatible IndexedDB metadata layout",
      );
    const payloadKeys = new Set<string>();
    for (const key of dataKeys) {
      if (typeof key === "string") payloadKeys.add(key);
      else if (Array.isArray(key) && typeof key[0] === "string") payloadKeys.add(key[0]);
    }
    const physical =
      format === INDEXEDDB_FORMAT ? await this.validateChunks(dataKeys, signal) : undefined;
    const available = physical ? new Set(physical.keys()) : payloadKeys;
    const decoded = await Promise.all([decodeSnapshot(first), decodeSnapshot(second)]);
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
        const entry = await decodeRecord(value);
        if (
          validateJournal(entry) &&
          entry.generation === journalKeys[i] &&
          hasPayloads(entry.upserts, available) &&
          this.matchSizes(entry.upserts, physical)
        )
          journals.set(entry.generation, entry);
      }),
    );
    const newest = recoverIndex(bases, journals, available);
    if (
      !newest &&
      (metadataKeys.filter((key) => key !== "format" && key !== "identity").length > 1 ||
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
      const lastBase = Math.max(
        ...bases.filter((base): base is PersistedIndex => !!base).map((base) => base.generation),
      );
      this.state = {
        generation: newest.generation,
        root: newest.root,
        nodes,
        ...referenceIndex(nodes.values()),
        bases,
        journals,
        journalKeys,
        payloadKeys,
        sinceCompaction: Array.from(journals.values()).filter(
          (entry) => entry.generation > lastBase,
        ).length,
      };
    }
    if (format !== INDEXEDDB_FORMAT) await this.migrateLegacy(dataKeys, signal);
    if (this.state) this.recordRecovery(this.state);
    this.initialized = true;
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

  private async validateChunks(
    keys: IDBValidKey[],
    signal?: AbortSignal,
  ): Promise<Map<string, ChunkManifest>> {
    const manifests = new Map<string, ChunkManifest>();
    const chunks = new Map<string, Set<number>>();
    for (const key of keys) {
      if (typeof key === "string") {
        const manifest = recoveryManifest(await this.readRecord(key, signal), key);
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

  private async commit(batch: PersistenceBatch): Promise<void> {
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
    };
    const encodedJournal = entry && (await encodeRecord(entry));
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
        nodes: Array.from(nodes.values()),
      };
      validatePersistedIndex(snapshot);
      slot = !bases[0] ? 0 : !bases[1] ? 1 : bases[0].generation <= bases[1].generation ? 0 : 1;
      bases[slot] = snapshot;
    }
    const encodedSnapshot = snapshot && (await encodeSnapshot(snapshot));
    const expected = new Map<string, number>();
    for (const node of staged.upserts.values())
      if (node.data !== undefined) {
        const size = expected.get(node.data);
        if (size !== undefined && size !== node.size) metadataError();
        expected.set(node.data, node.size);
      }
    const checking = new Set(Array.from(expected.keys()).concat(Array.from(batch.data.keys())));
    const pinChecks = new Set(batch.retainedData?.filter((key) => !checking.has(key)));
    let cutoff = -1;
    const retained = new Set(batch.retainedData);
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
    this.assertOwner();
    const tx = this.db.transaction(["metadata", "journal", "data"], "readwrite", {
      durability: "strict",
    });
    this.transactions.add(tx);
    const data = tx.objectStore("data");
    await new Promise<void>((resolve, reject) => {
      let failure: unknown;
      const abort = (error: unknown) => {
        failure = error;
        try {
          tx.abort();
        } catch {}
      };
      tx.oncomplete = () => {
        this.transactions.delete(tx);
        resolve();
      };
      tx.onabort = () => {
        this.transactions.delete(tx);
        for (const key of deletedReaders) this.deletingPayloads.delete(key);
        reject(
          this.ownershipError ?? failure ?? tx.error ?? new Error("Filesystem transaction aborted"),
        );
      };
      const finish = () => {
        try {
          for (const key of discarded) tx.objectStore("journal").delete(key);
          for (const slot of [0, 1] as const)
            if (old && !old.bases[slot]) tx.objectStore("metadata").delete(slot);
          if (encodedJournal) tx.objectStore("journal").put(encodedJournal, batch.generation);
          if (encodedSnapshot) tx.objectStore("metadata").put(encodedSnapshot, slot);
          tx.objectStore("metadata").put(batch.generation, "active");
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
      let remaining = checking.size + pinChecks.size;
      const checked = () => {
        if (--remaining === 0) finish();
      };
      const checkEpoch = tx.objectStore("metadata").get("epoch");
      checkEpoch.onsuccess = () => {
        if (checkEpoch.result !== this.epoch) {
          abort(this.loseOwnership());
          return;
        }
      };
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
      bases,
      journals: new Map(),
      journalKeys: [],
      payloadKeys: new Set(),
      sinceCompaction: 0,
    };
    for (const key of discarded) if (typeof key === "number") state.journals.delete(key);
    state.journalKeys = state.journalKeys.filter((key) => !discarded.has(key));
    applyChanges(state, staged, batch.generation, batch.root);
    state.bases = bases;
    if (entry) {
      state.journals.set(entry.generation, entry);
      state.journalKeys.push(entry.generation);
    }
    for (const key of batch.data.keys()) state.payloadKeys.add(key);
    if (compact) {
      for (const key of state.journals.keys()) if (key <= cutoff) state.journals.delete(key);
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
    this.state = state;
    this.recordRecovery(state, batch.retainedData);
  }
}
