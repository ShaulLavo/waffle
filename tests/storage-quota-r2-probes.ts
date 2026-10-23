import { IndexedDBStorage } from "../fs/indexeddb.js";
import { OpfsStorage } from "../fs/opfs.js";
import { decodeRecord, decodeSnapshot, type StorageBackend } from "../fs/storage.js";

export type AdapterKind = "indexeddb" | "opfs";
export type Fault = "payload-quota" | "commit" | "cleanup";
export interface NativeCounts {
  handles: number;
  peakHandles: number;
  opened: number;
  closed: number;
  writeBytes: number;
  puts: number;
  deletes: number;
  aborted: number;
  transactions: number;
  peakTransactions: number;
  faultHits: number;
}
export interface Inventory {
  payloads: string[];
  payloadRecords: number;
  chunkRecords: number;
  payloadBytes: number;
  metadataRecords: number;
  journalRecords: number;
  bases: number[];
  orphanPayloads: string[];
}
interface SyncAccess {
  getSize(): number;
  read(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccess> };
function hasSyncAccess(file: FileSystemFileHandle): file is SyncFile {
  return "createSyncAccessHandle" in file && typeof file.createSyncAccessHandle === "function";
}
type Completion = ReturnType<typeof Promise.withResolvers<void>>;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function encoded(value: string): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decoded(value: string): string {
  const result: unknown = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
  assert(typeof result === "string", "invalid physical OPFS payload name");
  return result;
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("raw transaction aborted"));
  });
}
async function database<T>(name: string, action: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await request(indexedDB.open(name));
  try {
    return await action(db);
  } finally {
    db.close();
  }
}
function referenceKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const nodes = "nodes" in value ? value.nodes : "upserts" in value ? value.upserts : [];
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node: unknown) =>
    node && typeof node === "object" && "data" in node && typeof node.data === "string"
      ? [node.data]
      : [],
  );
}
async function idbInventory(name: string): Promise<Inventory> {
  return database(name, async (db) => {
    const tx = db.transaction(["metadata", "journal", "data"]);
    const [metadata, journals, keys, values] = await Promise.all([
      request<unknown[]>(tx.objectStore("metadata").getAll()),
      request<unknown[]>(tx.objectStore("journal").getAll()),
      request(tx.objectStore("data").getAllKeys()),
      request<unknown[]>(tx.objectStore("data").getAll()),
    ]);
    const bases = (await Promise.all(metadata.map(decodeSnapshot))).filter((base) => !!base);
    const decodedJournals = await Promise.all(journals.map(decodeRecord));
    const retained = new Set(
      bases.flatMap(referenceKeys).concat(decodedJournals.flatMap(referenceKeys)),
    );
    const payloads = keys.filter((key): key is string => typeof key === "string");
    let payloadBytes = 0;
    for (const value of values) {
      if (!value || typeof value !== "object" || !("bytes" in value)) continue;
      if (value.bytes instanceof Uint8Array) payloadBytes += value.bytes.byteLength;
    }
    return {
      payloads,
      payloadRecords: keys.length,
      chunkRecords: keys.length - payloads.length,
      payloadBytes,
      metadataRecords: metadata.length,
      journalRecords: journals.length,
      bases: bases.map((base) => base.generation).sort((a, b) => a - b),
      orphanPayloads: payloads.filter((key) => !retained.has(key)),
    };
  });
}
async function directory(name: string): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(`bun-wasm-${encoded(name)}`);
}
async function files(dir: FileSystemDirectoryHandle): Promise<FileSystemFileHandle[]> {
  const result: FileSystemFileHandle[] = [];
  for await (const handle of dir.values()) if (handle.kind === "file") result.push(handle);
  return result;
}
async function opfsInventory(name: string): Promise<Inventory> {
  const root = await directory(name);
  const metadata = await files(await root.getDirectoryHandle("metadata"));
  const data = await files(await root.getDirectoryHandle("data"));
  const snapshots = metadata.filter((file) => file.name.startsWith("snapshot-"));
  const bases = await Promise.all(
    snapshots.map(async (file) => decodeSnapshot(JSON.parse(await (await file.getFile()).text()))),
  );
  const valid = bases.filter((base) => !!base);
  valid.sort((a, b) => b.generation - a.generation);
  const retained = new Set(valid.slice(0, 2).flatMap(referenceKeys));
  const payloads = data.map((file) => decoded(file.name.slice(2)));
  const sizes = await Promise.all(data.map(async (file) => (await file.getFile()).size));
  return {
    payloads,
    payloadRecords: data.length,
    chunkRecords: 0,
    payloadBytes: sizes.reduce((sum, size) => sum + size, 0),
    metadataRecords: snapshots.length,
    journalRecords: 0,
    bases: valid.map((base) => base.generation).sort((a, b) => a - b),
    orphanPayloads: payloads.filter((key) => !retained.has(key)),
  };
}
async function removeLatest(name: string, kind: AdapterKind): Promise<void> {
  if (kind === "indexeddb") {
    await database(name, async (db) => {
      const read = db.transaction("metadata").objectStore("metadata");
      const records = await Promise.all([
        request<unknown>(read.get(0)),
        request<unknown>(read.get(1)),
      ]);
      const bases = await Promise.all(records.map(decodeSnapshot));
      const slot = (bases[0]?.generation ?? -1) > (bases[1]?.generation ?? -1) ? 0 : 1;
      const tx = db.transaction(["metadata", "journal"], "readwrite", { durability: "strict" });
      const done = completed(tx);
      tx.objectStore("metadata").delete(slot);
      tx.objectStore("journal").delete(bases[slot]!.generation);
      await done;
    });
    return;
  }
  const metadata = await (await directory(name)).getDirectoryHandle("metadata");
  const snapshots = (await files(metadata)).filter((file) => file.name.startsWith("snapshot-"));
  const ordered = await Promise.all(
    snapshots.map(async (file) => ({
      file,
      index: await decodeSnapshot(JSON.parse(await (await file.getFile()).text())),
    })),
  );
  ordered.sort((a, b) => (b.index?.generation ?? -1) - (a.index?.generation ?? -1));
  assert(ordered[0], "missing OPFS snapshot to remove");
  await metadata.removeEntry(ordered[0].file.name);
}
export class QuotaProbe {
  readonly counts: NativeCounts = {
    handles: 0,
    peakHandles: 0,
    opened: 0,
    closed: 0,
    writeBytes: 0,
    puts: 0,
    deletes: 0,
    aborted: 0,
    transactions: 0,
    peakTransactions: 0,
    faultHits: 0,
  };
  fault: Fault | undefined;
  failure: { fault: Exclude<Fault, "cleanup">; reason: unknown } | undefined;
  private restorers: (() => void)[] = [];
  private owners = new Set<StorageBackend>();
  private held: { release: Completion; started: Completion } | undefined;
  pause() {
    const held = { release: Promise.withResolvers<void>(), started: Promise.withResolvers<void>() };
    this.held = held;
    return {
      started: held.started.promise,
      release: () => {
        this.held = undefined;
        held.release.resolve();
      },
    };
  }
  constructor(
    readonly kind: AdapterKind,
    readonly name: string,
    readonly compactEvery = 4,
  ) {}
  install(): void {
    if (this.kind === "indexeddb") this.instrumentIDB();
    else this.instrumentOPFS();
  }
  async open(): Promise<StorageBackend> {
    const storage =
      this.kind === "indexeddb"
        ? await IndexedDBStorage.open(this.name, { compactEvery: this.compactEvery })
        : await OpfsStorage.open(this.name, { createConcurrency: 1, handleCacheSize: 4 });
    const persist = storage.persist.bind(storage);
    storage.persist = async (batch) => {
      const held = this.held;
      held?.started.resolve();
      await held?.release.promise;
      await persist(batch);
    };
    this.owners.add(storage);
    return storage;
  }
  async close(storage: StorageBackend): Promise<void> {
    await storage.close();
    this.owners.delete(storage);
  }
  inspect(): Promise<Inventory> {
    return this.kind === "indexeddb" ? idbInventory(this.name) : opfsInventory(this.name);
  }
  removeLatest(): Promise<void> {
    return removeLatest(this.name, this.kind);
  }
  private instrumentIDB(): void {
    const counts = this.counts;
    const failPut = this.failPut.bind(this);
    const observeTransaction = this.observeTransaction.bind(this);
    const originalPut = IDBObjectStore.prototype.put;
    const originalDelete = IDBObjectStore.prototype.delete;
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      counts.puts++;
      const result = originalPut.call(this, value, key);
      failPut(this.name, key);
      return result;
    };
    IDBObjectStore.prototype.delete = function (key) {
      counts.deletes++;
      return originalDelete.call(this, key);
    };
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
      const tx = originalTransaction.apply(this, args);
      if (args[1] === "readwrite") observeTransaction(tx, args[2]);
      return tx;
    };
    this.restorers.push(() => {
      IDBObjectStore.prototype.put = originalPut;
      IDBObjectStore.prototype.delete = originalDelete;
      IDBDatabase.prototype.transaction = originalTransaction;
    });
  }
  private observeTransaction(tx: IDBTransaction, options?: IDBTransactionOptions): void {
    assert(options?.durability === "strict", "adapter commit must request strict durability");
    this.counts.transactions++;
    this.counts.peakTransactions = Math.max(this.counts.peakTransactions, this.counts.transactions);
    tx.addEventListener("complete", () => this.counts.transactions--, { once: true });
    tx.addEventListener(
      "abort",
      () => {
        this.counts.transactions--;
        this.counts.aborted++;
      },
      { once: true },
    );
  }
  private failPut(store: string, key?: IDBValidKey): void {
    if (this.fault === "payload-quota" && store === "data" && Array.isArray(key)) {
      this.fail(
        "payload-quota",
        new DOMException("injected quota after real chunk put", "QuotaExceededError"),
      );
    }
    if (this.fault !== "commit" || store !== "metadata" || key !== "active") return;
    this.fail("commit", new Error("injected commit failure after real active put"));
  }
  private instrumentOPFS(): void {
    const counts = this.counts;
    const observeHandle = this.observeHandle.bind(this);
    const fault = () => this.fault;
    const prototype = FileSystemFileHandle.prototype;
    assert(hasSyncAccess(prototype), "native OPFS sync handles require dedicated worker");
    const open = prototype.createSyncAccessHandle;
    prototype.createSyncAccessHandle = async function () {
      return observeHandle(this.name, await open.call(this));
    };
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = async function (name, options) {
      if (fault() === "cleanup" && (this.name === "data" || name.startsWith("snapshot-"))) {
        counts.faultHits++;
        throw new DOMException("injected cleanup denial", "NoModificationAllowedError");
      }
      counts.deletes++;
      await remove.call(this, name, options);
    };
    this.restorers.push(() => {
      prototype.createSyncAccessHandle = open;
      FileSystemDirectoryHandle.prototype.removeEntry = remove;
    });
  }
  private observeHandle(name: string, access: SyncAccess): SyncAccess {
    this.counts.handles++;
    this.counts.opened++;
    this.counts.peakHandles = Math.max(this.counts.peakHandles, this.counts.handles);
    let closed = false;
    return new Proxy(access, {
      get: (target, key) => {
        if (key === "write")
          return (bytes: Uint8Array, options?: { at?: number }) =>
            this.write(target, name, bytes, options);
        if (key === "flush") return () => this.flush(target, name);
        if (key === "close")
          return () => {
            target.close();
            assert(!closed, "native sync handle closed twice");
            closed = true;
            this.counts.handles--;
            this.counts.closed++;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  private write(
    access: SyncAccess,
    name: string,
    bytes: Uint8Array,
    options?: { at?: number },
  ): number {
    const partial = this.fault === "payload-quota" && name.startsWith("p-");
    const count = access.write(partial ? bytes.subarray(0, 1) : bytes, options);
    this.counts.writeBytes += count;
    if (!partial) return count;
    return this.fail(
      "payload-quota",
      new DOMException("injected quota after partial real payload write", "QuotaExceededError"),
    );
  }
  private flush(access: SyncAccess, name: string): void {
    if (
      this.fault !== "commit" ||
      !name.startsWith("snapshot-") ||
      name === "snapshot-initial.json"
    ) {
      access.flush();
      return;
    }
    this.fail("commit", new Error("injected commit failure before snapshot flush"));
  }
  private fail(fault: Exclude<Fault, "cleanup">, reason: unknown): never {
    this.counts.faultHits++;
    this.failure = { fault, reason };
    throw reason;
  }
  async destroy(): Promise<void> {
    this.fault = undefined;
    this.held?.release.resolve();
    this.held = undefined;
    try {
      for (const storage of this.owners) await this.close(storage);
      assert(this.counts.handles === 0, "native handles remain after storage close");
      assert(
        this.counts.transactions === 0,
        "native write transactions remain after storage close",
      );
    } finally {
      for (const restore of this.restorers.toReversed()) restore();
    }
    if (this.kind === "indexeddb") await request(indexedDB.deleteDatabase(this.name));
    else
      await (
        await navigator.storage.getDirectory()
      ).removeEntry(`bun-wasm-${encoded(this.name)}`, { recursive: true });
  }
}
