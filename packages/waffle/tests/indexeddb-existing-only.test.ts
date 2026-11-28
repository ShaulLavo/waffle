import { expect, test } from "bun:test";
import {
  IndexedDBStorage,
  IndexedDBStorageBusyError,
  IndexedDBStorageMissingError,
  VfsError,
} from "../fs/index.js";
import { maintenanceLock, type StorageLockManager } from "../fs/storage-maintenance.js";

interface LockRecord {
  readonly name: string;
  readonly mode: "exclusive" | "shared";
  readonly released: Promise<void>;
  release: () => void;
}

class FakeLockManager implements StorageLockManager {
  private readonly held = new Map<string, LockRecord[]>();
  private readonly waiters = new Map<string, (() => void)[]>();
  readonly requested: { readonly name: string; readonly mode: "exclusive" | "shared" }[] = [];

  heldCount(name: string): number {
    return this.held.get(name)?.length ?? 0;
  }

  async query(): Promise<{ held: { name: string; mode: string }[]; pending: unknown[] }> {
    const held: { name: string; mode: string }[] = [];
    for (const records of this.held.values()) {
      for (const record of records) held.push({ name: record.name, mode: record.mode });
    }
    return { held, pending: [] };
  }

  private canGrant(name: string, mode: "exclusive" | "shared"): boolean {
    const current = this.held.get(name) ?? [];
    if (current.length === 0) return true;
    return mode === "shared" && current.every((entry) => entry.mode === "shared");
  }

  private wake(name: string): void {
    const queue = this.waiters.get(name);
    if (!queue || queue.length === 0) return;
    const next = queue.slice();
    queue.length = 0;
    for (const resume of next) resume();
  }

  async request<T>(
    name: string,
    options:
      | { mode: "exclusive"; steal: true }
      | { mode: "exclusive" | "shared"; ifAvailable: true }
      | { mode: "exclusive" | "shared"; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T> {
    const mode = options.mode;
    this.requested.push({ name, mode });
    if ("steal" in options && options.steal) {
      this.held.delete(name);
    } else if ("ifAvailable" in options && options.ifAvailable) {
      if (!this.canGrant(name, mode)) return callback(null);
    } else {
      const signal = "signal" in options ? options.signal : undefined;
      while (!this.canGrant(name, mode)) {
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal?.reason);
          signal?.addEventListener("abort", onAbort, { once: true });
          const queue = this.waiters.get(name) ?? [];
          this.waiters.set(name, queue);
          queue.push(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      }
    }
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record: LockRecord = { name, mode, released, release };
    const list = this.held.get(name) ?? [];
    list.push(record);
    this.held.set(name, list);
    try {
      return await callback({ name, mode });
    } finally {
      const current = this.held.get(name);
      if (current) {
        const index = current.indexOf(record);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) this.held.delete(name);
      }
      release();
      this.wake(name);
    }
  }
}

interface FakeDatabaseState {
  version: number;
  stores: string[];
  metadata: Map<unknown, unknown>;
}

interface FakeIndexedDB {
  readonly factory: IDBFactory;
  readonly databases: Map<string, FakeDatabaseState>;
  readonly events: string[];
  closedCount: number;
}

function makeFakeDatabase(state: FakeDatabaseState, onClose: () => void): IDBDatabase {
  const storeNames = {
    get length() {
      return state.stores.length;
    },
    contains(name: string) {
      return state.stores.includes(name);
    },
  };
  return {
    get version() {
      return state.version;
    },
    objectStoreNames: storeNames,
    createObjectStore(name: string) {
      if (!state.stores.includes(name)) state.stores.push(name);
      return {};
    },
    close: onClose,
    transaction(storeName: string, mode?: IDBTransactionMode) {
      if (storeName !== "metadata") throw new Error(`unexpected store ${storeName}`);
      const tx: Record<string, unknown> = {
        oncomplete: null,
        onabort: null,
        onerror: null,
        error: null,
        aborted: false,
      };
      const staged = new Map(state.metadata);
      let pending = 0;
      const scheduleFinish = () => {
        queueMicrotask(() => {
          if (pending > 0) return;
          if (tx.aborted) {
            tx.error = new DOMException("aborted", "AbortError");
            (tx.onabort as (() => void) | null)?.();
            return;
          }
          if (mode === "readwrite") state.metadata = staged;
          (tx.oncomplete as (() => void) | null)?.();
        });
      };
      tx.abort = () => {
        tx.aborted = true;
      };
      tx.objectStore = () => ({
        get(key: unknown) {
          pending++;
          const req: Record<string, unknown> = {
            onsuccess: null,
            onerror: null,
            result: undefined,
          };
          queueMicrotask(() => {
            req.result = staged.get(key);
            pending--;
            (req.onsuccess as (() => void) | null)?.();
            scheduleFinish();
          });
          return req;
        },
        put(value: unknown, key: unknown) {
          staged.set(key, value);
          return {};
        },
      });
      return tx;
    },
  } as unknown as IDBDatabase;
}

function createFakeIndexedDB(
  onOpen?: (name: string) => void,
  initial: Readonly<Record<string, FakeDatabaseState>> = {},
): FakeIndexedDB {
  const databases = new Map<string, FakeDatabaseState>(Object.entries(initial));
  const events: string[] = [];
  const state: FakeIndexedDB = {
    databases,
    events,
    closedCount: 0,
    factory: {
      open(name: string, version?: number) {
        onOpen?.(name);
        const req: Record<string, unknown> = {
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
          result: undefined,
          error: null,
          transaction: null,
        };
        queueMicrotask(() => {
          const existing = databases.get(name);
          if (existing && version !== undefined && existing.version > version) {
            events.push(`version-error:${name}`);
            req.error = new DOMException("version mismatch", "VersionError");
            (req.onerror as (() => void) | null)?.();
            return;
          }
          if (!existing) {
            const candidate: FakeDatabaseState = {
              version: version ?? 1,
              stores: [],
              metadata: new Map(),
            };
            let aborted = false;
            const db = makeFakeDatabase(candidate, () => {
              state.closedCount++;
            });
            req.result = db;
            req.transaction = {
              abort() {
                aborted = true;
                events.push(`upgrade-aborted:${name}`);
              },
            };
            events.push(`upgradeneeded:${name}`);
            (req.onupgradeneeded as (() => void) | null)?.();
            if (aborted) {
              req.error = new DOMException("upgrade aborted", "AbortError");
              (req.onerror as (() => void) | null)?.();
              return;
            }
            databases.set(name, candidate);
            events.push(`created:${name}`);
            (req.onsuccess as (() => void) | null)?.();
            return;
          }
          const db = makeFakeDatabase(existing, () => {
            state.closedCount++;
          });
          req.result = db;
          events.push(`opened-existing:${name}`);
          (req.onsuccess as (() => void) | null)?.();
        });
        return req as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory,
  };
  return state;
}

const MAINT = (name: string) => `bun-wasm:filesystem:indexeddb-maintenance:${name}`;
const WRITER = (name: string) => `bun-wasm:filesystem:indexeddb:${name}`;

test("createIfMissing: false aborts upgradeneeded under maintenance lock without creating DB or allocating epoch 1", async () => {
  const locks = new FakeLockManager();
  let maintenanceHeldAtOpen = false;
  const idb = createFakeIndexedDB((name) => {
    maintenanceHeldAtOpen = locks.heldCount(MAINT(name)) > 0;
  });

  await expect(
    IndexedDBStorage.open("absent-db", {
      indexedDB: idb.factory,
      locks,
      createIfMissing: false,
    }),
  ).rejects.toBeInstanceOf(IndexedDBStorageMissingError);

  expect(maintenanceHeldAtOpen).toBe(true);
  expect(idb.events).toEqual(["upgradeneeded:absent-db", "upgrade-aborted:absent-db"]);
  expect(idb.databases.has("absent-db")).toBe(false);
  expect(locks.requested.some((entry) => entry.name === WRITER("absent-db"))).toBe(false);
  expect(locks.heldCount(MAINT("absent-db"))).toBe(0);
});

test("openCommitted with createIfMissing: false also rejects absent DB cleanly", async () => {
  const locks = new FakeLockManager();
  const idb = createFakeIndexedDB();

  await expect(
    IndexedDBStorage.openCommitted("absent-committed", {
      indexedDB: idb.factory,
      locks,
      createIfMissing: false,
    }),
  ).rejects.toBeInstanceOf(IndexedDBStorageMissingError);

  expect(idb.databases.has("absent-committed")).toBe(false);
  expect(locks.heldCount(MAINT("absent-committed"))).toBe(0);
});

test("createIfMissing: false opens an existing database, increments epoch, and releases locks on close", async () => {
  const locks = new FakeLockManager();
  const idb = createFakeIndexedDB(undefined, {
    "existing-db": {
      version: 1,
      stores: ["metadata", "journal", "data"],
      metadata: new Map<unknown, unknown>([
        ["epoch", 3],
        ["lastExclusiveEpoch", 3],
      ]),
    },
  });

  const storage = await IndexedDBStorage.open("existing-db", {
    indexedDB: idb.factory,
    locks,
    createIfMissing: false,
  });
  expect(idb.events).toEqual(["opened-existing:existing-db"]);
  expect(idb.databases.get("existing-db")?.metadata.get("epoch")).toBe(4);
  expect(locks.heldCount(MAINT("existing-db"))).toBe(1);
  expect(locks.heldCount(WRITER("existing-db"))).toBe(1);

  await storage.close();
  expect(locks.heldCount(WRITER("existing-db"))).toBe(0);
  expect(locks.heldCount(MAINT("existing-db"))).toBe(0);
});

test("createIfMissing: false waits for exclusive maintenance deletion and never recreates the deleted DB", async () => {
  const locks = new FakeLockManager();
  const idb = createFakeIndexedDB(undefined, {
    "raced-db": {
      version: 1,
      stores: ["metadata", "journal", "data"],
      metadata: new Map<unknown, unknown>([["epoch", 1]]),
    },
  });

  const exclusive = await maintenanceLock(locks, "raced-db", "exclusive");
  expect(exclusive).not.toBe("busy");
  if (exclusive === "busy") throw new Error("unexpected busy");

  const waiting = Promise.withResolvers<void>();
  const pendingOpen = IndexedDBStorage.open("raced-db", {
    indexedDB: idb.factory,
    locks,
    createIfMissing: false,
    onWaiting: () => waiting.resolve(),
  });
  await waiting.promise;
  expect(idb.events).toEqual([]);

  idb.databases.delete("raced-db");
  await exclusive.release();

  await expect(pendingOpen).rejects.toBeInstanceOf(IndexedDBStorageMissingError);
  expect(idb.events).toEqual(["upgradeneeded:raced-db", "upgrade-aborted:raced-db"]);
  expect(idb.databases.has("raced-db")).toBe(false);
  expect(locks.heldCount(MAINT("raced-db"))).toBe(0);
});

test("createIfMissing: false preserves VersionError, schema mismatch, and busy-lock errors on existing DBs", async () => {
  const locks = new FakeLockManager();
  const idb = createFakeIndexedDB(undefined, {
    "future-version": { version: 2, stores: ["metadata", "journal", "data"], metadata: new Map() },
    "wrong-schema": { version: 1, stores: ["other"], metadata: new Map() },
    "busy-db": {
      version: 1,
      stores: ["metadata", "journal", "data"],
      metadata: new Map<unknown, unknown>([["epoch", 1]]),
    },
  });

  await expect(
    IndexedDBStorage.open("future-version", {
      indexedDB: idb.factory,
      locks,
      createIfMissing: false,
    }),
  ).rejects.toBeInstanceOf(VfsError);

  await expect(
    IndexedDBStorage.open("wrong-schema", {
      indexedDB: idb.factory,
      locks,
      createIfMissing: false,
    }),
  ).rejects.toBeInstanceOf(VfsError);

  const writer = await IndexedDBStorage.open("busy-db", {
    indexedDB: idb.factory,
    locks,
    createIfMissing: false,
  });
  try {
    await expect(
      IndexedDBStorage.open("busy-db", {
        indexedDB: idb.factory,
        locks,
        createIfMissing: false,
        whenBusy: "ifAvailable",
      }),
    ).rejects.toBeInstanceOf(IndexedDBStorageBusyError);
  } finally {
    await writer.close();
  }
});
