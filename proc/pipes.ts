import {
  cryptoRandomUUID,
  scheduleTimeout,
  arrayFrom,
  isSharedArrayBuffer,
  BigInt64ArrayConstructor,
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  Uint8ArrayConstructor,
  atomicsAdd,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsOr,
  atomicsStore,
  atomicsWait,
  atomicsWaitAsync,
  objectFreeze,
  sharedArrayBufferByteLength,
  sharedArrayBufferGrow,
  sharedArrayBufferMaxByteLength,
  typedArrayBuffer,
  typedArrayLength,
  typedArraySet,
  typedArraySubarray,
} from "./intrinsics.ts";
import type { Readiness, Stream } from "../core/descriptors.js";
import { ProcessError } from "./types.js";

export const PipeErrno = objectFreeze({ AGAIN: 6, BADF: 8, INVAL: 28, NFILE: 41, PIPE: 64 });
export type PipeMode = "read" | "write";
export interface PipeOptions {
  /** Each process owns one bounded ring. Capacity must be a power of two. */
  capacity?: number;
  maxWriters?: number;
  maxReaders?: number;
  /** Share this word across a process service so one poll can wait on unrelated descriptors. */
  wake?: Int32Array;
  /** Worker-created pipes leave relay ownership to the supervisor. */
  relay?: "auto" | "manual";
  /** Service-wide canonical cursors let an authorized killer revoke unknown descendant pipes. */
  registry?: PipePublicationRegistry;
  /** Supervisor lifecycle callback after every reference/reservation is gone. */
  onClosed?(): void;
}
export interface PipePublicationRegistryHandle {
  buffer: SharedArrayBuffer;
  processCapacity: number;
  /** Initial allocation hint, not a per-process lifetime limit. */
  cellsPerProcess: number;
  wake: Int32Array;
}
declare const pipeHandleBrand: unique symbol;
/** Opaque structured-cloneable endpoint capability. Only attach/pass it; its wire data is private. */
export interface PipeEndpointHandle {
  readonly id: string;
  readonly pid: number;
  readonly mode: PipeMode;
  readonly [pipeHandleBrand]: true;
}
interface PipeHandleData {
  id: string;
  buffer: SharedArrayBuffer;
  capacity: number;
  maxWriters: number;
  maxReaders: number;
  wake: Int32Array;
  pid: number;
  mode: PipeMode;
  slot: number;
  generation: number;
  lifetime: SharedArrayBuffer;
  fdflags: SharedArrayBuffer;
  registry?: PipePublicationRegistryHandle;
}
function handleData(handle: PipeEndpointHandle): PipeHandleData {
  // This cast is confined to the opaque structured-clone transport boundary.
  return handle as unknown as PipeHandleData;
}

// The ring wrap/copy/notification scheme is adapted from browser/worker.ts SharedPipe.
// Unlike SharedPipe, the committed cursor and its permanent close flag are ONE atomic value.
// Revocation freezes the committed watermark with atomic OR. A producer paused after copying
// cannot publish over that watermark: its compareExchange necessarily loses to revocation.
const STOP = 1n << 32n;
const MASK = STOP - 1n;
const TAG_SHIFT = 33n;
const LOW = (1n << TAG_SHIFT) - 1n;
const RECORD_MASK = (1n << 29n) - 1n;
const INFLIGHT = 1 << 30;
const RELAY_SELECTION = 1n << 62n;
const HEADER = 48;
const RING_HEADER = 56;
function records(capacity: number): number {
  return Math.min(capacity, 1024, 2 ** (30 - Math.log2(capacity)));
}
function stride(capacity: number): number {
  return RING_HEADER + capacity * 2 + records(capacity) * 24;
}
function tag(value: bigint): number {
  return Number(BigInt.asUintN(64, value) >> TAG_SHIFT);
}
function tagged(value: bigint, identity: number): bigint {
  return BigInt.asIntN(64, (BigInt(identity) << TAG_SHIFT) | (value & LOW));
}
let defaultWake: Int32Array | undefined;
function waitChanged(word: Int32Array, observed: number): Promise<unknown> {
  const result = atomicsWaitAsync(word, 0, observed);
  return Promise.resolve(result.value);
}
function notify(word: Int32Array): void {
  atomicsAdd(word, 0, 1);
  atomicsNotify(word, 0);
}
function length(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((total, chunk) => total + typedArrayLength(chunk), 0);
}
function validLimit(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65536;
}

const OWNER_REVOKED = 1n << 31n;
function registryPid(value: bigint): number {
  return Number(value >> 32n);
}
function registryOwner(pid: number): bigint {
  return BigInt(pid) << 32n;
}

/** Host-only service capability. Enrollment precedes endpoint export, and historical PIDs
 * are never enrolled again. Collection freezes mapped cursors but retains their cells until
 * the owning ring is drained/recycled or its controller is disposed. Reassignment increments
 * a cell's tag, so delayed supported operations cannot change a replacement allocation.
 * The growable shared directory has bounded process and cell capacities; no guest owns a lock.
 */
class RegistryStorage {
  readonly wake: Int32Array;
  private readonly owners: BigInt64Array;
  private readonly allocated: Int32Array;
  private readonly cellBase: number;
  private readonly maxCells: number;
  private readonly data: PipePublicationRegistryHandle;
  constructor(
    options: {
      processCapacity?: number;
      cellsPerProcess?: number;
      maxCells?: number;
      wake?: Int32Array;
    } = {},
    attached?: PipePublicationRegistryHandle,
  ) {
    const processCapacity = attached?.processCapacity ?? options.processCapacity ?? 1024;
    const cellsPerProcess = attached?.cellsPerProcess ?? options.cellsPerProcess ?? 128;
    if (!validLimit(processCapacity) || !validLimit(cellsPerProcess))
      throw new RangeError("invalid pipe registry capacity");
    this.wake =
      attached?.wake ??
      options.wake ??
      (defaultWake ??= new Int32ArrayConstructor(new SharedArrayBufferConstructor(4)));
    if (!isSharedArrayBuffer(typedArrayBuffer(this.wake)) || typedArrayLength(this.wake) !== 1)
      throw new TypeError("registry wake must be one shared int32");
    this.cellBase = 16 + processCapacity * 8;
    this.maxCells = attached
      ? (sharedArrayBufferMaxByteLength(attached.buffer) - this.cellBase) / 16
      : (options.maxCells ?? 1 << 24);
    if (!Number.isInteger(this.maxCells) || this.maxCells <= 0 || this.maxCells > 1 << 24)
      throw new RangeError("invalid pipe registry cell limit");
    const initialCells = Math.min(processCapacity * cellsPerProcess, this.maxCells);
    // ES2022's declarations predate growable SABs; the host must implement the modern API.
    const SharedBuffer = SharedArrayBufferConstructor as unknown as {
      new (length: number, options: { __proto__: null; maxByteLength: number }): SharedArrayBuffer;
    };
    const buffer =
      attached?.buffer ??
      new SharedBuffer(this.cellBase + initialCells * 16, {
        __proto__: null,
        maxByteLength: this.cellBase + this.maxCells * 16,
      });
    this.data = { buffer, processCapacity, cellsPerProcess, wake: this.wake };
    this.allocated = new Int32ArrayConstructor(buffer, 0, 1);
    this.owners = new BigInt64ArrayConstructor(buffer, 16, processCapacity);
  }
  handle(): PipePublicationRegistryHandle {
    return { ...this.data };
  }
  get processCount(): number {
    let count = 0;
    for (let slot = 0; slot < typedArrayLength(this.owners); slot++)
      if (atomicsLoad(this.owners, slot)) count++;
    return count;
  }
  private process(pid: number): { slot: number; value: bigint } | undefined {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff)
      throw new Error("invalid registry process");
    // Collection leaves holes. An empty earlier probe does not end a lookup.
    for (let probe = 0; probe < typedArrayLength(this.owners); probe++) {
      const slot = (pid + probe) % typedArrayLength(this.owners);
      const value = atomicsLoad(this.owners, slot);
      if (registryPid(value) === pid) return { slot, value };
    }
    return undefined;
  }
  /** Creation-only service capability. Register a newly issued PID before publishing it to
   * workers or exporting its descriptors. Repeated registration of a live owner is harmless;
   * callers MUST NOT enroll historical PIDs after collection. Attached workers only use the
   * pre-existing enrollment, so late worker startup cannot resurrect a collected process.
   */
  registerProcess(pid: number): void {
    const existing = this.process(pid);
    if (existing) {
      if (existing.value & OWNER_REVOKED) throw new Error("pipe process is revoked");
      return;
    }
    for (let probe = 0; probe < typedArrayLength(this.owners); probe++) {
      const slot = (pid + probe) % typedArrayLength(this.owners);
      const previous = atomicsCompareExchange(this.owners, slot, 0n, registryOwner(pid));
      if (!previous) return;
      if (registryPid(previous) === pid) {
        if (previous & OWNER_REVOKED) throw new Error("pipe process is revoked");
        return;
      }
    }
    throw new ProcessError(PipeErrno.NFILE, "pipe process registry is full");
  }
  isRevoked(pid: number): boolean {
    const owner = this.process(pid);
    return !owner || (owner.value & OWNER_REVOKED) !== 0n;
  }
  private entry(index: number): BigInt64Array {
    return new BigInt64ArrayConstructor(this.data.buffer, this.cellBase + index * 16, 1);
  }
  private ensureCell(index: number): void {
    const buffer = this.data.buffer;
    const needed = this.cellBase + (index + 1) * 16;
    if (sharedArrayBufferByteLength(buffer) >= needed) return;
    const target = Math.min(
      sharedArrayBufferMaxByteLength(buffer),
      Math.max(needed, sharedArrayBufferByteLength(buffer) * 2),
    );
    try {
      sharedArrayBufferGrow(buffer, target);
    } catch (error) {
      if (!(error instanceof RangeError) || sharedArrayBufferByteLength(buffer) < needed)
        throw error;
    }
  }
  /** Reusable cursor allocation. A cell's tag increases on every assignment. */
  allocate(pid: number, initial = 0n): number {
    if (this.isRevoked(pid)) throw new Error("pipe process is revoked");
    for (let index = 0; index < this.maxCells; index++) {
      this.ensureCell(index);
      const entry = this.entry(index),
        previous = atomicsLoad(entry, 0);
      if (registryPid(previous)) continue;
      const generation = Number(previous & 0x7fffffffn) + 1;
      if (generation > 0x7fffffff) continue;
      const owner = registryOwner(pid) | BigInt(generation);
      if (atomicsCompareExchange(entry, 0, previous, owner) !== previous) continue;
      this.publishHighWater(index + 1);
      const cell = this.canonical(index);
      this.initializeCell(cell, initial, generation);
      if (this.isRevoked(pid) || atomicsLoad(entry, 0) !== owner) {
        this.release(index, generation);
        throw new Error("pipe process is revoked");
      }
      return index;
    }
    throw new ProcessError(PipeErrno.NFILE, "pipe cursor registry limit reached");
  }
  private publishHighWater(count: number): void {
    for (;;) {
      const previous = atomicsLoad(this.allocated, 0);
      if (previous >= count) return;
      if (atomicsCompareExchange(this.allocated, 0, previous, count) === previous) return;
    }
  }
  private initializeCell(cell: BigInt64Array, initial: bigint, generation: number): void {
    for (;;) {
      const previous = atomicsLoad(cell, 0);
      if (tag(previous) >= generation) return;
      if (atomicsCompareExchange(cell, 0, previous, tagged(initial, generation)) === previous)
        return;
    }
  }
  canonical(index: number): BigInt64Array {
    const offset = this.cellBase + index * 16 + 8;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= atomicsLoad(this.allocated, 0) ||
      offset + 8 > sharedArrayBufferByteLength(this.data.buffer)
    )
      throw new RangeError("invalid pipe cursor");
    return new BigInt64ArrayConstructor(this.data.buffer, offset, 1);
  }
  generation(index: number): number {
    return Number(atomicsLoad(this.entry(index), 0) & 0x7fffffffn);
  }
  release(index: number, generation: number): void {
    const entry = this.entry(index),
      previous = atomicsLoad(entry, 0);
    if (Number(previous & 0x7fffffffn) !== generation) return;
    this.freezeCell(registryPid(previous), index, generation);
    atomicsCompareExchange(entry, 0, previous, BigInt(generation));
  }
  private freezeOwner(pid: number): { slot: number; value: bigint } | undefined {
    const owner = this.process(pid);
    if (!owner) return undefined;
    for (;;) {
      const value = atomicsLoad(this.owners, owner.slot);
      if (registryPid(value) !== pid) return undefined;
      const revoked = value | OWNER_REVOKED;
      if (atomicsCompareExchange(this.owners, owner.slot, value, revoked) !== value) continue;
      this.freezeCells(pid);
      return { slot: owner.slot, value: revoked };
    }
  }
  private freezeCell(pid: number, index: number, generation?: number): void {
    for (;;) {
      const entry = atomicsLoad(this.entry(index), 0);
      if (
        registryPid(entry) !== pid ||
        (generation !== undefined && Number(entry & 0x7fffffffn) !== generation)
      )
        return;
      const cell = this.canonical(index),
        value = atomicsLoad(cell, 0);
      if (tag(value) !== Number(entry & 0x7fffffffn) || value & STOP) return;
      if (atomicsCompareExchange(cell, 0, value, value | STOP) === value) return;
    }
  }
  private freezeCells(pid: number): void {
    const count = atomicsLoad(this.allocated, 0);
    for (let index = 0; index < count; index++) {
      this.freezeCell(pid, index);
    }
  }
  get resourceUsage(): { allocatedCells: number; activeCells: number; backingBytes: number } {
    const allocatedCells = atomicsLoad(this.allocated, 0);
    let activeCells = 0;
    for (let index = 0; index < allocatedCells; index++)
      if (registryPid(atomicsLoad(this.entry(index), 0))) activeCells++;
    return {
      allocatedCells,
      activeCells,
      backingBytes: sharedArrayBufferByteLength(this.data.buffer),
    };
  }

  revoke(pid: number): void {
    this.freezeOwner(pid);
    notify(this.wake);
  }
  /** Freeze even unannounced descendant-created pipes and release the process row.
   * Mapped cells remain assigned until their ring releases them, not merely until collection.
   */
  collectProcess(pid: number): void {
    const owner = this.freezeOwner(pid);
    if (owner) atomicsCompareExchange(this.owners, owner.slot, owner.value, 0n);
    notify(this.wake);
  }
}
const registryStorage = Symbol("pipe registry storage");
export class PipePublicationRegistry {
  private readonly storage: RegistryStorage;
  constructor(
    options: ConstructorParameters<typeof RegistryStorage>[0] = {},
    attached?: PipePublicationRegistryHandle,
  ) {
    this.storage = new RegistryStorage(options, attached);
  }
  [registryStorage](): RegistryStorage {
    return this.storage;
  }
  get wake(): Int32Array {
    return this.storage.wake;
  }
  get processCount(): number {
    return this.storage.processCount;
  }
  get resourceUsage() {
    return this.storage.resourceUsage;
  }
  handle(): PipePublicationRegistryHandle {
    return this.storage.handle();
  }
  registerProcess(pid: number): void {
    this.storage.registerProcess(pid);
  }
  isRevoked(pid: number): boolean {
    return this.storage.isRevoked(pid);
  }
  revoke(pid: number): void {
    this.storage.revoke(pid);
  }
  collectProcess(pid: number): void {
    this.storage.collectProcess(pid);
  }
}
export function attachPipePublicationRegistry(
  handle: PipePublicationRegistryHandle,
): PipePublicationRegistry {
  return new PipePublicationRegistry({}, handle);
}

/** Single producer and one leased consumer. In relay mode only the supervisor consumes source
 * rings; workers consume their own delivery ring. No guest owns a lock another guest needs.
 */
interface PipeRecord {
  ticket: bigint;
  generation: number;
  end: number;
  index: number;
  remaining: number;
}
class Ring {
  private readonly registry?: RegistryStorage;
  private readonly membership: BigInt64Array;
  private readonly identity: BigInt64Array;
  private readonly localPublished: BigInt64Array;
  private readonly localConsumed: BigInt64Array;
  private readonly mapping: BigInt64Array;
  private readonly requests: BigInt64Array;
  private readonly words: BigInt64Array;
  private readonly metadata: BigInt64Array;
  private readonly positionBits: number;
  private readonly positionMask: number;
  private readonly recordMask: number;
  private readonly recordCapacity: number;
  constructor(
    buffer: SharedArrayBuffer,
    offset: number,
    readonly capacity: number,
    registry?: PipePublicationRegistry,
  ) {
    this.registry = registry?.[registryStorage]();
    this.membership = new BigInt64ArrayConstructor(buffer, offset, 1);
    this.identity = new BigInt64ArrayConstructor(buffer, offset + 48, 1);
    this.localPublished = new BigInt64ArrayConstructor(buffer, offset + 8, 1);
    this.localConsumed = new BigInt64ArrayConstructor(buffer, offset + 16, 1);
    this.mapping = new BigInt64ArrayConstructor(buffer, offset + 24, 2);
    this.requests = new BigInt64ArrayConstructor(buffer, offset + 40, 1);
    this.words = new BigInt64ArrayConstructor(buffer, offset + RING_HEADER, capacity / 4);
    this.recordCapacity = records(capacity);
    this.metadata = new BigInt64ArrayConstructor(
      buffer,
      offset + RING_HEADER + capacity * 2,
      this.recordCapacity * 3,
    );
    this.positionBits = Math.log2(capacity) + 1;
    this.positionMask = capacity * 2 - 1;
    this.recordMask = 2 ** (32 - this.positionBits) - 1;
  }
  get owner(): number {
    const membership = atomicsLoad(this.membership, 0);
    if (membership & STOP) return -Number(membership & MASK);
    const identity = atomicsLoad(this.identity, 0);
    return tag(identity) === tag(membership) ? Number(identity & MASK) : 0;
  }
  get references(): number {
    const membership = atomicsLoad(this.membership, 0);
    return membership & STOP ? 0 : Number(BigInt.asIntN(32, membership));
  }
  get generation(): number {
    return tag(atomicsLoad(this.membership, 0));
  }
  changeReferences(generation: number, previous: number, next: number): boolean {
    const before = tagged(BigInt(previous >>> 0), generation);
    const after = tagged(BigInt(next >>> 0), generation);
    return atomicsCompareExchange(this.membership, 0, before, after) === before;
  }
  reserve(previousGeneration: number, refs: number, pid: number, generation: number): boolean {
    const before = tagged(BigInt(refs >>> 0), previousGeneration);
    return (
      atomicsCompareExchange(this.membership, 0, before, tagged(STOP | BigInt(pid), generation)) ===
      before
    );
  }
  publish(pid: number, generation: number): boolean {
    const before = tagged(STOP | BigInt(pid), generation);
    this.initializeWord(this.identity, 0, generation, BigInt(pid));
    return atomicsCompareExchange(this.membership, 0, before, tagged(1n, generation)) === before;
  }
  cancelReservation(pid: number, generation: number): void {
    atomicsCompareExchange(
      this.membership,
      0,
      tagged(STOP | BigInt(pid), generation),
      tagged(MASK, generation),
    );
  }
  private initializeWord(words: BigInt64Array, at: number, generation: number, initial = 0n): void {
    for (;;) {
      const value = atomicsLoad(words, at);
      if (tag(value) >= generation) return;
      if (atomicsCompareExchange(words, at, value, tagged(initial, generation)) === value) return;
    }
  }
  initialize(generation: number, previousGeneration: number): void {
    this.unbind(previousGeneration);
    this.initializeWord(this.localPublished, 0, generation);
    this.initializeWord(this.localConsumed, 0, generation);
    this.initializeWord(this.mapping, 0, generation);
    this.initializeWord(this.mapping, 1, generation);
    this.initializeWord(this.requests, 0, generation);
    for (let at = 0; at < typedArrayLength(this.words); at++)
      this.initializeWord(this.words, at, generation);
    for (let at = 0; at < typedArrayLength(this.metadata); at++)
      this.initializeWord(this.metadata, at, generation);
  }
  releaseBindings(): void {
    this.unbind(this.generation);
  }
  private unbind(generation: number): void {
    if (!this.registry) return;
    for (let at = 0; at < 2; at++) this.unbindCursor(at, generation);
  }
  private unbindCursor(at: number, expected: number): void {
    const value = atomicsLoad(this.mapping, at),
      index = Number(value & MASK);
    if (!index || tag(value) !== expected) return;
    const generation = this.registry!.generation(index - 1);
    if (atomicsCompareExchange(this.mapping, at, value, tagged(0n, tag(value))) !== value) return;
    this.registry!.release(index - 1, generation);
  }
  get published(): BigInt64Array {
    const index = Number(atomicsLoad(this.mapping, 0) & MASK);
    return index ? this.registry!.canonical(index - 1) : this.localPublished;
  }
  get consumed(): BigInt64Array {
    const index = Number(atomicsLoad(this.mapping, 1) & MASK);
    return index ? this.registry!.canonical(index - 1) : this.localConsumed;
  }
  bind(pid: number, kind: "published" | "consumed", generation = this.generation): void {
    if (!this.registry) return;
    const at = kind === "published" ? 0 : 1;
    const empty = tagged(0n, generation);
    if (atomicsLoad(this.mapping, at) !== empty) return;
    const local = kind === "published" ? this.localPublished : this.localConsumed;
    const value = atomicsLoad(local, 0);
    let index: number;
    try {
      index = this.registry.allocate(pid, value);
    } catch (error) {
      if (kind === "consumed" && this.registry.isRevoked(pid)) {
        this.freezeReader();
        return;
      }
      throw error;
    }
    const cell = this.registry.canonical(index),
      allocation = tag(atomicsLoad(cell, 0));
    if (
      atomicsCompareExchange(this.mapping, at, empty, tagged(BigInt(index + 1), generation)) !==
      empty
    ) {
      this.registry.release(index, allocation);
      return;
    }
    if (atomicsLoad(local, 0) & STOP) this.freezeCursor(cell, allocation);
  }
  private freezeCursor(cell: BigInt64Array, generation = tag(atomicsLoad(cell, 0))): void {
    for (;;) {
      const value = atomicsLoad(cell, 0);
      if (tag(value) !== generation || value & STOP) return;
      if (atomicsCompareExchange(cell, 0, value, value | STOP) === value) return;
    }
  }
  freezeWriter(generation = this.generation): void {
    this.freezeCursor(this.localPublished, generation);
    this.freezeMapped(0, generation);
  }
  freezeReader(generation = this.generation): void {
    this.freezeCursor(this.localConsumed, generation);
    this.freezeMapped(1, generation);
  }
  private cursor(
    at: number,
    generation: number,
  ): { cell: BigInt64Array; generation: number } | undefined {
    const mapping = atomicsLoad(this.mapping, at),
      index = Number(mapping & MASK);
    if (tag(mapping) !== generation) return undefined;
    if (!index) return { cell: at ? this.localConsumed : this.localPublished, generation };
    const allocation = this.registry!.generation(index - 1);
    if (atomicsLoad(this.mapping, at) !== mapping) return undefined;
    return { cell: this.registry!.canonical(index - 1), generation: allocation };
  }
  private freezeMapped(at: number, generation: number): void {
    const cursor = this.cursor(at, generation);
    if (cursor) this.freezeCursor(cursor.cell, cursor.generation);
  }
  private position(value: bigint): number {
    return Number(value & BigInt(this.positionMask));
  }
  private record(value: bigint): number {
    return Number(value & MASK) >>> this.positionBits;
  }
  private advance(value: bigint, bytes: number, record: number): bigint {
    const low =
      BigInt(bytes & this.positionMask) |
      (BigInt(record & this.recordMask) << BigInt(this.positionBits));
    return tagged(low | (value & STOP), tag(value));
  }
  private distance(written: bigint, consumed: bigint): number {
    return (this.position(written) - this.position(consumed)) & this.positionMask;
  }
  get closed(): boolean {
    if (atomicsLoad(this.membership, 0) & STOP) return false;
    return (atomicsLoad(this.published, 0) & STOP) !== 0n;
  }
  get available(): number {
    return Math.min(
      this.capacity,
      this.distance(atomicsLoad(this.published, 0), atomicsLoad(this.consumed, 0)),
    );
  }
  get free(): number {
    return this.capacity - this.available;
  }
  get writable(): boolean {
    return (
      this.free > 0 &&
      ((this.record(atomicsLoad(this.published, 0)) - this.record(atomicsLoad(this.consumed, 0))) &
        this.recordMask) <
        this.recordCapacity
    );
  }
  get demand(): number {
    return Number(atomicsLoad(this.requests, 0) & MASK) | 0;
  }
  changeDemand(previous: number, next: number, generation = this.generation): boolean {
    return (
      atomicsCompareExchange(
        this.requests,
        0,
        tagged(BigInt(previous >>> 0), generation),
        tagged(BigInt(next >>> 0), generation),
      ) === tagged(BigInt(previous >>> 0), generation)
    );
  }
  request(count: number, generation: number): boolean {
    return this.changeDemand(0, Math.min(count, this.capacity), generation);
  }
  head(): PipeRecord | undefined {
    const generation = this.generation,
      consumed = atomicsLoad(this.consumed, 0),
      published = atomicsLoad(this.published, 0);
    if (this.record(consumed) === this.record(published)) return undefined;
    const index = this.record(consumed),
      slot = index % this.recordCapacity;
    const low = atomicsLoad(this.metadata, slot * 3),
      high = atomicsLoad(this.metadata, slot * 3 + 1),
      end = atomicsLoad(this.metadata, slot * 3 + 2);
    if (tag(low) !== generation || tag(high) !== generation || tag(end) !== generation)
      return undefined;
    return {
      index,
      generation,
      end: Number(end & MASK),
      remaining: (Number(end & MASK) - this.position(consumed)) & this.positionMask,
      ticket: BigInt.asIntN(64, ((high & MASK) << 32n) | (low & MASK)),
    };
  }
  private store(words: BigInt64Array, at: number, low: number, generation: number): boolean {
    for (;;) {
      const previous = atomicsLoad(words, at);
      if (tag(previous) !== generation) return false;
      if (
        atomicsCompareExchange(words, at, previous, tagged(BigInt(low >>> 0), generation)) ===
        previous
      )
        return true;
    }
  }
  private writeBytes(copy: Uint8Array, start: number, generation: number): boolean {
    for (let offset = 0; offset < typedArrayLength(copy); offset++) {
      const position = (start + offset) % this.capacity;
      if (!this.writeByte(position, copy[offset]!, generation)) return false;
    }
    return true;
  }
  private writeByte(position: number, byte: number, generation: number): boolean {
    const at = position >>> 2,
      shift = BigInt((position & 3) * 8),
      mask = 255n << shift;
    for (;;) {
      const previous = atomicsLoad(this.words, at);
      if (tag(previous) !== generation) return false;
      const next = (previous & ~mask) | (BigInt(byte) << shift);
      if (atomicsCompareExchange(this.words, at, previous, next) === previous) return true;
    }
  }
  write(
    chunks: readonly Uint8Array[],
    valid: () => boolean,
    ticket: bigint,
    atomic = true,
    generation = this.generation,
  ): number {
    const cursor = this.cursor(0, generation);
    if (!cursor) return -PipeErrno.BADF;
    const publication = cursor.cell,
      published = atomicsLoad(publication, 0);
    if (tag(published) !== cursor.generation || published & STOP || !valid())
      return -PipeErrno.BADF;
    const consumed = atomicsLoad(this.consumed, 0),
      free = this.capacity - this.distance(published, consumed),
      requested = length(chunks),
      used = (this.record(published) - this.record(consumed)) & this.recordMask;
    if (
      used >= this.recordCapacity ||
      (atomic && requested <= Math.min(4096, this.capacity) && free < requested)
    )
      return -PipeErrno.AGAIN;
    const count = Math.min(requested, free);
    if (!count) return -PipeErrno.AGAIN;
    const copy = new Uint8ArrayConstructor(count);
    let copied = 0;
    for (const chunk of chunks) {
      const take = Math.min(typedArrayLength(chunk), count - copied);
      typedArraySet(copy, typedArraySubarray(chunk, 0, take), copied);
      copied += take;
      if (copied === count) break;
    }
    if (!this.writeBytes(copy, this.position(published), generation)) return -PipeErrno.BADF;
    const end = (this.position(published) + count) & this.positionMask,
      record = this.record(published),
      slot = record % this.recordCapacity;
    if (
      !this.store(this.metadata, slot * 3, Number(ticket & MASK), generation) ||
      !this.store(this.metadata, slot * 3 + 1, Number((ticket >> 32n) & MASK), generation) ||
      !this.store(this.metadata, slot * 3 + 2, end, generation) ||
      !valid()
    )
      return -PipeErrno.BADF;
    return atomicsCompareExchange(
      publication,
      0,
      published,
      this.advance(published, end, record + 1),
    ) === published
      ? count
      : -PipeErrno.BADF;
  }
  read(
    chunks: readonly Uint8Array[],
    supervisor = false,
    generation = this.generation,
    valid: () => boolean = () => true,
  ): number {
    const cursor = this.cursor(1, generation);
    if (!cursor) return -PipeErrno.AGAIN;
    const consumption = cursor.cell,
      consumed = atomicsLoad(consumption, 0);
    if (tag(consumed) !== cursor.generation) return -PipeErrno.AGAIN;
    if (!supervisor && consumed & STOP) return -PipeErrno.AGAIN;
    const published = atomicsLoad(this.published, 0);
    if (this.record(consumed) === this.record(published))
      return published & STOP ? 0 : -PipeErrno.AGAIN;
    const record = this.record(consumed),
      slot = record % this.recordCapacity,
      endWord = atomicsLoad(this.metadata, slot * 3 + 2);
    if (tag(endWord) !== generation) return -PipeErrno.AGAIN;
    const remaining = (Number(endWord & MASK) - this.position(consumed)) & this.positionMask,
      count = Math.min(length(chunks), remaining),
      copy = new Uint8ArrayConstructor(count);
    if (!this.readBytes(copy, this.position(consumed), generation) || !valid())
      return -PipeErrno.AGAIN;
    const next = this.advance(
      consumed,
      this.position(consumed) + count,
      record + (count === remaining ? 1 : 0),
    );
    if (atomicsCompareExchange(consumption, 0, consumed, next) !== consumed)
      return -PipeErrno.AGAIN;
    let at = 0;
    for (const chunk of chunks) {
      const take = Math.min(typedArrayLength(chunk), count - at);
      typedArraySet(chunk, typedArraySubarray(copy, at, at + take));
      at += take;
      if (at === count) break;
    }
    return count;
  }
  private readBytes(copy: Uint8Array, start: number, generation: number): boolean {
    for (let offset = 0; offset < typedArrayLength(copy); offset++) {
      const position = (start + offset) % this.capacity,
        word = atomicsLoad(this.words, position >>> 2);
      if (tag(word) !== generation) return false;
      copy[offset] = Number((word >> BigInt((position & 3) * 8)) & 255n);
    }
    return true;
  }
}

function ringSome(rings: readonly Ring[], predicate: (ring: Ring) => boolean): boolean {
  for (let index = 0; index < rings.length; index++) if (predicate(rings[index]!)) return true;
  return false;
}
function ringEvery(rings: readonly Ring[], predicate: (ring: Ring) => boolean): boolean {
  for (let index = 0; index < rings.length; index++) if (!predicate(rings[index]!)) return false;
  return true;
}
function ringReduce(
  rings: readonly Ring[],
  initial: number,
  reducer: (total: number, ring: Ring) => number,
): number {
  let total = initial;
  for (let index = 0; index < rings.length; index++) total = reducer(total, rings[index]!);
  return total;
}
function ringFind(rings: readonly Ring[], predicate: (ring: Ring) => boolean): Ring | undefined {
  for (let index = 0; index < rings.length; index++) {
    const ring = rings[index]!;
    if (predicate(ring)) return ring;
  }
  return undefined;
}
function ringForEach(rings: readonly Ring[], callback: (ring: Ring) => void): void {
  for (let index = 0; index < rings.length; index++) callback(rings[index]!);
}

class PipeState {
  readonly control: Int32Array;
  readonly sequence: BigInt64Array;
  readonly selection: BigInt64Array;
  readonly changed: Int32Array;
  readonly writers: Ring[];
  readonly readers: Ring[];
  readonly capacity: number;
  readonly maxWriters: number;
  readonly maxReaders: number;
  readonly buffer: SharedArrayBuffer;
  readonly id: string;
  readonly wake: Int32Array;
  readonly registry?: PipePublicationRegistry;
  private readonly incarnations: Int32Array;
  constructor(
    handle: Pick<
      PipeHandleData,
      "id" | "buffer" | "capacity" | "maxWriters" | "maxReaders" | "wake" | "registry"
    >,
  ) {
    this.buffer = handle.buffer;
    this.id = handle.id;
    this.registry = handle.registry ? attachPipePublicationRegistry(handle.registry) : undefined;
    this.capacity = handle.capacity;
    this.maxWriters = handle.maxWriters;
    this.maxReaders = handle.maxReaders;
    this.wake = handle.wake;
    this.control = new Int32ArrayConstructor(this.buffer, 0, 6);
    this.sequence = new BigInt64ArrayConstructor(this.buffer, 24, 1);
    this.selection = new BigInt64ArrayConstructor(this.buffer, 32, 1);
    this.changed = new Int32ArrayConstructor(this.buffer, 4, 1);
    this.incarnations = new Int32ArrayConstructor(this.buffer, 40, 1);
    const ringStride = stride(this.capacity);
    const writerSlots = { __proto__: null, length: this.maxWriters };
    const readerSlots = { __proto__: null, length: this.maxReaders };
    this.writers = arrayFrom(
      writerSlots,
      (_, slot) => new Ring(this.buffer, HEADER + slot * ringStride, this.capacity, this.registry),
    );
    this.readers = arrayFrom(
      readerSlots,
      (_, slot) =>
        new Ring(
          this.buffer,
          HEADER + (this.maxWriters + slot) * ringStride,
          this.capacity,
          this.registry,
        ),
    );
  }
  get relay(): boolean {
    return atomicsLoad(this.control, 0) !== 0;
  }
  get disposed(): boolean {
    return atomicsLoad(this.control, 3) !== 0;
  }
  get closed(): boolean {
    const generation = atomicsLoad(this.control, 5);
    if (this.disposed || generation === -1) return true;
    if (generation === 0) return false;
    let alive = false;
    for (let index = 0; index < this.writers.length + this.readers.length; index++) {
      const ring =
        index < this.writers.length
          ? this.writers[index]!
          : this.readers[index - this.writers.length]!;
      const pid = ring.owner;
      if (
        pid &&
        !this.registry?.isRevoked(Math.abs(pid)) &&
        (pid < 0 ? !ring.closed : ring.references > 0)
      ) {
        alive = true;
        break;
      }
    }
    if (alive) return false;
    // A new reservation changes the generation AFTER publishing its negative owner but
    // BEFORE publishing references. A scan that passed that slot cannot retire the pipe.
    return atomicsCompareExchange(this.control, 5, generation, -1) === generation;
  }
  private admit(): void {
    for (;;) {
      const generation = atomicsLoad(this.control, 5);
      if (generation === -1 || this.disposed) throw new Error("pipe endpoint is closed");
      const next = generation === -2 ? 1 : (generation + 1) | 0;
      if (atomicsCompareExchange(this.control, 5, generation, next) === generation) return;
    }
  }
  signal(): void {
    notify(this.changed);
    notify(this.wake);
  }
  readerAlive(ring: Ring): boolean {
    return ring.owner > 0 && ring.references > 0 && !this.registry?.isRevoked(ring.owner);
  }
  hasReaders(): boolean {
    return ringSome(this.readers, (ring) => this.readerAlive(ring));
  }
  eof(): boolean {
    const generation = atomicsLoad(this.control, 5);
    if (!ringEvery(this.writers, (ring) => ring.owner === 0 || ring.closed)) return false;
    // Closed flags never reopen, but a child can reserve an earlier, already-scanned slot
    // before its parent closes a later slot. Validate the admission epoch so those two
    // observations cannot manufacture EOF while a reserved writer is still alive.
    if (atomicsLoad(this.control, 5) !== generation) {
      // Return AGAIN instead of spinning. Wake the caller even when the overlapping
      // handoff already completed (and sent its last notification) inside this scan.
      this.signal();
      return false;
    }
    return true;
  }
  queued(): number {
    return ringReduce(
      this.writers,
      0,
      (total, ring) => total + (ring.owner > 0 ? ring.available : 0),
    );
  }
  relayAvailable(): number {
    return (
      this.queued() +
      Math.max(0, atomicsLoad(this.control, 4)) +
      ringReduce(this.readers, 0, (total, ring) => total + (ring.owner > 0 ? ring.available : 0))
    );
  }
  nextTicket(): bigint {
    return BigInt.asIntN(64, atomicsAdd(this.sequence, 0, 1n) + 1n);
  }
  source(supervisor: boolean): { ring: Ring; record: PipeRecord; pin: bigint } | undefined {
    const selection = atomicsLoad(this.selection, 0),
      relay = selection & RELAY_SELECTION;
    if (!supervisor && relay) return undefined;
    const selected = Number(selection & 0x1ffffn) - 1;
    if (selected >= 0) {
      const ring = this.writers[selected]!,
        record = ring.head();
      if (record?.index === Number((selection >> 17n) & RECORD_MASK))
        return { ring, record, pin: selection };
      // A reader may die after consuming the last byte but before releasing its pin.
      // Canonical consumption makes stale pins helpable without that reader's cleanup.
      if (atomicsCompareExchange(this.selection, 0, selection, relay) === selection)
        return this.source(supervisor);
      return undefined;
    }
    // Exclude tickets issued after the scan begins: otherwise an earlier slot scanned empty
    // could commit A before B starts, but the same scan would incorrectly choose later B.
    const ceiling = atomicsLoad(this.sequence, 0);
    let chosen: { ring: Ring; record: PipeRecord; pin: bigint } | undefined;
    for (let index = 0; index < this.writers.length; index++) {
      const ring = this.writers[index]!;
      if (ring.owner <= 0) continue;
      const record = ring.head();
      if (!record || BigInt.asIntN(64, record.ticket - ceiling) > 0n) continue;
      if (chosen && BigInt.asIntN(64, record.ticket - chosen.record.ticket) >= 0n) continue;
      chosen = { ring, record, pin: relay | BigInt(index + 1) | (BigInt(record.index) << 17n) };
    }
    if (!chosen || atomicsCompareExchange(this.selection, 0, relay, chosen.pin) !== relay)
      return undefined;
    return chosen;
  }
  consume(
    source: { ring: Ring; record: PipeRecord; pin: bigint },
    chunks: readonly Uint8Array[],
    supervisor: boolean,
    valid: () => boolean = () => true,
  ): number {
    const result = source.ring.read(chunks, supervisor, source.record.generation, valid);
    if (source.ring.head()?.index !== source.record.index)
      atomicsCompareExchange(this.selection, 0, source.pin, source.pin & RELAY_SELECTION);
    return result;
  }
  switchToRelay(): void {
    atomicsOr(this.selection, 0, RELAY_SELECTION);
    // Revoke the old direct consumer's lease BEFORE publishing relay mode. A delayed direct
    // read cannot advance a ring's cursor after the supervisor takes over consumption.
    ringForEach(this.writers, (ring) => ring.freezeReader());
    atomicsStore(this.control, 0, 1);
    this.signal();
  }
  private nextGeneration(): number {
    for (;;) {
      const previous = atomicsLoad(this.incarnations, 0);
      if (previous >= 0x7fffffff)
        throw new ProcessError(PipeErrno.NFILE, "pipe incarnation space exhausted");
      if (atomicsCompareExchange(this.incarnations, 0, previous, previous + 1) === previous)
        return previous + 1;
    }
  }
  private retainReference(ring: Ring, generation: number): void {
    for (;;) {
      const refs = ring.references;
      if (ring.generation !== generation || refs <= 0) throw new Error("pipe endpoint is closed");
      if (ring.changeReferences(generation, refs, refs + 1)) return;
    }
  }
  private initializeReservation(
    ring: Ring,
    pid: number,
    mode: PipeMode,
    generation: number,
    previousGeneration: number,
  ): void {
    try {
      this.admit();
      ring.initialize(generation, previousGeneration);
      ring.bind(pid, "published", generation);
      if (mode === "read") ring.bind(pid, "consumed", generation);
      else if (!this.relay) this.bindDirectReader(ring, generation);
      if (this.registry?.isRevoked(pid) || !ring.publish(pid, generation))
        throw new Error("pipe process is revoked");
    } catch (error) {
      ring.freezeWriter(generation);
      ring.cancelReservation(pid, generation);
      this.signal();
      throw error;
    }
  }
  private bindDirectReader(ring: Ring, generation: number): void {
    const reader = ringFind(this.readers, (candidate) => this.readerAlive(candidate));
    if (reader) ring.bind(reader.owner, "consumed", generation);
  }
  retain(pid: number, mode: PipeMode, fdflags = new SharedArrayBufferConstructor(4)): PipeEndpoint {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff || this.closed)
      throw new Error("invalid pipe process");
    if (
      this.registry?.isRevoked(pid) ||
      ringSome(this.writers, (ring) => ring.owner === pid && ring.references < 0) ||
      ringSome(this.readers, (ring) => ring.owner === pid && ring.references < 0)
    )
      throw new Error("pipe process is revoked");
    // Allocate before acquiring a ring reference, so failed allocation owns no endpoint.
    const lifetime = new SharedArrayBufferConstructor(4);
    const rings = mode === "write" ? this.writers : this.readers;
    // Deterministic probing makes simultaneous reservation of the SAME pid contend on the
    // same slot. Negative owner is an unpublished reservation, never a live writer/reader.
    let selected = -1,
      selectedGeneration = 0;
    for (let probe = 0; probe < rings.length; probe++) {
      const slot = (pid + probe) % rings.length;
      const ring = rings[slot]!;
      const generation = ring.generation,
        owner = ring.owner;
      if (owner < 0) continue;
      if (owner === pid) {
        this.retainReference(ring, generation);
        selected = slot;
        selectedGeneration = generation;
        break;
      }
      const refs = ring.references,
        previousGeneration = ring.generation;
      if (owner && ((refs > 0 && !this.registry?.isRevoked(Math.abs(owner))) || ring.available))
        continue;
      const nextGeneration = this.nextGeneration();
      if (!ring.reserve(previousGeneration, refs, pid, nextGeneration)) continue;
      this.initializeReservation(ring, pid, mode, nextGeneration, previousGeneration);
      selectedGeneration = nextGeneration;
      selected = slot;
      break;
    }
    if (selected < 0) throw new ProcessError(PipeErrno.NFILE, `pipe ${mode} process limit reached`);
    const endpoint = new PipeEndpoint(
      this,
      pid,
      mode,
      selected,
      selectedGeneration,
      lifetime,
      fdflags,
    );
    try {
      if (!endpoint.live) throw new Error("pipe endpoint is closed");
      // Both sides publish identity before checking the other side. Concurrent first reader
      // and writer reservations cannot both miss registering the direct consumer's lease.
      // No producer can publish bytes until its reservation has returned the endpoint.
      if (mode === "write" && !this.relay) {
        const reader = ringFind(this.readers, (candidate) => this.readerAlive(candidate));
        if (reader) rings[selected]!.bind(reader.owner, "consumed", selectedGeneration);
      }
      if (mode === "read") {
        const directReader = new Int32ArrayConstructor(this.buffer, 44, 1);
        const priorReader = atomicsCompareExchange(directReader, 0, 0, selectedGeneration);
        if (
          (priorReader !== 0 && priorReader !== selectedGeneration) ||
          ringSome(this.readers, (ring) => ring.owner > 0 && ring.owner !== pid) ||
          ringSome(this.writers, (ring) => (atomicsLoad(ring.consumed, 0) & STOP) !== 0n)
        )
          this.switchToRelay();
        else if (!this.relay)
          ringForEach(this.writers, (source) => {
            if (source.owner > 0) source.bind(pid, "consumed");
          });
      }
      this.signal();
      return endpoint;
    } catch (error) {
      endpoint.close();
      throw error;
    }
  }
  revoke(pid: number, mode?: PipeMode): void {
    const revokeRings = (rings: readonly Ring[], readers: boolean): void => {
      ringForEach(rings, (ring) => {
        const generation = ring.generation,
          owner = ring.owner,
          refs = ring.references;
        if (Math.abs(owner) !== pid || refs < 0) return;
        ring.freezeWriter(generation);
        if (readers) {
          ring.freezeReader(generation);
          if (!this.relay) ringForEach(this.writers, (source) => source.freezeReader());
        }
        if (owner < 0) ring.cancelReservation(pid, generation);
        else ring.changeReferences(generation, refs, -1);
      });
    };
    if (mode === "read") revokeRings(this.readers, true);
    else if (mode === "write") revokeRings(this.writers, false);
    else {
      revokeRings(this.writers, false);
      revokeRings(this.readers, true);
    }
    this.signal();
  }
}

/** A reference to one reading/writing process's endpoint, usable directly or after cloning its
 * handle into a worker. Duplicated descriptors should share one OpenDescription as usual.
 */
export class PipeEndpoint implements Stream {
  readonly kind = "pipe" as const;
  readonly notification: Int32Array;
  private readonly lifetime: Int32Array;
  private readonly flags: Int32Array;
  constructor(
    private readonly state: PipeState,
    readonly pid: number,
    readonly mode: PipeMode,
    private readonly slot: number,
    private readonly generation: number,
    lifetime: SharedArrayBuffer,
    fdflags: SharedArrayBuffer,
  ) {
    this.notification = state.wake;
    this.lifetime = new Int32ArrayConstructor(lifetime);
    this.flags = new Int32ArrayConstructor(fdflags, 0, 1);
  }
  private get ring(): Ring {
    return (this.mode === "write" ? this.state.writers : this.state.readers)[this.slot]!;
  }
  get live(): boolean {
    return (
      !this.state.disposed &&
      atomicsLoad(this.lifetime, 0) === 0 &&
      this.ring.owner === this.pid &&
      this.ring.generation === this.generation &&
      this.ring.references > 0 &&
      !this.state.registry?.isRevoked(this.pid)
    );
  }
  get fdflags(): number {
    return atomicsLoad(this.flags, 0);
  }
  set fdflags(value: number) {
    atomicsStore(this.flags, 0, value);
  }
  handle(): PipeEndpointHandle {
    const wire: PipeHandleData = {
      id: this.state.id,
      buffer: this.state.buffer,
      capacity: this.state.capacity,
      maxWriters: this.state.maxWriters,
      maxReaders: this.state.maxReaders,
      wake: this.notification,
      pid: this.pid,
      mode: this.mode,
      slot: this.slot,
      generation: this.generation,
      lifetime: typedArrayBuffer(this.lifetime) as SharedArrayBuffer,
      fdflags: typedArrayBuffer(this.flags) as SharedArrayBuffer,
      registry: this.state.registry?.handle(),
    };
    return wire as unknown as PipeEndpointHandle;
  }
  forProcess(pid: number): PipeEndpoint {
    if (!this.live) throw new Error("pipe endpoint is closed");
    return pid === this.pid
      ? this
      : this.state.retain(pid, this.mode, typedArrayBuffer(this.flags) as SharedArrayBuffer);
  }
  inherit(pid: number): PipeEndpoint {
    return this.forProcess(pid);
  }
  revoke(): void {
    this.state.registry?.revoke(this.pid);
    this.state.revoke(this.pid, this.mode);
  }
  close(): void {
    if (atomicsCompareExchange(this.lifetime, 0, 0, 1) !== 0) return;
    for (;;) {
      const refs = this.ring.references;
      if (refs <= 0 || this.ring.owner !== this.pid || this.ring.generation !== this.generation)
        break;
      if (!this.ring.changeReferences(this.generation, refs, refs - 1)) continue;
      if (refs === 1) {
        this.ring.freezeWriter(this.generation);
        if (this.mode === "read") {
          this.ring.freezeReader(this.generation);
          if (!this.state.relay) ringForEach(this.state.writers, (source) => source.freezeReader());
        }
      }
      break;
    }
    this.state.signal();
  }
  tryWrite(chunks: readonly Uint8Array[]): number {
    if (this.mode !== "write" || !this.live) return -PipeErrno.BADF;
    if (!length(chunks)) return 0;
    if (!this.state.hasReaders()) return -PipeErrno.PIPE;
    const result = this.ring.write(chunks, () => this.live, this.state.nextTicket());
    if (result > 0) this.state.signal();
    return result;
  }
  tryRead(chunks: readonly Uint8Array[]): number {
    if (this.mode !== "read" || !this.live) return -PipeErrno.BADF;
    if (!length(chunks)) return 0;
    if (this.state.relay) {
      const result = this.ring.read(chunks, false, this.generation, () => this.live);
      if (!this.live) return -PipeErrno.BADF;
      if (result > 0) this.state.signal();
      else if (result === -PipeErrno.AGAIN && this.ring.request(length(chunks), this.generation))
        this.state.signal();
      return result;
    }
    const source = this.state.source(false);
    if (source) {
      const result = this.state.consume(source, chunks, false, () => this.live);
      if (result < 0 && !this.live) return -PipeErrno.BADF;
      if (result > 0) {
        this.state.signal();
        return result;
      }
    }
    if (this.state.relay) return this.tryRead(chunks);
    return this.state.eof() && this.state.queued() === 0 ? 0 : -PipeErrno.AGAIN;
  }

  read(chunks: readonly Uint8Array[]): number {
    return this.block(() => this.tryRead(chunks));
  }
  write(chunks: readonly Uint8Array[]): number {
    return this.block(() => this.tryWrite(chunks));
  }
  private block(operation: () => number): number {
    for (;;) {
      const observed = atomicsLoad(this.notification, 0);
      const result = operation();
      if (result !== -PipeErrno.AGAIN) return result;
      atomicsWait(this.notification, 0, observed);
    }
  }
  readiness(): Readiness {
    if (!this.live)
      return { readable: this.mode === "read", writable: false, hangup: true, nbytes: 0 };
    if (this.mode === "write") {
      const hangup = !this.state.hasReaders();
      return { readable: false, writable: !hangup && this.ring.writable, hangup, nbytes: 0 };
    }
    const nbytes = this.state.relay ? this.state.relayAvailable() : this.state.queued();
    const hangup = this.state.relay ? this.ring.closed : this.state.eof();
    return { readable: nbytes > 0 || hangup, writable: false, hangup, nbytes };
  }
  waitReadable(): Promise<void> {
    return this.wait("readable");
  }
  waitWritable(): Promise<void> {
    return this.wait("writable");
  }
  private async wait(key: "readable" | "writable"): Promise<void> {
    for (;;) {
      const observed = atomicsLoad(this.notification, 0);
      const state = this.readiness();
      if (state[key] || state.hangup) {
        // An earlier EAGAIN may have posted relay demand while bytes are still staged for a
        // different reader. Yield an actual task before retrying; resolved-promise polling
        // must not starve the supervisor's bounded relay task.
        if (
          key === "readable" &&
          this.mode === "read" &&
          this.state.relay &&
          !this.ring.available &&
          this.ring.demand > 0 &&
          !state.hangup
        ) {
          await new Promise<void>((resolve) => scheduleTimeout(resolve, 0));
        }
        return;
      }
      await waitChanged(this.notification, observed);
    }
  }
}

/** Supervisor control plane. Source and delivery rings are in a bounded shared directory, so
 * synchronous fd_read sees newly inherited writers without needing MessagePort dispatch.
 * Defaults allocate 4,982,576 bytes per pipe, including tagged payload and record metadata.
 * Atomic writes are <=4096 bytes (or capacity in tiny configured rings). Drained slots reuse
 * bounded backing with a new incarnation; opaque endpoints retain their original incarnation.
 */
export class PipeController {
  private readonly state: PipeState;
  private stopped = false;
  private ownsRelay = false;
  private runningRelay = false;
  private readerCursor = 0;
  private pending?: Uint8Array;
  private pendingAt = 0;
  private pendingTicket = 0n;
  private delivery?: { ring: Ring; generation: number };
  private readonly onClosed?: () => void;
  private reportedClosed = false;
  constructor(options: PipeOptions = {}, attached?: PipeEndpointHandle) {
    this.onClosed = options.onClosed;
    if (attached) this.state = new PipeState(handleData(attached));
    else {
      const capacity = options.capacity ?? 65536;
      const maxWriters = options.maxWriters ?? 16,
        maxReaders = options.maxReaders ?? 16;
      if (
        !Number.isInteger(capacity) ||
        capacity < 8 ||
        capacity > 1 << 24 ||
        (capacity & (capacity - 1)) !== 0
      )
        throw new RangeError("pipe capacity must be a power of two between 8 and 16777216");
      if (!validLimit(maxWriters) || !validLimit(maxReaders))
        throw new RangeError("invalid pipe process limit");
      const wake =
        options.registry?.wake ??
        options.wake ??
        (defaultWake ??= new Int32ArrayConstructor(new SharedArrayBufferConstructor(4)));
      if (!isSharedArrayBuffer(typedArrayBuffer(wake)) || typedArrayLength(wake) !== 1)
        throw new TypeError("pipe wake must be one shared int32");
      this.state = new PipeState({
        id: cryptoRandomUUID(),
        buffer: new SharedArrayBufferConstructor(
          HEADER + (maxWriters + maxReaders) * stride(capacity),
        ),
        capacity,
        maxWriters,
        maxReaders,
        wake,
        registry: options.registry?.handle(),
      });
    }
    if (options.relay !== "manual") this.startRelay();
  }
  get resourceUsage(): {
    backingBytes: number;
    activeWriters: number;
    activeReaders: number;
    incarnations: number;
  } {
    return {
      backingBytes: sharedArrayBufferByteLength(this.state.buffer),
      activeWriters: ringReduce(
        this.state.writers,
        0,
        (n, ring) =>
          n +
          Number(
            ring.owner > 0 && ring.references > 0 && !this.state.registry?.isRevoked(ring.owner),
          ),
      ),
      activeReaders: ringReduce(
        this.state.readers,
        0,
        (n, ring) =>
          n +
          Number(
            ring.owner > 0 && ring.references > 0 && !this.state.registry?.isRevoked(ring.owner),
          ),
      ),
      incarnations: atomicsLoad(new Int32ArrayConstructor(this.state.buffer, 40, 1), 0),
    };
  }
  get closed(): boolean {
    return this.state.closed;
  }
  get mode(): "direct" | "relay" {
    return this.state.relay ? "relay" : "direct";
  }
  get notification(): Int32Array {
    return this.state.wake;
  }
  retain(pid: number, mode: PipeMode): PipeEndpoint {
    return this.state.retain(pid, mode);
  }
  duplicate(endpoint: PipeEndpoint): PipeEndpoint {
    if (endpoint.handle().id !== this.state.id) throw new Error("endpoint belongs to another pipe");
    if (!endpoint.live) throw new Error("pipe endpoint is closed");
    return this.state.retain(endpoint.pid, endpoint.mode, handleData(endpoint.handle()).fdflags);
  }
  revoke(pid: number): void {
    this.state.registry?.revoke(pid);
    this.state.revoke(pid);
  }
  /** Bounded supervisor batch. Only an actual empty read posts demand; readiness never
   * reserves bytes. One outstanding delivery keeps a source record's unread tail ahead of
   * later writes. Its canonical consumption cursor decides the guest/reclaimer CAS winner.
   */
  pumpRelay(): void {
    if (this.stopped || !this.state.relay || this.state.disposed) return;
    this.claimRelay();
    for (let step = 0; step < 64; step++) {
      if (this.delivery) {
        const { ring, generation } = this.delivery;
        if (ring.generation !== generation || !ring.available) this.delivery = undefined;
        else {
          const alive = this.state.readerAlive(ring);
          const otherDemand = ringSome(
            this.state.readers,
            (candidate) =>
              candidate !== ring && this.state.readerAlive(candidate) && candidate.demand > 0,
          );
          if (alive && !otherDemand) break;
          if (!alive) {
            ring.freezeWriter(generation);
            ring.freezeReader(generation);
          }
          const head = ring.head();
          if (!head) {
            this.delivery = undefined;
            continue;
          }
          const copy = new Uint8ArrayConstructor(Math.min(head.remaining, 65536));
          const count = ring.read([copy], true, generation);
          if (count <= 0) continue;
          const tail = this.pending
            ? typedArraySubarray(this.pending, this.pendingAt)
            : new Uint8ArrayConstructor();
          const recovered = new Uint8ArrayConstructor(count + typedArrayLength(tail));
          typedArraySet(recovered, typedArraySubarray(copy, 0, count));
          typedArraySet(recovered, tail, count);
          this.pending = recovered;
          this.pendingAt = 0;
          this.pendingTicket = head.ticket;
          atomicsStore(this.state.control, 4, typedArrayLength(recovered));
          if (!ring.available) this.delivery = undefined;
          this.state.signal();
          // A live reader can abandon an EAGAIN request. Reclaiming with the SAME consumed
          // CAS safely reroutes its unread bytes, rather than waiting for it to close or die.
          continue;
        }
      }
      let destination: Ring | undefined;
      let destinationGeneration = 0;
      let budget = 0;
      for (let visited = 0; visited < this.state.readers.length; visited++) {
        const index = (this.readerCursor + visited) % this.state.readers.length,
          ring = this.state.readers[index]!;
        const generation = ring.generation,
          demand = ring.demand;
        if (
          !this.state.readerAlive(ring) ||
          ring.closed ||
          ring.available ||
          demand <= 0 ||
          demand & INFLIGHT
        )
          continue;
        if (!ring.changeDemand(demand, demand | INFLIGHT, generation)) continue;
        destination = ring;
        destinationGeneration = generation;
        budget = demand;
        this.readerCursor = (index + 1) % this.state.readers.length;
        break;
      }
      if (!destination) break;
      if (!this.pending) {
        const source = this.state.source(true);
        if (!source) {
          destination.changeDemand(budget | INFLIGHT, budget, destinationGeneration);
          break;
        }
        const chunk = new Uint8ArrayConstructor(Math.min(source.record.remaining, budget, 65536));
        const count = this.state.consume(source, [chunk], true);
        if (count <= 0) {
          destination.changeDemand(budget | INFLIGHT, budget, destinationGeneration);
          break;
        }
        this.pending = typedArraySubarray(chunk, 0, count);
        this.pendingAt = 0;
        this.pendingTicket = source.record.ticket;
        atomicsStore(this.state.control, 4, count);
        this.state.signal();
      }
      const piece = typedArraySubarray(
        this.pending,
        this.pendingAt,
        this.pendingAt + Math.min(budget, 65536),
      );
      const delivered = destination.write(
        [piece],
        () =>
          destination!.generation === destinationGeneration && this.state.readerAlive(destination!),
        this.pendingTicket,
        false,
        destinationGeneration,
      );
      // INFLIGHT prevents a guest racing publication from accidentally posting ghost demand.
      destination.changeDemand(budget | INFLIGHT, 0, destinationGeneration);
      if (delivered > 0) {
        this.pendingAt += delivered;
        atomicsStore(this.state.control, 4, typedArrayLength(this.pending) - this.pendingAt);
        if (this.pendingAt === typedArrayLength(this.pending)) this.pending = undefined;
        this.delivery = { ring: destination, generation: destinationGeneration };
        this.state.signal();
      } else if (delivered === -PipeErrno.AGAIN) break;
    }
    if (!this.pending && this.state.eof() && this.state.relayAvailable() === 0) {
      let changed = false;
      ringForEach(this.state.readers, (ring) => {
        if (ring.owner <= 0 || ring.closed) return;
        ring.freezeWriter();
        changed = true;
      });
      if (changed) this.state.signal();
    }
  }

  private claimRelay(): void {
    if (this.ownsRelay) return;
    if (atomicsCompareExchange(this.state.control, 2, 0, 1) !== 0)
      throw new Error("pipe already has a relay supervisor");
    this.ownsRelay = true;
  }
  startRelay(): void {
    if (this.runningRelay || this.stopped) return;
    this.claimRelay();
    this.runningRelay = true;
    void this.serviceRelay();
  }
  private async serviceRelay(): Promise<void> {
    const signal = this.state.registry ? this.state.wake : this.state.changed;
    while (!this.stopped && !this.closed) {
      const observed = atomicsLoad(signal, 0);
      this.pumpRelay();
      if (this.stopped || this.closed) break;
      // Our own progress causes one extra pass, then the fixed-point pump emits no changes.
      // Registry revocation has no pipe address, so registry-backed relays use the service word.
      if (atomicsLoad(signal, 0) !== observed) {
        // A microtask-only loop starves kill/exit MessagePort tasks under continuous traffic.
        await new Promise<void>((resolve) => scheduleTimeout(resolve, 0));
        continue;
      }
      await waitChanged(signal, observed);
    }
    this.reportClosed();
  }
  private reportClosed(): void {
    if (!this.closed || this.reportedClosed) return;
    this.reportedClosed = true;
    this.onClosed?.();
  }
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = undefined;
    this.delivery = undefined;
    atomicsStore(this.state.control, 4, 0);
    atomicsStore(this.state.control, 3, 1);
    const rings = this.state.writers.length + this.state.readers.length;
    for (let index = 0; index < rings; index++) {
      const ring =
        index < this.state.writers.length
          ? this.state.writers[index]!
          : this.state.readers[index - this.state.writers.length]!;
      const pid = ring.owner;
      if (pid > 0) this.state.revoke(pid);
      ring.releaseBindings();
    }
    this.state.signal();
    this.reportClosed();
  }
}

export function attachPipeEndpoint(handle: PipeEndpointHandle): PipeEndpoint {
  const data = handleData(handle),
    state = new PipeState(data);
  const limit = data.mode === "write" ? state.maxWriters : state.maxReaders;
  if (!Number.isInteger(data.slot) || data.slot < 0 || data.slot >= limit)
    throw new RangeError("invalid pipe slot");
  return new PipeEndpoint(
    state,
    data.pid,
    data.mode,
    data.slot,
    data.generation,
    data.lifetime,
    data.fdflags,
  );
}
export function attachPipeController(
  handle: PipeEndpointHandle,
  options: Pick<PipeOptions, "relay" | "onClosed"> = {},
): PipeController {
  return new PipeController(options, handle);
}
