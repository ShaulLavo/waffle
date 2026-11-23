import {
  cryptoRandomUUID,
  scheduleTimeout,
  arrayFrom,
  isSharedArrayBuffer,
  BigInt64ArrayConstructor,
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  Uint8ArrayConstructor,
  Uint32ArrayConstructor,
  atomicsAdd,
  atomicsCompareExchange,
  atomicsExchange,
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
  typedArrayCopy,
  pipePause,
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
  /** Realm-local accounting hook. Never placed in cloneable endpoint handles. */
  allocateShared?: (length: number) => SharedArrayBuffer;
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
// A cursor's low 32 bits count bytes. Its high word holds STOP (bit 0), ALLOCATED (bit 1)
// and the 29-bit write-record counter (bits 2 to 30).
const STOP = 1n << 32n;
const ALLOCATED = 1n << 33n;
const RECORD_MASK = (1 << 29) - 1;
const INFLIGHT = 1 << 30;
const RELAY_SELECTION = 1n << 62n;
const RELAY_HIGH = 1 << 30;
const HEADER = 40;
const RING_HEADER = 40;
const SECTION_MASK = 0xff;
const INCARNATION_SHIFT = 8;
const LAST_INCARNATION = 0x7fffff;
const RECLAIMING = -0x80000000;
// Ring storage is paged, as in Linux's pipe_buffer ring: a ring keeps its full virtual
// capacity, but holds physical pages only for unread data. See docs/architecture.md.
const PAGE_LIMIT = 4096;
const RECORD_BYTES = 16;
const RECORD_PAGE_LIMIT = 64;
/** Private pages per writer slot and kind: a stuck or greedy writer never starves another. */
const RESERVED_PAGES = 2;
/** Shared pages writers leave free, so relay deliveries always make progress. */
const DELIVERY_RESERVE = 2;
const PAGE_IDS = 0xfffe;
function records(capacity: number): number {
  return Math.min(capacity, 1024);
}
function log2(power: number): number {
  return 31 - Math.clz32(power);
}
function align8(value: number): number {
  return (value + 7) & ~7;
}

// Cursor words are BigInt64 atomics. Splitting them through one private scratch word keeps the
// hot paths free of intermediate BigInt allocations.
const wide = new BigInt64ArrayConstructor(1);
const halves = new Uint32ArrayConstructor(typedArrayBuffer(wide));
const probe = new Uint32ArrayConstructor(1);
probe[0] = 1;
const LOW = new Uint8ArrayConstructor(typedArrayBuffer(probe))[0] === 1 ? 0 : 1;
const HIGH = 1 - LOW;
function low(value: bigint): number {
  wide[0] = value;
  return halves[LOW]!;
}
function high(value: bigint): number {
  wide[0] = value;
  return halves[HIGH]!;
}
function pack(lowWord: number, highWord: number): bigint {
  halves[LOW] = lowWord;
  halves[HIGH] = highWord;
  return wide[0]!;
}
function stopped(value: bigint): boolean {
  return (high(value) & 1) !== 0;
}
function recordCounter(value: bigint): number {
  return (high(value) >>> 2) & RECORD_MASK;
}
/** Sign of BigInt.asIntN(64, a - b). */
function ticketOrder(a: bigint, b: bigint): number {
  wide[0] = a;
  const aLow = halves[LOW]!,
    aHigh = halves[HIGH]!;
  wide[0] = b;
  const bLow = halves[LOW]!,
    bHigh = halves[HIGH]!;
  const upper = (aHigh - bHigh - (aLow < bLow ? 1 : 0)) | 0;
  if (upper !== 0) return upper < 0 ? -1 : 1;
  return aLow === bLow ? 0 : 1;
}
let scratch = new Uint8ArrayConstructor(256);
function scratchFor(count: number): Uint8Array {
  if (typedArrayLength(scratch) < count)
    scratch = new Uint8ArrayConstructor(Math.max(count, typedArrayLength(scratch) * 2));
  return scratch;
}

export interface PoolLayout {
  /** Int32 offset of the used-page count, followed by the allocation bitmap. */
  control: number;
  /** Pages any ring may borrow. Ids at and above this are writer-reserved pages. */
  shared: number;
  ids: number;
  base: number;
}
export interface PipeLayout {
  pageBytes: number;
  pages: number;
  recordPage: number;
  recordPages: number;
  ringBytes: number;
  bytePool: PoolLayout;
  recordPool: PoolLayout;
  bytes: number;
}
/** Deterministic layout from the handle's capacity and slot counts. */
function pipeLayout(capacity: number, maxWriters: number, maxReaders: number): PipeLayout {
  const pageBytes = Math.min(PAGE_LIMIT, capacity),
    pages = capacity / pageBytes;
  const recordPage = Math.min(RECORD_PAGE_LIMIT, records(capacity)),
    recordPages = records(capacity) / recordPage;
  // Header, then 64-bit page entries (8-aligned, since the header is), then reserved-page hints.
  const ringBytes = align8(RING_HEADER + 8 * (pages + recordPages) + 4 * 2 * RESERVED_PAGES);
  let at = HEADER + (maxWriters + maxReaders) * ringBytes;
  const pool = (shared: number): PoolLayout => {
    const control = at;
    at += 4 * (1 + Math.ceil(shared / 32));
    return { control, shared, ids: shared + RESERVED_PAGES * maxWriters, base: 0 };
  };
  const bytePool = pool(pages + DELIVERY_RESERVE),
    recordPool = pool(recordPages + DELIVERY_RESERVE);
  if (bytePool.ids > PAGE_IDS || recordPool.ids > PAGE_IDS)
    throw new RangeError("pipe page directory limit exceeded");
  recordPool.base = align8(at);
  bytePool.base = recordPool.base + recordPool.ids * recordPage * RECORD_BYTES;
  const bytes = bytePool.base + bytePool.ids * pageBytes;
  return { pageBytes, pages, recordPage, recordPages, ringBytes, bytePool, recordPool, bytes };
}
/** Bytes one pipe reserves for these limits. */
export function pipeReservationBytes(
  options: Pick<PipeOptions, "capacity" | "maxWriters" | "maxReaders"> = {},
): number {
  return pipeLayout(options.capacity ?? 65536, options.maxWriters ?? 16, options.maxReaders ?? 16)
    .bytes;
}
/** Test-only: the byte offset of an endpoint's ring header in its pipe buffer. */
export function pipeRingOffset(
  handle: Pick<PipeEndpointHandle, "capacity" | "maxWriters" | "maxReaders" | "mode" | "slot">,
): number {
  const layout = pipeLayout(handle.capacity, handle.maxWriters, handle.maxReaders);
  return (
    HEADER + (handle.slot + (handle.mode === "read" ? handle.maxWriters : 0)) * layout.ringBytes
  );
}

/** Test-only: the buffer layout, for audits that decode page tables directly. */
export function pipeLayoutOf(
  handle: Pick<PipeEndpointHandle, "capacity" | "maxWriters" | "maxReaders">,
): PipeLayout {
  return pipeLayout(handle.capacity, handle.maxWriters, handle.maxReaders);
}
/** Test-only: shared (not writer-reserved) pages in use, for payload bytes and for records. */
export function pipeSharedPagesInUse(
  handle: Pick<PipeEndpointHandle, "buffer" | "capacity" | "maxWriters" | "maxReaders">,
): { bytes: number; records: number } {
  const layout = pipeLayout(handle.capacity, handle.maxWriters, handle.maxReaders);
  const used = (pool: PoolLayout) =>
    atomicsLoad(new Int32ArrayConstructor(handle.buffer, pool.control, 1), 0);
  return { bytes: used(layout.bytePool), records: used(layout.recordPool) };
}

/** Page allocator shared by every ring of one pipe. Bit set means the page is in use. */
class PagePool {
  readonly shared: number;
  private readonly used: Int32Array;
  private readonly bits: Int32Array;
  private readonly lastMask: number;
  constructor(buffer: SharedArrayBuffer, layout: PoolLayout) {
    this.shared = layout.shared;
    this.used = new Int32ArrayConstructor(buffer, layout.control, 1);
    this.bits = new Int32ArrayConstructor(
      buffer,
      layout.control + 4,
      Math.ceil(layout.shared / 32),
    );
    const tail = layout.shared % 32;
    this.lastMask = tail ? (1 << tail) - 1 : -1;
  }
  get available(): number {
    return this.shared - atomicsLoad(this.used, 0);
  }
  /** Set by the pipe: return pages earlier laps left in any ring. True when it freed one. */
  scavenge?: () => boolean;
  /** Claim one shared page, leaving at least `floor` free. Returns its id or -1. */
  take(floor: number): number {
    if (!this.admit(floor) && !(this.scavenge?.() && this.admit(floor))) return -1;
    pipePause("pool.admitted");
    // The count admitted us, so some bit is clear or about to be cleared by a returning page.
    for (;;)
      for (let index = 0; index < typedArrayLength(this.bits); index++) {
        const id = this.claim(index);
        if (id >= 0) return id;
      }
  }
  private admit(floor: number): boolean {
    for (;;) {
      const used = atomicsLoad(this.used, 0);
      if (this.shared - used <= floor) return false;
      if (atomicsCompareExchange(this.used, 0, used, used + 1) === used) return true;
    }
  }
  private claim(index: number): number {
    const mask = index === typedArrayLength(this.bits) - 1 ? this.lastMask : -1;
    let word = atomicsLoad(this.bits, index);
    while ((~word & mask) !== 0) {
      const bit = ~word & mask & -(~word & mask);
      const previous = atomicsCompareExchange(this.bits, index, word, word | bit);
      if (previous === word) return index * 32 + 31 - Math.clz32(bit);
      word = previous;
    }
    return -1;
  }
  give(id: number): void {
    const index = id >>> 5,
      bit = 1 << (id & 31);
    let word = atomicsLoad(this.bits, index);
    for (;;) {
      const previous = atomicsCompareExchange(this.bits, index, word, word & ~bit);
      if (previous === word) break;
      word = previous;
    }
    atomicsAdd(this.used, 0, -1);
    pipePause("pool.given");
  }
}

/** PageMap.judge verdicts. */
const KEEP = 0,
  FREE = 1,
  RETAG = 2;
/** One ring's virtual pages of one kind: payload bytes, or 16-byte write records. Each entry is
 * one 64-bit word: physical id + 1 in the low half (0 = unmapped) and the lap in the high half,
 * as wide as the cursor allows, so a reused entry never repeats a value inside the 4 GiB wrap
 * the cursors already assume. Only the ring's single producer maps an entry or retags it for
 * its next lap, before copying into it. A consumer clears an entry, by CAS on the exact entry
 * it read, only after its committed cursor passed that page's end for that lap. So a page that
 * still holds unread data, or that a paused producer may still write, is never freed; a retag
 * and a free of the same entry cannot both succeed.
 */
class PageMap {
  private readonly pageMask: number;
  private readonly lapMask: number;
  private readonly wrapMask: number;
  constructor(
    private readonly entries: BigInt64Array,
    /** The same entries as 32-bit halves, for the hot paths' allocation-free reads. */
    private readonly words: Int32Array,
    private readonly hints: Int32Array,
    private readonly pool: PagePool,
    /** First writer-reserved physical id, or -1 for a delivery ring. */
    private readonly reserved: number,
    private readonly floor: number,
    private readonly unitShift: number,
    private readonly spanShift: number,
    counterBits: number,
  ) {
    this.pageMask = typedArrayLength(entries) - 1;
    this.lapMask = 2 ** (counterBits - spanShift) - 1;
    this.wrapMask = counterBits === 32 ? -1 : (1 << counterBits) - 1;
  }
  private id(page: number): number {
    return atomicsLoad(this.words, page * 2 + LOW);
  }
  private page(position: number): number {
    return (position >>> this.unitShift) & this.pageMask;
  }
  private lap(position: number): number {
    return (position >>> this.spanShift) & this.lapMask;
  }
  private wrap(position: number): number {
    return this.wrapMask === -1 ? position >>> 0 : position & this.wrapMask;
  }
  /** The physical page holding a committed unit, or -1 when this view is stale. The producer
   * may already have retagged that page for the next lap; its earlier-lap bytes stay put. */
  find(position: number): number {
    // Two 32-bit loads can tear across a remap. The producer only reads its own stable
    // entries, and a reader that copies from a torn view loses its consuming CAS.
    const page = this.page(position),
      id = this.id(page);
    if (!id) return -1;
    const lap = this.lap(position),
      tag = atomicsLoad(this.words, page * 2 + HIGH);
    if (tag !== lap && tag !== ((lap + 1) & this.lapMask)) return -1;
    return id - 1;
  }
  /** Producer: map pages for [position, position + count). Returns the units now mapped. */
  ensure(position: number, count: number): number {
    const unit = 1 << this.unitShift;
    let covered = 0;
    while (covered < count) {
      const at = this.wrap(position + covered);
      const room = unit - (at & (unit - 1));
      if (!this.map(at, covered + room >= count)) break;
      covered += room;
    }
    return Math.min(covered, count);
  }
  private map(position: number, last: boolean): boolean {
    const page = this.page(position),
      lap = this.lap(position);
    for (;;) {
      const entry = atomicsLoad(this.entries, page);
      const id = low(entry),
        tag = halves[HIGH]!;
      pipePause("map.loaded");
      if (id && tag === lap) return true;
      if (!id) return this.allocate(page, lap, last);
      // The previous lap still owns it: keep the page unless its consumer frees it first.
      if (atomicsCompareExchange(this.entries, page, entry, pack(id, lap)) === entry) return true;
    }
  }
  /** The page a write ends in prefers a reserved page, so an idle writer holds no shared page. */
  private allocate(page: number, lap: number, last: boolean): boolean {
    let id = last ? this.takeReserved(page) : -1;
    if (id < 0) id = this.pool.take(this.floor);
    // A failed take may have scavenged this ring's own reserved pages; look again.
    if (id < 0) id = this.takeReserved(page);
    if (id < 0) return false;
    atomicsStore(this.entries, page, pack(id + 1, lap));
    return true;
  }
  private takeReserved(page: number): number {
    if (this.reserved < 0) return -1;
    for (let slot = 0; slot < RESERVED_PAGES; slot++) {
      if (this.reservedBusy(slot)) continue;
      atomicsStore(this.hints, slot, page + 1);
      return this.reserved + slot;
    }
    return -1;
  }
  private reservedBusy(slot: number): boolean {
    const hint = atomicsLoad(this.hints, slot);
    return hint !== 0 && this.id(hint - 1) === this.reserved + slot + 1;
  }
  /** Restore the invariant that every page outside the unread window [consumed, published) is
   * free, whatever path left one mapped: a failed write, a reader stopped between its CAS and
   * release(), or a slot reused before anyone looked. Returns whether it freed a page.
   *
   * Each virtual page is judged by its next occurrence at or after the page holding the
   * consumer's cursor. An entry tagged for an earlier lap holds only consumed data and goes in
   * every mode: a producer retagging it races this CAS on the same entry. Entries for the
   * current lap (or the next, when the producer has wrapped into the page being read) stay
   * unless `fenced` says no producer can be writing; then only pages touching unread data stay.
   *
   * Unfenced, each entry is judged against a cursor read after the entry, so the cursor is never
   * older than the mapping it judges. If the entry changes before the CAS, the CAS fails; if it
   * doesn't, the consumer has only moved further past it. Fenced, nothing new is mapped, and a
   * cursor read once up front can only be behind, which keeps more. */
  sweep(consumedAt: () => number, published: number, fenced: boolean): boolean {
    let consumed = consumedAt();
    let freed = false;
    for (let page = 0; page < typedArrayLength(this.entries); page++) {
      const entry = atomicsLoad(this.entries, page);
      const id = low(entry),
        tag = halves[HIGH]!;
      if (!id) continue;
      if (!fenced) consumed = consumedAt();
      pipePause("sweep.entry");
      const verdict = this.judge(page, tag, consumed, published, fenced);
      if (verdict === KEEP) continue;
      if (verdict === RETAG) {
        if (this.tagBack(page, entry, id, tag, consumedAt, published)) freed = true;
        continue;
      }
      if (this.clear(page, entry)) freed = true;
    }
    return freed;
  }
  /** Tag an aborted write's page back to its own lap. A reader that passed the page before
   * this CAS saw the later tag and skipped it in release(), so judge it again against a cursor
   * read after the CAS and free it if the reader is already past. Returns whether it freed. */
  private tagBack(
    page: number,
    entry: bigint,
    id: number,
    tag: number,
    consumedAt: () => number,
    published: number,
  ): boolean {
    const lap = (tag - 1) & this.lapMask;
    const retagged = pack(id, lap);
    pipePause("sweep.retag");
    if (atomicsCompareExchange(this.entries, page, entry, retagged) !== entry) return false;
    if (this.judge(page, lap, consumedAt(), published, true) !== FREE) return false;
    return this.clear(page, retagged);
  }
  private judge(
    page: number,
    tag: number,
    consumed: number,
    published: number,
    fenced: boolean,
  ): number {
    const base = this.wrap(consumed - (consumed & ((1 << this.unitShift) - 1)));
    const offset = ((page - this.page(base)) & this.pageMask) << this.unitShift;
    const age = (tag - this.lap(this.wrap(base + offset))) & this.lapMask;
    // Age 0 is the current lap, small ages are later laps, and the upper half is behind.
    if (age > this.lapMask >>> 1) return FREE;
    if (!fenced) return KEEP;
    const window = consumed === published ? 0 : this.wrap(published - base);
    if (offset >= window) return FREE;
    // A write that never published retagged this page for its next lap. Tag it back, so the
    // reader's release() frees it once the earlier lap's bytes are read.
    if (age === 1 && offset + 2 ** this.spanShift >= window) return RETAG;
    return KEEP;
  }
  /** Consumer: after committing [from, from + count), free each page whose end it passed. */
  release(from: number, count: number): void {
    const unit = 1 << this.unitShift;
    const end = from + count;
    for (let start = from - (from & (unit - 1)); start + unit <= end; start += unit) {
      const position = this.wrap(start);
      const page = this.page(position),
        entry = atomicsLoad(this.entries, page);
      const id = low(entry),
        tag = halves[HIGH]!;
      pipePause("release.page");
      if (id && tag === this.lap(position)) this.clear(page, entry);
    }
  }
  /** The ring's producer, on an empty ring: free the partly used page at its position.
   * Returns whether it freed one. */
  releaseIdle(position: number, sharedOnly: boolean): boolean {
    if (!(position & ((1 << this.unitShift) - 1))) return false;
    const page = this.page(position),
      entry = atomicsLoad(this.entries, page);
    const id = low(entry),
      tag = halves[HIGH]!;
    if (!id || tag !== this.lap(position)) return false;
    if (sharedOnly && id - 1 >= this.pool.shared) return false;
    return this.clear(page, entry);
  }
  /** Whether the producer could place one more unit at this position now. An exhausted pool
   * first takes back pages earlier laps left behind, as a write would. */
  canMap(position: number): boolean {
    if (this.id(this.page(position))) return true;
    if (this.pool.available > this.floor) return true;
    if (this.reserved >= 0 && (!this.reservedBusy(0) || !this.reservedBusy(1))) return true;
    if (!(this.pool.scavenge?.() ?? false)) return false;
    if (this.pool.available > this.floor) return true;
    return this.reserved >= 0 && (!this.reservedBusy(0) || !this.reservedBusy(1));
  }
  private clear(page: number, entry: bigint): boolean {
    if (atomicsCompareExchange(this.entries, page, entry, 0n) !== entry) return false;
    const id = low(entry) - 1;
    if (id < this.pool.shared) this.pool.give(id);
    return true;
  }
}

interface PipeSpace {
  buffer: SharedArrayBuffer;
  capacity: number;
  layout: PipeLayout;
  bytePool: PagePool;
  recordPool: PagePool;
  payload: Uint8Array;
  tickets: BigInt64Array;
  ends: Uint32Array;
}
function pipeSpace(
  buffer: SharedArrayBuffer,
  capacity: number,
  maxWriters: number,
  maxReaders: number,
): PipeSpace {
  const layout = pipeLayout(capacity, maxWriters, maxReaders);
  const { bytePool, recordPool, pageBytes, recordPage } = layout;
  const recordWords = recordPool.ids * recordPage * (RECORD_BYTES / 4);
  return {
    buffer,
    capacity,
    layout,
    bytePool: new PagePool(buffer, bytePool),
    recordPool: new PagePool(buffer, recordPool),
    payload: new Uint8ArrayConstructor(buffer, bytePool.base, bytePool.ids * pageBytes),
    tickets: new BigInt64ArrayConstructor(buffer, recordPool.base, recordWords / 2),
    ends: new Uint32ArrayConstructor(buffer, recordPool.base, recordWords),
  };
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
  let total = 0;
  for (let index = 0; index < chunks.length; index++) total += typedArrayLength(chunks[index]!);
  return total;
}
function distance(written: bigint, read: bigint): number {
  return (low(written) - low(read)) >>> 0;
}
function validLimit(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65536;
}

function allocatePipeBuffer(length: number): SharedArrayBuffer {
  return new SharedArrayBufferConstructor(length);
}

const OWNER_REVOKED = 1n << 31n;
function registryPid(value: bigint): number {
  return Number(value >> 32n);
}
function registryOwner(pid: number): bigint {
  return BigInt(pid) << 32n;
}
// A cell's epoch word holds its reuse tag (bits 16 to 30) and its hold count (bits 0 to 15).
// A cell reference is (tag << 16) | index, so a reference names one incarnation of a cell.
const CELL_INDEX = 0xffff;
const CELL_HOLDS = 0xffff;
const CELL_TAG_SHIFT = 16;
const LAST_CELL_TAG = 0x7ffe;
const MAX_CELLS = 1 << 16;
const CELL_BYTES = 16;
/** Ring mapping word after its pipe retired: the ring's local cursors hold the frozen copy. */
const RETIRED = -1;

/** Host-only service capability: never expose this control buffer as guest WASM memory.
 * Authorization (parent chain/job ownership) belongs to the process service, BEFORE revoke.
 * The service enrolls each newly issued, never-reused PID before exporting any endpoints.
 * Collection freezes its cursors and releases its bounded owner row. PID and revoked flag
 * share one CAS word: a paused allocator or killer cannot change a reused row.
 * Only enrollment creates owners; delayed allocate/revoke/collect calls never recreate one.
 *
 * Cells are reference counted and reused. Each 16-byte cell holds an epoch word (reuse tag
 * and hold count), its owner PID and the 64-bit cursor. A ring mapping the cell is one hold;
 * every operation that mutates the cursor (CAS, freeze) holds it too, and every load outside
 * a hold is validated against the tag afterwards. The cell returns to a tagged free stack
 * only when its last hold drops, and its tag advances first, so a retained raw view or a
 * stale reference can never act on another pipe's cursor: either it still holds the old
 * incarnation (which therefore is not reused), or its enter and tag checks fail. A Worker
 * that dies holding a cell quarantines that one cell. A tag that reaches LAST_CELL_TAG
 * retires its cell. Revocation scans the allocated cells for the owner PID.
 * Bounds: 1024 simultaneous enrolled processes and 65536 simultaneous cells by default, and
 * at most 65536 cells (the declared maximum is ~1 MiB). Each cell can be reused 32767 times,
 * so a root's lifetime cell capacity is about 2^31. Exhaustion is ENFILE.
 * No guest holds a lock. This requires modern growable SharedArrayBuffer support.
 */
export class PipePublicationRegistry {
  readonly wake: Int32Array;
  private readonly owners: BigInt64Array;
  private readonly allocated: Int32Array;
  /** Tagged free-stack head: low word is index + 1 (0 when empty), high word an ABA count. */
  private readonly free: BigInt64Array;
  /** Length-tracking view of the cells: epoch at index * 4, owner PID at index * 4 + 1. */
  private readonly cells: Int32Array;
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
      ? (sharedArrayBufferMaxByteLength(attached.buffer) - this.cellBase) / CELL_BYTES
      : (options.maxCells ?? MAX_CELLS);
    if (!Number.isInteger(this.maxCells) || this.maxCells <= 0 || this.maxCells > MAX_CELLS)
      throw new RangeError("invalid pipe registry cell limit");
    const initialCells = Math.min(processCapacity * cellsPerProcess, this.maxCells);
    // ES2022's declarations predate growable SABs; the host must implement the modern API.
    const SharedBuffer = SharedArrayBufferConstructor as unknown as {
      new (length: number, options: { __proto__: null; maxByteLength: number }): SharedArrayBuffer;
    };
    const buffer =
      attached?.buffer ??
      (options.allocate
        ? options.allocate(
            this.cellBase + initialCells * CELL_BYTES,
            this.cellBase + this.maxCells * CELL_BYTES,
          )
        : new SharedBuffer(this.cellBase + initialCells * CELL_BYTES, {
            __proto__: null,
            maxByteLength: this.cellBase + this.maxCells * CELL_BYTES,
          }));
    this.data = { buffer, processCapacity, cellsPerProcess, wake: this.wake };
    this.allocated = new Int32ArrayConstructor(buffer, 0, 1);
    this.free = new BigInt64ArrayConstructor(buffer, 8, 1);
    this.owners = new BigInt64ArrayConstructor(buffer, 16, processCapacity);
    this.cells = new Int32ArrayConstructor(buffer, this.cellBase);
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
  /** Pop a released cell, or take a never-used one. Its hold count is zero. */
  private reserveCell(): number {
    for (;;) {
      const head = atomicsLoad(this.free, 0);
      const top = low(head);
      if (!top) break;
      // The link lives in the free cell's owner word. A cell popped and reused meanwhile
      // gives a garbage link, but then the head's ABA count has moved and the CAS fails.
      const next = atomicsLoad(this.cells, (top - 1) * 4 + 1);
      if (atomicsCompareExchange(this.free, 0, head, pack(next, high(head) + 1)) === head)
        return top - 1;
    }
    for (;;) {
      const index = atomicsLoad(this.allocated, 0);
      if (index >= this.maxCells)
        throw new ProcessError(PipeErrno.NFILE, "pipe cursor registry limit reached");
      // Back the cell before counting it: revocation scans every counted cell, and an
      // allocator that stops here must not leave a counted cell past the buffer's end.
      this.ensureCell(index);
      if (atomicsCompareExchange(this.allocated, 0, index, index + 1) === index) return index;
    }
  }
  /** Return a cell whose last hold dropped. Its tag advances before anyone can reuse it. */
  private releaseCell(index: number, tag: number): void {
    // A cell out of tags stays retired with no holds, so no reference can enter it again.
    if (tag >= LAST_CELL_TAG) return;
    atomicsStore(this.cells, index * 4, (tag + 1) << CELL_TAG_SHIFT);
    for (;;) {
      const head = atomicsLoad(this.free, 0);
      atomicsStore(this.cells, index * 4 + 1, low(head));
      if (atomicsCompareExchange(this.free, 0, head, pack(index + 1, high(head) + 1)) === head)
        return;
    }
  }
  private ensureCell(index: number): void {
    const buffer = this.data.buffer;
    const needed = this.cellBase + (index + 1) * CELL_BYTES;
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
  /** Internal cursor allocation. Returns a cell reference holding one hold, which the caller
   * owns: a ring keeps it while its mapping names the cell, then drops it with `leave`. */
  allocate(pid: number): number {
    const owner = this.process(pid);
    if (!owner || owner.value & OWNER_REVOKED) throw new Error("pipe process is revoked");
    const index = this.reserveCell();
    const tag = atomicsLoad(this.cells, index * 4) >>> CELL_TAG_SHIFT;
    const ref = (tag << CELL_TAG_SHIFT) | index;
    const cell = this.canonical(ref);
    // Nobody can enter a cell with no holds, so these stores precede any other use of it.
    atomicsStore(this.cells, index * 4 + 1, pid);
    atomicsStore(cell, 0, ALLOCATED);
    atomicsStore(this.cells, index * 4, (tag << CELL_TAG_SHIFT) | 1);
    // Dekker pair with revocation: the owner store above precedes this row load, and a
    // killer's revoked-row CAS precedes its scan. Either this load sees the revocation or
    // the scan sees this cell.
    const value = atomicsLoad(this.owners, owner.slot);
    if (registryPid(value) !== pid || value & OWNER_REVOKED) {
      atomicsOr(cell, 0, STOP);
      this.leave(ref);
      throw new Error("pipe process is revoked");
    }
    return ref;
  }
  /** Take one hold on this incarnation of a cell. False once it was released. */
  enter(ref: number): boolean {
    const at = (ref & CELL_INDEX) * 4,
      tag = ref >>> CELL_TAG_SHIFT;
    for (;;) {
      const epoch = atomicsLoad(this.cells, at);
      const holds = epoch & CELL_HOLDS;
      if (epoch >>> CELL_TAG_SHIFT !== tag || !holds) return false;
      if (holds === CELL_HOLDS) throw new RangeError("pipe cursor hold limit reached");
      if (atomicsCompareExchange(this.cells, at, epoch, epoch + 1) === epoch) return true;
    }
  }
  /** Drop one hold; the last one returns the cell for reuse. */
  leave(ref: number): void {
    const index = ref & CELL_INDEX;
    const previous = atomicsAdd(this.cells, index * 4, -1);
    if ((previous & CELL_HOLDS) === 1) this.releaseCell(index, previous >>> CELL_TAG_SHIFT);
  }
  /** Whether this incarnation is still unreleased: validates a cursor loaded without a hold. */
  current(ref: number): boolean {
    return (
      atomicsLoad(this.cells, (ref & CELL_INDEX) * 4) >>> CELL_TAG_SHIFT === ref >>> CELL_TAG_SHIFT
    );
  }
  /** Epoch and owner words of every cell; rings validate unheld loads against them. */
  get cellWords(): Int32Array {
    return this.cells;
  }
  /** Raw cursor view of a cell. Callers act on it only while holding the reference. */
  canonical(ref: number): BigInt64Array {
    const index = ref & CELL_INDEX;
    const offset = this.cellBase + index * CELL_BYTES + 8;
    if (
      !Number.isInteger(ref) ||
      ref < 0 ||
      index >= atomicsLoad(this.allocated, 0) ||
      offset + 8 > sharedArrayBufferByteLength(this.data.buffer)
    )
      throw new RangeError("invalid pipe cursor");
    // Per-cell views remain valid after growth, including in a handle cloned before growth.
    return new BigInt64ArrayConstructor(this.data.buffer, offset, 1);
  }
  /** Cells currently held, for diagnostics and tests. */
  get cellsInUse(): number {
    let count = 0;
    const limit = atomicsLoad(this.allocated, 0);
    for (let index = 0; index < limit; index++)
      if (atomicsLoad(this.cells, index * 4) & CELL_HOLDS) count++;
    return count;
  }
  /** Mark the owner revoked. The caller then freezes its cells: the scan follows the CAS. */
  private markRevoked(pid: number): { slot: number; value: bigint } | undefined {
    const owner = this.process(pid);
    if (!owner) return undefined;
    for (;;) {
      const value = atomicsLoad(this.owners, owner.slot);
      if (registryPid(value) !== pid) return undefined;
      const revoked = value | OWNER_REVOKED;
      if (atomicsCompareExchange(this.owners, owner.slot, value, revoked) === value)
        return { slot: owner.slot, value: revoked };
    }
  }
  /** Freeze every held cell this PID owns. A hold pins the owner word while it is checked.
   * A cell at its hold limit cannot be held; the scan still freezes every other cell, then
   * reports that one. */
  private freezeCells(pid: number): void {
    const limit = atomicsLoad(this.allocated, 0);
    let failure: unknown;
    for (let index = 0; index < limit; index++) {
      try {
        this.freezeCell(index, pid);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }
  private freezeCell(index: number, pid: number): void {
    const epoch = atomicsLoad(this.cells, index * 4);
    if (!(epoch & CELL_HOLDS) || atomicsLoad(this.cells, index * 4 + 1) !== pid) return;
    const ref = (epoch & ~CELL_HOLDS) | index;
    if (!this.enter(ref)) return;
    if (atomicsLoad(this.cells, index * 4 + 1) === pid) atomicsOr(this.canonical(ref), 0, STOP);
    this.leave(ref);
  }
  revoke(pid: number): void {
    try {
      if (this.markRevoked(pid)) this.freezeCells(pid);
    } finally {
      notify(this.wake);
    }
  }
  /** Host resource-fence completion: freeze even unannounced descendant-created pipes and
   * release this owner's row. Physical worker termination is not required. Cells stay with
   * the rings that map them: a reader may still drain a collected writer's committed bytes.
   */
  collectProcess(pid: number): void {
    const owner = this.markRevoked(pid);
    try {
      if (owner) this.freezeCells(pid);
    } finally {
      if (owner) atomicsCompareExchange(this.owners, owner.slot, owner.value, 0n);
      notify(this.wake);
    }
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
  // Cached raw views of the mapped registry cells, keyed by mapping word (reference + 1).
  private publicationMapped = 0;
  private publicationCell?: BigInt64Array;
  private consumptionMapped = 0;
  private consumptionCell?: BigInt64Array;
  /** The registry's cell words, for validating loads without a call into the registry. */
  private readonly cellWords?: Int32Array;
  readonly epoch: Int32Array;
  readonly capacity: number;
  private readonly recordCapacity: number;
  private readonly bytes: PageMap;
  private readonly records: PageMap;
  /** Writer rings keep reserved pages; delivery rings borrow shared pages only. */
  private readonly writer: boolean;
  constructor(
    private readonly space: PipeSpace,
    offset: number,
    /** Writer slot whose reserved pages this ring owns, or -1 for a delivery ring. */
    writerSlot: number,
    /** Wake waiting endpoints; called whenever this ring returns a page outside a read. */
    private readonly wake: () => void,
    private readonly registry?: PipePublicationRegistry,
  ) {
    const buffer = space.buffer,
      layout = space.layout;
    this.pid = new Int32ArrayConstructor(buffer, offset, 1);
    this.refs = new Int32ArrayConstructor(buffer, offset + 4, 1);
    this.localPublished = new BigInt64ArrayConstructor(buffer, offset + 8, 1);
    this.localConsumed = new BigInt64ArrayConstructor(buffer, offset + 16, 1);
    this.mapping = new Int32ArrayConstructor(buffer, offset + 24, 2);
    this.demand = new Int32ArrayConstructor(buffer, offset + 32, 1);
    this.epoch = new Int32ArrayConstructor(buffer, offset + 36, 1);
    this.cellWords = registry?.cellWords;
    this.capacity = space.capacity;
    this.recordCapacity = records(space.capacity);
    this.writer = writerSlot >= 0;
    let at = offset + RING_HEADER;
    const table = (count: number): { entries: BigInt64Array; words: Int32Array } => {
      const entries = new BigInt64ArrayConstructor(buffer, at, count),
        words = new Int32ArrayConstructor(buffer, at, count * 2);
      at += count * 8;
      return { entries, words };
    };
    const hints = (): Int32Array => {
      const view = new Int32ArrayConstructor(buffer, at, RESERVED_PAGES);
      at += RESERVED_PAGES * 4;
      return view;
    };
    const byteTable = table(layout.pages),
      recordTable = table(layout.recordPages);
    const byteHints = hints(),
      recordHints = hints();
    const floor = this.writer ? DELIVERY_RESERVE : 0;
    const reserved = (pool: PoolLayout) =>
      this.writer ? pool.shared + writerSlot * RESERVED_PAGES : -1;
    this.bytes = new PageMap(
      byteTable.entries,
      byteTable.words,
      byteHints,
      space.bytePool,
      reserved(layout.bytePool),
      floor,
      log2(layout.pageBytes),
      log2(this.capacity),
      32,
    );
    this.records = new PageMap(
      recordTable.entries,
      recordTable.words,
      recordHints,
      space.recordPool,
      reserved(layout.recordPool),
      floor,
      log2(layout.recordPage),
      log2(this.recordCapacity),
      29,
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
    if (this.registry && atomicsLoad(this.mapping, at) === RETIRED)
      throw new Error("pipe endpoint is closed");
    const local = at ? this.localConsumed : this.localPublished;
    const value = this.load(at) & ~(STOP | ALLOCATED);
    atomicsStore(local, 0, value);
    if (!this.registry) return;
    const ref = this.registry.allocate(pid);
    atomicsOr(this.registry.canonical(ref), 0, value);
    // The slot's advanced incarnation fences its own operations; other parties holding the
    // old cell keep it until they drop it, so it is never reused under them.
    for (;;) {
      const old = atomicsLoad(this.mapping, at);
      if (old === RETIRED) {
        this.registry.leave(ref);
        throw new Error("pipe endpoint is closed");
      }
      if (atomicsCompareExchange(this.mapping, at, old, ref + 1) !== old) continue;
      this.drop(old);
      return;
    }
  }
  /** Raw cursor for a mapping word from `hold`: the registry cell, or the local cursor. */
  private cursor(at: 0 | 1, mapped: number): BigInt64Array {
    if (mapped <= 0) return at ? this.localConsumed : this.localPublished;
    if (at === 0) {
      if (this.publicationMapped !== mapped) {
        this.publicationCell = this.registry!.canonical(mapped - 1);
        this.publicationMapped = mapped;
      }
      return this.publicationCell!;
    }
    if (this.consumptionMapped !== mapped) {
      this.consumptionCell = this.registry!.canonical(mapped - 1);
      this.consumptionMapped = mapped;
    }
    return this.consumptionCell!;
  }
  /** Load a cursor (0 published, 1 consumed). A registry cell may be released and reused
   * at any time nobody holds it, so its load is validated against the cell's tag after. */
  load(at: 0 | 1): bigint {
    for (;;) {
      const mapped = atomicsLoad(this.mapping, at);
      if (mapped <= 0) return atomicsLoad(at ? this.localConsumed : this.localPublished, 0);
      const value = atomicsLoad(this.cursor(at, mapped), 0);
      // The cell's epoch word still carries the reference's tag (registry.current, inlined).
      const ref = mapped - 1;
      if (
        atomicsLoad(this.cellWords!, (ref & CELL_INDEX) * 4) >>> CELL_TAG_SHIFT ===
        ref >>> CELL_TAG_SHIFT
      )
        return value;
      // The mapping moves on before its hold drops, so a released cell means a new mapping,
      // unless a corrupted mapping names a released cell: then report a stopped cursor.
      if (atomicsLoad(this.mapping, at) === mapped) return value | STOP;
    }
  }
  /** Hold the mapped cell across a mutation. Returns the mapping word for cursor/drop. */
  private hold(at: 0 | 1): number {
    for (;;) {
      const mapped = atomicsLoad(this.mapping, at);
      if (mapped <= 0 || this.registry!.enter(mapped - 1)) return mapped;
      if (atomicsLoad(this.mapping, at) === mapped) return RETIRED;
    }
  }
  private drop(mapped: number): void {
    if (mapped > 0) this.registry!.leave(mapped - 1);
  }
  bind(pid: number, kind: "published" | "consumed"): void {
    if (!this.registry) return;
    const at = kind === "published" ? 0 : 1;
    if (atomicsLoad(this.mapping, at)) return;
    let ref: number;
    try {
      ref = this.registry.allocate(pid);
    } catch (error) {
      if (kind === "consumed" && this.registry.isRevoked(pid)) {
        this.freezeReader();
        return;
      }
      throw error;
    }
    const local = at ? this.localConsumed : this.localPublished;
    const cell = this.registry.canonical(ref);
    // One hold for the mapping, one for the copy after publishing it: a retiring pipe may
    // drop the mapping's hold as soon as the mapping names this cell.
    this.registry.enter(ref);
    atomicsOr(cell, 0, atomicsLoad(local, 0));
    if (atomicsCompareExchange(this.mapping, at, 0, ref + 1) === 0)
      atomicsOr(cell, 0, atomicsLoad(local, 0));
    else this.registry.leave(ref);
    this.registry.leave(ref);
  }
  /** The pipe retired: keep each cursor's frozen value locally and release its cells. */
  retire(): void {
    if (!this.registry) return;
    this.retireCursor(0);
    this.retireCursor(1);
  }
  /** Whether retirement reached this ring's consumed cursor, the last one it retires. */
  get retired(): boolean {
    return atomicsLoad(this.mapping, 1) === RETIRED;
  }
  private retireCursor(at: 0 | 1): void {
    const local = at ? this.localConsumed : this.localPublished;
    for (;;) {
      const mapped = atomicsLoad(this.mapping, at);
      if (mapped === RETIRED) return;
      atomicsStore(local, 0, this.load(at) | STOP);
      if (atomicsCompareExchange(this.mapping, at, mapped, RETIRED) !== mapped) continue;
      this.drop(mapped);
      return;
    }
  }
  get owner(): number {
    return atomicsLoad(this.pid, 0);
  }
  get references(): number {
    return atomicsLoad(this.refs, 0);
  }
  get closed(): boolean {
    return stopped(this.load(0));
  }
  get available(): number {
    const consumed = this.load(1);
    return Math.min(this.capacity, distance(this.load(0), consumed));
  }
  get writable(): boolean {
    const consumed = this.load(1),
      published = this.load(0);
    const position = low(published),
      record = recordCounter(published);
    return (
      distance(published, consumed) < this.capacity &&
      ((record - recordCounter(consumed)) & RECORD_MASK) < this.recordCapacity &&
      this.records.canMap(record) &&
      this.bytes.canMap(position)
    );
  }
  private freeze(at: 0 | 1): void {
    atomicsOr(at ? this.localConsumed : this.localPublished, 0, STOP);
    const mapped = this.hold(at);
    atomicsOr(this.cursor(at, mapped), 0, STOP);
    this.drop(mapped);
  }
  freezeWriter(): void {
    this.freeze(0);
  }
  freezeReader(): void {
    this.freeze(1);
  }
  request(count: number): boolean {
    return atomicsCompareExchange(this.demand, 0, 0, Math.min(count, this.capacity)) === 0;
  }
  head(): PipeRecord | undefined {
    wide[0] = this.load(1);
    const position = halves[LOW]!,
      index = (halves[HIGH]! >>> 2) & RECORD_MASK;
    if (index === recordCounter(this.load(0))) return undefined;
    const slot = this.recordSlot(index);
    if (slot < 0) return undefined;
    const end = this.space.ends[slot * 4 + 2]!;
    return {
      index,
      end,
      remaining: (end - position) >>> 0,
      ticket: atomicsLoad(this.space.tickets, slot * 2),
    };
  }
  private recordSlot(record: number): number {
    const id = this.records.find(record);
    if (id < 0) return -1;
    const perPage = this.space.layout.recordPage;
    return id * perPage + (record & (perPage - 1));
  }
  write(
    chunks: readonly Uint8Array[],
    valid: () => boolean,
    ticket: bigint,
    incarnation: number,
    atomic = true,
  ): number {
    if (!this.enter(incarnation)) return -PipeErrno.BADF;
    // Hold the published cell from its load to the publishing CAS. A refused hold (the cell
    // is at its hold limit) still leaves the section.
    let mapped = 0;
    try {
      mapped = this.hold(0);
      return this.writeEntered(chunks, valid, ticket, atomic, this.cursor(0, mapped));
    } finally {
      this.drop(mapped);
      this.leave();
    }
  }
  private writeEntered(
    chunks: readonly Uint8Array[],
    valid: () => boolean,
    ticket: bigint,
    atomic: boolean,
    publication: BigInt64Array,
  ): number {
    const published = atomicsLoad(publication, 0);
    wide[0] = published;
    const position = halves[LOW]!,
      flags = halves[HIGH]!;
    if (flags & 1) return -PipeErrno.BADF;
    const record = (flags >>> 2) & RECORD_MASK;
    wide[0] = this.load(1);
    const free = this.capacity - ((position - halves[LOW]!) >>> 0);
    const usedRecords = (record - (halves[HIGH]! >>> 2)) & RECORD_MASK;
    const requested = length(chunks);
    const whole = atomic && requested <= Math.min(4096, this.capacity);
    if (usedRecords >= this.recordCapacity || (whole && free < requested)) return -PipeErrno.AGAIN;
    pipePause("write.loaded");
    let idle = false;
    if (!usedRecords && free === this.capacity && this.writer) {
      idle = this.bytes.releaseIdle(position, true);
      idle = this.records.releaseIdle(record, true) || idle;
    }
    const count = this.reserve(position, record, Math.min(requested, free), whole ? requested : 1);
    if (!count) {
      if (idle) this.wake();
      return -PipeErrno.AGAIN;
    }
    pipePause("write.reserved");
    this.copyIn(chunks, position, count);
    const slot = this.recordSlot(record);
    atomicsStore(this.space.tickets, slot * 2, ticket);
    this.space.ends[slot * 4 + 2] = (position + count) >>> 0;
    pipePause("write.copied");
    // Payload AND record metadata become visible in one canonical CAS. Revocation captures
    // precisely this committed prefix; unused tickets never block readers behind a zombie.
    const next = pack((position + count) >>> 0, (flags & 3) | (((record + 1) & RECORD_MASK) << 2));
    if (valid() && atomicsCompareExchange(publication, 0, published, next) === published)
      return count;
    pipePause("write.failed");
    // Nothing was published, so the pages just mapped lie outside the unread window.
    if (this.sweep(true) || idle) this.wake();
    return -PipeErrno.BADF;
  }
  /** Map the record slot and at least `minimum` payload bytes. Returns the bytes mapped. */
  private reserve(position: number, record: number, count: number, minimum: number): number {
    if (!count) return 0;
    if (this.records.ensure(record, 1)) {
      pipePause("write.record");
      const mapped = this.bytes.ensure(position, count);
      if (mapped >= minimum) return mapped;
    }
    if (this.sweep(true)) this.wake();
    return 0;
  }
  /** Return every page outside this ring's unread window. `fenced` asserts that no producer
   * can write the ring now: its own producer calling, the relay on a delivery ring it is
   * recovering, or a slot reclaim that advanced the incarnation. Returns whether it freed;
   * the caller wakes waiters. */
  sweep(fenced: boolean): boolean {
    // Published first: a consumer cursor read after it never passes it.
    const published = this.load(0);
    const end = low(published),
      last = recordCounter(published);
    pipePause("sweep.cursors");
    const bytes = this.bytes.sweep(() => low(this.load(1)), end, fenced);
    const records = this.records.sweep(() => recordCounter(this.load(1)), last, fenced);
    return bytes || records;
  }
  private copyIn(chunks: readonly Uint8Array[], position: number, count: number): void {
    const unit = this.space.layout.pageBytes;
    let copied = 0;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const take = Math.min(typedArrayLength(chunk), count - copied);
      for (let at = 0; at < take;) {
        const target = (position + copied + at) >>> 0,
          offset = target & (unit - 1);
        const piece = Math.min(take - at, unit - offset);
        const base = this.bytes.find(target) * unit + offset;
        typedArrayCopy(this.space.payload, base, chunk, at, at + piece);
        at += piece;
      }
      copied += take;
      if (copied === count) break;
    }
  }
  /** Copy committed bytes into private scratch; false when this view raced a reclaimed page. */
  private copyOut(copy: Uint8Array, position: number, count: number): boolean {
    const unit = this.space.layout.pageBytes;
    for (let at = 0; at < count;) {
      const source = (position + at) >>> 0,
        offset = source & (unit - 1);
      const id = this.bytes.find(source);
      if (id < 0) return false;
      const piece = Math.min(count - at, unit - offset),
        base = id * unit + offset;
      typedArrayCopy(copy, at, this.space.payload, base, base + piece);
      at += piece;
    }
    return true;
  }
  read(chunks: readonly Uint8Array[], supervisor = false): number {
    // Hold the consumed cell from its load to the consuming CAS.
    const mapped = this.hold(1);
    try {
      return this.readHeld(chunks, supervisor, this.cursor(1, mapped));
    } finally {
      this.drop(mapped);
    }
  }
  private readHeld(
    chunks: readonly Uint8Array[],
    supervisor: boolean,
    consumption: BigInt64Array,
  ): number {
    const consumed = atomicsLoad(consumption, 0);
    wide[0] = consumed;
    const position = halves[LOW]!,
      flags = halves[HIGH]!;
    if (!supervisor && flags & 1) return -PipeErrno.AGAIN;
    const record = (flags >>> 2) & RECORD_MASK;
    wide[0] = this.load(0);
    const written = halves[LOW]!,
      writtenFlags = halves[HIGH]!;
    if (record === ((writtenFlags >>> 2) & RECORD_MASK))
      return writtenFlags & 1 ? 0 : -PipeErrno.AGAIN;
    const slot = this.recordSlot(record);
    if (slot < 0) return -PipeErrno.AGAIN;
    const remaining = (this.space.ends[slot * 4 + 2]! - position) >>> 0;
    // A stale view can read a reused record; clamp so it never copies past committed bytes.
    const count = Math.min(length(chunks), remaining, (written - position) >>> 0);
    if (!count) return -PipeErrno.AGAIN;
    pipePause("read.loaded");
    // Copy before the CAS: a consumer that loses the race must leave the caller's buffer alone.
    const copy = scratchFor(count);
    if (!this.copyOut(copy, position, count)) return -PipeErrno.AGAIN;
    pipePause("read.copied");
    const complete = count === remaining;
    const next = pack(
      (position + count) >>> 0,
      (flags & 3) | (((record + (complete ? 1 : 0)) & RECORD_MASK) << 2),
    );
    if (atomicsCompareExchange(consumption, 0, consumed, next) !== consumed)
      return -PipeErrno.AGAIN;
    pipePause("read.committed");
    this.bytes.release(position, count);
    if (complete) this.records.release(record, 1);
    let at = 0;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const take = Math.min(typedArrayLength(chunk), count - at);
      typedArrayCopy(chunk, 0, copy, at, at + take);
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
  private lastReader = 0;
  constructor(
    handle: Pick<
      PipeEndpointHandle,
      "id" | "buffer" | "capacity" | "maxWriters" | "maxReaders" | "wake" | "registry"
    >,
    private readonly allocateShared: (length: number) => SharedArrayBuffer = allocatePipeBuffer,
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
    const space = pipeSpace(this.buffer, this.capacity, this.maxWriters, this.maxReaders);
    const ringBytes = space.layout.ringBytes;
    const writerSlots = { __proto__: null, length: this.maxWriters };
    const readerSlots = { __proto__: null, length: this.maxReaders };
    const wake = () => this.signal();
    this.writers = arrayFrom(
      writerSlots,
      (_, slot) => new Ring(space, HEADER + slot * ringBytes, slot, wake, this.registry),
    );
    this.readers = arrayFrom(
      readerSlots,
      (_, slot) =>
        new Ring(space, HEADER + (this.maxWriters + slot) * ringBytes, -1, wake, this.registry),
    );
    space.bytePool.scavenge = space.recordPool.scavenge = () => this.scavenge();
  }
  /** An exhausted pool takes back pages earlier laps left behind, for example by a reader
   * stopped between its consuming CAS and its release, and wakes anyone waiting for one. */
  private scavenge(): boolean {
    let freed = false;
    for (let index = 0; index < this.writers.length + this.readers.length; index++) {
      const ring =
        index < this.writers.length
          ? this.writers[index]!
          : this.readers[index - this.writers.length]!;
      pipePause("scavenge.ring");
      if (ring.sweep(false)) freed = true;
    }
    if (freed) this.signal();
    return freed;
  }
  get relay(): boolean {
    return atomicsLoad(this.control, 0) !== 0;
  }
  get disposed(): boolean {
    return atomicsLoad(this.control, 3) !== 0;
  }
  get closed(): boolean {
    for (;;) {
      const generation = atomicsLoad(this.control, 5);
      if (generation === -1) {
        // The retiring realm may have stopped before releasing every cell: finish for it.
        if (this.registry && !this.readers[this.readers.length - 1]!.retired) this.retireCells();
        return true;
      }
      if (!this.disposed) return this.retireIdle(generation);
      // A disposed pipe admits nobody; retire it once, so its registry cells return.
      if (atomicsCompareExchange(this.control, 5, generation, -1) !== generation) continue;
      this.retireCells();
      return true;
    }
  }
  /** Retire the pipe if no slot is alive. The one winning CAS releases its registry cells:
   * every endpoint is then dead, and an operation still running holds the cells it uses. */
  private retireIdle(generation: number): boolean {
    if (generation === 0) return false;
    let alive = false;
    for (let index = 0; index < this.writers.length + this.readers.length; index++) {
      const ring =
        index < this.writers.length
          ? this.writers[index]!
          : this.readers[index - this.writers.length]!;
      const pid = ring.owner;
      const reader = index >= this.writers.length;
      if (
        reader
          ? this.readerPending(ring)
          : pid &&
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
    if (atomicsCompareExchange(this.control, 5, generation, -1) !== generation) return false;
    this.retireCells();
    return true;
  }
  /** After a close: retire a registry-backed pipe now if that was its last live slot, so its
   * cells return even when no relay or broker is watching it. */
  settle(): boolean {
    return this.registry !== undefined && this.closed;
  }
  /** Idempotent, so any realm may finish a retirement another realm began. It goes in ring
   * order, and the last reader's consumed cursor is the last one it retires. */
  private retireCells(): void {
    if (!this.registry) return;
    ringForEach(this.writers, (ring) => ring.retire());
    ringForEach(this.readers, (ring) => ring.retire());
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
    const pid = ring.owner;
    return pid > 0 && ring.references > 0 && !this.registry?.isRevoked(pid);
  }
  hasReaders(): boolean {
    // Check the reader found alive last time before scanning every slot.
    if (this.readerAlive(this.readers[this.lastReader]!)) return true;
    for (let index = 0; index < this.readers.length; index++) {
      if (!this.readerAlive(this.readers[index]!)) continue;
      this.lastReader = index;
      return true;
    }
    return false;
  }
  /** A reservation or reclaiming slot may still publish a reader after the last close. */
  readerHangup(): boolean {
    const changed = atomicsLoad(this.changed, 0);
    const generation = atomicsLoad(this.control, 5);
    if (ringSome(this.readers, (ring) => this.readerPending(ring))) return false;
    if (atomicsLoad(this.control, 5) === generation && atomicsLoad(this.changed, 0) === changed)
      return true;
    this.signal();
    return false;
  }
  private readerPending(ring: Ring): boolean {
    const pid = ring.owner;
    if (pid === RECLAIMING) return true;
    if (pid === 0 || this.registry?.isRevoked(Math.abs(pid))) return false;
    return pid < 0 || ring.references > 0;
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
      (total, ring) => total + (ring.owner !== 0 ? ring.available : 0),
    );
  }
  relayAvailable(): number {
    return (
      this.queued() +
      Math.max(0, atomicsLoad(this.control, 4)) +
      ringReduce(this.readers, 0, (total, ring) => total + (ring.owner !== 0 ? ring.available : 0))
    );
  }
  nextTicket(): bigint {
    return BigInt.asIntN(64, atomicsAdd(this.sequence, 0, 1n) + 1n);
  }
  source(supervisor: boolean): { ring: Ring; record: PipeRecord; pin: bigint } | undefined {
    // Selection: bit 62 relay mode, bits 17 to 45 the pinned record, bits 0 to 16 slot + 1.
    const selection = atomicsLoad(this.selection, 0);
    const selectionLow = low(selection),
      selectionHigh = high(selection);
    const relayHigh = selectionHigh & RELAY_HIGH,
      relay = relayHigh ? RELAY_SELECTION : 0n;
    if (!supervisor && relayHigh) return undefined;
    const selected = (selectionLow & 0x1ffff) - 1;
    if (selected >= 0) {
      const ring = this.writers[selected]!,
        record = ring.head();
      const pinned = ((selectionLow >>> 17) | ((selectionHigh & 0x3fff) << 15)) & RECORD_MASK;
      if (record?.index === pinned) return { ring, record, pin: selection };
      // A reader may die after consuming the last byte but before releasing its pin.
      // Canonical consumption makes stale pins helpable without that reader's cleanup.
      if (atomicsCompareExchange(this.selection, 0, selection, relay) === selection)
        return this.source(supervisor);
      return undefined;
    }
    // Exclude tickets issued after the scan begins: otherwise an earlier slot scanned empty
    // could commit A before B starts, but the same scan would incorrectly choose later B.
    const ceiling = atomicsLoad(this.sequence, 0);
    let chosen: Ring | undefined,
      chosenRecord: PipeRecord | undefined,
      chosenIndex = 0;
    for (let index = 0; index < this.writers.length; index++) {
      const ring = this.writers[index]!;
      if (ring.owner === 0) continue;
      const record = ring.head();
      if (!record || ticketOrder(record.ticket, ceiling) > 0) continue;
      if (chosenRecord && ticketOrder(record.ticket, chosenRecord.ticket) >= 0) continue;
      chosen = ring;
      chosenRecord = record;
      chosenIndex = index;
    }
    if (!chosen || !chosenRecord) return undefined;
    const pin = pack(
      (chosenIndex + 1) | ((chosenRecord.index & 0x7fff) << 17),
      (chosenRecord.index >>> 15) | relayHigh,
    );
    if (atomicsCompareExchange(this.selection, 0, relay, pin) !== relay) return undefined;
    return { ring: chosen, record: chosenRecord, pin };
  }
  consume(
    source: { ring: Ring; record: PipeRecord; pin: bigint },
    chunks: readonly Uint8Array[],
    supervisor: boolean,
  ): number {
    const result = source.ring.read(chunks, supervisor);
    // A successful read that ends the pinned record has moved its ring's head.
    const moved =
      result > 0
        ? result === source.record.remaining
        : source.ring.head()?.index !== source.record.index;
    if (moved) atomicsCompareExchange(this.selection, 0, source.pin, source.pin & RELAY_SELECTION);
    return result;
  }
  switchToRelay(): void {
    if (this.relay) return;
    atomicsOr(this.selection, 0, RELAY_SELECTION);
    // Revoke the old direct consumer's lease BEFORE publishing relay mode. A delayed direct
    // read cannot advance a ring's cursor after the supervisor takes over consumption.
    ringForEach(this.writers, (ring) => ring.freezeReader());
    atomicsStore(this.control, 0, 1);
    this.signal();
  }
  retain(pid: number, mode: PipeMode, fdflags?: SharedArrayBuffer): PipeEndpoint {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff || this.closed)
      throw new Error("invalid pipe process");
    if (
      this.registry?.isRevoked(pid) ||
      ringSome(this.writers, (ring) => ring.owner === pid && ring.references < 0) ||
      ringSome(this.readers, (ring) => ring.owner === pid && ring.references < 0)
    )
      throw new Error("pipe process is revoked");
    // Allocate before acquiring a ring reference, so failed allocation owns no endpoint.
    const flags = fdflags ?? this.allocateShared(4);
    const lifetime = this.allocateShared(4);
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
    if (selected < 0) {
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
        `pipe ${mode} process limit reached: ${rings.length} slots are ${mode === "read" ? "live, unread, busy" : "live, busy"} or incarnation-exhausted`,
      );
    const endpoint = new PipeEndpoint(this, pid, mode, selected, incarnation, lifetime, flags);
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
    // Writers append after old committed records. The consumer keeps its cursor and pin;
    // counted sections exclude old producers even when committed bytes remain.
    if (
      mode === "read" &&
      (ring.available !== 0 || recordCounter(ring.load(1)) !== recordCounter(ring.load(0)))
    )
      return undefined;
    if (atomicsCompareExchange(ring.pid, 0, owner, RECLAIMING) !== owner) return undefined;
    if (!ring.advance(incarnation)) {
      atomicsStore(ring.pid, 0, owner);
      this.signal();
      return undefined;
    }
    try {
      pipePause("reclaim.advanced");
      // The advanced incarnation fences every earlier producer and the new one is not
      // admitted yet, so pages a stopped writer or reader left behind can all go now.
      ring.sweep(true);
      atomicsStore(ring.refs, 0, 0);
      atomicsStore(ring.demand, 0, 0);
      ring.reopen(pid, "published");
      if (mode === "read") ring.reopen(pid, "consumed");
      atomicsStore(ring.pid, 0, -pid);
      if (mode === "read") this.switchToRelay();
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
  retainSuccessor(): PipeEndpoint {
    if (!this.live) throw new Error("pipe endpoint is closed");
    return this.state.retain(
      this.pid,
      this.mode,
      typedArrayBuffer(this.flags) as SharedArrayBuffer,
    );
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
    this.state.settle();
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
    if (!this.state.hasReaders())
      return this.state.readerHangup() ? -PipeErrno.PIPE : -PipeErrno.AGAIN;
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
    if (this.state.relay) return this.readDelivery(chunks);
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

  private readDelivery(chunks: readonly Uint8Array[]): number {
    if (!this.ring.enter(this.incarnation)) return -PipeErrno.BADF;
    try {
      if (!this.live) return -PipeErrno.BADF;
      const result = this.ring.read(chunks);
      if (result > 0) this.state.signal();
      else if (result === -PipeErrno.AGAIN && this.ring.request(length(chunks)))
        this.state.signal();
      return result;
    } finally {
      this.ring.leave();
    }
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
      const writable = this.state.hasReaders() && this.ring.writable;
      return {
        readable: false,
        writable,
        hangup: !writable && this.state.readerHangup(),
        nbytes: 0,
      };
    }
    const nbytes = this.state.relay ? this.state.relayAvailable() : this.state.queued();
    const hangup = this.state.relay ? this.ring.closed : this.state.eof();
    return { readable: nbytes > 0 || hangup, writable: false, hangup, nbytes };
  }
  async waitReaderHangup(): Promise<void> {
    for (;;) {
      const observed = atomicsLoad(this.notification, 0);
      if (!this.live || this.state.readerHangup()) return;
      await waitChanged(this.notification, observed);
    }
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
 * Rings page their storage from one pool per pipe, so the defaults reserve about 266 KB per
 * pipe whatever the slot count; see pipeReservationBytes(). Atomic writes are <=4096 bytes (or capacity in tiny configured rings). Reuse advances a
 * finite incarnation only after all synchronous mutations of the old incarnation leave.
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
  private delivery?: { ring: Ring; incarnation: number };
  private readonly onClosed?: () => void;
  private reportedClosed = false;
  constructor(options: PipeOptions = {}, attached?: PipeEndpointHandle) {
    this.onClosed = options.onClosed;
    if (attached) this.state = new PipeState(attached, options.allocateShared);
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
      const bytes = pipeLayout(capacity, maxWriters, maxReaders).bytes;
      const wake =
        options.registry?.wake ??
        options.wake ??
        (options.allocateShared
          ? new Int32ArrayConstructor(options.allocateShared(4))
          : (defaultWake ??= new Int32ArrayConstructor(new SharedArrayBufferConstructor(4))));
      if (!isSharedArrayBuffer(typedArrayBuffer(wake)) || typedArrayLength(wake) !== 1)
        throw new TypeError("pipe wake must be one shared int32");
      this.state = new PipeState(
        {
          id: cryptoRandomUUID(),
          buffer: (options.allocateShared ?? allocatePipeBuffer)(bytes),
          capacity,
          maxWriters,
          maxReaders,
          wake,
          registry: options.registry?.handle(),
        },
        options.allocateShared,
      );
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
      if (this.delivery && !this.recoverDelivery(this.delivery)) break;
      const destination = this.selectDelivery();
      if (!destination) break;
      try {
        if (!this.deliver(destination)) break;
      } finally {
        destination.ring.leave();
      }
    }
    if (!this.pending && this.state.eof() && this.state.relayAvailable() === 0) {
      ringForEach(this.state.readers, (ring) => this.endDelivery(ring));
    }
  }
  private recoverDelivery(delivery: { ring: Ring; incarnation: number }): boolean {
    const ring = delivery.ring;
    if (!ring.enter(delivery.incarnation)) {
      this.delivery = undefined;
      return true;
    }
    try {
      return this.recoverEntered(ring);
    } finally {
      ring.leave();
    }
  }
  /** A delivery ring is done: the relay, its only producer, returns every page it holds. */
  private retire(ring: Ring): boolean {
    this.delivery = undefined;
    if (ring.sweep(true)) this.state.signal();
    return true;
  }
  private recoverEntered(ring: Ring): boolean {
    if (!ring.available) return this.retire(ring);
    const alive = this.state.readerAlive(ring);
    const otherDemand = ringSome(
      this.state.readers,
      (candidate) =>
        candidate !== ring &&
        this.state.readerAlive(candidate) &&
        atomicsLoad(candidate.demand, 0) > 0,
    );
    if (alive && !otherDemand) return false;
    pipePause("relay.recover");
    if (!alive) {
      ring.freezeWriter();
      ring.freezeReader();
    }
    const head = ring.head();
    if (!head) return this.retire(ring);
    pipePause("relay.head");
    const copy = new Uint8ArrayConstructor(Math.min(head.remaining, 65536));
    const count = ring.read([copy], true);
    // The owner won the race to this record. Retire a drained ring; otherwise keep it as the
    // outstanding delivery, so no later delivery overtakes the bytes it still holds.
    if (count <= 0) return ring.available ? false : this.retire(ring);
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
    if (!ring.available) this.retire(ring);
    this.state.signal();
    return true;
  }
  private selectDelivery(): { ring: Ring; incarnation: number; budget: number } | undefined {
    for (let visited = 0; visited < this.state.readers.length; visited++) {
      const index = (this.readerCursor + visited) % this.state.readers.length;
      const ring = this.state.readers[index]!;
      const incarnation = ring.incarnation;
      if (!ring.enter(incarnation)) continue;
      let budget: number;
      try {
        budget = this.claimDemand(ring);
      } catch (error) {
        ring.leave();
        throw error;
      }
      if (!budget) {
        ring.leave();
        continue;
      }
      this.readerCursor = (index + 1) % this.state.readers.length;
      return { ring, incarnation, budget };
    }
    return undefined;
  }
  private claimDemand(ring: Ring): number {
    const demand = atomicsLoad(ring.demand, 0);
    if (
      !this.state.readerAlive(ring) ||
      ring.closed ||
      ring.available ||
      demand <= 0 ||
      demand & INFLIGHT
    )
      return 0;
    return atomicsCompareExchange(ring.demand, 0, demand, demand | INFLIGHT) === demand
      ? demand
      : 0;
  }
  private stageDelivery(budget: number): boolean {
    if (this.pending) return true;
    const source = this.state.source(true);
    if (!source) return false;
    const chunk = new Uint8ArrayConstructor(Math.min(source.record.remaining, budget, 65536));
    const count = this.state.consume(source, [chunk], true);
    if (count <= 0) return false;
    pipePause("relay.staged");
    this.pending = typedArraySubarray(chunk, 0, count);
    this.pendingAt = 0;
    this.pendingTicket = source.record.ticket;
    atomicsStore(this.state.control, 4, count);
    this.state.signal();
    return true;
  }
  private deliver(destination: { ring: Ring; incarnation: number; budget: number }): boolean {
    const ring = destination.ring;
    if (!this.stageDelivery(destination.budget)) {
      atomicsStore(ring.demand, 0, destination.budget);
      return false;
    }
    const pending = this.pending!;
    const piece = typedArraySubarray(
      pending,
      this.pendingAt,
      this.pendingAt + Math.min(destination.budget, 65536),
    );
    pipePause("relay.deliver");
    const delivered = ring.write(
      [piece],
      () => this.state.readerAlive(ring),
      this.pendingTicket,
      destination.incarnation,
      false,
    );
    // The outer section also fences demand and delivery bookkeeping after Ring.write leaves.
    // AGAIN means no shared page was free: keep the reader's demand and wait for a release.
    atomicsStore(ring.demand, 0, delivered === -PipeErrno.AGAIN ? destination.budget : 0);
    if (delivered <= 0) return delivered !== -PipeErrno.AGAIN;
    this.pendingAt += delivered;
    atomicsStore(this.state.control, 4, typedArrayLength(pending) - this.pendingAt);
    if (this.pendingAt === typedArrayLength(pending)) this.pending = undefined;
    this.delivery = { ring, incarnation: destination.incarnation };
    this.state.signal();
    return true;
  }
  private endDelivery(ring: Ring): void {
    ring.enterCurrent();
    try {
      if (ring.owner <= 0 || ring.closed) return;
      ring.freezeWriter();
      this.state.signal();
    } finally {
      ring.leave();
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

export function attachPipeEndpoint(
  handle: PipeEndpointHandle,
  options: Pick<PipeOptions, "allocateShared"> = {},
): PipeEndpoint {
  const state = new PipeState(handle, options.allocateShared);
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
  options: Pick<PipeOptions, "relay" | "onClosed" | "allocateShared"> = {},
): PipeController {
  return new PipeController(options, handle);
}
