import {
  FilesystemError,
  type FileHandle,
  type WatchDrainResult,
  type WatchFileSystem,
} from "../core/filesystem.js";
import type { WatchBatch } from "./watch.js";
import {
  arrayAppend,
  atomicsLoad,
  MapConstructor,
  mapDelete,
  mapFirst,
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
  /** The root's watch cells; index 3 moves on every committed watch record and revocation. */
  readonly word: Int32Array;
  /** Unrevoked, unended watches have queued records or an unobserved commit. */
  pending(): boolean;
}

export type GuestWatchRead =
  | { readonly kind: "records"; readonly records: readonly Uint8Array[]; readonly length: number }
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
  observed: number;
  queue: Uint8Array[];
  head: number;
  ended: boolean;
  errno: number;
}

const END: GuestWatchRead = { kind: "records", records: [], length: 0 };

function failure(errno: number): { readonly kind: "error"; readonly errno: number } {
  return { kind: "error", errno };
}

function watchError(id: number, errno: number): GuestWatchNext {
  return { kind: "watch_error", id, errno };
}

function nextOf(id: number, result: GuestWatchRead): GuestWatchNext {
  return result.kind === "error" ? watchError(id, result.errno) : { ...result, id };
}

function rotate(map: Map<number, Watch>, watch: Watch): void {
  mapDelete(map, watch.id);
  mapSet(map, watch.id, watch);
}

/** Process-local watch ids over the opener's filesystem session. Ids are never reused. */
export class GuestWatchTable implements GuestWatchReadiness {
  #fs: WatchFileSystem;
  #watches!: Map<number, Watch>;
  #byService!: Map<number, Watch>;
  #buffered!: Map<number, Watch>;
  #errored!: Map<number, Watch>;
  #ended!: Map<number, Watch>;
  #nextId = 1;
  #revocationNotified = false;
  #activeCount = 0;
  #observedGen = 0;
  #observedCount = 0;
  #tableObserved: number | undefined;
  #drainMore = false;
  #noDrain = false;
  #flip = false;

  constructor(fs: WatchFileSystem) {
    this.#fs = fs;
    this.drop();
  }

  get word(): Int32Array {
    return this.#fs.cells;
  }

  get active(): boolean {
    return this.#activeCount > 0;
  }

  #useDrain(): boolean {
    if (typeof this.#fs.drain !== "function" || this.#noDrain) return false;
    if (this.#fs.canDrain === false) {
      this.#tableObserved = undefined;
      this.#drainMore = false;
      return false;
    }
    return true;
  }

  #allObserved(generation: number): boolean {
    return (
      (this.#observedCount === this.#activeCount && this.#observedGen === generation) ||
      (this.#useDrain() && !this.#drainMore && this.#tableObserved === generation)
    );
  }

  pending(): boolean {
    if (this.#fs.revoked)
      return !!this.#fs.remote && !this.#revocationNotified && this.#activeCount > 0;
    return (
      this.#activeCount > 0 &&
      (mapSize(this.#buffered) > 0 ||
        mapSize(this.#errored) > 0 ||
        !this.#allObserved(atomicsLoad(this.#fs.cells, 3)))
    );
  }

  /** A read may return records, end or an error; never consumes watch state. */
  ready(): boolean {
    if (!mapSize(this.#watches)) return false;
    return (
      this.#fs.revoked ||
      mapSize(this.#buffered) > 0 ||
      mapSize(this.#errored) > 0 ||
      mapSize(this.#ended) > 0 ||
      (this.#activeCount > 0 && !this.#allObserved(atomicsLoad(this.#fs.cells, 3)))
    );
  }

  #setObserved(watch: Watch, generation: number): void {
    if (watch.observed === generation) return;
    if (!watch.ended) {
      if (watch.observed === this.#observedGen) this.#observedCount--;
      if (generation !== this.#observedGen) {
        this.#observedGen = generation;
        this.#observedCount = 1;
      } else this.#observedCount++;
    }
    watch.observed = generation;
  }

  #markEnded(watch: Watch): void {
    if (watch.ended) return;
    watch.ended = true;
    this.#activeCount--;
    if (watch.observed === this.#observedGen) this.#observedCount--;
    watch.errno = 0;
    mapDelete(this.#buffered, watch.id);
    mapDelete(this.#errored, watch.id);
    mapSet(this.#ended, watch.id, watch);
  }

  /** Throws FilesystemError from the service. */
  open(handle: FileHandle, recursive: boolean): number {
    if (this.#nextId > LAST_ID) throw new FilesystemError(EAGAIN, "watch ids exhausted");
    const observed = atomicsLoad(this.#fs.cells, 3);
    const service = this.#fs.open(handle, recursive);
    const id = this.#nextId++;
    const watch: Watch = { id, service, observed: -1, queue: [], head: 0, ended: false, errno: 0 };
    mapSet(this.#watches, id, watch);
    mapSet(this.#byService, service, watch);
    this.#activeCount++;
    this.#setObserved(watch, observed);
    return id;
  }

  /** Scoped to `id`; never drains other watches. Throws FilesystemError when the service read fails. */
  read(id: number, capacity: number): GuestWatchRead {
    const watch = mapGet(this.#watches, id);
    if (!watch) return failure(EBADF);
    if (watch.ended) return END;
    if (watch.head < watch.queue.length) return this.#takeFrom(watch, capacity);
    const force = watch.errno !== 0;
    if (force) {
      watch.errno = 0;
      mapDelete(this.#errored, id);
    }
    return this.#refillSingle(watch, force) ?? this.#takeFrom(watch, capacity);
  }

  /** Read the next ready watch without scanning idle ones. Returns EAGAIN when nothing is ready. */
  readNext(capacity: number): GuestWatchNext {
    if (!mapSize(this.#watches)) return failure(EAGAIN);
    if (this.#fs.revoked) {
      if (this.#fs.remote) this.#revocationNotified = true;
      const first = mapFirst(this.#watches)!;
      rotate(this.#watches, first);
      return watchError(first.id, ECANCELED);
    }
    if (this.#useDrain() && (mapSize(this.#buffered) || !this.#drainService()))
      return this.#takeNextReady(capacity);
    return this.#readNextFallback(capacity);
  }

  #takeNextReady(capacity: number): GuestWatchNext {
    const buffered = mapFirst(this.#buffered);
    if (buffered) {
      const read = this.#takeFrom(buffered, capacity);
      if (buffered.head < buffered.queue.length) rotate(this.#buffered, buffered);
      return nextOf(buffered.id, read);
    }
    const ended = mapFirst(this.#ended);
    const errored = mapFirst(this.#errored);
    const pick = this.#flip ? (ended ?? errored) : (errored ?? ended);
    if (!pick) return failure(EAGAIN);
    this.#flip = !pick.ended;
    rotate(pick.ended ? this.#ended : this.#errored, pick);
    return pick.ended ? nextOf(pick.id, END) : watchError(pick.id, pick.errno);
  }

  #readNextFallback(capacity: number): GuestWatchNext {
    let result: GuestWatchNext | undefined;
    let reported: Watch | undefined;
    mapForEach(this.#watches, (watch) => {
      if (result) return;
      try {
        const read = this.read(watch.id, capacity);
        if (read.kind !== "error" || read.errno !== EAGAIN) {
          result = nextOf(watch.id, read);
          reported = watch;
        }
      } catch (error) {
        if (!(error instanceof FilesystemError)) throw error;
        result = watchError(watch.id, error.errno);
        reported = watch;
      }
    });
    if (reported) rotate(this.#watches, reported);
    return result ?? failure(EAGAIN);
  }

  /** Throws FilesystemError when the service close fails; the id then stays open for a retry. */
  close(id: number): number {
    const watch = mapGet(this.#watches, id);
    if (!watch) return EBADF;
    if (!this.#fs.revoked) {
      try {
        this.#fs.close(watch.service);
      } catch (error) {
        if (!(error instanceof FilesystemError) || error.errno !== ECANCELED) throw error;
      }
    }
    if (!watch.ended) {
      this.#activeCount--;
      if (watch.observed === this.#observedGen) this.#observedCount--;
    }
    mapDelete(this.#buffered, id);
    mapDelete(this.#errored, id);
    mapDelete(this.#ended, id);
    mapDelete(this.#watches, id);
    mapDelete(this.#byService, watch.service);
    if (!mapSize(this.#watches)) {
      this.#tableObserved = undefined;
      this.#drainMore = false;
    }
    return 0;
  }

  /** Forget every id without service calls; the session's close releases subscriptions. */
  drop(): void {
    this.#watches = new MapConstructor();
    this.#byService = new MapConstructor();
    this.#buffered = new MapConstructor();
    this.#errored = new MapConstructor();
    this.#ended = new MapConstructor();
    this.#activeCount = this.#observedCount = 0;
    this.#tableObserved = undefined;
    this.#drainMore = false;
  }

  #applyBatch(watch: Watch, batch: WatchBatch, generation: number): boolean {
    if (batch.kind === "closed") {
      this.#markEnded(watch);
      return true;
    }
    this.#setObserved(watch, generation);
    watch.queue = encodeBatch(batch);
    watch.head = 0;
    if (watch.queue.length) mapSet(this.#buffered, watch.id, watch);
    return false;
  }

  /** Drain ready watches in one service RPC. Returns true if drain is unsupported. */
  #drainService(): boolean {
    const generation = atomicsLoad(this.#fs.cells, 3);
    if (!this.#drainMore && this.#allObserved(generation)) return false;
    const previous = this.#tableObserved;
    this.#tableObserved = generation;
    let drained: WatchDrainResult;
    try {
      drained = this.#fs.drain!();
    } catch (error) {
      if (error instanceof FilesystemError && error.errno === ENOTSUP) {
        this.#tableObserved = undefined;
        this.#drainMore = false;
        if (this.#fs.canDrain === undefined) this.#noDrain = true;
        return true;
      }
      this.#tableObserved = previous;
      throw error;
    }
    this.#drainMore = drained.more;
    mapForEach(this.#errored, (watch) => {
      watch.errno = 0;
    });
    this.#errored = new MapConstructor();
    for (let index = 0; index < drained.entries.length; index++) {
      const entry = drained.entries[index]!;
      const watch = mapGet(this.#byService, entry.id);
      if (!watch || watch.ended) continue;
      if ("errno" in entry) {
        watch.errno = entry.errno;
        mapSet(this.#errored, watch.id, watch);
      } else {
        this.#applyBatch(watch, entry.batch, generation);
      }
    }
    return false;
  }

  #refillSingle(watch: Watch, force: boolean): GuestWatchRead | undefined {
    if (this.#fs.revoked) {
      if (this.#fs.remote) this.#revocationNotified = true;
      return failure(ECANCELED);
    }
    const generation = atomicsLoad(this.#fs.cells, 3);
    if (
      !force &&
      !this.#fs.remote &&
      (generation === watch.observed ||
        (this.#useDrain() && !this.#drainMore && generation === this.#tableObserved))
    )
      return failure(EAGAIN);
    if (this.#applyBatch(watch, this.#fs.read(watch.service), generation)) return END;
    if (!watch.queue.length) return failure(EAGAIN);
  }

  #takeFrom(watch: Watch, capacity: number): GuestWatchRead {
    const records: Uint8Array[] = [];
    let length = 0;
    while (watch.head < watch.queue.length) {
      const record = watch.queue[watch.head]!;
      if (length + record.length > capacity) break;
      arrayAppend(records, record);
      length += record.length;
      watch.head++;
      if (record[0] === OVERFLOW) this.#markEnded(watch);
    }
    if (!length) return { kind: "short", needed: watch.queue[watch.head]!.length };
    if (watch.head === watch.queue.length) {
      watch.queue = [];
      watch.head = 0;
      mapDelete(this.#buffered, watch.id);
    }
    return { kind: "records", records, length };
  }
}

function encodeBatch(batch: Exclude<WatchBatch, { kind: "closed" }>): Uint8Array[] {
  if (batch.kind === "overflow") return [encodeRecord(OVERFLOW, null)];
  const records: Uint8Array[] = [];
  for (let index = 0; index < batch.events.length; index++) {
    const event = batch.events[index]!;
    arrayAppend(records, encodeRecord(event.type === "change" ? CHANGE : RENAME, event.name));
  }
  return records;
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
