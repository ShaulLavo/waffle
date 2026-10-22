import { IndexedDBStorage } from "../../fs/indexeddb.js";
import { PersistentBackend } from "../../fs/persistent.js";
import { installFilesystemWorker } from "../../fs/service.js";
import {
  failureValue,
  isFailureReason,
  isRecord,
  isShutdownArm,
  observe,
  pending,
  type Outcome,
  type ShutdownSpec,
  type WorkerSnapshot,
} from "../filesystem-shutdown-browser.js";

let configuration: ShutdownSpec | undefined;
let control: MessagePort | undefined;
let snapshot: WorkerSnapshot | undefined;
let closeOriginalStorage: (() => Promise<void>) | undefined;
const gate = Promise.withResolvers<void>();
const scope: {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
} = {
  onmessage: null,
  postMessage: (message) => globalThis.postMessage(message),
};

function originalReason(result: Outcome<void>, reason: unknown): void {
  if (!snapshot || result.kind !== "rejected") return;
  snapshot.originalReasonMatched = {
    kind: "fulfilled",
    value: Object.is(result.reason, reason),
  };
}
function installSeams(storage: IndexedDBStorage, backend: PersistentBackend): void {
  if (!configuration || !snapshot) throw new Error("Missing fixture configuration");
  const config = configuration;
  const record = snapshot;
  const reason = record.injectedReason;
  const prepare = backend.prepare.bind(backend);
  const backendClose = backend.close.bind(backend);
  const persist = storage.persist.bind(storage);
  const rawClose = storage.close.bind(storage);
  closeOriginalStorage = rawClose;
  let gated = false;
  // Test-only preparation gate. All other operations still use the real backend.
  backend.prepare = (operation, args) => {
    const original = prepare(operation, args);
    if (operation !== "listFiles" || gated) return original;
    gated = true;
    const joined = Promise.resolve(original).then(() => {
      control?.postMessage({ event: "gate-entered" });
      return gate.promise;
    });
    void observe(joined).then((result) => {
      record.preparation = result;
      originalReason(result, reason);
    });
    return joined;
  };
  // Test-only final-persist rejection, before native transaction submission.
  storage.persist = (batch) => {
    if (config.arm === "final-save-failure") return Promise.reject(reason);
    return persist(batch);
  };
  storage.close = () => {
    record.rawCloseCalls++;
    record.nativeCloseCalls++;
    const native = rawClose();
    void observe(native).then((result) => {
      record.nativeClose = result;
    });
    // This seam rejects AFTER real close/unlock. It is not a native close fault.
    if (config.arm === "raw-close-failure") return native.then(() => Promise.reject(reason));
    return native;
  };
  backend.close = () => {
    record.backendCloseCalls++;
    const original = backendClose();
    void observe(original).then((result) => {
      record.backendClose = result;
      originalReason(result, reason);
    });
    return original;
  };
}

installFilesystemWorker(scope, async () => {
  if (!configuration) throw new Error("Missing fixture configuration");
  const storage = await IndexedDBStorage.open(configuration.database, { whenBusy: "wait" });
  closeOriginalStorage = storage.close.bind(storage);
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  installSeams(storage, backend);
  return backend;
});

async function controlAction(action: unknown): Promise<unknown> {
  if (!configuration || !snapshot) throw new Error("Missing original fixture owner");
  if (action === "release") {
    if (configuration.arm === "drain-failure") gate.reject(snapshot.injectedReason);
    else gate.resolve();
    return;
  }
  if (action === "snapshot") return snapshot;
  if (action === "cleanup-storage") {
    // Explicit teardown of the real storage owner, never a backend-close retry/proof.
    gate.resolve();
    if (!closeOriginalStorage) throw new Error("Missing original storage cleanup owner");
    await closeOriginalStorage();
    return;
  }
  throw new Error("Unknown fixture-only control action");
}
function receiveControl(event: MessageEvent<unknown>): void {
  const message = event.data;
  if (!isRecord(message) || !Number.isSafeInteger(message.id))
    throw new Error("Invalid fixture-only control request");
  const id = message.id;
  void observe(controlAction(message.action)).then((outcome) => {
    control?.postMessage({ id, outcome });
  });
}
function configure(message: Record<string, unknown>): void {
  if (configuration) throw new Error("Fixture configured twice");
  if (!isShutdownArm(message.arm) || !isFailureReason(message.reason))
    throw new Error("Invalid fixture arm or reason");
  if (
    typeof message.database !== "string" ||
    typeof message.nonce !== "string" ||
    typeof message.marker !== "string" ||
    !(message.port instanceof MessagePort)
  )
    throw new Error("Invalid fixture configuration");
  configuration = {
    arm: message.arm,
    reason: message.reason,
    database: message.database,
    nonce: message.nonce,
    marker: message.marker,
  };
  snapshot = {
    nonce: configuration.nonce,
    location: globalThis.location.href,
    backendCloseCalls: 0,
    rawCloseCalls: 0,
    nativeCloseCalls: 0,
    preparation: pending(),
    backendClose: pending(),
    nativeClose: pending(),
    injectedReason: failureValue(configuration.reason),
    originalReasonMatched: pending(),
  };
  control = message.port;
  control.onmessage = receiveControl;
  control.start();
}
globalThis.onmessage = (event: MessageEvent<unknown>) => {
  if (isRecord(event.data) && event.data.fixture === "configure") {
    configure(event.data);
    return;
  }
  scope.onmessage?.(event);
};
