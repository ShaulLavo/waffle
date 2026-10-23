import { atomicsWaitAsync, BigIntConstructor } from "../proc/intrinsics.js";
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
  WAITING = 8;
const HEADER = 10,
  WORDS = 8,
  RECORDS = 64,
  RADIX = 0x80000000;
const OWNER = 0,
  ID = 2,
  REMOTE = 4,
  INPUT = 5,
  INPUT_METADATA = 6;
const LOCAL_REF = 1n,
  REMOTE_REF = 2n,
  REFERENCES = 3n;
export const WRITE_INPUT_LIMIT = 512 * 1024 * 1024;
const WRITE_ARGUMENT_LIMIT = 8192;
const WRITE_METADATA_LIMIT = 16 * 1024 * 1024;

export const WRITE_BARRIER_WORDS = HEADER + WORDS * RECORDS;
export const WRITE_BARRIER_OFFSET = 80 * 4;

class AdmissionBusy extends FilesystemError {
  constructor() {
    super(6);
  }
}

/** Fixed execution records. Waiting producers retain only their caller-owned input. */
export class WriteAdmission {
  private readonly cells: Int32Array;
  private readonly states: BigInt64Array;
  // Cache the representation, never the shared ownership check.
  private localSerial = 0;
  private localState = 0n;
  constructor(readonly buffer: SharedArrayBuffer) {
    this.cells = new Int32Array(buffer, WRITE_BARRIER_OFFSET, WRITE_BARRIER_WORDS);
    this.states = new BigInt64Array(buffer, WRITE_BARRIER_OFFSET, WRITE_BARRIER_WORDS / 2);
  }
  private locked<T>(owner: number, run: () => T, interrupted?: () => boolean): T {
    for (;;) {
      const holder = Atomics.compareExchange(this.cells, LOCK, 0, owner);
      if (!holder) break;
      if (!interrupted) throw new AdmissionBusy();
      if (interrupted()) throw new FilesystemError(11);
      Atomics.wait(this.cells, LOCK, holder, 50);
    }
    let changed = true;
    try {
      return run();
    } catch (error) {
      changed = !(error instanceof AdmissionBusy);
      throw error;
    } finally {
      Atomics.compareExchange(this.cells, LOCK, owner, 0);
      Atomics.notify(this.cells, LOCK);
      if (changed && Atomics.load(this.cells, WAITING)) this.notify();
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
  get active(): number {
    let active = 0;
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS)
      if (Atomics.load(this.states, (slot + ID) / 2)) active++;
    return active;
  }
  private reserved(field: number): number {
    let bytes = 0;
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS)
      if (Atomics.load(this.states, (slot + ID) / 2))
        bytes += Atomics.load(this.cells, slot + field);
    return bytes;
  }
  admit(
    owner: number,
    bytes = 0,
    interrupted?: () => boolean,
    metadata = 0,
    asynchronous = false,
  ): WriteTicket {
    if (this.closed) throw new FilesystemError(6);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > WRITE_INPUT_LIMIT)
      throw new FilesystemError(6, "filesystem input capacity exhausted");
    if (!Number.isSafeInteger(metadata) || metadata < 0 || metadata > WRITE_METADATA_LIMIT)
      throw new FilesystemError(6, "filesystem metadata capacity exhausted");
    return this.locked(
      owner,
      () => {
        if (this.closed) throw new FilesystemError(6);
        if (
          (bytes && this.inputBytes + bytes > WRITE_INPUT_LIMIT) ||
          (metadata && this.metadataBytes + metadata > WRITE_METADATA_LIMIT)
        )
          throw new AdmissionBusy();
        if (asynchronous && this.active >= RECORDS - 1) throw new AdmissionBusy();
        const slot = this.freeSlot();
        const serial = this.nextSerial();
        Atomics.store(this.cells, slot + OWNER, owner);
        Atomics.store(this.cells, slot + REMOTE, 0);
        Atomics.store(this.cells, slot + INPUT, bytes);
        Atomics.store(this.cells, slot + INPUT_METADATA, metadata);
        const state = (BigIntConstructor(serial) << 2n) | LOCAL_REF;
        Atomics.store(this.states, (slot + ID) / 2, state);
        this.localSerial = serial;
        this.localState = state;
        return { slot, serial, owner };
      },
      interrupted,
    );
  }
  private nextSerial(): number {
    let low = Atomics.load(this.cells, SERIAL) + 1;
    let high = Atomics.load(this.cells, SERIAL_HIGH);
    if (low >= RADIX) {
      low = 1;
      high++;
    }
    const serial = high * RADIX + low;
    if (!Number.isSafeInteger(serial)) throw new FilesystemError(33);
    Atomics.store(this.cells, SERIAL, low);
    Atomics.store(this.cells, SERIAL_HIGH, high);
    return serial;
  }
  async admitAsync(
    owner: number,
    bytes = 0,
    metadata = 0,
    interrupted?: () => boolean,
  ): Promise<WriteTicket> {
    const generation = Atomics.load(this.cells, LEASE);
    for (;;) {
      if (interrupted?.()) throw new FilesystemError(11);
      if (Atomics.load(this.cells, LEASE) !== generation) throw new FilesystemError(6);
      const observed = this.change;
      try {
        return this.admit(owner, bytes, undefined, metadata, true);
      } catch (error) {
        if (!(error instanceof AdmissionBusy)) throw error;
      }
      await this.changed(observed, 50);
    }
  }
  private freeSlot(): number {
    const hint = Atomics.load(this.cells, FREE);
    for (let index = 0; index < RECORDS; index++) {
      const slot = HEADER + ((hint + index) % RECORDS) * WORDS;
      if (!Atomics.load(this.states, (slot + ID) / 2)) return slot;
    }
    throw new AdmissionBusy();
  }
  private matches(ticket: WriteTicket): boolean {
    const state = Atomics.load(this.states, (ticket.slot + ID) / 2);
    if (ticket.serial === this.localSerial && state === this.localState) return true;
    return state >> 2n === BigIntConstructor(ticket.serial);
  }
  verify(ticket: WriteTicket, owner = ticket.owner, finishing = false): void {
    const { slot, serial } = ticket;
    if (
      !Number.isInteger(slot) ||
      slot < HEADER ||
      slot >= this.cells.length ||
      (slot - HEADER) % WORDS ||
      !Number.isSafeInteger(serial) ||
      serial <= 0 ||
      owner !== ticket.owner ||
      Atomics.load(this.cells, slot + OWNER) !== owner ||
      !this.matches(ticket) ||
      (!finishing && Atomics.load(this.cells, CLOSED) === -1)
    )
      throw new FilesystemError(11, "filesystem write ticket retired");
  }
  reserveInput(ticket: WriteTicket, bytes: number, interrupted?: () => boolean): void {
    this.reserve(ticket, bytes, INPUT, WRITE_INPUT_LIMIT, interrupted);
  }
  reserveMetadata(ticket: WriteTicket, bytes: number, interrupted?: () => boolean): void {
    this.reserve(ticket, bytes, INPUT_METADATA, WRITE_METADATA_LIMIT, interrupted);
  }
  private reserve(
    ticket: WriteTicket,
    bytes: number,
    field: number,
    limit: number,
    interrupted?: () => boolean,
  ): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) throw new FilesystemError(6);
    if (!bytes) return;
    this.locked(
      ticket.owner,
      () => {
        this.verify(ticket);
        const previous = Atomics.load(this.cells, ticket.slot + field);
        if (bytes <= previous) return;
        if (this.reserved(field) + bytes - previous > limit) throw new FilesystemError(6);
        Atomics.store(this.cells, ticket.slot + field, bytes);
      },
      interrupted,
    );
  }
  send(ticket: WriteTicket, request: number): void {
    this.verify(ticket);
    if (!Number.isSafeInteger(request) || request <= 0 || request >= 0x7fffffff)
      throw new FilesystemError(33);
    const index = (ticket.slot + ID) / 2;
    const local = (BigIntConstructor(ticket.serial) << 2n) | LOCAL_REF;
    if (Atomics.compareExchange(this.states, index, local, local | REMOTE_REF) !== local)
      throw new FilesystemError(6, "write ticket already has an executing request");
    Atomics.store(this.cells, ticket.slot + REMOTE, request);
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
    if (
      !request &&
      !failed &&
      ticket.serial === this.localSerial &&
      Atomics.compareExchange(this.states, (ticket.slot + ID) / 2, this.localState, 0n) ===
        this.localState
    ) {
      Atomics.store(this.cells, FREE, (ticket.slot - HEADER) / WORDS);
      this.notify();
      return;
    }
    if (request && Atomics.load(this.cells, ticket.slot + REMOTE) !== request) return;
    this.releaseReference(
      ticket.slot,
      BigIntConstructor(ticket.serial),
      request ? REMOTE_REF : LOCAL_REF,
      failed,
    );
  }
  private releaseReference(slot: number, serial: bigint, reference: bigint, failed = false): void {
    const index = (slot + ID) / 2;
    for (;;) {
      const state = Atomics.load(this.states, index);
      if (state >> 2n !== serial || !(state & reference)) return;
      const remaining = state & REFERENCES & ~reference;
      const next = remaining ? (serial << 2n) | remaining : 0n;
      if (failed && this.closed) Atomics.store(this.cells, FAILURE, 1);
      if (Atomics.compareExchange(this.states, index, state, next) !== state) continue;
      if (!remaining) Atomics.store(this.cells, FREE, (slot - HEADER) / WORDS);
      this.notify();
      return;
    }
  }
  reapLocal(owner: number): void {
    Atomics.compareExchange(this.cells, LOCK, owner, 0);
    Atomics.notify(this.cells, LOCK);
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS) {
      const state = Atomics.load(this.states, (slot + ID) / 2);
      if (Atomics.load(this.cells, slot + OWNER) !== owner) continue;
      this.releaseReference(slot, state >> 2n, LOCAL_REF);
    }
    this.notify();
  }
  discardUnreceived(owner: number): void {
    for (let slot = HEADER; slot < this.cells.length; slot += WORDS) {
      const state = Atomics.load(this.states, (slot + ID) / 2);
      if (
        Atomics.load(this.cells, slot + OWNER) !== owner ||
        Atomics.load(this.cells, slot + REMOTE) < 0
      )
        continue;
      this.releaseReference(slot, state >> 2n, REMOTE_REF);
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
      if (Atomics.compareExchange(this.cells, CLOSED, 0, lease) !== 0)
        throw new FilesystemError(11);
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
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  private async closeWaiting(signal?: AbortSignal): Promise<number> {
    for (;;) {
      if (signal?.aborted) throw new FilesystemError(11);
      const observed = this.change;
      try {
        return this.close();
      } catch (error) {
        if (!(error instanceof AdmissionBusy)) throw error;
      }
      await this.changed(observed, 50);
    }
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
      if (Atomics.load(this.cells, FAILURE))
        throw new FilesystemError(6, "earlier mutation failed");
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  private async changed(observed: number, timeout?: number): Promise<void> {
    Atomics.add(this.cells, WAITING, 1);
    try {
      const waiting = atomicsWaitAsync(this.cells, CHANGE, observed, timeout);
      if (waiting.async) await waiting.value;
    } finally {
      Atomics.sub(this.cells, WAITING, 1);
    }
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
