import { allocateSharedControl } from "../memory/control.js";
import type { WalkPlan, WalkCursor, WalkPage, WalkPageOptions } from "./walk.js";
import { FilesystemWatch, type WatchOptions } from "./watch.js";
import { checkDirectoryPage } from "./directory-pages.js";
import { DirtyCapacityError } from "./dirty-admission.js";
import { ResidentAttachment, stopWorkspaceBridge } from "./publication-attachment.js";
import { localPublication } from "./publication-internal.js";
import {
  FilesystemRequestAllocator,
  FilesystemTransportSection,
  requestCells,
  requestBytes,
  requestCancelled,
  cancelRequestBuffer,
  releaseRequestBuffer,
  requestTransportError,
  closeRequestMemory,
  requestMemoryExhausted,
  REQUEST_CLIENT,
  REQUEST_INLINE_BYTES,
  REQUEST_SERVICE,
  type FilesystemRequestBuffer,
} from "./request-memory.js";
import {
  mutationIntent,
  type PublicationAdmission,
  type MutationIntent,
  type MutationId,
  type AdmissionResult,
} from "./publication.js";
import { permissionsFor, type WatchFileSystem } from "../core/filesystem.js";
import {
  ArrayBufferConstructor,
  Int32ArrayConstructor,
  RangeErrorConstructor,
  Uint8ArrayConstructor,
  symbolIterator,
  atomicsLoad,
  atomicsStore,
  atomicsAdd,
  atomicsCompareExchange,
  atomicsNotify,
  atomicsWait,
  atomicsWaitAsync,
  typedArrayLength,
  typedArraySet,
  typedArraySubarray,
  MapConstructor,
  SetConstructor,
  mapGet,
  mapSet,
  mapHas,
  mapDelete,
  mapClear,
  mapSize,
  mapForEach,
  setAdd,
  setHas,
  setDelete,
  setForEach,
  arrayAppend,
} from "../proc/intrinsics.ts";
import type {
  FileSystem,
  FileHandle,
  FileStat,
  DirectoryEntry,
  ResolvedPath,
} from "../core/index.js";
import {
  CAPABILITY_HEADER,
  CAPABILITY_LENGTH,
  CAPABILITY_SLOTS,
  CAPABILITY_WORDS,
  HEADER,
  PAGE,
  TRANSIENT_HANDLES,
  State,
  FilesystemError,
  FilesystemSection,
  createFilesystemIdentity,
  errno,
  isRevoked,
  pack,
  reapFilesystem,
  unpack,
  wake,
  releaseFilesystemReservation,
  type FilesystemIdentity,
  type FilesystemReservation,
  type FilesystemConnection,
} from "./protocol.js";
import {
  MissingDataError,
  MissingSegmentError,
  SharedFilesystemState,
  fixedWriteSources,
  sharedRevoked,
} from "./shared.js";

export interface BorrowedResolvedPath {
  readonly path: Readonly<ResolvedPath>;
  release(): void;
}

export interface WriteFileOptions {
  /** Append bytes instead of replacing the existing file. */
  append?: boolean;
  /** Fail with EEXIST when the path already names a file or directory. */
  exclusive?: boolean;
}
export type WriteFileMode = boolean | WriteFileOptions;

export function resolveWriteFileMode(mode: WriteFileMode = false): {
  append: boolean;
  exclusive: boolean;
} {
  if (typeof mode === "boolean") return { append: mode, exclusive: false };
  const append = mode.append ?? false;
  const exclusive = mode.exclusive ?? false;
  if (append && exclusive) throw new TypeError("writeFile cannot append and create exclusively");
  return { append, exclusive };
}

/** Physical response room is at most one page; a larger result completes through overflow. */
function validateResponseCapacity(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new FilesystemError(28);
  return capacity;
}
function privateInput(
  length: number,
  input: Uint8Array,
  data: Uint8Array,
  inputLength: number,
): ArrayBuffer {
  let payload: ArrayBuffer;
  try {
    payload = new ArrayBufferConstructor(length);
  } catch (error) {
    if (error instanceof RangeErrorConstructor) throw requestMemoryExhausted();
    throw error;
  }
  const bytes = new Uint8ArrayConstructor(payload);
  typedArraySet(bytes, input);
  typedArraySet(bytes, data, inputLength);
  return payload;
}
/** A transfer list whose conversion never reaches a guest-replaceable array iterator. */
function transferList(payload: ArrayBuffer): Transferable[] {
  let done = false;
  const iterator = {
    __proto__: null,
    next() {
      const value = done ? undefined : payload;
      const result = { __proto__: null, done, value };
      done = true;
      return result;
    },
  };
  return { __proto__: null, [symbolIterator]: () => iterator } as unknown as Transferable[];
}

export class FilesystemCompletion {
  readonly cells: Int32Array;
  private changed: (() => void)[] = [];
  private cancellations = new SetConstructor<() => void>();
  private decoded: unknown;
  private loading?: Promise<unknown>;
  private consumed = false;
  constructor(
    readonly id: number,
    readonly buffer: FilesystemRequestBuffer,
    private client: FilesystemClient,
    readonly publication?: PublicationAdmission,
  ) {
    this.cells = requestCells(buffer);
  }
  get ready(): boolean {
    return (
      !!this.client.transportError() ||
      isRevoked(this.client.connection) ||
      requestCancelled(this.buffer) ||
      atomicsLoad(this.cells, 0) !== State.Pending
    );
  }
  get epoch(): number {
    return this.cells[5]!;
  }
  notify(): void {
    const changed = this.changed;
    this.changed = [];
    for (let index = 0; index < changed.length; index++) changed[index]!();
  }
  cancel(): void {
    if (this.publication) this.client.cancelPublication(this.publication);
    if (requestCancelled(this.buffer)) {
      this.notify();
      return;
    }
    cancelRequestBuffer(this.buffer);
    atomicsNotify(this.cells, 0);
    wake(this.client.connection);
    this.client.connection.port.postMessage({ discard: this.id });
    setForEach(this.cancellations, (cancel) => cancel());
    this.cancellations = new SetConstructor();
    this.notify();
  }
  release(): void {
    // Shared state can be ready before its port notification wakes value(). An unconsumed
    // release cancels that value and notifies its waiters before removing the completion.
    if (!this.consumed) this.cancel();
    else this.client.connection.port.postMessage({ discard: this.id });
    mapDelete(this.client.completions, this.id);
    releaseRequestBuffer(this.buffer, REQUEST_CLIENT);
    if (!mapSize(this.client.completions)) wake(this.client.connection);
  }
  /** Release a ready result that the caller does not need, while still delivering failures.
   * This never waits, decodes bytes or requests an overflow transfer. */
  releaseReady(): void {
    if (!this.ready) throw new FilesystemError(6);
    try {
      this.check();
      this.consumed = true;
    } finally {
      this.release();
    }
  }
  /** Release a staged write after this client committed it. Committing is the only use of that
   * completion, and the discard posted here asks the owner to apply the write. */
  releaseCommitted(): void {
    this.consumed = true;
    this.release();
  }
  private check(): void {
    const failure = this.client.transportError();
    if (failure) throw failure;
    if (
      isRevoked(this.client.connection) ||
      requestCancelled(this.buffer) ||
      this.cells[0] === State.Cancelled
    )
      throw new FilesystemError(11);
    if (this.cells[0] === State.Failed) throw new FilesystemError(this.cells[3]!);
  }
  private decode(bytes: Uint8Array): unknown {
    return this.cells[4] ? bytes : unpack(bytes);
  }
  private inlineBytes(): Uint8Array {
    const size = this.cells[2]!;
    const available = Math.min(size, this.buffer.length - HEADER);
    return new Uint8ArrayConstructor(typedArraySubarray(requestBytes(this.buffer), 0, available));
  }
  wait(): any {
    const signal = new Int32ArrayConstructor(this.client.connection.signal);
    while (!this.ready) {
      const observed = atomicsLoad(signal, 0);
      this.check();
      if (!this.ready) atomicsWait(signal, 0, observed);
    }
    this.check();
    if (this.consumed) return this.decoded;
    const size = this.cells[2]!;
    let bytes = this.inlineBytes();
    if (this.cells[0] === State.Overflow) {
      bytes = new Uint8ArrayConstructor(size);
      for (let at = 0; at < size; at += PAGE)
        bytes.set(this.client.call("take", [this.id, at, PAGE]), at);
    }
    this.check();
    this.decoded = this.decode(bytes);
    this.consumed = true;
    return this.decoded;
  }
  async value(): Promise<any> {
    if (!this.ready)
      await new Promise<void>((resolve) => {
        arrayAppend(this.changed, resolve);
        this.client.watchRevocation();
        // The response may have arrived between the check and registration.
        if (this.ready) this.notify();
      });
    this.check();
    if (this.consumed) return this.decoded;
    // All waiters consume the same overflow transfer; the final take deletes the stored bytes.
    return (this.loading ??= this.load());
  }
  private async load(): Promise<unknown> {
    const size = this.cells[2]!;
    let bytes = this.inlineBytes();
    if (this.cells[0] === State.Overflow) {
      bytes = new Uint8ArrayConstructor(size);
      for (let at = 0; at < size; at += PAGE) {
        const part = this.client.submit("take", [this.id, at, PAGE]);
        const cancel = () => part.cancel();
        setAdd(this.cancellations, cancel);
        try {
          this.check();
          bytes.set(await part.value(), at);
        } finally {
          setDelete(this.cancellations, cancel);
          part.release();
        }
      }
    }
    this.check();
    this.decoded = this.decode(bytes);
    this.consumed = true;
    return this.decoded;
  }
}
/** A write the owner is holding for this client. `bytes` is the client's own copy: a retry
 * commits the stage only when it still carries exactly these bytes for the same place. */
interface StagedPreparation {
  kind: "write";
  completion: FilesystemCompletion;
  offset: number;
  append: boolean;
  bytes: Uint8Array;
}
/** A private copy of the first bytes of a write, at most one transport page. */
function stagedBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (let i = 0; i < chunks.length; i++) length = Math.min(PAGE, length + chunks[i]!.length);
  const bytes = new Uint8ArrayConstructor(length);
  let at = 0;
  for (let i = 0; i < chunks.length && at < length; i++) {
    const chunk = chunks[i]!;
    const count = Math.min(chunk.length, length - at);
    typedArraySet(bytes, new Uint8ArrayConstructor(chunk.buffer, chunk.byteOffset, count), at);
    at += count;
  }
  return bytes;
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}
/** Copies `bytes` into the iovecs, starting `skip` bytes into their combined range. */
function copyReadAt(chunks: readonly Uint8Array[], bytes: Uint8Array, skip: number): void {
  let source = 0;
  for (let i = 0; i < chunks.length && source < bytes.length; i++) {
    const chunk = chunks[i]!;
    const start = Math.min(skip, chunk.length);
    skip -= start;
    const count = Math.min(chunk.length - start, bytes.length - source);
    if (count > 0) typedArraySet(chunk, bytes.subarray(source, source + count), start);
    source += Math.max(0, count);
  }
}
function preparationFailed(completion: FilesystemCompletion | undefined): boolean {
  const state = completion?.cells[0];
  return state === State.Failed || state === State.Cancelled;
}
/** Blocking watch calls for a synchronous guest; each one is a service round trip. */
function clientWatches(
  cells: () => Int32Array,
  revoked: () => boolean,
  call: (operation: string, args: unknown[]) => any,
): WatchFileSystem {
  return {
    get cells() {
      return cells();
    },
    get revoked() {
      return revoked();
    },
    open: (handle, recursive) => call("watchOpen", [handle, recursive]),
    read: (id) => call("watchRead", [id]),
    close: (id) => {
      call("watchClose", [id]);
    },
  };
}

/** Blocking preview1 adapter and non-blocking request/completion API for the async host.
 * Read/stat caches are validated by the service's global seqlock. A concurrent mutation invalidates
 * before changing data; a cached read that overlaps it is discarded, never returned as fresh.
 */
export interface FilesystemClientOptions {
  /** Trusted host capability; never included in a serialized connection or supplied to a guest. */
  readonly connect?: (identity: FilesystemIdentity) => FilesystemConnection;
}
export class FilesystemClient implements FileSystem {
  readonly completions = new MapConstructor<number, FilesystemCompletion>();
  private readonly requests: FilesystemRequestAllocator;
  private reads = new Map<number, { offset: number; bytes: Uint8Array; epoch: number }>();
  private stats = new Map<number, { stat: FileStat; epoch: number }>();
  private paths = new Map<string, { path: ResolvedPath | number; epoch: number }>();
  private readdirs = new Map<number, { entries: DirectoryEntry[]; epoch: number }>();
  private openHandles = new MapConstructor<number, number>();
  // Shared slots of open regular files: a live handle never changes slot, and direct I/O
  // rechecks the slot's handle under its file lock.
  private fileSlots = new MapConstructor<number, number>();
  // Preparation owns no guest buffers and never writes file bytes. Only a successful try* retry
  // commits I/O; preparation selects cold bytes or reserves write capacity.
  private ioPreparations = new MapConstructor<
    number,
    | { kind: "prepare"; completion: FilesystemCompletion }
    | {
        kind: "read";
        completion: FilesystemCompletion;
        offset: number;
        length: number;
        revision: number | undefined;
      }
  >();
  // One staged write per handle, apart from ioPreparations: a read or a readiness probe on the
  // same handle consumes or replaces those, and must never withdraw a write waiting to commit.
  private stagedWrites = new MapConstructor<number, StagedPreparation>();
  // Handles whose last immediate write had to be staged. Right after such a write commits, the
  // file waits one owner turn for its apply. The next write then stages at once, instead of
  // first asking for growth and staging on the retry after that. Only a hint: a wrong one costs
  // a stage the direct path then makes unnecessary.
  private stagedHandles = new SetConstructor<number>();
  private capabilityEntries = new MapConstructor<number, number>();
  private capabilities: Int32Array;
  private epoch: Int32Array;
  private revoked: () => boolean;
  private readonly section: FilesystemSection;
  readonly shared: SharedFilesystemState;
  readonly watches: WatchFileSystem;
  private watchingRevocation = false;
  private resident: ResidentAttachment | undefined;
  private workspaceStop: Promise<void> | undefined;
  constructor(
    readonly connection: FilesystemConnection,
    private readonly options: FilesystemClientOptions = {},
  ) {
    this.requests = new FilesystemRequestAllocator(connection.requests);
    this.capabilities = new Int32ArrayConstructor(connection.capabilities, 0, CAPABILITY_LENGTH);
    this.epoch = new Int32ArrayConstructor(connection.epoch);
    const revoked = sharedRevoked(connection);
    this.revoked = () => revoked() || !!this.transportError();
    if (connection.residentPublication)
      this.resident = new ResidentAttachment(connection.residentPublication, this.revoked);
    this.section = new FilesystemTransportSection(connection, this.requests.memory, this.revoked);
    this.shared = new SharedFilesystemState(
      connection.shared,
      connection.maxBytes,
      connection.owner,
      connection.segments,
      this.section,
      connection.publication?.buffers,
    );
    this.watches = clientWatches(
      () => this.shared.watch.cells,
      this.revoked,
      (operation, args) => this.call(operation, args),
    );
    connection.port.onmessage = ({ data }) => {
      if (data.segment) this.attachSegment(data.segment, data.buffer);
      else mapGet(this.completions, data.completed)?.notify();
    };
    connection.port.onmessageerror = () => {
      closeRequestMemory(this.requests.memory);
      wake(connection);
      mapForEach(this.completions, (completion) => completion.notify());
      connection.port.postMessage({ transportClosed: true });
      connection.port.close();
    };
    connection.port.start();
  }
  transportError() {
    return requestTransportError(this.requests.memory);
  }
  /** An announced segment only makes later access direct. Nothing waits for it: until it
   * arrives, and for an agent that never returns to its event loop, the owner serves those
   * pages. The connection's directory is filled too, so later forks start with the segment. */
  private attachSegment(index: number, buffer: SharedArrayBuffer): void {
    this.shared.addSegment(buffer, index);
    this.connection.segments[index - 1] ??= this.shared.segments[index]!;
  }
  async attachResidentPublication(): Promise<void> {
    await this.resident?.attach();
    if (this.connection.residentPublication?.kind === "workspace")
      await this.asyncCall("workspaceBind", [this.residentPublicationClient().session]);
  }
  private beginWorkspaceStop(): Promise<void> | undefined {
    if (this.connection.residentPublication?.kind !== "workspace") return;
    if (!this.workspaceStop) {
      this.workspaceStop = stopWorkspaceBridge(this.connection);
      void this.workspaceStop.catch(() => {});
    }
    return this.workspaceStop;
  }
  async stopResidentPublication(): Promise<void> {
    this.resident?.invalidate();
    await this.beginWorkspaceStop();
    await this.resident?.stop();
  }
  residentPublicationClient() {
    const client = this.resident?.client;
    if (!client) throw new FilesystemError(6);
    return client;
  }
  /** A single shared-signal waiter handles service death without a port completion message.
   * Normal replies still use the port; the watcher exits when the last completion is released.
   */
  watchRevocation(): void {
    if (this.watchingRevocation) return;
    this.watchingRevocation = true;
    void this.monitorRevocation();
  }
  private async monitorRevocation(): Promise<void> {
    const signal = new Int32ArrayConstructor(this.connection.signal);
    try {
      while (mapSize(this.completions)) {
        const observed = atomicsLoad(signal, 0);
        if (this.revoked()) {
          mapForEach(this.completions, (completion) => completion.cancel());
          return;
        }
        const waiting = atomicsWaitAsync(signal, 0, observed);
        if (waiting.async) await waiting.value;
      }
    } finally {
      this.watchingRevocation = false;
    }
  }
  fork(): FilesystemConnection {
    const failure = this.transportError();
    if (failure) throw failure;
    if (this.revoked()) throw new FilesystemError(11);
    const connect = this.options.connect;
    if (!connect) throw new FilesystemError(58, "filesystem fork requires a host connector");
    this.section.enter();
    try {
      return connect(createFilesystemIdentity(this.connection));
    } finally {
      this.section.exit();
    }
  }
  /** Keep source admission held until the spawn notification has been published. */
  beginTransfer(): () => void {
    this.section.enter();
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.section.exit();
      }
    };
  }
  reserve(handle: FileHandle, target: FilesystemIdentity): FilesystemReservation {
    this.section.enter();
    try {
      if (isRevoked(target)) throw new FilesystemError(11);
      this.retain(handle);
      try {
        const sourceKey = this.capabilityEntry(handle)!;
        const entries = new Int32ArrayConstructor(target.capabilities, 0, CAPABILITY_LENGTH);
        let targetKey = CAPABILITY_HEADER;
        while (
          targetKey < typedArrayLength(entries) &&
          atomicsLoad(entries, targetKey + 1) >= 0 &&
          atomicsLoad(entries, targetKey) !== handle
        )
          targetKey += CAPABILITY_WORDS;
        if (targetKey >= typedArrayLength(entries)) throw new FilesystemError(51);
        const reservation: FilesystemReservation = {
          handle,
          source: this.connection.capabilities,
          sourceKey,
          target: target.capabilities,
          targetKey,
          targetOwner: target.owner,
          state: allocateSharedControl(8),
        };
        atomicsAdd(this.capabilities, sourceKey + 2, 1);
        atomicsStore(entries, targetKey, handle);
        atomicsStore(entries, targetKey + 2, 0);
        const previous = atomicsLoad(entries, targetKey + 1);
        atomicsStore(entries, targetKey + 1, previous < 0 ? 1 : previous + 1);
        arrayAppend(target.reservations, reservation);
        return reservation;
      } finally {
        this.release(handle);
      }
    } finally {
      this.section.exit();
    }
  }
  /** Import the already-owned reference, not another retain. */
  adopt(reservation: FilesystemReservation): void {
    if (atomicsLoad(new Int32ArrayConstructor(reservation.state), 0)) return;
    mapSet(
      this.openHandles,
      reservation.handle,
      (mapGet(this.openHandles, reservation.handle) ?? 0) + 1,
    );
    mapSet(this.capabilityEntries, reservation.handle, reservation.targetKey);
  }
  releaseReservation(reservation: FilesystemReservation): void {
    const state = new Int32ArrayConstructor(reservation.state);
    const wasClosed = atomicsLoad(state, 0);
    releaseFilesystemReservation(reservation);
    if (!wasClosed) {
      const count = mapGet(this.openHandles, reservation.handle) ?? 0;
      if (count > 1) mapSet(this.openHandles, reservation.handle, count - 1);
      else {
        mapDelete(this.openHandles, reservation.handle);
        mapDelete(this.fileSlots, reservation.handle);
        this.closeIO(reservation.handle);
      }
    }
    this.connection.port.postMessage({ trim: true });
    this.sweep();
  }
  sweep(): void {
    this.connection.port.postMessage({ sweep: true });
  }
  [localPublication](
    operation: string,
    args: readonly unknown[],
    data: Uint8Array,
    id?: MutationId,
  ): AdmissionResult {
    if (this.revoked()) throw new FilesystemError(11);
    const domain = this.shared.publication,
      connection = this.connection.publication;
    if (!domain || !connection) throw new FilesystemError(58);
    const intent = mutationIntent(operation, args);
    if (!intent) throw new FilesystemError(28);
    return domain.admit(connection.session, id ?? domain.next(connection.session), intent, data);
  }
  submit(
    operation: string,
    args: unknown[] = [],
    data: Uint8Array = new Uint8ArrayConstructor(),
    capacity = operation === "read" ||
    operation === "take" ||
    operation === "readdir" ||
    operation === "walkPage"
      ? PAGE
      : 1024,
    publication?: PublicationAdmission,
  ): FilesystemCompletion {
    const failure = this.transportError();
    if (failure) throw failure;
    if (this.revoked()) throw new FilesystemError(11);
    if (this.resident && this.connection.residentPublication?.kind !== "workspace")
      throw new FilesystemError(58, "resident grant namespace is unsupported");
    if (this.resident && !this.resident.client) throw new FilesystemError(6);
    this.checkWorkspaceBounds(args, data);
    const domain = this.shared.publication;
    const connection = this.connection.publication;
    const intent = domain ? mutationIntent(operation, args) : undefined;
    if (domain && connection && intent && !publication) {
      const admitted = domain.admit(
        connection.session,
        domain.next(connection.session),
        intent,
        data,
      );
      if (admitted.kind !== "admitted") throw new FilesystemError(29);
      publication = admitted.admission;
      data = admitted.input;
    }
    if (domain && connection && intent && publication)
      domain.verify(connection.session, publication, intent, data);
    try {
      return this.submitPrepared(operation, args, data, capacity, publication);
    } catch (error) {
      if (publication && connection) domain!.cancel(connection.session, publication);
      throw error;
    }
  }
  private checkWorkspaceBounds(args: unknown[], data: Uint8Array): void {
    if (this.connection.residentPublication?.kind !== "workspace") return;
    if (mapSize(this.completions) >= 16 || data.length > PAGE || pack(args).length > 8192)
      throw new FilesystemError(6);
  }
  private submitPrepared(
    operation: string,
    args: unknown[],
    data: Uint8Array,
    capacity: number,
    publication?: PublicationAdmission,
  ): FilesystemCompletion {
    const input = pack({ operation, args, publication });
    this.section.enter();
    try {
      return this.postRequest(input, data, capacity, publication);
    } finally {
      this.section.exit();
    }
  }
  private postRequest(
    input: Uint8Array,
    data: Uint8Array,
    capacity: number,
    publication?: PublicationAdmission,
  ): FilesystemCompletion {
    const inputLength = typedArrayLength(input);
    const total = inputLength + typedArrayLength(data);
    const privateLength = total > REQUEST_INLINE_BYTES ? total : 0;
    const room = Math.min(validateResponseCapacity(capacity), PAGE);
    const buffer = this.requests.allocate(
      privateLength ? room : Math.max(total, room),
      privateLength,
    );
    try {
      const completion = new FilesystemCompletion(buffer.id, buffer, this, publication);
      completion.cells[1] = inputLength;
      completion.cells[2] = total - inputLength;
      const descriptor = {
        id: completion.id,
        generation: buffer.memory.generation,
        offset: buffer.offset,
        length: buffer.length,
      };
      if (!privateLength) {
        typedArraySet(requestBytes(buffer), input);
        typedArraySet(requestBytes(buffer), data, inputLength);
        mapSet(this.completions, completion.id, completion);
        this.connection.port.postMessage(descriptor);
        return completion;
      }
      const payload = privateInput(privateLength, input, data, inputLength);
      mapSet(this.completions, completion.id, completion);
      this.connection.port.postMessage({ ...descriptor, payload }, transferList(payload));
      return completion;
    } catch (error) {
      mapDelete(this.completions, buffer.id);
      releaseRequestBuffer(buffer, REQUEST_CLIENT);
      releaseRequestBuffer(buffer, REQUEST_SERVICE);
      throw error;
    }
  }

  cancelPublication(admission: PublicationAdmission): void {
    const connection = this.connection.publication;
    if (connection) this.shared.publication!.cancel(connection.session, admission);
  }
  readiness(id: number): { kind: 3; id: number; ready: boolean } | undefined {
    const completion = mapGet(this.completions, id);
    return completion && { kind: 3, id, ready: completion.ready };
  }
  call(operation: string, args: unknown[] = [], data?: Uint8Array): any {
    const completion = this.submit(operation, args, data);
    try {
      return completion.wait();
    } finally {
      completion.release();
    }
  }
  async asyncCall(
    operation: string,
    args: unknown[] = [],
    data?: Uint8Array,
    publication?: PublicationAdmission,
  ): Promise<any> {
    const completion = this.submit(operation, args, data, undefined, publication);
    try {
      return await completion.value();
    } finally {
      completion.release();
    }
  }
  private readonly watchers = new SetConstructor<FilesystemWatch>();
  async watch(handle: FileHandle, options: WatchOptions = {}): Promise<FilesystemWatch> {
    if (options.signal?.aborted) throw new FilesystemError(11);
    const id: number = await this.asyncCall("watchOpen", [handle, options.recursive ?? false]);
    if (isRevoked(this.connection)) throw new FilesystemError(11);
    const watcher = new FilesystemWatch(this, id, options.signal, (closed) =>
      setDelete(this.watchers, closed),
    );
    if (!options.signal?.aborted) setAdd(this.watchers, watcher);
    return watcher;
  }
  dispose(): void {
    this.resident?.invalidate();
    this.beginWorkspaceStop();
    // The disposing agent is quiescent: no synchronous file operation can be active here.
    reapFilesystem(this.connection);
    setForEach(this.watchers, (watcher) => {
      void watcher.close();
    });
    mapForEach(this.completions, (completion) => completion.release());
    mapClear(this.completions);
    mapClear(this.ioPreparations);
    mapClear(this.stagedWrites);
    this.stagedHandles = new SetConstructor();
    this.reads.clear();
    this.stats.clear();
    this.paths.clear();
    this.readdirs.clear();
    mapClear(this.openHandles);
    mapClear(this.fileSlots);
    mapClear(this.capabilityEntries);
    this.sweep();
    this.connection.port.close();
  }
  private version(): number {
    if (this.revoked()) throw new FilesystemError(11);
    return atomicsLoad(this.epoch, 0);
  }
  preopen(path: string): FileHandle {
    return this.call("preopen", [path]);
  }
  private capabilityEntry(handle: FileHandle): number | undefined {
    const cached = mapGet(this.capabilityEntries, handle);
    if (
      cached !== undefined &&
      atomicsLoad(this.capabilities, cached) === handle &&
      atomicsLoad(this.capabilities, cached + 1) >= 0
    )
      return cached;
    mapDelete(this.capabilityEntries, handle);
    for (
      let key = CAPABILITY_HEADER;
      key < typedArrayLength(this.capabilities);
      key += CAPABILITY_WORDS
    ) {
      if (
        atomicsLoad(this.capabilities, key) === handle &&
        atomicsLoad(this.capabilities, key + 1) >= 0
      )
        return key;
    }
    return undefined;
  }
  private dropReference(key: number): number {
    for (;;) {
      const count = atomicsLoad(this.capabilities, key + 1);
      if (count <= 0) return count;
      if (atomicsCompareExchange(this.capabilities, key + 1, count, count - 1) !== count) continue;
      if (
        count === 1 &&
        !this.revoked() &&
        ((!this.resident && this.shared.isUnlinked(atomicsLoad(this.capabilities, key))) ||
          atomicsLoad(this.capabilities, 0) > TRANSIENT_HANDLES)
      )
        this.connection.port.postMessage({ trim: true });
      return count - 1;
    }
  }
  retain(handle: FileHandle): void {
    this.section.enter();
    try {
      if (!Number.isInteger(handle) || handle < 0) throw new FilesystemError(8);
      for (;;) {
        if (this.revoked()) throw new FilesystemError(11);
        const key = this.capabilityEntry(handle);
        if (key === undefined) throw new FilesystemError(8);
        const count = atomicsLoad(this.capabilities, key + 1);
        if (count < 0 || atomicsLoad(this.capabilities, key) !== handle) continue;
        if (count === 0x7fffffff) throw new FilesystemError(33);
        if (atomicsCompareExchange(this.capabilities, key + 1, count, count + 1) !== count)
          continue;
        // An idle entry may have been evicted and reassigned between the key read and CAS.
        // Our temporary reference prevents further reuse while we validate its identity.
        if (atomicsLoad(this.capabilities, key) !== handle) {
          this.dropReference(key);
          continue;
        }
        if (this.revoked()) {
          this.dropReference(key);
          throw new FilesystemError(11);
        }
        mapSet(this.capabilityEntries, handle, key);
        mapSet(this.openHandles, handle, (mapGet(this.openHandles, handle) ?? 0) + 1);
        if (mapSize(this.capabilityEntries) > CAPABILITY_SLOTS)
          mapForEach(this.capabilityEntries, (entry, cachedHandle) => {
            if (
              !mapHas(this.openHandles, cachedHandle) &&
              (atomicsLoad(this.capabilities, entry) !== cachedHandle ||
                atomicsLoad(this.capabilities, entry + 1) < 0)
            )
              mapDelete(this.capabilityEntries, cachedHandle);
          });
        return;
      }
    } finally {
      this.section.exit();
    }
  }
  release(handle: FileHandle): void {
    try {
      this.section.enter();
    } catch (error) {
      if (!(error instanceof FilesystemError) || error.errno !== 11) throw error;
      mapDelete(this.openHandles, handle);
      mapDelete(this.fileSlots, handle);
      this.closeIO(handle);
      return;
    }
    try {
      const count = mapGet(this.openHandles, handle) ?? 0;
      if (!count) throw new FilesystemError(8);
      const key = mapGet(this.capabilityEntries, handle)!;
      if (count > 1) mapSet(this.openHandles, handle, count - 1);
      else {
        mapDelete(this.openHandles, handle);
        mapDelete(this.fileSlots, handle);
        this.closeIO(handle);
      }
      // Keep linked zero-reference capabilities as a bounded cache. dropReference queues any
      // needed detached-file/budget trim without waiting for a worker acknowledgment.
      this.dropReference(key);
    } finally {
      this.section.exit();
    }
  }
  /** The shared slot of a regular file this connection holds open, or 0. */
  private directSlot(handle: FileHandle): number {
    const cached = mapGet(this.fileSlots, handle);
    if (cached !== undefined) return cached;
    if (!mapHas(this.openHandles, handle)) return 0;
    const slot = this.shared.fileSlot(handle);
    if (slot) mapSet(this.fileSlots, handle, slot);
    return slot;
  }
  private directFailure(handle: FileHandle, error: unknown): number {
    if (error instanceof FilesystemError && error.errno === 8) mapDelete(this.fileSlots, handle);
    return errno(error);
  }
  private cancelIO(handle: FileHandle): void {
    const pending = mapGet(this.ioPreparations, handle);
    if (!pending) return;
    mapDelete(this.ioPreparations, handle);
    pending.completion.release();
  }
  /** The last local reference to a handle is gone: nothing prepared for it may outlive it. */
  private closeIO(handle: FileHandle): void {
    this.cancelIO(handle);
    this.cancelStage(handle);
    setDelete(this.stagedHandles, handle);
  }
  /** Withdraws an uncommitted staged write. The owner drops its copy and nothing changed. */
  private cancelStage(handle: FileHandle): void {
    const stage = mapGet(this.stagedWrites, handle);
    if (!stage) return;
    mapDelete(this.stagedWrites, handle);
    stage.completion.release();
  }
  private preparedIO(handle: FileHandle): boolean {
    const pending = mapGet(this.ioPreparations, handle);
    if (!pending) return true;
    if (pending.kind === "read") {
      this.cancelIO(handle);
      return true;
    }
    const completion = pending.completion;
    if (!completion.ready) return false;
    mapDelete(this.ioPreparations, handle);
    // Inspect shared completion state even while poll owns the worker, before the port callback
    // can run. No wait(), async continuation or overflow transfer is needed for preparation.
    completion.releaseReady();
    return true;
  }
  /** The writer's view of both preparations. False means one is still running: EAGAIN, and
   * nothing new is submitted. A staged write that finished stays for the retry to commit; one
   * that failed or was cancelled is cleared here and throws its errno once. */
  private preparedWrite(handle: FileHandle): boolean {
    if (!this.preparedIO(handle)) return false;
    const stage = mapGet(this.stagedWrites, handle);
    if (!stage) return true;
    if (!stage.completion.ready) return false;
    if (atomicsLoad(stage.completion.cells, 0) === State.Complete) return true;
    mapDelete(this.stagedWrites, handle);
    stage.completion.releaseReady();
    return true;
  }
  private submitStage(handle: FileHandle, offset: number, append: boolean, bytes: Uint8Array) {
    this.cancelStage(handle);
    const completion = this.submit("stageWrite", [handle, offset, append], bytes);
    mapSet(this.stagedWrites, handle, { kind: "write", completion, offset, append, bytes });
  }
  /** An immediate write whose target pages are in a segment this agent lacks. The first call
   * hands a private copy to the owner and returns EAGAIN with nothing changed and no iovec kept.
   * A retry that still carries the same bytes for the same place commits that stage itself, in
   * attached metadata, and returns its count. Anything else prepares again: other bytes, or a
   * commit that found the file waiting for the owner, not loaded, too small or reader-pinned. */
  private stagedIO(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    append: boolean,
    admission?: PublicationAdmission,
  ): { written: number; offset: number } | number {
    const bytes = stagedBytes(chunks);
    const stage = mapGet(this.stagedWrites, handle);
    const matches =
      stage !== undefined &&
      stage.append === append &&
      (append || stage.offset === offset) &&
      sameBytes(stage.bytes, bytes);
    const end = matches
      ? this.shared.commitStagedWrite(
          slot,
          handle,
          stage.completion.cells,
          stage.bytes,
          append,
          offset,
          this.epoch,
          this.revoked,
          this.connection.owner,
          admission,
        )
      : undefined;
    if (stage && end !== undefined) {
      mapDelete(this.stagedWrites, handle);
      stage.completion.releaseCommitted();
      return append ? { written: bytes.length, offset: end } : bytes.length;
    }
    setAdd(this.stagedHandles, handle);
    this.submitStage(handle, offset, append, bytes);
    return -6;
  }
  /** A direct immediate write found the file not resident or too small. With a staged write
   * outstanding the owner does both jobs in one preparation; otherwise capacity is reserved. */
  private prepareWriteIO(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    append: boolean,
    size: number,
  ): number {
    if (mapHas(this.stagedWrites, handle) || setHas(this.stagedHandles, handle))
      this.submitStage(handle, offset, append, stagedBytes(chunks));
    else this.prepareIO(handle, { kind: "grow", size });
    return -6;
  }
  /** A direct immediate write was accepted, so a stage for this handle is no longer needed. */
  private wroteDirectly(handle: FileHandle): void {
    this.cancelStage(handle);
    setDelete(this.stagedHandles, handle);
  }
  /** EAGAIN keeps a staged write for the next retry. Any other failure withdraws it. */
  private immediateFailure(handle: FileHandle, error: unknown): number {
    const code = this.directFailure(handle, error);
    if (code !== 6) this.cancelStage(handle);
    return code;
  }
  private prepareIO(handle: FileHandle, intent: { kind: "grow"; size: number }): void {
    if (mapHas(this.ioPreparations, handle)) return;
    const completion = this.submit("grow", [handle, intent.size]);
    mapSet(this.ioPreparations, handle, { kind: "prepare", completion });
  }
  private prepareReadIO(handle: FileHandle, offset: number, length: number): void {
    if (mapHas(this.ioPreparations, handle)) return;
    const revision = this.shared.revision(handle, true, this.revoked, this.connection.owner);
    const completion = this.submit("read", [handle, Math.min(PAGE, length), offset]);
    mapSet(this.ioPreparations, handle, {
      kind: "read",
      completion,
      offset,
      length: Math.min(PAGE, length),
      revision,
    });
  }
  private preparedRead(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
  ): number | undefined {
    const pending = mapGet(this.ioPreparations, handle);
    if (pending?.kind !== "read") return;
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (
      pending.offset !== offset ||
      pending.length < Math.min(PAGE, length) ||
      pending.revision !== this.shared.revision(handle, true, this.revoked, this.connection.owner)
    ) {
      this.cancelIO(handle);
      return;
    }
    const completion = pending.completion;
    if (!completion.ready) return -6;
    mapDelete(this.ioPreparations, handle);
    try {
      const count = completion.cells[2]!;
      if (completion.cells[0] !== State.Complete || !completion.cells[4] || count > pending.length)
        throw new FilesystemError(29);
      const bytes: Uint8Array = completion.wait();
      return this.copyReadResult(chunks, bytes.subarray(0, Math.min(count, length)));
    } finally {
      completion.release();
    }
  }
  private copyReadResult(chunks: readonly Uint8Array[], bytes: Uint8Array): number {
    let at = 0;
    for (const chunk of chunks) {
      const count = Math.min(chunk.length, bytes.length - at);
      if (count <= 0) break;
      typedArraySet(chunk, bytes.subarray(at, at + count));
      at += count;
    }
    return at;
  }
  /** Blocking read of bytes this agent cannot reach, in owner requests of one transport page.
   * The file's revision only moves forward, so a reply taken between two equal samples is that
   * revision's content. Only such a reply is copied out, which makes the returned prefix one
   * revision's bytes:
   * - a change before any progress asks again, so a race is never reported as end of file;
   * - a change or an error after progress returns the bytes already delivered;
   * - an error before progress returns that errno with every destination unchanged;
   * - a reply shorter than its request is the end of the file. */
  private readThroughOwner(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
  ): number {
    let wanted = 0;
    for (let i = 0; i < chunks.length; i++) wanted += chunks[i]!.length;
    let delivered = 0;
    try {
      let revision = this.shared.revision(handle, false, this.revoked, this.connection.owner);
      while (delivered < wanted) {
        const requested = Math.min(PAGE, wanted - delivered);
        const bytes: Uint8Array = this.call("read", [handle, requested, offset + delivered]);
        const current = this.shared.revision(handle, false, this.revoked, this.connection.owner);
        if (current !== revision && delivered) return delivered;
        if (current !== revision) {
          revision = current;
          continue;
        }
        copyReadAt(chunks, bytes, delivered);
        delivered += bytes.length;
        if (bytes.length < requested) return delivered;
      }
      return delivered;
    } catch (error) {
      return delivered || -errno(error);
    }
  }
  /** A file whose bytes are not resident: one bounded owner read, under one file lock at the
   * owner. A cold file is read as a range and is not loaded whole, so this stays a short read. */
  private readUnloaded(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    try {
      let requested = 0;
      for (let i = 0; i < chunks.length; i++) requested += chunks[i]!.length;
      const bytes: Uint8Array = this.call("read", [handle, Math.min(PAGE, requested), offset]);
      return this.copyReadResult(chunks, bytes);
    } catch (failure) {
      return -errno(failure);
    }
  }
  private residentIO<T>(action: () => T): T | number {
    try {
      this.section.enter();
    } catch (error) {
      return -errno(error);
    }
    try {
      return action();
    } catch (error) {
      return -errno(error);
    } finally {
      this.section.exit();
    }
  }
  /** Nonblocking runtime_proc I/O. Never retain an iovec across an EAGAIN boundary. */
  tryRead(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    if (this.resident)
      return this.residentIO(() => this.resident?.client?.tryRead(handle, chunks, offset) ?? -6);
    if (!(offset >= 0)) return -28;
    try {
      const prepared = this.preparedRead(handle, chunks, offset);
      if (prepared !== undefined) return prepared;
      if (!this.preparedIO(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot) return -8;
      return this.shared.directRead(
        slot,
        handle,
        chunks,
        offset,
        this.revoked,
        this.connection.owner,
        true,
      );
    } catch (error) {
      if (error instanceof MissingDataError || error instanceof MissingSegmentError) {
        try {
          this.prepareReadIO(
            handle,
            offset,
            chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          );
          return -6;
        } catch (failure) {
          return -errno(failure);
        }
      }
      return -this.directFailure(handle, error);
    }
  }
  tryWrite(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    if (this.resident)
      return this.residentIO(() => this.resident?.client?.tryWrite(handle, chunks, offset) ?? -6);
    if (this.shared.publication) return this.publishedWrite(handle, chunks, offset, true);
    if (!(offset >= 0)) return -28;
    try {
      if (!this.preparedWrite(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot) return -8;
      chunks = fixedWriteSources(chunks);
      const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
      const written = this.immediateWrite(slot, handle, chunks, offset, total);
      if (written === "missing")
        return this.stagedIO(slot, handle, chunks, offset, false) as number;
      if (written === undefined)
        return this.prepareWriteIO(handle, chunks, offset, false, offset + total);
      // The segment arrived in the meantime, so a stage for this write is no longer needed.
      this.wroteDirectly(handle);
      return written;
    } catch (error) {
      return -this.immediateFailure(handle, error);
    }
  }
  /** The direct attempt of an immediate write. "missing" means a target page is in a segment
   * this agent lacks and nothing changed; undefined asks for the owner, as directWrite does. */
  private immediateWrite(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    total: number,
  ): number | undefined | "missing" {
    try {
      return this.shared.directWrite(
        slot,
        handle,
        chunks,
        offset,
        total,
        this.epoch,
        this.revoked,
        this.connection.owner,
        true,
      );
    } catch (error) {
      if (error instanceof MissingSegmentError) return "missing";
      throw error;
    }
  }
  tryAppend(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
  ): { written: number; offset: number } | number {
    if (this.resident)
      return this.residentIO(() => this.resident?.client?.tryAppend(handle, chunks) ?? -6);
    if (this.shared.publication) return this.publishedAppend(handle, chunks, true);
    try {
      if (!this.preparedWrite(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot) return -8;
      chunks = fixedWriteSources(chunks);
      const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
      const result = this.immediateAppend(slot, handle, chunks, total);
      if (result === "missing") return this.stagedIO(slot, handle, chunks, 0, true);
      if (typeof result === "number") return this.prepareWriteIO(handle, chunks, 0, true, result);
      this.wroteDirectly(handle);
      return result;
    } catch (error) {
      return -this.immediateFailure(handle, error);
    }
  }
  private immediateAppend(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    total: number,
  ): { written: number; offset: number } | number | "missing" {
    try {
      return this.shared.directAppend(
        slot,
        handle,
        chunks,
        total,
        this.epoch,
        this.revoked,
        this.connection.owner,
        true,
      );
    } catch (error) {
      if (error instanceof MissingSegmentError) return "missing";
      throw error;
    }
  }
  private publicationInput(chunks: readonly Uint8Array[], bound: number): Uint8Array {
    chunks = fixedWriteSources(chunks);
    let length = 0;
    for (const chunk of chunks) length = Math.min(bound, length + chunk.length);
    const bytes = new Uint8ArrayConstructor(length);
    let at = 0;
    for (const chunk of chunks) {
      const count = Math.min(chunk.length, length - at);
      if (!count) break;
      typedArraySet(bytes, new Uint8ArrayConstructor(chunk.buffer, chunk.byteOffset, count), at);
      at += count;
    }
    return bytes;
  }
  private publishedAppend(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    nonblocking: boolean,
  ): { written: number; offset: number } | number {
    const result = this.publicationIO(handle, chunks, 0, true, nonblocking);
    return result;
  }
  private publishedWrite(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    nonblocking: boolean,
  ): number {
    const result = this.publicationIO(handle, chunks, offset, false, nonblocking);
    return typeof result === "number" ? result : result.written;
  }
  private publicationIO(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    append: boolean,
    nonblocking: boolean,
  ): { written: number; offset: number } | number {
    const domain = this.shared.publication!,
      connection = this.connection.publication!;
    let admission: PublicationAdmission | undefined;
    try {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new FilesystemError(28);
      if (nonblocking && !this.preparedWrite(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot && nonblocking) return -8;
      // The admission covers exactly the bytes that commit. A retry of a staged write commits
      // the staged prefix, so it admits no more than that.
      const staged = nonblocking && mapHas(this.stagedWrites, handle);
      const bytes = this.publicationInput(
        chunks,
        staged ? Math.min(PAGE, domain.limits.inputBytes) : domain.limits.inputBytes,
      );
      const intent = append
        ? ({ kind: "append", handle } as const)
        : ({ kind: "write", handle, offset } as const);
      const admitted = domain.admit(
        connection.session,
        domain.next(connection.session),
        intent,
        bytes,
      );
      if (admitted.kind !== "admitted") throw new FilesystemError(29);
      admission = admitted.admission;
      return this.executePublicationIO(
        slot,
        handle,
        admitted.input,
        offset,
        append,
        nonblocking,
        admission,
      );
    } catch (error) {
      return -(nonblocking
        ? this.immediateFailure(handle, error)
        : this.directFailure(handle, error));
    } finally {
      if (admission) domain.cancel(connection.session, admission);
    }
  }
  private executePublicationIO(
    slot: number,
    handle: FileHandle,
    input: Uint8Array,
    offset: number,
    append: boolean,
    nonblocking: boolean,
    admission: PublicationAdmission,
  ): { written: number; offset: number } | number {
    if (!slot) return this.publicationFallback(handle, input, offset, append, admission);
    for (;;) {
      const result = this.blockingPublicationAttempt(
        slot,
        handle,
        input,
        offset,
        append,
        nonblocking,
        admission,
      );
      if (result === "missing")
        return this.stagedIO(slot, handle, [input], offset, append, admission);
      if (typeof result !== "number" || result >= 0) {
        if (nonblocking) this.wroteDirectly(handle);
        return result;
      }
      const size = -result;
      if (nonblocking) return this.prepareWriteIO(handle, [input], offset, append, size);
      this.call("grow", [handle, size]);
    }
  }
  private blockingPublicationAttempt(
    slot: number,
    handle: FileHandle,
    input: Uint8Array,
    offset: number,
    append: boolean,
    nonblocking: boolean,
    admission: PublicationAdmission,
  ): { written: number; offset: number } | number | "missing" {
    try {
      return this.attemptPublicationIO(slot, handle, input, offset, append, nonblocking, admission);
    } catch (error) {
      // An immediate caller never waits for the owner here: it stages the write instead.
      if (nonblocking && error instanceof MissingSegmentError) return "missing";
      if (!(error instanceof DirtyCapacityError) || error.permanent || nonblocking) throw error;
      return this.publicationFallback(handle, input, offset, append, admission);
    }
  }
  private attemptPublicationIO(
    slot: number,
    handle: FileHandle,
    input: Uint8Array,
    offset: number,
    append: boolean,
    nonblocking: boolean,
    admission: PublicationAdmission,
  ): { written: number; offset: number } | number {
    try {
      if (append) {
        const result = this.shared.directAppend(
          slot,
          handle,
          [input],
          input.length,
          this.epoch,
          this.revoked,
          this.connection.owner,
          nonblocking,
          admission,
        );
        return typeof result === "number" ? -result : result;
      }
      const result = this.shared.directWrite(
        slot,
        handle,
        [input],
        offset,
        input.length,
        this.epoch,
        this.revoked,
        this.connection.owner,
        nonblocking,
        admission,
      );
      return result === undefined ? -Math.max(1, offset + input.length) : result;
    } catch (error) {
      if (!(error instanceof MissingSegmentError) || nonblocking) throw error;
      return this.publicationFallback(handle, input, offset, append, admission);
    }
  }
  private publicationFallback(
    handle: FileHandle,
    input: Uint8Array,
    offset: number,
    append: boolean,
    admission: PublicationAdmission,
  ): { written: number; offset: number } | number {
    const completion = this.submit(
      append ? "append" : "write",
      append ? [handle] : [handle, offset],
      input,
      1024,
      admission,
    );
    try {
      return completion.wait();
    } finally {
      completion.release();
    }
  }
  ioReadiness(
    handle: FileHandle,
    writing: boolean,
  ): { readable: boolean; writable: boolean; hangup: boolean } {
    const pending = mapGet(this.ioPreparations, handle);
    // Only a writer waits for a staged write. A reader of the same handle never sees it.
    const stage = writing ? mapGet(this.stagedWrites, handle) : undefined;
    // A failed preparation is ready too: retrying the syscall delivers its errno, rather than
    // leaving poll asleep forever. Preserve that completion until the syscall consumes it.
    if (this.revoked()) return { readable: true, writable: true, hangup: true };
    if (pending?.kind === "read")
      return { readable: pending.completion.ready, writable: false, hangup: false };
    if ((pending && !pending.completion.ready) || (stage && !stage.completion.ready))
      return { readable: false, writable: false, hangup: false };
    if (preparationFailed(pending?.completion) || preparationFailed(stage?.completion))
      return { readable: true, writable: true, hangup: false };
    try {
      if (!this.preparedIO(handle)) return { readable: false, writable: false, hangup: false };
      const slot = this.directSlot(handle);
      if (!slot) return { readable: true, writable: true, hangup: false };
      const ready = this.shared.directReadiness(
        slot,
        handle,
        writing,
        this.revoked,
        this.connection.owner,
      );
      // A finished staged write is consumed by its retry, which also prepares again when the
      // file is not resident. Report it writable unless a lock is busy right now.
      if (stage) return { readable: false, writable: ready !== false, hangup: false };
      // Cold polling selects a bounded range. Only the next syscall consumes its bytes.
      if (ready === undefined && writing) this.prepareIO(handle, { kind: "grow", size: 0 });
      if (ready === undefined && !writing) this.prepareReadIO(handle, 0, PAGE);
      return {
        readable: !writing && ready === true,
        writable: writing && ready === true,
        hangup: false,
      };
    } catch {
      return { readable: true, writable: true, hangup: false };
    }
  }
  resolveBorrowed(
    directory: FileHandle,
    path: string,
    followFinal = false,
  ): BorrowedResolvedPath | number {
    if (this.connection.residentPublication) return 58;
    const held: FileHandle[] = [];
    const release = () => {
      for (const handle of held.splice(0)) this.release(handle);
    };
    let completion: FilesystemCompletion | undefined;
    try {
      completion = this.submit("resolve", [directory, path, followFinal]);
      const resolved: ResolvedPath | number = completion.wait();
      if (typeof resolved === "number") return resolved;
      for (const handle of [resolved.parent, resolved.node]) {
        if (handle === undefined || held.includes(handle)) continue;
        this.retain(handle);
        held.push(handle);
      }
      return { path: Object.freeze({ ...resolved }), release };
    } catch (error) {
      release();
      return errno(error);
    } finally {
      completion?.release();
    }
  }

  resolve(directory: FileHandle, path: string, followFinal = false): ResolvedPath | number {
    try {
      const epoch = this.version();
      const key = `${directory}\0${Number(followFinal)}\0${path}`;
      const cached = this.paths.get(key);
      if (!this.resident && !this.shared.publication && !(epoch & 1) && cached?.epoch === epoch)
        return typeof cached.path === "number" ? cached.path : { ...cached.path };
      const completion = this.submit("resolve", [directory, path, followFinal]);
      try {
        const resolved: ResolvedPath | number = completion.wait();
        if (this.paths.size >= 256) this.paths.clear();
        this.paths.set(key, { path: resolved, epoch: completion.epoch });
        return typeof resolved === "number" ? resolved : { ...resolved };
      } finally {
        completion.release();
      }
    } catch (error) {
      return errno(error);
    }
  }
  stat(handle: FileHandle): FileStat {
    // Keep the capability's backend pin alive while reading its shared metadata slot.
    this.retain(handle);
    try {
      const direct = this.resident ? undefined : this.shared.stat(handle, this.revoked);
      if (direct) return direct;
      const epoch = this.version();
      const cached = this.stats.get(handle);
      if (!this.resident && !this.shared.publication && !(epoch & 1) && cached?.epoch === epoch)
        return { ...cached.stat };
      const completion = this.submit("stat", [handle]);
      try {
        const stat = completion.wait();
        if (this.stats.size >= 256) this.stats.clear();
        this.stats.set(handle, { stat, epoch: completion.epoch });
        return { ...stat };
      } finally {
        completion.release();
      }
    } finally {
      this.release(handle);
    }
  }
  permissions(handle: FileHandle) {
    const stat = this.stat(handle);
    return stat.mode === undefined ? undefined : permissionsFor(stat.kind, stat.mode);
  }
  setMode(handle: FileHandle, mode: number): number {
    try {
      return this.call("setMode", [handle, mode]);
    } catch (error) {
      return errno(error);
    }
  }
  private cachedRead(handle: FileHandle, position: number) {
    const epoch = this.version();
    let cached = this.reads.get(handle);
    if (
      this.resident ||
      this.shared.publication ||
      epoch & 1 ||
      cached?.epoch !== epoch ||
      position < cached.offset ||
      position >= cached.offset + cached.bytes.length
    ) {
      const completion = this.submit("read", [handle, PAGE, position]);
      try {
        cached = { offset: position, bytes: completion.wait(), epoch: completion.epoch };
        if (this.reads.size >= 16) this.reads.clear();
        this.reads.set(handle, cached);
      } finally {
        completion.release();
      }
    }
    return cached;
  }
  private workspaceRead(handle: number, chunks: readonly Uint8Array[], offset: number): number {
    try {
      let requested = 0;
      for (const chunk of chunks) requested += chunk.length;
      if (requested > PAGE) throw new FilesystemError(6);
      const bytes: Uint8Array = this.call("read", [handle, requested, offset]);
      let at = 0;
      for (const chunk of chunks) {
        const count = Math.min(chunk.length, bytes.length - at);
        if (count > 0) typedArraySet(chunk, bytes.subarray(at, at + count));
        at += count;
      }
      return bytes.length;
    } catch (error) {
      return -errno(error);
    }
  }
  private workspaceWrite(
    handle: number,
    chunks: readonly Uint8Array[],
    offset: number,
    append: false,
  ): number;
  private workspaceWrite(
    handle: number,
    chunks: readonly Uint8Array[],
    offset: number,
    append: true,
  ): number | { written: number; offset: number };
  private workspaceWrite(
    handle: number,
    chunks: readonly Uint8Array[],
    offset: number,
    append: boolean,
  ): number | { written: number; offset: number } {
    try {
      chunks = fixedWriteSources(chunks);
      let length = 0;
      for (const chunk of chunks) length += typedArrayLength(chunk);
      if (length > PAGE) throw new FilesystemError(6);
      const bytes = new Uint8ArrayConstructor(length);
      let at = 0;
      for (const chunk of chunks) {
        typedArraySet(bytes, chunk, at);
        at += typedArrayLength(chunk);
      }
      return this.call(append ? "append" : "write", append ? [handle] : [handle, offset], bytes);
    } catch (error) {
      return -errno(error);
    }
  }
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    if (this.connection.residentPublication?.kind === "file")
      return this.tryRead(handle, chunks, offset);
    if (this.resident) return this.workspaceRead(handle, chunks, offset);
    if (!(offset >= 0)) return -28; // EINVAL: positions are never negative.
    const slot = this.directSlot(handle);
    if (slot) {
      try {
        return this.shared.directRead(
          slot,
          handle,
          chunks,
          offset,
          this.revoked,
          this.connection.owner,
        );
      } catch (error) {
        // Either way the direct read refused before it changed any destination byte.
        if (error instanceof MissingSegmentError)
          return this.readThroughOwner(handle, chunks, offset);
        if (!(error instanceof MissingDataError)) return -this.directFailure(handle, error);
        return this.readUnloaded(handle, chunks, offset);
      }
    }
    let total = 0;
    try {
      for (const chunk of chunks) {
        let at = 0;
        while (at < chunk.length) {
          const position = offset + total;
          const cached = this.cachedRead(handle, position);
          const start = position - cached.offset;
          const count = Math.min(chunk.length - at, cached.bytes.length - start);
          if (this.version() !== cached.epoch) continue;
          chunk.set(cached.bytes.subarray(start, start + count), at);
          at += count;
          total += count;
          if (!count || (cached.bytes.length < PAGE && start + count === cached.bytes.length))
            return total;
        }
      }
      return total;
    } catch (error) {
      return total || -errno(error);
    }
  }
  write(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    if (this.connection.residentPublication?.kind === "file")
      return this.tryWrite(handle, chunks, offset);
    if (this.resident) return this.workspaceWrite(handle, chunks, offset, false);
    if (this.shared.publication) return this.publishedWrite(handle, chunks, offset, false);
    if (!(offset >= 0)) return -28; // EINVAL: positions are never negative.
    chunks = fixedWriteSources(chunks);
    const slot = this.directSlot(handle);
    if (slot) {
      let total = 0;
      for (let i = 0; i < chunks.length; i++) total += chunks[i]!.length;
      try {
        if (!total) {
          if (this.revoked()) throw new FilesystemError(11);
          return 0;
        }
        return this.blockingDirectWrite(slot, handle, chunks, offset, total);
      } catch (error) {
        if (error instanceof MissingSegmentError) {
          try {
            const data = new Uint8ArrayConstructor(total);
            let at = 0;
            for (const chunk of chunks) {
              data.set(chunk, at);
              at += chunk.length;
            }
            return this.call("write", [handle, offset], data);
          } catch (failure) {
            return -errno(failure);
          }
        }
        return -this.directFailure(handle, error);
      }
    }
    let total = 0;
    try {
      for (const chunk of chunks)
        for (let at = 0; at < chunk.length; at += PAGE)
          total += this.call("write", [handle, offset + total], chunk.subarray(at, at + PAGE));
      return total;
    } catch (error) {
      return total || -errno(error);
    }
  }
  private blockingDirectWrite(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    offset: number,
    total: number,
  ): number {
    for (;;) {
      // Capacity is rechecked under the file lock. A truncate can reclaim pages between
      // retries, so grow only after both locks exit.
      let written: number | undefined;
      const changed = this.shared.dirtyAdmission.change;
      try {
        written = this.shared.directWrite(
          slot,
          handle,
          chunks,
          offset,
          total,
          this.epoch,
          this.revoked,
          this.connection.owner,
        );
      } catch (error) {
        if (!(error instanceof DirtyCapacityError) || error.permanent) throw error;
        this.call("dirtyWait", [handle, changed]);
        continue;
      }
      if (written !== undefined) return written;
      this.call("grow", [handle, offset + total]);
    }
  }
  append(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
  ): { written: number; offset: number } | number {
    if (this.connection.residentPublication?.kind === "file") return this.tryAppend(handle, chunks);
    if (this.resident) return this.workspaceWrite(handle, chunks, 0, true);
    if (this.shared.publication) return this.publishedAppend(handle, chunks, false);
    chunks = fixedWriteSources(chunks);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i]!.length;
    const fallback = () => {
      const data = new Uint8ArrayConstructor(total);
      let at = 0;
      for (const chunk of chunks) {
        data.set(chunk, at);
        at += chunk.length;
      }
      return this.call("append", [handle], data);
    };
    const slot = this.directSlot(handle);
    try {
      if (!slot) return fallback();
      return this.blockingDirectAppend(slot, handle, chunks, total);
    } catch (error) {
      if (error instanceof MissingSegmentError) {
        try {
          return fallback();
        } catch (failure) {
          return -errno(failure);
        }
      }
      return -this.directFailure(handle, error);
    }
  }
  private blockingDirectAppend(
    slot: number,
    handle: FileHandle,
    chunks: readonly Uint8Array[],
    total: number,
  ): { written: number; offset: number } {
    for (;;) {
      let result: ReturnType<SharedFilesystemState["directAppend"]>;
      const changed = this.shared.dirtyAdmission.change;
      try {
        result = this.shared.directAppend(
          slot,
          handle,
          chunks,
          total,
          this.epoch,
          this.revoked,
          this.connection.owner,
        );
      } catch (error) {
        if (!(error instanceof DirtyCapacityError) || error.permanent) throw error;
        this.call("dirtyWait", [handle, changed]);
        continue;
      }
      if (typeof result !== "number") return result;
      this.call("grow", [handle, result]);
    }
  }
  private publishedMetadata(
    intent: Extract<MutationIntent, { kind: "resize" | "setMtime" }>,
  ): number {
    const domain = this.shared.publication!,
      session = this.connection.publication!.session;
    let admission: PublicationAdmission | undefined;
    try {
      if (intent.kind === "resize" && (!Number.isSafeInteger(intent.size) || intent.size < 0))
        throw new FilesystemError(28);
      if (intent.kind === "setMtime" && (!Number.isSafeInteger(intent.mtime) || intent.mtime < 0))
        throw new FilesystemError(28);
      const input = new Uint8ArrayConstructor();
      const admitted = domain.admit(session, domain.next(session), intent, input);
      if (admitted.kind !== "admitted") throw new FilesystemError(29);
      admission = admitted.admission;
      const result = this.attemptMetadata(intent, admission);
      if (result !== undefined) return result;
      const args =
        intent.kind === "resize"
          ? [intent.handle, intent.size, intent.truncate]
          : [intent.handle, intent.mtime];
      const completion = this.submit(intent.kind, args, input, 1024, admission);
      try {
        return completion.wait();
      } finally {
        completion.release();
      }
    } catch (error) {
      return errno(error);
    } finally {
      if (admission) domain.cancel(session, admission);
    }
  }
  private attemptMetadata(
    intent: Extract<MutationIntent, { kind: "resize" | "setMtime" }>,
    admission: PublicationAdmission,
  ): number | undefined {
    if (!mapHas(this.openHandles, intent.handle) || !this.shared.hasFile(intent.handle))
      return undefined;
    try {
      return this.shared.mutate(
        this.epoch,
        this.revoked,
        () => {
          if (intent.kind === "setMtime")
            return this.shared.setMtime(
              intent.handle,
              intent.mtime,
              this.revoked,
              this.connection.owner,
              admission,
            );
          const info = this.shared.info(intent.handle, this.revoked);
          if (!info) throw new FilesystemError(8);
          if ((intent.truncate && intent.size < info.size) || intent.size > info.capacity)
            return undefined;
          return this.shared.resize(
            intent.handle,
            intent.size,
            intent.truncate,
            this.revoked,
            this.connection.owner,
            admission,
          );
        },
        this.connection.owner,
      );
    } catch (error) {
      if (
        error instanceof MissingSegmentError ||
        error instanceof MissingDataError ||
        error instanceof DirtyCapacityError
      )
        return undefined;
      throw error;
    }
  }
  private callMetadata(operation: "resize" | "setMtime", args: unknown[]): number {
    try {
      return this.call(operation, args);
    } catch (error) {
      return errno(error);
    }
  }
  resize(handle: FileHandle, size: number, truncate: boolean): number {
    if (this.shared.publication)
      return this.publishedMetadata({ kind: "resize", handle, size, truncate });
    if (
      !this.shared.publication &&
      mapHas(this.openHandles, handle) &&
      this.shared.hasFile(handle)
    ) {
      try {
        const result = this.shared.mutate(
          this.epoch,
          this.revoked,
          () => {
            const info = this.shared.info(handle, this.revoked);
            if (!info) throw new FilesystemError(8);
            if (info.mode !== undefined && !(info.mode & 0o200)) throw new FilesystemError(2);
            // Recheck under the global lock: an append may have turned this into a shrink,
            // or a service shrink may have reclaimed the capacity sampled by the caller.
            if ((truncate && size < info.size) || size > info.capacity) return undefined;
            return this.shared.resize(handle, size, truncate, this.revoked, this.connection.owner);
          },
          this.connection.owner,
        );
        return result === undefined ? this.call("resize", [handle, size, truncate]) : result;
      } catch (error) {
        if (
          error instanceof DirtyCapacityError ||
          error instanceof MissingSegmentError ||
          error instanceof MissingDataError
        )
          return this.callMetadata("resize", [handle, size, truncate]);
        return errno(error);
      }
    }
    return this.callMetadata("resize", [handle, size, truncate]);
  }
  setMtime(handle: FileHandle, mtime: number): number {
    if (this.shared.publication) return this.publishedMetadata({ kind: "setMtime", handle, mtime });
    if (
      !this.shared.publication &&
      mapHas(this.openHandles, handle) &&
      this.shared.hasFile(handle)
    ) {
      try {
        return this.shared.mutate(
          this.epoch,
          this.revoked,
          () => this.shared.setMtime(handle, mtime, this.revoked, this.connection.owner),
          this.connection.owner,
        );
      } catch (error) {
        if (error instanceof DirtyCapacityError)
          return this.callMetadata("setMtime", [handle, mtime]);
        return errno(error);
      }
    }
    return this.callMetadata("setMtime", [handle, mtime]);
  }
  sync(handle: FileHandle): number {
    try {
      return this.call("sync", [handle]);
    } catch (error) {
      return errno(error);
    }
  }
  walkOpen(directory: FileHandle, plan: WalkPlan): WalkCursor {
    return this.call("walkOpen", [directory, plan]);
  }
  walkPage(cursor: WalkCursor, options: WalkPageOptions): WalkPage {
    const completion = this.submit("walkPage", [cursor, options], undefined, PAGE);
    try {
      return completion.wait();
    } finally {
      completion.release();
    }
  }
  walkRelease(grants: readonly number[]): void {
    this.call("walkRelease", [grants]);
  }
  walkClose(cursor: WalkCursor): void {
    this.call("walkClose", [cursor]);
  }
  readdirPage(handle: FileHandle, cookie: bigint, byteLength: number): Uint8Array {
    checkDirectoryPage(cookie, byteLength);
    const completion = this.submit(
      "readdirPage",
      [handle, cookie, byteLength],
      undefined,
      Math.min(byteLength, PAGE),
    );
    try {
      return completion.wait();
    } finally {
      completion.release();
    }
  }
  readdir(handle: FileHandle): DirectoryEntry[] {
    const epoch = this.version();
    const cached = this.readdirs.get(handle);
    if (!this.resident && !this.shared.publication && !(epoch & 1) && cached?.epoch === epoch)
      return cached.entries.map((entry) => ({ ...entry }));
    const completion = this.submit("readdir", [handle]);
    try {
      const entries = completion.wait() as DirectoryEntry[];
      if (this.readdirs.size >= 64) this.readdirs.clear();
      this.readdirs.set(handle, { entries, epoch: completion.epoch });
      return entries.map((entry) => ({ ...entry }));
    } finally {
      completion.release();
    }
  }
  create(
    path: ResolvedPath,
    kind: "file" | "directory" | "socket",
    exclusive = true,
  ): FileHandle | { error: number } {
    try {
      return this.call("create", [path, kind, exclusive]);
    } catch (error) {
      return { error: errno(error) };
    }
  }
  symlink(path: ResolvedPath, target: string): number {
    try {
      return this.call("symlink", [path, target]);
    } catch (error) {
      return errno(error);
    }
  }
  readlink(handle: FileHandle): string {
    return this.call("readlink", [handle]);
  }
  bindSocket(
    parent: FileHandle,
    name: string,
    lease: number,
  ): import("../core/filesystem.js").SocketBinding | { error: number } {
    try {
      return this.call("bindSocket", [parent, name, lease]);
    } catch (error) {
      return { error: errno(error) };
    }
  }
  unbindSocket(
    binding: import("../core/filesystem.js").SocketBinding,
    name: string,
    lease: number,
    unlink: boolean,
  ): number {
    try {
      return this.call("unbindSocket", [binding, name, lease, unlink]);
    } catch (error) {
      return errno(error);
    }
  }
  connectSocket(directory: FileHandle, path: string): { ino: number } | { error: number } {
    try {
      return this.call("connectSocket", [directory, path]);
    } catch (error) {
      return { error: errno(error) };
    }
  }
  link(from: ResolvedPath, to: ResolvedPath): number {
    try {
      return this.call("link", [from, to]);
    } catch (error) {
      return errno(error);
    }
  }
  removePath(path: ResolvedPath, directory: boolean): number {
    try {
      return this.call("removePath", [path, directory]);
    } catch (error) {
      return errno(error);
    }
  }
  rename(from: ResolvedPath, to: ResolvedPath): number {
    try {
      return this.call("rename", [from, to]);
    } catch (error) {
      return errno(error);
    }
  }
  lookup(path: string): any {
    return this.call("lookup", [path]);
  }
  writeFile(path: string, value: string | Uint8Array, mode: WriteFileMode = false): void {
    const { append, exclusive } = resolveWriteFileMode(mode);
    this.call(
      "writeFile",
      [path, append, exclusive],
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }
}
