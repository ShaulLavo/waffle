import {
  atomicsCompareExchange,
  atomicsLoad,
  atomicsStore,
  BigInt64ArrayConstructor,
  BigIntConstructor,
  DataViewConstructor,
  dataViewGetUint32,
  dataViewSetUint32,
  Int32ArrayConstructor,
  sharedArrayBufferByteLength,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
  typedArraySet,
  Uint8ArrayConstructor,
} from "../../proc/intrinsics.js";
import { gpuPayloadLayout as layout } from "../display/generated/graphics-layout.js";
import { GPU_TERMINAL, type Handle } from "./protocol.js";

const integer = Number.isInteger;

/** Shared directory reads are untrusted. The allocator keeps its own occupied ranges. */
export class PayloadDirectory {
  readonly #words: BigInt64Array;
  readonly #view: DataView;
  readonly #terminal: Int32Array;
  readonly #backing: SharedArrayBuffer;
  constructor(backing: SharedArrayBuffer) {
    if (sharedArrayBufferByteLength(backing) !== layout.byteLength)
      throw new RangeError("Invalid GPU payload backing");
    this.#backing = backing;
    this.#words = new BigInt64ArrayConstructor(
      backing,
      layout.directoryOffset,
      (layout.slots * layout.slotBytes) / 8,
    );
    this.#view = new DataViewConstructor(backing);
    this.#terminal = new Int32ArrayConstructor(backing, layout.terminalOffset, 1);
  }
  mirror(reason: number): void {
    atomicsStore(this.#terminal, 0, reason);
  }
  state(index: number): bigint {
    return atomicsLoad(this.#words, (index * layout.slotBytes) / 8);
  }
  consumed(index: number, generation: number): boolean {
    return this.state(index) === pair(generation, layout.consumed);
  }
  publish(index: number, generation: number, offset: number, length: number): void {
    const descriptor = layout.directoryOffset + index * layout.slotBytes;
    dataViewSetUint32(this.#view, descriptor + layout.offsetOffset, offset, true);
    dataViewSetUint32(this.#view, descriptor + layout.lengthOffset, length, true);
    atomicsStore(this.#words, (index * layout.slotBytes) / 8, pair(generation, layout.ready));
  }
  span(offset: number, length: number): Uint8Array {
    return new Uint8ArrayConstructor(this.#backing, offset, length);
  }
  copyOnce(
    handle: Handle,
    destination: Uint8Array,
    terminal: () => number | undefined,
    terminate: (reason: number) => number,
  ): number {
    const reason = terminal();
    if (reason) return terminalErrno(reason);
    if (
      !integer(handle.id) ||
      handle.id < 1 ||
      handle.id > layout.slots ||
      !integer(handle.generation) ||
      handle.generation < 1 ||
      handle.generation > 0xffffffff
    )
      return -8;
    const index = handle.id - 1;
    const ready = pair(handle.generation, layout.ready);
    if (this.state(index) !== ready) return -8;
    const descriptor = layout.directoryOffset + index * layout.slotBytes;
    const offset = dataViewGetUint32(this.#view, descriptor + layout.offsetOffset, true);
    const length = dataViewGetUint32(this.#view, descriptor + layout.lengthOffset, true);
    if (
      offset < layout.dataOffset ||
      offset > layout.byteLength ||
      length > layout.byteLength - offset
    )
      return -8;
    if (typedArrayLength(destination) < length) return -42;
    const word = (index * layout.slotBytes) / 8;
    if (
      atomicsCompareExchange(this.#words, word, ready, pair(handle.generation, layout.reading)) !==
      ready
    )
      return -8;
    // This authoritative load admits the synchronous copy, even if terminal wins just afterward.
    const selected = terminal();
    if (selected) return terminalErrno(selected);
    try {
      const target = new Uint8ArrayConstructor(
        typedArrayBuffer(destination),
        typedArrayByteOffset(destination),
        length,
      );
      typedArraySet(target, this.span(offset, length));
    } catch {
      return terminalErrno(terminate(GPU_TERMINAL.service));
    }
    atomicsStore(this.#words, word, pair(handle.generation, layout.consumed));
    return 0;
  }
}
export function terminalErrno(reason: number): number {
  return reason === GPU_TERMINAL.resource ? -48 : -64;
}
function pair(generation: number, state: number): bigint {
  return (BigIntConstructor(generation | 0) << 32n) | BigIntConstructor(state);
}
