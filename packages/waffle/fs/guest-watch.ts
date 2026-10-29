import { FilesystemError, type FileHandle, type WatchFileSystem } from "../core/filesystem.js";
import type { WatchBatch, WatchEvent } from "./watch.js";
import {
  arrayAppend,
  atomicsLoad,
  MapConstructor,
  mapDelete,
  mapForEach,
  mapGet,
  mapSet,
} from "../proc/intrinsics/core.js";

// Guest watch ids and their records: the runtime_fs watch_* contract in docs/host-abi.md.
const EAGAIN = 6;
const EBADF = 8;
const ECANCELED = 11;
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
  /** A watch_read would return records or an end without waiting. */
  pending(): boolean;
}

export type GuestWatchRead =
  /** Whole records in order; no records means end of stream. */
  | { readonly kind: "records"; readonly records: readonly Uint8Array[]; readonly length: number }
  /** The first pending record needs `needed` bytes. Nothing was consumed. */
  | { readonly kind: "short"; readonly needed: number }
  | { readonly kind: "error"; readonly errno: number };

interface Watch {
  readonly service: number;
  /** cells[3] before this watch's latest service read, or before its open RPC. */
  observed: number;
  /** Encoded records of at most one service batch, consumed from `head`. */
  queue: Uint8Array[];
  head: number;
  ended: boolean;
}

const END: GuestWatchRead = { kind: "records", records: [], length: 0 };

function failure(errno: number): GuestWatchRead {
  return { kind: "error", errno };
}

/** Process-local watch ids over the opener's filesystem session. Ids are never reused. */
export class GuestWatchTable implements GuestWatchReadiness {
  private watches = new MapConstructor<number, Watch>();
  private nextId = 1;

  constructor(private readonly fs: WatchFileSystem) {}

  get word(): Int32Array {
    return this.fs.cells;
  }

  get active(): boolean {
    let active = false;
    mapForEach(this.watches, (watch) => {
      if (!watch.ended) active = true;
    });
    return active;
  }

  pending(): boolean {
    if (this.fs.revoked) return false;
    const generation = atomicsLoad(this.fs.cells, 3);
    let pending = false;
    mapForEach(this.watches, (watch) => {
      if (watch.ended) return;
      if (watch.head < watch.queue.length || watch.observed !== generation) pending = true;
    });
    return pending;
  }

  /** Throws FilesystemError from the service. */
  open(handle: FileHandle, recursive: boolean): number {
    if (this.nextId > LAST_ID) throw new FilesystemError(EAGAIN, "watch ids exhausted");
    // Sampled before the RPC: a commit after the service activates the subscription must
    // move the counter past this value, so the first read cannot skip its service call.
    const observed = atomicsLoad(this.fs.cells, 3);
    const service = this.fs.open(handle, recursive);
    const id = this.nextId++;
    mapSet(this.watches, id, { service, observed, queue: [], head: 0, ended: false });
    return id;
  }

  /** Throws FilesystemError when the service read fails. */
  read(id: number, capacity: number): GuestWatchRead {
    const watch = mapGet(this.watches, id);
    if (!watch) return failure(EBADF);
    if (watch.ended) return END;
    if (watch.head === watch.queue.length) {
      const refused = this.refill(watch);
      if (refused) return refused;
    }
    return take(watch, capacity);
  }

  /** Throws FilesystemError when the service close fails; the id then stays open for a retry. */
  close(id: number): number {
    const watch = mapGet(this.watches, id);
    if (!watch) return EBADF;
    if (!this.fs.revoked) this.closeService(watch.service);
    mapDelete(this.watches, id);
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
  }

  private refill(watch: Watch): GuestWatchRead | undefined {
    if (this.fs.revoked) return failure(ECANCELED);
    const generation = atomicsLoad(this.fs.cells, 3);
    if (generation === watch.observed) return failure(EAGAIN);
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
      watch.ended = true;
      return END;
    }
    watch.queue = encodeBatch(batch);
    watch.head = 0;
    if (!watch.queue.length) return failure(EAGAIN);
  }
}

function take(watch: Watch, capacity: number): GuestWatchRead {
  const records: Uint8Array[] = [];
  let length = 0;
  while (watch.head < watch.queue.length) {
    const record = watch.queue[watch.head]!;
    if (length + record.length > capacity) break;
    arrayAppend(records, record);
    length += record.length;
    watch.head++;
    if (record[0] === OVERFLOW) watch.ended = true;
  }
  if (!length) return { kind: "short", needed: watch.queue[watch.head]!.length };
  if (watch.head === watch.queue.length) {
    watch.queue = [];
    watch.head = 0;
  }
  return { kind: "records", records, length };
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
