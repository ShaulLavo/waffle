import { ProcessErrno, ProcessError } from "./types.ts";
import {
  isInstance,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsWait,
  atomicsStore,
  atomicsAdd,
  atomicsExchange,
  BigInt64ArrayConstructor,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
} from "./intrinsics.ts";

const MASK = 0xffffffffn;
// Executors may replace the global clock with a guest polyfill. Wait deadlines
// must keep using the host's monotonic clock, independently of guest time.
const clock = performance.now.bind(performance);
export function packedControl(id: number, value: number): bigint {
  return (BigInt(id) << 32n) | BigInt(value >>> 0);
}
export interface CellValidity {
  buffer: SharedArrayBuffer;
  byteOffset: number;
  id: number;
}
export interface TaggedCellsTransfer {
  type: "tagged-cells";
  buffer: SharedArrayBuffer;
  byteOffset: number;
  length: number;
  id: number;
  validity?: CellValidity;
}
/** Captures an incarnation once. Every mutation compares the complete tagged word; a
 * suspended writer can never adopt the identity of a replacement row. */
export class TaggedCells {
  readonly cells: BigInt64Array;
  readonly id: number;
  readonly validity?: CellValidity;
  private readonly identity?: BigInt64Array;
  constructor(cells: BigInt64Array, id: number, validity?: CellValidity) {
    this.cells = cells;
    this.id = id;
    this.validity = validity;
    if (validity)
      this.identity = new BigInt64ArrayConstructor(validity.buffer, validity.byteOffset, 1);
  }
  get buffer(): SharedArrayBuffer {
    return typedArrayBuffer(this.cells) as SharedArrayBuffer;
  }
  get byteOffset(): number {
    return typedArrayByteOffset(this.cells);
  }
  get length(): number {
    return typedArrayLength(this.cells);
  }
  valid(): boolean {
    return (
      this.identity === undefined ||
      atomicsLoad(this.identity, 0) === packedControl(this.validity!.id, 1)
    );
  }
  check(): void {
    if (!this.valid())
      throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected");
  }
  private checked(value: bigint): number {
    this.check();
    if (value >> 32n !== BigInt(this.id))
      throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected");
    return Number(BigInt.asIntN(32, value & MASK));
  }
  load(index = 0): number {
    this.check();
    return this.checked(atomicsLoad(this.cells, index));
  }
  compareExchange(index: number, expected: number, replacement: number): number {
    this.check();
    return this.checked(
      atomicsCompareExchange(
        this.cells,
        index,
        packedControl(this.id, expected),
        packedControl(this.id, replacement),
      ),
    );
  }
  store(index: number, value: number): number {
    for (;;) {
      const previous = this.load(index);
      if (this.compareExchange(index, previous, value) === previous) return value;
    }
  }
  add(index: number, value: number): number {
    for (;;) {
      const previous = this.load(index);
      if (this.compareExchange(index, previous, previous + value) === previous) return previous;
    }
  }
  exchange(index: number, value: number): number {
    for (;;) {
      const previous = this.load(index);
      if (this.compareExchange(index, previous, value) === previous) return previous;
    }
  }
}
export function serializeTaggedCells(cells: TaggedCells): TaggedCellsTransfer {
  return {
    type: "tagged-cells",
    buffer: cells.buffer,
    byteOffset: cells.byteOffset,
    length: cells.length,
    id: cells.id,
    validity: cells.validity,
  };
}
export function reviveTaggedCells(source: TaggedCellsTransfer): TaggedCells {
  if (
    source.type !== "tagged-cells" ||
    !Number.isInteger(source.byteOffset) ||
    !Number.isInteger(source.length) ||
    source.length < 1
  ) {
    throw new TypeError("invalid tagged cells transfer");
  }
  return new TaggedCells(
    new BigInt64ArrayConstructor(source.buffer, source.byteOffset, source.length),
    source.id,
    source.validity,
  );
}
/** Standalone host words are never recycled. Directory words always use TaggedCells. */
export type ControlCells = Int32Array | TaggedCells;
export function controlLoad(word: ControlCells, index = 0): number {
  return isInstance(word, TaggedCells) ? word.load(index) : atomicsLoad(word, index);
}
export function controlStore(word: ControlCells, index: number, value: number): number {
  return isInstance(word, TaggedCells)
    ? word.store(index, value)
    : atomicsStore(word, index, value);
}
export function controlCas(
  word: ControlCells,
  index: number,
  expected: number,
  value: number,
): number {
  return isInstance(word, TaggedCells)
    ? word.compareExchange(index, expected, value)
    : atomicsCompareExchange(word, index, expected, value);
}
export function controlAdd(word: ControlCells, index: number, value: number): number {
  return isInstance(word, TaggedCells) ? word.add(index, value) : atomicsAdd(word, index, value);
}
export function controlExchange(word: ControlCells, index: number, value: number): number {
  return isInstance(word, TaggedCells)
    ? word.exchange(index, value)
    : atomicsExchange(word, index, value);
}
export function controlNotify(word: ControlCells, index = 0): void {
  if (isInstance(word, TaggedCells)) {
    word.load(index);
    atomicsNotify(word.cells, index);
    word.check();
  } else atomicsNotify(word, index);
}
export function controlWait(
  word: ControlCells,
  index: number,
  expected: number,
  timeout?: number,
): string {
  if (!isInstance(word, TaggedCells)) return atomicsWait(word, index, expected, timeout);
  const duration = timeout === undefined || Number.isNaN(timeout) ? Infinity : Math.max(timeout, 0);
  const deadline = clock() + duration;
  // Lifecycle retirement changes a separate word. Bound sleeps so collection between
  // validation and parking cannot leave an old incarnation asleep indefinitely.
  for (;;) {
    if (word.load(index) !== expected) return "not-equal";
    const remaining = Math.max(0, deadline - clock());
    const result = atomicsWait(
      word.cells,
      index,
      packedControl(word.id, expected),
      Math.min(remaining, 10),
    );
    word.load(index);
    if (result !== "timed-out" || clock() >= deadline) return result;
  }
}
