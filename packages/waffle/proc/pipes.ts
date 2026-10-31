import {
  cryptoRandomUUID,
  scheduleTimeout,
  arrayFrom,
  isSharedArrayBuffer,
  BigInt64ArrayConstructor,
  DataViewConstructor,
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  Uint8ArrayConstructor,
  atomicsAdd,
  atomicsCompareExchange,
  atomicsExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsOr,
  atomicsStore,
  atomicsWait,
  atomicsWaitAsync,
  dataViewGetUint32,
  dataViewSetUint32,
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
/** Structured-cloneable capability. Transfer preserves one reference; forProcess/duplicate
 * reserve new references. Slot incarnations fence supported operations after reuse.
 */
export interface PipeEndpointHandle {
  /** SAB wrappers change identity when cloned; this stable id identifies the underlying pipe. */
  id: string;
  buffer: SharedArrayBuffer;
  capacity: number;
  maxWriters: number;
  maxReaders: number;
  wake: Int32Array;
  pid: number;
  mode: PipeMode;
  slot: number;
  incarnation: number;
  lifetime: SharedArrayBuffer;
  /** Shared by every inherited/duplicated reference to this open description. */
  fdflags: SharedArrayBuffer;
  registry?: PipePublicationRegistryHandle;
}

// The ring wrap/copy/notification scheme is adapted from browser/worker.ts SharedPipe.
// Unlike SharedPipe, the committed cursor and its permanent close flag are ONE atomic value.
// Revocation freezes the committed watermark with atomic OR. A producer paused after copying
// cannot publish over that watermark: its compareExchange necessarily loses to revocation.
const STOP = 1n << 32n;
const MASK = STOP - 1n;
const ALLOCATED = 1n << 33n;
const RECORD_SHIFT = 34n;
const RECORD_MASK = (1n << 29n) - 1n;
const INFLIGHT = 1 << 30;
const RELAY_SELECTION = 1n << 62n;
const HEADER = 40;
const RING_HEADER = 40;
const SECTION_MASK = 0xff;
const INCARNATION_SHIFT = 8;
const LAST_INCARNATION = 0x7fffff;
const RECLAIMING = -0x80000000;
function records(capacity: number): number {
  return Math.min(capacity, 1024);
}
function stride(capacity: number): number {
  return RING_HEADER + capacity + records(capacity) * 16;
}
function recordCounter(value: bigint): number {
  return Number((value >> RECORD_SHIFT) & RECORD_MASK);
}
function advance(value: bigint, bytes: number, record: number): bigint {
  return (
    (value & (STOP | ALLOCATED)) |
    BigInt(bytes >>> 0) |
    (BigInt(record & Number(RECORD_MASK)) << RECORD_SHIFT)
  );
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
function counter(value: bigint): number {
  return Number(value & MASK);
}
function distance(written: bigint, read: bigint): number {
  return (counter(written) - counter(read)) >>> 0;
}
function validLimit(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65536;
}

const OWNER_REVOKED = 1n << 31n;
const OWNER_HEAD = OWNER_REVOKED - 1n;
function registryPid(value: bigint): number {
  return Number(value >> 32n);
}
function registryOwner(pid: number): bigint {
  return BigInt(pid) << 32n;
}

/** Host-only service capability: never expose this control buffer as guest WASM memory.
 * Authorization (parent chain/job ownership) belongs to the process service, BEFORE revoke.
 * The service enrolls each newly issued, never-reused PID before exporting any endpoints.
 * Collection freezes its cursors and releases its bounded owner row. PID, revoked flag and
 * list head share one CAS word: a paused allocator or killer cannot change a reused row.
 * Only enrollment creates owners; delayed allocate/revoke/collect calls never recreate one.
 * Canonical cells have append-only global indices in a growable SAB. Their full cursor
 * payload has no incarnation tag, so retained raw views must NEVER alias another cursor.
 * No guest holds a lock. This requires modern growable SharedArrayBuffer support.
 * Bounds: 1024 simultaneous enrolled processes by default; 1048576 lifetime cells
 * (16 MiB maximum committed cell storage). Explicit maxCells supports up to 16777216 cells.
 * Cell exhaustion is ENFILE, not unsafe reuse or unbounded allocation. Initial storage is
 * ~2 MiB. Collecting owners does not reclaim the intentionally permanent cursor arena.
 */
export class PipePublicationRegistry {
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
      /** Host allocator charges the declared backing before constructing it. */
      allocate?: (length: number, maxByteLength: number) => SharedArrayBuffer;
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
      : (options.maxCells ?? 1 << 20);
    if (!Number.isInteger(this.maxCells) || this.maxCells <= 0 || this.maxCells > 1 << 24)
      throw new RangeError("invalid pipe registry cell limit");
    const initialCells = Math.min(processCapacity * cellsPerProcess, this.maxCells);
    // ES2022's declarations predate growable SABs; the host must implement the modern API.
    const SharedBuffer = SharedArrayBufferConstructor as unknown as {
      new (length: number, options: { __proto__: null; maxByteLength: number }): SharedArrayBuffer;
    };
    const buffer =
      attached?.buffer ??
      (options.allocate
        ? options.allocate(this.cellBase + initialCells * 16, this.cellBase + this.maxCells * 16)
        : new SharedBuffer(this.cellBase + initialCells * 16, {
            __proto__: null,
            maxByteLength: this.cellBase + this.maxCells * 16,
          }));
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
  private reserveCell(): number {
    for (;;) {
      const index = atomicsLoad(this.allocated, 0);
      if (index >= this.maxCells)
        throw new ProcessError(PipeErrno.NFILE, "pipe cursor registry limit reached");
      if (atomicsCompareExchange(this.allocated, 0, index, index + 1) === index) return index;
    }
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
      // Another allocator can grow beyond our target between reading length and grow().
      // That operation cannot shrink the buffer, but its RangeError is not an allocation
      // failure if the cell we actually need is already available.
      if (!(error instanceof RangeError) || sharedArrayBufferByteLength(buffer) < needed)
        throw error;
    }
  }
  /** Internal cursor allocation; the returned global cell never moves or gets recycled. */
  allocate(pid: number): number {
    const owner = this.process(pid);
    if (!owner || owner.value & OWNER_REVOKED) throw new Error("pipe process is revoked");
    const index = this.reserveCell();
    this.ensureCell(index);
    const entry = new Int32ArrayConstructor(this.data.buffer, this.cellBase + index * 16, 2);
    const cell = this.canonical(index);
    atomicsStore(entry, 0, pid);
    atomicsStore(cell, 0, ALLOCATED);
    for (;;) {
      const value = atomicsLoad(this.owners, owner.slot);
      if (registryPid(value) !== pid || value & OWNER_REVOKED) {
        atomicsOr(cell, 0, STOP);
        throw new Error("pipe process is revoked");
      }
      atomicsStore(entry, 1, Number(value & OWNER_HEAD));
      const linked = (value & ~OWNER_HEAD) | BigInt(index + 1);
      if (atomicsCompareExchange(this.owners, owner.slot, value, linked) === value) break;
    }
    // Linking and revoking contend on the SAME incarnation-tagged word. Once linked, the
    // next pointer is immutable. Revocation either freezes this cell or wins before the CAS.
    const value = atomicsLoad(this.owners, owner.slot);
    if (registryPid(value) !== pid || value & OWNER_REVOKED) {
      atomicsOr(cell, 0, STOP);
      throw new Error("pipe process is revoked");
    }
    return index;
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
    // Per-cell views remain valid after growth, including in a handle cloned before growth.
    return new BigInt64ArrayConstructor(this.data.buffer, offset, 1);
  }
  private freezeOwner(pid: number): { slot: number; value: bigint } | undefined {
    const owner = this.process(pid);
    if (!owner) return undefined;
    for (;;) {
      const value = atomicsLoad(this.owners, owner.slot);
      if (registryPid(value) !== pid) return undefined;
      const revoked = value | OWNER_REVOKED;
      if (atomicsCompareExchange(this.owners, owner.slot, value, revoked) !== value) continue;
      let link = Number(revoked & OWNER_HEAD);
      while (link) {
        const index = link - 1;
        atomicsOr(this.canonical(index), 0, STOP);
        link = atomicsLoad(
          new Int32ArrayConstructor(this.data.buffer, this.cellBase + index * 16 + 4, 1),
          0,
        );
      }
      return { slot: owner.slot, value: revoked };
    }
  }
  revoke(pid: number): void {
    this.freezeOwner(pid);
    notify(this.wake);
  }
  /** Host resource-fence completion: freeze even unannounced descendant-created pipes and
   * release this owner's metadata. Physical worker termination is not required. Retained
   * handles can still address only the old permanent cells, never a new occupant's row/list.
   */
  collectProcess(pid: number): void {
    const owner = this.freezeOwner(pid);
    if (owner) atomicsCompareExchange(this.owners, owner.slot, owner.value, 0n);
    notify(this.wake);
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
  end: number;
  index: number;
  remaining: number;
}
class Ring {
  readonly refs: Int32Array;
  readonly pid: Int32Array;
  readonly demand: Int32Array;
  private readonly localPublished: BigInt64Array;
  private readonly localConsumed: BigInt64Array;
  private readonly mapping: Int32Array;
  private publication?: { index: number; cell: BigInt64Array };
  private consumption?: { index: number; cell: BigInt64Array };
  readonly epoch: Int32Array;
  readonly bytes: Uint8Array;
  private readonly metadata: DataView;
  private readonly metadataWords: BigInt64Array;
  private readonly recordCapacity: number;
  constructor(
    buffer: SharedArrayBuffer,
    offset: number,
    readonly capacity: number,
    private readonly registry?: PipePublicationRegistry,
  ) {
    this.pid = new Int32ArrayConstructor(buffer, offset, 1);
    this.refs = new Int32ArrayConstructor(buffer, offset + 4, 1);
    this.localPublished = new BigInt64ArrayConstructor(buffer, offset + 8, 1);
    this.localConsumed = new BigInt64ArrayConstructor(buffer, offset + 16, 1);
    this.mapping = new Int32ArrayConstructor(buffer, offset + 24, 2);
    this.demand = new Int32ArrayConstructor(buffer, offset + 32, 1);
    this.epoch = new Int32ArrayConstructor(buffer, offset + 36, 1);
    this.bytes = new Uint8ArrayConstructor(buffer, offset + RING_HEADER, capacity);
    this.recordCapacity = records(capacity);
    this.metadata = new DataViewConstructor(
      buffer,
      offset + RING_HEADER + capacity,
      this.recordCapacity * 16,
    );
    this.metadataWords = new BigInt64ArrayConstructor(
      buffer,
      offset + RING_HEADER + capacity,
      this.recordCapacity * 2,
    );
  }
  get incarnation(): number {
    return atomicsLoad(this.epoch, 0) >>> INCARNATION_SHIFT;
  }
  enter(incarnation: number): boolean {
    for (;;) {
      const epoch = atomicsLoad(this.epoch, 0);
      if (epoch >>> INCARNATION_SHIFT !== incarnation) return false;
      if ((epoch & SECTION_MASK) === SECTION_MASK)
        throw new RangeError("pipe slot active section limit reached");
      if (atomicsCompareExchange(this.epoch, 0, epoch, epoch + 1) === epoch) return true;
    }
  }
  enterCurrent(): number {
    for (;;) {
      const incarnation = this.incarnation;
      if (this.enter(incarnation)) return incarnation;
    }
  }
  leave(): void {
    atomicsAdd(this.epoch, 0, -1);
  }
  advance(incarnation: number): boolean {
    if (incarnation === LAST_INCARNATION) return false;
    const epoch = incarnation << INCARNATION_SHIFT;
    return atomicsCompareExchange(this.epoch, 0, epoch, epoch + 256) === epoch;
  }
  reopen(pid: number, kind: "published" | "consumed"): void {
    const at = kind === "published" ? 0 : 1;
    const current = kind === "published" ? this.published : this.consumed;
    const local = kind === "published" ? this.localPublished : this.localConsumed;
    const value = atomicsLoad(current, 0) & ~(STOP | ALLOCATED);
    atomicsStore(local, 0, value);
    if (!this.registry) return;
    const index = this.registry.allocate(pid);
    atomicsOr(this.registry.canonical(index), 0, value);
    atomicsStore(this.mapping, at, index + 1);
  }
  get published(): BigInt64Array {
    const index = atomicsLoad(this.mapping, 0);
    if (!index) return this.localPublished;
    if (this.publication?.index !== index)
      this.publication = { index, cell: this.registry!.canonical(index - 1) };
    return this.publication.cell;
  }
  get consumed(): BigInt64Array {
    const index = atomicsLoad(this.mapping, 1);
    if (!index) return this.localConsumed;
    if (this.consumption?.index !== index)
      this.consumption = { index, cell: this.registry!.canonical(index - 1) };
    return this.consumption.cell;
  }
  bind(pid: number, kind: "published" | "consumed"): void {
    if (!this.registry) return;
    const at = kind === "published" ? 0 : 1;
    if (atomicsLoad(this.mapping, at)) return;
    let index: number;
    try {
      index = this.registry.allocate(pid);
    } catch (error) {
      if (kind === "consumed" && this.registry.isRevoked(pid)) {
        this.freezeReader();
        return;
      }
      throw error;
    }
    const local = kind === "published" ? this.localPublished : this.localConsumed;
    atomicsOr(this.registry.canonical(index), 0, atomicsLoad(local, 0));
    atomicsCompareExchange(this.mapping, at, 0, index + 1);
    atomicsOr(this.registry.canonical(index), 0, atomicsLoad(local, 0));
  }
  get owner(): number {
    return atomicsLoad(this.pid, 0);
  }
  get references(): number {
    return atomicsLoad(this.refs, 0);
  }
  get closed(): boolean {
    return (atomicsLoad(this.published, 0) & STOP) !== 0n;
  }
  get available(): number {
    const consumed = atomicsLoad(this.consumed, 0);
    return Math.min(this.capacity, distance(atomicsLoad(this.published, 0), consumed));
  }
  get free(): number {
    return this.capacity - this.available;
  }
  get writable(): boolean {
    const consumed = atomicsLoad(this.consumed, 0),
      published = atomicsLoad(this.published, 0);
    return (
      this.free > 0 &&
      ((recordCounter(published) - recordCounter(consumed)) & Number(RECORD_MASK)) <
        this.recordCapacity
    );
  }
  freezeWriter(): void {
    atomicsOr(this.localPublished, 0, STOP);
    atomicsOr(this.published, 0, STOP);
  }
  freezeReader(): void {
    atomicsOr(this.localConsumed, 0, STOP);
    atomicsOr(this.consumed, 0, STOP);
  }
  request(count: number): boolean {
    return atomicsCompareExchange(this.demand, 0, 0, Math.min(count, this.capacity)) === 0;
  }
  head(): PipeRecord | undefined {
    const consumed = atomicsLoad(this.consumed, 0),
      published = atomicsLoad(this.published, 0);
    if (recordCounter(consumed) === recordCounter(published)) return undefined;
    const index = recordCounter(consumed),
      slot = index % this.recordCapacity;
    const end = dataViewGetUint32(this.metadata, slot * 16 + 8, true);
    return {
      index,
      end,
      remaining: (end - counter(consumed)) >>> 0,
      ticket: atomicsLoad(this.metadataWords, slot * 2),
    };
  }
  write(
    chunks: readonly Uint8Array[],
    valid: () => boolean,
    ticket: bigint,
    incarnation: number,
    atomic = true,
  ): number {
    if (!this.enter(incarnation)) return -PipeErrno.BADF;
    try {
      return this.writeEntered(chunks, valid, ticket, atomic);
    } finally {
      this.leave();
    }
  }
  private writeEntered(
    chunks: readonly Uint8Array[],
    valid: () => boolean,
    ticket: bigint,
    atomic: boolean,
  ): number {
    const publication = this.published;
    const published = atomicsLoad(publication, 0);
    if ((published & STOP) !== 0n || !valid()) return -PipeErrno.BADF;
    const consumed = atomicsLoad(this.consumed, 0);
    const free = this.capacity - distance(published, consumed),
      requested = length(chunks);
    const usedRecords = (recordCounter(published) - recordCounter(consumed)) & Number(RECORD_MASK);
    if (
      usedRecords >= this.recordCapacity ||
      (atomic && requested <= Math.min(4096, this.capacity) && free < requested)
    )
      return -PipeErrno.AGAIN;
    const count = Math.min(requested, free);
    if (!count) return -PipeErrno.AGAIN;
    let copied = 0;
    for (const chunk of chunks) {
      const take = Math.min(typedArrayLength(chunk), count - copied);
      if (!take) continue;
      const start = (counter(published) + copied) % this.capacity,
        first = Math.min(take, this.capacity - start);
      typedArraySet(this.bytes, typedArraySubarray(chunk, 0, first), start);
      if (take > first) typedArraySet(this.bytes, typedArraySubarray(chunk, first, take), 0);
      copied += take;
      if (copied === count) break;
    }
    const end = (counter(published) + count) >>> 0,
      record = recordCounter(published),
      slot = record % this.recordCapacity;
    atomicsStore(this.metadataWords, slot * 2, ticket);
    dataViewSetUint32(this.metadata, slot * 16 + 8, end, true);
    if (!valid()) return -PipeErrno.BADF;
    // Payload AND record metadata become visible in one canonical CAS. Revocation captures
    // precisely this committed prefix; unused tickets never block readers behind a zombie.
    const next = advance(published, end, record + 1);
    return atomicsCompareExchange(publication, 0, published, next) === published
      ? count
      : -PipeErrno.BADF;
  }
  read(chunks: readonly Uint8Array[], supervisor = false): number {
    const consumed = atomicsLoad(this.consumed, 0);
    if (!supervisor && (consumed & STOP) !== 0n) return -PipeErrno.AGAIN;
    const published = atomicsLoad(this.published, 0);
    if (recordCounter(consumed) === recordCounter(published))
      return (published & STOP) !== 0n ? 0 : -PipeErrno.AGAIN;
    const record = recordCounter(consumed),
      slot = record % this.recordCapacity;
    const end = dataViewGetUint32(this.metadata, slot * 16 + 8, true),
      remaining = (end - counter(consumed)) >>> 0;
    const count = Math.min(length(chunks), remaining);
    const copy = new Uint8ArrayConstructor(count),
      start = counter(consumed) % this.capacity,
      first = Math.min(count, this.capacity - start);
    typedArraySet(copy, typedArraySubarray(this.bytes, start, start + first));
    if (count > first) typedArraySet(copy, typedArraySubarray(this.bytes, 0, count - first), first);
    const next = advance(
      consumed,
      counter(consumed) + count,
      record + (count === remaining ? 1 : 0),
    );
    if (atomicsCompareExchange(this.consumed, 0, consumed, next) !== consumed)
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
  constructor(
    handle: Pick<
      PipeEndpointHandle,
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
        (pid === RECLAIMING || !this.registry?.isRevoked(Math.abs(pid))) &&
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
    // A child can reserve or reopen an earlier, already-scanned slot
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
  ): number {
    const result = source.ring.read(chunks, supervisor);
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
    let selected = -1;
    let incarnation = 0;
    for (let probe = 0; probe < rings.length; probe++) {
      const slot = (pid + probe) % rings.length;
      const ring = rings[slot]!;
      const owner = ring.owner;
      if (owner === -pid) throw new Error("pipe process reservation is in progress");
      const own = owner === pid ? this.claimOwn(ring, pid) : undefined;
      if (own !== undefined) {
        selected = slot;
        incarnation = own;
        break;
      }
      if (!this.claimFresh(ring, pid, mode)) continue;
      selected = slot;
      break;
    }
    if (selected < 0 && mode === "write") {
      for (let probe = 0; probe < rings.length; probe++) {
        const slot = (pid + probe) % rings.length;
        const reclaimed = this.reclaim(rings[slot]!, pid, mode);
        if (reclaimed === undefined) continue;
        selected = slot;
        incarnation = reclaimed;
        break;
      }
    }
    if (selected < 0)
      throw new ProcessError(
        PipeErrno.NFILE,
        `pipe ${mode} process limit reached: ${rings.length} slots are live, unread, busy or incarnation-exhausted`,
      );
    const endpoint = new PipeEndpoint(this, pid, mode, selected, incarnation, lifetime, fdflags);
    try {
      // Both sides publish identity before checking the other side. Concurrent first reader
      // and writer reservations cannot both miss registering the direct consumer's lease.
      // No producer can publish bytes until its reservation has returned the endpoint.
      if (mode === "write" && !this.relay) {
        const reader = ringFind(this.readers, (candidate) => this.readerAlive(candidate));
        if (reader) rings[selected]!.bind(reader.owner, "consumed");
      }
      if (mode === "read") {
        if (ringSome(this.readers, (ring) => ring.owner > 0 && ring.owner !== pid))
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
  private claimOwn(ring: Ring, pid: number): number | undefined {
    const incarnation = ring.enterCurrent();
    try {
      if (ring.owner !== pid) return undefined;
      this.addReference(ring);
      return incarnation;
    } finally {
      ring.leave();
    }
  }
  private addReference(ring: Ring): void {
    for (;;) {
      const refs = ring.references;
      if (refs <= 0) throw new Error("pipe endpoint is closed");
      if (atomicsCompareExchange(ring.refs, 0, refs, refs + 1) === refs) return;
    }
  }
  private claimFresh(ring: Ring, pid: number, mode: PipeMode): boolean {
    if (atomicsCompareExchange(ring.pid, 0, 0, -pid) !== 0) return false;
    try {
      this.occupy(ring, pid, mode);
      return true;
    } catch (error) {
      this.abandon(ring, pid, mode);
      throw error;
    }
  }
  private reclaim(ring: Ring, pid: number, mode: PipeMode): number | undefined {
    const owner = ring.owner;
    const epoch = atomicsLoad(ring.epoch, 0);
    const incarnation = epoch >>> INCARNATION_SHIFT;
    if (owner <= 0 || epoch & SECTION_MASK || incarnation === LAST_INCARNATION) return undefined;
    if (!ring.closed || (ring.references > 0 && !this.registry?.isRevoked(owner))) return undefined;
    if (
      recordCounter(atomicsLoad(ring.consumed, 0)) !== recordCounter(atomicsLoad(ring.published, 0))
    )
      return undefined;
    if (atomicsCompareExchange(ring.pid, 0, owner, RECLAIMING) !== owner) return undefined;
    if (!ring.advance(incarnation)) {
      atomicsStore(ring.pid, 0, owner);
      return undefined;
    }
    try {
      atomicsStore(ring.refs, 0, 0);
      atomicsStore(ring.demand, 0, 0);
      ring.reopen(pid, "published");
      atomicsStore(ring.pid, 0, -pid);
      this.occupy(ring, pid, mode);
      return incarnation + 1;
    } catch (error) {
      this.abandon(ring, pid, mode);
      throw error;
    }
  }
  private occupy(ring: Ring, pid: number, mode: PipeMode): void {
    this.admit();
    ring.bind(pid, "published");
    if (mode === "read") ring.bind(pid, "consumed");
    else if (!this.relay) {
      const reader = ringFind(this.readers, (candidate) => this.readerAlive(candidate));
      if (reader) ring.bind(reader.owner, "consumed");
    }
    if (this.registry?.isRevoked(pid)) throw new Error("pipe process is revoked");
    if (atomicsCompareExchange(ring.refs, 0, 0, 1) !== 0)
      throw new Error("pipe process is revoked");
    atomicsStore(ring.pid, 0, pid);
  }
  private abandon(ring: Ring, pid: number, mode: PipeMode): void {
    ring.freezeWriter();
    if (mode === "read") ring.freezeReader();
    atomicsStore(ring.refs, 0, -1);
    atomicsStore(ring.pid, 0, pid);
    this.signal();
  }
  private revokeRing(ring: Ring, pid: number, readers: boolean): void {
    ring.enterCurrent();
    try {
      if (Math.abs(ring.owner) !== pid || ring.references < 0) return;
      ring.freezeWriter();
      if (readers) {
        ring.freezeReader();
        if (!this.relay) ringForEach(this.writers, (source) => source.freezeReader());
      }
      atomicsExchange(ring.refs, 0, -1);
    } finally {
      ring.leave();
    }
  }
  revoke(pid: number, mode?: PipeMode): void {
    const revokeRings = (rings: readonly Ring[], readers: boolean): void => {
      ringForEach(rings, (ring) => this.revokeRing(ring, pid, readers));
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
    readonly slot: number,
    readonly incarnation: number,
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
      this.ring.incarnation === this.incarnation &&
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
    return {
      id: this.state.id,
      buffer: this.state.buffer,
      capacity: this.state.capacity,
      maxWriters: this.state.maxWriters,
      maxReaders: this.state.maxReaders,
      wake: this.notification,
      pid: this.pid,
      mode: this.mode,
      slot: this.slot,
      incarnation: this.incarnation,
      lifetime: typedArrayBuffer(this.lifetime) as SharedArrayBuffer,
      fdflags: typedArrayBuffer(this.flags) as SharedArrayBuffer,
      registry: this.state.registry?.handle(),
    };
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
    if (this.ring.enter(this.incarnation)) {
      try {
        this.releaseReference();
      } finally {
        this.ring.leave();
      }
    }
    this.state.signal();
  }
  private releaseReference(): void {
    for (;;) {
      const refs = this.ring.references;
      if (refs <= 0) return;
      if (atomicsCompareExchange(this.ring.refs, 0, refs, refs - 1) !== refs) continue;
      if (refs === 1) this.freeze();
      return;
    }
  }
  private freeze(): void {
    this.ring.freezeWriter();
    if (this.mode !== "read") return;
    this.ring.freezeReader();
    if (!this.state.relay) ringForEach(this.state.writers, (source) => source.freezeReader());
  }
  tryWrite(chunks: readonly Uint8Array[]): number {
    if (this.mode !== "write" || !this.live) return -PipeErrno.BADF;
    if (!length(chunks)) return 0;
    if (!this.state.hasReaders()) return -PipeErrno.PIPE;
    const result = this.ring.write(
      chunks,
      () => this.live,
      this.state.nextTicket(),
      this.incarnation,
    );
    if (result > 0) this.state.signal();
    return result;
  }
  tryRead(chunks: readonly Uint8Array[]): number {
    if (this.mode !== "read" || !this.live) return -PipeErrno.BADF;
    if (!length(chunks)) return 0;
    if (this.state.relay) {
      const result = this.ring.read(chunks);
      if (result > 0) this.state.signal();
      else if (result === -PipeErrno.AGAIN && this.ring.request(length(chunks)))
        this.state.signal();
      return result;
    }
    const source = this.state.source(false);
    if (source) {
      const result = this.state.consume(source, chunks, false);
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
          atomicsLoad(this.ring.demand, 0) > 0 &&
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
 * Defaults reserve about 2.5 MiB per pipe, including bounded write-record metadata.
 * Atomic writes are <=4096 bytes (or capacity in tiny configured rings); no slot is reused.
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
  private delivery?: Ring;
  private readonly onClosed?: () => void;
  private reportedClosed = false;
  constructor(options: PipeOptions = {}, attached?: PipeEndpointHandle) {
    this.onClosed = options.onClosed;
    if (attached) this.state = new PipeState(attached);
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
    return this.state.retain(endpoint.pid, endpoint.mode, endpoint.handle().fdflags);
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
        const ring = this.delivery;
        if (!ring.available) this.delivery = undefined;
        else {
          const alive = this.state.readerAlive(ring);
          const otherDemand = ringSome(
            this.state.readers,
            (candidate) =>
              candidate !== ring &&
              this.state.readerAlive(candidate) &&
              atomicsLoad(candidate.demand, 0) > 0,
          );
          if (alive && !otherDemand) break;
          if (!alive) {
            ring.freezeWriter();
            ring.freezeReader();
          }
          const head = ring.head();
          if (!head) {
            this.delivery = undefined;
            continue;
          }
          const copy = new Uint8ArrayConstructor(Math.min(head.remaining, 65536));
          const count = ring.read([copy], true);
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
      let budget = 0;
      for (let visited = 0; visited < this.state.readers.length; visited++) {
        const index = (this.readerCursor + visited) % this.state.readers.length,
          ring = this.state.readers[index]!;
        const demand = atomicsLoad(ring.demand, 0);
        if (
          !this.state.readerAlive(ring) ||
          ring.closed ||
          ring.available ||
          demand <= 0 ||
          demand & INFLIGHT
        )
          continue;
        if (atomicsCompareExchange(ring.demand, 0, demand, demand | INFLIGHT) !== demand) continue;
        destination = ring;
        budget = demand;
        this.readerCursor = (index + 1) % this.state.readers.length;
        break;
      }
      if (!destination) break;
      if (!this.pending) {
        const source = this.state.source(true);
        if (!source) {
          atomicsStore(destination.demand, 0, budget);
          break;
        }
        const chunk = new Uint8ArrayConstructor(Math.min(source.record.remaining, budget, 65536));
        const count = this.state.consume(source, [chunk], true);
        if (count <= 0) {
          atomicsStore(destination.demand, 0, budget);
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
        () => this.state.readerAlive(destination!),
        this.pendingTicket,
        destination.incarnation,
        false,
      );
      // INFLIGHT prevents a guest racing publication from accidentally posting ghost demand.
      atomicsStore(destination.demand, 0, 0);
      if (delivered > 0) {
        this.pendingAt += delivered;
        atomicsStore(this.state.control, 4, typedArrayLength(this.pending) - this.pendingAt);
        if (this.pendingAt === typedArrayLength(this.pending)) this.pending = undefined;
        this.delivery = destination;
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
    }
    this.state.signal();
    this.reportClosed();
  }
}

export function attachPipeEndpoint(handle: PipeEndpointHandle): PipeEndpoint {
  const state = new PipeState(handle);
  const limit = handle.mode === "write" ? state.maxWriters : state.maxReaders;
  if (!Number.isInteger(handle.slot) || handle.slot < 0 || handle.slot >= limit)
    throw new RangeError("invalid pipe slot");
  if (
    !Number.isInteger(handle.incarnation) ||
    handle.incarnation < 0 ||
    handle.incarnation > LAST_INCARNATION
  )
    throw new RangeError("invalid pipe incarnation");
  return new PipeEndpoint(
    state,
    handle.pid,
    handle.mode,
    handle.slot,
    handle.incarnation,
    handle.lifetime,
    handle.fdflags,
  );
}
export function attachPipeController(
  handle: PipeEndpointHandle,
  options: Pick<PipeOptions, "relay" | "onClosed"> = {},
): PipeController {
  return new PipeController(options, handle);
}
