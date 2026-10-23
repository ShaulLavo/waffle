import { OpfsStorage } from "../../fs/opfs.js";
import { PersistentBackend } from "../../fs/persistent.js";
import { installFilesystemWorker } from "../../fs/service.js";

export const shutdownDebtWorkerPath = import.meta.filename;
type NativeAccess = { close(): void; getSize(): number };
type Original = { native: NativeAccess; close: () => void; closed: boolean; calls: number };

function nativeAccess(value: unknown): asserts value is NativeAccess {
  if (!value || typeof value !== "object" || !("close" in value) || !("getSize" in value))
    throw new Error("Missing native access handle");
  if (typeof value.close !== "function" || typeof value.getSize !== "function")
    throw new Error("Missing native access methods");
}

function installStorage(): void {
  const records: Original[] = [];
  let selected: Original | undefined;
  let armed = false;
  let closing: Promise<void> | undefined;
  let storage: OpfsStorage | undefined;
  let sameStoragePromise = false;
  let reasonMatched = false;
  let lateCallbacks = 0;
  const reason: unknown = new URL(location.href).searchParams.get("reason") === "undefined"
    ? undefined : new Error("labelled injection before original native close");
  const prototype = FileSystemFileHandle.prototype;
  const factory: unknown = Reflect.get(prototype, "createSyncAccessHandle");
  if (typeof factory !== "function") throw new Error("Native sync access is unavailable");
  Object.defineProperty(prototype, "createSyncAccessHandle", {
    configurable: true,
    async value(this: FileSystemFileHandle) {
      const native: unknown = await Reflect.apply(factory, this, []);
      nativeAccess(native);
      const record = { native, close: native.close.bind(native), closed: false, calls: 0 };
      records.push(record);
      Object.defineProperty(native, "close", { configurable: true, value: () => close(record) });
      return native;
    },
  });
  function close(record: Original): void {
    record.calls++;
    if (armed && !selected) selected = record;
    if (armed && selected === record) throw reason;
    record.close();
    record.closed = true;
  }
  function snapshot() {
    const retained = selected !== undefined && !selected.closed;
    return {
      records: records.length,
      retained,
      selectedCalls: selected?.calls,
      originalReadable: selected && retained ? selected.native.getSize() >= 0 : false,
      sameStoragePromise,
      reasonMatched,
      lateCallbacks,
      resources: storage?.resources(),
    };
  }
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage(message: unknown): void } = {
    onmessage: null,
    postMessage(message: unknown) { globalThis.postMessage(message); },
  };
  installFilesystemWorker(scope, async (data) => {
    storage = await OpfsStorage.open(data.name);
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    const originalClose = storage.close.bind(storage);
    storage.close = () => {
      armed = new URL(location.href).searchParams.get("fault") === "true";
      const original = originalClose();
      if (!closing) closing = original;
      sameStoragePromise = closing === original;
      void original.catch((failure: unknown) => { reasonMatched = Object.is(failure, reason); });
      return original;
    };
    return backend;
  });
  globalThis.onmessage = (event: MessageEvent) => {
    if (event.data?.probe === "snapshot") {
      globalThis.postMessage({ probe: "snapshot", value: snapshot() });
      return;
    }
    if (event.data?.probe === "late") {
      lateCallbacks++;
      if (!storage) throw new Error("Missing original storage");
      sameStoragePromise = storage.close() === closing;
      globalThis.postMessage({ probe: "late", value: snapshot() });
      return;
    }
    scope.onmessage?.(event);
  };
}

if (typeof document === "undefined" && typeof self !== "undefined" && "postMessage" in self) {
  if (new URL(location.href).searchParams.get("role") === "consumer") {
    globalThis.onmessage = () => globalThis.postMessage({ alive: true });
    globalThis.postMessage({ ready: true });
  } else installStorage();
}
