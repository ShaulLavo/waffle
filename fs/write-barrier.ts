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
  FAILURE = 5,
  SERIAL_HIGH = 6,
  FREE = 7,
  INPUT_TOTAL = 8,
  METADATA_TOTAL = 9,
  ACTIVE = 10,
  WAITING = 11;
const HEADER = 12,
  WORDS = 7,
  RECORDS = 64,
  RADIX = 0x80000000;
const OWNER = 0,
  ID = 1,
  LOCAL = 2,
  REMOTE = 3,
  INPUT = 4,
  INPUT_METADATA = 5,
  ID_HIGH = 6;
export const WRITE_INPUT_LIMIT = 512 * 1024 * 1024;
const WRITE_ARGUMENT_LIMIT = 8192;
const WRITE_METADATA_LIMIT = 16 * 1024 * 1024;

export const WRITE_BARRIER_WORDS = HEADER + WORDS * RECORDS;
export const WRITE_BARRIER_OFFSET = 80 * 4;

class AdmissionBusy extends FilesystemError {
  constructor() { super(6); }
}

/** Fixed execution records. Waiting producers retain only their caller-owned input. */
export class WriteAdmission {
  private readonly cells: Int32Array;
  constructor(readonly buffer: SharedArrayBuffer) {
    this.cells = new Int32Array(buffer, WRITE_BARRIER_OFFSET, WRITE_BARRIER_WORDS);
  }
  private locked<T>(owner: number, run: () => T, interrupted?: () => boolean): T {
    for (;;) {
      const holder = Atomics.compareExchange(this.cells, LOCK, 0, owner);
      if (!holder) break;
      if (!interrupted) throw new AdmissionBusy();
      if (interrupted()) throw new FilesystemError(11);
      Atomics.wait(this.cells, LOCK, holder, 50);
    }
    try {
      return run();
    } finally {
      Atomics.compareExchange(this.cells, LOCK, owner, 0);
      Atomics.notify(this.cells, LOCK);
      if (Atomics.load(this.cells, WAITING)) this.notify();
    }
  }
  private notify(): void {
    Atomics.add(this.cells, CHANGE, 1);
    Atomics.notify(this.cells, CHANGE);
  }
  get change(): number { return Atomics.load(this.cells, CHANGE); }
  get closed(): boolean { return Atomics.load(this.cells, CLOSED) !== 0; }
  get inputBytes(): number { return Atomics.load(this.cells, INPUT_TOTAL); }
  get metadataBytes(): number { return Atomics.load(this.cells, METADATA_TOTAL); }
  get active(): number { return Atomics.load(this.cells, ACTIVE); }
  admit(owner: number, bytes = 0, interrupted?: () => boolean, metadata = 0, asynchronous = false): WriteTicket {
    if (this.closed) throw new FilesystemError(6);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > WRITE_INPUT_LIMIT)
      throw new FilesystemError(6, "filesystem input capacity exhausted");
    if (!Number.isSafeInteger(metadata) || metadata < 0 || metadata > WRITE_METADATA_LIMIT)
      throw new FilesystemError(6, "filesystem metadata capacity exhausted");
    return this.locked(owner, () => {
      if (this.closed) throw new FilesystemError(6);
      if (this.inputBytes + bytes > WRITE_INPUT_LIMIT || this.metadataBytes + metadata > WRITE_METADATA_LIMIT)
        throw new AdmissionBusy();
      if (asynchronous && this.active >= RECORDS - 1) throw new AdmissionBusy();
      const slot = this.freeSlot();
      const serial = this.nextSerial();
      const low = serial % RADIX;
      Atomics.store(this.cells, slot + OWNER, owner);
      Atomics.store(this.cells, slot + ID_HIGH, Math.floor(serial / RADIX));
      Atomics.store(this.cells, slot + LOCAL, low);
      Atomics.store(this.cells, slot + REMOTE, 0);
      Atomics.store(this.cells, slot + INPUT, bytes);
      Atomics.store(this.cells, slot + INPUT_METADATA, metadata);
      Atomics.add(this.cells, INPUT_TOTAL, bytes);
      Atomics.add(this.cells, METADATA_TOTAL, metadata);
      Atomics.add(this.cells, ACTIVE, 1);
      Atomics.store(this.cells, slot + ID, low);
      return { slot, serial, owner };
    }, interrupted);
  }
  private nextSerial(): number {
    let low = Atomics.load(this.cells, SERIAL) + 1;
    let high = Atomics.load(this.cells, SERIAL_HIGH);
    if (low >= RADIX) { low = 1; high++; }
    const serial = high * RADIX + low;
    if (!Number.isSafeInteger(serial)) throw new FilesystemError(33);
    Atomics.store(this.cells, SERIAL, low);
    Atomics.store(this.cells, SERIAL_HIGH, high);
    return serial;
  }
  async admitAsync(owner: number, bytes = 0, metadata = 0, interrupted?: () => boolean): Promise<WriteTicket> {
    const generation = Atomics.load(this.cells, LEASE);
    for (;;) {
      if (interrupted?.()) throw new FilesystemError(11);
      if (Atomics.load(this.cells, LEASE) !== generation) throw new FilesystemError(6);
      const observed = this.change;
      try { return this.admit(owner, bytes, undefined, metadata, true); }
      catch (error) { if (!(error instanceof AdmissionBusy)) throw error; }
      await this.changed(observed, 50);
    }
  }
  private freeSlot(): number {
    const hint = Atomics.load(this.cells, FREE);
    for (let index = 0; index < RECORDS; index++) {
      const slot = HEADER + ((hint + index) % RECORDS) * WORDS;
      if (!Atomics.load(this.cells, slot + ID)) return slot;
    }
    throw new AdmissionBusy();
  }
  private matches(ticket: WriteTicket): boolean {
    return Atomics.load(this.cells, ticket.slot + ID) === ticket.serial % RADIX &&
      Atomics.load(this.cells, ticket.slot + ID_HIGH) === Math.floor(ticket.serial / RADIX);
  }
  verify(ticket: WriteTicket, owner = ticket.owner, finishing = false): void {
    const { slot, serial } = ticket;
    if (!Number.isInteger(slot) || slot < HEADER || slot >= this.cells.length ||
      (slot - HEADER) % WORDS || !Number.isSafeInteger(serial) || serial <= 0 ||
      owner !== ticket.owner || Atomics.load(this.cells, slot + OWNER) !== owner ||
      !this.matches(ticket) || (!finishing && Atomics.load(this.cells, CLOSED) === -1))
      throw new FilesystemError(11, "filesystem write ticket retired");
  }
  reserveInput(ticket: WriteTicket, bytes: number, interrupted?: () => boolean): void {
    this.reserve(ticket, bytes, INPUT, INPUT_TOTAL, WRITE_INPUT_LIMIT, interrupted);
  }
  reserveMetadata(ticket: WriteTicket, bytes: number, interrupted?: () => boolean): void {
    this.reserve(ticket, bytes, INPUT_METADATA, METADATA_TOTAL, WRITE_METADATA_LIMIT, interrupted);
  }
  private reserve(ticket: WriteTicket, bytes: number, field: number, total: number, limit: number, interrupted?: () => boolean): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) throw new FilesystemError(6);
    if (!bytes) return;
    this.locked(ticket.owner, () => {
      this.verify(ticket);
      const previous = Atomics.load(this.cells, ticket.slot + field);
      if (bytes <= previous) return;
      if (Atomics.load(this.cells, total) + bytes - previous > limit) throw new FilesystemError(6);
      Atomics.add(this.cells, total, bytes - previous);
      Atomics.store(this.cells, ticket.slot + field, bytes);
    }, interrupted);
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
    const remote = prepared ? Atomics.load(this.cells, ticket.slot + REMOTE) :
      Atomics.compareExchange(this.cells, ticket.slot + REMOTE, request, -request);
    if (remote !== (prepared ? -request : request)) throw new FilesystemError(11);
  }
  finish(ticket: WriteTicket, request = 0, failed = false): void {
    if (!this.matches(ticket)) return;
    this.verify(ticket, ticket.owner, true);
    const low = ticket.serial % RADIX;
    const released = request ? Atomics.compareExchange(this.cells, ticket.slot + REMOTE, request, 0) === request :
      Atomics.compareExchange(this.cells, ticket.slot + LOCAL, low, 0) === low;
    if (!released) return;
    if (failed && this.closed) Atomics.store(this.cells, FAILURE, 1);
    this.retire(ticket.slot, low);
  }
  private retire(slot: number, serial: number): void {
    if (Atomics.load(this.cells, slot + LOCAL) || Atomics.load(this.cells, slot + REMOTE)) return;
    if (Atomics.compareExchange(this.cells, slot + ID, serial, -serial) !== serial) return;
    Atomics.sub(this.cells, INPUT_TOTAL, Atomics.load(this.cells, slot + INPUT));
    Atomics.sub(this.cells, METADATA_TOTAL, Atomics.load(this.cells, slot + INPUT_METADATA));
    Atomics.store(this.cells, FREE, (slot - HEADER) / WORDS);
    Atomics.store(this.cells, slot + ID, 0);
    Atomics.sub(this.cells, ACTIVE, 1);
    this.notify();
  }
  reapLocal(owner: number): void {
    Atomics.compareExchange(this.cells, LOCK, owner, 0);
    Atomics.notify(this.cells, LOCK);
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS) {
      if (Atomics.load(this.cells, slot + OWNER) !== owner) continue;
      const serial = Atomics.load(this.cells, slot + ID);
      if (serial <= 0) continue;
      Atomics.compareExchange(this.cells, slot + LOCAL, serial, 0);
      this.retire(slot, serial);
    }
    this.notify();
  }
  discardUnreceived(owner: number): void {
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS) {
      if (Atomics.load(this.cells, slot + OWNER) !== owner) continue;
      const serial = Atomics.load(this.cells, slot + ID);
      const remote = Atomics.load(this.cells, slot + REMOTE);
      if (serial <= 0 || remote <= 0) continue;
      Atomics.compareExchange(this.cells, slot + REMOTE, remote, 0);
      this.retire(slot, serial);
    }
  }
  close(): number {
    const lease = this.locked(0x7fffffff, () => {
      if (Atomics.load(this.cells, CLOSED) === -1) throw new FilesystemError(11);
      if (this.closed) throw new FilesystemError(10, "filesystem barrier already owned");
      const lease = Atomics.load(this.cells, LEASE) + 1;
      if (lease >= 0x7fffffff) throw new FilesystemError(33);
      Atomics.store(this.cells, LEASE, lease);
      Atomics.store(this.cells, FAILURE, 0);
      if (Atomics.compareExchange(this.cells, CLOSED, 0, lease) !== 0) throw new FilesystemError(11);
      return lease;
    });
    this.notify();
    return lease;
  }
  async closeAsync(signal?: AbortSignal): Promise<number> {
    const abort = () => this.notify();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.closeWaiting(signal);
    } finally { signal?.removeEventListener("abort", abort); }
  }
  private async closeWaiting(signal?: AbortSignal): Promise<number> {
    for (;;) {
      if (signal?.aborted) throw new FilesystemError(11);
      const observed = this.change;
      try { return this.close(); }
      catch (error) { if (!(error instanceof AdmissionBusy)) throw error; }
      await this.changed(observed, 50);
    }
  }
  assertLease(lease: number): void {
    if (Atomics.load(this.cells, CLOSED) !== lease) throw new FilesystemError(11);
  }
  open(lease: number): void { Atomics.compareExchange(this.cells, CLOSED, lease, 0); this.notify(); }
  stop(): void { Atomics.store(this.cells, CLOSED, -1); this.notify(); }
  async drain(lease: number, signal?: AbortSignal): Promise<void> {
    const abort = () => this.open(lease);
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
      if (Atomics.load(this.cells, FAILURE)) throw new FilesystemError(6, "earlier mutation failed");
    } finally { signal?.removeEventListener("abort", abort); }
  }
  private async changed(observed: number, timeout?: number): Promise<void> {
    Atomics.add(this.cells, WAITING, 1);
    try {
      const waiting = atomicsWaitAsync(this.cells, CHANGE, observed, timeout);
      if (waiting.async) await waiting.value;
    } finally { Atomics.sub(this.cells, WAITING, 1); }
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
    size = objectArgumentSize(value, budget, depth);
  }
  if (size > budget) throw new FilesystemError(6);
  return size;
}
function objectArgumentSize(value: object, budget: number, depth: number): number {
  let size = 2;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    size += 2 + stringSize(key, budget - size);
    size += writeArgumentSize(Reflect.get(value, key), budget - size, depth + 1);
  }
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
