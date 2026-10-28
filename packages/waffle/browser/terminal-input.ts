import { assertTerminalWaitAllowed } from "../proc/terminal-turn.js";
import type { Readiness } from "../core/descriptors.js";
import {
  TERMINAL_SESSION_LIMITS,
  type TerminalDisplay,
  type TerminalFailure,
  type TerminalPolicy,
  type TerminalResult,
  type TerminalTurn,
  terminalInputSection,
} from "./terminal-session.js";
import {
  atomicsAdd,
  atomicsWaitAsyncBigInt,
  atomicsWaitAsync,
  PromiseConstructor,
  afterNativePromise,
  abortSignalAborted,
  listenAbort,
  unlistenAbort,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  BigInt64ArrayConstructor,
  Uint32ArrayConstructor,
  cryptoGetRandomValues,
  typedArraySet,
  typedArrayLength,
  typedArraySubarray,
  sharedArrayBufferByteLength,
  Uint8ArrayConstructor,
  isInstance,
  isSharedArrayBuffer,
} from "../proc/intrinsics.ts";

const AGAIN = -6;
const BADF = -8;
const CANCELED = -11;
const NOTSUP = -58;
const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 4;
const DEFAULT_CAPACITY = 65536;
const H = {
  write: 0,
  read: 1,
  wake: 2,
  closed: 3,
  lock: 4,
  cancelled: 6,
  cookedReady: 7,
  cookedEnd: 8,
  cookedOutputEnd: 9,
  skipLineFeed: 10,
  poisoned: 11,
  nonce: 12,
  nextToken: 14,
} as const;

export interface TerminalInputObservation {
  /** Advisory data/lock wake; does not consume bytes. All native registrations join before return. */
  wait(options?: { readonly signal?: AbortSignal }): Promise<TerminalResult<void>>;
}
export interface TerminalInput {
  /** Shared transport passed to a worker through spawn metadata. */
  readonly buffer: SharedArrayBuffer;
  readonly notification: Int32Array;
  readonly capacity: number;
  /** Nonblocking producer operation: all bytes written, AGAIN, BADF or CANCELED. */
  push(bytes: Uint8Array): number;
  available(): number;
  /** Observe before a bounded read attempt; wait outside the granted turn if needed. */
  observe(): TerminalInputObservation;
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

export type TerminalInputPushResult =
  | { readonly kind: "ok"; readonly value: number }
  | { readonly kind: "error"; readonly code: TerminalFailure; readonly accepted: number };

interface CookedRecord {
  readonly end: number;
  readonly outputEnd: number;
  readonly skipLineFeed: boolean;
}

function validCapacity(capacity: number): boolean {
  return Number.isSafeInteger(capacity) && capacity > 0 && capacity <= 0x7fffffff;
}

function viewCapacity(buffer: SharedArrayBuffer): number {
  const capacity = sharedArrayBufferByteLength(buffer) - HEADER_BYTES;
  if (capacity <= 0) throw new TypeError("invalid terminal input buffer");
  if (!validCapacity(capacity)) throw new TypeError("invalid terminal input capacity");
  return capacity;
}

function copyInto(ring: Uint8Array, index: number, bytes: Uint8Array): void {
  const capacity = typedArrayLength(ring);
  const start = (index >>> 0) % capacity;
  const first = Math.min(typedArrayLength(bytes), capacity - start);
  typedArraySet(ring, typedArraySubarray(bytes, 0, first), start);
  typedArraySet(ring, typedArraySubarray(bytes, first), 0);
}

function copyFrom(ring: Uint8Array, index: number, length: number): Uint8Array {
  const result = new Uint8ArrayConstructor(length);
  const capacity = typedArrayLength(ring);
  const start = (index >>> 0) % capacity;
  const first = Math.min(length, capacity - start);
  typedArraySet(result, typedArraySubarray(ring, start, start + first));
  typedArraySet(result, typedArraySubarray(ring, 0, length - first), first);
  return result;
}

function hasBytes(chunks: readonly Uint8Array[]): boolean {
  for (let index = 0; index < chunks.length; index++)
    if (typedArrayLength(chunks[index]!) > 0) return true;
  return false;
}

class InputBuffer implements TerminalInput {
  readonly capacity: number;
  readonly state: Int32Array;
  readonly ring: Uint8Array;
  readonly notification: Int32Array;
  readonly lock: BigInt64Array;
  readonly identity: BigInt64Array;
  constructor(readonly buffer: SharedArrayBuffer) {
    this.capacity = viewCapacity(buffer);
    this.state = new Int32ArrayConstructor(buffer, 0, HEADER_WORDS);
    this.ring = new Uint8ArrayConstructor(buffer, HEADER_BYTES);
    this.notification = new Int32ArrayConstructor(buffer, H.wake * 4, 1);
    this.lock = new BigInt64ArrayConstructor(buffer, H.lock * 4, 1);
    this.identity = new BigInt64ArrayConstructor(buffer, H.nonce * 4, 2);
  }
  available(): number {
    return (atomicsLoad(this.state, H.write) - atomicsLoad(this.state, H.read)) >>> 0;
  }
  observe(): TerminalInputObservation {
    return new InputObservation(this, atomicsLoad(this.notification, 0), atomicsLoad(this.lock, 0));
  }
  cancelled(): boolean {
    return atomicsLoad(this.state, H.cancelled) !== 0;
  }
  push(bytes: Uint8Array): number {
    if (atomicsLoad(this.state, H.poisoned) !== 0) return BADF;
    const length = typedArrayLength(bytes);
    if (!length) return 0;
    if (this.cancelled()) return CANCELED;
    if (atomicsLoad(this.state, H.closed) !== 0) return BADF;
    if (atomicsCompareExchange(this.lock, 0, 0n, 1n) !== 0n) return AGAIN;
    try {
      if (atomicsLoad(this.state, H.closed) !== 0) return BADF;
      if (this.cancelled()) return CANCELED;
      const write = atomicsLoad(this.state, H.write);
      if (length > this.capacity - this.available()) return AGAIN;
      copyInto(this.ring, write, bytes);
      atomicsStore(this.state, H.write, write + length);
      this.signal();
      return length;
    } finally {
      atomicsStore(this.lock, 0, 0n);
      atomicsNotify(this.lock, 0);
    }
  }
  read(turn: TerminalTurn, chunks: readonly Uint8Array[], cooked: boolean): number {
    if (atomicsLoad(this.state, H.poisoned) !== 0) return BADF;
    if (!hasBytes(chunks)) return 0;
    if (this.cancelled()) return CANCELED;
    const token = atomicsAdd(this.identity, 1, 1n) + 1n;
    if (token <= 1n) {
      this.poison();
      return BADF;
    }
    return terminalInputSection(turn, atomicsLoad(this.identity, 0), token, () =>
      this.lockedRead(chunks, cooked, token),
    );
  }
  private lockedRead(chunks: readonly Uint8Array[], cooked: boolean, token: bigint): number {
    if (atomicsCompareExchange(this.lock, 0, 0n, token) !== 0n) return AGAIN;
    try {
      if (atomicsLoad(this.state, H.poisoned) !== 0) return BADF;
      if (this.cancelled()) return CANCELED;
      return cooked ? this.readCooked(chunks) : this.readRaw(chunks);
    } finally {
      atomicsStore(this.lock, 0, 0n);
      atomicsNotify(this.lock, 0);
    }
  }
  inputReady(cooked: boolean): boolean {
    if (atomicsLoad(this.state, H.poisoned) !== 0) return true;
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
  }
  resetModeRecord(): void {
    this.resetCooked();
  }
  private readRaw(chunks: readonly Uint8Array[]): number {
    const read = atomicsLoad(this.state, H.read);
    let remaining = this.available();
    if (!remaining) return atomicsLoad(this.state, H.closed) !== 0 ? 0 : AGAIN;
    let offset = 0;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const capacity = typedArrayLength(chunk);
      if (!capacity) continue;
      const length = Math.min(capacity, remaining);
      if (!length) break;
      typedArraySet(chunk, copyFrom(this.ring, read + offset, length));
      offset += length;
      remaining -= length;
    }
    atomicsStore(this.state, H.read, read + offset);
    if (offset > 0) atomicsStore(this.state, H.skipLineFeed, 0);
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
      while (destination < chunks.length && offset === typedArrayLength(chunks[destination]!)) {
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
  poison(): void {
    atomicsStore(this.state, H.poisoned, 1);
    this.signal();
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

class InputObservation implements TerminalInputObservation {
  private used = false;
  constructor(
    private readonly input: InputBuffer,
    private readonly sequence: number,
    private readonly owner: bigint,
  ) {}
  async wait(options: { readonly signal?: AbortSignal } = {}): Promise<TerminalResult<void>> {
    assertTerminalWaitAllowed();
    if (this.used) return { kind: "error", code: "INVALID" };
    this.used = true;
    const signal = options.signal;
    const wake = () => this.notify();
    if (signal) listenAbort(signal, wake);
    try {
      const failure = this.failure(signal);
      if (failure) return { kind: "error", code: failure };
      if (!this.changed()) await this.joinWake(signal);
      const after = this.failure(signal);
      return after ? { kind: "error", code: after } : { kind: "ok", value: undefined };
    } finally {
      if (signal) unlistenAbort(signal, wake);
    }
  }
  private failure(signal?: AbortSignal): TerminalFailure | undefined {
    if ((signal && abortSignalAborted(signal)) || this.input.cancelled()) return "CANCELED";
    return atomicsLoad(this.input.state, H.poisoned) !== 0 ? "CLOSED" : undefined;
  }
  private changed(): boolean {
    return (
      atomicsLoad(this.input.notification, 0) !== this.sequence ||
      atomicsLoad(this.input.lock, 0) !== this.owner
    );
  }
  private notify(): void {
    atomicsNotify(this.input.notification, 0);
    atomicsNotify(this.input.lock, 0);
  }
  private joinWake(signal?: AbortSignal): Promise<void> {
    return new PromiseConstructor((resolve, reject) => {
      const data = atomicsWaitAsync(this.input.notification, 0, this.sequence);
      let lock: ReturnType<typeof atomicsWaitAsyncBigInt>;
      try {
        lock = atomicsWaitAsyncBigInt(this.input.lock, 0, this.owner);
      } catch (cause) {
        this.notify();
        reject(cause);
        return;
      }
      let remaining = 2;
      const completed = () => {
        remaining--;
        this.notify(); // Release the losing registration too; never modify either word.
        if (remaining === 0) resolve();
      };
      if (data.async) afterNativePromise(data.value, completed, reject);
      else completed();
      if (lock.async) afterNativePromise(lock.value, completed, reject);
      else completed();
      // Cover input/signal cancellation between predicate check and native registration.
      if (this.changed() || this.failure(signal)) this.notify();
    });
  }
}

function inputBuffer(input: TerminalInput | SharedArrayBuffer): InputBuffer {
  if (isInstance(input, InputBuffer)) return input;
  const buffer = isSharedArrayBuffer(input) ? input : input.buffer;
  return new InputBuffer(buffer);
}

export function createTerminalInput(options: { readonly capacity?: number } = {}): TerminalInput {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  if (!validCapacity(capacity)) throw new RangeError("invalid terminal input capacity");
  const input = new InputBuffer(new SharedArrayBufferConstructor(HEADER_BYTES + capacity));
  const nonce = cryptoGetRandomValues(new Uint32ArrayConstructor(2));
  if (nonce[0] === 0 && nonce[1] === 0) nonce[0] = 1;
  typedArraySet(new Uint32ArrayConstructor(input.buffer, H.nonce * 4, 2), nonce);
  atomicsStore(input.identity, 1, 1n);
  return input;
}

/** Only a captured native owner's successful stop may abandon its exact acquisition token. */
export function poisonTerminalInput(input: TerminalInput, nonce: bigint, token: bigint): boolean {
  const buffer = inputBuffer(input);
  if (atomicsLoad(buffer.identity, 0) !== nonce) return false;
  if (atomicsLoad(buffer.lock, 0) === token) buffer.poison();
  return true;
}

export function attachTerminalInput(buffer: SharedArrayBuffer): TerminalInput {
  return new InputBuffer(buffer);
}

function pushFailure(code: number): TerminalFailure {
  if (code === AGAIN) return "AGAIN";
  if (code === CANCELED) return "CANCELED";
  if (code === BADF) return "CLOSED";
  return "INVALID";
}

export function pushTerminalInput(
  display: TerminalDisplay,
  input: TerminalInput,
  bytes: Uint8Array,
): TerminalInputPushResult {
  let offset = 0;
  const total = typedArrayLength(bytes);
  while (offset < total) {
    const end = Math.min(offset + TERMINAL_SESSION_LIMITS.inputBytesPerTurn, total);
    const length = end - offset;
    let pushed = 0;
    const result = display.input(() => {
      pushed = input.push(typedArraySubarray(bytes, offset, end));
      return pushed >= 0 ? pushed : 0;
    });
    if (pushed < 0) return { kind: "error", code: pushFailure(pushed), accepted: offset };
    offset += pushed;
    if (result.kind === "error") return { kind: "error", code: result.code, accepted: offset };
    if (pushed !== length) return { kind: "error", code: "INVALID", accepted: offset };
  }
  return { kind: "ok", value: offset };
}

export function createTerminalInputPolicy(options: TerminalInputPolicyOptions): TerminalPolicy {
  const input = inputBuffer(options.input);
  return {
    tryRead(turn: TerminalTurn, chunks: readonly Uint8Array[]): number {
      return input.read(turn, chunks, turn.mode === "cooked");
    },
    inputReadiness(turn): Pick<Readiness, "readable" | "nbytes"> {
      const available = input.available();
      return { readable: input.inputReady(turn.mode === "cooked"), nbytes: available };
    },
    transition(_turn, change): TerminalResult<void> {
      if (change.kind === "mode") input.resetModeRecord();
      return { kind: "ok", value: undefined };
    },
    tryWrite(target, chunks): number {
      return options.tryWrite?.(target, chunks) ?? (hasBytes(chunks) ? NOTSUP : 0);
    },
    outputReadiness(target): Pick<Readiness, "writable"> {
      return options.outputReadiness?.(target) ?? { writable: false };
    },
  };
}
