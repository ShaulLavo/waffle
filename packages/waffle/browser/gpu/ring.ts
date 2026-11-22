import {
  atomicsAdd,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  atomicsWait,
  atomicsWaitAsync,
  BigInt64ArrayConstructor,
  BigIntConstructor,
  DataViewConstructor,
  dataViewGetUint32,
  dataViewSetUint32,
  Int32ArrayConstructor,
  objectFreeze,
  reflectApply,
  sharedArrayBufferByteLength,
  SharedArrayBufferConstructor,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
  typedArraySet,
  Uint8ArrayConstructor,
} from "../../proc/intrinsics.js";

import { descriptor } from "../../proc/intrinsics/core.js";

export const RECORD_RING_HEADER_BYTES = 64;

// The first eight bytes are one atomic word: low 32 bits head, high 32 bits
// terminal reason. Never access it through narrower views: closure and record
// publication arbitrate through the same i64 CAS without taking the writer lock.
const TAIL = 2;
const WRITER = 3;
const WAKE = 4;
const COMMON_HEADER_BYTES = 8;
const WAIT_SLICE_MS = 10;
const integer = Number.isInteger;
const NumberConstructor = Number;
const minimum = Math.min;
const RangeErrorConstructor = RangeError;
const ErrorConstructor = Error;
const growableGetter = SharedArrayBufferConstructor
  ? descriptor(SharedArrayBufferConstructor.prototype, "growable")?.get
  : undefined;

export interface RingTerminal {
  readonly kind: "terminal";
  /** Opaque, nonzero u32 selected once by the connection owner. */
  readonly reason: number;
}

export type RingWriteResult =
  | { readonly kind: "written" }
  | { readonly kind: "full" }
  | RingTerminal;

export interface RingWriter {
  /** One bounded attempt. A full result may still have published end padding. */
  tryWrite(record: Uint8Array): RingWriteResult;
  /** Idempotent. Never steal a lease from a physically interrupted producer. */
  release(): void;
}

export type RingAcquireResult =
  | { readonly kind: "acquired"; readonly writer: RingWriter }
  | { readonly kind: "busy" }
  | RingTerminal;

export type RingReadResult =
  | { readonly kind: "record"; readonly bytes: number }
  | { readonly kind: "short"; readonly required: number }
  | { readonly kind: "empty" }
  | RingTerminal;

export type RingWaitResult = "ok" | "not-equal" | "timed-out" | "terminal";

/**
 * Multiple serialized producers, exactly one consumer. Backing must already be
 * accounted, zero-initialized, fixed, and exclusively assigned to this ring.
 * Attachments never reset it. No private views leave this object.
 *
 * Header: publication i64 at byte 0; tail i32 at byte 8; writer lock i32 at
 * byte 12; wake i32 at byte 16; bytes 20..63 are reserved. Capacity is a power
 * of two in [8, 2^30], and at least recordHeaderBytes. Power-of-two geometry keeps u32 rollover continuous.
 * Records have a common little-endian u16 kind, u16 flags, u32 whole length.
 * Whole lengths include eight-byte alignment padding. Kind zero is ring-owned
 * padding; ordinary commands need 8 bytes, completions need 16.
 *
 * Framing/counter corruption throws. The connection owner selects its terminal
 * reason. In particular, this module owns neither allocation nor service policy.
 */
export class RecordRing {
  readonly capacity: number;
  readonly recordHeaderBytes: 8 | 16;
  readonly #cells: Int32Array;
  readonly #publication: BigInt64Array;
  readonly #data: Uint8Array;
  readonly #view: DataView;

  constructor(backing: SharedArrayBuffer, recordHeaderBytes: 8 | 16) {
    const bytes = sharedArrayBufferByteLength(backing);
    const capacity = bytes - RECORD_RING_HEADER_BYTES;
    if (growableGetter && reflectApply(growableGetter, backing, []))
      throw new RangeErrorConstructor("record ring backing must be fixed");
    if (recordHeaderBytes !== 8 && recordHeaderBytes !== 16)
      throw new RangeErrorConstructor("record ring header must be 8 or 16 bytes");
    if (capacity < recordHeaderBytes || capacity >= 0x80000000 || (capacity & (capacity - 1)) !== 0)
      throw new RangeErrorConstructor("record ring capacity must be a power of two below 2^31");
    this.capacity = capacity;
    this.recordHeaderBytes = recordHeaderBytes;
    this.#cells = new Int32ArrayConstructor(backing, 0, RECORD_RING_HEADER_BYTES / 4);
    this.#publication = new BigInt64ArrayConstructor(backing, 0, 1);
    this.#data = new Uint8ArrayConstructor(backing, RECORD_RING_HEADER_BYTES, capacity);
    this.#view = new DataViewConstructor(backing, RECORD_RING_HEADER_BYTES, capacity);
  }

  /** Snapshot before checking readiness, then wait on this value if not ready. */
  sequence(): number {
    return atomicsLoad(this.#cells, WAKE);
  }

  terminal(): RingTerminal | undefined {
    return terminalFrom(atomicsLoad(this.#publication, 0));
  }

  /** First reason wins. Does not wait for, release, or reuse the writer's lock. */
  terminate(reason: number): RingTerminal {
    if (!integer(reason) || reason <= 0 || reason > 0xffffffff)
      throw new RangeErrorConstructor("terminal reason must be a nonzero u32");
    let observed = atomicsLoad(this.#publication, 0);
    for (;;) {
      const existing = NumberConstructor((observed >> 32n) & 0xffffffffn);
      if (existing !== 0) {
        this.#wake();
        return { kind: "terminal", reason: existing };
      }
      const terminal = (BigIntConstructor(reason | 0) << 32n) | (observed & 0xffffffffn);
      const previous = atomicsCompareExchange(this.#publication, 0, observed, terminal);
      if (previous === observed) {
        this.#wake();
        return { kind: "terminal", reason };
      }
      observed = previous;
    }
  }

  tryAcquireWriter(): RingAcquireResult {
    const terminal = this.terminal();
    if (terminal) return terminal;
    const lock = atomicsCompareExchange(this.#cells, WRITER, 0, 1);
    if (lock === 1) return { kind: "busy" };
    if (lock !== 0) throw new ErrorConstructor("corrupt record ring writer lock");
    let released = false;
    const writer: RingWriter = objectFreeze({
      tryWrite: (record: Uint8Array) => {
        if (released) throw new ErrorConstructor("record ring writer lease was released");
        return this.#write(record);
      },
      release: () => {
        if (released) return;
        released = true;
        atomicsStore(this.#cells, WRITER, 0);
        this.#wake();
      },
    });
    return { kind: "acquired", writer };
  }

  /**
   * Copies one whole record, including its header, into caller-owned storage.
   * Short destinations never consume the record. Committed records drain before
   * the terminal result. At most one trailing padding record is skipped.
   */
  readInto(destination: Uint8Array): RingReadResult {
    const output = this.#externalView(destination);
    let tail = atomicsLoad(this.#cells, TAIL) >>> 0;
    const publication = atomicsLoad(this.#publication, 0);
    const head = NumberConstructor(publication & 0xffffffffn);
    let used = this.#distance(head, tail);
    if (used === 0) return terminalFrom(publication) ?? { kind: "empty" };
    let offset = tail & (this.capacity - 1);
    let length = this.#recordLength(offset, used);
    const prefix = dataViewGetUint32(this.#view, offset, true);
    if ((prefix & 0xffff) === 0) {
      if (prefix !== 0 || length !== this.capacity - offset)
        throw new ErrorConstructor("corrupt record ring padding");
      tail = (tail + length) >>> 0;
      this.#consume(tail);
      used -= length;
      if (used === 0) return terminalFrom(publication) ?? { kind: "empty" };
      offset = 0;
      length = this.#recordLength(offset, used);
    }
    if ((dataViewGetUint32(this.#view, offset, true) & 0xffff) === 0)
      throw new ErrorConstructor("consecutive record ring padding");
    if (length < this.recordHeaderBytes) throw new ErrorConstructor("truncated record ring header");
    if (typedArrayLength(output) < length) return { kind: "short", required: length };
    const source = new Uint8ArrayConstructor(
      typedArrayBuffer(this.#data),
      RECORD_RING_HEADER_BYTES + offset,
      length,
    );
    typedArraySet(output, source);
    this.#consume((tail + length) >>> 0);
    return { kind: "record", bytes: length };
  }

  /**
   * One synchronous sleep, capped at 10 ms even for Infinity. The guest wrapper
   * owns the deadline/retry loop and must supply its captured liveness check.
   * Wakes are hints; always rescan readiness. No message delivery is required.
   */
  wait(seen: number, timeoutMs: number, checkLiveness: () => void): RingWaitResult {
    const timeout = waitSlice(seen, timeoutMs);
    checkLiveness();
    if (this.terminal()) return "terminal";
    const result = atomicsWait(this.#cells, WAKE, seen, timeout);
    checkLiveness();
    return this.terminal() ? "terminal" : result;
  }

  /** A single bounded native async wait, not a per-connection service loop. */
  waitAsync(seen: number, timeoutMs: number): ReturnType<typeof atomicsWaitAsync> {
    const timeout = waitSlice(seen, timeoutMs);
    if (this.terminal()) return { async: false, value: "terminal" };
    return atomicsWaitAsync(this.#cells, WAKE, seen, timeout);
  }

  #write(record: Uint8Array): RingWriteResult {
    const terminal = this.terminal();
    if (terminal) return terminal;
    const source = this.#externalView(record);
    const length = typedArrayLength(source);
    if (length < this.recordHeaderBytes || length > this.capacity || length % 8 !== 0)
      throw new RangeErrorConstructor("record does not fit the ring's aligned framing");
    const sourceView = new DataViewConstructor(
      typedArrayBuffer(source),
      typedArrayByteOffset(source),
      length,
    );
    if (
      (dataViewGetUint32(sourceView, 0, true) & 0xffff) === 0 ||
      dataViewGetUint32(sourceView, 4, true) !== length
    )
      throw new RangeErrorConstructor("invalid record ring source header");
    const head = NumberConstructor(atomicsLoad(this.#publication, 0) & 0xffffffffn);
    const tail = atomicsLoad(this.#cells, TAIL) >>> 0;
    const free = this.capacity - this.#distance(head, tail);
    const offset = head & (this.capacity - 1);
    const remainder = this.capacity - offset;
    const padding = length > remainder ? remainder : 0;
    if (free < padding || (padding === 0 && free < length)) return { kind: "full" };
    if (padding > 0) {
      dataViewSetUint32(this.#view, offset, 0, true);
      dataViewSetUint32(this.#view, offset + 4, padding, true);
      if (free < padding + length) {
        const stopped = this.#publish(head, padding);
        return stopped ?? { kind: "full" };
      }
    }
    const at = padding > 0 ? 0 : offset;
    typedArraySet(this.#data, source, at);
    // A caller may supply shared payload memory. Validate the copied prefix too;
    // racing source mutation must never publish an invalid record boundary.
    if (
      (dataViewGetUint32(this.#view, at, true) & 0xffff) === 0 ||
      dataViewGetUint32(this.#view, at + 4, true) !== length
    )
      throw new RangeErrorConstructor("record ring source header changed during copying");
    return this.#publish(head, padding + length) ?? { kind: "written" };
  }

  #publish(head: number, bytes: number): RingTerminal | undefined {
    const previous = atomicsCompareExchange(
      this.#publication,
      0,
      BigIntConstructor(head),
      BigIntConstructor((head + bytes) >>> 0),
    );
    if (previous === BigIntConstructor(head)) {
      this.#wake();
      return undefined;
    }
    const terminal = this.terminal();
    if (terminal) return terminal;
    throw new ErrorConstructor("record ring head changed outside its writer lease");
  }

  #distance(head: number, tail: number): number {
    const used = (head - tail) >>> 0;
    if (head % 8 !== 0 || tail % 8 !== 0 || used > this.capacity)
      throw new ErrorConstructor("corrupt record ring counters");
    return used;
  }

  #recordLength(offset: number, used: number): number {
    const length = dataViewGetUint32(this.#view, offset + 4, true);
    if (length < COMMON_HEADER_BYTES || length % 8 !== 0 || length > used)
      throw new ErrorConstructor("corrupt record ring length");
    if (length > this.capacity - offset)
      throw new ErrorConstructor("record ring record crosses the end");
    return length;
  }

  #externalView(bytes: Uint8Array): Uint8Array {
    const backing = typedArrayBuffer(bytes);
    if (backing === typedArrayBuffer(this.#data))
      throw new RangeErrorConstructor("record ring input/output cannot alias its backing");
    // Captured TypedArray.set uses internal slots, not these views' mutable
    // getters or species. There is no need to allocate another payload view.
    return bytes;
  }

  #consume(tail: number): void {
    atomicsStore(this.#cells, TAIL, tail);
    this.#wake();
  }

  #wake(): void {
    atomicsAdd(this.#cells, WAKE, 1);
    atomicsNotify(this.#cells, WAKE);
  }
}

function terminalFrom(publication: bigint): RingTerminal | undefined {
  const reason = NumberConstructor((publication >> 32n) & 0xffffffffn);
  return reason === 0 ? undefined : { kind: "terminal", reason };
}

function waitSlice(seen: number, timeoutMs: number): number {
  if (!integer(seen) || seen < -0x80000000 || seen > 0x7fffffff)
    throw new RangeErrorConstructor("record ring wake sample must be an i32");
  if (!(timeoutMs >= 0)) throw new RangeErrorConstructor("record ring wait timeout is invalid");
  return minimum(timeoutMs, WAIT_SLICE_MS);
}
