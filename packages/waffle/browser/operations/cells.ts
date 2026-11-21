import {
  atomicsCompareExchange,
  atomicsLoad,
  BigInt64ArrayConstructor,
} from "../../proc/intrinsics/core.js";
import { BigIntConstructor } from "../../proc/intrinsics/host.js";
import type { GuestOperationBinding, OperationBinding } from "./protocol.js";

export const OPERATION_SLOTS = 16;
const ROW_WORDS = 20;
export const OPERATION_BYTES = OPERATION_SLOTS * ROW_WORDS * 8;
export const MAX_VALUE = 0xffffffff;
const MASK = 0xffffffffn;

export const PIPE_OFFSET = 0;
export const RESOLVE_OFFSET = 9;
export const ACKNOWLEDGED = 18;
export const Field = {
  sequence: 0,
  active: 1,
  started: 2,
  result: 3,
  duration: 4,
  completed: 5,
  cancelled: 6,
  failed: 7,
  timed: 8,
} as const;

export const Result = {
  completed: 1,
  signalPending: 2,
  processStop: 3,
  filesystemCancelled: 4,
  pollError: 5,
  resolveError: 6,
  transportError: 7,
  submissionError: 8,
} as const;
export type ResultName = keyof typeof Result;
export type ResultCode = (typeof Result)[ResultName];

const perfNow = performance.now.bind(performance);
const timeOrigin = performance.timeOrigin;
const trunc = Math.trunc;
const min = Math.min;
const max = Math.max;
export function operationClock(): number {
  return timeOrigin + perfNow();
}
export function elapsedFrom(origin: number, now = operationClock()): number {
  return min(MAX_VALUE, max(0, trunc(now - origin)));
}

export class OperationCells {
  readonly #words: BigInt64Array;
  readonly #tag: bigint;
  constructor(binding: OperationBinding | GuestOperationBinding) {
    this.#words = new BigInt64ArrayConstructor(
      binding.buffer,
      binding.slot * ROW_WORDS * 8,
      ROW_WORDS,
    );
    this.#tag = BigIntConstructor(binding.captureId);
  }
  read(index: number): number | undefined {
    const cell = atomicsLoad(this.#words, index);
    if (((cell >> 32n) & MASK) === this.#tag) return NumberConstructor(cell & MASK);
  }
  write(index: number, value: number): boolean {
    const previous = atomicsLoad(this.#words, index);
    if (((previous >> 32n) & MASK) !== this.#tag) return false;
    const next = (this.#tag << 32n) | BigIntConstructor(value);
    return atomicsCompareExchange(this.#words, index, previous, next) === previous;
  }
  /** Only the page changes a slot's tag. Each old producer can win at most one in-flight CAS. */
  assign(): void {
    const next = this.#tag << 32n;
    for (let index = 0; index < ROW_WORDS; index++) {
      let previous = atomicsLoad(this.#words, index);
      for (;;) {
        const actual = atomicsCompareExchange(this.#words, index, previous, next);
        if (actual === previous) break;
        previous = actual;
      }
    }
  }
}

const NumberConstructor = Number;
