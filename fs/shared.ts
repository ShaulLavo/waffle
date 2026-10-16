import type { FileHandle, FileStat } from "../core";
import { PAGE, FilesystemError, isRevoked, SHARED_SEGMENT_BYTES, MAX_SHARED_SEGMENTS, DEFAULT_SHARED_MAX_BYTES, createSharedSegment, normalizeSharedMaxBytes, type FilesystemSection, type GrowableSharedSegment } from "./protocol";
export { SHARED_SEGMENT_BYTES, DEFAULT_SHARED_MAX_BYTES } from "./protocol";

const MAGIC = 0x42574653;
const HEADER_WORDS = 16;
const MAX_FILES = 4096;
const MAX_FILE_PAGES = 256;
const SEGMENT_PAGES = 256;
const SEGMENT_BYTES = SEGMENT_PAGES * PAGE;
const MAX_SEGMENTS = MAX_SHARED_SEGMENTS;
const TOTAL_PAGES = SEGMENT_PAGES * MAX_SEGMENTS;
const SLOT_WORDS = 12;
const PAGE_OWNER_OFFSET = HEADER_WORDS;
const SLOT_OFFSET = PAGE_OWNER_OFFSET + TOTAL_PAGES;
const PAGE_TABLE_OFFSET = SLOT_OFFSET + MAX_FILES * SLOT_WORDS;
const DATA_OFFSET = (PAGE_TABLE_OFFSET + MAX_FILES * MAX_FILE_PAGES) * 4;
const BUFFER_SIZE = DATA_OFFSET + SEGMENT_BYTES;
const GLOBAL_LOCK = 1;
const SERVICE_OWNER = 0x7fffffff;
const USED_PAGES = 2;
const FILE_SIZE = 1;
const MTIME_LOW = 2;
const MTIME_HIGH = 3;
const INO = 4;
const CAPACITY = 5;
const REFS = 6;
const UNLINKED = 7;
const FILE_LOCK = 8;
const HANDLE = 9;

// The intrinsic copy, so a guest iovec subclass's set() cannot reenter under a file lock. WASI
// iovecs are plain views; a subclass's overridden length/buffer/byteOffset getters still run there.
const copyBytes = Uint8Array.prototype.set;

export class MissingSegmentError extends Error {}
export interface SharedFileInfo extends FileStat { capacity: number; }
export interface SharedSegment { buffer: SharedArrayBuffer; index: number; }

/** Fix only growable shared sources; ordinary/fixed WASM sources keep their original iovec.
 * A source can grow while waiting for a lock or copying another iovec. Capacity checks,
 * byte counts and the copy must all use the same bounds, including a nonzero byteOffset.
 */
export function fixedWriteSources(chunks: readonly Uint8Array[]): readonly Uint8Array[] {
  let fixed: Uint8Array[] | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const buffer = chunk.buffer;
    if (buffer instanceof SharedArrayBuffer && "growable" in buffer && buffer.growable) {
      fixed ??= chunks.slice();
      fixed[i] = new Uint8Array(buffer, chunk.byteOffset, chunk.byteLength);
    }
  }
  return fixed ?? chunks;
}

/** Shared metadata and a service-grown pool of prepublished growable SAB data segments. */
export class SharedFilesystemState {
  readonly cells: Int32Array;
  readonly owners: Int32Array;
  readonly slots: Int32Array;
  readonly pages: Int32Array;
  readonly segments: SharedArrayBuffer[];
  readonly pendingSegments: SharedSegment[] = [];
  private readonly firstBytes: Uint8Array;
  private readonly pageViews: (Uint8Array | undefined)[] = [];
  private serviceMutation = false;
  onContention?: () => void;
  constructor(readonly buffer: SharedArrayBuffer = SharedFilesystemState.createBuffer(), maxBytes = DEFAULT_SHARED_MAX_BYTES, readonly lockOwner = SERVICE_OWNER, segments: readonly SharedArrayBuffer[] = [], private readonly section?: FilesystemSection) {
    this.cells = new Int32Array(buffer, 0, HEADER_WORDS);
    if (Atomics.compareExchange(this.cells, 0, 0, MAGIC) === 0) {
      Atomics.store(this.cells, USED_PAGES, 0);
      Atomics.store(this.cells, 4, normalizeSharedMaxBytes(maxBytes) / SEGMENT_BYTES);
    } else while (Atomics.load(this.cells, 0) !== MAGIC) { /* another connection initializes */ }
    this.owners = new Int32Array(buffer, PAGE_OWNER_OFFSET * 4, TOTAL_PAGES);
    this.slots = new Int32Array(buffer, SLOT_OFFSET * 4, MAX_FILES * SLOT_WORDS);
    this.pages = new Int32Array(buffer, PAGE_TABLE_OFFSET * 4, MAX_FILES * MAX_FILE_PAGES);
    this.firstBytes = new Uint8Array(buffer, DATA_OFFSET, SEGMENT_BYTES);
    this.segments = [buffer].concat(segments);
  }
  static createBuffer(): SharedArrayBuffer { return new SharedArrayBuffer(BUFFER_SIZE); }
  addSegment(buffer: SharedArrayBuffer, index = this.segments.length): void {
    if (buffer.byteLength < SEGMENT_BYTES || !Number.isInteger(index) || index < 1 || index >= Atomics.load(this.cells, 4)) throw new RangeError("invalid shared filesystem segment");
    // An indexed announcement may arrive after a prepublished wrapper has already grown.
    // Keep the original wrapper so queued delivery cannot replace a live segment.
    this.segments[index] ??= buffer;
  }
  takeNewSegments(): SharedSegment[] { const out = this.pendingSegments.slice(); this.pendingSegments.length = 0; return out; }
  private segmentFor(page: number): Uint8Array {
    const cached = this.pageViews[page];
    if (cached) return cached;
    const segment = Math.floor(page / SEGMENT_PAGES);
    const local = page % SEGMENT_PAGES;
    const buffer = this.segments[segment];
    if (!buffer) throw new MissingSegmentError("shared filesystem segment has not reached this guest");
    // Fixed page views remain valid when a growable segment grows. Physical pages may be
    // recycled between files, but their backing buffer and byte offset never change.
    const bytes = segment === 0 ? this.firstBytes.subarray(local * PAGE, (local + 1) * PAGE) : new Uint8Array(buffer, local * PAGE, PAGE);
    this.pageViews[page] = bytes;
    return bytes;
  }
  private findSlot(handle: FileHandle, create = false): number {
    if (!Number.isInteger(handle) || handle < 0 || handle >= 0x7ffffffe) return 0;
    const start = handle % (MAX_FILES - 1);
    let available = 0;
    for (let probe = 0; probe < MAX_FILES - 1; probe++) {
      const slot = (start + probe) % (MAX_FILES - 1) + 1;
      const key = Atomics.load(this.slots, this.at(slot, HANDLE));
      if (key === handle + 1) return slot;
      if (key <= 0 && !available) available = slot;
      if (key === 0) return create ? available : 0;
    }
    return create ? available : 0;
  }
  private slot(handle: FileHandle): number {
    const slot = this.findSlot(handle);
    if (!slot) throw new FilesystemError(8);
    return slot;
  }
  private at(slot: number, field: number): number { return slot * SLOT_WORDS + field; }
  private pageAt(slot: number, logical: number): number { return slot * MAX_FILE_PAGES + logical; }
  /** The slot of a registered regular file, or 0. A live handle keeps its slot until it is freed. */
  fileSlot(handle: FileHandle): number { const slot = this.findSlot(handle); return slot !== 0 && Atomics.load(this.slots, this.at(slot, 0)) === 1 ? slot : 0; }
  hasFile(handle: FileHandle): boolean { const slot = this.findSlot(handle); return slot !== 0 && Atomics.load(this.slots, this.at(slot, 0)) === 1; }
  isUnlinked(handle: FileHandle): boolean { const slot = this.findSlot(handle); return slot !== 0 && Atomics.load(this.slots, this.at(slot, UNLINKED)) !== 0; }
  /** Spin for a held lock. Only a contended caller checks revocation here; every acquirer
   * checks it once after its locks are held, so a revoked guest never proceeds under a lock. */
  private contend(cells: Int32Array, index: number, revoked: (() => boolean) | undefined, owner: number): void {
    for (;;) {
      if (revoked?.()) throw new FilesystemError(11);
      this.onContention?.();
      if (Atomics.compareExchange(cells, index, 0, owner) === 0) return;
    }
  }
  private lock(index: number, revoked?: () => boolean, owner = this.lockOwner): void {
    this.section?.enter();
    try {
      if (Atomics.compareExchange(this.slots, index, 0, owner) !== 0) this.contend(this.slots, index, revoked, owner);
      if (!revoked?.()) return;
      Atomics.compareExchange(this.slots, index, owner, 0);
      throw new FilesystemError(11);
    } catch (error) { this.section?.exit(); throw error; }
  }
  private unlock(index: number, owner = this.lockOwner): void {
    Atomics.compareExchange(this.slots, index, owner, 0);
    this.section?.exit();
  }
  private globalLock(revoked?: () => boolean, owner = this.lockOwner): void {
    if (this.serviceMutation && owner === SERVICE_OWNER) return;
    this.section?.enter();
    try {
      if (Atomics.compareExchange(this.cells, GLOBAL_LOCK, 0, owner) !== 0) this.contend(this.cells, GLOBAL_LOCK, revoked, owner);
      if (!revoked?.()) return;
      Atomics.compareExchange(this.cells, GLOBAL_LOCK, owner, 0);
      throw new FilesystemError(11);
    } catch (error) { this.section?.exit(); throw error; }
  }
  private globalUnlock(owner = this.lockOwner): void {
    if (!this.serviceMutation) {
      Atomics.compareExchange(this.cells, GLOBAL_LOCK, owner, 0);
      this.section?.exit();
    }
  }
  beginServiceMutation(epoch: Int32Array): void {
    this.globalLock();
    this.serviceMutation = true;
    Atomics.add(epoch, 0, 1);
  }
  endServiceMutation(epoch: Int32Array): void {
    Atomics.add(epoch, 0, 1);
    this.serviceMutation = false;
    this.globalUnlock();
  }
  get ownsServiceMutation(): boolean { return this.serviceMutation; }
  mutate<T>(epoch: Int32Array | undefined, revoked: (() => boolean) | undefined, fn: () => T, owner = this.lockOwner): T {
    this.globalLock(revoked, owner);
    if (epoch) Atomics.add(epoch, 0, 1);
    try { return fn(); }
    finally { if (epoch) Atomics.add(epoch, 0, 1); this.globalUnlock(owner); }
  }
  private setTimestamp(slot: number, mtime: number): void { Atomics.store(this.slots, this.at(slot, MTIME_LOW), mtime >>> 0); Atomics.store(this.slots, this.at(slot, MTIME_HIGH), Math.floor(mtime / 0x100000000) >>> 0); }
  private getMtime(slot: number): number { return (Atomics.load(this.slots, this.at(slot, MTIME_HIGH)) >>> 0) * 0x100000000 + (Atomics.load(this.slots, this.at(slot, MTIME_LOW)) >>> 0); }
  private ensureSegment(segment: number): void {
    if (segment >= Atomics.load(this.cells, 4)) throw new FilesystemError(51, "shared filesystem storage exhausted");
    if (segment === 0 || this.segments[segment]?.byteLength === SEGMENT_BYTES) return;
    const existing = this.segments[segment];
    const buffer = existing ?? createSharedSegment();
    (buffer as GrowableSharedSegment).grow(SEGMENT_BYTES);
    if (!existing) {
      // Standalone states can still exchange indexed segments. Connected identities already
      // own every wrapper, so their synchronous guests need no port delivery after growth.
      this.segments[segment] = buffer;
      this.pendingSegments.push({ buffer, index: segment });
    }
  }
  private allocate(slot: number, needed: number): void {
    const current = Atomics.load(this.slots, this.at(slot, CAPACITY));
    if (needed <= current) return;
    if (needed > MAX_FILE_PAGES) throw new RangeError("shared filesystem file is too large");
    const target = Math.max(needed, Math.min(MAX_FILE_PAGES, Math.max(1, current * 2)));
    const allocated: number[] = [];
    const rollback = () => {
      for (const physical of allocated) {
        this.segmentFor(physical).fill(0);
        Atomics.store(this.owners, physical, 0);
      }
      allocated.length = 0;
    };
    const take = (count: number) => {
      for (let physical = 0; physical < Atomics.load(this.cells, 4) * SEGMENT_PAGES && allocated.length < count; physical++) {
        this.ensureSegment(Math.floor(physical / SEGMENT_PAGES));
        if (Atomics.compareExchange(this.owners, physical, 0, slot) === 0) allocated.push(physical);
      }
    };
    try {
      take(target - current);
      if (allocated.length !== target - current && target !== needed) { rollback(); take(needed - current); }
      if (allocated.length !== needed - current && allocated.length !== target - current)
        throw new FilesystemError(51, "shared filesystem storage exhausted");
      // Finish potentially throwing initialization before publishing any page-table entries.
      for (const physical of allocated) this.segmentFor(physical).fill(0);
      for (let i = 0; i < allocated.length; i++) Atomics.store(this.pages, this.pageAt(slot, current + i), allocated[i]! + 1);
      Atomics.store(this.slots, this.at(slot, CAPACITY), current + allocated.length);
      Atomics.add(this.cells, USED_PAGES, allocated.length);
    } catch (error) {
      rollback();
      if (error instanceof RangeError) throw new FilesystemError(51, "shared filesystem segment allocation failed");
      throw error;
    }
  }
  register(handle: FileHandle, stat: FileStat, data?: Uint8Array): void {
    this.globalLock();
    try {
      const slot = this.findSlot(handle, true);
      if (!slot) throw new FilesystemError(51, "shared filesystem identity table exhausted");
      if (Atomics.load(this.slots, this.at(slot, 0)) && Atomics.load(this.slots, this.at(slot, INO)) === stat.ino) {
        if (stat.kind === "directory") {
          this.lock(this.at(slot, FILE_LOCK));
          try { this.setTimestamp(slot, stat.mtime); } finally { this.unlock(this.at(slot, FILE_LOCK)); }
        }
        return;
      }
      if (stat.kind === "file") { this.allocate(slot, Math.ceil(Math.max(data?.length ?? 0, stat.size) / PAGE)); if (data?.length) this.copyInto(slot, data, 0); }
      Atomics.store(this.slots, this.at(slot, 0), stat.kind === "file" ? 1 : 2); Atomics.store(this.slots, this.at(slot, FILE_SIZE), stat.size); Atomics.store(this.slots, this.at(slot, INO), stat.ino); this.setTimestamp(slot, stat.mtime); Atomics.store(this.slots, this.at(slot, HANDLE), handle + 1);
    } finally { this.globalUnlock(); }
  }
  info(handle: FileHandle, revoked?: () => boolean, owner = this.lockOwner): SharedFileInfo | undefined {
    const slot = this.findSlot(handle);
    if (!slot) return undefined;
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      if (Atomics.load(this.slots, this.at(slot, HANDLE)) !== handle + 1 || Atomics.load(this.slots, this.at(slot, 0)) !== 1) return undefined;
      return { kind: "file", ino: Atomics.load(this.slots, this.at(slot, INO)), size: Atomics.load(this.slots, this.at(slot, FILE_SIZE)), mtime: this.getMtime(slot), capacity: Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE };
    } finally { this.unlock(this.at(slot, FILE_LOCK), owner); }
  }
  stat(handle: FileHandle, revoked?: () => boolean, owner = this.lockOwner): FileStat | undefined {
    const slot = this.findSlot(handle);
    if (!slot) return undefined;
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      const kind = Atomics.load(this.slots, this.at(slot, 0));
      if (!kind || Atomics.load(this.slots, this.at(slot, HANDLE)) !== handle + 1) return undefined;
      return { kind: kind === 1 ? "file" : "directory", ino: Atomics.load(this.slots, this.at(slot, INO)), size: kind === 1 ? Atomics.load(this.slots, this.at(slot, FILE_SIZE)) : 0, mtime: this.getMtime(slot) };
    } finally { this.unlock(this.at(slot, FILE_LOCK), owner); }
  }
  private copyInto(slot: number, source: Uint8Array, offset: number): void { let at = offset; for (let sourceAt = 0; sourceAt < source.length;) { const logical = Math.floor(at / PAGE); const page = Atomics.load(this.pages, this.pageAt(slot, logical)) - 1; const inPage = at % PAGE; const count = Math.min(source.length - sourceAt, PAGE - inPage); this.segmentFor(page).set(source.subarray(sourceAt, sourceAt + count), inPage); at += count; sourceAt += count; } }
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number, revoked?: () => boolean, owner = this.lockOwner): number { const slot = this.slot(handle); if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31); this.lock(this.at(slot, FILE_LOCK), revoked, owner); try { const size = Atomics.load(this.slots, this.at(slot, FILE_SIZE)); let total = 0; for (const chunk of chunks) { let at = 0; while (at < chunk.length && offset + total < size) { const position = offset + total; const page = Atomics.load(this.pages, this.pageAt(slot, Math.floor(position / PAGE))) - 1; const inPage = position % PAGE; const count = Math.min(chunk.length - at, size - position, PAGE - inPage); chunk.set(this.segmentFor(page).subarray(inPage, inPage + count), at); at += count; total += count; } if (at < chunk.length) break; } return total; } finally { this.unlock(this.at(slot, FILE_LOCK), owner); } }
  /* Direct client paths. A live file's size, timestamp and page entries below its size change only
   * under its file lock; capacity and the page entries above it change only under the global lock.
   * Each direct path holds the lock covering every field it touches, so it uses plain Int32 reads
   * and writes (aligned, never torn) ordered by the lock's acquiring and releasing atomics. Lock
   * words, the epoch and revocation stay atomic. */
  /** Client read of an open file from its cached slot: one file lock, one revocation check after
   * locking, then a coherent copy straight into the guest iovecs. Every size change holds the
   * same lock, so the copy is the file's content at one instant. */
  directRead(slot: number, handle: FileHandle, chunks: readonly Uint8Array[], offset: number, revoked: () => boolean, owner: number): number {
    const slots = this.slots, base = slot * SLOT_WORDS, lock = base + FILE_LOCK;
    this.section?.enter();
    try { if (Atomics.compareExchange(slots, lock, 0, owner) !== 0) this.contend(slots, lock, revoked, owner); }
    catch (error) { this.section?.exit(); throw error; }
    try {
      if (revoked()) throw new FilesystemError(11);
      if (slots[base + HANDLE] !== handle + 1) throw new FilesystemError(8);
      const size = slots[base + FILE_SIZE]!, pages = this.pages, first = slot * MAX_FILE_PAGES;
      let position = offset;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!, length = chunk.length;
        let at = 0;
        while (at < length && position < size) {
          const inPage = position % PAGE;
          const count = Math.min(length - at, size - position, PAGE - inPage);
          const page = this.segmentFor(pages[first + (position - inPage) / PAGE]! - 1);
          copyBytes.call(chunk, count === PAGE ? page : page.subarray(inPage, inPage + count), at);
          at += count; position += count;
        }
        if (at < length) break;
      }
      return position - offset;
    } finally { Atomics.compareExchange(slots, lock, owner, 0); this.section?.exit(); }
  }
  private copyChunks(slot: number, chunks: readonly Uint8Array[], offset: number): void {
    const pages = this.pages, first = slot * MAX_FILE_PAGES;
    let position = offset;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!, length = chunk.length;
      for (let at = 0; at < length;) {
        const inPage = position % PAGE;
        const count = Math.min(length - at, PAGE - inPage);
        const page = this.segmentFor(pages[first + (position - inPage) / PAGE]! - 1);
        // A fixed-length source view never changes length; build sub-views without species lookup.
        page.set(count === length ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset + at, count), inPage);
        at += count; position += count;
      }
    }
  }
  /** Client in-capacity write at offset, or append at EOF, under one global mutation (odd epoch)
   * and one file lock, with one revocation check once both are held. Returns the end offset, or
   * the negated size the service must grow to after both locks exit. Sources must be fixed-length
   * views; callers reject negative offsets. */
  private direct(slot: number, handle: FileHandle, chunks: readonly Uint8Array[], append: boolean, offset: number, total: number, epoch: Int32Array, revoked: () => boolean, owner: number): number {
    const cells = this.cells, slots = this.slots, base = slot * SLOT_WORDS, lock = base + FILE_LOCK;
    this.section?.enter();
    try { if (Atomics.compareExchange(cells, GLOBAL_LOCK, 0, owner) !== 0) this.contend(cells, GLOBAL_LOCK, revoked, owner); }
    catch (error) { this.section?.exit(); throw error; }
    Atomics.add(epoch, 0, 1);
    try {
      if (Atomics.compareExchange(slots, lock, 0, owner) !== 0) this.contend(slots, lock, revoked, owner);
      try {
        if (revoked()) throw new FilesystemError(11);
        if (slots[base + HANDLE] !== handle + 1) throw new FilesystemError(8);
        const size = slots[base + FILE_SIZE]!;
        const at = append ? size : offset;
        if (!total) return at;
        const end = at + total;
        if (end > slots[base + CAPACITY]! * PAGE) return -end;
        this.copyChunks(slot, chunks, at);
        if (end > size) slots[base + FILE_SIZE] = end;
        const mtime = Date.now();
        slots[base + MTIME_LOW] = mtime >>> 0;
        slots[base + MTIME_HIGH] = Math.floor(mtime / 0x100000000) >>> 0;
        return end;
      } finally { Atomics.compareExchange(slots, lock, owner, 0); }
    } finally {
      Atomics.add(epoch, 0, 1);
      Atomics.compareExchange(cells, GLOBAL_LOCK, owner, 0);
      this.section?.exit();
    }
  }
  directWrite(slot: number, handle: FileHandle, chunks: readonly Uint8Array[], offset: number, total: number, epoch: Int32Array, revoked: () => boolean, owner: number): number | undefined {
    return this.direct(slot, handle, chunks, false, offset, total, epoch, revoked, owner) < 0 ? undefined : total;
  }
  directAppend(slot: number, handle: FileHandle, chunks: readonly Uint8Array[], total: number, epoch: Int32Array, revoked: () => boolean, owner: number): { written: number; offset: number } | number {
    const end = this.direct(slot, handle, chunks, true, 0, total, epoch, revoked, owner);
    return end < 0 ? -end : { written: total, offset: end };
  }
  /** Caller owns the global mutation lock. Undefined asks for service growth after unlock. */
  tryWrite(handle: FileHandle, chunks: readonly Uint8Array[], offset: number, total: number, revoked?: () => boolean, owner = this.lockOwner): number | undefined {
    const slot = this.slot(handle);
    if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31);
    if (!total) return 0;
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      if (revoked?.()) throw new FilesystemError(11);
      const end = offset + total;
      if (end > Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE) return undefined;
      let at = offset;
      for (const chunk of chunks) { this.copyInto(slot, chunk, at); at += chunk.length; }
      if (end > Atomics.load(this.slots, this.at(slot, FILE_SIZE))) Atomics.store(this.slots, this.at(slot, FILE_SIZE), end);
      this.setTimestamp(slot, Date.now());
      return total;
    } finally { this.unlock(this.at(slot, FILE_LOCK), owner); }
  }
  write(handle: FileHandle, chunks: readonly Uint8Array[], offset: number, revoked?: () => boolean, owner = this.lockOwner): number {
    chunks = fixedWriteSources(chunks);
    const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
    const written = this.tryWrite(handle, chunks, offset, total, revoked, owner);
    if (written === undefined) throw new RangeError("file needs growth");
    return written;
  }
  /** Caller owns the global mutation lock. A number asks for service growth after unlock. */
  tryAppend(handle: FileHandle, chunks: readonly Uint8Array[], total: number, revoked?: () => boolean, owner = this.lockOwner): { written: number; offset: number } | number {
    const slot = this.slot(handle);
    if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31);
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      const offset = Atomics.load(this.slots, this.at(slot, FILE_SIZE));
      if (!total) return { written: 0, offset };
      if (offset + total > Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE) return offset + total;
      let at = offset;
      for (const chunk of chunks) { this.copyInto(slot, chunk, at); at += chunk.length; }
      Atomics.store(this.slots, this.at(slot, FILE_SIZE), at);
      this.setTimestamp(slot, Date.now());
      return { written: total, offset: at };
    } finally { this.unlock(this.at(slot, FILE_LOCK), owner); }
  }
  append(handle: FileHandle, chunks: readonly Uint8Array[], revoked?: () => boolean, owner = this.lockOwner): { written: number; offset: number } {
    chunks = fixedWriteSources(chunks);
    const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
    const result = this.tryAppend(handle, chunks, total, revoked, owner);
    if (typeof result === "number") throw new RangeError("file needs growth");
    return result;
  }
  growLocked(handle: FileHandle, size: number): void { this.allocate(this.slot(handle), Math.ceil(size / PAGE)); }
  grow(handle: FileHandle, size: number): void { this.globalLock(); try { this.growLocked(handle, size); } finally { this.globalUnlock(); } }
  resize(handle: FileHandle, size: number, truncate: boolean, revoked?: () => boolean, owner = this.lockOwner): number { const slot = this.slot(handle); if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31); this.lock(this.at(slot, FILE_LOCK), revoked, owner); try { const old = Atomics.load(this.slots, this.at(slot, FILE_SIZE)); if (size > Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE) throw new RangeError("file needs growth"); if (truncate && size < old) { let position = size; while (position < old) { const page = Atomics.load(this.pages, this.pageAt(slot, Math.floor(position / PAGE))) - 1; const count = Math.min(old - position, PAGE - position % PAGE); this.segmentFor(page).fill(0, position % PAGE, position % PAGE + count); position += count; } } Atomics.store(this.slots, this.at(slot, FILE_SIZE), truncate ? size : Math.max(old, size)); if (truncate) this.setTimestamp(slot, Date.now()); return 0; } finally { this.unlock(this.at(slot, FILE_LOCK), owner); } }
  /** Service-only: caller holds the global allocator/mutation lock. */
  reclaimLocked(handle: FileHandle): void {
    const slot = this.slot(handle);
    this.lock(this.at(slot, FILE_LOCK));
    try {
      const needed = Math.ceil(Atomics.load(this.slots, this.at(slot, FILE_SIZE)) / PAGE);
      const capacity = Atomics.load(this.slots, this.at(slot, CAPACITY));
      for (let logical = needed; logical < capacity; logical++) {
        const physical = Atomics.load(this.pages, this.pageAt(slot, logical)) - 1;
        this.segmentFor(physical).fill(0);
        Atomics.store(this.pages, this.pageAt(slot, logical), 0);
        Atomics.store(this.owners, physical, 0);
      }
      Atomics.store(this.slots, this.at(slot, CAPACITY), needed);
      Atomics.sub(this.cells, USED_PAGES, capacity - needed);
    } finally { this.unlock(this.at(slot, FILE_LOCK)); }
  }
  setMtime(handle: FileHandle, mtime: number, revoked?: () => boolean, owner = this.lockOwner): number { const slot = this.slot(handle); this.lock(this.at(slot, FILE_LOCK), revoked, owner); try { this.setTimestamp(slot, mtime); return 0; } finally { this.unlock(this.at(slot, FILE_LOCK), owner); } }
  retain(handle: FileHandle): void {
    this.section?.enter();
    try { Atomics.add(this.slots, this.at(this.slot(handle), REFS), 1); }
    finally { this.section?.exit(); }
  }
  release(handle: FileHandle): void {
    this.section?.enter();
    try { const slot = this.slot(handle); const refs = Atomics.sub(this.slots, this.at(slot, REFS), 1) - 1; if (refs === 0 && Atomics.load(this.slots, this.at(slot, UNLINKED))) this.free(slot); }
    finally { this.section?.exit(); }
  }
  unlink(handle: FileHandle): void {
    this.section?.enter();
    try { const slot = this.findSlot(handle); if (!slot) return; Atomics.store(this.slots, this.at(slot, UNLINKED), 1); if (Atomics.load(this.slots, this.at(slot, REFS)) === 0) this.free(slot); }
    finally { this.section?.exit(); }
  }
  private free(slot: number): void { this.globalLock(); try { if (!Atomics.load(this.slots, this.at(slot, UNLINKED)) || Atomics.load(this.slots, this.at(slot, REFS))) return; const count = Atomics.load(this.slots, this.at(slot, CAPACITY)); for (let logical = 0; logical < count; logical++) { const owner = Atomics.load(this.pages, this.pageAt(slot, logical)) - 1; if (owner >= 0) { Atomics.store(this.owners, owner, 0); this.segmentFor(owner).fill(0); } Atomics.store(this.pages, this.pageAt(slot, logical), 0); } Atomics.sub(this.cells, USED_PAGES, count); for (let field = 0; field < SLOT_WORDS; field++) Atomics.store(this.slots, this.at(slot, field), 0); Atomics.store(this.slots, this.at(slot, HANDLE), -1); } finally { this.globalUnlock(); } }
  ownerActive(owner: number): boolean {
    if (Atomics.load(this.cells, GLOBAL_LOCK) === owner) return true;
    for (let slot = 1; slot < MAX_FILES; slot++) if (Atomics.load(this.slots, this.at(slot, FILE_LOCK)) === owner) return true;
    return false;
  }
  revokeOwner(owner: number, epoch?: Int32Array): void {
    if (!owner || owner === SERVICE_OWNER) return;
    // Keep the global lock held while repairing its epoch: another writer must not enter
    // between releasing the dead owner and publishing the matching even epoch.
    const ownsGlobal = Atomics.compareExchange(this.cells, GLOBAL_LOCK, owner, SERVICE_OWNER) === owner;
    for (let slot = 1; slot < MAX_FILES; slot++) Atomics.compareExchange(this.slots, this.at(slot, FILE_LOCK), owner, 0);
    if (ownsGlobal) {
      if (epoch && (Atomics.load(epoch, 0) & 1)) Atomics.add(epoch, 0, 1);
      Atomics.compareExchange(this.cells, GLOBAL_LOCK, SERVICE_OWNER, 0);
    }
  }
  resources(): { bytes: number; poolBytes: number; metadataBytes: number; usedBytes: number; freeBytes: number; maxBytes: number; files: number } {
    let files = 0;
    for (let slot = 1; slot < MAX_FILES; slot++) if (Atomics.load(this.slots, this.at(slot, 0))) files++;
    const usedBytes = Atomics.load(this.cells, USED_PAGES) * PAGE;
    const poolBytes = this.segments.slice(1).reduce((bytes, buffer) => bytes + buffer.byteLength, SEGMENT_BYTES);
    const metadataBytes = this.buffer.byteLength - SEGMENT_BYTES;
    return { bytes: poolBytes + metadataBytes, poolBytes, metadataBytes, usedBytes, freeBytes: poolBytes - usedBytes, maxBytes: Atomics.load(this.cells, 4) * SEGMENT_BYTES, files };
  }
}
/** This connection's revocation word or any ancestor's. An indexed scan: Array#some with a
 * callback costs several times more in WebKit, and every direct I/O call checks it. */
export function sharedRevoked(connection: { revocations: SharedArrayBuffer[] }): () => boolean {
  const words = connection.revocations.map(buffer => new Int32Array(buffer));
  return () => {
    for (let i = 0; i < words.length; i++) if (Atomics.load(words[i]!, 0) !== 0) return true;
    return false;
  };
}
