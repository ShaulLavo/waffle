import { atomicsWaitAsync } from "../proc/intrinsics.js";
import { FilesystemError } from "../core/filesystem.js";

export interface FilesystemWriteBarrier {
  flush(): Promise<void>;
  release(): Promise<void>;
}
export interface WriteTicket {
  readonly slot: number;
  readonly serial: number;
  readonly owner: number;
}
const LOCK = 0,
  CLOSED = 1,
  SERIAL = 2,
  LEASE = 3,
  CHANGE = 4,
  FAILURE = 5;
const HEADER = 8,
  WORDS = 6,
  RECORDS = 64;
const OWNER = 0,
  ID = 1,
  LOCAL = 2,
  REMOTE = 3,
  INPUT = 4,
  INPUT_METADATA = 5;
export const WRITE_INPUT_LIMIT = 512 * 1024 * 1024;
const WRITE_ARGUMENT_LIMIT = 8192;
const WRITE_METADATA_LIMIT = 16 * 1024 * 1024;

export const WRITE_BARRIER_WORDS = HEADER + WORDS * RECORDS;
export const WRITE_BARRIER_OFFSET = 64 * 4;

/** A root-wide fixed record pool. Local stacks and executing transport each own a reference.
 * A cancelled caller cannot release the executing reference. No lock spans a callback or wait. */
export class WriteAdmission {
  private readonly cells: Int32Array;
  constructor(readonly buffer: SharedArrayBuffer) {
    this.cells = new Int32Array(buffer, WRITE_BARRIER_OFFSET, WRITE_BARRIER_WORDS);
  }
  private locked<T>(owner: number, run: () => T): T {
    if (Atomics.compareExchange(this.cells, LOCK, 0, owner)) throw new FilesystemError(6);
    try {
      return run();
    } finally {
      Atomics.compareExchange(this.cells, LOCK, owner, 0);
      this.notify();
    }
  }
  private notify(): void {
    Atomics.add(this.cells, CHANGE, 1);
    Atomics.notify(this.cells, CHANGE);
  }
  get change(): number {
    return Atomics.load(this.cells, CHANGE);
  }
  get closed(): boolean {
    return Atomics.load(this.cells, CLOSED) !== 0;
  }
  get inputBytes(): number {
    return this.reserved(INPUT);
  }
  get metadataBytes(): number {
    return this.reserved(INPUT_METADATA);
  }
  private reserved(field: number): number {
    let total = 0;
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS) {
      const serial = Atomics.load(this.cells, slot + ID);
      if (serial) total += Atomics.load(this.cells, slot + field);
    }
    return total;
  }
  get active(): number {
    let count = 0;
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS)
      if (Atomics.load(this.cells, slot + ID)) count++;
    return count;
  }
  admit(owner: number, bytes = 0): WriteTicket {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > WRITE_INPUT_LIMIT)
      throw new FilesystemError(6, "filesystem input capacity exhausted");
    return this.locked(owner, () => {
      if (this.closed || this.inputBytes + bytes > WRITE_INPUT_LIMIT) throw new FilesystemError(6);
      const slot = this.freeSlot();
      const serial = Atomics.load(this.cells, SERIAL) + 1;
      if (serial >= 0x7fffffff) throw new FilesystemError(33);
      Atomics.store(this.cells, SERIAL, serial);
      Atomics.store(this.cells, slot + OWNER, owner);
      Atomics.store(this.cells, slot + LOCAL, serial);
      Atomics.store(this.cells, slot + REMOTE, 0);
      Atomics.store(this.cells, slot + INPUT, bytes);
      Atomics.store(this.cells, slot + INPUT_METADATA, 0);
      Atomics.store(this.cells, slot + ID, serial);
      return { slot, serial, owner };
    });
  }
  private freeSlot(): number {
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS)
      if (!Atomics.load(this.cells, slot + ID)) return slot;
    throw new FilesystemError(6, "filesystem producer table exhausted");
  }
  verify(ticket: WriteTicket, owner = ticket.owner, finishing = false): void {
    const { slot, serial } = ticket;
    if (
      !Number.isInteger(slot) ||
      slot < HEADER ||
      slot >= this.cells.length ||
      (slot - HEADER) % WORDS ||
      owner !== ticket.owner ||
      Atomics.load(this.cells, slot + OWNER) !== owner ||
      Atomics.load(this.cells, slot + ID) !== serial ||
      !serial ||
      (!finishing && Atomics.load(this.cells, CLOSED) === -1)
    )
      throw new FilesystemError(11, "filesystem write ticket retired");
  }
  reserveInput(ticket: WriteTicket, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > WRITE_INPUT_LIMIT)
      throw new FilesystemError(6);
    this.locked(ticket.owner, () => {
      this.verify(ticket);
      const previous = Atomics.load(this.cells, ticket.slot + INPUT);
      if (bytes <= previous) return;
      if (this.inputBytes + bytes - previous > WRITE_INPUT_LIMIT) throw new FilesystemError(6);
      Atomics.store(this.cells, ticket.slot + INPUT, bytes);
    });
  }
  reserveMetadata(ticket: WriteTicket, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > WRITE_METADATA_LIMIT)
      throw new FilesystemError(6);
    this.locked(ticket.owner, () => {
      this.verify(ticket);
      const previous = Atomics.load(this.cells, ticket.slot + INPUT_METADATA);
      if (bytes <= previous) return;
      if (this.metadataBytes + bytes - previous > WRITE_METADATA_LIMIT)
        throw new FilesystemError(6);
      Atomics.store(this.cells, ticket.slot + INPUT_METADATA, bytes);
    });
  }
  send(ticket: WriteTicket, request: number): void {
    this.verify(ticket);
    if (!Number.isSafeInteger(request) || request <= 0 || request >= 0x7fffffff)
      throw new FilesystemError(33);
    if (Atomics.compareExchange(this.cells, ticket.slot + REMOTE, 0, request))
      throw new FilesystemError(6, "write ticket already has an executing request");
  }
  receive(ticket: WriteTicket, owner: number, request: number, prepared: boolean): void {
    this.verify(ticket, owner);
    if (!Number.isSafeInteger(request) || request <= 0 || request >= 0x7fffffff)
      throw new FilesystemError(28);
    const remote = prepared
      ? Atomics.load(this.cells, ticket.slot + REMOTE)
      : Atomics.compareExchange(this.cells, ticket.slot + REMOTE, request, -request);
    if (remote !== (prepared ? -request : request)) throw new FilesystemError(11);
  }
  finish(ticket: WriteTicket, request = 0, failed = false): void {
    if (Atomics.load(this.cells, ticket.slot + ID) !== ticket.serial) return;
    this.verify(ticket, ticket.owner, true);
    const released = request
      ? Atomics.compareExchange(this.cells, ticket.slot + REMOTE, request, 0) === request
      : Atomics.compareExchange(this.cells, ticket.slot + LOCAL, ticket.serial, 0) ===
        ticket.serial;
    if (!released) return;
    if (failed && this.closed) Atomics.store(this.cells, FAILURE, 1);
    this.retire(ticket.slot, ticket.serial);
  }
  private retire(slot: number, serial: number): void {
    if (Atomics.load(this.cells, slot + LOCAL) || Atomics.load(this.cells, slot + REMOTE)) return;
    if (Atomics.compareExchange(this.cells, slot + ID, serial, -serial) !== serial) return;
    Atomics.store(this.cells, slot + ID, 0);
    this.notify();
  }
  reapLocal(owner: number): void {
    Atomics.compareExchange(this.cells, LOCK, owner, 0);
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS) {
      if (Atomics.load(this.cells, slot + OWNER) !== owner) continue;
      const serial = Atomics.load(this.cells, slot + ID);
      if (serial < 0) Atomics.compareExchange(this.cells, slot + ID, serial, 0);
      if (serial <= 0) continue;
      Atomics.compareExchange(this.cells, slot + LOCAL, serial, 0);
      this.retire(slot, serial);
    }
  }
  close(): number {
    return this.locked(0x7fffffff, () => {
      if (Atomics.load(this.cells, CLOSED) === -1) throw new FilesystemError(11);
      if (this.closed) throw new FilesystemError(6, "filesystem barrier already owned");
      const lease = Atomics.load(this.cells, LEASE) + 1;
      if (lease >= 0x7fffffff) throw new FilesystemError(33);
      Atomics.store(this.cells, LEASE, lease);
      Atomics.store(this.cells, FAILURE, 0);
      if (Atomics.compareExchange(this.cells, CLOSED, 0, lease) !== 0)
        throw new FilesystemError(11);
      return lease;
    });
  }
  assertLease(lease: number): void {
    if (Atomics.load(this.cells, CLOSED) !== lease) throw new FilesystemError(11);
  }
  open(lease: number): void {
    Atomics.compareExchange(this.cells, CLOSED, lease, 0);
    this.notify();
  }
  stop(): void {
    Atomics.store(this.cells, CLOSED, -1);
    this.notify();
  }
  async drain(lease: number, signal?: AbortSignal): Promise<void> {
    const abort = () => {
      this.open(lease);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (this.active) {
        if (signal?.aborted) throw new FilesystemError(11);
        this.assertLease(lease);
        const observed = this.change;
        this.assertLease(lease);
        if (this.active) await this.changed(observed);
      }
      if (signal?.aborted) throw new FilesystemError(11);
      this.assertLease(lease);
      if (Atomics.load(this.cells, FAILURE))
        throw new FilesystemError(6, "earlier mutation failed");
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  private async changed(observed: number): Promise<void> {
    const waiting = atomicsWaitAsync(this.cells, CHANGE, observed);
    if (waiting.async) await waiting.value;
  }
}

/** Bounds the protocol's JSON representation before allocating encoded arguments. */
export function writeArgumentSize(
  value: unknown,
  budget = WRITE_ARGUMENT_LIMIT,
  depth = 0,
): number {
  if (budget < 0 || depth > 5) throw new FilesystemError(6);
  if (value === undefined) return 19;
  if (value === null || typeof value === "boolean") return 5;
  if (typeof value === "number") return 24;
  if (typeof value === "string") return stringSize(value, budget);
  if (typeof value !== "object") throw new FilesystemError(28);
  let size = 2;
  if (Array.isArray(value)) {
    for (const item of value) size += 1 + writeArgumentSize(item, budget - size, depth + 1);
  } else if (value instanceof Map) {
    size += 10;
    for (const [key, item] of value) {
      size += 4 + writeArgumentSize(key, budget - size, depth + 1);
      size += writeArgumentSize(item, budget - size, depth + 1);
    }
  } else {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      size += 2 + stringSize(key, budget - size);
      size += writeArgumentSize(Reflect.get(value, key), budget - size, depth + 1);
    }
  }
  if (size > budget) throw new FilesystemError(6);
  return size;
}
function stringSize(text: string, budget: number): number {
  let size = 2;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      size += 4;
      index++;
    } else if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) size += 6;
    else size += code === 34 || code === 92 ? 2 : code < 128 ? 1 : code < 2048 ? 2 : 3;
    if (size > budget) throw new FilesystemError(6);
  }
  return size;
}
export function readWriteTicket(value: unknown): WriteTicket {
  if (
    !value ||
    typeof value !== "object" ||
    !("slot" in value) ||
    !("serial" in value) ||
    !("owner" in value) ||
    typeof value.slot !== "number" ||
    typeof value.serial !== "number" ||
    typeof value.owner !== "number"
  )
    throw new FilesystemError(28);
  return { slot: value.slot, serial: value.serial, owner: value.owner };
}
