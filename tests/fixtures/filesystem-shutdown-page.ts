import { FilesystemClient } from "../../fs/client.js";
import { IndexedDBStorage } from "../../fs/indexeddb.js";
import { PersistentBackend } from "../../fs/persistent.js";
import { createFilesystemConnection } from "../../fs/protocol.js";
import {
  before,
  isRecord,
  observe,
  parseOutcome,
  parseSnapshot,
  requireValue,
  type Outcome,
  type ReopenResults,
  type ShutdownPage,
  type ShutdownSpec,
  type Stage,
} from "../filesystem-shutdown-browser.js";

let spec: ShutdownSpec | undefined;
let target: Worker | undefined;
let client: FilesystemClient | undefined;
let control: MessagePort | undefined;
let otherControl: MessagePort | undefined;
let nextControl = 0;
const requests = new Map<number, (result: Outcome<unknown>) => void>();
const ready = Promise.withResolvers<void>();
const entered = Promise.withResolvers<void>();
const ack = Promise.withResolvers<void>();
void observe(ready.promise);
void observe(entered.promise);
const ackOutcome = observe(ack.promise);
let ackState: Stage<void> = { kind: "pending" };
void ackOutcome.then((result) => {
  ackState = result;
});
let requestOutcome: Promise<Outcome<unknown>> | undefined;
let reopenedStorage: IndexedDBStorage | undefined;
let reopenedBackend: PersistentBackend | undefined;
let storageCreation: Promise<IndexedDBStorage> | undefined;
let backendCreation: Promise<PersistentBackend> | undefined;
const openingDebts: Promise<void>[] = [];

function receiveControl(event: MessageEvent<unknown>): void {
  const message = event.data;
  if (!isRecord(message)) throw new Error("Invalid fixture-only response");
  if (message.event === "gate-entered") {
    entered.resolve();
    return;
  }
  if (typeof message.id !== "number") throw new Error("Missing fixture-only response id");
  const resolve = requests.get(message.id);
  if (!resolve) throw new Error("Unowned fixture-only response");
  requests.delete(message.id);
  resolve(parseOutcome(message.outcome));
}
function controlCall(action: string): Promise<Outcome<unknown>> {
  const id = ++nextControl;
  return new Promise((resolve, reject) => {
    requests.set(id, resolve);
    if (!control) {
      requests.delete(id);
      reject(new Error("Missing original fixture control port"));
      return;
    }
    control.postMessage({ id, action });
  });
}
function receiveService(event: MessageEvent<unknown>): void {
  const message = event.data;
  if (!isRecord(message)) throw new Error("Invalid original service response");
  if (message.type === "filesystem-state" && message.status === "ready") ready.resolve();
  if (message.type === "filesystem-error") {
    ready.reject(message.message);
    entered.reject(message.message);
    return;
  }
  if (message.type !== "filesystem-disposed") return;
  if (Object.hasOwn(message, "error")) ack.reject(message.error);
  else ack.resolve();
}
function workerError(event: ErrorEvent): void {
  const failure = new Error(event.message || "Original worker observer failed");
  ready.reject(failure);
  entered.reject(failure);
  ack.reject(failure);
}
async function start(next: ShutdownSpec, deadline: number): Promise<void> {
  if (target) throw new Error("Fixture already owns an original Worker");
  spec = next;
  const channel = new MessageChannel();
  control = channel.port1;
  otherControl = channel.port2;
  control.onmessage = receiveControl;
  control.start();
  target = new Worker(`/filesystem-shutdown-worker.js?nonce=${next.nonce}`, { type: "module" });
  target.onmessage = receiveService;
  target.onerror = workerError;
  target.onmessageerror = () =>
    workerError(new ErrorEvent("error", { message: "Worker message decode failed" }));
  target.postMessage({ fixture: "configure", ...next, port: otherControl }, [otherControl]);
  const connection = createFilesystemConnection();
  client = new FilesystemClient(connection.client);
  target.postMessage({ connect: connection.server }, [connection.server.port]);
  requireValue(await before(deadline, "ready", () => ready.promise), "ready");
  const originalClient = client;
  requireValue(
    await before(deadline, "write dirty marker", () =>
      originalClient.asyncCall("writeFile", ["/marker"], new TextEncoder().encode(next.marker)),
    ),
    "write dirty marker",
  );
  if (Date.now() >= deadline) throw new Error("Original preparation deadline exhausted");
  requestOutcome = observe(client.asyncCall("listFiles", ["/"]));
  requireValue(
    await before(deadline, "original preparation gate", () => entered.promise),
    "original preparation gate",
  );
  target.postMessage({ dispose: true });
}
async function lockAvailable(): Promise<boolean> {
  if (!spec) throw new Error("Missing original database identity");
  return navigator.locks.request(
    `bun-wasm:filesystem:indexeddb:${spec.database}`,
    { mode: "exclusive", ifAvailable: true },
    (lock) => lock !== null,
  );
}
async function workerSnapshot() {
  return parseSnapshot(requireValue(await controlCall("snapshot"), "original snapshot"));
}
async function cleanupReopenedBackend(): Promise<void> {
  const backend = backendCreation ? await backendCreation.catch(() => undefined) : reopenedBackend;
  await backend?.close();
  reopenedBackend = undefined;
}
async function cleanupReopenedStorage(): Promise<void> {
  const storage = storageCreation ? await storageCreation.catch(() => undefined) : reopenedStorage;
  await storage?.close();
  await Promise.all(openingDebts);
  reopenedStorage = undefined;
}
async function readMarker(): Promise<string> {
  if (!reopenedBackend) throw new Error("Missing real reopened backend");
  await reopenedBackend.prepare("readFile", ["/marker"]);
  const bytes: unknown = reopenedBackend.execute("readFile", ["/marker"], new Uint8Array());
  if (!(bytes instanceof Uint8Array)) throw new Error("Real reopened marker is not bytes");
  return new TextDecoder().decode(bytes);
}
async function openReopened(deadline: number): Promise<void> {
  if (!spec) throw new Error("Missing original database identity");
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error("Reopen deadline expired")),
    Math.max(0, deadline - Date.now()),
  );
  try {
    storageCreation = IndexedDBStorage.open(spec.database, {
      whenBusy: "wait",
      signal: abort.signal,
      retainOpeningDebt: (debt) => {
        openingDebts.push(debt);
        void observe(debt);
      },
    });
    void observe(storageCreation);
    reopenedStorage = await storageCreation;
    if (Date.now() >= deadline) throw new Error("Reopen deadline exhausted");
    backendCreation = PersistentBackend.open(reopenedStorage, { intervalMs: 0 });
    void observe(backendCreation);
    reopenedBackend = await backendCreation;
  } finally {
    clearTimeout(timer);
  }
}
async function reopen(deadline: number): Promise<ReopenResults> {
  const open = await before(deadline, "reopen", () => openReopened(deadline));
  const read = await before(deadline, "read marker", readMarker);
  const close = await before(deadline, "reopened backend close", cleanupReopenedBackend);
  const rawCleanup = await before(deadline, "reopened raw cleanup", cleanupReopenedStorage);
  return { open, readMarker: read, close, rawCleanup };
}
async function closeClient(): Promise<Outcome<void>[]> {
  const actions = [() => client?.dispose(), () => control?.close(), () => otherControl?.close()];
  const results: Outcome<void>[] = [];
  for (const action of actions) results.push(await observe(Promise.resolve().then(action)));
  return results;
}
async function deleteDatabase(): Promise<void> {
  if (!spec) throw new Error("Missing owned database identity");
  await new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(spec.database);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error);
    deletion.onblocked = () => reject(new Error("Owned database deletion blocked"));
  });
}
const fixture: ShutdownPage = {
  start,
  lockAvailable,
  async release() {
    requireValue(await controlCall("release"), "original gate release");
  },
  originalRequest: () =>
    requestOutcome ?? Promise.resolve({ kind: "invalid", cause: "Original request absent" }),
  serviceAck: () => ackOutcome,
  snapshot: workerSnapshot,
  ackState: () => ackState,
  reopen,
  cleanupOriginalStorage: () => controlCall("cleanup-storage"),
  cleanupReopenedBackend,
  cleanupReopenedStorage,
  terminate() {
    if (!target) throw new Error("Missing original Worker for termination");
    target.terminate();
  },
  closeClient,
  deleteDatabase,
};
window.filesystemShutdownFixture = fixture;
