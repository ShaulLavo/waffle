import { openIdleWorkspace, type IdleWorkspace } from "../index.js";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import { assert, batch } from "./storage-browser-helpers.js";

export async function idle(name: string): Promise<IdleWorkspace> {
  const owner = await openIdleWorkspace({ mode: "fast", name });
  assert(typeof owner !== "string", `Expected idle workspace, got ${owner}`);
  return owner;
}

export function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

export async function seed(name: string): Promise<void> {
  const storage = await IndexedDBStorage.open(name);
  try {
    await storage.persist(batch(1, "saved source"));
  } finally {
    await storage.close();
  }
}
