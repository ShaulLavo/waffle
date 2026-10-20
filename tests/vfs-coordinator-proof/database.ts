import { MemFS } from "../../fs/memory.js";
import type { Arm, State } from "./protocol.js";

export function openDatabase(workspace: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(workspace, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
export function initial(arm: Arm): State {
  return {
    format: "waffle-e5-proof-only",
    arm,
    epoch: 0,
    token: "",
    closed: true,
    history: crypto.randomUUID(),
    generation: 0,
    watermark: 0,
    durableWatermark: 0,
    root: new MemFS().root,
    versions: new Map(),
    receipts: new Map(),
    changes: [],
  };
}
type Update<T> = (value: State | undefined) => { state?: State; result: T };
function applyUpdate<T>(
  store: IDBObjectStore,
  tx: IDBTransaction,
  value: State | undefined,
  update: Update<T>,
  success: (value: T) => void,
  failed: (error: unknown) => void,
): void {
  try {
    const next = update(value);
    success(next.result);
    if (next.state) store.put(next.state, "head");
  } catch (error) {
    failed(error);
    tx.abort();
  }
}
export function transaction<T>(
  db: IDBDatabase,
  durability: IDBTransactionDurability,
  update: Update<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("workspace", "readwrite", { durability });
    const store = tx.objectStore("workspace");
    let result: T, problem: unknown;
    if (tx.durability !== durability) {
      tx.abort();
      reject(new Error("UNSUPPORTED: durability"));
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(problem ?? tx.error ?? new Error("ABORT"));
    const get = store.get("head");
    const success = (value: T) => {
      result = value;
    };
    const failed = (error: unknown) => {
      problem = error;
    };
    get.onsuccess = () => applyUpdate(store, tx, get.result, update, success, failed);
  });
}
export async function readRegistry(workspace: string): Promise<State | undefined> {
  const db = await openDatabase(workspace);
  try {
    return await transaction(db, "relaxed", (state) => ({ result: state }));
  } finally {
    db.close();
  }
}
