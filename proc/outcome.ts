import { startFailureName } from "./start-errno.ts";
import { ProcessErrno, ProcessError, type ProcessExit } from "./types.ts";

/** An outcome's running sentinel and record identity are captured, never readopted. */
export class OutcomeCell {
  readonly running: bigint;
  readonly cells: BigInt64Array;
  readonly pid: number;
  readonly valid: () => boolean;
  constructor(cells: BigInt64Array, pid: number, valid: () => boolean) { this.cells = cells; this.pid = pid; this.valid = valid; this.running = BigInt(pid) << 2n; }
  get buffer(): SharedArrayBuffer { return this.cells.buffer as SharedArrayBuffer; }
  get byteOffset(): number { return this.cells.byteOffset; }
  check(): void { if (!this.valid()) throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected"); }
}
export type OutcomeWord = BigInt64Array | OutcomeCell;
/** Standalone outcomes do not recycle and use the zero running sentinel. */
export function outcomeWord(source?: OutcomeWord | SharedArrayBuffer): OutcomeWord {
  if (source instanceof OutcomeCell) return source;
  const word = source instanceof BigInt64Array ? source : new BigInt64Array(source ?? new SharedArrayBuffer(8));
  if (!(word.buffer instanceof SharedArrayBuffer) || word.length !== 1) throw new TypeError("outcome word must be one shared int64");
  return word;
}
export function processOutcome(result: Pick<ProcessExit, "kind" | "code">): ProcessExit {
  const { kind, code } = result;
  if (kind === "start-failed") return Object.freeze({ kind, code, error: startFailureName(code), status: null });
  return Object.freeze({ kind, code, status: kind === "signaled" ? 128 + code : code });
}
function decode(encoded: bigint): ProcessExit {
  const tag = encoded & 3n;
  if (tag === 0n) throw new ProcessError(ProcessErrno.SRCH, "outcome incarnation changed");
  return processOutcome({ kind: tag === 1n ? "exited" : tag === 2n ? "signaled" : "start-failed", code: Number(encoded >> 2n) });
}
export function readOutcome(word: OutcomeWord): ProcessExit | null {
  if (word instanceof OutcomeCell) word.check();
  const encoded = Atomics.load(word instanceof OutcomeCell ? word.cells : word, 0);
  if (word instanceof OutcomeCell) word.check();
  return encoded === (word instanceof OutcomeCell ? word.running : 0n) ? null : decode(encoded);
}
/** A stale producer can only CAS its captured running sentinel, not a new occupant's. */
export function claimOutcome(word: OutcomeWord, result: Pick<ProcessExit, "kind" | "code">): ProcessExit {
  if (!Number.isSafeInteger(result.code)) throw new RangeError("process outcome code must be a safe integer");
  if (result.kind === "start-failed") startFailureName(result.code);
  if (word instanceof OutcomeCell) word.check();
  const encoded = (BigInt(result.code) << 2n) | (result.kind === "exited" ? 1n : result.kind === "signaled" ? 2n : 3n);
  const running = word instanceof OutcomeCell ? word.running : 0n;
  const previous = Atomics.compareExchange(word instanceof OutcomeCell ? word.cells : word, 0, running, encoded);
  if (word instanceof OutcomeCell) word.check();
  return decode(previous === running ? encoded : previous);
}
