import type { MemoryBudget } from "./memory-budget.js";
import { allocateStartupRoot } from "./root-memory-budget.js";
import { DirtyAdmission, DIRTY_HEADER_WORDS, DIRTY_NODE_UNITS } from "./dirty-admission.js";
import {
  ReaderPagePressure,
  SharedPageVersion,
  truncateBoundaryEnd,
  type RetainedSharedPage,
} from "./shared-version-pages.js";
import {
  IdentityAllocator,
  readIdentityWords,
  writeIdentityWords,
  type FileIdentity,
  type FileId,
  type FileVersion,
} from "./file-identity.js";
import { typedArraySet } from "../proc/intrinsics.js";
import {
  PublicationDomain,
  type PublicationAdmission,
  type PreparedPublication,
} from "./publication.js";
import type { PublicationBuffers, PublicationConnection } from "./publication-internal.js";
import type { FileHandle, FileStat } from "../core/index.js";
import {
  PAGE,
  FilesystemError,
  MAX_SHARED_SEGMENTS,
  DEFAULT_SHARED_MAX_BYTES,
  createSharedSegment,
  normalizeSharedMaxBytes,
  type FilesystemSection,
  type GrowableSharedSegment,
} from "./protocol.js";
export { SHARED_SEGMENT_BYTES, DEFAULT_SHARED_MAX_BYTES } from "./protocol.js";

const MAGIC = 0x42574653;
const HEADER_WORDS = 32 + DIRTY_HEADER_WORDS;
const MAX_FILES = 4096;
const SEGMENT_PAGES = 256;
const SEGMENT_BYTES = SEGMENT_PAGES * PAGE;
const MAX_SEGMENTS = MAX_SHARED_SEGMENTS;
const TOTAL_PAGES = SEGMENT_PAGES * MAX_SEGMENTS;
const MAX_FILE_PAGES = TOTAL_PAGES;
const TABLE_ENTRIES = 256;
// A partial table per file plus enough full tables to address every storage page.
const TABLE_BLOCKS = MAX_FILES + Math.ceil(TOTAL_PAGES / TABLE_ENTRIES);
export const SLOT_WORDS = 24;
const NLINK = 23;
const FILE_ID = 13;
const FILE_VERSION = 17;
const DIRTY_SIZE = 21;
const DIRTY_MARK = 22;
const PAGE_OWNER_OFFSET = HEADER_WORDS;
const SLOT_OFFSET = PAGE_OWNER_OFFSET + TOTAL_PAGES;
const PAGE_TABLE_OFFSET = SLOT_OFFSET + MAX_FILES * SLOT_WORDS;
const TABLE_OWNER_OFFSET = PAGE_TABLE_OFFSET + MAX_FILES * MAX_SEGMENTS;
const TABLE_DATA_OFFSET = TABLE_OWNER_OFFSET + TABLE_BLOCKS;
const DATA_OFFSET = (TABLE_DATA_OFFSET + TABLE_BLOCKS * TABLE_ENTRIES) * 4;
const BUFFER_SIZE = DATA_OFFSET + SEGMENT_BYTES;
const GLOBAL_LOCK = 1;
const SERVICE_OWNER = 0x7fffffff;
const USED_PAGES = 2;
const RETIRED_PAGE = -1;
// Allocator-protected floor for reincarnated handles, even when a collision moves their slot.
// Header words 5 and 6 belong to connection owner allocation and attachment probing.
const FREED_REVISION_LOW = 7;
const FREED_REVISION_HIGH = 8;
const MODE = 12;
const FILE_SIZE = 1;
const MTIME_LOW = 2;
const MTIME_HIGH = 3;
const INO = 4;
const CAPACITY = 5;
const REFS = 6;
const UNLINKED = 7;
const FILE_LOCK = 8;
const HANDLE = 9;
const REVISION = 10;
// Bit 0 is residency; the remaining bits extend the revision beyond a 32-bit counter.
const REVISION_STATE = 11;
const RESIDENT = 1;

// The intrinsic copy, so a guest iovec subclass's set() cannot reenter under a file lock. WASI
// iovecs are plain views; a subclass's overridden length/buffer/byteOffset getters still run there.
const copyBytes = Uint8Array.prototype.set;

export class MissingSegmentError extends Error {}
export class MissingDataError extends Error {}
export interface SharedFileSnapshot {
  stat: FileStat;
  data: Uint8Array;
  revision: number;
}
export interface SharedFileInfo extends FileStat {
  capacity: number;
}
export interface SharedSegment {
  buffer: SharedArrayBuffer;
  index: number;
}

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

interface PlannedIdentityRevision {
  readonly identity: FileIdentity;
  readonly allocation: IdentityAllocator;
}
/** Shared metadata and a service-grown pool of prepublished growable SAB data segments. */
export class SharedFilesystemState {
  readonly buffer: SharedArrayBuffer;
  readonly dirtyAdmission: DirtyAdmission;
  readonly identities: IdentityAllocator;
  identityGroup = false;
  readonly cells: Int32Array;
  readonly owners: Int32Array;
  readonly slots: Int32Array;
  readonly pages: Int32Array;
  private readonly pageTables: Int32Array;
  private readonly tableOwners: Int32Array;
  readonly segments: SharedArrayBuffer[];
  readonly pendingSegments: SharedSegment[] = [];
  private readonly firstBytes: Uint8Array;
  private readonly pageViews: (Uint8Array | undefined)[] = [];
  private serviceMutation = false;
  private globalOwner: number | undefined;
  private globalDepth = 0;
  private fileOwnsGlobal = new Set<number>();
  private currentOwner: number | undefined;
  readonly publication?: PublicationDomain;
  private readonly pageReaders?: Int32Array;
  onContention?: () => void;
  constructor(
    buffer?: SharedArrayBuffer,
    maxBytes = DEFAULT_SHARED_MAX_BYTES,
    readonly lockOwner = SERVICE_OWNER,
    segments: readonly SharedArrayBuffer[] = [],
    private readonly section?: FilesystemSection,
    publication?: PublicationBuffers,
    readonly startupMemoryBudget?: MemoryBudget,
  ) {
    if (buffer && startupMemoryBudget)
      throw new TypeError("an imported root cannot use startup allocation admission");
    const allocation = startupMemoryBudget
      ? allocateStartupRoot(startupMemoryBudget, BUFFER_SIZE)
      : undefined;
    this.buffer = buffer ?? allocation?.buffer ?? SharedFilesystemState.createBuffer();
    buffer = this.buffer;
    try {
      this.dirtyAdmission = new DirtyAdmission(buffer);
      if (publication) this.publication = new PublicationDomain(publication, lockOwner, section);
      if (publication?.pageReaders) this.pageReaders = new Int32Array(publication.pageReaders);
      this.cells = new Int32Array(buffer, 0, HEADER_WORDS);
      this.identities = new IdentityAllocator(new Int32Array(buffer, 16 * 4, 9));
      const initialized = Atomics.compareExchange(this.cells, 0, 0, MAGIC);
      if (initialized === 0) {
        Atomics.store(this.cells, USED_PAGES, 0);
        Atomics.store(this.cells, 4, normalizeSharedMaxBytes(maxBytes) / SEGMENT_BYTES);
      }
      while (initialized !== 0 && Atomics.load(this.cells, 0) !== MAGIC) {
        /* another connection initializes */
      }
      this.owners = new Int32Array(buffer, PAGE_OWNER_OFFSET * 4, TOTAL_PAGES);
      this.slots = new Int32Array(buffer, SLOT_OFFSET * 4, MAX_FILES * SLOT_WORDS);
      this.pageTables = new Int32Array(buffer, PAGE_TABLE_OFFSET * 4, MAX_FILES * MAX_SEGMENTS);
      this.tableOwners = new Int32Array(buffer, TABLE_OWNER_OFFSET * 4, TABLE_BLOCKS);
      this.pages = new Int32Array(buffer, TABLE_DATA_OFFSET * 4, TABLE_BLOCKS * TABLE_ENTRIES);
      this.firstBytes = new Uint8Array(buffer, DATA_OFFSET, SEGMENT_BYTES);
      this.segments = [buffer].concat(segments);
      allocation?.publish();
    } catch (error) {
      allocation?.cancel();
      throw error;
    }
  }
  retainVersionPages(handle: FileHandle, offset: number, length: number): SharedPageVersion {
    this.globalLock();
    try {
      const slot = this.slot(handle);
      this.checkFile(slot, handle);
      this.checkAccess(slot, 4);
      if (!this.pageReaders) throw new FilesystemError(58, "page retention is not enabled");
      const size = this.slots[this.at(slot, FILE_SIZE)]!;
      if (!(this.slots[this.at(slot, REVISION_STATE)]! & RESIDENT))
        throw new MissingDataError("shared filesystem file has not been loaded");
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset > Number.MAX_SAFE_INTEGER - length ||
        offset + length > size
      )
        throw new RangeError("invalid retained extent");
      let additional = 0;
      for (
        let logical = Math.floor(offset / PAGE);
        length && logical < Math.ceil((offset + length) / PAGE);
        logical++
      ) {
        if (!this.pageReaders[this.pages[this.pageAt(slot, logical)]! - 1]) additional += PAGE;
      }
      if (additional > 256 * 1024 * 1024 - this.readerPinBytes())
        throw new ReaderPagePressure("reader page capacity exhausted");
      const pages: RetainedSharedPage[] = [];
      for (
        let logical = Math.floor(offset / PAGE);
        length > 0 && logical < Math.ceil((offset + length) / PAGE);
        logical++
      ) {
        const physical = this.pages[this.pageAt(slot, logical)]! - 1;
        pages.push({ physical, bytes: this.segmentFor(physical) });
      }
      const version = new SharedPageVersion(offset, length, pages, () =>
        this.releaseVersionPages(pages),
      );
      for (const page of pages) Atomics.add(this.pageReaders, page.physical, 1);
      return version;
    } finally {
      this.globalUnlock();
    }
  }
  readerPinBytes(): number {
    if (!this.pageReaders) return 0;
    let pages = 0;
    for (const count of this.pageReaders) if (count > 0) pages++;
    return pages * PAGE;
  }
  private releaseVersionPages(pages: readonly RetainedSharedPage[]): void {
    this.globalLock(undefined, this.lockOwner, false, "release");
    try {
      for (const { physical } of pages) {
        const previous = Atomics.sub(this.pageReaders!, physical, 1);
        if (previous === 1 && this.owners[physical] === RETIRED_PAGE)
          this.detachVersionPage(physical);
      }
    } finally {
      this.globalUnlock();
    }
  }
  private detachVersionPage(physical: number): void {
    if (this.pageReaders?.[physical]) {
      this.owners[physical] = RETIRED_PAGE;
      return;
    }
    this.segmentFor(physical).fill(0);
    this.owners[physical] = 0;
    Atomics.sub(this.cells, USED_PAGES, 1);
    this.dirtyAdmission.capacityReleased();
  }
  private reserveVersionPage(slot: number): number {
    for (let physical = 0; physical < Atomics.load(this.cells, 4) * SEGMENT_PAGES; physical++) {
      if (this.owners[physical]) continue;
      this.ensureSegment(Math.floor(physical / SEGMENT_PAGES));
      this.owners[physical] = slot;
      return physical;
    }
    throw new FilesystemError(6, "retained page copy capacity exhausted");
  }
  private prepareVersionPages(
    slot: number,
    offset: number,
    end: number,
    dirtySize?: number,
  ): () => void {
    if (!this.pageReaders || offset === end) return () => {};
    let additional = 0;
    for (let logical = Math.floor(offset / PAGE); logical < Math.ceil(end / PAGE); logical++) {
      if (this.pageReaders[this.pages[this.pageAt(slot, logical)]! - 1]) additional += PAGE;
    }
    const resident = this.residentBytes() + additional;
    if (dirtySize === undefined) this.dirtyAdmission.resident(resident);
    else this.checkDirty(slot, dirtySize, resident);
    const replacements: { entry: number; previous: number; physical: number }[] = [];
    try {
      for (let logical = Math.floor(offset / PAGE); logical < Math.ceil(end / PAGE); logical++) {
        const entry = this.pageAt(slot, logical);
        const previous = this.pages[entry]! - 1;
        if (!this.pageReaders[previous]) continue;
        const physical = this.reserveVersionPage(slot);
        replacements.push({ entry, previous, physical });
        this.segmentFor(physical).set(this.segmentFor(previous));
      }
    } catch (error) {
      for (const replacement of replacements) this.owners[replacement.physical] = 0;
      throw error;
    }
    for (const { entry, previous, physical } of replacements) {
      this.pages[entry] = physical + 1;
      this.owners[previous] = RETIRED_PAGE;
    }
    Atomics.add(this.cells, USED_PAGES, replacements.length);
    return () => {
      for (const { entry, previous, physical } of replacements) {
        this.pages[entry] = previous + 1;
        this.owners[previous] = slot;
        this.detachVersionPage(physical);
      }
    };
  }
  /** Reserves growth and every COW page before publication can change any logical state. */
  prepareVersionWrite(
    handle: FileHandle,
    offset: number,
    length: number,
    size: number,
  ): { rollback(): void; commit(): void } {
    const slot = this.slot(handle);
    this.lock(this.at(slot, FILE_LOCK));
    const capacity = this.slots[this.at(slot, CAPACITY)]!;
    let undo: (() => void) | undefined;
    try {
      this.allocate(slot, Math.ceil(size / PAGE));
      undo = this.prepareVersionPages(slot, offset, offset + length);
    } catch (error) {
      this.trimCapacity(slot, capacity);
      throw error;
    } finally {
      this.unlock(this.at(slot, FILE_LOCK));
    }
    let active = true;
    return {
      commit: () => {
        active = false;
      },
      rollback: () => {
        if (!active) return;
        active = false;
        undo();
        this.trimCapacity(slot, capacity);
      },
    };
  }
  private trimCapacity(slot: number, needed: number): void {
    const capacity = this.slots[this.at(slot, CAPACITY)]!;
    for (let logical = needed; logical < capacity; logical++) {
      const entry = this.pageAt(slot, logical);
      this.detachVersionPage(this.pages[entry]! - 1);
      this.pages[entry] = 0;
    }
    this.slots[this.at(slot, CAPACITY)] = needed;
    this.trimPageTables(slot, needed);
  }
  static createBuffer(memoryBudget?: MemoryBudget): SharedArrayBuffer {
    if (!memoryBudget) return new SharedArrayBuffer(BUFFER_SIZE);
    const allocation = allocateStartupRoot(memoryBudget, BUFFER_SIZE);
    try {
      allocation.publish();
      return allocation.buffer;
    } catch (error) {
      allocation.cancel();
      throw error;
    }
  }

  addSegment(buffer: SharedArrayBuffer, index = this.segments.length): void {
    if (
      buffer.byteLength < SEGMENT_BYTES ||
      !Number.isInteger(index) ||
      index < 1 ||
      index >= Atomics.load(this.cells, 4)
    )
      throw new RangeError("invalid shared filesystem segment");
    // An indexed announcement may arrive after a prepublished wrapper has already grown.
    // Keep the original wrapper so queued delivery cannot replace a live segment.
    this.segments[index] ??= buffer;
  }
  takeNewSegments(): SharedSegment[] {
    const out = this.pendingSegments.slice();
    this.pendingSegments.length = 0;
    return out;
  }
  private segmentFor(page: number): Uint8Array {
    const cached = this.pageViews[page];
    if (cached) return cached;
    const segment = Math.floor(page / SEGMENT_PAGES);
    const local = page % SEGMENT_PAGES;
    const buffer = this.segments[segment];
    if (!buffer)
      throw new MissingSegmentError("shared filesystem segment has not reached this guest");
    // Fixed page views remain valid when a growable segment grows. Physical pages may be
    // recycled between files, but their backing buffer and byte offset never change.
    const bytes =
      segment === 0
        ? this.firstBytes.subarray(local * PAGE, (local + 1) * PAGE)
        : new Uint8Array(buffer, local * PAGE, PAGE);
    this.pageViews[page] = bytes;
    return bytes;
  }
  private findSlot(handle: FileHandle, create = false): number {
    if (!Number.isInteger(handle) || handle < 0 || handle >= 0x7ffffffe) return 0;
    const start = handle % (MAX_FILES - 1);
    let available = 0;
    for (let probe = 0; probe < MAX_FILES - 1; probe++) {
      const slot = ((start + probe) % (MAX_FILES - 1)) + 1;
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
  private at(slot: number, field: number): number {
    return slot * SLOT_WORDS + field;
  }
  private pageAt(slot: number, logical: number): number {
    const block =
      Atomics.load(this.pageTables, slot * MAX_SEGMENTS + Math.floor(logical / TABLE_ENTRIES)) - 1;
    return block * TABLE_ENTRIES + (logical % TABLE_ENTRIES);
  }
  private reservePageTables(slot: number, needed: number): void {
    for (let table = 0; table < Math.ceil(needed / TABLE_ENTRIES); table++) {
      const index = slot * MAX_SEGMENTS + table;
      if (Atomics.load(this.pageTables, index)) continue;
      const block = this.tableOwners.indexOf(0);
      if (block < 0) throw new FilesystemError(51, "shared filesystem page tables exhausted");
      Atomics.store(this.tableOwners, block, slot);
      Atomics.store(this.pageTables, index, block + 1);
    }
  }
  private trimPageTables(slot: number, needed: number): void {
    for (let table = Math.ceil(needed / TABLE_ENTRIES); table < MAX_SEGMENTS; table++) {
      const block = Atomics.exchange(this.pageTables, slot * MAX_SEGMENTS + table, 0) - 1;
      if (block < 0) continue;
      this.pages.fill(0, block * TABLE_ENTRIES, (block + 1) * TABLE_ENTRIES);
      Atomics.store(this.tableOwners, block, 0);
    }
  }
  /** The slot of a registered regular file, or 0. A live handle keeps its slot until it is freed. */
  fileSlot(handle: FileHandle): number {
    const slot = this.findSlot(handle);
    return slot !== 0 && Atomics.load(this.slots, this.at(slot, 0)) === 1 ? slot : 0;
  }
  hasFile(handle: FileHandle): boolean {
    const slot = this.findSlot(handle);
    return slot !== 0 && Atomics.load(this.slots, this.at(slot, 0)) === 1;
  }
  isUnlinked(handle: FileHandle): boolean {
    const slot = this.findSlot(handle);
    return slot !== 0 && Atomics.load(this.slots, this.at(slot, UNLINKED)) !== 0;
  }
  /** Spin for a held lock. Only a contended caller checks revocation here; every acquirer
   * checks it once after its locks are held, so a revoked guest never proceeds under a lock. */
  private contend(
    cells: Int32Array,
    index: number,
    revoked: (() => boolean) | undefined,
    owner: number,
  ): void {
    for (;;) {
      if (revoked?.()) throw new FilesystemError(11);
      this.publication?.assertLive();
      this.onContention?.();
      if (Atomics.compareExchange(cells, index, 0, owner) === 0) return;
    }
  }
  private assertLockAccess(access: "data" | "activation" | "release"): void {
    if (access === "release") return;
    if (access === "activation") this.publication?.assertLive();
    else this.publication?.assertAccess();
  }
  private lock(
    index: number,
    revoked?: () => boolean,
    owner = this.lockOwner,
    access: "data" | "release" = "data",
  ): void {
    const global =
      (this.dirtyAdmission.enabled || !!this.publication || this.identities.active) &&
      this.globalOwner === undefined;
    if (global) this.globalLock(revoked, owner, false, access);
    else this.assertLockAccess(access);
    this.section?.enter();
    let held = false;
    try {
      if (Atomics.compareExchange(this.slots, index, 0, owner) !== 0)
        this.contend(this.slots, index, revoked, owner);
      held = true;
      if (revoked?.()) throw new FilesystemError(11);
      if (global) this.fileOwnsGlobal.add(index);
    } catch (error) {
      if (held) Atomics.compareExchange(this.slots, index, owner, 0);
      this.section?.exit();
      if (global) this.globalUnlock(owner);
      throw error;
    }
  }
  private unlock(index: number, owner = this.lockOwner): void {
    Atomics.compareExchange(this.slots, index, owner, 0);
    this.section?.exit();
    if (!this.fileOwnsGlobal.delete(index)) return;
    this.globalUnlock(owner);
  }
  private globalLock(
    revoked?: () => boolean,
    owner = this.lockOwner,
    nonblocking = false,
    access: "data" | "activation" | "release" = "data",
    revocation: "global" | "file" = "global",
  ): void {
    if (this.globalOwner === owner) {
      this.assertLockAccess(access);
      this.globalDepth++;
      return;
    }
    if (this.serviceMutation && owner === SERVICE_OWNER) {
      this.assertLockAccess(access);
      return;
    }
    this.section?.enter();
    let held = false;
    try {
      held = Atomics.compareExchange(this.cells, GLOBAL_LOCK, 0, owner) === 0;
      if (!held && nonblocking) throw new FilesystemError(6);
      if (!held) this.contend(this.cells, GLOBAL_LOCK, revoked, owner);
      held = true;
      if (revocation === "global" && revoked?.()) throw new FilesystemError(11);
      this.assertLockAccess(access);
      this.globalOwner = owner;
    } catch (error) {
      if (held) Atomics.compareExchange(this.cells, GLOBAL_LOCK, owner, 0);
      this.section?.exit();
      throw error;
    }
  }
  private globalUnlock(owner = this.lockOwner): void {
    if (this.globalDepth > 0) {
      this.globalDepth--;
      return;
    }
    if (this.serviceMutation) return;
    this.globalOwner = undefined;
    Atomics.compareExchange(this.cells, GLOBAL_LOCK, owner, 0);
    this.section?.exit();
  }
  activateResidentAuthority(): void {
    this.globalLock(undefined, this.lockOwner, false, "activation");
    try {
      this.publication!.activateResident();
    } finally {
      this.globalUnlock();
    }
  }
  beginServiceMutation(epoch: Int32Array, residentGrant = 0): void {
    this.globalLock();
    try {
      this.publication?.assertCurrent(residentGrant);
    } catch (error) {
      this.globalUnlock();
      throw error;
    }
    this.serviceMutation = true;
    Atomics.add(epoch, 0, 1);
  }
  endServiceMutation(epoch: Int32Array): void {
    Atomics.add(epoch, 0, 1);
    this.serviceMutation = false;
    this.globalUnlock();
  }
  get ownsServiceMutation(): boolean {
    return this.serviceMutation;
  }
  mutate<T>(
    epoch: Int32Array | undefined,
    revoked: (() => boolean) | undefined,
    fn: () => T,
    owner = this.lockOwner,
  ): T {
    this.globalLock(revoked, owner);
    if (epoch) Atomics.add(epoch, 0, 1);
    const previous = this.currentOwner;
    this.currentOwner = owner;
    try {
      this.publication?.assertCurrent();
      return fn();
    } finally {
      this.currentOwner = previous;
      if (epoch) Atomics.add(epoch, 0, 1);
      this.globalUnlock(owner);
    }
  }
  private setTimestamp(slot: number, mtime: number): void {
    Atomics.store(this.slots, this.at(slot, MTIME_LOW), mtime >>> 0);
    Atomics.store(this.slots, this.at(slot, MTIME_HIGH), Math.floor(mtime / 0x100000000) >>> 0);
  }
  private getMtime(slot: number): number {
    return (
      (Atomics.load(this.slots, this.at(slot, MTIME_HIGH)) >>> 0) * 0x100000000 +
      (Atomics.load(this.slots, this.at(slot, MTIME_LOW)) >>> 0)
    );
  }
  /** Revision reads and increments are covered by the file lock, including the carry. */
  private getRevision(slot: number): number {
    const base = slot * SLOT_WORDS;
    return (
      (this.slots[base + REVISION_STATE]! >>> 1) * 0x100000000 +
      (this.slots[base + REVISION]! >>> 0)
    );
  }
  private changed(slot: number): void {
    const base = slot * SLOT_WORDS,
      low = this.slots[base + REVISION]!;
    this.slots[base + REVISION] = low + 1;
    if (low === -1) this.slots[base + REVISION_STATE] = this.slots[base + REVISION_STATE]! + 2;
  }
  private residentBytes(): number {
    return Atomics.load(this.cells, USED_PAGES) * PAGE;
  }
  private checkDirty(slot: number, size: number, resident = this.residentBytes()): void {
    this.dirtyAdmission.checkFile(
      resident,
      this.slots[this.at(slot, DIRTY_SIZE)]!,
      size,
      this.slots[this.at(slot, DIRTY_MARK)] !== 1,
    );
  }
  private dirty(slot: number, size = this.slots[this.at(slot, FILE_SIZE)]!): void {
    if (!this.dirtyAdmission.enabled) return;
    const previous = this.slots[this.at(slot, DIRTY_SIZE)]!;
    this.dirtyAdmission.file(
      this.residentBytes(),
      previous,
      size,
      this.slots[this.at(slot, DIRTY_MARK)] !== 1,
    );
    this.slots[this.at(slot, DIRTY_SIZE)] = Math.max(previous, size);
    this.slots[this.at(slot, DIRTY_MARK)] = 1;
  }
  checkDirtyGrowth(handle: FileHandle, size: number): void {
    this.checkDirty(this.slot(handle), size);
  }
  prepareDirtyMutation(files: ReadonlyMap<FileHandle, number>, namespace: number): void {
    let bytes = 0,
      metadata = 0;
    for (const [handle, size] of files) {
      const slot = this.slot(handle);
      this.checkDirty(slot, size);
      bytes += Math.max(0, size - this.slots[this.at(slot, DIRTY_SIZE)]!) * 2;
      if (this.slots[this.at(slot, DIRTY_MARK)] !== 1) metadata += DIRTY_NODE_UNITS;
    }
    this.dirtyAdmission.mutation(this.residentBytes(), namespace, bytes, metadata);
    for (const [handle, size] of files) {
      const slot = this.slot(handle);
      this.slots[this.at(slot, DIRTY_SIZE)] = Math.max(
        size,
        this.slots[this.at(slot, DIRTY_SIZE)]!,
      );
      this.slots[this.at(slot, DIRTY_MARK)] = 1;
    }
  }
  cleanDirty(revision: number, namespace: number): void {
    if (!this.dirtyAdmission.clean(revision, namespace)) return;
    for (let slot = 1; slot < MAX_FILES; slot++) {
      this.slots[this.at(slot, DIRTY_SIZE)] = 0;
      this.slots[this.at(slot, DIRTY_MARK)] = 0;
    }
  }
  private checkFile(slot: number, handle: FileHandle): void {
    if (this.slots[this.at(slot, HANDLE)] !== handle + 1) throw new FilesystemError(8);
    if (this.slots[this.at(slot, 0)] !== 1) throw new FilesystemError(31);
  }
  private ensureSegment(segment: number): void {
    if (segment >= Atomics.load(this.cells, 4))
      throw new FilesystemError(51, "shared filesystem storage exhausted");
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
    const target = this.dirtyAdmission.enabled
      ? needed
      : Math.max(needed, Math.min(MAX_FILE_PAGES, Math.max(1, current * 2)));
    this.dirtyAdmission.resident(this.residentBytes() + (target - current) * PAGE);
    const allocated: number[] = [];
    const rollback = () => {
      for (const physical of allocated) {
        this.segmentFor(physical).fill(0);
        Atomics.store(this.owners, physical, 0);
      }
      allocated.length = 0;
      this.trimPageTables(slot, current);
    };
    const take = (count: number) => {
      for (
        let physical = 0;
        physical < Atomics.load(this.cells, 4) * SEGMENT_PAGES && allocated.length < count;
        physical++
      ) {
        this.ensureSegment(Math.floor(physical / SEGMENT_PAGES));
        if (Atomics.compareExchange(this.owners, physical, 0, slot) === 0) allocated.push(physical);
      }
    };
    try {
      take(target - current);
      if (allocated.length !== target - current && target !== needed) {
        rollback();
        take(needed - current);
      }
      if (allocated.length !== needed - current && allocated.length !== target - current)
        throw new FilesystemError(51, "shared filesystem storage exhausted");
      // Finish potentially throwing initialization before publishing any page-table entries.
      for (const physical of allocated) this.segmentFor(physical).fill(0);
      this.reservePageTables(slot, current + allocated.length);
      for (let i = 0; i < allocated.length; i++)
        Atomics.store(this.pages, this.pageAt(slot, current + i), allocated[i]! + 1);
      Atomics.store(this.slots, this.at(slot, CAPACITY), current + allocated.length);
      Atomics.add(this.cells, USED_PAGES, allocated.length);
      this.trimPageTables(slot, current + allocated.length);
    } catch (error) {
      rollback();
      if (error instanceof RangeError)
        throw new FilesystemError(51, "shared filesystem segment allocation failed");
      throw error;
    }
  }
  private refreshRegistered(slot: number, stat: FileStat): boolean {
    if (!this.slots[this.at(slot, 0)] || this.slots[this.at(slot, INO)] !== stat.ino) return false;
    Atomics.store(this.slots, this.at(slot, NLINK), stat.nlink);
    if (this.slots[this.at(slot, MODE)] !== (stat.mode ?? -1)) {
      this.slots[this.at(slot, MODE)] = stat.mode ?? -1;
      this.changed(slot);
    }
    if (stat.kind === "directory" && this.getMtime(slot) !== stat.mtime) {
      this.setTimestamp(slot, stat.mtime);
      this.changed(slot);
    }
    return true;
  }
  register(
    handle: FileHandle,
    stat: FileStat,
    data?: Uint8Array,
    resident = true,
    identity?: FileIdentity,
  ): void {
    this.globalLock();
    try {
      const slot = this.findSlot(handle, true);
      if (!slot) throw new FilesystemError(51, "shared filesystem identity table exhausted");
      this.lock(this.at(slot, FILE_LOCK));
      let pinned = false;
      try {
        if (this.refreshRegistered(slot, stat)) return;
        this.dirtyAdmission.pin(1, this.residentBytes());
        pinned = true;
        const loaded = resident || stat.size === 0;
        if (stat.kind === "file" && loaded) {
          this.allocate(slot, Math.ceil(Math.max(data?.length ?? 0, stat.size) / PAGE));
          if (data?.length) this.copyInto(slot, data, 0);
        }
        Atomics.store(
          this.slots,
          this.at(slot, 0),
          stat.kind === "file" ? 1 : stat.kind === "symlink" ? 3 : 2,
        );
        Atomics.store(this.slots, this.at(slot, FILE_SIZE), stat.size);
        Atomics.store(this.slots, this.at(slot, INO), stat.ino);
        Atomics.store(this.slots, this.at(slot, NLINK), stat.nlink);
        this.setTimestamp(slot, stat.mtime);
        Atomics.store(this.slots, this.at(slot, MODE), stat.mode ?? -1);
        const floor =
          (this.cells[FREED_REVISION_HIGH]! >>> 0) * 0x100000000 +
          (this.cells[FREED_REVISION_LOW]! >>> 0);
        const revision = Math.max(this.getRevision(slot), floor) + 1;
        this.slots[this.at(slot, REVISION)] = revision >>> 0;
        this.slots[this.at(slot, REVISION_STATE)] =
          Math.floor(revision / 0x100000000) * 2 + (loaded ? RESIDENT : 0);
        if (identity) this.installIdentity(slot, identity);
        Atomics.store(this.slots, this.at(slot, HANDLE), handle + 1);
      } catch (error) {
        if (pinned) this.dirtyAdmission.pin(-1, this.residentBytes());
        throw error;
      } finally {
        this.unlock(this.at(slot, FILE_LOCK));
      }
    } finally {
      this.globalUnlock();
    }
  }
  identity(handle: FileHandle): FileIdentity | undefined {
    this.globalLock(undefined, this.lockOwner, true);
    try {
      const slot = this.findSlot(handle);
      if (!slot) return undefined;
      const id = readIdentityWords(this.slots, this.at(slot, FILE_ID));
      if (id === 0n) return undefined;
      return {
        id: id as FileId,
        version: readIdentityWords(this.slots, this.at(slot, FILE_VERSION)) as FileVersion,
      };
    } finally {
      this.globalUnlock();
    }
  }
  updateIdentity(handle: FileHandle, identity: FileIdentity): void {
    const slot = this.findSlot(handle);
    if (slot) this.installIdentity(slot, identity);
  }
  private installIdentity(slot: number, identity: FileIdentity): void {
    writeIdentityWords(this.slots, this.at(slot, FILE_ID), identity.id);
    writeIdentityWords(this.slots, this.at(slot, FILE_VERSION), identity.version);
  }
  private prepareIdentityVersion(
    slot: number,
    changed: boolean,
  ): PlannedIdentityRevision | undefined {
    if (!changed || this.identityGroup || !this.identities.active) return undefined;
    const id = readIdentityWords(this.slots, this.at(slot, FILE_ID));
    if (id === 0n) throw new FilesystemError(29, "missing shared file identity");
    const allocation = this.identities.stage();
    return { allocation, identity: { id: id as FileId, version: allocation.versions(1)[0]! } };
  }
  private commitIdentityVersion(slot: number, revision: PlannedIdentityRevision | undefined): void {
    if (!revision) return;
    this.identities.copyFrom(revision.allocation);
    this.installIdentity(slot, revision.identity);
  }
  private publicationFile(slot: number, revision: PlannedIdentityRevision | undefined) {
    const id = readIdentityWords(this.slots, this.at(slot, FILE_ID));
    if (id === 0n) throw new FilesystemError(29, "missing shared file identity");
    return {
      birthHistory: this.publication!.buffers.history,
      ino: this.slots[this.at(slot, INO)]!,
      id: id as FileId,
      version:
        revision?.identity.version ??
        (readIdentityWords(this.slots, this.at(slot, FILE_VERSION)) as FileVersion),
    };
  }
  /** Install persisted bytes without changing the file's metadata or dirty revision. */
  hydrate(handle: FileHandle, data: Uint8Array): void {
    this.globalLock();
    try {
      const slot = this.slot(handle);
      this.lock(this.at(slot, FILE_LOCK));
      try {
        this.checkFile(slot, handle);
        if (this.slots[this.at(slot, REVISION_STATE)]! & RESIDENT) return;
        if (data.length !== this.slots[this.at(slot, FILE_SIZE)])
          throw new RangeError("persisted file size does not match shared metadata");
        this.allocate(slot, Math.ceil(data.length / PAGE));
        this.copyInto(slot, data, 0);
        this.slots[this.at(slot, REVISION_STATE)]! |= RESIDENT;
      } finally {
        this.unlock(this.at(slot, FILE_LOCK));
      }
    } finally {
      this.globalUnlock();
    }
  }
  isResident(handle: FileHandle): boolean {
    const slot = this.findSlot(handle);
    if (!slot) return false;
    this.lock(this.at(slot, FILE_LOCK));
    try {
      return (
        this.slots[this.at(slot, HANDLE)] === handle + 1 &&
        this.slots[this.at(slot, 0)] === 1 &&
        (this.slots[this.at(slot, REVISION_STATE)]! & RESIDENT) !== 0
      );
    } finally {
      this.unlock(this.at(slot, FILE_LOCK));
    }
  }
  /** Bounded by the resident identity table, not the size of the persisted namespace. */
  registeredHandles(): FileHandle[] {
    const handles: FileHandle[] = [];
    for (let slot = 1; slot < MAX_FILES; slot++) {
      const handle = Atomics.load(this.slots, this.at(slot, HANDLE)) - 1;
      if (handle >= 0) handles.push(handle);
    }
    return handles;
  }
  revision(
    handle: FileHandle,
    nonblocking = false,
    revoked?: () => boolean,
    owner = this.lockOwner,
  ): number | undefined {
    return this.current(nonblocking, revoked, owner, () =>
      this.revisionLocked(handle, nonblocking, revoked, owner),
    );
  }
  private revisionLocked(
    handle: FileHandle,
    nonblocking: boolean,
    revoked: (() => boolean) | undefined,
    owner: number,
  ): number | undefined {
    const slot = this.findSlot(handle);
    if (!slot) return undefined;
    const lock = this.at(slot, FILE_LOCK);
    this.section?.enter();
    try {
      if (Atomics.compareExchange(this.slots, lock, 0, owner) !== 0) {
        if (nonblocking) throw new FilesystemError(6);
        this.contend(this.slots, lock, revoked, owner);
      }
    } catch (error) {
      this.section?.exit();
      throw error;
    }
    try {
      if (revoked?.()) throw new FilesystemError(11);
      return this.slots[this.at(slot, HANDLE)] === handle + 1 && this.slots[this.at(slot, 0)]
        ? this.getRevision(slot)
        : undefined;
    } finally {
      this.unlock(this.at(slot, FILE_LOCK), owner);
    }
  }
  /** One file lock covers the bytes, stat and revision; the returned bytes are an owned copy. */
  snapshot(handle: FileHandle): SharedFileSnapshot | undefined {
    const slot = this.findSlot(handle);
    if (!slot) return undefined;
    this.lock(this.at(slot, FILE_LOCK));
    try {
      const base = slot * SLOT_WORDS;
      if (
        this.slots[base + HANDLE] !== handle + 1 ||
        this.slots[base] !== 1 ||
        !(this.slots[base + REVISION_STATE]! & RESIDENT)
      )
        return undefined;
      const stat: FileStat = {
        kind: "file",
        ino: this.slots[base + INO]!,
        nlink: this.slots[base + NLINK]! >>> 0,
        size: this.slots[base + FILE_SIZE]!,
        mtime: this.getMtime(slot),
        ...this.modeField(slot),
      };
      const data = new Uint8Array(stat.size);
      for (let position = 0; position < data.length; position += PAGE) {
        const count = Math.min(PAGE, data.length - position);
        const page = this.segmentFor(this.pages[this.pageAt(slot, position / PAGE)]! - 1);
        data.set(count === PAGE ? page : page.subarray(0, count), position);
      }
      return { stat, data, revision: this.getRevision(slot) };
    } finally {
      this.unlock(this.at(slot, FILE_LOCK));
    }
  }
  /** Eviction may discard a linked file only after its exact revision has been persisted.
   * Service-owned references include transient client cache entries, not just open descriptors. */
  evict(handle: FileHandle, revision: number): boolean {
    this.globalLock();
    try {
      const slot = this.findSlot(handle);
      if (!slot) return false;
      this.lock(this.at(slot, FILE_LOCK));
      try {
        if (
          this.slots[this.at(slot, HANDLE)] !== handle + 1 ||
          !this.slots[this.at(slot, 0)] ||
          this.slots[this.at(slot, REFS)] !== 0 ||
          this.getRevision(slot) !== revision
        )
          return false;
        this.freeLocked(slot);
        return true;
      } finally {
        this.unlock(this.at(slot, FILE_LOCK));
      }
    } finally {
      this.globalUnlock();
    }
  }
  /** Drop a persisted payload without revoking open or transient cached identities. */
  unload(handle: FileHandle, revision: number): boolean {
    this.globalLock();
    try {
      const slot = this.findSlot(handle);
      if (!slot) return false;
      this.lock(this.at(slot, FILE_LOCK));
      try {
        if (
          this.slots[this.at(slot, HANDLE)] !== handle + 1 ||
          this.slots[this.at(slot, 0)] !== 1 ||
          this.getRevision(slot) !== revision
        )
          return false;
        this.freePagesLocked(slot);
        if (this.slots[this.at(slot, FILE_SIZE)])
          this.slots[this.at(slot, REVISION_STATE)]! &= ~RESIDENT;
        return true;
      } finally {
        this.unlock(this.at(slot, FILE_LOCK));
      }
    } finally {
      this.globalUnlock();
    }
  }
  info(
    handle: FileHandle,
    revoked?: () => boolean,
    owner = this.lockOwner,
  ): SharedFileInfo | undefined {
    return this.current(false, revoked, owner, () => this.infoLocked(handle, revoked, owner));
  }
  private infoLocked(
    handle: FileHandle,
    revoked?: () => boolean,
    owner = this.lockOwner,
  ): SharedFileInfo | undefined {
    const slot = this.findSlot(handle);
    if (!slot) return undefined;
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      if (
        Atomics.load(this.slots, this.at(slot, HANDLE)) !== handle + 1 ||
        Atomics.load(this.slots, this.at(slot, 0)) !== 1
      )
        return undefined;
      return {
        kind: "file",
        ino: Atomics.load(this.slots, this.at(slot, INO)),
        nlink: Atomics.load(this.slots, this.at(slot, NLINK)) >>> 0,
        size: Atomics.load(this.slots, this.at(slot, FILE_SIZE)),
        mtime: this.getMtime(slot),
        ...this.modeField(slot),
        capacity: Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE,
      };
    } finally {
      this.unlock(this.at(slot, FILE_LOCK), owner);
    }
  }
  stat(handle: FileHandle, revoked?: () => boolean, owner = this.lockOwner): FileStat | undefined {
    return this.current(false, revoked, owner, () => this.statLocked(handle, revoked, owner));
  }
  private statLocked(
    handle: FileHandle,
    revoked?: () => boolean,
    owner = this.lockOwner,
  ): FileStat | undefined {
    const slot = this.findSlot(handle);
    if (!slot) return undefined;
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      const kind = Atomics.load(this.slots, this.at(slot, 0));
      if (!kind || Atomics.load(this.slots, this.at(slot, HANDLE)) !== handle + 1) return undefined;
      return {
        kind: kind === 1 ? "file" : kind === 3 ? "symlink" : "directory",
        ino: Atomics.load(this.slots, this.at(slot, INO)),
        nlink: Atomics.load(this.slots, this.at(slot, NLINK)) >>> 0,
        size: kind !== 2 ? Atomics.load(this.slots, this.at(slot, FILE_SIZE)) : 0,
        mtime: this.getMtime(slot),
        ...this.modeField(slot),
      };
    } finally {
      this.unlock(this.at(slot, FILE_LOCK), owner);
    }
  }
  setNlink(handle: FileHandle, nlink: number): void {
    const slot = this.findSlot(handle);
    if (!slot) return;
    this.lock(this.at(slot, FILE_LOCK));
    try {
      if (this.slots[this.at(slot, HANDLE)] === handle + 1)
        Atomics.store(this.slots, this.at(slot, NLINK), nlink);
    } finally {
      this.unlock(this.at(slot, FILE_LOCK));
    }
  }
  private modeField(slot: number): Pick<FileStat, "mode"> {
    const mode = Atomics.load(this.slots, this.at(slot, MODE));
    return mode < 0 ? {} : { mode };
  }
  private checkAccess(slot: number, access: number): void {
    const mode = this.slots[this.at(slot, MODE)]!;
    if (mode >= 0 && ((mode >>> 6) & access) !== access) throw new FilesystemError(2);
  }
  setMode(handle: FileHandle, mode: number): void {
    const slot = this.slot(handle);
    this.lock(this.at(slot, FILE_LOCK));
    try {
      if (this.slots[this.at(slot, HANDLE)] !== handle + 1) throw new FilesystemError(8);
      const changed = this.slots[this.at(slot, MODE)] !== mode;
      const version = this.prepareIdentityVersion(slot, changed);
      if (!changed) return;
      this.dirty(slot);
      this.slots[this.at(slot, MODE)] = mode;
      this.changed(slot);
      this.commitIdentityVersion(slot, version);
    } finally {
      this.unlock(this.at(slot, FILE_LOCK));
    }
  }
  private copyInto(slot: number, source: Uint8Array, offset: number): void {
    let at = offset;
    for (let sourceAt = 0; sourceAt < source.length;) {
      const logical = Math.floor(at / PAGE);
      const page = Atomics.load(this.pages, this.pageAt(slot, logical)) - 1;
      const inPage = at % PAGE;
      const count = Math.min(source.length - sourceAt, PAGE - inPage);
      this.segmentFor(page).set(source.subarray(sourceAt, sourceAt + count), inPage);
      at += count;
      sourceAt += count;
    }
  }
  read(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    revoked?: () => boolean,
    owner = this.lockOwner,
  ): number {
    const slot = this.slot(handle);
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      this.checkFile(slot, handle);
      this.checkAccess(slot, 4);
      if (!(this.slots[this.at(slot, REVISION_STATE)]! & RESIDENT))
        throw new MissingDataError("shared filesystem file has not been loaded");
      const size = Atomics.load(this.slots, this.at(slot, FILE_SIZE));
      let total = 0;
      for (const chunk of chunks) {
        let at = 0;
        while (at < chunk.length && offset + total < size) {
          const position = offset + total;
          const page = Atomics.load(this.pages, this.pageAt(slot, Math.floor(position / PAGE))) - 1;
          const inPage = position % PAGE;
          const count = Math.min(chunk.length - at, size - position, PAGE - inPage);
          chunk.set(this.segmentFor(page).subarray(inPage, inPage + count), at);
          at += count;
          total += count;
        }
        if (at < chunk.length) break;
      }
      return total;
    } finally {
      this.unlock(this.at(slot, FILE_LOCK), owner);
    }
  }
  /* Direct client paths. A live file's size, timestamp and page entries below its size change only
   * under its file lock; capacity and the page entries above it change only under the global lock.
   * Each direct path holds the lock covering every field it touches, so it uses plain Int32 reads
   * and writes (aligned, never torn) ordered by the lock's acquiring and releasing atomics. Lock
   * words, the epoch and revocation stay atomic. */
  /** Client read of an open file from its cached slot: one file lock, one revocation check after
   * locking, then a coherent copy straight into the guest iovecs. Every size change holds the
   * same lock, so the copy is the file's content at one instant. */
  current<T>(
    nonblocking: boolean,
    revoked: (() => boolean) | undefined,
    owner: number,
    read: () => T,
  ): T {
    if (!this.publication) return read();
    if ((this.serviceMutation && owner === SERVICE_OWNER) || this.currentOwner === owner) {
      this.publication?.assertLive();
      this.publication?.assertAccess();
      return read();
    }
    this.globalLock(revoked, owner, nonblocking);
    try {
      this.publication?.assertCurrent();
      return read();
    } finally {
      this.globalUnlock(owner);
    }
  }

  directRead(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    revoked: () => boolean,
    owner: number,
    nonblocking = false,
  ): number {
    return this.current(nonblocking, revoked, owner, () =>
      this.directReadLocked(slot, handle, chunks, offset, revoked, owner, nonblocking),
    );
  }
  private directReadLocked(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    revoked: () => boolean,
    owner: number,
    nonblocking = false,
  ): number {
    const slots = this.slots,
      base = slot * SLOT_WORDS,
      lock = base + FILE_LOCK;
    this.section?.enter();
    try {
      if (Atomics.compareExchange(slots, lock, 0, owner) !== 0) {
        if (nonblocking) throw new FilesystemError(6);
        this.contend(slots, lock, revoked, owner);
      }
    } catch (error) {
      this.section?.exit();
      throw error;
    }
    try {
      if (revoked()) throw new FilesystemError(11);
      if (slots[base + HANDLE] !== handle + 1) throw new FilesystemError(8);
      this.checkAccess(slot, 4);
      if (!(slots[base + REVISION_STATE]! & RESIDENT))
        throw new MissingDataError("shared filesystem file has not been loaded");
      const size = slots[base + FILE_SIZE]!,
        pages = this.pages;
      let position = offset;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!,
          length = chunk.length;
        let at = 0;
        while (at < length && position < size) {
          const inPage = position % PAGE;
          const count = Math.min(length - at, size - position, PAGE - inPage);
          const page = this.segmentFor(pages[this.pageAt(slot, (position - inPage) / PAGE)]! - 1);
          copyBytes.call(chunk, count === PAGE ? page : page.subarray(inPage, inPage + count), at);
          at += count;
          position += count;
        }
        if (at < length) break;
      }
      return position - offset;
    } finally {
      Atomics.compareExchange(slots, lock, owner, 0);
      this.section?.exit();
    }
  }
  private readyGlobal(revoked: () => boolean, owner: number): boolean {
    try {
      this.globalLock(revoked, owner, true);
      return true;
    } catch (error) {
      if (error instanceof FilesystemError && error.errno === 6) return false;
      throw error;
    }
  }
  /** Probe without spinning or changing file data. True means ready, false means lock contention,
   * and undefined requests hydration. The same locks gate a successful retry. */
  directReadiness(
    slot: number,
    handle: FileHandle,
    writing: boolean,
    revoked: () => boolean,
    owner: number,
  ): boolean | undefined {
    this.section?.enter();
    const lock = slot * SLOT_WORDS + FILE_LOCK;
    let global = false,
      file = false;
    try {
      if (revoked()) throw new FilesystemError(11);
      if (writing || this.publication) {
        global = this.readyGlobal(revoked, owner);
        if (!global) return false;
      }
      file = Atomics.compareExchange(this.slots, lock, 0, owner) === 0;
      if (!file) return false;
      if (this.slots[slot * SLOT_WORDS + HANDLE] !== handle + 1) throw new FilesystemError(8);
      return this.slots[slot * SLOT_WORDS + REVISION_STATE]! & RESIDENT ? true : undefined;
    } finally {
      if (file) Atomics.compareExchange(this.slots, lock, owner, 0);
      if (global) this.globalUnlock(owner);
      this.section?.exit();
    }
  }
  private copyChunks(slot: number, chunks: readonly Uint8Array[], offset: number): void {
    const pages = this.pages;
    let position = offset;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!,
        length = chunk.length;
      for (let at = 0; at < length;) {
        const inPage = position % PAGE;
        const count = Math.min(length - at, PAGE - inPage);
        const page = this.segmentFor(pages[this.pageAt(slot, (position - inPage) / PAGE)]! - 1);
        // A fixed-length source view never changes length; build sub-views without species lookup.
        page.set(
          count === length ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset + at, count),
          inPage,
        );
        at += count;
        position += count;
      }
    }
  }
  /** Client in-capacity write at offset, or append at EOF, under one global mutation (odd epoch)
   * and one file lock, with one revocation check once both are held. Returns the end offset, or
   * the negated size the service must grow to after both locks exit. Sources must be fixed-length
   * views; callers reject negative offsets. */
  private direct(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    append: boolean,
    offset: number,
    total: number,
    epoch: Int32Array,
    revoked: () => boolean,
    owner: number,
    nonblocking = false,
    admission?: PublicationAdmission,
  ): number {
    const slots = this.slots,
      base = slot * SLOT_WORDS,
      lock = base + FILE_LOCK;
    this.globalLock(revoked, owner, nonblocking, "data", "file");
    Atomics.add(epoch, 0, 1);
    try {
      if (Atomics.compareExchange(slots, lock, 0, owner) !== 0) {
        if (nonblocking) throw new FilesystemError(6);
        this.contend(slots, lock, revoked, owner);
      }
      try {
        if (revoked()) throw new FilesystemError(11);
        if (slots[base + HANDLE] !== handle + 1) throw new FilesystemError(8);
        this.checkAccess(slot, 2);
        const size = slots[base + FILE_SIZE]!;
        const at = append ? size : offset;
        this.publication?.assertCurrent();
        if (this.publication && !admission)
          throw new FilesystemError(28, "publication admission required");
        if (!total) {
          if (this.publication && admission) {
            this.publication.verifyAdmission(
              admission,
              append ? { kind: "append", handle } : { kind: "write", handle, offset },
              new Uint8Array(),
            );
            this.publication.commit(
              this.publication.prepare(
                admission,
                append ? { kind: "append", written: 0, offset: at } : { kind: "number", value: 0 },
                [],
              ),
            );
          }
          return at;
        }
        const end = at + total;
        if (!(slots[base + REVISION_STATE]! & RESIDENT) || end > slots[base + CAPACITY]! * PAGE)
          return -Math.max(1, end);
        // Resolve every backing page before the first byte is committed. A retry must never
        // hide a partial write when a segment is not yet available.
        if (nonblocking || this.publication)
          for (let page = Math.floor(at / PAGE); page < Math.ceil(end / PAGE); page++)
            this.segmentFor(this.pages[this.pageAt(slot, page)]! - 1);
        this.checkDirty(slot, Math.max(size, end));
        const mtime = Date.now();
        const identity = this.prepareIdentityVersion(slot, true);
        const prepared = this.prepareDirectPublication(
          slot,
          chunks,
          append,
          at,
          end,
          size,
          mtime,
          identity,
          admission,
        );
        this.prepareVersionPages(slot, at, end, Math.max(size, end));
        this.dirty(slot, Math.max(size, end));
        this.commitDirectBytes(
          slot,
          prepared ? [prepared.bytes] : chunks,
          at,
          end,
          size,
          mtime,
          prepared?.publication,
          identity,
        );
        return end;
      } finally {
        Atomics.compareExchange(slots, lock, owner, 0);
      }
    } finally {
      Atomics.add(epoch, 0, 1);
      this.globalUnlock(owner);
    }
  }
  private commitDirectBytes(
    slot: number,
    chunks: readonly Uint8Array[],
    at: number,
    end: number,
    size: number,
    mtime: number,
    publication?: PreparedPublication,
    identity?: PlannedIdentityRevision,
  ): void {
    const base = slot * SLOT_WORDS;
    try {
      this.copyChunks(slot, chunks, at);
      if (end > size) this.slots[base + FILE_SIZE] = end;
      this.slots[base + MTIME_LOW] = mtime >>> 0;
      this.slots[base + MTIME_HIGH] = Math.floor(mtime / 0x100000000) >>> 0;
      this.changed(slot);
      this.commitIdentityVersion(slot, identity);
      if (publication) this.publication!.commit(publication);
    } catch (error) {
      // Once a byte may have changed, failure is unknown, never a no-effect retry.
      this.publication?.stop();
      throw error;
    }
  }
  private prepareDirectPublication(
    slot: number,
    chunks: readonly Uint8Array[],
    append: boolean,
    at: number,
    end: number,
    oldSize: number,
    mtime: number,
    identity: PlannedIdentityRevision | undefined,
    admission?: PublicationAdmission,
  ): { publication: PreparedPublication; bytes: Uint8Array } | undefined {
    const domain = this.publication;
    if (!domain) return;
    if (!admission) throw new FilesystemError(28, "publication admission required");
    if (end - at > domain.limits.inputBytes)
      throw new FilesystemError(6, "publication input bound exceeded");
    const bytes = new Uint8Array(end - at);
    let offset = 0;
    for (const chunk of chunks) {
      typedArraySet(bytes, chunk, offset);
      offset += chunk.length;
    }
    domain.verifyAdmission(
      admission,
      append
        ? { kind: "append", handle: this.slots[slot * SLOT_WORDS + HANDLE]! - 1 }
        : { kind: "write", handle: this.slots[slot * SLOT_WORDS + HANDLE]! - 1, offset: at },
      bytes,
    );
    const file = this.publicationFile(slot, identity);
    const publication = domain.prepare(
      admission,
      append
        ? { kind: "append", written: bytes.length, offset: end }
        : { kind: "number", value: bytes.length },
      [
        {
          kind: "bytes",
          file,
          offset: at,
          bytes,
          size: Math.max(oldSize, end),
          version: domain.nextContentVersion(file.ino),
        },
        { kind: "metadata", file, mode: this.slots[slot * SLOT_WORDS + MODE]!, mtime },
      ],
    );
    return { publication, bytes };
  }
  directWrite(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    total: number,
    epoch: Int32Array,
    revoked: () => boolean,
    owner: number,
    nonblocking = false,
    admission?: PublicationAdmission,
  ): number | undefined {
    return this.direct(
      slot,
      handle,
      chunks,
      false,
      offset,
      total,
      epoch,
      revoked,
      owner,
      nonblocking,
      admission,
    ) < 0
      ? undefined
      : total;
  }
  directAppend(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    total: number,
    epoch: Int32Array,
    revoked: () => boolean,
    owner: number,
    nonblocking = false,
    admission?: PublicationAdmission,
  ): { written: number; offset: number } | number {
    const end = this.direct(
      slot,
      handle,
      chunks,
      true,
      0,
      total,
      epoch,
      revoked,
      owner,
      nonblocking,
      admission,
    );
    return end < 0 ? -end : { written: total, offset: end };
  }
  /** Caller owns the global mutation lock. Undefined asks for service growth after unlock. */
  tryWrite(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    total: number,
    revoked?: () => boolean,
    owner = this.lockOwner,
  ): number | undefined {
    const slot = this.slot(handle);
    if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31);
    if (!total) return 0;
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      if (revoked?.()) throw new FilesystemError(11);
      this.checkFile(slot, handle);
      this.checkAccess(slot, 2);
      const end = offset + total;
      if (
        !(this.slots[this.at(slot, REVISION_STATE)]! & RESIDENT) ||
        end > Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE
      )
        return undefined;
      const identity = this.prepareIdentityVersion(slot, true);
      this.prepareVersionPages(
        slot,
        offset,
        end,
        Math.max(this.slots[this.at(slot, FILE_SIZE)]!, end),
      );
      this.dirty(slot, Math.max(this.slots[this.at(slot, FILE_SIZE)]!, end));
      let at = offset;
      for (const chunk of chunks) {
        this.copyInto(slot, chunk, at);
        at += chunk.length;
      }
      if (end > Atomics.load(this.slots, this.at(slot, FILE_SIZE)))
        Atomics.store(this.slots, this.at(slot, FILE_SIZE), end);
      this.setTimestamp(slot, Date.now());
      this.changed(slot);
      this.commitIdentityVersion(slot, identity);
      return total;
    } finally {
      this.unlock(this.at(slot, FILE_LOCK), owner);
    }
  }
  write(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    revoked?: () => boolean,
    owner = this.lockOwner,
  ): number {
    chunks = fixedWriteSources(chunks);
    const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
    const written = this.tryWrite(handle, chunks, offset, total, revoked, owner);
    if (written === undefined) throw new RangeError("file needs growth");
    return written;
  }
  /** Caller owns the global mutation lock. A number asks for service growth after unlock. */
  tryAppend(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    total: number,
    revoked?: () => boolean,
    owner = this.lockOwner,
  ): { written: number; offset: number } | number {
    const slot = this.slot(handle);
    if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31);
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      this.checkFile(slot, handle);
      this.checkAccess(slot, 2);
      const offset = Atomics.load(this.slots, this.at(slot, FILE_SIZE));
      if (!total) return { written: 0, offset };
      if (
        !(this.slots[this.at(slot, REVISION_STATE)]! & RESIDENT) ||
        offset + total > Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE
      )
        return offset + total;
      const identity = this.prepareIdentityVersion(slot, true);
      this.prepareVersionPages(slot, offset, offset + total, offset + total);
      this.dirty(slot, offset + total);
      let at = offset;
      for (const chunk of chunks) {
        this.copyInto(slot, chunk, at);
        at += chunk.length;
      }
      Atomics.store(this.slots, this.at(slot, FILE_SIZE), at);
      this.setTimestamp(slot, Date.now());
      this.changed(slot);
      this.commitIdentityVersion(slot, identity);
      return { written: total, offset: at };
    } finally {
      this.unlock(this.at(slot, FILE_LOCK), owner);
    }
  }
  append(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    revoked?: () => boolean,
    owner = this.lockOwner,
  ): { written: number; offset: number } {
    chunks = fixedWriteSources(chunks);
    const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
    const result = this.tryAppend(handle, chunks, total, revoked, owner);
    if (typeof result === "number") throw new RangeError("file needs growth");
    return result;
  }
  growLocked(handle: FileHandle, size: number): void {
    const slot = this.slot(handle);
    const needed = Math.ceil(size / PAGE);
    const capacity = this.slots[this.at(slot, CAPACITY)]!;
    this.checkDirty(slot, size, this.residentBytes() + Math.max(0, needed - capacity) * PAGE);
    this.allocate(slot, needed);
  }
  grow(handle: FileHandle, size: number): void {
    this.globalLock();
    try {
      this.growLocked(handle, size);
    } finally {
      this.globalUnlock();
    }
  }
  resize(
    handle: FileHandle,
    size: number,
    truncate: boolean,
    revoked?: () => boolean,
    owner = this.lockOwner,
    admission?: PublicationAdmission,
  ): number {
    const slot = this.slot(handle);
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      this.checkFile(slot, handle);
      this.checkAccess(slot, 2);
      const old = Atomics.load(this.slots, this.at(slot, FILE_SIZE));
      const resident = (this.slots[this.at(slot, REVISION_STATE)]! & RESIDENT) !== 0;
      if (!resident && !(truncate && size === 0))
        throw new MissingDataError("shared filesystem file has not been loaded");
      if (size > Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE)
        throw new RangeError("file needs growth");
      const next = truncate ? size : Math.max(old, size);
      const mtime = truncate ? Date.now() : this.getMtime(slot);
      const identity = this.prepareIdentityVersion(
        slot,
        next !== old || mtime !== this.getMtime(slot),
      );
      if (truncate || next !== old) this.checkDirty(slot, next);
      const publication = admission
        ? this.prepareResize(slot, handle, size, truncate, next, mtime, identity, admission)
        : undefined;
      if (resident && truncate && size < old)
        this.prepareVersionPages(slot, size, truncateBoundaryEnd(size, old), next);
      if (truncate || next !== old) this.dirty(slot, next);
      if (resident && truncate && size < old) this.zeroTruncatedPages(slot, size, old);
      Atomics.store(this.slots, this.at(slot, FILE_SIZE), next);
      this.slots[this.at(slot, REVISION_STATE)]! |= RESIDENT;
      if (truncate) this.setTimestamp(slot, mtime);
      if (truncate || next !== old) this.changed(slot);
      this.commitIdentityVersion(slot, identity);
      if (publication) this.publication!.commit(publication);
      return 0;
    } finally {
      this.unlock(this.at(slot, FILE_LOCK), owner);
    }
  }
  private zeroTruncatedPages(slot: number, size: number, old: number): void {
    let position = size;
    while (position < old) {
      const page = Atomics.load(this.pages, this.pageAt(slot, Math.floor(position / PAGE))) - 1;
      const count = Math.min(old - position, PAGE - (position % PAGE));
      // Whole pinned pages leave the live mapping in reclaimLocked, unchanged for readers.
      if (position % PAGE || !this.pageReaders?.[page])
        this.segmentFor(page).fill(0, position % PAGE, (position % PAGE) + count);
      position += count;
    }
  }
  private prepareResize(
    slot: number,
    handle: FileHandle,
    size: number,
    truncate: boolean,
    next: number,
    mtime: number,
    identity: PlannedIdentityRevision | undefined,
    admission: PublicationAdmission,
  ): PreparedPublication {
    const domain = this.publication!;
    domain.verifyAdmission(admission, { kind: "resize", handle, size, truncate }, new Uint8Array());
    const file = this.publicationFile(slot, identity);
    const changes: import("./publication.js").PublicationEffect[] = [];
    if (next !== this.slots[this.at(slot, FILE_SIZE)])
      changes.push({
        kind: "resize",
        file,
        size: next,
        version: domain.nextContentVersion(file.ino),
      });
    if (mtime !== this.getMtime(slot))
      changes.push({ kind: "metadata", file, mode: this.slots[this.at(slot, MODE)]!, mtime });
    return domain.prepare(admission, { kind: "number", value: 0 }, changes);
  }
  private prepareMtime(
    slot: number,
    handle: FileHandle,
    mtime: number,
    identity: PlannedIdentityRevision | undefined,
    admission: PublicationAdmission,
  ): PreparedPublication {
    const domain = this.publication!;
    domain.verifyAdmission(admission, { kind: "setMtime", handle, mtime }, new Uint8Array());
    const file = this.publicationFile(slot, identity);
    const changes: import("./publication.js").PublicationEffect[] =
      mtime === this.getMtime(slot)
        ? []
        : [{ kind: "metadata", file, mode: this.slots[this.at(slot, MODE)]!, mtime }];
    return domain.prepare(admission, { kind: "number", value: 0 }, changes);
  }
  /** Service-only: caller holds the global allocator/mutation lock. */
  reclaimLocked(handle: FileHandle): void {
    const slot = this.slot(handle);
    this.lock(this.at(slot, FILE_LOCK));
    try {
      const needed = Math.ceil(Atomics.load(this.slots, this.at(slot, FILE_SIZE)) / PAGE);
      const capacity = Atomics.load(this.slots, this.at(slot, CAPACITY));
      for (let logical = needed; logical < capacity; logical++) {
        const physical = Atomics.load(this.pages, this.pageAt(slot, logical)) - 1;
        this.detachVersionPage(physical);
        Atomics.store(this.pages, this.pageAt(slot, logical), 0);
      }
      Atomics.store(this.slots, this.at(slot, CAPACITY), needed);

      this.trimPageTables(slot, needed);
    } finally {
      this.unlock(this.at(slot, FILE_LOCK));
    }
  }
  setMtime(
    handle: FileHandle,
    mtime: number,
    revoked?: () => boolean,
    owner = this.lockOwner,
    admission?: PublicationAdmission,
  ): number {
    const slot = this.slot(handle);
    this.lock(this.at(slot, FILE_LOCK), revoked, owner);
    try {
      if (this.slots[this.at(slot, HANDLE)] !== handle + 1) throw new FilesystemError(8);
      this.checkAccess(slot, 2);
      this.checkDirty(slot, this.slots[this.at(slot, FILE_SIZE)]!);
      const identity = this.prepareIdentityVersion(slot, mtime !== this.getMtime(slot));
      const publication = admission
        ? this.prepareMtime(slot, handle, mtime, identity, admission)
        : undefined;
      this.dirty(slot);
      this.setTimestamp(slot, mtime);
      this.changed(slot);
      this.commitIdentityVersion(slot, identity);
      if (publication) this.publication!.commit(publication);
      return 0;
    } finally {
      this.unlock(this.at(slot, FILE_LOCK), owner);
    }
  }
  retain(handle: FileHandle): void {
    this.section?.enter();
    try {
      const slot = this.slot(handle);
      this.lock(this.at(slot, FILE_LOCK));
      try {
        if (this.slots[this.at(slot, HANDLE)] !== handle + 1) throw new FilesystemError(8);
        Atomics.add(this.slots, this.at(slot, REFS), 1);
      } finally {
        this.unlock(this.at(slot, FILE_LOCK));
      }
    } finally {
      this.section?.exit();
    }
  }
  release(handle: FileHandle): void {
    this.section?.enter();
    try {
      const slot = this.slot(handle);
      let free = false;
      this.lock(this.at(slot, FILE_LOCK), undefined, this.lockOwner, "release");
      try {
        if (this.slots[this.at(slot, HANDLE)] !== handle + 1) throw new FilesystemError(8);
        const refs = Atomics.sub(this.slots, this.at(slot, REFS), 1) - 1;
        free = refs === 0 && this.slots[this.at(slot, UNLINKED)] !== 0;
      } finally {
        this.unlock(this.at(slot, FILE_LOCK));
      }
      if (free) this.free(handle, "release");
    } finally {
      this.section?.exit();
    }
  }
  unlink(handle: FileHandle): void {
    this.section?.enter();
    try {
      const slot = this.findSlot(handle);
      if (!slot) return;
      // Namespace mutation owns the global lock. A revocation callback may mark a pinned
      // file while its writer still holds the file lock, so only actual reclamation takes it.
      Atomics.store(this.slots, this.at(slot, UNLINKED), 1);
      if (Atomics.load(this.slots, this.at(slot, REFS)) === 0) this.free(handle);
    } finally {
      this.section?.exit();
    }
  }
  /** Service namespace mutation owns the global lock, as for unlink. Relinking does not
   * change the persisted payload or its revision; it cancels last-close reclamation. */
  relink(handle: FileHandle): void {
    this.section?.enter();
    try {
      const slot = this.findSlot(handle);
      if (slot) Atomics.store(this.slots, this.at(slot, UNLINKED), 0);
    } finally {
      this.section?.exit();
    }
  }
  /** Both global and file locks are held. */
  private freePagesLocked(slot: number): void {
    const count = Atomics.load(this.slots, this.at(slot, CAPACITY));
    for (let logical = 0; logical < count; logical++) {
      const physical = Atomics.load(this.pages, this.pageAt(slot, logical)) - 1;
      if (physical >= 0) this.detachVersionPage(physical);
      Atomics.store(this.pages, this.pageAt(slot, logical), 0);
    }

    this.trimPageTables(slot, 0);
    Atomics.store(this.slots, this.at(slot, CAPACITY), 0);
  }
  /** Both global and file locks are held. Keep the lock and generation until after publication. */
  private freeLocked(slot: number): void {
    if (this.slots[this.at(slot, UNLINKED)])
      this.publication?.forgetContent(this.slots[this.at(slot, INO)]!);
    this.freePagesLocked(slot);
    this.dirtyAdmission.pin(-1, this.residentBytes());
    this.slots[this.at(slot, DIRTY_SIZE)] = 0;
    this.slots[this.at(slot, DIRTY_MARK)] = 0;
    const revision = this.getRevision(slot);
    const floor =
      (this.cells[FREED_REVISION_HIGH]! >>> 0) * 0x100000000 +
      (this.cells[FREED_REVISION_LOW]! >>> 0);
    if (revision > floor) {
      this.cells[FREED_REVISION_LOW] = revision >>> 0;
      this.cells[FREED_REVISION_HIGH] = Math.floor(revision / 0x100000000);
    }
    for (let field = 0; field < HANDLE; field++)
      if (field !== FILE_LOCK) Atomics.store(this.slots, this.at(slot, field), 0);
    this.slots[this.at(slot, REVISION_STATE)]! &= ~RESIDENT;
    Atomics.store(this.slots, this.at(slot, HANDLE), -1);
  }
  private free(handle: FileHandle, access: "data" | "release" = "data"): void {
    this.globalLock(undefined, this.lockOwner, false, access);
    try {
      const slot = this.findSlot(handle);
      if (!slot) return;
      this.lock(this.at(slot, FILE_LOCK), undefined, this.lockOwner, access);
      try {
        if (
          this.slots[this.at(slot, HANDLE)] !== handle + 1 ||
          !this.slots[this.at(slot, UNLINKED)] ||
          this.slots[this.at(slot, REFS)]
        )
          return;
        this.freeLocked(slot);
      } finally {
        this.unlock(this.at(slot, FILE_LOCK));
      }
    } finally {
      this.globalUnlock();
    }
  }
  ownerActive(owner: number): boolean {
    if (Atomics.load(this.cells, GLOBAL_LOCK) === owner) return true;
    for (let slot = 1; slot < MAX_FILES; slot++)
      if (Atomics.load(this.slots, this.at(slot, FILE_LOCK)) === owner) return true;
    return false;
  }
  revokeOwner(owner: number, epoch?: Int32Array): void {
    if (!owner || owner === SERVICE_OWNER) return;
    this.publication?.revokeOwner(owner);
    // Keep the global lock held while repairing its epoch: another writer must not enter
    // between releasing the dead owner and publishing the matching even epoch.
    const ownsGlobal =
      Atomics.compareExchange(this.cells, GLOBAL_LOCK, owner, SERVICE_OWNER) === owner;
    for (let slot = 1; slot < MAX_FILES; slot++)
      Atomics.compareExchange(this.slots, this.at(slot, FILE_LOCK), owner, 0);
    if (ownsGlobal) {
      if (epoch && Atomics.load(epoch, 0) & 1) Atomics.add(epoch, 0, 1);
      Atomics.compareExchange(this.cells, GLOBAL_LOCK, SERVICE_OWNER, 0);
    }
  }
  resources(): {
    bytes: number;
    poolBytes: number;
    metadataBytes: number;
    usedBytes: number;
    freeBytes: number;
    maxBytes: number;
    files: number;
  } {
    let files = 0;
    for (let slot = 1; slot < MAX_FILES; slot++)
      if (Atomics.load(this.slots, this.at(slot, 0))) files++;
    const usedBytes = Atomics.load(this.cells, USED_PAGES) * PAGE;
    const poolBytes = this.segments
      .slice(1)
      .reduce((bytes, buffer) => bytes + buffer.byteLength, SEGMENT_BYTES);
    const metadataBytes =
      this.buffer.byteLength - SEGMENT_BYTES + (this.pageReaders?.byteLength ?? 0);
    return {
      bytes: poolBytes + metadataBytes,
      poolBytes,
      metadataBytes,
      usedBytes,
      freeBytes: poolBytes - usedBytes,
      maxBytes: Atomics.load(this.cells, 4) * SEGMENT_BYTES,
      files,
    };
  }
}
/** This connection's revocation word or any ancestor's. An indexed scan: Array#some with a
 * callback costs several times more in WebKit, and every direct I/O call checks it. */
export function sharedRevoked(connection: {
  revocations: SharedArrayBuffer[];
  ownerStates: SharedArrayBuffer;
  publication?: PublicationConnection;
}): () => boolean {
  const words = [new Int32Array(connection.ownerStates, 0, 1)].concat(
    connection.revocations.map((buffer) => new Int32Array(buffer)),
  );
  if (connection.publication)
    words.push(new Int32Array(connection.publication.buffers.control, 0, 1));
  return () => {
    for (let i = 0; i < words.length; i++) if (Atomics.load(words[i]!, 0) !== 0) return true;
    return false;
  };
}
