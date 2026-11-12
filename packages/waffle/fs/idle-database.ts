import { INDEXEDDB_FORMAT } from "./vfs-format.js";
import { IndexedDBStorage } from "./indexeddb.js";
import { maintenanceLock } from "./storage-maintenance.js";
import { VfsError } from "./vfs.js";

function databaseRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** An aborted upgrade rolls back the creation if the name disappeared after enumeration. */
export function existingDatabase(
  name: string,
  signal?: AbortSignal,
  retainDebt?: (completion: Promise<void>) => void,
): Promise<IDBDatabase | undefined> {
  signal?.throwIfAborted();
  const completion = Promise.withResolvers<void>();
  void completion.promise.catch(() => {});
  retainDebt?.(completion.promise);
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name);
    } catch (error) {
      completion.resolve();
      reject(error);
      return;
    }
    let missing = false;
    const abort = () => reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction?.abort();
    };
    request.onerror = () => {
      completion.resolve();
      signal?.removeEventListener("abort", abort);
      if (missing) resolve(undefined);
      else reject(request.error);
    };
    request.onsuccess = () => {
      signal?.removeEventListener("abort", abort);
      const database = request.result;
      if (signal?.aborted) {
        try {
          database.close();
          completion.resolve();
          reject(signal.reason);
        } catch (error) {
          completion.reject(error);
          reject(error);
        }
        return;
      }
      completion.resolve();
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export async function isWorkspace(database: IDBDatabase): Promise<boolean> {
  if (!database.objectStoreNames.contains("metadata")) return false;
  const metadata = database.transaction("metadata", "readonly").objectStore("metadata");
  const [format, epoch, keys] = await Promise.all([
    databaseRequest<unknown>(metadata.get("format")),
    databaseRequest<unknown>(metadata.get("epoch")),
    databaseRequest(metadata.getAllKeys()),
  ]);
  if (
    format === INDEXEDDB_FORMAT ||
    (typeof format === "string" && format.startsWith("waffle-indexeddb-"))
  )
    return true;
  if (database.version !== 1 || database.objectStoreNames.length !== 3) return false;
  if (!["journal", "data"].every((name) => database.objectStoreNames.contains(name))) return false;
  return (
    typeof epoch === "number" &&
    Number.isSafeInteger(epoch) &&
    epoch > 0 &&
    keys.some((key) => key === 0 || key === 1) &&
    keys.every(
      (key) =>
        key === 0 ||
        key === 1 ||
        key === "epoch" ||
        key === "active" ||
        key === "identity" ||
        key === "format",
    )
  );
}

export async function storedNames(): Promise<string[]> {
  const names: string[] = [];
  for (const { name } of await indexedDB.databases()) {
    if (name === undefined) continue;
    const maintenance = await maintenanceLock(navigator.locks, name, "shared");
    if (maintenance === "busy") continue;
    let database: IDBDatabase | undefined;
    let storage: IndexedDBStorage | undefined;
    try {
      database = await existingDatabase(name);
      if (!database || !(await isWorkspace(database))) continue;
      const connection = IndexedDBStorage.readOnlyConnection(database, () => Promise.resolve());
      storage = connection.storage;
      await storage.load();
      names.push(name);
    } catch (error) {
      if (!(error instanceof VfsError)) throw error;
    } finally {
      await storage?.close();
      database?.close();
      await maintenance.release();
    }
  }
  return names;
}
