import { IndexedDBStorage } from "../fs/indexeddb.js";
import {
  type FaultScheduler,
  type FaultSchedule,
  runFaultSchedules,
  withCellCleanup,
} from "./storage-crash-r2-scheduler.js";
import {
  checkReopen,
  closeCells,
  modeDelta,
  equal,
  invariant,
  opened,
  recoveredState,
  replaceAndRename,
  seedChange,
} from "./storage-crash-r2-state.js";

function target(store: string, key: IDBValidKey | IDBKeyRange | undefined): string {
  if (store === "data" && Array.isArray(key)) return `chunk:${String(key[1])}`;
  if (store === "data" && typeof key === "string") return "manifest";
  if (store === "metadata" && typeof key === "number") return "base";
  if (store === "journal") return "journal";
  return String(key);
}
interface TransactionObservation {
  stores: string[];
  durability: IDBTransactionDurability;
  state: "pending" | "aborted" | "completed";
  injected: boolean;
  error: DOMException | null;
}
function instrument(scheduler: FaultScheduler) {
  const transaction = IDBDatabase.prototype.transaction;
  const transactions: TransactionObservation[] = [];
  const records = new Map<IDBTransaction, TransactionObservation>();
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    const tx = transaction.call(this, stores, mode, options);
    if (mode !== "readwrite") return tx;
    const record: TransactionObservation = {
      stores: Array.from(tx.objectStoreNames),
      durability: tx.durability,
      state: "pending",
      injected: false,
      error: null,
    };
    transactions.push(record);
    records.set(tx, record);
    tx.addEventListener(
      "abort",
      () => {
        record.state = "aborted";
        record.error = tx.error;
      },
      { once: true },
    );
    tx.addEventListener(
      "complete",
      () => {
        record.state = "completed";
      },
      { once: true },
    );
    return tx;
  };
  const put = IDBObjectStore.prototype.put;
  const remove = IDBObjectStore.prototype.delete;
  function observe(
    store: IDBObjectStore,
    request: IDBRequest,
    operation: string,
    key?: IDBValidKey | IDBKeyRange,
  ) {
    request.addEventListener("success", () => abortSelected(store, operation, key), { once: true });
  }
  function abortSelected(
    store: IDBObjectStore,
    operation: string,
    key?: IDBValidKey | IDBKeyRange,
  ) {
    const destination = `${store.name}/${target(store.name, key)}`;
    if (
      !scheduler.visit({
        adapter: "indexeddb",
        operation,
        target: destination,
        resource: `${store.name}/${JSON.stringify(key)}`,
      })
    )
      return;
    const record = records.get(store.transaction);
    invariant(record, "injection belongs to an observed native transaction");
    record.injected = true;
    store.transaction.abort();
  }
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    const request = put.call(this, value, key);
    observe(this, request, "put-success", key);
    return request;
  };
  IDBObjectStore.prototype.delete = function (key: IDBValidKey | IDBKeyRange) {
    const request = remove.call(this, key);
    observe(this, request, "delete-success", key);
    return request;
  };
  return {
    transactions,
    restore() {
      IDBDatabase.prototype.transaction = transaction;
      IDBObjectStore.prototype.put = put;
      IDBObjectStore.prototype.delete = remove;
    },
  };
}
function nativeRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.addEventListener("blocked", () => reject(new Error("Owned database deletion blocked")));
  });
}
async function physicalKeys(databaseName: string) {
  const db = await nativeRequest(indexedDB.open(databaseName));
  try {
    return await nativeRequest(db.transaction("data").objectStore("data").getAllKeys());
  } finally {
    db.close();
  }
}
interface Cell {
  id: string;
  checkpoints: number;
  schedule: FaultSchedule | null;
  kind: "flush" | "drop-memory";
}
function fault(
  id: string,
  destination: string,
  checkpoints: number,
  operation = "put-success",
): Cell {
  return {
    id,
    checkpoints,
    kind: "flush",
    schedule: { id, occurrence: 1, at: { adapter: "indexeddb", operation, target: destination } },
  };
}
const cells: Cell[] = [
  fault("journal-first-chunk", "data/chunk:0", 1),
  fault("journal-middle-chunk", "data/chunk:1", 1),
  fault("journal-final-chunk", "data/chunk:2", 1),
  fault("journal-manifest", "data/manifest", 1),
  fault("journal-publish", "journal/journal", 1),
  fault("journal-active", "metadata/active", 1),
  fault("base-publish", "metadata/base", 2),
  fault("base-active", "metadata/active", 2),
  fault("rotation-base", "metadata/base", 4),
  fault("rotation-journal-delete", "journal/journal", 4, "delete-success"),
  fault("rotation-payload-delete", "data/manifest", 4, "delete-success"),
  { id: "journal-control", checkpoints: 1, schedule: null, kind: "flush" },
  { id: "base-control", checkpoints: 2, schedule: null, kind: "flush" },
  { id: "rotation-control", checkpoints: 4, schedule: null, kind: "flush" },
  { id: "fast-memory-ack-without-flush", checkpoints: 1, schedule: null, kind: "drop-memory" },
];
async function runCell(cell: Cell, scheduler: FaultScheduler) {
  const databaseName = `waffle-storage-crash-r2-${crypto.randomUUID()}`;
  const owners: IndexedDBStorage[] = [];
  const backends: Awaited<ReturnType<typeof opened>>[] = [];
  const open = async () => {
    const storage = await IndexedDBStorage.open(databaseName, { compactEvery: 2 });
    owners.push(storage);
    const backend = await opened(storage);
    backends.push(backend);
    return { storage, backend };
  };
  return withCellCleanup(
    async () => {
      const first = await open();
      for (let generation = 1; generation <= cell.checkpoints; generation++) {
        seedChange(first.backend, generation);
        await first.backend.flush();
      }
      const before = await recoveredState(first.backend);
      const keysBefore = await physicalKeys(databaseName);
      const oldGeneration = (await first.storage.load())?.generation;
      replaceAndRename(first.backend);
      const after = await recoveredState(first.backend);
      const changedMode = modeDelta(before, after);
      const ids = before.metadata
        .concat(after.metadata)
        .flatMap((entry) => (entry.id ? [entry.id] : []));
      const observation = instrument(scheduler);
      let failure: unknown;
      try {
        if (cell.kind === "flush") await first.backend.flush();
      } catch (error) {
        failure = error;
      } finally {
        observation.restore();
      }
      scheduler.assertReached();
      invariant(
        observation.transactions.length === (cell.kind === "flush" ? 1 : 0),
        "exactly one publishing transaction, none for memory-only ACK",
      );
      invariant(
        observation.transactions.every(
          (tx) =>
            tx.durability === "strict" &&
            tx.stores.includes("data") &&
            tx.stores.includes("metadata") &&
            tx.stores.includes("journal"),
        ),
        "publication uses the actual strict cross-store transaction",
      );
      if (cell.schedule) assertInjectedAbort(observation.transactions, failure);
      else equal(failure, undefined, "normal control flush fulfills");
      first.backend.dispose();
      await first.storage.close();
      const second = await open();
      const old = cell.schedule !== null || cell.kind === "drop-memory";
      const expected = old ? before : after;
      const firstReopen = await checkReopen(second.backend, expected, ids);
      const recoveredGeneration = (await second.storage.load())?.generation;
      equal(
        recoveredGeneration,
        old ? oldGeneration : (oldGeneration ?? 0) + 1,
        "recovered generation matches publication outcome",
      );
      if (old)
        equal(
          await physicalKeys(databaseName),
          keysBefore,
          "old outcome preserves exact data-store manifest and chunk keys",
        );
      second.backend.dispose();
      await second.storage.close();
      const third = await open();
      const secondReopen = await checkReopen(third.backend, expected, ids);
      invariant(
        firstReopen.freshId !== secondReopen.freshId,
        "an abandoned allocation from the first reopen is never reused",
      );
      return {
        id: cell.id,
        ok: true,
        schedule: cell.schedule,
        events: scheduler.events,
        transactions: observation.transactions,
        oldGeneration,
        recoveredGeneration,
        changedMode,
        firstReopen,
        secondReopen,
        outcome: old ? "old-complete" : "new-complete",
        ack: "FAST memory ACK precedes tested explicit flush",
        model:
          "native IDB transaction abort after successful request; no browser kill or power loss",
        invariants: [
          "namespace",
          "mode",
          "bytes",
          "FileId",
          "revision",
          "no-reuse",
          "generation",
          "checked-mutations",
          "target-mode-delta-600-to-400",
          "second-reopen",
        ].concat(
          old ? ["exact-old-data-store-keys"] : [],
          cell.schedule ? ["injected-native-transaction-aborted"] : [],
        ),
      };
    },
    () => closeCells(backends, owners, () => nativeRequest(indexedDB.deleteDatabase(databaseName))),
  );
}
function assertInjectedAbort(
  transactions: readonly TransactionObservation[],
  failure: unknown,
): void {
  const injected = transactions.filter((tx) => tx.injected);
  equal(injected.length, 1, "exactly the selected native transaction received abort");
  const tx = injected[0];
  invariant(tx?.state === "aborted", "selected native transaction emitted abort, not completion");
  invariant(failure instanceof Error, "injected native abort rejects the flush");
  invariant(
    failure === tx.error ||
      (tx.error === null && failure.message === "Filesystem transaction aborted"),
    "flush rejection is the selected native abort cause or adapter fallback",
  );
}
/** @browserEntry */
export async function indexedDBCrashMatrix() {
  return runFaultSchedules(cells, runCell);
}
