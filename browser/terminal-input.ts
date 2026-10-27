import type { Readiness } from "../core/descriptors.js";
import type { TerminalPolicy, TerminalResult, TerminalTurn } from "./terminal-session.js";
import {
  atomicsAdd,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
} from "../proc/intrinsics.ts";

const AGAIN = -6;
const BADF = -8;
const CANCELED = -11;
const NOTSUP = -58;
const HEADER_WORDS = 6;
const HEADER_BYTES = HEADER_WORDS * 4;
const DEFAULT_CAPACITY = 65536;
const H = {
  write: 0,
  read: 1,
  wake: 2,
  closed: 3,
  lock: 4,
  cancelled: 5,
} as const;

export interface TerminalInput {
  /** Shared transport passed to a worker through spawn metadata. */
  readonly buffer: SharedArrayBuffer;
  readonly notification: Int32Array;
  readonly capacity: number;
  /** Nonblocking producer operation: all bytes written, AGAIN, BADF or CANCELED. */
  push(bytes: Uint8Array): number;
  available(): number;
  /** Publishes true EOF after already queued bytes are drained. */
  close(): void;
  /** Cancels pending consumers; resume is explicit and does not reopen a closed input. */
  cancel(): void;
  resume(): void;
}

export interface TerminalInputPolicyOptions {
  readonly input: TerminalInput | SharedArrayBuffer;
  readonly tryWrite?: (target: 1 | 2, chunks: readonly Uint8Array[]) => number;
  readonly outputReadiness?: (target: 1 | 2) => Pick<Readiness, "writable">;
}

interface CookedState {
  skipLineFeed: boolean;
}

function validCapacity(capacity: number): boolean {
  return Number.isSafeInteger(capacity) && capacity > 0 && capacity <= 0x7fffffff;
}

function viewCapacity(buffer: SharedArrayBuffer): number {
  if (buffer.byteLength <= HEADER_BYTES) throw new TypeError("invalid terminal input buffer");
  const capacity = buffer.byteLength - HEADER_BYTES;
  if (!validCapacity(capacity)) throw new TypeError("invalid terminal input capacity");
  return capacity;
}

function copyInto(ring: Uint8Array, index: number, bytes: Uint8Array): void {
  const start = (index >>> 0) % ring.length;
  const first = Math.min(bytes.length, ring.length - start);
  ring.set(bytes.subarray(0, first), start);
  ring.set(bytes.subarray(first), 0);
}

function copyFrom(ring: Uint8Array, index: number, length: number): Uint8Array {
  const result = new Uint8Array(length);
  const start = (index >>> 0) % ring.length;
  const first = Math.min(length, ring.length - start);
  result.set(ring.subarray(start, start + first));
  result.set(ring.subarray(0, length - first), first);
  return result;
}

class InputBuffer implements TerminalInput {
  readonly capacity: number;
  readonly state: Int32Array;
  readonly ring: Uint8Array;
  readonly notification: Int32Array;
  constructor(readonly buffer: SharedArrayBuffer) {
    this.capacity = viewCapacity(buffer);
    this.state = new Int32ArrayConstructor(buffer, 0, HEADER_WORDS);
    this.ring = new Uint8Array(buffer, HEADER_BYTES);
    this.notification = new Int32ArrayConstructor(buffer, H.wake * 4, 1);
  }
  available(): number {
    return (atomicsLoad(this.state, H.write) - atomicsLoad(this.state, H.read)) >>> 0;
  }
  push(bytes: Uint8Array): number {
    if (!bytes.length) return 0;
    if (atomicsLoad(this.state, H.cancelled) !== 0) return CANCELED;
    if (atomicsLoad(this.state, H.closed) !== 0) return BADF;
    if (atomicsCompareExchange(this.state, H.lock, 0, 1) !== 0) return AGAIN;
    try {
      if (atomicsLoad(this.state, H.closed) !== 0) return BADF;
      if (atomicsLoad(this.state, H.cancelled) !== 0) return CANCELED;
      const write = atomicsLoad(this.state, H.write);
      const free = this.capacity - this.available();
      if (bytes.length > free) return AGAIN;
      copyInto(this.ring, write, bytes);
      atomicsStore(this.state, H.write, write + bytes.length);
      this.signal();
      return bytes.length;
    } finally {
      atomicsStore(this.state, H.lock, 0);
      atomicsNotify(this.state, H.lock);
    }
  }
  read(chunks: readonly Uint8Array[], cooked: boolean, state: CookedState): number {
    if (!chunks.some((chunk) => chunk.length)) return 0;
    if (atomicsLoad(this.state, H.cancelled) !== 0) return CANCELED;
    if (atomicsCompareExchange(this.state, H.lock, 0, 1) !== 0) return AGAIN;
    try {
      const available = this.available();
      if (!available) return atomicsLoad(this.state, H.closed) !== 0 ? 0 : AGAIN;
      const read = atomicsLoad(this.state, H.read);
      const result = cooked
        ? this.readCooked(chunks, state, read, available)
        : this.readRaw(chunks, read, available);
      atomicsStore(this.state, H.read, read + result.consumed);
      if (result.consumed) this.signal();
      return result.value;
    } finally {
      atomicsStore(this.state, H.lock, 0);
      atomicsNotify(this.state, H.lock);
    }
  }
  private readRaw(
    chunks: readonly Uint8Array[],
    read: number,
    available: number,
  ): { value: number; consumed: number } {
    const count = Math.min(available, byteLength(chunks));
    if (!count) return { value: 0, consumed: 0 };
    let offset = 0;
    let written = 0;
    for (const chunk of chunks) {
      const length = Math.min(chunk.length, count - offset);
      if (!length) break;
      chunk.set(copyFrom(this.ring, read + offset, length));
      offset += length;
      written += length;
    }
    return { value: written, consumed: written };
  }
  private readCooked(
    chunks: readonly Uint8Array[],
    state: CookedState,
    read: number,
    available: number,
  ): { value: number; consumed: number; eof: boolean } {
    let consumed = 0;
    let written = 0;
    let eof = false;
    let destination = 0;
    let offset = 0;
    while (consumed < available && destination < chunks.length) {
      while (destination < chunks.length && offset === chunks[destination]!.length) {
        destination++;
        offset = 0;
      }
      if (destination === chunks.length) break;
      const byte = this.ring[((read + consumed) >>> 0) % this.capacity]!;
      if (state.skipLineFeed && byte === 10) {
        state.skipLineFeed = false;
        consumed++;
        continue;
      }
      if (byte === 4) {
        if (written === 0) {
          consumed++;
          eof = true;
        }
        break;
      }
      state.skipLineFeed = byte === 13;
      chunks[destination]![offset++] = byte === 13 ? 10 : byte;
      consumed++;
      written++;
    }
    if (!written && consumed && !eof && atomicsLoad(this.state, H.closed) === 0)
      return { value: AGAIN, consumed, eof: false };
    return { value: written, consumed, eof };
  }
  close(): void {
    atomicsStore(this.state, H.closed, 1);
    this.signal();
  }
  cancel(): void {
    atomicsStore(this.state, H.cancelled, 1);
    this.signal();
  }
  resume(): void {
    atomicsStore(this.state, H.cancelled, 0);
    this.signal();
  }
  private signal(): void {
    atomicsAdd(this.state, H.wake, 1);
    atomicsNotify(this.state, H.wake);
  }
}

function byteLength(chunks: readonly Uint8Array[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  return total;
}

function inputBuffer(input: TerminalInput | SharedArrayBuffer): InputBuffer {
  if (input instanceof InputBuffer) return input;
  const buffer = input instanceof SharedArrayBuffer ? input : input.buffer;
  return new InputBuffer(buffer);
}

export function createTerminalInput(options: { readonly capacity?: number } = {}): TerminalInput {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  if (!validCapacity(capacity)) throw new RangeError("invalid terminal input capacity");
  return new InputBuffer(new SharedArrayBufferConstructor(HEADER_BYTES + capacity));
}

export function attachTerminalInput(buffer: SharedArrayBuffer): TerminalInput {
  return new InputBuffer(buffer);
}

export function createTerminalInputPolicy(options: TerminalInputPolicyOptions): TerminalPolicy {
  const input = inputBuffer(options.input);
  const state: CookedState = { skipLineFeed: false };
  return {
    tryRead(turn: TerminalTurn, chunks: readonly Uint8Array[]): number {
      return input.read(chunks, turn.mode === "cooked", state);
    },
    inputReadiness(): Pick<Readiness, "readable" | "nbytes"> {
      const available = input.available();
      return {
        readable: available > 0 || atomicsLoad(input.state, H.closed) !== 0,
        nbytes: available,
      };
    },
    transition(_turn, change): TerminalResult<void> {
      if (change.kind === "mode" || change.kind === "selection") state.skipLineFeed = false;
      return { kind: "ok", value: undefined };
    },
    tryWrite(target, chunks): number {
      return (
        options.tryWrite?.(target, chunks) ?? (chunks.some((chunk) => chunk.length) ? NOTSUP : 0)
      );
    },
    outputReadiness(target): Pick<Readiness, "writable"> {
      return options.outputReadiness?.(target) ?? { writable: false };
    },
  };
}
