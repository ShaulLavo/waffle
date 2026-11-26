import { openIdleWorkspace } from "../index.js";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import type { PersistedNode, PersistenceBatch } from "../fs/storage.js";
import { assert, type StorageContractCase } from "./storage-browser-helpers.js";
import { storedTimes } from "./fixtures/file-times.js";

function files(): PersistenceBatch {
  return {
    generation: 1,
    root: 1,
    removes: [],
    upserts: Array.of<PersistedNode>({
      ino: 1,
      kind: "dir",
      size: 0,
      ...storedTimes(1),
      children: Array.from({ length: 4 }, (_, index) => [`file${index}`, index + 2]),
    }).concat(
      Array.from({ length: 4 }, (_, index): PersistedNode => ({
        ino: index + 2,
        kind: "file",
        size: 1,
        ...storedTimes(1),
        data: `payload${index}`,
      })),
    ),
    data: new Map(
      Array.from({ length: 4 }, (_, index) => [`payload${index}`, new Uint8Array([index])]),
    ),
  };
}

async function cancelledLoad(name: string, phase: "metadata" | "manifest"): Promise<void> {
  const writer = await IndexedDBStorage.open(name);
  try {
    await writer.persist(files());
  } finally {
    await writer.close();
  }
  const controller = new AbortController();
  const reason = new Error(`cancel idle ${phase} validation`);
  const nativeGet = IDBObjectStore.prototype.get;
  const nativeGetAll = IDBObjectStore.prototype.getAll;
  const nativeClose = IDBDatabase.prototype.close;
  const nativeOpen = IDBFactory.prototype.open;
  let settled = false,
    closed = false,
    prematureClose = false,
    prematureOpen = false;
  let manifestsAfterAbort = 0;
  let successor: Promise<IndexedDBStorage> | undefined;
  const unhandled: unknown[] = [];
  const observeRejection = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", observeRejection);
  /** Cancels once, right after the selected native request was placed. */
  const cancelAfter = (store: IDBObjectStore, selected: boolean) => {
    if (!selected || controller.signal.aborted) return;
    const aborted = store.transaction.onabort;
    const completed = store.transaction.oncomplete;
    store.transaction.onabort = function (event) {
      settled = true;
      aborted?.call(this, event);
    };
    store.transaction.oncomplete = function (event) {
      settled = true;
      completed?.call(this, event);
    };
    successor = IndexedDBStorage.open(name);
    controller.abort(reason);
  };
  IDBObjectStore.prototype.get = function (key) {
    if (this.name === "data" && typeof key === "string" && controller.signal.aborted)
      manifestsAfterAbort++;
    const result = nativeGet.call(this, key);
    cancelAfter(this, phase === "metadata" && this.name === "metadata" && key === 0);
    return result;
  };
  // Manifests are validated from one bulk read of the data store's string keys.
  IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) {
    if (this.name === "data" && controller.signal.aborted) manifestsAfterAbort++;
    const result = nativeGetAll.apply(this, args);
    cancelAfter(this, phase === "manifest" && this.name === "data");
    return result;
  };
  IDBDatabase.prototype.close = function () {
    if (this.name === name && controller.signal.aborted) {
      prematureClose ||= !settled;
      closed = true;
    }
    nativeClose.call(this);
  };
  IDBFactory.prototype.open = function (...args) {
    if (args[0] === name && controller.signal.aborted) prematureOpen ||= !settled || !closed;
    return nativeOpen.apply(this, args);
  };
  try {
    const outcome = await openIdleWorkspace(
      { mode: "fast", name },
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    if (
      outcome &&
      typeof outcome === "object" &&
      "close" in outcome &&
      typeof outcome.close === "function"
    )
      await outcome.close();
    assert(outcome === reason, "original cancellation reason returned");
    assert(manifestsAfterAbort === 0, "no later manifest transactions admitted after cancellation");
    const next = await successor;
    assert(next, "ordinary successor attempted during cancellation");
    await next.close();
    assert(
      settled && closed && !prematureClose,
      `native transaction settled before connection close: ${JSON.stringify({ settled, closed, prematureClose })}`,
    );
    assert(!prematureOpen, "maintenance held until native completion and connection close");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(unhandled.length === 0, "cancelled native requests have rejection observers");
  } finally {
    IDBObjectStore.prototype.get = nativeGet;
    IDBObjectStore.prototype.getAll = nativeGetAll;
    IDBDatabase.prototype.close = nativeClose;
    IDBFactory.prototype.open = nativeOpen;
    globalThis.removeEventListener("unhandledrejection", observeRejection);
    await (await successor)?.close();
  }
}

export function idleCancellationCases(): StorageContractCase[] {
  return Array.from(["metadata", "manifest"] as const, (phase) => ({
    label: `idle workspace cancelled ${phase} validation stops native reads before release`,
    run: (name) => cancelledLoad(name, phase),
  }));
}
