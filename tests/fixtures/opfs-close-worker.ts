import { OpfsStorage } from "../../fs/opfs.js";
import type { StorageLockManager } from "../../fs/indexeddb.js";
import { batch, bytes } from "../indexeddb-storage-browser.js";
import {
  OpfsCloseSetupInvalid,
  parseOpfsCloseCommand,
  reasonReceipt,
  requireProof,
  type OpfsCloseArm,
  type OpfsCloseCommand,
  type OpfsCloseReply,
} from "../opfs-close-browser.js";

type NativeAccess = {
  close(): void;
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
};
interface OriginalAccess {
  id: number;
  file: FileSystemFileHandle;
  original: NativeAccess;
  close: NativeAccess["close"];
  size: NativeAccess["getSize"];
  read: NativeAccess["read"];
  events: Record<string, unknown>[];
  closed: boolean;
  requests: number;
  closeDescriptor?: PropertyDescriptor;
}
interface OriginalLock {
  original: Lock | null;
  request: Promise<unknown>;
  state: "pending" | "fulfilled" | "rejected";
}
const rawOutcomes: unknown[] = [];
const originals: OriginalAccess[] = [];
const locks: OriginalLock[] = [];
const reentrant: Promise<void>[] = [];
const texts = ["u2g-original-a", "u2g-original-b"] as const;
const keys = ["file:1", "file:second"] as const;
let storage: OpfsStorage | undefined;
let closing: Promise<void> | undefined;
let selected: OriginalAccess | undefined;
let payloads: OriginalAccess[] = [];
let arm: OpfsCloseArm = "native-success";
let armed = false;
let nativeFactory: ((file: FileSystemFileHandle) => Promise<NativeAccess>) | undefined;
let nativeLockRequest: LockManager["request"] | undefined;
const injectedError = new Error("U2g labelled injection BEFORE native physical close");

function remember<T>(value: PromiseSettledResult<T>): PromiseSettledResult<T> {
  rawOutcomes.push(value);
  return value;
}
async function settled<T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([operation]);
  if (!result) throw new Error("Missing settled result");
  return remember(result);
}
function attempt<T>(operation: () => T): PromiseSettledResult<T> {
  try {
    return remember({ status: "fulfilled", value: operation() });
  } catch (reason) {
    return remember({ status: "rejected", reason });
  }
}
function receipt<T>(result: PromiseSettledResult<T>): Record<string, unknown> {
  return result.status === "fulfilled"
    ? { status: "fulfilled", value: result.value }
    : { status: "rejected", reason: reasonReceipt(result.reason) };
}
function checkAccess(value: unknown): asserts value is NativeAccess {
  if (!value || typeof value !== "object") throw new OpfsCloseSetupInvalid("Native access missing");
  for (const method of ["close", "getSize", "read", "write", "truncate", "flush"])
    if (typeof Reflect.get(value, method) !== "function")
      throw new OpfsCloseSetupInvalid(`Native access method missing: ${method}`);
}
function originalClose(record: OriginalAccess): void {
  record.requests++;
  if (closing && storage) reentrant.push(storage.close());
  if (armed && record === selected && arm !== "native-success") {
    record.events.push({
      phase: "injected-before-physical-close",
      reason: reasonReceipt(injected()),
    });
    throw injected();
  }
  record.events.push({ phase: "physical-close-request" });
  const result = attempt(() => record.close.call(record.original));
  record.events.push({ phase: "physical-close-outcome", ...receipt(result) });
  if (result.status === "rejected") throw result.reason;
  record.closed = true;
}
function injected(): unknown {
  return arm === "injected-undefined" ? undefined : injectedError;
}
async function capture(file: FileSystemFileHandle): Promise<NativeAccess> {
  if (!nativeFactory) throw new OpfsCloseSetupInvalid("Saved native factory missing");
  const original = await nativeFactory(file);
  const record: OriginalAccess = {
    id: originals.length + 1,
    file,
    original,
    close: original.close,
    size: original.getSize,
    read: original.read,
    events: [],
    closed: false,
    requests: 0,
    closeDescriptor: Object.getOwnPropertyDescriptor(original, "close"),
  };
  originals.push(record);
  try {
    Object.defineProperty(original, "close", {
      configurable: true,
      writable: true,
      value: () => originalClose(record),
    });
  } catch (reason) {
    rawOutcomes.push(reason);
    throw new OpfsCloseSetupInvalid(
      "Exact native original cannot be instrumented; no Proxy fallback",
    );
  }
  requireProof(originals[record.id - 1]?.original === original, "Exact original identity lost");
  return original;
}
function install(): void {
  if (nativeFactory) throw new OpfsCloseSetupInvalid("Native observer already installed");
  if (
    typeof navigator.storage?.getDirectory !== "function" ||
    typeof navigator.locks?.request !== "function" ||
    typeof navigator.locks?.query !== "function"
  )
    throw new OpfsCloseSetupInvalid("Native OPFS/WebLock observers unavailable");
  if (typeof FileSystemFileHandle === "undefined")
    throw new OpfsCloseSetupInvalid("OPFS unavailable");
  nativeLockRequest = navigator.locks.request.bind(navigator.locks);
  const prototype = FileSystemFileHandle.prototype;
  const factory: unknown = Reflect.get(prototype, "createSyncAccessHandle");
  if (typeof factory !== "function")
    throw new OpfsCloseSetupInvalid("Native sync access unavailable");
  nativeFactory = async (file) => {
    const original: unknown = await Reflect.apply(factory, file, []);
    checkAccess(original);
    return original;
  };
  try {
    Object.defineProperty(prototype, "createSyncAccessHandle", {
      configurable: true,
      writable: true,
      value: function (this: FileSystemFileHandle) {
        return capture(this);
      },
    });
  } catch (reason) {
    rawOutcomes.push(reason);
    throw new OpfsCloseSetupInvalid("Native factory interceptor unavailable");
  }
}
const forwardingLocks: StorageLockManager = {
  request<T>(
    storageName: string,
    options: Parameters<StorageLockManager["request"]>[1],
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T> {
    if ("steal" in options) throw new OpfsCloseSetupInvalid("Lock stealing is not an oracle seam");
    const record: OriginalLock = { original: null, request: Promise.resolve(), state: "pending" };
    if (!nativeLockRequest) throw new OpfsCloseSetupInvalid("Saved native WebLock request missing");
    const request = nativeLockRequest(storageName, options, (original) => {
      record.original = original;
      return callback(original);
    });
    record.request = request;
    locks.push(record);
    void request.then(
      (value) => {
        record.state = "fulfilled";
        rawOutcomes.push({ status: "fulfilled", value });
      },
      (reason) => {
        record.state = "rejected";
        rawOutcomes.push({ status: "rejected", reason });
      },
    );
    return request;
  },
};
function accessReceipts(): Record<string, unknown>[] {
  return originals.map((record) => ({
    id: record.id,
    file: record.file.name,
    exactOriginalReturned: true,
    requests: record.requests,
    events: record.events,
  }));
}
function lockReceipts(): Record<string, unknown>[] {
  return locks.map((record) => ({
    nativeLockObserved: record.original !== null,
    name: record.original?.name,
    nativeRequest: record.state,
    callbackAndRequestUnchanged: true,
  }));
}
function encoded(value: string): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function directory(storageName: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(`bun-wasm-${encoded(storageName)}`);
}
function sameBytes(actual: Uint8Array, expected: string): boolean {
  return (
    actual.length === bytes(expected).length &&
    actual.every((value, index) => value === bytes(expected)[index])
  );
}
async function cachedOriginal(storageName: string, key: string): Promise<OriginalAccess> {
  const data = await (await directory(storageName)).getDirectoryHandle("data");
  const file = await data.getFileHandle(`p-${encoded(key)}`);
  const matching: OriginalAccess[] = [];
  for (const record of originals)
    if (!record.closed && (await record.file.isSameEntry(file))) matching.push(record);
  requireProof(
    matching.length === 1 && matching[0],
    "Unique original cached native handle missing",
  );
  return matching[0];
}
async function prepare(
  storageName: string,
  selectedArm: OpfsCloseArm,
): Promise<Record<string, unknown>> {
  arm = selectedArm;
  install();
  storage = await OpfsStorage.open(storageName, {
    locks: forwardingLocks,
    createConcurrency: 1,
    handleCacheSize: 2,
  });
  const saving = batch(1, texts[0]);
  const root = saving.upserts[0];
  requireProof(root?.children, "Batch root missing");
  root.children.push(["second", 3]);
  saving.upserts.push({
    ino: 3,
    kind: "file",
    size: bytes(texts[1]!).length,
    mtime: 1,
    data: keys[1],
  });
  saving.data.set(keys[1]!, bytes(texts[1]!));
  await storage.persist(saving);
  await storage.flush();
  for (const [index, key] of keys.entries())
    requireProof(sameBytes(await storage.read(key), texts[index]!), "Prepared bytes differ");
  payloads = await Promise.all(keys.map((key) => cachedOriginal(storageName, key)));
  selected = payloads[0];
  return { native: inspect(false), accesses: accessReceipts(), locks: lockReceipts() };
}
function nativeRead(record: OriginalAccess, text: string, live: boolean): Record<string, unknown> {
  const size = attempt(() => record.size.call(record.original));
  const buffer = new Uint8Array(bytes(text).length);
  const read = attempt(() => record.read.call(record.original, buffer, { at: 0 }));
  if (live) {
    requireProof(
      size.status === "fulfilled" && size.value === buffer.length,
      "Original native size unavailable",
    );
    requireProof(
      read.status === "fulfilled" && read.value === buffer.length && sameBytes(buffer, text),
      "Original native bytes differ",
    );
  } else {
    requireProof(
      size.status === "rejected" && read.status === "rejected",
      "Native original remains usable after physical close",
    );
  }
  return {
    id: record.id,
    liveExpected: live,
    size: receipt(size),
    read: receipt(read),
    bytes: Array.from(buffer),
  };
}
function inspect(retained: boolean): Record<string, unknown> {
  requireProof(payloads.length === 2, "Original payload identities missing");
  const beforeClose = closing === undefined;
  const native = payloads.map((record, index) =>
    nativeRead(record, texts[index]!, beforeClose || (retained && index === 0)),
  );
  requireProof(
    locks.length === 1 && locks[0]?.original !== null,
    "Exact original native lock missing",
  );
  if (closing)
    requireProof(
      locks.every((record) => record.state === (retained ? "pending" : "fulfilled")),
      "Original native lock lifetime differs",
    );
  return {
    native,
    accesses: accessReceipts(),
    locks: lockReceipts(),
    location: globalThis.location.href,
  };
}
async function closeOwner(): Promise<Record<string, unknown>> {
  requireProof(storage, "Original adapter missing");
  armed = true;
  const original = storage.close();
  closing = original;
  const repeated = storage.close();
  const result = await settled(original);
  const again = await settled(storage.close());
  requireProof(
    original === repeated && original === storage.close(),
    "Original close promise identity changed",
  );
  requireProof(
    reentrant.length === 2 && reentrant.every((promise) => promise === original),
    "Reentrant promise identity or callback coverage changed",
  );
  if (arm === "native-success")
    requireProof(
      result.status === "fulfilled" && again.status === "fulfilled",
      "Native adapter close rejected",
    );
  else
    requireProof(
      result.status === "rejected" &&
        again.status === "rejected" &&
        Object.is(result.reason, injected()) &&
        Object.is(again.reason, injected()),
      "Exact injected reason lost in original realm",
    );
  requireProof(
    payloads.every((record) => record.requests === 1),
    "Original close request coverage differs",
  );
  for (const record of payloads) {
    const physical = record.events.filter((event) => event.phase === "physical-close-request");
    const expected = record === selected && arm !== "native-success" ? 0 : 1;
    requireProof(
      physical.length === expected,
      "Pre-physical injection or safe sibling coverage differs",
    );
  }
  const admission = await settled(storage.load());
  requireProof(admission.status === "rejected", "Adapter admitted after close");
  return {
    request: "storage.close",
    outcome: receipt(result),
    repeated: receipt(again),
    samePromise: true,
    reentrantSamePromise: true,
    reentrantCallbacks: reentrant.length,
    sameRealmReason: arm === "native-success" ? "not injected" : true,
    admission: receipt(admission),
    accesses: accessReceipts(),
    locks: lockReceipts(),
    diagnosticsOnly: storage.resources(),
  };
}
function lockedReason(reason: unknown): boolean {
  return (
    reason instanceof DOMException &&
    ["NoModificationAllowedError", "InvalidStateError", "NotReadableError"].includes(reason.name)
  );
}
async function probeFile(
  file: FileSystemFileHandle,
  text: string,
  excluded: boolean,
): Promise<Record<string, unknown>> {
  const factory: unknown = Reflect.get(file, "createSyncAccessHandle");
  if (typeof factory !== "function")
    throw new OpfsCloseSetupInvalid("Raw probe factory unavailable");
  const opening = await settled(
    Promise.resolve().then((): unknown => Reflect.apply(factory, file, [])),
  );
  if (opening.status === "rejected") {
    requireProof(
      excluded && lockedReason(opening.reason),
      "Unexpected native file acquisition rejection",
    );
    return { file: file.name, acquisition: receipt(opening), excluded: true };
  }
  const original: unknown = opening.value;
  checkAccess(original);
  const record: OriginalAccess = {
    id: -1,
    file,
    original,
    close: original.close,
    size: original.getSize,
    read: original.read,
    events: [],
    closed: false,
    requests: 0,
  };
  const reading = attempt(() => nativeRead(record, text, true));
  const closed = attempt(() => record.close.call(original));
  if (reading.status === "rejected" || closed.status === "rejected") {
    const failures: unknown[] = [];
    if (reading.status === "rejected") failures.push(reading.reason);
    if (closed.status === "rejected") failures.push(closed.reason);
    throw new AggregateError(
      failures,
      "Raw probe read/physical close failed; both raw outcomes retained",
    );
  }
  requireProof(!excluded, "Native file was acquired while exclusion was required");
  return {
    file: file.name,
    acquisition: { status: "fulfilled" },
    reading: receipt(reading),
    physicalClose: receipt(closed),
  };
}
async function probe(
  storageName: string,
  held: "both" | "first" | "none",
): Promise<Record<string, unknown>> {
  const data = await (await directory(storageName)).getDirectoryHandle("data");
  const files: Record<string, unknown>[] = [];
  for (const [index, key] of keys.entries()) {
    const file = await data.getFileHandle(`p-${encoded(key)}`);
    files.push(
      await probeFile(file, texts[index]!, held === "both" || (held === "first" && index === 0)),
    );
  }
  const grant = await navigator.locks.request(
    `bun-wasm:filesystem:${storageName}`,
    { mode: "exclusive", ifAvailable: true },
    (original) => original !== null,
  );
  rawOutcomes.push(grant);
  requireProof(grant === (held === "none"), "Independent original WebLock availability differs");
  return {
    files,
    webLock: { ifAvailable: true, granted: grant, request: "fulfilled" },
    query: await navigator.locks.query(),
  };
}
async function reopen(storageName: string): Promise<Record<string, unknown>> {
  install();
  storage = await OpfsStorage.open(storageName, {
    locks: forwardingLocks,
    createConcurrency: 1,
    handleCacheSize: 2,
  });
  const index = await storage.load();
  requireProof(index?.generation === 1, "Reopened generation differs");
  const read: number[][] = [];
  for (const [position, key] of keys.entries()) {
    const value = await storage.read(key);
    requireProof(sameBytes(value, texts[position]!), "Reopened bytes differ");
    read.push(Array.from(value));
  }
  closing = storage.close();
  const closed = await settled(closing);
  requireProof(closed.status === "fulfilled", "Reopened adapter close rejected");
  requireProof(
    originals.length > 0 && originals.every((record) => record.closed),
    "Reopened native originals not physically closed",
  );
  const nativeClosed = originals.map((record) =>
    receipt(attempt(() => record.size.call(record.original))),
  );
  requireProof(
    nativeClosed.every((result) => result.status === "rejected"),
    "Reopened native original is still usable",
  );
  return {
    generation: index.generation,
    bytes: read,
    close: receipt(closed),
    nativeClosed,
    accesses: accessReceipts(),
    locks: lockReceipts(),
  };
}
async function deleteStorage(storageName: string): Promise<Record<string, unknown>> {
  await OpfsStorage.delete(storageName);
  const root = await navigator.storage.getDirectory();
  const missing = await settled(root.getDirectoryHandle(`bun-wasm-${encoded(storageName)}`));
  requireProof(
    missing.status === "rejected" &&
      missing.reason instanceof DOMException &&
      missing.reason.name === "NotFoundError",
    "Unique task storage deletion unconfirmed",
  );
  return { storageName, deletion: "fulfilled", absence: receipt(missing) };
}
async function dispatch(command: OpfsCloseCommand): Promise<Record<string, unknown>> {
  switch (command.kind) {
    case "prepare":
      return prepare(command.storageName, command.arm);
    case "close":
      return closeOwner();
    case "inspect":
      return inspect(command.retained);
    case "probe":
      return probe(command.storageName, command.held);
    case "reopen":
      return reopen(command.storageName);
    case "delete":
      return deleteStorage(command.storageName);
  }
}
async function receive(value: unknown): Promise<OpfsCloseReply> {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id)
  )
    throw new OpfsCloseSetupInvalid("Invalid request identity");
  const id = value.id;
  try {
    if (!("command" in value)) throw new OpfsCloseSetupInvalid("Worker command missing");
    return { id, status: "ok", receipt: await dispatch(parseOpfsCloseCommand(value.command)) };
  } catch (reason) {
    rawOutcomes.push(reason);
    return {
      id,
      status: reason instanceof OpfsCloseSetupInvalid ? "setup-invalid" : "behavioral-red",
      receipt: {
        error: reasonReceipt(reason),
        accesses: accessReceipts(),
        locks: lockReceipts(),
        rawOutcomesRetainedInOriginalRealm: rawOutcomes.length,
      },
    };
  }
}
globalThis.onmessage = (event: MessageEvent<unknown>) => {
  void receive(event.data).then(
    (reply) => globalThis.postMessage(reply),
    (reason) => {
      rawOutcomes.push(reason);
      globalThis.postMessage({ protocolError: reasonReceipt(reason) });
    },
  );
};
