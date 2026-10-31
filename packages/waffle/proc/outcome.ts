import { startFailureName, startFailureErrno } from "./start-errno.ts";
import { ProcessErrno, ProcessError, type ProcessExit } from "./types.ts";
import { packedControl, type CellValidity } from "./control.ts";
import {
  atomicsCompareExchange,
  atomicsLoad,
  BigInt64ArrayConstructor,
  SharedArrayBufferConstructor,
  objectFreeze,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
  isSharedArrayBuffer,
  isBigInt64Array,
  isInstance,
} from "./intrinsics.ts";

export interface OutcomeCellTransfer {
  type: "outcome-cell";
  buffer: SharedArrayBuffer;
  byteOffset: number;
  pid: number;
  running: bigint;
  validity: CellValidity;
}
export interface OutcomeWordTransfer {
  type: "outcome-word";
  buffer: SharedArrayBuffer;
  byteOffset: number;
}
export type OutcomeTransfer = SharedArrayBuffer | OutcomeCellTransfer | OutcomeWordTransfer;

const STARTED = 4n;
/** An outcome's running sentinel and record identity are captured, never readopted. */
export class OutcomeCell {
  readonly running: bigint;
  readonly cells: BigInt64Array;
  readonly pid: number;
  readonly validity: CellValidity;
  private readonly identity: BigInt64Array;
  constructor(cells: BigInt64Array, pid: number, validity: CellValidity) {
    this.cells = cells;
    this.pid = pid;
    this.validity = validity;
    this.running = BigInt(pid) << 3n;
    this.identity = new BigInt64ArrayConstructor(validity.buffer, validity.byteOffset, 1);
  }
  get buffer(): SharedArrayBuffer {
    return typedArrayBuffer(this.cells) as SharedArrayBuffer;
  }
  get byteOffset(): number {
    return typedArrayByteOffset(this.cells);
  }
  valid(): boolean {
    return atomicsLoad(this.identity, 0) === packedControl(this.validity.id, 1);
  }
  check(): void {
    if (!this.valid())
      throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected");
  }
}
export type OutcomeWord = BigInt64Array | OutcomeCell;
/** Standalone outcomes do not recycle and use the zero running sentinel. */
export function outcomeWord(source?: OutcomeWord | SharedArrayBuffer): OutcomeWord {
  if (isInstance(source, OutcomeCell)) return source;
  const word = isBigInt64Array(source)
    ? source
    : new BigInt64ArrayConstructor(source ?? new SharedArrayBufferConstructor(8));
  if (!isSharedArrayBuffer(typedArrayBuffer(word)) || typedArrayLength(word) !== 1)
    throw new TypeError("outcome word must be one shared int64");
  return word;
}
export function serializeOutcome(source: OutcomeWord): OutcomeTransfer {
  if (isInstance(source, OutcomeCell))
    return {
      type: "outcome-cell",
      buffer: source.buffer,
      byteOffset: source.byteOffset,
      pid: source.pid,
      running: source.running,
      validity: source.validity,
    };
  if (!isSharedArrayBuffer(typedArrayBuffer(source)) || typedArrayLength(source) !== 1)
    throw new TypeError("outcome word must be one shared int64");
  return {
    type: "outcome-word",
    buffer: typedArrayBuffer(source) as SharedArrayBuffer,
    byteOffset: typedArrayByteOffset(source),
  };
}
export function reviveOutcome(source: OutcomeTransfer): OutcomeWord {
  if (isSharedArrayBuffer(source)) return outcomeWord(source);
  if (source.type === "outcome-word")
    return outcomeWord(new BigInt64ArrayConstructor(source.buffer, source.byteOffset, 1));
  if (source.type === "outcome-cell") {
    if (source.running !== BigInt(source.pid) << 3n)
      throw new TypeError("invalid outcome running sentinel");
    return new OutcomeCell(
      new BigInt64ArrayConstructor(source.buffer, source.byteOffset, 1),
      source.pid,
      source.validity,
    );
  }
  throw new TypeError("invalid outcome transfer");
}
export function processOutcome(result: Pick<ProcessExit, "kind" | "code">): ProcessExit {
  const { kind, code } = result;
  if (kind === "start-failed")
    return objectFreeze({ kind, code, error: startFailureName(code), status: null });
  return objectFreeze({ kind, code, status: kind === "signaled" ? 128 + code : code });
}
function decode(encoded: bigint): ProcessExit {
  const tag = encoded & 3n;
  if (tag === 0n) throw new ProcessError(ProcessErrno.SRCH, "outcome incarnation changed");
  return processOutcome({
    kind: tag === 1n ? "exited" : tag === 2n ? "signaled" : "start-failed",
    code: Number(encoded >> 3n),
  });
}
function cells(word: OutcomeWord): BigInt64Array {
  return isInstance(word, OutcomeCell) ? word.cells : word;
}
function running(word: OutcomeWord): bigint {
  return isInstance(word, OutcomeCell) ? word.running : 0n;
}
function load(word: OutcomeWord): bigint {
  if (isInstance(word, OutcomeCell)) word.check();
  const encoded = atomicsLoad(cells(word), 0);
  if (isInstance(word, OutcomeCell)) word.check();
  // Neither an old pending nor an old started producer may adopt a recycled row.
  if ((encoded & 3n) === 0n && (encoded & ~STARTED) !== running(word))
    throw new ProcessError(ProcessErrno.SRCH, "outcome incarnation changed");
  return encoded;
}
export function readOutcome(word: OutcomeWord): ProcessExit | null {
  const encoded = load(word);
  return (encoded & 3n) === 0n ? null : decode(encoded);
}
/** Non-consuming startup observation, independent of exit cleanup and collection. */
export function startStatus(word: OutcomeWord): number {
  const encoded = load(word);
  if (encoded & STARTED) return 0;
  if ((encoded & 3n) === 0n) return -ProcessErrno.AGAIN;
  const result = decode(encoded);
  return result.kind === "start-failed" ? startFailureErrno(result.error) : -ProcessErrno.CANCELED;
}
/** Commit executable entry against the same atomic winner as kill and startup failure.
 * The caller publishes its common wake after success, immediately before entering guest code.
 * False means a terminal winner prevented entry; a repeated live commit is harmless. */
export function markStarted(word: OutcomeWord): boolean {
  for (;;) {
    const previous = load(word);
    if ((previous & 3n) !== 0n) return false;
    if (previous & STARTED) return true;
    const observed = atomicsCompareExchange(cells(word), 0, previous, previous | STARTED);
    if (isInstance(word, OutcomeCell)) word.check();
    if (observed === previous) return true;
  }
}
/** A stale producer can only CAS its captured running sentinel, not a new occupant's.
 * STARTED is sticky, but never itself a terminal result. onClaim only runs for this
 * caller's successful terminal CAS, so host failures need not await a failed executor. */
export function claimOutcome(
  word: OutcomeWord,
  result: Pick<ProcessExit, "kind" | "code">,
  onClaim?: () => void,
): ProcessExit {
  if (!Number.isSafeInteger(result.code))
    throw new RangeError("process outcome code must be a safe integer");
  if (result.kind === "start-failed") startFailureName(result.code);
  const value =
    (BigInt(result.code) << 3n) |
    (result.kind === "exited" ? 1n : result.kind === "signaled" ? 2n : 3n);
  for (;;) {
    const previous = load(word);
    if ((previous & 3n) !== 0n) return decode(previous);
    if (result.kind === "start-failed" && previous & STARTED)
      throw new ProcessError(ProcessErrno.INVAL, "startup failure after executable entry");
    const encoded = value | (previous & STARTED);
    const observed = atomicsCompareExchange(cells(word), 0, previous, encoded);
    if (isInstance(word, OutcomeCell)) word.check();
    if (observed === previous) {
      onClaim?.();
      return decode(encoded);
    }
  }
}
