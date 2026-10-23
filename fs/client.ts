import { DirtyCapacityError } from "./dirty-admission.js";
import { ResidentAttachment, stopWorkspaceBridge } from "./publication-attachment.js";
import { localPublication } from "./publication-internal.js";
import {
  mutationIntent,
  type PublicationAdmission,
  type MutationIntent,
  type MutationId,
  type AdmissionResult,
} from "./publication.js";
import { permissionsFor } from "../core/filesystem.js";
import {
  Int32ArrayConstructor,
  Uint8ArrayConstructor,
  SharedArrayBufferConstructor,
  atomicsLoad,
  atomicsStore,
  atomicsAdd,
  atomicsExchange,
  atomicsCompareExchange,
  atomicsNotify,
  atomicsWait,
  atomicsWaitAsync,
  typedArrayLength,
  typedArraySet,
  sharedArrayBufferByteLength,
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
  createFilesystemConnection,
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

export class FilesystemCompletion {
  readonly cells: Int32Array;
  private changed: (() => void)[] = [];
  private cancellations = new SetConstructor<() => void>();
  private decoded: unknown;
  private loading?: Promise<unknown>;
  private consumed = false;
  constructor(
    readonly id: number,
    readonly buffer: SharedArrayBuffer,
    private client: FilesystemClient,
    readonly publication?: PublicationAdmission,
  ) {
    this.cells = new Int32ArrayConstructor(buffer, 0, HEADER / 4);
  }
  get ready(): boolean {
    return isRevoked(this.client.connection) || atomicsLoad(this.cells, 0) !== State.Pending;
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
    if (atomicsExchange(this.cells, 6, 1)) return;
    atomicsCompareExchange(this.cells, 0, State.Pending, State.Cancelled);
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
  private check(): void {
    if (isRevoked(this.client.connection) || this.cells[6] || this.cells[0] === State.Cancelled)
      throw new FilesystemError(11);
    if (this.cells[0] === State.Failed) throw new FilesystemError(this.cells[3]!);
  }
  private decode(bytes: Uint8Array): unknown {
    return this.cells[4] ? bytes : unpack(bytes);
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
    let bytes = new Uint8ArrayConstructor(
      new Uint8ArrayConstructor(
        this.buffer,
        HEADER,
        Math.min(size, sharedArrayBufferByteLength(this.buffer) - HEADER),
      ),
    );
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
    let bytes = new Uint8ArrayConstructor(
      new Uint8ArrayConstructor(
        this.buffer,
        HEADER,
        Math.min(size, sharedArrayBufferByteLength(this.buffer) - HEADER),
      ),
    );
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
/** Blocking preview1 adapter and non-blocking request/completion API for the async host.
 * Read/stat caches are validated by the service's global seqlock. A concurrent mutation invalidates
 * before changing data; a cached read that overlaps it is discarded, never returned as fresh.
 */
export class FilesystemClient implements FileSystem {
  readonly completions = new MapConstructor<number, FilesystemCompletion>();
  private nextRequest = 1;
  private reads = new Map<number, { offset: number; bytes: Uint8Array; epoch: number }>();
  private stats = new Map<number, { stat: FileStat; epoch: number }>();
  private paths = new Map<string, { path: ResolvedPath | number; epoch: number }>();
  private readdirs = new Map<number, { entries: DirectoryEntry[]; epoch: number }>();
  private openHandles = new MapConstructor<number, number>();
  // Shared slots of open regular files: a live handle never changes slot, and direct I/O
  // rechecks the slot's handle under its file lock.
  private fileSlots = new MapConstructor<number, number>();
  // Preparation owns no guest buffers and never writes file bytes. Only a successful try* retry
  // commits I/O; preparation only hydrates data or reserves write capacity.
  private ioPreparations = new MapConstructor<number, FilesystemCompletion>();
  private capabilityEntries = new MapConstructor<number, number>();
  private capabilities: Int32Array;
  private epoch: Int32Array;
  private revoked: () => boolean;
  private readonly section: FilesystemSection;
  readonly shared: SharedFilesystemState;
  private watchingRevocation = false;
  private resident: ResidentAttachment | undefined;
  private workspaceStop: Promise<void> | undefined;
  constructor(readonly connection: FilesystemConnection) {
    this.capabilities = new Int32ArrayConstructor(connection.capabilities, 0, CAPABILITY_LENGTH);
    this.epoch = new Int32ArrayConstructor(connection.epoch);
    this.revoked = sharedRevoked(connection);
    if (connection.residentPublication)
      this.resident = new ResidentAttachment(connection.residentPublication, this.revoked);
    this.section = new FilesystemSection(connection, this.revoked);
    this.shared = new SharedFilesystemState(
      connection.shared,
      connection.maxBytes,
      connection.owner,
      connection.segments,
      this.section,
      connection.publication?.buffers,
    );
    connection.port.onmessage = ({ data }) => {
      if (data.segment) this.shared.addSegment(data.segment, data.index);
      else mapGet(this.completions, data.completed)?.notify();
    };
    connection.port.start();
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
    this.section.enter();
    try {
      const connection = createFilesystemConnection(this.connection);
      this.connection.port.postMessage({ connect: connection.server }, [connection.server.port]);
      return connection.client;
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
          state: new SharedArrayBufferConstructor(8),
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
        this.cancelIO(reservation.handle);
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
    capacity = operation === "read" || operation === "take" || operation === "readdir"
      ? PAGE
      : 1024,
    publication?: PublicationAdmission,
  ): FilesystemCompletion {
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
    const buffer = new SharedArrayBufferConstructor(
      HEADER + Math.max(input.length + data.length, capacity),
    );
    const completion = new FilesystemCompletion(this.nextRequest++, buffer, this, publication);
    completion.cells[1] = input.length;
    completion.cells[2] = data.length;
    typedArraySet(new Uint8ArrayConstructor(buffer, HEADER), input);
    typedArraySet(new Uint8ArrayConstructor(buffer, HEADER + input.length), data);
    mapSet(this.completions, completion.id, completion);
    try {
      this.connection.port.postMessage({ id: completion.id, buffer });
    } catch (error) {
      mapDelete(this.completions, completion.id);
      throw error;
    }
    return completion;
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
  dispose(): void {
    this.resident?.invalidate();
    this.beginWorkspaceStop();
    // The disposing agent is quiescent: no synchronous file operation can be active here.
    reapFilesystem(this.connection);
    mapForEach(this.completions, (completion) => completion.cancel());
    mapClear(this.completions);
    mapClear(this.ioPreparations);
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
      this.cancelIO(handle);
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
        this.cancelIO(handle);
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
    const completion = mapGet(this.ioPreparations, handle);
    if (!completion) return;
    mapDelete(this.ioPreparations, handle);
    completion.release();
  }
  private preparedIO(handle: FileHandle): boolean {
    const completion = mapGet(this.ioPreparations, handle);
    if (!completion) return true;
    if (!completion.ready) return false;
    mapDelete(this.ioPreparations, handle);
    // Inspect shared completion state even while poll owns the worker, before the port callback
    // can run. No wait(), async continuation or overflow transfer is needed for preparation.
    completion.releaseReady();
    return true;
  }
  private prepareIO(
    handle: FileHandle,
    intent: { kind: "read" } | { kind: "grow"; size: number },
  ): void {
    if (mapHas(this.ioPreparations, handle)) return;
    const completion =
      intent.kind === "read"
        ? this.submit("read", [handle, 0, 0])
        : this.submit("grow", [handle, intent.size]);
    mapSet(this.ioPreparations, handle, completion);
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
          this.prepareIO(handle, { kind: "read" });
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
      if (!this.preparedIO(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot) return -8;
      chunks = fixedWriteSources(chunks);
      const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
      const written = this.shared.directWrite(
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
      if (written !== undefined) return written;
      this.prepareIO(handle, { kind: "grow", size: offset + total });
      return -6;
    } catch (error) {
      return -this.directFailure(handle, error);
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
      if (!this.preparedIO(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot) return -8;
      chunks = fixedWriteSources(chunks);
      const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
      const result = this.shared.directAppend(
        slot,
        handle,
        chunks,
        total,
        this.epoch,
        this.revoked,
        this.connection.owner,
        true,
      );
      if (typeof result !== "number") return result;
      this.prepareIO(handle, { kind: "grow", size: result });
      return -6;
    } catch (error) {
      return -this.directFailure(handle, error);
    }
  }
  private publicationInput(chunks: readonly Uint8Array[]): Uint8Array {
    const bound = this.shared.publication!.limits.inputBytes;
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
      if (nonblocking && !this.preparedIO(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot && nonblocking) return -8;
      const bytes = this.publicationInput(chunks);
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
      return -this.directFailure(handle, error);
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
      if (typeof result !== "number" || result >= 0) return result;
      const size = -result;
      if (nonblocking) {
        this.prepareIO(handle, { kind: "grow", size });
        return -6;
      }
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
  ): { written: number; offset: number } | number {
    try {
      return this.attemptPublicationIO(slot, handle, input, offset, append, nonblocking, admission);
    } catch (error) {
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
      if (!(error instanceof MissingSegmentError)) throw error;
      if (nonblocking) throw new FilesystemError(6);
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
    // A failed preparation is ready too: retrying the syscall delivers its errno, rather than
    // leaving poll asleep forever. Preserve that completion until the syscall consumes it.
    if (this.revoked()) return { readable: true, writable: true, hangup: true };
    if (pending && !pending.ready) return { readable: false, writable: false, hangup: false };
    if (pending && (pending.cells[0] === State.Failed || pending.cells[0] === State.Cancelled))
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
      // A cold file can be polled before its first read. Start hydration, but do not enqueue
      // RPCs on ordinary hot-file lock contention.
      if (ready === undefined)
        this.prepareIO(handle, writing ? { kind: "grow", size: 0 } : { kind: "read" });
      return {
        readable: !writing && ready === true,
        writable: writing && ready === true,
        hangup: false,
      };
    } catch {
      return { readable: true, writable: true, hangup: false };
    }
  }
  resolve(directory: FileHandle, path: string): ResolvedPath | number {
    try {
      const epoch = this.version();
      const key = `${directory}\0${path}`;
      const cached = this.paths.get(key);
      if (!this.resident && !this.shared.publication && !(epoch & 1) && cached?.epoch === epoch)
        return typeof cached.path === "number" ? cached.path : { ...cached.path };
      const completion = this.submit("resolve", [directory, path]);
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
        if (!(error instanceof MissingSegmentError) && !(error instanceof MissingDataError))
          return -this.directFailure(handle, error);
        // Only a standalone state can lack a segment; the service reply replaces every copied byte.
        try {
          let requested = 0;
          for (let i = 0; i < chunks.length; i++) requested += chunks[i]!.length;
          const bytes = this.call("read", [handle, requested, offset]) as Uint8Array;
          let at = 0;
          for (const chunk of chunks) {
            const count = Math.min(chunk.length, bytes.length - at);
            if (count > 0) chunk.set(bytes.subarray(at, at + count));
            at += count;
          }
          return bytes.length;
        } catch (failure) {
          return -errno(failure);
        }
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
    kind: "file" | "directory",
    exclusive = true,
  ): FileHandle | { error: number } {
    try {
      return this.call("create", [path, kind, exclusive]);
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
