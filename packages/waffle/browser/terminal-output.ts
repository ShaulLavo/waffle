import { allocateSharedControl } from "../memory/control.js";
// Original browser adapter: bounded terminal output between process Workers and the page. It
// gives host terminal destinations the flow control of a real TTY: a write waits for room or
// reports the exact prefix it accepted, and each root holds at most one budget of bytes.
import type { Readiness, Stream } from "../core/descriptors.js";
import {
  atomicsAdd,
  atomicsCompareExchange,
  atomicsExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  atomicsWait,
  Int32ArrayConstructor,
  isSharedArrayBuffer,
  SetConstructor,
  setAdd,
  setDelete,
  setForEach,
  setHas,
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
const H = { write: 0, read: 1, wake: 2, armed: 3, closed: 4, credit: 5, want: 6 } as const;
/** Buffer bytes, headers included, one root's writers may hold accepted and undelivered. */
const TERMINAL_OUTPUT_BUDGET = 65536;

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
  /** Called when the page waits to be told about a write or a credit request. */
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

/** Page side: allocate one Worker's buffer. The page alone reads it and grants its credit.
 * Positions are 32-bit counters, so the capacity is a power of two that keeps them consistent
 * when they wrap. */
export function createTerminalOutput(capacity = DEFAULT_CAPACITY): TerminalOutputReader {
  if (
    !Number.isSafeInteger(capacity) ||
    capacity <= RECORD_BYTES ||
    capacity > 0x40000000 ||
    (capacity & (capacity - 1)) !== 0
  )
    throw new RangeError("terminal output capacity must be a power of two above 4 bytes");
  const buffer = allocateSharedControl(HEADER_BYTES + capacity);
  atomicsStore(words(buffer), H.armed, 1);
  return new TerminalOutputReader(buffer);
}

export class TerminalOutputReader {
  private state: Int32Array;
  private ring: Uint8Array;
  private shared: SharedArrayBuffer | undefined;
  private draining = false;
  /** Credit handed to this writer and not yet returned by delivery, in buffer bytes. */
  granted = 0;
  constructor(buffer: SharedArrayBuffer) {
    this.state = words(buffer);
    this.ring = ringOf(buffer);
    this.shared = buffer;
  }
  /** The Worker's shared buffer, until retire() moves its accepted bytes to page memory. */
  get buffer(): SharedArrayBuffer {
    if (!this.shared) throw new TypeError("terminal output was retired");
    return this.shared;
  }
  get retired(): boolean {
    return !this.shared;
  }
  /** Bytes, headers included, accepted from the Worker and not yet delivered. */
  pending(): number {
    return (atomicsLoad(this.state, H.write) - atomicsLoad(this.state, H.read)) >>> 0;
  }
  /**
   * The writer ran out of credit and waits for a grant. A writer that read its credit just
   * before a grant stores its request after it; that request is stale while the credit still
   * funds a record, and must not cost the writer its armed doorbell. The page clears the
   * request only as part of a grant, so reading it never loses a newer one.
   */
  wants(): boolean {
    return (
      !this.retired &&
      atomicsLoad(this.state, H.want) !== 0 &&
      atomicsLoad(this.state, H.credit) <= RECORD_BYTES
    );
  }
  /** Gives the writer more credit and wakes it. */
  grant(units: number): void {
    atomicsStore(this.state, H.want, 0);
    atomicsAdd(this.state, H.credit, units);
    this.granted += units;
    notify(this.state);
  }
  /** Takes back credit the writer has not used. It asks again when it needs more. */
  reclaim(): void {
    if (this.retired) return;
    this.granted -= atomicsExchange(this.state, H.credit, 0);
  }
  /**
   * Offers buffered records in order. A short delivery keeps the rest buffered and returns
   * "blocked"; drain again after the destination reports room. A drain requested from inside
   * a delivery is part of the running pass: that delivery's returned count decides it.
   */
  drain(deliver: TerminalOutputDelivery): "idle" | "blocked" {
    if (this.draining) return "blocked";
    this.draining = true;
    try {
      while (this.pending()) if (!this.deliverRecord(deliver)) return "blocked";
      return "idle";
    } finally {
      this.draining = false;
    }
  }
  /** Arms the doorbell. False when the writer has bytes or a credit request the page must see. */
  park(): boolean {
    if (this.retired) return true;
    atomicsStore(this.state, H.armed, 1);
    if (!this.pending() && !this.wants()) return true;
    // If the writer already took the arm, its doorbell follows.
    return atomicsExchange(this.state, H.armed, 0) === 0;
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
      this.release(read, RECORD_BYTES + length);
      return true;
    }
    if (!accepted) return false;
    // Rewrite the shortened record over delivered bytes, then release them to the writer.
    copyIn(this.ring, read + accepted, header(target, length - accepted));
    this.release(read, accepted);
    return false;
  }
  private release(read: number, bytes: number): void {
    atomicsStore(this.state, H.read, (read + bytes) | 0);
    this.granted -= bytes;
    notify(this.state);
  }
  /** Refuses later writes and wakes a blocked writer. Buffered bytes remain deliverable. */
  close(): void {
    atomicsStore(this.state, H.closed, 1);
    notify(this.state);
  }
  /**
   * The Worker has physically stopped. Return its unused credit and any credit lost to an
   * unpublished write, and move its accepted bytes into page memory of exactly their size.
   */
  retire(): void {
    if (this.retired) return;
    atomicsExchange(this.state, H.credit, 0);
    const pending = this.pending();
    const bytes = copyOut(this.ring, atomicsLoad(this.state, H.read), pending);
    this.shared = undefined;
    this.state = new Int32ArrayConstructor(HEADER_WORDS);
    atomicsStore(this.state, H.write, pending);
    atomicsStore(this.state, H.closed, 1);
    this.ring = bytes;
    this.granted = pending;
  }
}

/**
 * One root's terminal output: every writer under the root shares one budget, like the buffer
 * of a TTY. Accepted bytes belong to the root's destination, not to the writing process, so
 * they outlive it, and the total stays within the budget however many writers stop.
 */
export class TerminalOutputBudget {
  readonly readers = new SetConstructor<TerminalOutputReader>();
  private servicing = false;
  constructor(readonly budget = TERMINAL_OUTPUT_BUDGET) {}
  /** Credit not yet granted to any writer. */
  available(): number {
    let granted = 0;
    setForEach(this.readers, (reader) => {
      granted += reader.granted;
    });
    return this.budget - granted;
  }
  pending(): number {
    let pending = 0;
    setForEach(this.readers, (reader) => {
      pending += reader.pending();
    });
    return pending;
  }
  /**
   * Delivers, grants credit and re-arms doorbells until nothing can progress. A call from
   * inside a delivery joins the running pass. Returns without spinning when the destination
   * is full or no credit is free; a later doorbell, outputDrained or retire resumes it.
   */
  service(deliver: TerminalOutputDelivery): void {
    if (this.servicing) return;
    this.servicing = true;
    const blocked = new SetConstructor<TerminalOutputReader>();
    try {
      for (;;) {
        setForEach(this.readers, (reader) => {
          if (!setHas(blocked, reader) && reader.drain(deliver) === "blocked")
            setAdd(blocked, reader);
        });
        this.distribute();
        if (!this.parkAll(blocked)) return;
      }
    } finally {
      this.servicing = false;
      setForEach(this.readers, (reader) => {
        if (reader.retired && !reader.pending()) setDelete(this.readers, reader);
      });
    }
  }
  /** True when an unblocked writer has bytes, or wants credit that is now free. */
  private parkAll(blocked: Set<TerminalOutputReader>): boolean {
    let again = false;
    setForEach(this.readers, (reader) => {
      if (setHas(blocked, reader) || reader.park()) return;
      if (reader.pending() || (reader.wants() && this.available() > RECORD_BYTES)) again = true;
    });
    return again;
  }
  private distribute(): void {
    const wanting: TerminalOutputReader[] = [];
    setForEach(this.readers, (reader) => {
      if (reader.wants()) wanting[wanting.length] = reader;
    });
    if (!wanting.length) return;
    // Idle writers give their unused credit back; they ask again when they write.
    setForEach(this.readers, (reader) => {
      if (!reader.wants()) reader.reclaim();
    });
    let pool = this.available();
    for (let index = 0; index < wanting.length; index++) {
      const share = Math.floor(pool / (wanting.length - index));
      if (share <= RECORD_BYTES) continue;
      wanting[index]!.grant(share);
      pool -= share;
    }
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
  const requestCredit = () => {
    atomicsStore(state, H.want, 1);
    if (atomicsExchange(state, H.armed, 0) === 1) options.doorbell();
  };
  /** Takes credit for one record and returns its payload size, or 0 after asking for more. */
  const reserve = (total: number): number => {
    for (;;) {
      const credit = atomicsLoad(state, H.credit);
      const space = free();
      const room = (credit < space ? credit : space) - RECORD_BYTES;
      if (room <= 0) {
        requestCredit();
        return 0;
      }
      const count = total < room ? total : room;
      const next = credit - RECORD_BYTES - count;
      if (atomicsCompareExchange(state, H.credit, credit, next) === credit) return count;
    }
  };
  const tryWrite = (target: 1 | 2, chunks: readonly Uint8Array[]): number => {
    options.checkActive();
    if (closed()) return -BADF;
    const total = totalLength(chunks);
    if (!total) return 0;
    const count = reserve(total);
    if (!count) return -AGAIN;
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
  const writable = (): boolean => {
    if (closed()) return false;
    if (atomicsLoad(state, H.credit) > RECORD_BYTES && free() > RECORD_BYTES) return true;
    // Readiness waits on this buffer's notification, so a grant must be on its way.
    requestCredit();
    return false;
  };
  return { tryWrite, write, flush, notification, writable };
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
