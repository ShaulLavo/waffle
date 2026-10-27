import type { Readiness } from "../core/descriptors.js";
import {
  TERMINAL_SESSION_LIMITS,
  type TerminalDisplay,
  type TerminalPolicy,
  type TerminalResult,
  type TerminalTurn,
} from "./terminal-session.js";
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
const HEADER_WORDS = 10;
const HEADER_BYTES = HEADER_WORDS * 4;
const DEFAULT_CAPACITY = 65536;
const H = {
  write: 0,
  read: 1,
  wake: 2,
  closed: 3,
  lock: 4,
  cancelled: 5,
  cookedReady: 6,
  cookedEnd: 7,
  cookedOutputEnd: 8,
  skipLineFeed: 9,
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
  cancelled(): boolean;
}

export interface TerminalInputPolicyOptions {
  readonly input: TerminalInput | SharedArrayBuffer;
  readonly tryWrite?: (target: 1 | 2, chunks: readonly Uint8Array[]) => number;
  readonly outputReadiness?: (target: 1 | 2) => Pick<Readiness, "writable">;
}

interface CookedRecord {
  readonly end: number;
  readonly outputEnd: number;
  readonly skipLineFeed: boolean;
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
  cancelled(): boolean {
    return atomicsLoad(this.state, H.cancelled) !== 0;
  }
  push(bytes: Uint8Array): number {
    if (!bytes.length) return 0;
    if (this.cancelled()) return CANCELED;
    if (atomicsLoad(this.state, H.closed) !== 0) return BADF;
    if (atomicsCompareExchange(this.state, H.lock, 0, 1) !== 0) return AGAIN;
    try {
      if (atomicsLoad(this.state, H.closed) !== 0) return BADF;
      if (this.cancelled()) return CANCELED;
      const write = atomicsLoad(this.state, H.write);
      if (bytes.length > this.capacity - this.available()) return AGAIN;
      copyInto(this.ring, write, bytes);
      atomicsStore(this.state, H.write, write + bytes.length);
      this.signal();
      return bytes.length;
    } finally {
      atomicsStore(this.state, H.lock, 0);
      atomicsNotify(this.state, H.lock);
    }
  }
  read(chunks: readonly Uint8Array[], cooked: boolean): number {
    if (!chunks.some((chunk) => chunk.length)) return 0;
    if (this.cancelled()) return CANCELED;
    if (atomicsCompareExchange(this.state, H.lock, 0, 1) !== 0) return AGAIN;
    try {
      if (this.cancelled()) return CANCELED;
      return cooked ? this.readCooked(chunks) : this.readRaw(chunks);
    } finally {
      atomicsStore(this.state, H.lock, 0);
      atomicsNotify(this.state, H.lock);
    }
  }
  inputReady(cooked: boolean): boolean {
    if (this.cancelled()) return true;
    if (atomicsLoad(this.state, H.closed) !== 0 && this.available() === 0) return true;
    if (!cooked) return this.available() > 0;
    if (atomicsLoad(this.state, H.cookedReady) !== 0) return true;
    return this.cookedRecord() !== undefined;
  }
  resetCooked(): void {
    atomicsStore(this.state, H.cookedReady, 0);
    atomicsStore(this.state, H.cookedEnd, atomicsLoad(this.state, H.read));
    atomicsStore(this.state, H.cookedOutputEnd, atomicsLoad(this.state, H.read));
    atomicsStore(this.state, H.skipLineFeed, 0);
  }
  private readRaw(chunks: readonly Uint8Array[]): number {
    const read = atomicsLoad(this.state, H.read);
    const count = Math.min(this.available(), byteLength(chunks));
    if (!count) return atomicsLoad(this.state, H.closed) !== 0 ? 0 : AGAIN;
    let offset = 0;
    for (const chunk of chunks) {
      const length = Math.min(chunk.length, count - offset);
      if (!length) break;
      chunk.set(copyFrom(this.ring, read + offset, length));
      offset += length;
    }
    atomicsStore(this.state, H.read, read + offset);
    this.signal();
    return offset;
  }
  private readCooked(chunks: readonly Uint8Array[]): number {
    let read = atomicsLoad(this.state, H.read);
    if (atomicsLoad(this.state, H.skipLineFeed) !== 0) {
      if (this.available() === 0) return atomicsLoad(this.state, H.closed) !== 0 ? 0 : AGAIN;
      if (this.byteAt(read) === 10) {
        atomicsStore(this.state, H.read, read + 1);
        read++;
        this.signal();
      }
      atomicsStore(this.state, H.skipLineFeed, 0);
    }
    if (atomicsLoad(this.state, H.cookedReady) === 0) {
      const record = this.cookedRecord();
      if (!record) return atomicsLoad(this.state, H.closed) !== 0 ? 0 : AGAIN;
      atomicsStore(this.state, H.cookedEnd, record.end);
      atomicsStore(this.state, H.cookedOutputEnd, record.outputEnd);
      atomicsStore(this.state, H.skipLineFeed, record.skipLineFeed ? 1 : 0);
      atomicsStore(this.state, H.cookedReady, 1);
    }
    const outputEnd = atomicsLoad(this.state, H.cookedOutputEnd);
    const end = atomicsLoad(this.state, H.cookedEnd);
    let written = 0;
    let position = read;
    let destination = 0;
    let offset = 0;
    while (position < outputEnd && destination < chunks.length) {
      while (destination < chunks.length && offset === chunks[destination]!.length) {
        destination++;
        offset = 0;
      }
      if (destination === chunks.length) break;
      const byte = this.byteAt(position);
      if (byte === 13 && position + 1 < outputEnd && this.byteAt(position + 1) === 10) {
        chunks[destination]![offset++] = 10;
        position += 2;
      } else {
        chunks[destination]![offset++] = byte === 13 ? 10 : byte;
        position++;
      }
      written++;
    }
    atomicsStore(this.state, H.read, position);
    if (position === outputEnd && end !== outputEnd) {
      atomicsStore(this.state, H.read, end);
      position = end;
    }
    if (position === end) {
      atomicsStore(this.state, H.cookedReady, 0);
      this.signal();
    }
    if (!written && position === end) return 0;
    if (written) this.signal();
    return written;
  }
  private cookedRecord(): CookedRecord | undefined {
    const read = atomicsLoad(this.state, H.read);
    const available = this.available();
    const closed = atomicsLoad(this.state, H.closed) !== 0;
    if (!available) return closed ? { end: read, outputEnd: read, skipLineFeed: false } : undefined;
    for (let offset = 0; offset < available; offset++) {
      const byte = this.byteAt(read + offset);
      if (byte === 4) {
        if (offset === 0) return { end: read + 1, outputEnd: read, skipLineFeed: false };
        return {
          end: read + offset + 1,
          outputEnd: read + offset,
          skipLineFeed: false,
        };
      }
      if (byte === 10)
        return {
          end: read + offset + 1,
          outputEnd: read + offset + 1,
          skipLineFeed: false,
        };
      if (byte !== 13) continue;
      if (offset + 1 < available) {
        const hasLineFeed = this.byteAt(read + offset + 1) === 10;
        return {
          end: read + offset + (hasLineFeed ? 2 : 1),
          outputEnd: read + offset + 1,
          skipLineFeed: false,
        };
      }
      return {
        end: read + offset + 1,
        outputEnd: read + offset + 1,
        skipLineFeed: !closed,
      };
    }
    return closed
      ? { end: read + available, outputEnd: read + available, skipLineFeed: false }
      : undefined;
  }
  private byteAt(index: number): number {
    return this.ring[(index >>> 0) % this.capacity]!;
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

export function pushTerminalInput(
  display: TerminalDisplay,
  input: TerminalInput,
  bytes: Uint8Array,
): TerminalResult<number> {
  let offset = 0;
  while (offset < bytes.length) {
    const end = Math.min(offset + TERMINAL_SESSION_LIMITS.inputBytesPerTurn, bytes.length);
    const result = display.input(() => input.push(bytes.subarray(offset, end)));
    if (result.kind === "error") return result;
    if (result.value !== end - offset) return { kind: "error", code: "INVALID" };
    offset = end;
  }
  return { kind: "ok", value: offset };
}

export function createTerminalInputPolicy(options: TerminalInputPolicyOptions): TerminalPolicy {
  const input = inputBuffer(options.input);
  return {
    tryRead(turn: TerminalTurn, chunks: readonly Uint8Array[]): number {
      return input.read(chunks, turn.mode === "cooked");
    },
    inputReadiness(turn): Pick<Readiness, "readable" | "nbytes"> {
      const available = input.available();
      return { readable: input.inputReady(turn.mode === "cooked"), nbytes: available };
    },
    transition(_turn, change): TerminalResult<void> {
      if (change.kind === "mode" || change.kind === "selection") input.resetCooked();
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
