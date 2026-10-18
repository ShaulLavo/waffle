import { ProcessErrno, ProcessError } from "./types.js";

const MASK = 0xffffffffn;
export function packedControl(id: number, value: number): bigint { return BigInt(id) << 32n | BigInt(value >>> 0); }
/** Captures an incarnation once. Every mutation compares the complete tagged word; a
 * suspended writer can never adopt the identity of a replacement row. */
export class TaggedCells {
  readonly cells: BigInt64Array;
  readonly id: number;
  constructor(cells: BigInt64Array, id: number) { this.cells = cells; this.id = id; }
  get buffer(): SharedArrayBuffer { return this.cells.buffer as SharedArrayBuffer; }
  get byteOffset(): number { return this.cells.byteOffset; }
  get length(): number { return this.cells.length; }
  private checked(value: bigint): number {
    if (value >> 32n !== BigInt(this.id)) throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected");
    return Number(BigInt.asIntN(32, value & MASK));
  }
  load(index = 0): number { return this.checked(Atomics.load(this.cells, index)); }
  compareExchange(index: number, expected: number, replacement: number): number {
    return this.checked(Atomics.compareExchange(this.cells, index, packedControl(this.id, expected), packedControl(this.id, replacement)));
  }
  store(index: number, value: number): number {
    for (;;) { const previous = this.load(index); if (this.compareExchange(index, previous, value) === previous) return value; }
  }
  add(index: number, value: number): number {
    for (;;) { const previous = this.load(index); if (this.compareExchange(index, previous, previous + value) === previous) return previous; }
  }
  exchange(index: number, value: number): number {
    for (;;) { const previous = this.load(index); if (this.compareExchange(index, previous, value) === previous) return previous; }
  }
}
/** Standalone host words are never recycled. Directory words always use TaggedCells. */
export type ControlCells = Int32Array | TaggedCells;
export function controlLoad(word: ControlCells, index = 0): number { return word instanceof TaggedCells ? word.load(index) : Atomics.load(word, index); }
export function controlStore(word: ControlCells, index: number, value: number): number { return word instanceof TaggedCells ? word.store(index, value) : Atomics.store(word, index, value); }
export function controlCas(word: ControlCells, index: number, expected: number, value: number): number { return word instanceof TaggedCells ? word.compareExchange(index, expected, value) : Atomics.compareExchange(word, index, expected, value); }
export function controlAdd(word: ControlCells, index: number, value: number): number { return word instanceof TaggedCells ? word.add(index, value) : Atomics.add(word, index, value); }
export function controlExchange(word: ControlCells, index: number, value: number): number { return word instanceof TaggedCells ? word.exchange(index, value) : Atomics.exchange(word, index, value); }
export function controlNotify(word: ControlCells, index = 0): void { if (word instanceof TaggedCells) Atomics.notify(word.cells, index); else Atomics.notify(word, index); }
export function controlWait(word: ControlCells, index: number, expected: number, timeout?: number): string {
  return word instanceof TaggedCells ? Atomics.wait(word.cells, index, packedControl(word.id, expected), timeout) : Atomics.wait(word, index, expected, timeout);
}
