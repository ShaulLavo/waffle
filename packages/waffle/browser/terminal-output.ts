// Original browser adapter: a bounded terminal output buffer between one process Worker and
// the page. It gives host terminal destinations the flow control of a real TTY: a write
// waits for room or reports the exact prefix it accepted, and the page never queues more.
import type { Readiness, Stream } from "../core/descriptors.js";
import {
  atomicsAdd,
  atomicsExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  atomicsWait,
  Int32ArrayConstructor,
  isSharedArrayBuffer,
  SharedArrayBufferConstructor,
  sharedArrayBufferByteLength,
  typedArrayLength,
  typedArraySet,
  typedArraySubarray,
  Uint8ArrayConstructor,
} from "../proc/intrinsics.ts";

const AGAIN = 6;
const BADF = 8;
const INTR = 27;
const NOSYS = 52;
const HEADER_WORDS = 8;
const HEADER_BYTES = HEADER_WORDS * 4;
const RECORD_BYTES = 4;
const STDERR = 0x80000000;
const DEFAULT_CAPACITY = 65536;
// Signals publish on the process interrupt word, not this buffer's sequence.
const SIGNAL_RESCAN_MS = 10;
const H = { write: 0, read: 1, wake: 2, armed: 3, closed: 4 } as const;

/** Exact-count host terminal destination. It never drops bytes or reports more than accepted. */
export interface RuntimeTerminalOutput {
  /** Accepts a prefix without waiting: its exact length, -AGAIN when nothing fits, or -errno. */
  tryWrite(target: 1 | 2, chunks: readonly Uint8Array[]): number;
  /** Waits for room. Returns the exact count accepted, short only after an interruption. */
  write?(target: 1 | 2, chunks: readonly Uint8Array[]): number;
  writable(): boolean;
  /** Sequence incremented and notified when room may have appeared. */
  readonly notification?: Int32Array;
}

export interface TerminalOutputWriterOptions {
  /** Throws when the process may no longer perform I/O. */
  checkActive(): void;
  /** A pending signal ends a blocking write with EINTR, or with its accepted prefix. */
  interrupted(): boolean;
  /** Called after a write when the page has drained everything and waits to be told. */
  doorbell(): void;
}

export interface TerminalOutputWriter extends RuntimeTerminalOutput {
  write(target: 1 | 2, chunks: readonly Uint8Array[]): number;
  readonly notification: Int32Array;
  /** Waits until the page has delivered every accepted byte, or `stop` becomes true. */
  flush(stop: () => boolean): boolean;
}

/** Page delivery: return the exact accepted prefix length, from 0 to `data.length`. */
export type TerminalOutputDelivery = (target: 1 | 2, data: Uint8Array) => number;

function words(buffer: SharedArrayBuffer): Int32Array {
  if (!isSharedArrayBuffer(buffer) || sharedArrayBufferByteLength(buffer) <= HEADER_BYTES)
    throw new TypeError("invalid terminal output buffer");
  return new Int32ArrayConstructor(buffer, 0, HEADER_WORDS);
}

function ringOf(buffer: SharedArrayBuffer): Uint8Array {
  return new Uint8ArrayConstructor(buffer, HEADER_BYTES);
}

function copyIn(ring: Uint8Array, index: number, bytes: Uint8Array): void {
  const capacity = typedArrayLength(ring);
  const start = (index >>> 0) % capacity;
  const length = typedArrayLength(bytes);
  const first = length < capacity - start ? length : capacity - start;
  typedArraySet(ring, typedArraySubarray(bytes, 0, first), start);
  if (first < length) typedArraySet(ring, typedArraySubarray(bytes, first), 0);
}

function copyOut(ring: Uint8Array, index: number, length: number): Uint8Array {
  const result = new Uint8ArrayConstructor(length);
  const capacity = typedArrayLength(ring);
  const start = (index >>> 0) % capacity;
  const first = length < capacity - start ? length : capacity - start;
  typedArraySet(result, typedArraySubarray(ring, start, start + first));
  if (first < length) typedArraySet(result, typedArraySubarray(ring, 0, length - first), first);
  return result;
}

function header(target: 1 | 2, length: number): Uint8Array {
  const word = (length | (target === 2 ? STDERR : 0)) >>> 0;
  return new Uint8ArrayConstructor([
    word & 255,
    (word >>> 8) & 255,
    (word >>> 16) & 255,
    word >>> 24,
  ]);
}

function totalLength(chunks: readonly Uint8Array[]): number {
  let total = 0;
  for (let index = 0; index < chunks.length; index++) total += typedArrayLength(chunks[index]!);
  return total;
}

/** The chunks after their first `skip` bytes, without copying guest memory. */
function remaining(chunks: readonly Uint8Array[], skip: number): Uint8Array[] {
  const rest: Uint8Array[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    const length = typedArrayLength(chunk);
    if (skip >= length) {
      skip -= length;
      continue;
    }
    rest[rest.length] = skip ? typedArraySubarray(chunk, skip) : chunk;
    skip = 0;
  }
  return rest;
}

function notify(state: Int32Array): void {
  atomicsAdd(state, H.wake, 1);
  atomicsNotify(state, H.wake);
}

/** Page side: allocate one Worker's buffer. The page alone reads it. Positions are 32-bit
 * counters, so the capacity is a power of two that keeps them consistent when they wrap. */
export function createTerminalOutput(capacity = DEFAULT_CAPACITY): TerminalOutputReader {
  if (
    !Number.isSafeInteger(capacity) ||
    capacity <= RECORD_BYTES ||
    capacity > 0x40000000 ||
    (capacity & (capacity - 1)) !== 0
  )
    throw new RangeError("terminal output capacity must be a power of two above 4 bytes");
  const buffer = new SharedArrayBufferConstructor(HEADER_BYTES + capacity);
  atomicsStore(words(buffer), H.armed, 1);
  return new TerminalOutputReader(buffer);
}

export class TerminalOutputReader {
  private readonly state: Int32Array;
  private readonly ring: Uint8Array;
  private draining = false;
  private again = false;
  constructor(readonly buffer: SharedArrayBuffer) {
    this.state = words(buffer);
    this.ring = ringOf(buffer);
  }
  /** Bytes accepted from the Worker and not yet delivered. */
  pending(): number {
    return (atomicsLoad(this.state, H.write) - atomicsLoad(this.state, H.read)) >>> 0;
  }
  /**
   * Offers buffered records in order. A short delivery keeps the rest buffered and returns
   * "blocked"; deliver again after the destination reports room. "idle" means the Worker
   * will ring its doorbell for the next write.
   */
  drain(deliver: TerminalOutputDelivery): "idle" | "blocked" {
    // A destination may report room from inside its own delivery; finish this pass, then retry.
    if (this.draining) {
      this.again = true;
      return "idle";
    }
    this.draining = true;
    try {
      for (;;) {
        this.again = false;
        const result = this.drainOnce(deliver);
        if (result === "idle" || !this.again) return result;
      }
    } finally {
      this.draining = false;
    }
  }
  private drainOnce(deliver: TerminalOutputDelivery): "idle" | "blocked" {
    for (;;) {
      while (this.pending()) if (!this.deliverRecord(deliver)) return "blocked";
      atomicsStore(this.state, H.armed, 1);
      if (!this.pending()) return "idle";
      // A write raced the arm. If its writer already took the arm, its doorbell follows.
      if (atomicsExchange(this.state, H.armed, 0) === 0) return "idle";
    }
  }
  private deliverRecord(deliver: TerminalOutputDelivery): boolean {
    const read = atomicsLoad(this.state, H.read);
    const head = copyOut(this.ring, read, RECORD_BYTES);
    const word = (head[0]! | (head[1]! << 8) | (head[2]! << 16) | (head[3]! << 24)) >>> 0;
    const target = word & STDERR ? 2 : 1;
    const length = word & ~STDERR;
    const data = copyOut(this.ring, read + RECORD_BYTES, length);
    const accepted = deliver(target, data);
    if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted > length)
      throw new TypeError("terminal output delivery returned an invalid count");
    if (accepted === length) {
      atomicsStore(this.state, H.read, (read + RECORD_BYTES + length) | 0);
      notify(this.state);
      return true;
    }
    if (!accepted) return false;
    // Rewrite the shortened record over delivered bytes, then release them to the writer.
    const next = (read + accepted) | 0;
    copyIn(this.ring, next, header(target, length - accepted));
    atomicsStore(this.state, H.read, next);
    notify(this.state);
    return false;
  }
  /** Refuses later writes and wakes a blocked writer. Buffered bytes remain deliverable. */
  close(): void {
    atomicsStore(this.state, H.closed, 1);
    notify(this.state);
  }
}

/** Worker side: blocking and immediate writes into a page-drained buffer. */
export function attachTerminalOutput(
  buffer: SharedArrayBuffer,
  options: TerminalOutputWriterOptions,
): TerminalOutputWriter {
  const state = words(buffer),
    ring = ringOf(buffer),
    capacity = typedArrayLength(ring),
    notification = new Int32ArrayConstructor(buffer, H.wake * 4, 1);
  const free = () => capacity - ((atomicsLoad(state, H.write) - atomicsLoad(state, H.read)) >>> 0);
  const closed = () => atomicsLoad(state, H.closed) !== 0;
  const tryWrite = (target: 1 | 2, chunks: readonly Uint8Array[]): number => {
    options.checkActive();
    if (closed()) return -BADF;
    const total = totalLength(chunks);
    if (!total) return 0;
    const room = free() - RECORD_BYTES;
    if (room <= 0) return -AGAIN;
    const count = total < room ? total : room;
    const start = atomicsLoad(state, H.write);
    copyIn(ring, start, header(target, count));
    let at = start + RECORD_BYTES,
      left = count;
    for (let index = 0; index < chunks.length && left; index++) {
      const chunk = chunks[index]!;
      const length = typedArrayLength(chunk);
      const part = length < left ? chunk : typedArraySubarray(chunk, 0, left);
      copyIn(ring, at, part);
      at += typedArrayLength(part);
      left -= typedArrayLength(part);
    }
    atomicsStore(state, H.write, (start + RECORD_BYTES + count) | 0);
    if (atomicsExchange(state, H.armed, 0) === 1) options.doorbell();
    return count;
  };
  const write = (target: 1 | 2, chunks: readonly Uint8Array[]): number => {
    const total = totalLength(chunks);
    let done = 0;
    for (;;) {
      const seen = atomicsLoad(state, H.wake);
      const result = tryWrite(target, done ? remaining(chunks, done) : chunks);
      if (result >= 0) done += result;
      else if (result !== -AGAIN) return done || result;
      if (done === total) return done;
      if (result > 0) continue;
      if (options.interrupted()) return done || -INTR;
      atomicsWait(state, H.wake, seen, SIGNAL_RESCAN_MS);
    }
  };
  const flush = (stop: () => boolean): boolean => {
    for (;;) {
      const seen = atomicsLoad(state, H.wake);
      if (free() === capacity) return true;
      if (closed() || stop()) return false;
      atomicsWait(state, H.wake, seen, SIGNAL_RESCAN_MS);
    }
  };
  return {
    tryWrite,
    write,
    flush,
    notification,
    writable: () => !closed() && free() > RECORD_BYTES,
  };
}

/** Copies each immediate write to a page or host callback that reports its accepted prefix. */
export function deliveredTerminalOutput(deliver: TerminalOutputDelivery): RuntimeTerminalOutput {
  return {
    tryWrite(target, chunks) {
      const total = totalLength(chunks);
      if (!total) return 0;
      // Copy guest memory before posting or transferring; Wasm memory is never transferable.
      const data = new Uint8ArrayConstructor(total);
      let offset = 0;
      for (let index = 0; index < chunks.length; index++) {
        typedArraySet(data, chunks[index]!, offset);
        offset += typedArrayLength(chunks[index]!);
      }
      const accepted = deliver(target, data);
      if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted > total)
        throw new TypeError("terminal output delivery returned an invalid count");
      return accepted || -AGAIN;
    },
    writable: () => true,
  };
}

/** A host terminal description. Without `output`, writes fail with NOSYS. */
export function hostTerminalStream(
  target: 0 | 1 | 2,
  output: RuntimeTerminalOutput | undefined,
  checkActive?: () => void,
): Stream {
  const destination = target === 2 ? 2 : 1;
  const read = () => {
    checkActive?.();
    return 0;
  };
  const send = (blocking: boolean, chunks: readonly Uint8Array[]): number => {
    checkActive?.();
    if (!totalLength(chunks)) return 0;
    if (!output) return -NOSYS;
    return blocking && output.write
      ? output.write(destination, chunks)
      : output.tryWrite(destination, chunks);
  };
  return {
    kind: "terminal",
    read,
    tryRead: read,
    write: (chunks) => send(true, chunks),
    tryWrite: (chunks) => send(false, chunks),
    readiness(): Readiness {
      checkActive?.();
      return { readable: true, writable: output?.writable() ?? true, hangup: target === 0 };
    },
    ...(output?.notification ? { notification: output.notification } : {}),
  };
}
