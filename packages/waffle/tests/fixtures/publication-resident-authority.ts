import { hostFilesystemClient } from "./filesystem-host.js";
import { residentMemory } from "./resident-memory";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../../fs";
import { publicationObserver, type PublicationLimits } from "../../fs/publication-internal";
import { publicationCut } from "../../fs/publication";
import {
  serveResidentAuthority,
  type ResidentAuthorityServer,
} from "../../browser/publication-authority";
import { record, text } from "../../fs/publication-attachment";

import { IndexedDBStorage } from "../../fs/indexeddb";
import type { RuntimeStartupStage } from "../../fs/startup";
import {
  createPersistentResidentOwner,
  selectPersistentWorkspace,
  type PersistentOwnerRequest,
  type PersistentResidentOwner,
} from "../../browser/persistent-resident-owner";

let persistentOwner: PersistentResidentOwner | undefined;
let persistentAbort: AbortController | undefined;
let persistentStop: Promise<void> | undefined;
let observeNative = false;
let failNativeClose = false;
let openGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let openHeld: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let nativeEvents: string[] = [];
let startupBarrier:
  | { stage: RuntimeStartupStage; arrived: ReturnType<typeof Promise.withResolvers<void>> }
  | undefined;
let abortAtStage: RuntimeStartupStage | undefined;
let failPhysicalClose = false;
const physicalCloseFailure = new Error("injected original physical close failure");
const nativeDatabaseClose = IDBDatabase.prototype.close;
IDBDatabase.prototype.close = function () {
  if (observeNative) nativeEvents.push("native-db-close-called");
  if (failPhysicalClose) throw physicalCloseFailure;
  nativeDatabaseClose.call(this);
  if (observeNative) nativeEvents.push("native-db-closed");
};
const nativeOpen = IndexedDBStorage.open;
const nativeLoad = IndexedDBStorage.prototype.load;
const nativeClose = IndexedDBStorage.prototype.close;
IndexedDBStorage.open = async function (name, options) {
  if (observeNative) nativeEvents.push("native-open");
  const storage = await nativeOpen.call(this, name, options);
  if (observeNative) nativeEvents.push("native-acquired");
  if (openGate) {
    openHeld!.resolve();
    await openGate.promise;
  }
  return storage;
};
IndexedDBStorage.prototype.load = async function () {
  if (observeNative) nativeEvents.push("native-load");
  return nativeLoad.call(this);
};
IndexedDBStorage.prototype.close = async function () {
  if (observeNative) nativeEvents.push("native-close-called");
  if (failNativeClose) throw new Error("injected native close failure");
  await nativeClose.call(this);
  if (observeNative) nativeEvents.push("native-closed");
};

const limits: PublicationLimits = {
  sessions: 16,
  operations: 16,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 4096,
  effects: 16,
  resultBytes: 256,
  logRecords: 8,
  logBytes: 32768,
  pins: 2,
  pinBytes: 256,
};
let backend: MemoryBackend | undefined, service: FilesystemService | undefined;
let root: FilesystemClient | undefined, server: ResidentAuthorityServer | undefined;
let handle = 0,
  rootHandle = 0;
let ordinaryPort: MessagePort | undefined;
let holdReply: "open" | "prepare" | undefined;
let heldReply: (() => void) | undefined;
const post = BroadcastChannel.prototype.postMessage;
BroadcastChannel.prototype.postMessage = function (value: unknown): void {
  const data = record(value);
  const response = data.value;
  if (
    holdReply &&
    data.kind === "reply" &&
    response &&
    typeof response === "object" &&
    (holdReply === "open"
      ? "descriptor" in response && "token" in response
      : "key" in response && "session" in response)
  ) {
    const phase = holdReply;
    holdReply = undefined;
    heldReply = () => Reflect.apply(post, this, [value]);
    self.postMessage({ event: `${phase}Held` });
    return;
  }
  Reflect.apply(post, this, [value]);
};
async function initialize(): Promise<void> {
  backend = new MemoryBackend();
  backend.fs.writeFile("/file", new Uint8Array([1, 2, 3]));
  backend.fs.mkdirp("/dir");
  backend.fs.writeFile("/dir/a", new Uint8Array([10, 20, 30, 40]));
  backend.fs.writeFile("/dir/b", new Uint8Array([5, 6]));
  service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(connection.server);
  root = hostFilesystemClient(service, connection);
  const dir: number = await root.asyncCall("preopen", ["/"]);
  rootHandle = dir;
  const file: { node: number } = await root.asyncCall("resolve", [dir, "file"]);
  handle = file.node;
  root.retain(handle);
}
let guardGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let guardAttempt: Promise<void> | undefined;
let guardAbort: AbortController | undefined;
const nativeLockRequest = navigator.locks.request.bind(navigator.locks);
Object.defineProperty(navigator.locks, "request", {
  value: async (name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => {
    if (guardGate && options.mode === "shared") {
      self.postMessage({ event: "guardPending" });
      await guardGate.promise;
    }
    return nativeLockRequest(name, options, async (lock) => {
      const value = await callback(lock);
      if (observeNative && name.startsWith("waffle:publication:"))
        nativeEvents.push("guard-released");
      return value;
    });
  },
});
async function serviceWork(): Promise<number> {
  try {
    await root!.asyncCall("writeFile", ["/file"], new Uint8Array([99]));
    return 0;
  } catch (error) {
    return Number(Reflect.get(Object(error), "errno"));
  }
}
async function enable(workspace: string, namespace = false): Promise<unknown> {
  if (!root || !service) throw new Error("authority not initialized");
  const descriptor: unknown = await root.asyncCall(
    namespace ? "publicationWorkspace" : "publicationResident",
    [root.connection.publication!.observer, namespace ? rootHandle : handle, workspace],
  );
  server = await serveResidentAuthority(service.residentPublication!, new AbortController().signal);
  return descriptor;
}
function inspectBytes(output: Uint8Array): number {
  const shared = backend!.shared,
    epoch = new Int32Array(root!.connection.epoch);
  try {
    shared.beginServiceMutation(epoch);
  } catch (error) {
    return -Number(Reflect.get(Object(error), "errno"));
  }
  try {
    return shared.read(handle, [output], 0);
  } finally {
    shared.endServiceMutation(epoch);
  }
}
function persistentRequest(body: unknown): PersistentOwnerRequest {
  const data = record(body);
  const base = {
    runtimeLifetime: text(data.runtimeLifetime),
    attempt: text(data.attempt),
    selected: selectPersistentWorkspace({ name: text(data.name), mode: "fast", whenBusy: "wait" }),
    publication: { limits, observe: true },
  };
  if (data.original === undefined) return { ...base, kind: "initial-open" };
  const original = record(data.original);
  return {
    ...base,
    kind: "reopen-v1",
    accept: "new-history-loss-and-unknown",
    original: { instance: text(original.instance), history: text(original.history) },
  };
}
function beginPersistent(body: unknown): PersistentResidentOwner {
  if (persistentOwner) throw new Error("original persistent owner still retained");
  observeNative = true;
  nativeEvents = [];
  persistentAbort = new AbortController();
  persistentStop = undefined;
  const request = persistentRequest(body);
  persistentOwner = createPersistentResidentOwner(
    request,
    persistentAbort.signal,
    (stage) => {
      nativeEvents.push(stage);
      if (startupBarrier?.stage === stage) startupBarrier.arrived.resolve();
      if (abortAtStage === stage) persistentAbort!.abort();
    },
    residentMemory(),
  );
  return persistentOwner;
}
async function stopPersistent(): Promise<unknown> {
  const owner = persistentOwner;
  if (!owner) throw new Error("persistent owner missing");
  persistentStop ??= owner.stop();
  const same = persistentStop === owner.stop();
  try {
    await persistentStop;
    if (persistentOwner === owner) persistentOwner = undefined;
    return { same, stopped: true, events: nativeEvents.slice() };
  } catch (error) {
    return {
      same,
      stopped: false,
      failure: String(error),
      originalFailure: error === physicalCloseFailure,
      events: nativeEvents.slice(),
    };
  }
}
function beginObservedPersistent(body: unknown): Promise<boolean> {
  return beginPersistent(body).ready.then(
    () => true,
    () => false,
  );
}
async function pendingNativeClaim(body: unknown): Promise<unknown> {
  startupBarrier = { stage: "filesystem-lock-requested", arrived: Promise.withResolvers<void>() };
  const ready = beginObservedPersistent(body);
  await startupBarrier.arrived.promise;
  const key = `bun-wasm:filesystem:indexeddb:${text(record(body).name)}`;
  const before = await navigator.locks.query();
  const held = before.held?.filter((lock) => lock.name === key).length;
  const pending = before.pending?.filter((lock) => lock.name === key).length;
  if (held !== 1 || pending !== 1)
    throw new Error("ordinary holder or pending native claim missing");
  const stopped = await stopPersistent();
  const after = await navigator.locks.query();
  startupBarrier = undefined;
  return {
    ready: await ready,
    held,
    pending,
    heldAfter: after.held?.filter((lock) => lock.name === key).length,
    pendingAfter: after.pending?.filter((lock) => lock.name === key).length,
    stopped,
  };
}
async function pendingNativeOpen(body: unknown): Promise<unknown> {
  startupBarrier = { stage: "indexeddb-open-requested", arrived: Promise.withResolvers<void>() };
  failPhysicalClose = record(body).failClose === true;
  const ready = beginObservedPersistent(body);
  await startupBarrier.arrived.promise;
  persistentStop = persistentOwner!.stop();
  let settled = false;
  void persistentStop.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await ready;
  await Promise.resolve();
  startupBarrier = undefined;
  return { ready: false, pending: !settled, events: nativeEvents.slice() };
}
async function cancelledNativeEpoch(body: unknown): Promise<unknown> {
  abortAtStage = "filesystem-epoch-resolved";
  const ready = beginObservedPersistent(body);
  const outcome = await ready;
  const stopped = await stopPersistent();
  abortAtStage = undefined;
  return { ready: outcome, stopped };
}
async function persistentOperation(operation: string, body: unknown): Promise<unknown> {
  if (operation === "persistentCancelPendingClaim") return pendingNativeClaim(body);
  if (operation === "persistentBeginLateRequest") return pendingNativeOpen(body);
  if (operation === "persistentCancelEpoch") return cancelledNativeEpoch(body);
  if (operation === "persistentStart") {
    const owner = beginPersistent(body);
    try {
      return { ready: true, value: await owner.ready, events: nativeEvents.slice() };
    } catch (error) {
      return { ready: false, failure: String(error), events: nativeEvents.slice() };
    }
  }
  if (operation === "persistentStop") return stopPersistent();
  if (operation === "persistentFailClose") {
    failNativeClose = true;
    return null;
  }
  if (operation === "persistentAbortLateOpen") {
    openGate = Promise.withResolvers<void>();
    openHeld = Promise.withResolvers<void>();
    const owner = beginPersistent(body);
    const ready = owner.ready.then(
      () => true,
      () => false,
    );
    await openHeld.promise;
    persistentAbort!.abort();
    persistentStop = owner.stop();
    let settled = false;
    void persistentStop.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    const pendingBeforeRelease = !settled;
    openGate.resolve();
    const stopped = await stopPersistent();
    openGate = undefined;
    openHeld = undefined;
    return { pendingBeforeRelease, ready: await ready, stopped };
  }
  throw new Error(`unknown persistent operation ${operation}`);
}
async function execute(operation: string, body: unknown): Promise<unknown> {
  if (operation.startsWith("persistent")) return persistentOperation(operation, body);
  if (operation === "beginGuard") {
    await initialize();
    await root!.asyncCall("publicationResident", [
      root!.connection.publication!.observer,
      handle,
      text(body),
    ]);
    guardGate = Promise.withResolvers<void>();
    guardAbort = new AbortController();
    guardAttempt = serveResidentAuthority(service!.residentPublication!, guardAbort.signal).then(
      (value) => {
        server = value;
      },
      () => {},
    );
    return null;
  }
  if (operation === "serviceWork") return serviceWork();
  if (operation === "failGuard") {
    guardAbort!.abort();
    guardGate!.resolve();
    await guardAttempt;
    return serviceWork();
  }
  if (operation === "idleStop") {
    const queued = serviceWork();
    await server!.stop();
    return {
      queued: await queued,
      idleStopped: await serviceWork(),
      stopped: backend!.shared.publication!.stopped,
    };
  }
  if (operation === "workspaceStart") {
    await initialize();
    return enable(text(body), true);
  }
  if (operation === "workspaceCut") return publicationObserver(root!).cut();
  if (operation === "workspaceStop") {
    await server?.stop();
    root?.dispose();
    service?.dispose();
    return null;
  }
  if (operation === "start") {
    await initialize();
    return enable(text(body));
  }
  if (operation === "ordinaryRoot") {
    await initialize();
    const connection = root!.fork();
    const sibling = new FilesystemClient(connection);
    const directory: number = await sibling.asyncCall("preopen", ["/"]);
    const file: { node: number } = await sibling.asyncCall("resolve", [directory, "file"]);
    sibling.retain(file.node);
    ordinaryPort = connection.port;
    return { connection, handle: file.node };
  }
  if (operation === "enable") return enable(text(body));
  if (!root || !backend || !service) throw new Error("authority not started");
  if (operation === "holdOpen" || operation === "holdPrepare") {
    holdReply = operation === "holdOpen" ? "open" : "prepare";
    return null;
  }
  if (operation === "releaseOpen" || operation === "releasePrepare") {
    heldReply?.();
    heldReply = undefined;
    return null;
  }
  if (operation === "inspect") {
    const output = new Uint8Array(8).fill(90),
      count = inspectBytes(output);
    return {
      count,
      bytes: Array.from(output),
      cut: backend.shared.publication!.cut(),
      lock: Atomics.load(backend.shared.cells, 1),
      diagnostics: backend.shared.publication!.diagnostics(),
    };
  }
  if (operation === "bypass") {
    const read = root.tryRead(handle, [new Uint8Array(3)], 0);
    const write = root.tryWrite(handle, [new Uint8Array([77])], 0);
    let namespace = 0;
    try {
      await root.asyncCall("writeFile", ["/file"], new Uint8Array([88]));
    } catch (error) {
      namespace = Number(Reflect.get(Object(error), "errno"));
    }
    return { read, write, namespace, lock: Atomics.load(backend.shared.cells, 1) };
  }
  if (operation === "changes")
    return publicationObserver(root).changes(publicationCut(body), limits.logBytes);
  if (operation === "stop") {
    root.dispose();
    await server?.stop();
    service.dispose();
    return null;
  }
  throw new Error(`unsupported fixture operation ${operation}`);
}
self.onmessage = ({ data }: MessageEvent<unknown>) => {
  const message = record(data),
    id = text(message.id);
  void execute(text(message.operation), message.body).then(
    (value) => {
      const transfer = message.operation === "ordinaryRoot" && ordinaryPort ? [ordinaryPort] : [];
      self.postMessage({ id, value }, transfer);
    },
    (error: unknown) => self.postMessage({ id, failure: String(error) }),
  );
};
