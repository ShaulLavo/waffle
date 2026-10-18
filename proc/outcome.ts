import type { ProcessExit } from "./types.js";

/** One atomic terminal decision: zero is running; the low bits encode the outcome kind.
 * Keeping kind and code in one cell avoids a lock or an intermediate unpublished payload.
 */
export function outcomeWord(source?: BigInt64Array | SharedArrayBuffer): BigInt64Array {
  const word = source instanceof BigInt64Array ? source : new BigInt64Array(source ?? new SharedArrayBuffer(8));
  if (!(word.buffer instanceof SharedArrayBuffer) || word.length !== 1) throw new TypeError("outcome word must be one shared int64");
  return word;
}
export function processOutcome(result: Pick<ProcessExit, "kind" | "code">): ProcessExit {
  const { kind, code } = result;
  if (kind === "start-failed") return Object.freeze({ kind, code, error: code === 2 ? "ENOENT" : "EACCES", status: null });
  return Object.freeze({ kind, code, status: kind === "signaled" ? 128 + code : code });
}
function decode(encoded: bigint): ProcessExit {
  const tag = encoded & 3n;
  return processOutcome({ kind: tag === 1n ? "exited" : tag === 2n ? "signaled" : "start-failed", code: Number(encoded >> 2n) });
}
export function readOutcome(word: BigInt64Array): ProcessExit | null {
  const encoded = Atomics.load(word, 0);
  return encoded === 0n ? null : decode(encoded);
}
/** Every producer adopts the first complete outcome; later signals cannot replace an exit. */
export function claimOutcome(word: BigInt64Array, result: Pick<ProcessExit, "kind" | "code">): ProcessExit {
  if (!Number.isSafeInteger(result.code)) throw new RangeError("process outcome code must be a safe integer");
  if (result.kind === "start-failed" && result.code !== 2 && result.code !== 13) throw new RangeError("start failure must be ENOENT or EACCES");
  const encoded = (BigInt(result.code) << 2n) | (result.kind === "exited" ? 1n : result.kind === "signaled" ? 2n : 3n);
  const previous = Atomics.compareExchange(word, 0, 0n, encoded);
  return decode(previous === 0n ? encoded : previous);
}
