import { allocateSharedControl } from "../memory/control.ts";
import { directoryObservationLocation, returnDirectoryProcess } from "./directory.js";
import { packedControl } from "./control.js";
import {
  processOutcome,
  OutcomeCell,
  reviveOutcome,
  serializeOutcome,
  readOutcome,
  type OutcomeWord,
  type OutcomeTransfer,
} from "./outcome.js";
import { ExecutionUnwind } from "../core/unwind.js";
import { ProcessError, ProcessErrno, type ProcessExit } from "./types.js";
import {
  BigInt64ArrayConstructor,
  BigIntConstructor,
  atomicsLoad,
  atomicsCompareExchange,
  isSharedArrayBuffer,
  sharedArrayBufferByteLength,
  WeakMapConstructor,
  weakMapSet,
  weakMapGet,
  isInstance,
  typedArrayByteOffset,
  typedArrayBuffer,
  Uint32ArrayConstructor,
  cryptoGetRandomValues,
  typedArraySet,
  atomicsStore,
  objectFreeze,
} from "./intrinsics.ts";

export type ProcessObservation =
  | { readonly kind: "pending" }
  | { readonly kind: "selected"; readonly result: ProcessExit }
  | { readonly kind: "terminated" };
export type ProcessObservationTransfer = {
  readonly pid: number;
  readonly lifetime: SharedArrayBuffer;
} & (
  | { readonly kind: "directory"; readonly directory: SharedArrayBuffer; readonly slot: number }
  | { readonly kind: "standalone"; readonly domain: bigint; readonly source: OutcomeTransfer }
);
/** Capture once before publishing a standalone record, or reuse its admitted association. */
export function admitProcessObservation(
  pid: number,
  outcome: OutcomeWord,
  existing?: ProcessObservationTransfer,
): ProcessObservationTransfer {
  if (existing) {
    if (existing.pid !== pid) throw new TypeError("Process observation pid differs from admission");
    validateObservationOutcome(existing, outcome);
    captureProcessObserver(existing);
    return existing;
  }
  if (isInstance(outcome, OutcomeCell))
    throw new TypeError("Directory outcomes require their admitted process observation");
  const lifetime = allocateSharedControl(16);
  typedArraySet(
    new Uint32ArrayConstructor(lifetime, 0, 2),
    cryptoGetRandomValues(new Uint32ArrayConstructor(2)),
  );
  const token = new BigInt64ArrayConstructor(lifetime);
  atomicsStore(token, 1, packedControl(pid, 1));
  return {
    kind: "standalone",
    pid,
    lifetime,
    domain: atomicsLoad(token, 0),
    source: objectFreeze(serializeOutcome(outcome)),
  };
}
export interface ProcessObserver {
  read(): ProcessObservation;
}

function invalid(): never {
  throw new ProcessError(ProcessErrno.SRCH, "invalid process observation incarnation");
}
type CapturedSource =
  | {
      readonly kind: "directory";
      readonly location: ReturnType<typeof directoryObservationLocation>;
      readonly domain: bigint;
    }
  | { readonly kind: "standalone"; readonly word: BigInt64Array; readonly domain: bigint };
function captureSource(transfer: ProcessObservationTransfer): CapturedSource {
  if (transfer.kind === "directory") {
    const location = directoryObservationLocation(transfer);
    return { kind: "directory", location, domain: location.domain };
  }
  const word = reviveOutcome(transfer.source);
  if (isInstance(word, OutcomeCell))
    throw new TypeError("Standalone observation cannot use a recycled row");
  return { kind: "standalone", word, domain: transfer.domain };
}
function readDirectorySource(
  source: Extract<CapturedSource, { kind: "directory" }>,
  pid: number,
  expired: () => boolean,
): ProcessObservation {
  const before = atomicsLoad(source.location.identity, 0);
  const encoded = atomicsLoad(source.location.outcome, 0);
  const after = atomicsLoad(source.location.identity, 0);
  if (expired()) return { kind: "terminated" };
  if (Number(before >> 32n) !== pid || Number(after >> 32n) !== pid) return invalid();
  const phase = after & 0xffffffffn;
  const firstPhase = before & 0xffffffffn;
  if (firstPhase !== 1n && firstPhase !== 3n && firstPhase !== 4n) return invalid();
  if (phase !== 1n && phase !== 3n && phase !== 4n) return invalid();
  const tag = encoded & 3n;
  if (tag === 0n) {
    if ((encoded & ~4n) !== BigIntConstructor(pid) << 3n) return invalid();
    return { kind: "pending" };
  }
  return {
    kind: "selected",
    result: processOutcome({
      kind: tag === 1n ? "exited" : tag === 2n ? "signaled" : "start-failed",
      code: Number(encoded >> 3n),
    }),
  };
}
/** Read authority outlives logical collection, but never native termination return. */
export function captureProcessObserver(transfer: ProcessObservationTransfer): ProcessObserver {
  const pid = transfer.pid;
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff)
    throw new TypeError("invalid process observation pid");
  if (
    !isSharedArrayBuffer(transfer.lifetime) ||
    sharedArrayBufferByteLength(transfer.lifetime) !== 16
  )
    throw new TypeError("invalid process observation token");
  const source = captureSource(transfer);
  const token = new BigInt64ArrayConstructor(transfer.lifetime);
  const active = packedControl(pid, 1);
  const terminated = packedControl(pid, 2);
  function expired(): boolean {
    if (atomicsLoad(token, 0) !== source.domain) return invalid();
    const state = atomicsLoad(token, 1);
    if (state === terminated) return true;
    if (state !== active) return invalid();
    return false;
  }
  function read(): ProcessObservation {
    if (expired()) return { kind: "terminated" };
    if (source.kind === "directory") return readDirectorySource(source, pid, expired);
    const selected = readOutcome(source.word);
    if (expired()) return { kind: "terminated" };
    return selected ? { kind: "selected", result: selected } : { kind: "pending" };
  }
  read();
  return objectFreeze({ read });
}

/** Capture before calling an embedding hook. Completion is idempotent and has no await. */
export function captureNativeReturn(transfer: ProcessObservationTransfer): () => void {
  const process =
    transfer.kind === "directory"
      ? { directory: transfer.directory, slot: transfer.slot, pid: transfer.pid }
      : undefined;
  const pid = transfer.pid;
  const observer = captureProcessObserver(transfer);
  const token = new BigInt64ArrayConstructor(transfer.lifetime);
  const active = packedControl(pid, 1);
  const terminated = packedControl(pid, 2);
  let completed = false;
  return () => {
    if (completed) return;
    observer.read();
    const previous = atomicsCompareExchange(token, 1, active, terminated);
    if (previous !== active && previous !== terminated) return invalid();
    if (process) returnDirectoryProcess(process);
    completed = true;
  };
}

const terminations = new WeakMapConstructor<object, ProcessObserver>();
class ProcessExecutionTerminated extends ExecutionUnwind {
  constructor(observer: ProcessObserver) {
    super("process execution terminated");
    weakMapSet(terminations, this, observer);
  }
}
export function isProcessExecutionTerminated(error: unknown, observer?: ProcessObserver): boolean {
  if (typeof error !== "object" || error === null) return false;
  const owner = weakMapGet(terminations, error);
  return owner !== undefined && (observer === undefined || owner === observer);
}
export function checkProcessObservation(observer: ProcessObserver): ProcessExit | null {
  const result = observer.read();
  if (result.kind === "terminated") throw new ProcessExecutionTerminated(observer);
  return result.kind === "selected" ? result.result : null;
}
/** Only runtime-owned authority acquisition belongs inside this recovery boundary. */
export function acquireObservedProcess<T>(observer: ProcessObserver, acquire: () => T): T {
  try {
    return acquire();
  } catch (error) {
    let observed: ProcessObservation;
    try {
      observed = observer.read();
    } catch {
      throw error;
    }
    if (observed.kind === "terminated") throw new ProcessExecutionTerminated(observer);
    if (observed.kind === "selected") throw new ObservedProcessExit(observer, observed.result);
    throw error;
  }
}
const observedExits = new WeakMapConstructor<
  object,
  { observer: ProcessObserver; result: ProcessExit }
>();
export function observedProcessExit(
  error: unknown,
  observer?: ProcessObserver,
): ProcessExit | null {
  if (typeof error !== "object" || error === null) return null;
  const observed = weakMapGet(observedExits, error);
  if (!observed || (observer !== undefined && observed.observer !== observer)) return null;
  return observed.result;
}
class ObservedProcessExit extends ExecutionUnwind {
  constructor(observer: ProcessObserver, result: ProcessExit) {
    super("process selected its terminal outcome");
    weakMapSet(observedExits, this, { observer, result });
  }
}

/** Same-version threaded transfers bind their producer and observer to one canonical word. */
export function validateObservationOutcome(
  transfer: ProcessObservationTransfer | null,
  outcome: OutcomeWord,
): void {
  if (!transfer) {
    if (isInstance(outcome, OutcomeCell))
      throw new TypeError("Recyclable outcomes require process observation");
    return;
  }
  if (transfer.kind === "standalone") {
    const source = reviveOutcome(transfer.source);
    if (isInstance(source, OutcomeCell) || isInstance(outcome, OutcomeCell))
      throw new TypeError("Standalone observation cannot use a recycled row");
    if (
      typedArrayBuffer(source) !== typedArrayBuffer(outcome) ||
      typedArrayByteOffset(source) !== typedArrayByteOffset(outcome)
    )
      throw new TypeError("Process observation differs from its canonical outcome");
    return;
  }
  if (!isInstance(outcome, OutcomeCell))
    throw new TypeError("Process observation requires a canonical outcome cell");
  const location = directoryObservationLocation(transfer);
  const buffer = typedArrayBuffer(outcome.cells);
  if (!isSharedArrayBuffer(buffer)) throw new TypeError("Canonical outcome must be shared");
  const domain = atomicsLoad(new BigInt64ArrayConstructor(buffer, 8, 1), 0);
  if (
    outcome.pid !== transfer.pid ||
    outcome.validity.id !== transfer.pid ||
    typedArrayByteOffset(outcome.cells) !== typedArrayByteOffset(location.outcome) ||
    outcome.validity.byteOffset !== typedArrayByteOffset(location.identity) ||
    sharedArrayBufferByteLength(buffer) !== sharedArrayBufferByteLength(transfer.directory) ||
    domain !== location.domain
  )
    throw new TypeError("Process observation differs from its canonical outcome");
}
