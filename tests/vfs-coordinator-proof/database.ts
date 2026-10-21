import { MemFS } from "../../fs/memory.js";
import type { Arm, State } from "./protocol.js";

const opening = new Set<IDBOpenDBRequest>();
function abortTransaction(tx: IDBTransaction): void {
  try { tx.abort(); }
  catch (error) {
    if (error instanceof DOMException && error.name === "InvalidStateError") return;
    throw error;
  }
}
function finishOpen(request: IDBOpenDBRequest, signal: AbortSignal | undefined, resolve: (db: IDBDatabase) => void): void {
  if (signal?.aborted) { request.result.close(); return; }
  resolve(request.result);
}
export function openDatabase(workspace: string, signal?: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (opening.size >= 64) throw new Error("BACKPRESSURE: pending database opens");
    const request = indexedDB.open(workspace, 1);
    opening.add(request);
    const aborted = () => reject(signal?.reason);
    const cleanup = () => { signal?.removeEventListener("abort", aborted); opening.delete(request); };
    signal?.addEventListener("abort", aborted, { once: true });
    request.onupgradeneeded = () => {
      if (signal?.aborted) request.transaction?.abort();
      else request.result.createObjectStore("workspace");
    };
    request.onerror = () => { cleanup(); reject(request.error); };
    request.onsuccess = () => {
      cleanup();
      finishOpen(request, signal, resolve);
    };
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
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const tx = db.transaction("workspace", "readwrite", { durability });
    const store = tx.objectStore("workspace");
    let result: T, problem: unknown;
    if (tx.durability !== durability) {
      tx.abort();
      reject(new Error("UNSUPPORTED: durability"));
      return;
    }
    const aborted = () => abortTransaction(tx);
    const cleanup = () => signal?.removeEventListener("abort", aborted);
    signal?.addEventListener("abort", aborted, { once: true });
    tx.oncomplete = () => { cleanup(); resolve(result); };
    tx.onabort = () => { cleanup(); reject(problem ?? signal?.reason ?? tx.error ?? new Error("ABORT")); };
    const get = store.get("head");
    const success = (value: T) => {
      result = value;
    };
    const failed = (error: unknown) => {
      problem = error;
    };
    get.onsuccess = () => {
      if (signal?.aborted) return aborted();
      applyUpdate(store, tx, get.result, update, success, failed);
    };
  });
}
export async function readRegistry(workspace: string, signal?: AbortSignal): Promise<State | undefined> {
  const db = await openDatabase(workspace, signal);
  try {
    return await transaction(db, "relaxed", (state) => ({ result: state }), signal);
  } finally {
    db.close();
  }
}
