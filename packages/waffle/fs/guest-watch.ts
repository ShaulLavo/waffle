import {
  FilesystemError,
  type FileHandle,
  type WatchDrainEntry,
  type WatchFileSystem,
} from "../core/filesystem.js";
import type { WatchBatch, WatchEvent } from "./watch.js";
import {
  arrayAppend,
  atomicsLoad,
  MapConstructor,
  mapDelete,
  mapForEach,
  mapGet,
  mapSet,
  mapSize,
} from "../proc/intrinsics/core.js";

// Guest watch ids and their records: the runtime_fs watch_* contract in docs/host-abi.md.
const EAGAIN = 6;
const EBADF = 8;
const ECANCELED = 11;
const ENOTSUP = 58;
const CHANGE = 1;
const RENAME = 2;
const OVERFLOW = 3;
const NULL_NAME = 0xffffffff;
const LAST_ID = 0xffffffff;
const encoder = new TextEncoder();

/** What a guest's network wait needs to know about its filesystem watches. */
export interface GuestWatchReadiness {
  /** At least one open watch has not reached its end. */
  readonly active: boolean;
  /** The root's watch cells; index 3 moves on every committed watch record. */
  readonly word: Int32Array;
  /** Unrevoked, unended watches have queued records or an unobserved commit. */
  pending(): boolean;
}

export type GuestWatchRead =
  /** Whole records in order; no records means end of stream. */
  | { readonly kind: "records"; readonly records: readonly Uint8Array[]; readonly length: number }
  /** The first pending record needs `needed` bytes. Nothing was consumed. */
  | { readonly kind: "short"; readonly needed: number }
  | { readonly kind: "error"; readonly errno: number };

export type GuestWatchNext =
  | {
      readonly kind: "records";
      readonly id: number;
      readonly records: readonly Uint8Array[];
      readonly length: number;
    }
  | { readonly kind: "short"; readonly id: number; readonly needed: number }
  | { readonly kind: "watch_error"; readonly id: number; readonly errno: number }
  | { readonly kind: "error"; readonly errno: number };

interface Watch {
  readonly id: number;
  readonly service: number;
  /** cells[3] before this watch's latest per-watch service read (fallback path only). */
  observed: number;
  /** Encoded records consumed from `head`. */
  queue: Uint8Array[];
  head: number;
  ended: boolean;
  overflowed: boolean;
  pendingErrno: number;
  inReady: boolean;
  readyPrev: Watch | undefined;
  readyNext: Watch | undefined;
}

const END: GuestWatchRead = { kind: "records", records: [], length: 0 };

function failure(errno: number): { readonly kind: "error"; readonly errno: number } {
  return { kind: "error", errno };
}

function nextOf(id: number, result: GuestWatchRead): GuestWatchNext {
  return result.kind === "error"
    ? { kind: "watch_error", id, errno: result.errno }
    : { ...result, id };
}

/** Process-local watch ids over the opener's filesystem session. Ids are never reused. */
export class GuestWatchTable implements GuestWatchReadiness {
  private watches = new MapConstructor<number, Watch>();
  private byService = new MapConstructor<number, Watch>();
  private nextId = 1;
  private revocationNotified = false;
  private activeCount = 0;
  private readyHead: Watch | undefined;
  private readyTail: Watch | undefined;
  private tableObserved = 0;
  private drainAvailable: boolean;

  constructor(private readonly fs: WatchFileSystem) {
    this.drainAvailable = typeof fs.drain === "function";
  }

  get word(): Int32Array {
    return this.fs.cells;
  }

  get active(): boolean {
    return this.activeCount > 0;
  }

  private useDrain(): boolean {
    return this.drainAvailable && !this.fs.remote;
  }

  pending(): boolean {
    if (this.fs.revoked)
      return !!this.fs.remote && !this.revocationNotified && this.activeCount > 0;
    if (!this.activeCount) return false;
    return this.hasPending(false);
  }

  /** A read may return records, end or an error; never consumes watch state. */
  ready(): boolean {
    if (!mapSize(this.watches)) return false;
    if (this.fs.revoked || this.readyHead) return true;
    return this.hasPending(true);
  }

  private hasPending(includeEnded: boolean): boolean {
    for (let watch = this.readyHead; watch; watch = watch.readyNext)
      if (includeEnded || !watch.ended) return true;
    const generation = atomicsLoad(this.fs.cells, 3);
    if (this.useDrain()) return this.activeCount > 0 && generation !== this.tableObserved;
    let pending = false;
    mapForEach(this.watches, (watch) => {
      if (watch.ended ? includeEnded : watch.observed !== generation) pending = true;
    });
    return pending;
  }

  private linkReady(watch: Watch): void {
    if (watch.inReady) return;
    watch.inReady = true;
    watch.readyPrev = this.readyTail;
    watch.readyNext = undefined;
    if (this.readyTail) this.readyTail.readyNext = watch;
    else this.readyHead = watch;
    this.readyTail = watch;
  }

  private unlinkReady(watch: Watch): void {
    if (!watch.inReady) return;
    watch.inReady = false;
    const { readyPrev: prev, readyNext: next } = watch;
    if (prev) prev.readyNext = next;
    else this.readyHead = next;
    if (next) next.readyPrev = prev;
    else this.readyTail = prev;
    watch.readyPrev = watch.readyNext = undefined;
  }

  private rotateReady(watch: Watch): void {
    if (!watch.inReady || watch === this.readyTail) return;
    this.unlinkReady(watch);
    this.linkReady(watch);
  }

  private markEnded(watch: Watch): void {
    if (watch.ended) return;
    watch.ended = true;
    this.activeCount--;
    this.linkReady(watch);
  }

  private syncReady(watch: Watch): void {
    if (watch.ended || watch.head < watch.queue.length || watch.pendingErrno !== 0)
      this.linkReady(watch);
    else this.unlinkReady(watch);
  }

  /** Throws FilesystemError from the service. */
  open(handle: FileHandle, recursive: boolean): number {
    if (this.nextId > LAST_ID) throw new FilesystemError(EAGAIN, "watch ids exhausted");
    // Sampled before the RPC: a commit after the service activates the subscription must
    // move the counter past this value, so the first read cannot skip its service call.
    const observed = atomicsLoad(this.fs.cells, 3);
    const service = this.fs.open(handle, recursive);
    const id = this.nextId++;
    if (!mapSize(this.watches)) this.tableObserved = observed;
    const watch: Watch = {
      id,
      service,
      observed,
      queue: [],
      head: 0,
      ended: false,
      overflowed: false,
      pendingErrno: 0,
      inReady: false,
      readyPrev: undefined,
      readyNext: undefined,
    };
    mapSet(this.watches, id, watch);
    mapSet(this.byService, service, watch);
    this.activeCount++;
    return id;
  }

  /** Throws FilesystemError when the service read fails. */
  read(id: number, capacity: number): GuestWatchRead {
    const watch = mapGet(this.watches, id);
    if (!watch) return failure(EBADF);
    if (watch.ended) return END;
    if (this.useDrain()) {
      if (this.fs.revoked) return failure(ECANCELED);
      if (this.drainService()) return this.readFallback(watch, capacity);
      if (watch.ended) return END;
      return watch.head < watch.queue.length
        ? this.takeFrom(watch, capacity)
        : failure(watch.pendingErrno || EAGAIN);
    }
    return this.readFallback(watch, capacity);
  }

  /** Read the next ready watch without scanning idle ones. Returns EAGAIN when nothing is ready. */
  readNext(capacity: number): GuestWatchNext {
    if (!mapSize(this.watches)) return failure(EAGAIN);
    if (this.fs.revoked) {
      if (this.fs.remote) this.revocationNotified = true;
      let firstId = 0;
      mapForEach(this.watches, (_watch, id) => {
        if (!firstId) firstId = id;
      });
      return firstId ? { kind: "watch_error", id: firstId, errno: ECANCELED } : failure(EAGAIN);
    }
    if (this.useDrain()) {
      if (this.drainService()) return this.readNextFallback(capacity);
      return this.takeNextReady(capacity);
    }
    return this.readNextFallback(capacity);
  }

  private takeNextReady(capacity: number): GuestWatchNext {
    const watch = this.readyHead;
    if (!watch) return failure(EAGAIN);
    if (watch.ended) {
      this.rotateReady(watch);
      return nextOf(watch.id, END);
    }
    if (watch.head < watch.queue.length) return nextOf(watch.id, this.takeFrom(watch, capacity));
    if (watch.pendingErrno !== 0) {
      this.rotateReady(watch);
      return { kind: "watch_error", id: watch.id, errno: watch.pendingErrno };
    }
    this.unlinkReady(watch);
    return failure(EAGAIN);
  }

  private readFallback(watch: Watch, capacity: number): GuestWatchRead {
    if (watch.ended) return END;
    if (watch.head === watch.queue.length) {
      const refused = this.refillSingle(watch);
      if (refused) return refused;
    }
    return this.takeFrom(watch, capacity);
  }

  private readNextFallback(capacity: number): GuestWatchNext {
    if (this.readyHead) return this.takeNextReady(capacity);
    const generation = atomicsLoad(this.fs.cells, 3);
    let result: GuestWatchNext | undefined;
    mapForEach(this.watches, (watch) => {
      if (result || watch.ended || watch.observed === generation) return;
      try {
        const read = this.readFallback(watch, capacity);
        if (read.kind !== "error" || read.errno !== EAGAIN) result = nextOf(watch.id, read);
      } catch (error) {
        if (error instanceof FilesystemError)
          result = { kind: "watch_error", id: watch.id, errno: error.errno };
        else throw error;
      }
    });
    return result ?? failure(EAGAIN);
  }

  /** Throws FilesystemError when the service close fails; the id then stays open for a retry. */
  close(id: number): number {
    const watch = mapGet(this.watches, id);
    if (!watch) return EBADF;
    if (!this.fs.revoked) this.closeService(watch.service);
    this.unlinkReady(watch);
    if (!watch.ended) this.activeCount--;
    mapDelete(this.watches, id);
    mapDelete(this.byService, watch.service);
    return 0;
  }

  private closeService(service: number): void {
    try {
      this.fs.close(service);
    } catch (error) {
      // Revoked meanwhile: the session's close releases the subscription.
      if (!(error instanceof FilesystemError) || error.errno !== ECANCELED) throw error;
    }
  }

  /** Forget every id without service calls; the session's close releases subscriptions. */
  drop(): void {
    this.watches = new MapConstructor();
    this.byService = new MapConstructor();
    this.activeCount = 0;
    this.readyHead = this.readyTail = undefined;
  }

  /** Drain all ready watches for this owner in one service RPC. Returns true if drain is unsupported. */
  private drainService(): boolean {
    const generation = atomicsLoad(this.fs.cells, 3);
    if (generation === this.tableObserved) return false;
    const previous = this.tableObserved;
    this.tableObserved = generation;
    let entries: readonly WatchDrainEntry[];
    try {
      entries = this.fs.drain!();
    } catch (error) {
      this.tableObserved = previous;
      if (error instanceof FilesystemError && error.errno === ENOTSUP) {
        this.drainAvailable = false;
        mapForEach(this.watches, (watch) => {
          watch.observed = previous;
        });
        return true;
      }
      throw error;
    }
    // Clear stale access errors before applying the fresh drain snapshot.
    for (let watch = this.readyHead; watch;) {
      const next = watch.readyNext;
      if (watch.pendingErrno !== 0) {
        watch.pendingErrno = 0;
        this.syncReady(watch);
      }
      watch = next;
    }
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const watch = mapGet(this.byService, entry.id);
      if (!watch || watch.ended) continue;
      if ("errno" in entry) {
        watch.pendingErrno = entry.errno;
        this.syncReady(watch);
        continue;
      }
      const batch = entry.batch;
      if (batch.kind === "closed") {
        this.markEnded(watch);
        continue;
      }
      if (batch.kind === "overflow") {
        if (watch.overflowed) continue;
        watch.overflowed = true;
        arrayAppend(watch.queue, encodeRecord(OVERFLOW, null));
        this.syncReady(watch);
        continue;
      }
      if (!batch.events.length) continue;
      for (let at = 0; at < batch.events.length; at++)
        arrayAppend(watch.queue, encodeEvent(batch.events[at]!));
      this.syncReady(watch);
    }
    return false;
  }

  private refillSingle(watch: Watch): GuestWatchRead | undefined {
    if (this.fs.revoked) {
      if (this.fs.remote) this.revocationNotified = true;
      return failure(ECANCELED);
    }
    const generation = atomicsLoad(this.fs.cells, 3);
    if (!this.fs.remote && generation === watch.observed) return failure(EAGAIN);
    // Set before the call: a commit after the service drains moves the counter again. A failed
    // call drained nothing, so the watch stays pending for the retry.
    const previous = watch.observed;
    watch.observed = generation;
    let batch: WatchBatch;
    try {
      batch = this.fs.read(watch.service);
    } catch (error) {
      watch.observed = previous;
      throw error;
    }
    if (batch.kind === "closed") {
      this.markEnded(watch);
      return END;
    }
    watch.queue = encodeBatch(batch);
    watch.head = 0;
    if (!watch.queue.length) {
      this.syncReady(watch);
      return failure(EAGAIN);
    }
    this.syncReady(watch);
  }

  private takeFrom(watch: Watch, capacity: number): GuestWatchRead {
    const records: Uint8Array[] = [];
    let length = 0;
    while (watch.head < watch.queue.length) {
      const record = watch.queue[watch.head]!;
      if (length + record.length > capacity) break;
      arrayAppend(records, record);
      length += record.length;
      watch.head++;
      if (record[0] === OVERFLOW) this.markEnded(watch);
    }
    if (!length) return { kind: "short", needed: watch.queue[watch.head]!.length };
    if (watch.head === watch.queue.length) {
      watch.queue = [];
      watch.head = 0;
    }
    this.syncReady(watch);
    return { kind: "records", records, length };
  }
}

function encodeBatch(batch: Exclude<WatchBatch, { kind: "closed" }>): Uint8Array[] {
  if (batch.kind === "overflow") return [encodeRecord(OVERFLOW, null)];
  const records: Uint8Array[] = [];
  for (let index = 0; index < batch.events.length; index++)
    arrayAppend(records, encodeEvent(batch.events[index]!));
  return records;
}

function encodeEvent(event: WatchEvent): Uint8Array {
  return encodeRecord(event.type === "change" ? CHANGE : RENAME, event.name);
}

/** u8 type, three zero bytes, u32le name length or NULL_NAME, UTF-8 name padded to 4. */
function encodeRecord(type: number, name: string | null): Uint8Array {
  const bytes = name === null ? undefined : encoder.encode(name);
  const size = bytes ? bytes.length : 0;
  const record = new Uint8Array(8 + ((size + 3) & ~3));
  const length = bytes ? size : NULL_NAME;
  record[0] = type;
  record[4] = length & 0xff;
  record[5] = (length >>> 8) & 0xff;
  record[6] = (length >>> 16) & 0xff;
  record[7] = length >>> 24;
  if (bytes) record.set(bytes, 8);
  return record;
}
