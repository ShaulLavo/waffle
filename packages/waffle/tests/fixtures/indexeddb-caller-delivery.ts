import type { StorageLockManager } from "../../fs/storage-maintenance.js";

interface Delivery<T> {
  result: T;
  onsuccess?: () => void;
}
function delivered<T>(result: T): Delivery<T> {
  const request: Delivery<T> = { result };
  queueMicrotask(() => request.onsuccess?.());
  return request;
}
function transactionDelivery() {
  const transaction: { oncomplete?: () => void; objectStore: () => typeof store } = {
    objectStore: () => store,
  };
  const store = {
    get: () => delivered(1),
    put: () => queueMicrotask(() => transaction.oncomplete?.()),
  };
  return transaction;
}

/** Only the native API delivery is modeled; storage, recovery and leases execute normally. */
export function indexeddbCallerDelivery(
  options: {
    queryFailure?: { value: unknown };
    recoveryFailure?: { value: unknown };
  } = {},
) {
  const events: string[] = [];
  const loss = Promise.withResolvers<never>();
  void loss.promise.catch(() => {});
  const querySeen = Promise.withResolvers<void>();
  let queries = 0;
  let transactions = 0;
  const transaction = transactionDelivery();
  const database: {
    version: number;
    objectStoreNames: { length: number; contains: (name: string) => boolean };
    onversionchange?: () => void;
    transaction: () => typeof transaction;
    close: () => void;
  } = {
    version: 1,
    objectStoreNames: {
      length: 3,
      contains: (name) => ["metadata", "journal", "data"].includes(name),
    },
    transaction() {
      if (transactions++ > 0 && options.recoveryFailure) throw options.recoveryFailure.value;
      return transaction;
    },
    close: () => {
      events.push("database-close");
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open: () => delivered(database) },
  });
  const locks: StorageLockManager = {
    async query() {
      events.push("query");
      queries++;
      querySeen.resolve();
      if (options.queryFailure) throw options.queryFailure.value;
      return undefined;
    },
    request(name, _options, callback) {
      const result = Promise.resolve()
        .then(() => callback({}))
        .then((value) => {
          events.push(
            name.includes("maintenance") ? "maintenance-request-done" : "writer-request-done",
          );
          return value;
        });
      return name.includes("maintenance") ? result : Promise.race([result, loss.promise]);
    },
  };
  return {
    locks,
    database,
    events,
    loss,
    querySeen,
    get queries() {
      return queries;
    },
    restore() {
      if (original) Object.defineProperty(globalThis, "indexedDB", original);
      else Reflect.deleteProperty(globalThis, "indexedDB");
    },
  };
}
