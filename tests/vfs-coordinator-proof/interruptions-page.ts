import { blockedOpen, committedClaim, uncommittedClaim } from "./interruptions-database.js";
import { ProofClient } from "./client.js";
import { openDatabase } from "./database.js";
import type { Reply } from "./protocol.js";
const client = new ProofClient();
let running: Promise<Reply> | undefined;
let outcome: Reply | undefined;
let release: (() => void) | undefined;
let successorWorker: SharedWorker | undefined;
const connections = new Set<IDBDatabase>();
let openRequests = 0;
const originalOpen = indexedDB.open.bind(indexedDB);
indexedDB.open = (name: string, version?: number) => {
  openRequests++;
  const request = originalOpen(name, version);
  request.addEventListener("success", () => connections.add(request.result));
  return request;
};
const originalClose = IDBDatabase.prototype.close;
IDBDatabase.prototype.close = function () {
  connections.delete(this);
  originalClose.call(this);
};
function start(work: Promise<Reply>): void {
  outcome = undefined;
  running = work.then((reply) => {
    outcome = reply;
    return reply;
  });
}
async function holdBootstrap(workspace: string): Promise<void> {
  const ready = Promise.withResolvers<void>();
  void navigator.locks.request(
    `e5-bootstrap:${workspace}`,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        ready.resolve();
      }),
  );
  await ready.promise;
}
function keepAlive(store: IDBObjectStore, held: () => boolean): void {
  const request = store.get("head");
  request.onsuccess = () => {
    if (held()) keepAlive(store, held);
  };
}
async function holdRegistry(workspace: string): Promise<void> {
  const db = await openDatabase(workspace);
  const tx = db.transaction("workspace", "readwrite");
  let held = true;
  const complete = new Promise<void>((resolve) => {
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
  });
  release = () => {
    held = false;
  };
  const store = tx.objectStore("workspace");
  await new Promise<void>((resolve) => {
    const first = store.get("head");
    first.onsuccess = () => {
      keepAlive(store, () => held);
      resolve();
    };
  });
  void complete;
}
function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry instanceof Map) return { map: Array.from(entry) };
    if (entry instanceof Uint8Array) return { bytes: Array.from(entry) };
    return entry;
  });
}
async function snapshot(): Promise<string> {
  const inspection = await client.send({ kind: "inspect" });
  if (inspection.kind !== "ok" || !inspection.result || typeof inspection.result !== "object")
    throw new Error("Invalid inspection");
  const detail = inspection.result;
  if (!("state" in detail)) throw new Error("Missing inspected state");
  return serialized({
    authority: client.authority,
    cursor: client.cursor,
    state: detail.state,
    connection: client.attachment(),
  });
}
const interruptions = {
  blockedOpen,
  committedClaim,
  uncommittedClaim,
  client,
  holdBootstrap,
  holdRegistry,
  startConnect: (workspace: string) => start(client.connect(workspace, "volatile-fast")),
  startRecover: () => start(client.recover()),
  result: () => outcome,
  joined: () => running,
  release: () => {
    release?.();
    release = undefined;
  },
  requestedOpens: () => openRequests,
  resources: () => ({ databases: connections.size, worker: Boolean(client.worker) }),
  snapshot,
  retainWorker: () => {
    successorWorker = client.worker;
  },
  sameWorker: () => successorWorker === client.worker,
};
type InterruptionPage = typeof interruptions;
declare global {
  var interruptions: InterruptionPage;
}
globalThis.interruptions = interruptions;
