import { allocateSharedControl } from "../memory/control.ts";
import { startFailureName, startFailureErrno } from "./start-errno.ts";
import { ProcessErrno, ProcessError, type ProcessExit } from "./types.ts";
import {
  packedControl,
  type CellValidity,
  type ControlCells,
  TaggedCells,
  controlLoad,
  controlStore,
  controlCas,
  serializeTaggedCells,
  reviveTaggedCells,
  type TaggedCellsTransfer,
} from "./control.ts";
import { START_DIAGNOSTIC_WORDS, diagnosticBytes, diagnosticText } from "./start-diagnostic.ts";
import {
  atomicsCompareExchange,
  atomicsLoad,
  atomicsStore,
  BigInt64ArrayConstructor,
  objectFreeze,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
  isSharedArrayBuffer,
  isBigInt64Array,
  isInstance,
  sharedArrayBufferByteLength,
  Int32ArrayConstructor,
  Uint8ArrayConstructor,
} from "./intrinsics.ts";

export interface OutcomeCellTransfer {
  type: "outcome-cell";
  buffer: SharedArrayBuffer;
  byteOffset: number;
  pid: number;
  running: bigint;
  validity: CellValidity;
  diagnostic?: TaggedCellsTransfer;
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
  readonly diagnostic?: TaggedCells;
  private readonly identity: BigInt64Array;
  constructor(cells: BigInt64Array, pid: number, validity: CellValidity, diagnostic?: TaggedCells) {
    this.cells = cells;
    this.pid = pid;
    this.validity = validity;
    this.diagnostic = diagnostic;
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
const STANDALONE_WORDS = 1 + Math.ceil((START_DIAGNOSTIC_WORDS * 4) / 8);
function diagnosticCells(word: OutcomeWord): ControlCells | undefined {
  if (isInstance(word, OutcomeCell)) return word.diagnostic;
  return standaloneDiagnostic(word);
}
function standaloneDiagnostic(word: BigInt64Array): Int32Array {
  return new Int32ArrayConstructor(
    typedArrayBuffer(word),
    typedArrayByteOffset(word) + 8,
    START_DIAGNOSTIC_WORDS,
  );
}
function writeDiagnostic(word: OutcomeWord, text: string): void {
  const cells = diagnosticCells(word);
  if (!cells || controlCas(cells, 0, 0, -1) !== 0) return;
  const bytes = diagnosticBytes(text),
    length = typedArrayLength(bytes);
  for (let offset = 0; offset < length; offset += 4) {
    const value =
      (bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24);
    controlStore(cells, 1 + offset / 4, value);
  }
  controlStore(cells, 0, length + 1);
}
function publishDiagnostic(word: OutcomeWord, text: string): void {
  try {
    writeDiagnostic(word, text);
  } catch {
    // A failed copy is complete with no text. Only a live producer may remain pending.
    settleUnavailableDiagnostic(word);
  }
}
function settleUnavailableDiagnostic(word: OutcomeWord): void {
  try {
    if (isInstance(word, OutcomeCell)) {
      if (word.diagnostic) controlStore(word.diagnostic, 0, 1);
      return;
    }
    atomicsStore(word, 1, 1n);
  } catch {
    // Collection revokes diagnostic writes along with the original process incarnation.
  }
}
/** Null means the winning producer is still copying its diagnostic. */
export function readStartDiagnostic(word: OutcomeWord): string | null {
  if (readOutcome(word)?.kind !== "start-failed") return "";
  const cells = diagnosticCells(word);
  if (!cells) return "";
  const published = controlLoad(cells);
  if (published <= 0) return null;
  const length = published - 1;
  const bytes = new Uint8ArrayConstructor(length);
  for (let offset = 0; offset < length; offset++)
    bytes[offset] = controlLoad(cells, 1 + (offset >>> 2)) >>> ((offset & 3) * 8);
  return diagnosticText(bytes);
}
/** Standalone outcomes do not recycle and use the zero running sentinel. */
export function outcomeWord(source?: OutcomeWord | SharedArrayBuffer): OutcomeWord {
  if (isInstance(source, OutcomeCell)) return source;
  const buffer = isBigInt64Array(source)
    ? typedArrayBuffer(source)
    : (source ?? allocateSharedControl(STANDALONE_WORDS * 8));
  const offset = isBigInt64Array(source) ? typedArrayByteOffset(source) : 0;
  if (
    !isSharedArrayBuffer(buffer) ||
    sharedArrayBufferByteLength(buffer) - offset < STANDALONE_WORDS * 8
  )
    throw new TypeError("standalone outcome requires its shared diagnostic storage");
  if (isBigInt64Array(source) && typedArrayLength(source) === STANDALONE_WORDS) return source;
  return new BigInt64ArrayConstructor(buffer, offset, STANDALONE_WORDS);
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
      diagnostic: source.diagnostic ? serializeTaggedCells(source.diagnostic) : undefined,
    };
  outcomeWord(source);
  const word = source;
  return {
    type: "outcome-word",
    buffer: typedArrayBuffer(word) as SharedArrayBuffer,
    byteOffset: typedArrayByteOffset(word),
  };
}
export function reviveOutcome(source: OutcomeTransfer): OutcomeWord {
  if (isSharedArrayBuffer(source)) return outcomeWord(source);
  if (source.type === "outcome-word") {
    return outcomeWord(
      new BigInt64ArrayConstructor(source.buffer, source.byteOffset, STANDALONE_WORDS),
    );
  }
  if (source.type === "outcome-cell") {
    if (source.running !== BigInt(source.pid) << 3n)
      throw new TypeError("invalid outcome running sentinel");
    return new OutcomeCell(
      new BigInt64ArrayConstructor(source.buffer, source.byteOffset, 1),
      source.pid,
      source.validity,
      source.diagnostic ? reviveTaggedCells(source.diagnostic) : undefined,
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
  diagnostic?: string,
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
    if (observed !== previous) continue;
    if (result.kind === "start-failed") publishDiagnostic(word, diagnostic ?? "");
    onClaim?.();
    return decode(encoded);
  }
}
