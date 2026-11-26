import { WalkTable, type WalkTransaction } from "./walk.js";
import type { OperationBinding } from "../browser/operations/protocol.js";
import {
  requestMemorySections,
  waitForRequestQuiescence,
  assertRequestBudget,
  requestBudgetBytes,
  retainResponseBytes,
  captureRequestMemory,
  closeRequestMemory,
  requestMemoryRetired,
  retireRequestMemory,
  requestTransportError,
  requestLengths,
  requestCells,
  requestBytes,
  requestCancelled,
  receiveRequestBuffer,
  releaseRequestBuffer,
  requestMemoryExhausted,
  REQUEST_SERVICE,
  type FilesystemRequestMemory,
  type FilesystemRequestBuffer,
} from "./request-memory.js";
import { atomicsWaitAsync, typedArrayBuffer } from "../proc/intrinsics.js";
import { WatchService } from "./watch-service.js";
import { checkDirectoryPage } from "./directory-pages.js";
import type { SocketBinding, ResolvedPath } from "../core/filesystem.js";
import { ReaderLifetime } from "./workspace-protocol.js";
import { WorkspaceReadAuthority, WorkspaceReadBudget } from "./workspace-read.js";
import { DirtyCapacityError } from "./dirty-admission.js";
import { NamespaceAuthority } from "./workspace-namespace.js";
import { ResidentGrantAuthority } from "./publication-grant.js";
import {
  encodeEffects,
  mutationIntent,
  mutationValue,
  publicationAdmission,
  publicationCut,
  type PublicationAdmission,
} from "./publication.js";
import { reportRuntimeStartup, type RuntimeStartupObserver } from "./startup.js";
import { MemoryBackend, type FilesystemBackend } from "./backend.js";
import type { SharedFilesystemState, StagedWrite } from "./shared.js";
import {
  CAPABILITY_HEADER,
  CAPABILITY_LENGTH,
  CAPABILITY_SLOTS,
  CAPABILITY_WORDS,
  PAGE,
  TRANSIENT_HANDLES,
  SIGNAL_TRANSPORT,
  State,
  FilesystemError,
  errno,
  isRevoked,
  pack,
  revokeFilesystem,
  revokeFilesystemService,
  waitForFilesystemQuiescence,
  unpack,
  wake,
  wakeTransport,
  sameFilesystemIdentity,
  reserveIdentityCapability,
  releaseFilesystemReservation,
  type FilesystemIdentity,
  type FilesystemConnection,
  type RequestMessage,
  type SegmentAnnouncement,
} from "./protocol.js";

const mutations = new Set([
  "preopen",
  "bindSocket",
  "bindSocketPath",
  "unbindSocket",
  "release",
  "write",
  "append",
  "resize",
  "setTimes",
  "setMode",
  "create",
  "symlink",
  "link",
  "removePath",
  "rename",
  "writeFile",
  "mkdirp",
  "remove",
  "move",
]);
let connectObserved: (
  owner: FilesystemService,
  connection: FilesystemConnection,
  acceptResolve: (id: number) => void,
) => void;
type ResponsePayload =
  | { kind: "pending" }
  | { kind: "inline" }
  | { kind: "overflow"; bytes: Uint8Array };
type Response =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "resolve"; references: Map<number, number>; payload: ResponsePayload };
interface SocketScopeState {
  readonly root: number;
  readonly leases: Map<number, { binding: SocketBinding; name: string }>;
}
interface WatchTransaction {
  readonly cancel: () => void;
  readonly release: (() => void) | undefined;
}
/** A write staged for a client that lacks the target segment, keyed by its request id. The
 * request block stays held by the service while the entry exists, because the stage's state and
 * committed position live in that block's header. */
interface SessionStage {
  readonly shared: SharedFilesystemState;
  readonly stage: StagedWrite;
  /** Refunds the owner's private copy to the connection's retained-bytes budget. */
  readonly release: () => void;
}
/** Largest request, in encoded bytes, whose decoded form stays with it while it is queued. */
const RETAINED_DECODE_BYTES = 512;
interface WatchResponseSettlement {
  readonly cancel: () => void;
  readonly release: (() => void) | undefined;
}
interface Session {
  watchTransactions: Map<number, WatchTransaction>;
  watchResponses: Map<number, WatchResponseSettlement>;
  walks?: WalkTable;
  walkTransactions: Map<number, WalkTransaction>;
  walkResponses: Map<number, () => void>;
  socketScope?: SocketScopeState;
  connection: FilesystemConnection;
  requests: FilesystemRequestMemory;
  transportRetirement?: Promise<void>;
  transportJoined?: Set<Promise<unknown>>;
  transportFailed?: boolean;
  handles: Map<number, number>;
  capabilities: Int32Array;
  /** One view for the connection's lifetime: every request reads and bumps it. */
  readonly epoch: Int32Array;
  freeEntries: number[];
  preopens: Set<number>;
  transient: Map<number, true>;
  references: Map<number, number>;
  responses: Map<number, Response>;
  responseMemory: Map<number, () => void>;
  stages: Map<number, SessionStage>;
  retainedRequests: Map<number, FilesystemRequestBuffer>;
  pending: Map<number, FilesystemRequestBuffer>;
  /** Scalar write/append requests already dispatched to backend execution. */
  inFlightWrites: Set<number>;
  /** Transferred inputs by request id. Removed only when that request's work settles. */
  privateInputs: Map<number, Uint8Array>;
  preparingHandles: Map<number, number>;
  preparations: Set<Promise<void>>;
  /** The backend's unlink generation when a trim last proved no transient capability was
   * unlinked. Undefined while one may still become detached, so every trim rescans. */
  trimmedUnlinks?: number;
  quiescing?: Promise<void>;
  releaseState?: { kind: "running" } | { kind: "failed"; error: unknown };
  closed?: boolean;
  retirement?: ReturnType<typeof setTimeout>;
  publicationPins?: Set<number>;
  namespace?: NamespaceAuthority;
  reader?: WorkspaceReadAuthority;
  readerClosing?: Promise<void>;
}
function isCommittedScalarWrite(operation: string, state: State): boolean {
  return (operation === "write" || operation === "append") && state === State.Complete;
}

function sessionRevoked(session: Session): boolean {
  return isRevoked(session.connection) || !!requestTransportError(session.requests);
}
function requestInput(session: Session, id: number, response: Uint8Array): Uint8Array {
  return session.privateInputs.get(id) ?? response;
}
/** A retained reply must not keep a refunded private input reachable through a shared backing.
 * An inline input cannot alias an overflowing result: it fits the response room by construction. */
function independentResponse(
  result: Uint8Array,
  input: Uint8Array,
  release: () => void,
): Uint8Array {
  if (typedArrayBuffer(result) !== typedArrayBuffer(input)) return result;
  try {
    return result.slice();
  } catch (error) {
    release();
    if (error instanceof RangeError) throw requestMemoryExhausted();
    throw error;
  }
}
interface ShutdownOwner {
  readonly done: Promise<void>;
  readonly sessions: readonly Session[];
}
interface PreparedRequest {
  handles: number[];
  failure?: { error: unknown };
  read?: { value: unknown; startEpoch?: number; startVersion?: string };
}
/** One serial owner of the tree. No request ever waits for a guest acknowledgment. */
export class FilesystemService {
  static {
    connectObserved = (owner, connection, acceptResolve) =>
      owner.#connect(connection, acceptResolve);
  }

  private sessions = new Set<Session>();
  private requestBudget?: SharedArrayBuffer;
  private readBudget?: WorkspaceReadBudget;
  private queue = Promise.resolve();
  private sweeping = false;
  private ownerStopping = false;
  private ownerDraining: Promise<void> | undefined;
  private runningRequests = new Set<Promise<void>>();
  private preparingSessions = new Set<Session>();
  private work = new Map<Promise<unknown>, Session>();
  private shutdownOwner: ShutdownOwner | undefined;
  private refusedConnections = new Set<FilesystemConnection>();
  residentPublication: ResidentGrantAuthority | undefined;
  private watchService?: WatchService;
  private disposingWatches = false;
  constructor(private backend: FilesystemBackend) {}
  attachSocketScope(
    guest: Pick<FilesystemIdentity, "owner" | "sections">,
    directory: number,
    connection: FilesystemConnection,
  ) {
    const source = Array.from(this.sessions).find((session) =>
      sameFilesystemIdentity(session.connection, guest),
    );
    if (!source) throw new FilesystemError(76);
    if (sessionRevoked(source)) throw new FilesystemError(11);
    if (!source.handles.has(directory)) throw new FilesystemError(76);
    this.check(source, directory);
    if (this.backend.supportsSockets === false) throw new FilesystemError(58);
    if (
      !(this.backend instanceof MemoryBackend) ||
      this.backend.fs.stat(directory).kind !== "directory"
    )
      throw new FilesystemError(76);
    if (isRevoked(connection)) throw new FilesystemError(11);
    if (connection.revocations.length !== 1) throw new FilesystemError(76);
    if (!(this.backend.fs.permissions(directory).access & 1)) throw new FilesystemError(2);
    const reservation = reserveIdentityCapability(source.connection, directory, connection);
    try {
      this.connect(connection);
      const target = Array.from(this.sessions).find((session) => session.connection === connection);
      if (!target) throw new FilesystemError(11);
      target.socketScope = { root: directory, leases: new Map() };
      return { root: directory, rootIno: this.backend.fs.stat(directory).ino, reservation };
    } catch (error) {
      releaseFilesystemReservation(reservation);
      revokeFilesystem(connection);
      this.sweep();
      throw error;
    }
  }
  connect(connection: FilesystemConnection): void {
    this.#connect(connection);
  }
  #connect(connection: FilesystemConnection, acceptResolve?: (id: number) => void): void {
    if (this.ownerStopping) {
      this.refuseConnection(connection);
      throw new FilesystemError(11);
    }
    if (connection.publication && !(this.backend instanceof MemoryBackend))
      throw new FilesystemError(58, "publication requires a synchronous memory backend");
    if (this.backend instanceof MemoryBackend) {
      this.backend.attachShared(
        connection.shared,
        connection.maxBytes,
        connection.segments,
        connection.publication?.buffers,
      );
      this.backend.shared.onContention = () => this.sweep();
    } else {
      this.backend.attachShared?.(connection.shared);
    }
    if (this.requestBudget) assertRequestBudget(this.requestBudget, connection.requestBudget);
    else this.requestBudget = connection.requestBudget;
    assertRequestBudget(connection.requestBudget, connection.requests.budget);
    const session: Session = {
      connection,
      walkTransactions: new Map(),
      walkResponses: new Map(),
      watchTransactions: new Map(),
      watchResponses: new Map(),
      requests: captureRequestMemory(connection.requests),
      handles: new Map(),
      capabilities: new Int32Array(connection.capabilities, 0, CAPABILITY_LENGTH),
      epoch: new Int32Array(connection.epoch),
      freeEntries: Array.from(
        { length: CAPABILITY_SLOTS },
        (_, index) => CAPABILITY_HEADER + (CAPABILITY_SLOTS - index - 1) * CAPABILITY_WORDS,
      ),
      preopens: new Set(),
      transient: new Map(),
      references: new Map(),
      responses: new Map(),
      responseMemory: new Map(),
      stages: new Map(),
      retainedRequests: new Map(),
      pending: new Map(),
      inFlightWrites: new Set(),
      privateInputs: new Map(),
      preparingHandles: new Map(),
      preparations: new Set(),
      ...(connection.publication?.observer ? { publicationPins: new Set<number>() } : {}),
    };
    this.sessions.add(session);
    for (const reservation of connection.reservations) {
      const state = new Int32Array(reservation.state);
      if (Atomics.compareExchange(state, 1, 0, 1) !== 0) continue;
      try {
        if (!isRevoked(connection) && !session.handles.has(reservation.handle)) {
          this.backend.retain(reservation.handle);
          if (isRevoked(connection) || !this.sessions.has(session)) {
            this.backend.release(reservation.handle);
            Atomics.store(session.capabilities, reservation.targetKey + 1, -1);
            continue;
          }
          session.handles.set(reservation.handle, reservation.targetKey);
          session.transient.set(reservation.handle, true);
          const index = session.freeEntries.indexOf(reservation.targetKey);
          if (index >= 0) session.freeEntries.splice(index, 1);
        } else if (isRevoked(connection))
          Atomics.store(session.capabilities, reservation.targetKey + 1, -1);
      } finally {
        Atomics.sub(
          new Int32Array(reservation.source, 0, CAPABILITY_LENGTH),
          reservation.sourceKey + 2,
          1,
        );
      }
    }
    Atomics.store(session.capabilities, 0, session.transient.size);
    this.sweep();
    // Adopting a child pin can make the live parent's final detached pin collectible.
    for (const peer of this.sessions) if (!isRevoked(peer.connection)) this.trim(peer);
    // The launch snapshot can be older than the tree. Every segment that exists now is offered
    // again, so an agent that reaches its event loop attaches what its snapshot lacked.
    this.announceSegments(this.backend.sharedSegments?.() ?? [], [session]);
    const receive = ({ data }: MessageEvent<RequestMessage>) => {
      try {
        this.receive(session, data);
      } catch {
        this.signalTransportFailure(session, "protocol");
      }
    };
    connection.port.onmessage = acceptResolve
      ? (event: MessageEvent<RequestMessage>) => {
          receive(event);
          this.observeAcceptedResolve(session, event.data, acceptResolve);
        }
      : receive;
    connection.port.onmessageerror = () => this.signalTransportFailure(session);
    connection.port.start();
    if (!session.closed) this.trackWork(session, this.watchTransport(session));
  }
  private observeAcceptedResolve(
    session: Session,
    data: RequestMessage,
    accept: (id: number) => void,
  ): void {
    try {
      if (!("id" in data)) return;
      if (requestTransportError(session.requests)) return;
      const buffer = session.pending.get(data.id);
      if (!buffer) return;
      const bytes = requestInput(session, data.id, requestBytes(buffer));
      const { inputLength } = requestLengths(buffer, bytes);
      if (unpack(bytes.subarray(0, inputLength)).operation === "resolve") accept(data.id);
    } catch {
      // Receipt observation cannot fail the transport or affect the queued request.
    }
  }
  /** Offers segments by index. Delivery is never awaited or acknowledged: a blocked agent
   * cannot receive it, and reaches those pages through the owner until it can. */
  private announceSegments(
    segments: readonly { buffer: SharedArrayBuffer; index: number }[],
    sessions: Iterable<Session>,
  ): void {
    if (!segments.length) return;
    const announcements = segments.map(({ index, buffer }): SegmentAnnouncement => ({
      segment: index,
      buffer,
    }));
    for (const peer of sessions) {
      if (peer.closed || sessionRevoked(peer)) continue;
      for (const announcement of announcements) peer.connection.port.postMessage(announcement);
    }
  }
  private signalTransportFailure(
    session: Session,
    reason: "messageerror" | "protocol" = "messageerror",
  ): void {
    closeRequestMemory(session.requests, reason);
    wakeTransport(session.connection);
  }
  private async watchTransport(session: Session): Promise<void> {
    const signal = new Int32Array(session.connection.signal);
    // Revocation, reap and transport failure all wake SIGNAL_TRANSPORT. A publication domain's
    // stop wakes nothing itself, so a publishing session keeps watching every change.
    const word = session.connection.publication ? 0 : SIGNAL_TRANSPORT;
    while (!session.closed) {
      const observed = Atomics.load(signal, word);
      if (sessionRevoked(session)) {
        if (requestTransportError(session.requests)) session.transportFailed = true;
        this.close(session);
        return;
      }
      const waiting = atomicsWaitAsync(signal, word, observed);
      if (waiting.async) await waiting.value;
    }
  }
  private receive(session: Session, data: RequestMessage): void {
    const connection = session.connection;
    if (requestTransportError(session.requests) || "transportClosed" in data) {
      this.signalTransportFailure(session);
      return;
    }
    if ("sweep" in data) {
      this.sweep();
      this.enqueueMaintenance(session, () => {
        for (const peer of this.sessions) if (!isRevoked(peer.connection)) this.trim(peer);
      });
      return;
    }
    if ("discard" in data) {
      session.reader?.cancel(data.discard);
      this.enqueueMaintenance(session, () => this.discardResponse(session, data.discard));
      return;
    }
    if ("trim" in data) {
      this.enqueueMaintenance(session, () => {
        if (this.sessions.has(session) && !isRevoked(connection)) this.trim(session);
      });
      return;
    }
    const buffer = receiveRequestBuffer(
      session.requests,
      data.id,
      data.generation,
      data.offset,
      data.length,
      data.payload,
    );
    if (this.ownerStopping) {
      this.cancelRequest(session, data.id, buffer);
      return;
    }
    if (session.pending.has(data.id) || session.retainedRequests.has(data.id))
      throw new FilesystemError(28, "duplicate filesystem request");
    session.pending.set(data.id, buffer);
    if (data.payload) session.privateInputs.set(data.id, new Uint8Array(data.payload));
    this.enqueue(session, data.id, buffer);
  }
  private retireTransport(session: Session): void {
    if (session.transportRetirement) return;
    const joined = (session.transportJoined ??= new Set());
    const pending = Array.from(this.work)
      .filter((entry) => entry[1] === session && !joined.has(entry[0]))
      .map((entry) => entry[0]);
    if (!pending.length) {
      retireRequestMemory(session.requests);
      wakeTransport(session.connection);
      return;
    }
    session.transportRetirement = Promise.allSettled(pending).then(() => {
      for (const done of pending) joined.add(done);
      session.transportRetirement = undefined;
      this.retireTransport(session);
    });
    void session.transportRetirement.catch(() => {});
  }
  private async closeWorkspace(connection: FilesystemConnection): Promise<void> {
    const session = Array.from(this.sessions).find(
      (peer) => peer.connection.capabilities === connection.capabilities,
    );
    if (!session) return;
    await waitForFilesystemQuiescence(session.connection);
    await this.queue;
    await Promise.all(Array.from(session.preparations));
    await this.queue;
    this.close(session);
    if (this.sessions.has(session)) throw new FilesystemError(6);
  }
  private adoptWorkspace(
    connection: FilesystemConnection,
    reservation: import("./protocol.js").FilesystemReservation,
  ): void {
    const target = Array.from(this.sessions).find(
      (peer) => peer.connection.capabilities === connection.capabilities,
    );
    const source = Array.from(this.sessions).find(
      (peer) => peer.connection.capabilities === reservation.source,
    );
    if (
      !target ||
      !source ||
      isRevoked(source.connection) ||
      isRevoked(connection) ||
      reservation.target !== connection.capabilities ||
      reservation.targetOwner !== connection.owner ||
      source.handles.get(reservation.handle) !== reservation.sourceKey ||
      Atomics.load(source.capabilities, reservation.sourceKey + 2) <= 0
    )
      throw new FilesystemError(8);
    const state = new Int32Array(reservation.state);
    if (Atomics.load(state, 0) || Atomics.compareExchange(state, 1, 0, 1))
      throw new FilesystemError(11);
    try {
      if (target.handles.has(reservation.handle)) return;
      this.backend.retain(reservation.handle);
      target.handles.set(reservation.handle, reservation.targetKey);
      target.transient.set(reservation.handle, true);
      const free = target.freeEntries.indexOf(reservation.targetKey);
      if (free >= 0) target.freeEntries.splice(free, 1);
    } finally {
      Atomics.sub(source.capabilities, reservation.sourceKey + 2, 1);
    }
  }
  private enqueue(
    session: Session,
    id: number,
    buffer: FilesystemRequestBuffer,
    prepared?: PreparedRequest,
  ): void {
    // Barriers capture their checkpoint in queue order without holding the mutation lock
    // while storage commits. Cold preparation likewise rejoins the queue only when ready.
    let barrier = false;
    // A small request runs on this decode, so an ordinary queue turn decodes it once. A queued
    // request can wait behind a blocked backend, so the decoded form is kept only when it is
    // small; a larger one is decoded again at its turn instead of staying in memory meanwhile.
    let input: { operation: string; args: unknown[]; publication?: unknown } | undefined;
    try {
      const length = requestCells(buffer)[1]!;
      const decoded = unpack(requestInput(session, id, requestBytes(buffer)).subarray(0, length));
      barrier = decoded?.operation === "flush" || decoded?.operation === "sync";
      if (length <= RETAINED_DECODE_BYTES) input = decoded;
    } catch {
      /* request() reports malformed input through its completion */
    }
    const previous = this.queue;
    const request = this.trackWork(
      session,
      previous.then(() => this.request(session, id, buffer, prepared, input)),
    );
    this.runningRequests.add(request);
    void request.then(
      () => this.runningRequests.delete(request),
      () => this.runningRequests.delete(request),
    );
    this.queue = barrier
      ? previous.then(() => {})
      : request.then(
          () => {},
          () => {},
        );
  }
  private trackWork<T>(session: Session, done: Promise<T>): Promise<T> {
    this.work.set(done, session);
    void done.then(
      () => this.work.delete(done),
      () => {},
    );
    return done;
  }
  private trackRequestWork<T>(session: Session, done: Promise<T>): Promise<T> {
    return this.backend.asyncErrorsAreClientResults ? done : this.trackWork(session, done);
  }
  private enqueueMaintenance(session: Session, run: () => void): void {
    const done = this.trackWork(session, this.queue.then(run));
    this.queue = done.then(
      () => {},
      () => {},
    );
  }
  private refuseConnection(connection: FilesystemConnection): void {
    if (
      connection.reservations.some(
        (reservation) => Atomics.load(new Int32Array(reservation.state), 1) === 0,
      )
    )
      this.refusedConnections.add(connection);
    revokeFilesystem(connection);
    connection.port.close();
  }
  private cancelRequest(session: Session, id: number, buffer: FilesystemRequestBuffer): void {
    const cells = requestCells(buffer);
    Atomics.store(cells, 6, 1);
    Atomics.store(cells, 3, 11);
    Atomics.store(cells, 0, State.Cancelled);
    Atomics.notify(cells, 0);
    wake(session.connection);
    releaseRequestBuffer(buffer, REQUEST_SERVICE);
    session.pending.delete(id);
    this.discardResponse(session, id);
    session.connection.port.postMessage({ completed: id });
  }
  private holdResolvedResponse(session: Session, id: number, path: ResolvedPath): void {
    const references = new Map<number, number>();
    session.responses.set(id, { kind: "resolve", references, payload: { kind: "pending" } });
    try {
      for (const handle of [path.parent, path.node]) {
        if (handle === undefined || references.has(handle)) continue;
        this.holdResponseReference(session, references, handle);
      }
    } catch (error) {
      this.discardResponse(session, id);
      throw error;
    }
  }
  private holdResponseReference(
    session: Session,
    references: Map<number, number>,
    handle: number,
  ): void {
    this.pin(session, handle);
    const key = session.handles.get(handle);
    if (key === undefined) throw new FilesystemError(11);
    for (;;) {
      if (sessionRevoked(session) || !this.sessions.has(session)) throw new FilesystemError(11);
      const count = Atomics.load(session.capabilities, key + 1);
      if (count < 0) throw new FilesystemError(8);
      if (count === 0x7fffffff) throw new FilesystemError(33);
      if (Atomics.compareExchange(session.capabilities, key + 1, count, count + 1) !== count)
        continue;
      references.set(handle, key);
      return;
    }
  }
  private dropResponseReference(session: Session, handle: number, key: number): void {
    for (;;) {
      if (session.handles.get(handle) !== key || Atomics.load(session.capabilities, key) !== handle)
        return;
      const count = Atomics.load(session.capabilities, key + 1);
      if (count <= 0) return;
      if (Atomics.compareExchange(session.capabilities, key + 1, count, count - 1) === count)
        return;
    }
  }
  private releaseResponseMemory(session: Session, id: number): void {
    session.responseMemory.get(id)?.();
    session.responseMemory.delete(id);
  }
  /** Ends a staged write: applied when its client committed it, withdrawn otherwise. The shared
   * state settles each stage once, so a repeated discard or a late one does nothing. */
  private settleStage(session: Session, id: number): void {
    const staged = session.stages.get(id);
    if (!staged) return;
    session.stages.delete(id);
    try {
      staged.shared.settleStagedWrite(staged.stage);
    } finally {
      staged.release();
    }
  }
  private stageWrite(
    session: Session,
    id: number,
    handle: unknown,
    offset: unknown,
    append: unknown,
    data: Uint8Array,
  ): unknown {
    if (!(this.backend instanceof MemoryBackend)) throw new FilesystemError(58);
    if (
      typeof handle !== "number" ||
      typeof offset !== "number" ||
      typeof append !== "boolean" ||
      !data.length ||
      data.length > PAGE
    )
      throw new FilesystemError(28);
    const pending = session.pending.get(id);
    if (!pending) throw new FilesystemError(11);
    // The same checks as growth: a regular file this session may write.
    this.backend.execute("grow", [handle, 0], new Uint8Array());
    const shared = this.backend.shared;
    const release = retainResponseBytes(session.requests, data.length);
    try {
      // The request's bytes belong to the transport. The stage keeps its own private copy.
      const stage = shared.stageWrite(handle, offset, append, data.slice(), requestCells(pending));
      session.stages.set(id, { shared, stage, release });
    } catch (error) {
      release();
      throw error;
    }
    return this.finishResult(session, id, "stageWrite", undefined);
  }
  private discardResponse(session: Session, id: number): void {
    this.settleStage(session, id);
    const watch = session.watchResponses.get(id);
    session.watchResponses.delete(id);
    const request = session.retainedRequests.get(id);
    if (watch) {
      if (
        sessionRevoked(session) ||
        !this.sessions.has(session) ||
        (request && requestCancelled(request))
      )
        watch.cancel();
      else watch.release?.();
    }
    this.releaseResponseMemory(session, id);
    const retained = session.retainedRequests.get(id);
    const cancelledWalk = retained && requestCancelled(retained);
    const cancelWalk = session.walkResponses.get(id);
    session.walkResponses.delete(id);
    if (cancelledWalk) cancelWalk?.();
    if (retained) releaseRequestBuffer(retained, REQUEST_SERVICE);
    session.retainedRequests.delete(id);
    const response = session.responses.get(id);
    session.responses.delete(id);
    if (response?.kind !== "resolve") return;
    for (const [handle, key] of response.references)
      this.dropResponseReference(session, handle, key);
    if (this.sessions.has(session) && !sessionRevoked(session)) this.trim(session);
  }
  private pin(session: Session, handle: number | undefined, preopen = false): void {
    if (handle === undefined) return;
    if (!session.handles.has(handle)) {
      const key = session.freeEntries.pop();
      if (key === undefined) throw new FilesystemError(51, "session capability table exhausted");
      try {
        this.backend.retain(handle);
        // Contention can run sweep() and close a cancelled session before retain returns.
        if (sessionRevoked(session) || !this.sessions.has(session)) {
          this.backend.release(handle);
          throw new FilesystemError(11);
        }
      } catch (error) {
        session.freeEntries.push(key);
        throw error;
      }
      session.handles.set(handle, key);
      Atomics.store(session.capabilities, key, handle);
      Atomics.store(session.capabilities, key + 2, 0);
      // Publish only after the backend pin and identity are ready.
      Atomics.store(session.capabilities, key + 1, 0);
    }
    if (preopen) session.preopens.add(handle);
    session.transient.delete(handle);
    if (!session.preopens.has(handle)) session.transient.set(handle, true);
    Atomics.store(session.capabilities, 0, session.transient.size);
  }
  private forget(session: Session, handle: number, key: number): void {
    // The caller has atomically revoked the entry. Drop ownership before backend.release,
    // whose allocator contention hook can reenter sweep().
    session.handles.delete(handle);
    session.preopens.delete(handle);
    session.transient.delete(handle);
    session.references.delete(handle);
    session.freeEntries.push(key);
    Atomics.store(session.capabilities, 0, session.transient.size);
    this.backend.release(handle);
  }
  private responseReferenceCounts(session: Session): Map<number, number> {
    const responseHeld = new Map<number, number>();
    for (const response of session.responses.values()) {
      if (response.kind !== "resolve") continue;
      for (const handle of response.references.keys())
        responseHeld.set(handle, (responseHeld.get(handle) ?? 0) + 1);
    }
    return responseHeld;
  }
  /** NaN, which never equals a recorded value, when the backend cannot say. */
  private unlinkGeneration(): number {
    if (this.backend instanceof MemoryBackend) return this.backend.unlinkGeneration();
    if (!this.backend.isUnlinked) return 0;
    return this.backend.unlinkGeneration?.() ?? NaN;
  }
  private trim(session: Session): void {
    // Only an unlink makes a capability detachable, and idle capabilities exceed the bound only
    // when the whole set does. Until either changes, a previous scan's answer still holds.
    const unlinks = this.unlinkGeneration();
    if (session.trimmedUnlinks === unlinks && session.transient.size <= TRANSIENT_HANDLES) return;
    session.trimmedUnlinks = undefined;
    let idle = 0,
      unlinked = 0,
      detached = false;
    const shared = this.backend instanceof MemoryBackend ? this.backend.shared : undefined;
    const isUnlinked = (handle: number) =>
      shared ? shared.isUnlinked(handle) : (this.backend.isUnlinked?.(handle) ?? false);
    const responseHeld = this.responseReferenceCounts(session);
    for (const handle of session.transient.keys()) {
      const gone = isUnlinked(handle);
      if (gone) unlinked++;
      const references = Atomics.load(session.capabilities, session.handles.get(handle)! + 1);
      if (session.preparingHandles.has(handle) || references !== (responseHeld.get(handle) ?? 0))
        continue;
      idle++;
      if (references === 0 && gone) detached = true;
    }
    if (idle <= TRANSIENT_HANDLES && !detached) {
      if (!unlinked) session.trimmedUnlinks = unlinks;
      return;
    }
    // Over the bound, evict the least recently used down to half of it. Each eviction bumps the
    // namespace epoch and so drops every client's cached answers; one handle per new path
    // would do that on every resolve of a build that touches more paths than the bound.
    const keep = idle > TRANSIENT_HANDLES ? TRANSIENT_HANDLES / 2 : TRANSIENT_HANDLES;
    // Eviction is a capability mutation, serialized against direct guest mutations too.
    const epoch = session.epoch;
    const invalidate = !shared?.ownsServiceMutation;
    let opened = false;
    if (invalidate) {
      if (shared) shared.beginServiceMutation(epoch);
      else opened = this.beginEpochMutation(epoch);
    }
    try {
      for (const handle of session.transient.keys()) {
        if (session.preparingHandles.has(handle)) continue;
        if (idle <= keep && !isUnlinked(handle)) continue;
        const key = session.handles.get(handle)!;
        // A local retain racing this CAS either owns a live pin or sees a revoked entry.
        if (Atomics.compareExchange(session.capabilities, key + 1, 0, -1) !== 0) continue;
        if (Atomics.load(session.capabilities, key + 2) > 0) {
          Atomics.store(session.capabilities, key + 1, 0);
          continue;
        }
        if (isUnlinked(handle)) unlinked--;
        this.forget(session, handle, key);
        idle--;
      }
      if (!unlinked) session.trimmedUnlinks = unlinks;
    } finally {
      if (invalidate) {
        if (shared) shared.endServiceMutation(epoch);
        else this.endEpochMutation(epoch, opened);
      }
    }
  }
  /** A backend without shared state marks its mutations on the epoch alone, and only this
   * service changes that epoch. Requests mutate one at a time through the queue and evictions
   * are synchronous, so an epoch already odd belongs to an open mutation that outlives this one,
   * such as the creating request around an eviction. The nested one joins it and the epoch stays
   * odd until the outer one ends. The shared value decides, so every session's view of the same
   * memory agrees, including structured-cloned wrappers. Returns whether this call opened it. */
  private beginEpochMutation(epoch: Int32Array): boolean {
    if (Atomics.load(epoch, 0) & 1) return false;
    Atomics.add(epoch, 0, 1);
    return true;
  }
  private endEpochMutation(epoch: Int32Array, opened: boolean): void {
    if (opened) Atomics.add(epoch, 0, 1);
  }
  /** Offer the segments a request built, then close its mutation even if the offer fails, so a
   * failure can neither strand the epoch odd nor keep the service mutation lock. */
  private finishRequestMutation(
    epoch: Int32Array,
    mutation: boolean,
    opened: boolean,
  ): { error: unknown } | undefined {
    try {
      // A segment that was built stays, even when the request that needed it was cancelled or
      // failed afterwards. Offer every one exactly once, indexed so a peer that connected in
      // between can take both its snapshot and this broadcast.
      this.announceSegments(this.backend.takeSharedSegments?.() ?? [], this.sessions);
      return undefined;
    } catch (error) {
      return { error };
    } finally {
      if (mutation && this.backend instanceof MemoryBackend)
        this.backend.shared.endServiceMutation(epoch);
      else if (mutation) this.endEpochMutation(epoch, opened);
    }
  }
  private check(session: Session, handle: number | undefined, held?: number[]): void {
    if (handle === undefined) return;
    if (!session.handles.has(handle)) throw new FilesystemError(8);
    if (session.transient.delete(handle)) session.transient.set(handle, true);
    if (held && !held.includes(handle)) {
      held.push(handle);
      session.preparingHandles.set(handle, (session.preparingHandles.get(handle) ?? 0) + 1);
    }
  }
  private checkRequest(session: Session, operation: string, args: any[], held?: number[]): void {
    const [a, b] = args;
    const scope = session.socketScope;
    if (
      scope &&
      ![
        "resolve",
        "bindSocket",
        "bindSocketPath",
        "unbindSocket",
        "connectSocket",
        "stat",
        "permissions",
        "retain",
        "release",
        "take",
      ].includes(operation)
    )
      throw new FilesystemError(76);
    if (["bindSocket", "bindSocketPath", "unbindSocket", "connectSocket"].includes(operation)) {
      if (this.backend.supportsSockets === false) throw new FilesystemError(58);
      if (!scope) throw new FilesystemError(76);
    }
    if (
      scope &&
      (operation === "resolve" ||
        operation === "connectSocket" ||
        operation === "bindSocketPath") &&
      a !== scope.root
    )
      throw new FilesystemError(76);
    if (operation === "bindSocket" || operation === "bindSocketPath") {
      this.check(session, a, held);
      if (scope!.leases.has(args[2])) throw new FilesystemError(28);
      if (scope!.leases.size >= 128) throw new FilesystemError(42);
      if (session.freeEntries.length < 2) throw new FilesystemError(51);
    }
    if (operation === "unbindSocket") {
      const owned = scope!.leases.get(args[2]);
      if (
        !owned ||
        owned.name !== b ||
        owned.binding.node !== a.node ||
        owned.binding.parent !== a.parent ||
        owned.binding.ino !== a.ino ||
        owned.binding.parentIno !== a.parentIno
      )
        throw new FilesystemError(76);
    }
    if (operation === "connectSocket") this.check(session, a, held);
    if (operation === "watchOpen") {
      if (typeof a !== "number" || !Number.isSafeInteger(a) || typeof b !== "boolean")
        throw new FilesystemError(28);
      this.check(session, a, held);
    }
    this.checkWalkRoot(session, operation, a, held);
    if (operation === "readdirPage") checkDirectoryPage(b, args[2]);
    if (operation === "publicationPin") {
      const grant = session.connection.publication?.observer;
      if (!grant || a !== grant) throw new FilesystemError(2);
      if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 0) throw new FilesystemError(28);
      this.check(session, b, held);
    }
    if (
      [
        "dirtyWait",
        "retain",
        "release",
        "sync",
        "stat",
        "readlink",
        "permissions",
        "setMode",
        "read",
        "write",
        "append",
        "grow",
        "stageWrite",
        "resize",
        "setTimes",
        "readdir",
        "readdirPage",
        "resolve",
        "realpath",
      ].includes(operation)
    )
      this.check(session, a, held);
    if (["create", "symlink", "link", "removePath", "rename"].includes(operation)) {
      this.check(session, a.parent, held);
      this.check(session, a.node, held);
      if (operation === "link" || operation === "rename") {
        this.check(session, b.parent, held);
        this.check(session, b.node, held);
      }
    }
  }
  private checkWalkRoot(
    session: Session,
    operation: string,
    directory: unknown,
    held?: number[],
  ): void {
    if (operation !== "walkOpen") return;
    if (typeof directory !== "number" || !Number.isSafeInteger(directory))
      throw new FilesystemError(28);
    this.check(session, directory, held);
  }
  private releasePrepared(session: Session, prepared: PreparedRequest | undefined): void {
    for (const handle of prepared?.handles ?? []) {
      const count = session.preparingHandles.get(handle) ?? 0;
      if (count > 1) session.preparingHandles.set(handle, count - 1);
      else session.preparingHandles.delete(handle);
    }
    if (prepared) prepared.handles.length = 0;
  }
  private watchRequest(
    session: Session,
    requestId: number,
    operation: string,
    args: any[],
  ): unknown {
    const [a, b] = args;
    const request = session.pending.get(requestId);
    const cancelled = () =>
      sessionRevoked(session) ||
      !this.sessions.has(session) ||
      !request ||
      requestCancelled(request);
    if (operation === "watchOpen") {
      if (this.backend.watchOpen) {
        const register = (id: number) => {
          if (cancelled()) {
            this.backend.watchClose?.(session.connection.owner, id);
            throw new FilesystemError(11);
          }
          session.watchTransactions.set(requestId, {
            cancel: () => this.backend.watchClose?.(session.connection.owner, id),
            release: undefined,
          });
          return id;
        };
        const opening = this.backend.watchOpen(session.connection.owner, a, b, cancelled);
        return opening instanceof Promise
          ? this.trackRequestWork(session, opening).then(register)
          : register(opening);
      }
      if (!(this.backend instanceof MemoryBackend)) throw new FilesystemError(58);
      this.watchService ??= new WatchService(this.backend);
      const id = this.watchService.open(session.connection.owner, a, b, cancelled);
      session.watchTransactions.set(requestId, {
        cancel: () => this.watchService?.close(session.connection.owner, id),
        release: undefined,
      });
      return id;
    }
    if (operation === "watchRead") {
      if (this.backend.watchRead) {
        const register = (held: import("./watch-subscriptions.js").HeldWatchBatch) => {
          if (cancelled()) {
            held.rollback();
            throw new FilesystemError(11);
          }
          if (held.batch.events.length)
            session.watchTransactions.set(requestId, {
              cancel: held.rollback,
              release: held.release,
            });
          else held.release();
          return held.batch;
        };
        const reading = this.backend.watchRead(session.connection.owner, a, cancelled);
        return reading instanceof Promise
          ? this.trackRequestWork(session, reading).then(register)
          : register(reading);
      }
      if (!this.watchService) throw new FilesystemError(8);
      const held = this.watchService.readHeld(session.connection.owner, a);
      if (held.batch.events.length)
        session.watchTransactions.set(requestId, { cancel: held.rollback, release: held.release });
      else held.release();
      return held.batch;
    }
    if (operation === "watchClose") {
      if (this.backend.watchClose) {
        this.backend.watchClose(session.connection.owner, a);
        return;
      }
      this.watchService?.close(session.connection.owner, a);
      return;
    }
    throw new FilesystemError(58);
  }
  private walkReference(session: Session, handle: number): () => void {
    const references = new Map<number, number>();
    this.holdResponseReference(session, references, handle);
    const key = references.get(handle)!;
    return () => {
      this.dropResponseReference(session, handle, key);
      if (session.handles.get(handle) !== key || session.preopens.has(handle)) return;
      if (Atomics.compareExchange(session.capabilities, key + 1, 0, -1) !== 0) return;
      if (Atomics.load(session.capabilities, key + 2) > 0) {
        Atomics.store(session.capabilities, key + 1, 0);
        return;
      }
      this.forget(session, handle, key);
    };
  }
  private walkRequest(session: Session, id: number, operation: string, args: unknown[]): unknown {
    if (!(this.backend instanceof MemoryBackend)) throw new FilesystemError(58);
    const backend = this.backend;
    const execute = () => {
      if (sessionRevoked(session)) throw new FilesystemError(11);
      const table = (session.walks ??= new WalkTable(backend, (handle) =>
        this.walkReference(session, handle),
      ));
      if (operation === "walkRelease") return table.release(args[0]);
      if (operation === "walkClose") return table.close(args[0]);
      const pending = session.pending.get(id);
      if (!pending) throw new FilesystemError(11);
      const capacity = requestBytes(pending).length;
      const directory = args[0];
      if (operation === "walkOpen" && typeof directory !== "number") throw new FilesystemError(28);
      const transaction =
        operation === "walkOpen" && typeof directory === "number"
          ? table.open(directory, args[1])
          : operation === "walkPage"
            ? table.page(args[0], args[1], capacity)
            : undefined;
      if (!transaction) throw new FilesystemError(52);
      session.walkTransactions.set(id, transaction);
      if (pack(transaction.value).length > capacity) throw new FilesystemError(28);
      return transaction.value;
    };
    return backend.shared.ownsServiceMutation
      ? execute()
      : backend.shared.mutate(undefined, () => sessionRevoked(session), execute);
  }
  private settleWalk(session: Session, id: number, success: boolean): void {
    const transaction = session.walkTransactions.get(id);
    if (!transaction) return;
    session.walkTransactions.delete(id);
    if (success) {
      transaction.commit();
      session.walkResponses.set(id, transaction.cancel);
    } else transaction.rollback();
  }
  private takeResponseChunk(session: Session, a: number, b: number, c: number): Uint8Array {
    const response = session.responses.get(a);
    const bytes =
      response?.kind === "bytes"
        ? response.bytes
        : response?.payload.kind === "overflow"
          ? response.payload.bytes
          : undefined;
    if (!bytes) throw new FilesystemError(11);
    const part = bytes.slice(b, b + c);
    if (b + c < bytes.length) return part;
    this.releaseResponseMemory(session, a);
    if (response?.kind === "resolve") response.payload = { kind: "inline" };
    else if (session.watchResponses.has(a)) session.responses.delete(a);
    else this.discardResponse(session, a);
    return part;
  }
  private execute(
    session: Session,
    id: number,
    operation: string,
    args: any[],
    data: Uint8Array,
  ): unknown | Promise<unknown> {
    const [a, b, c] = args;
    this.checkSocketTree(session, operation, args);
    if (operation.startsWith("walk")) return this.walkRequest(session, id, operation, args);
    if (operation.startsWith("watch")) return this.watchRequest(session, id, operation, args);
    if (operation === "stageWrite") return this.stageWrite(session, id, a, b, c, data);
    if (operation === "take") return this.takeResponseChunk(session, a, b, c);
    if (operation === "retain") {
      const key = session.handles.get(a)!;
      for (;;) {
        const count = Atomics.load(session.capabilities, key + 1);
        if (count < 0) throw new FilesystemError(8);
        if (count === 0x7fffffff) throw new FilesystemError(33);
        if (Atomics.compareExchange(session.capabilities, key + 1, count, count + 1) === count)
          break;
      }
      session.references.set(a, (session.references.get(a) ?? 0) + 1);
      return;
    }
    if (operation === "release") {
      const owned = session.references.get(a) ?? 0;
      if (!owned) throw new FilesystemError(8);
      const key = session.handles.get(a)!;
      for (;;) {
        const count = Atomics.load(session.capabilities, key + 1);
        if (count <= 0) throw new FilesystemError(8);
        const forget = count === 1 && Atomics.load(session.capabilities, key + 2) === 0;
        if (
          Atomics.compareExchange(session.capabilities, key + 1, count, forget ? -1 : count - 1) !==
          count
        )
          continue;
        // A synchronous reservation publishes while holding a temporary ordinary reference.
        // Recheck after revocation before dropping the backend's last pin.
        if (forget && Atomics.load(session.capabilities, key + 2) > 0)
          Atomics.store(session.capabilities, key + 1, 0);
        if (owned > 1) session.references.set(a, owned - 1);
        else session.references.delete(a);
        if (forget && Atomics.load(session.capabilities, key + 1) === -1)
          this.forget(session, a, key);
        break;
      }
      return;
    }
    if (operation === "flush" || operation === "sync") {
      const target = operation === "sync" ? a : typeof a === "string" ? a : undefined;
      if (operation === "sync") this.backend.retain(a);
      let flushing: Promise<void> | undefined;
      try {
        flushing = this.backend.flush?.(target);
      } catch (error) {
        if (operation === "sync") this.backend.release(a);
        throw error;
      }
      return this.trackRequestWork(session, Promise.resolve(flushing)).then(
        () => {
          if (operation === "sync") this.backend.release(a);
          return this.finishResult(session, id, operation, operation === "sync" ? 0 : undefined);
        },
        (error) => {
          if (operation === "sync") this.backend.release(a);
          throw error;
        },
      );
    }
    if (operation === "resolve" && session.socketScope && this.backend instanceof MemoryBackend) {
      const result = this.backend.fs.resolveSocket(a, b, c === true);
      return this.finishResult(session, id, operation, result, args);
    }
    const isCancelled = () => {
      const pending = session.pending.get(id);
      return (
        !pending ||
        sessionRevoked(session) ||
        !this.sessions.has(session) ||
        requestCancelled(pending)
      );
    };
    const result = this.backend.execute(operation, args, data, isCancelled);
    if (result instanceof Promise)
      return this.trackRequestWork(session, result).then((value) =>
        this.finishResult(session, id, operation, value, args),
      );
    return this.finishResult(session, id, operation, result, args);
  }
  private finishResult(
    session: Session,
    id: number,
    operation: string,
    result: any,
    args: any[] = [],
  ): unknown {
    try {
      this.finishSocketOperation(session, operation, result, args);
      const pending = session.pending.get(id);
      const scalarWrite = operation === "write" || operation === "append";
      if (
        !pending ||
        (!scalarWrite &&
          (sessionRevoked(session) || !this.sessions.has(session) || requestCancelled(pending)))
      )
        throw new FilesystemError(11);
      if (operation === "preopen" || (operation === "create" && typeof result === "number"))
        this.pin(session, result, operation === "preopen");
      // Touch every returned identity before choosing an eviction victim: a new parent may point
      // to a hard-linked node that was previously the oldest transient capability.
      if (operation === "resolve" && typeof result !== "number")
        this.holdResolvedResponse(session, id, result);
      if (mutations.has(operation)) {
        for (const peer of this.sessions) if (!isRevoked(peer.connection)) this.trim(peer);
      } else this.trim(session);
      return result;
    } finally {
      this.backend.settleResult?.(operation, result);
    }
  }
  private checkSocketTree(session: Session, operation: string, args: any[]): void {
    if (
      operation !== "bindSocket" ||
      !session.socketScope ||
      !(this.backend instanceof MemoryBackend)
    )
      return;
    const error = this.backend.fs.socketParentAccess(session.socketScope.root, args[0]);
    if (error) throw new FilesystemError(error);
  }
  private finishSocketOperation(
    session: Session,
    operation: string,
    result: any,
    args: any[],
  ): void {
    const scope = session.socketScope;
    if (!scope) return;
    if (
      (operation === "bindSocket" || operation === "bindSocketPath") &&
      result &&
      !("error" in result)
    ) {
      const binding = operation === "bindSocketPath" ? result.binding : result;
      const name = operation === "bindSocketPath" ? result.name : args[1];
      this.backend.retain(binding.parent);
      this.backend.retain(binding.node);
      scope.leases.set(args[2], { binding, name });
      this.pin(session, binding.parent);
      this.pin(session, binding.node);
    }
    if (operation !== "unbindSocket" || (result !== 0 && result !== 44)) return;
    const owned = scope.leases.get(args[2]);
    if (!owned) return;
    scope.leases.delete(args[2]);
    this.backend.release(owned.binding.node);
    this.backend.release(owned.binding.parent);
  }
  private preparedReadInvalidated(
    prepared: PreparedRequest | undefined,
    epoch: Int32Array,
  ): boolean {
    const read = prepared?.read;
    if (!read) return false;
    if (read.startEpoch !== undefined && Atomics.load(epoch, 0) !== read.startEpoch) return true;
    return read.startVersion !== undefined && this.backend.readVersion?.() !== read.startVersion;
  }
  private dirtyRetryChange(error: unknown): number | undefined {
    if (
      !(error instanceof DirtyCapacityError) ||
      error.permanent ||
      !this.backend.waitForDirtyCapacity
    )
      return undefined;
    return (
      this.backend.dirtyChange?.() ??
      (this.backend instanceof MemoryBackend
        ? this.backend.shared.dirtyAdmission.change
        : undefined)
    );
  }
  private cancelSessionWatchResponses(session: Session): void {
    for (const [id, watch] of session.watchResponses) {
      session.watchResponses.delete(id);
      watch.cancel();
    }
  }
  private assertBackendAccess(): void {
    if (this.backend instanceof MemoryBackend) this.backend.shared.publication?.assertAccess();
  }
  private async request(
    session: Session,
    id: number,
    buffer: FilesystemRequestBuffer,
    prepared?: PreparedRequest,
    decoded?: { operation: string; args: unknown[]; publication?: unknown },
  ): Promise<void> {
    const cells = requestCells(buffer);
    const response = requestBytes(buffer);
    const bytes = requestInput(session, id, response);
    let state = State.Complete;
    let mutation = false;
    let opened = false;
    let preparing = false;
    let staging = false;
    let committedWrite = false;
    let admission: PublicationAdmission | undefined;
    let dirtyRetry: number | undefined;
    const epoch = session.epoch;
    try {
      if (sessionRevoked(session) || !this.sessions.has(session) || requestCancelled(buffer))
        throw new FilesystemError(11);
      const { inputLength, dataLength } = requestLengths(buffer, bytes);
      const input = decoded ?? unpack(bytes.subarray(0, inputLength));
      const { operation, args } = input;
      if (session.connection.publication && input.publication)
        admission = publicationAdmission(input.publication);
      this.checkRequest(session, operation, args);
      if (prepared?.failure) throw prepared.failure.error;
      if (this.preparedReadInvalidated(prepared, epoch)) {
        this.releasePrepared(session, prepared);
        prepared = undefined;
      }
      this.assertBackendAccess();
      const continuation = this.prepareRequest(
        session,
        id,
        buffer,
        operation,
        args,
        bytes.subarray(inputLength, inputLength + dataLength),
        prepared,
      );
      if (continuation) {
        prepared = continuation;
        preparing = true;
        return;
      }
      // From here to completion the serial execute queue owns the request again.
      this.releasePrepared(session, prepared);
      const local = this.backend instanceof MemoryBackend && this.backend.shared.publication;
      mutation = mutations.has(operation) && !local;
      if (mutation) {
        if (this.backend instanceof MemoryBackend) this.backend.shared.beginServiceMutation(epoch);
        else opened = this.beginEpochMutation(epoch);
      }
      const payload = bytes.subarray(inputLength, inputLength + dataLength);
      const preparedRead =
        prepared?.read && (!this.backend.isPreparedReadValid || this.backend.isPreparedReadValid())
          ? prepared.read
          : undefined;
      if (operation === "write" || operation === "append") session.inFlightWrites.add(id);
      const value = preparedRead
        ? this.finishResult(session, id, operation, preparedRead.value)
        : local && operation !== "flush" && operation !== "sync"
          ? this.executePublication(session, id, operation, args, payload, admission)
          : await this.execute(session, id, operation, args, payload);
      this.announceSegments(this.backend.takeSharedSegments?.() ?? [], this.sessions);
      state = this.writeResponse(session, id, cells, response, value, bytes);
      staging = operation === "stageWrite";
      committedWrite = isCommittedScalarWrite(operation, state);
    } catch (error) {
      this.discardResponse(session, id);
      const dirtyChange = this.dirtyRetryChange(error);
      if (dirtyChange !== undefined) {
        dirtyRetry = dirtyChange;
        prepared ??= { handles: [] };
        const input = unpack(bytes.subarray(0, cells[1]!));
        this.checkRequest(session, input.operation, input.args, prepared.handles);
        preparing = true;
      } else {
        cells[3] = errno(error);
        state = cells[3] === 11 ? State.Cancelled : State.Failed;
      }
    } finally {
      const offered = this.finishRequestMutation(epoch, mutation, opened);
      // A failed offer fails the request rather than leaving it pending.
      if (offered && !preparing && state !== State.Failed && state !== State.Cancelled) {
        this.discardResponse(session, id);
        cells[3] = errno(offered.error);
        state = State.Failed;
      }
      if (!preparing) {
        this.cancelPublication(session, admission);
        this.releasePrepared(session, prepared);
        cells[5] = Atomics.load(epoch, 0);
        state = this.settleCancelledState(session, id, buffer, state, staging, committedWrite);
        this.settleWalk(session, id, state === State.Complete);
        this.settleWatch(session, id, state === State.Complete || state === State.Overflow);
        Atomics.store(cells, 0, state);
        Atomics.notify(cells, 0);
        wake(session.connection);
        session.inFlightWrites.delete(id);
        session.pending.delete(id);
        session.privateInputs.delete(id);
        this.retainRequestReply(session, id, buffer);
        session.connection.port.postMessage({ completed: id });
        this.sweep();
      } else {
        session.inFlightWrites.delete(id);
      }
    }
    if (dirtyRetry !== undefined && prepared) {
      const wait = this.backend.waitForDirtyCapacity!(
        dirtyRetry,
        () => sessionRevoked(session) || requestCancelled(buffer),
      );
      this.joinPreparation(session, id, buffer, prepared, wait);
    }
  }
  private settleCancelledState(
    session: Session,
    id: number,
    buffer: FilesystemRequestBuffer,
    state: State,
    staging: boolean,
    committedWrite: boolean,
  ): State {
    if (sessionRevoked(session) || requestCancelled(buffer)) {
      this.discardResponse(session, id);
      // Preserve inline committed write/append results so shared-offset leases observe
      // an already-landed mutation before releasing the offset lock.
      if (!committedWrite) state = State.Cancelled;
    }
    // Complete is what lets the client commit a stage. Never publish it for a stage the
    // owner no longer holds, or that commit would have nothing to apply.
    if (staging && !session.stages.has(id)) return State.Cancelled;
    return state;
  }
  private holdResponseMemory(session: Session, id: number, release: () => void): void {
    const prior = session.responseMemory.get(id);
    session.responseMemory.set(id, () => {
      try {
        prior?.();
      } finally {
        release();
      }
    });
  }
  private settleWatch(session: Session, id: number, success: boolean): void {
    const transaction = session.watchTransactions.get(id);
    if (!transaction) return;
    session.watchTransactions.delete(id);
    if (!success) {
      transaction.cancel();
      return;
    }
    session.watchResponses.set(id, {
      cancel: transaction.cancel,
      release: transaction.release,
    });
  }
  private retainRequestReply(session: Session, id: number, buffer: FilesystemRequestBuffer): void {
    if (
      session.responses.has(id) ||
      session.walkResponses.has(id) ||
      session.watchResponses.has(id) ||
      session.stages.has(id)
    ) {
      session.retainedRequests.set(id, buffer);
      return;
    }
    releaseRequestBuffer(buffer, REQUEST_SERVICE);
  }
  private writeResponse(
    session: Session,
    id: number,
    cells: Int32Array,
    bytes: Uint8Array,
    value: unknown,
    input: Uint8Array,
  ): State {
    const binary = value instanceof Uint8Array;
    const result = binary ? value : pack(value);
    cells[2] = result.length;
    cells[4] = binary ? 1 : 0;
    const response = session.responses.get(id);
    if (result.length > bytes.length) {
      const release = retainResponseBytes(session.requests, result.length);
      const stored = independentResponse(result, input, release);
      this.holdResponseMemory(session, id, release);
      if (response?.kind === "resolve") response.payload = { kind: "overflow", bytes: stored };
      else session.responses.set(id, { kind: "bytes", bytes: stored });
      return State.Overflow;
    }
    if (response?.kind === "resolve") response.payload = { kind: "inline" };
    bytes.set(result);
    return State.Complete;
  }
  private joinPreparation(
    session: Session,
    id: number,
    buffer: FilesystemRequestBuffer,
    continuation: PreparedRequest,
    preparation: Promise<void>,
  ): void {
    const original = this.trackWork(session, preparation);
    const joined = original.then(
      () => this.enqueue(session, id, buffer, continuation),
      (error) => {
        continuation.failure = { error };
        this.enqueue(session, id, buffer, continuation);
      },
    );
    this.trackWork(session, joined);
    session.preparations.add(joined);
    this.preparingSessions.add(session);
    void joined.then(
      () => this.releasePreparation(session, joined),
      () => this.releasePreparation(session, joined),
    );
  }
  private prepareRequest(
    session: Session,
    id: number,
    buffer: FilesystemRequestBuffer,
    operation: string,
    args: Parameters<NonNullable<FilesystemBackend["prepare"]>>[1],
    payload: Uint8Array,
    prepared?: PreparedRequest,
  ): PreparedRequest | undefined {
    if (operation === "flush" || operation === "sync" || prepared?.read) return;
    if (operation.startsWith("publicationRead"))
      return this.prepareRead(session, id, buffer, operation, args);
    if (operation === "dirtyWait" && prepared) return;
    if (operation === "read") {
      const read = this.backend.prepareDescriptorRead?.(
        args[0],
        args[2],
        args[1],
        () => sessionRevoked(session) || requestCancelled(buffer),
      );
      if (read) return this.prepareDescriptorRead(session, id, buffer, operation, args, read);
    }
    const preparation =
      operation === "dirtyWait"
        ? this.backend.waitForDirtyCapacity?.(
            args[1],
            () => sessionRevoked(session) || requestCancelled(buffer),
          )
        : this.prepareBackend(operation, args, payload);
    if (!preparation) return;
    const continuation = prepared ?? { handles: [] };
    this.checkRequest(session, operation, args, continuation.handles);
    this.joinPreparation(session, id, buffer, continuation, preparation);
    return continuation;
  }
  /** Storage work a backend finishes before the request owns the queue. A pin reads its file,
   * and a staged write needs its file loaded and writable, exactly as growth does. */
  private prepareBackend(
    operation: string,
    args: Parameters<NonNullable<FilesystemBackend["prepare"]>>[1],
    payload: Uint8Array,
  ): void | Promise<void> {
    if (operation === "publicationPin") return this.backend.prepare?.("read", [args[1]], payload);
    if (operation === "stageWrite") return this.backend.prepare?.("grow", [args[0], 0], payload);
    return this.backend.prepare?.(operation, args, payload);
  }
  private prepareDescriptorRead(
    session: Session,
    id: number,
    buffer: FilesystemRequestBuffer,
    operation: string,
    args: unknown[],
    read: Promise<Uint8Array>,
  ): PreparedRequest {
    const startEpoch = Atomics.load(session.epoch, 0);
    const startVersion = this.backend.readVersion?.();
    const continuation: PreparedRequest = { handles: [] };
    this.checkRequest(session, operation, args, continuation.handles);
    const capture = read.then((value) => {
      continuation.read = { value, startEpoch, startVersion };
    });
    this.joinPreparation(session, id, buffer, continuation, capture);
    return continuation;
  }
  private prepareRead(
    session: Session,
    id: number,
    buffer: FilesystemRequestBuffer,
    operation: string,
    args: unknown[],
  ): PreparedRequest {
    if (
      !(this.backend instanceof MemoryBackend) ||
      !session.connection.publication?.observer ||
      args[0] !== session.connection.publication.observer
    )
      throw new FilesystemError(2);
    session.reader ??= new WorkspaceReadAuthority(
      this.backend,
      (this.readBudget ??= new WorkspaceReadBudget(
        session.connection.publication.buffers.readerLifetimes?.byteLength,
      )),
      new ReaderLifetime(session.connection.publication),
    );
    const continuation: PreparedRequest = { handles: [] };
    const original = this.trackWork(session, session.reader.invoke(operation, args, id));
    const joined = original.then(
      (value) => {
        continuation.read = { value };
        this.enqueue(session, id, buffer, continuation);
      },
      (error: unknown) => {
        continuation.failure = { error };
        this.enqueue(session, id, buffer, continuation);
      },
    );
    this.trackWork(session, joined);
    session.preparations.add(joined);
    this.preparingSessions.add(session);
    void joined.then(
      () => this.releasePreparation(session, joined),
      () => this.releasePreparation(session, joined),
    );
    return continuation;
  }
  private releasePreparation(session: Session, joined: Promise<void>): void {
    session.preparations.delete(joined);
    if (!session.preparations.size) this.preparingSessions.delete(session);
  }
  private cancelPublication(session: Session, admission?: PublicationAdmission): void {
    if (!admission || !session.connection.publication || !(this.backend instanceof MemoryBackend))
      return;
    this.backend.shared.publication?.cancel(session.connection.publication.session, admission);
  }
  private executePublication(
    session: Session,
    id: number,
    operation: string,
    args: unknown[],
    data: Uint8Array,
    admission?: PublicationAdmission,
  ): unknown {
    if (!(this.backend instanceof MemoryBackend)) throw new FilesystemError(58);
    const backend = this.backend,
      domain = backend.shared.publication!,
      connection = session.connection.publication;
    if (!connection) throw new FilesystemError(2);
    backend.shared.beginServiceMutation(session.epoch);
    try {
      domain.assertLive();
      this.checkSocketTree(session, operation, args);
      if (operation.startsWith("publication"))
        return this.publicationControl(session, operation, args);
      const intent = mutationIntent(operation, args);
      if (!intent) {
        const value = this.execute(session, id, operation, args, data);
        if (value instanceof Promise)
          throw new FilesystemError(58, "publication execute must be synchronous");
        return value;
      }
      if (!admission) throw new FilesystemError(28, "publication admission required");
      domain.verify(connection.session, admission, intent, data);
      if (intent.kind === "preopen" && !session.freeEntries.length) throw new FilesystemError(51);
      const plan = backend.planPublication(intent, data);
      let publication: import("./publication.js").PreparedPublication;
      try {
        if (
          (intent.kind === "create" || intent.kind === "preopen") &&
          plan.result.kind === "number" &&
          !session.handles.has(plan.result.value) &&
          !session.freeEntries.length
        )
          throw new FilesystemError(51);
        backend.prepareMutation(plan);
        publication = domain.prepare(admission, plan.result, plan.changes);
      } catch (error) {
        backend.discardPublication(plan);
        throw error;
      }
      return this.applyPublication(session, id, operation, plan, publication, args);
    } finally {
      backend.shared.endServiceMutation(session.epoch);
    }
  }
  private applyPublication(
    session: Session,
    id: number,
    operation: string,
    plan: import("./backend.js").LocalMutationPlan,
    publication: import("./publication.js").PreparedPublication,
    args: any[],
  ): unknown {
    if (!(this.backend instanceof MemoryBackend)) throw new FilesystemError(58);
    const domain = this.backend.shared.publication!;
    try {
      domain.assertLive();
      this.backend.applyPublication(plan);
      domain.commit(publication);
    } catch (error) {
      domain.stop();
      throw error;
    }
    return this.finishResult(session, id, operation, mutationValue(plan.result), args);
  }
  private namespaceControl(
    backend: MemoryBackend,
    session: Session,
    operation: string,
    args: unknown[],
  ): unknown {
    const domain = backend.shared.publication!;
    switch (operation) {
      case "publicationNamespaceNext": {
        const serial = args[1],
          options = args[2];
        if (
          typeof serial !== "number" ||
          !Number.isSafeInteger(serial) ||
          serial < 1 ||
          !options ||
          typeof options !== "object" ||
          !("prefix" in options) ||
          typeof options.prefix !== "string" ||
          !("includeDirs" in options) ||
          typeof options.includeDirs !== "boolean"
        )
          throw new FilesystemError(28);
        session.namespace ??= new NamespaceAuthority(backend);
        return session.namespace.next(serial, {
          prefix: options.prefix,
          includeDirs: options.includeDirs,
        });
      }
      case "publicationNamespaceClose": {
        const serial = args[1];
        if (
          serial !== undefined &&
          (typeof serial !== "number" || !Number.isSafeInteger(serial) || serial < 1)
        )
          throw new FilesystemError(28);
        session.namespace ??= new NamespaceAuthority(backend);
        session.namespace.close(serial);
        return;
      }
      case "publicationNamespaceChanges": {
        const after = publicationCut(args[1]);
        const available = domain.availability();
        const page = domain.changes(after, domain.limits.effectBytes);
        return {
          workspace: backend.workspaceId,
          ...available,
          kind: page.kind,
          publications:
            page.kind === "changes"
              ? page.publications.map((group) =>
                  encodeEffects(group.receipt, group.changes, domain.limits.effectBytes),
                )
              : [],
          next: page.kind === "changes" ? page.next : available.current,
        };
      }
      default:
        throw new FilesystemError(58);
    }
  }
  private publicationControl(session: Session, operation: string, args: unknown[]): unknown {
    if (!(this.backend instanceof MemoryBackend)) throw new FilesystemError(58);
    const grant = session.connection.publication?.observer;
    if (!grant || args[0] !== grant) throw new FilesystemError(2);
    const domain = this.backend.shared.publication!;
    if (operation.startsWith("publicationNamespace"))
      return this.namespaceControl(this.backend, session, operation, args);
    switch (operation) {
      case "publicationWorkspace":
      case "publicationResident": {
        const handle = args[1],
          workspace = args[2];
        if (typeof handle !== "number" || typeof workspace !== "string" || !workspace.length)
          throw new FilesystemError(28);
        this.check(session, handle);
        this.residentPublication ??= new ResidentGrantAuthority(
          this.backend,
          session.epoch,
          workspace,
        );
        if (this.residentPublication.workspace !== workspace) throw new FilesystemError(28);
        this.residentPublication.workspaceHost ??= {
          root: session.connection,
          connect: (connection) => this.connect(connection),
          adopt: (connection, reservation) => this.adoptWorkspace(connection, reservation),
          close: (connection) => this.closeWorkspace(connection),
        };
        const descriptor = this.residentPublication.retain(
          handle,
          operation === "publicationWorkspace" ? "workspace" : "file",
        );
        domain.excludeDirect();
        return descriptor;
      }
      case "publicationCut":
        return domain.cut();
      case "publicationChanges": {
        const limit = args[2];
        if (
          typeof limit !== "number" ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > domain.limits.logBytes
        )
          throw new FilesystemError(28);
        return domain.changes(publicationCut(args[1]), limit);
      }
      case "publicationReceipt": {
        const identity = args[1];
        if (
          !identity ||
          typeof identity !== "object" ||
          !("session" in identity) ||
          !("sequence" in identity) ||
          typeof identity.session !== "number" ||
          typeof identity.sequence !== "number"
        )
          throw new FilesystemError(28);
        return domain.lookupAny({ session: identity.session, sequence: identity.sequence });
      }
      case "publicationPin":
        return this.publicationPin(session, args);
      case "publicationReleasePin": {
        const id = args[1];
        if (typeof id !== "number" || !session.publicationPins?.delete(id))
          throw new FilesystemError(28);
        domain.releasePin(id);
        return;
      }
      case "publicationDiagnostics":
        return domain.diagnostics();
      case "publicationStop":
        domain.stop();
        return;
      default:
        throw new FilesystemError(52);
    }
  }
  private publicationPin(session: Session, args: readonly unknown[]): unknown {
    if (!(this.backend instanceof MemoryBackend)) throw new FilesystemError(58);
    const [, handle, offset, length] = args;
    const shared = this.backend.shared,
      domain = shared.publication!;
    if (
      typeof handle !== "number" ||
      typeof offset !== "number" ||
      typeof length !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > Math.floor(domain.limits.pinBytes / domain.limits.pins)
    )
      throw new FilesystemError(28);
    this.check(session, handle);
    const stat = shared.info(handle);
    if (!stat || stat.kind !== "file") throw new FilesystemError(8);
    const read = this.backend.execute("read", [handle, length, offset], new Uint8Array());
    if (!(read instanceof Uint8Array)) throw new FilesystemError(29);
    const pin = domain.pin(
      { birthHistory: domain.buffers.history, ino: stat.ino },
      domain.contentVersion(stat.ino),
      read,
    );
    session.publicationPins!.add(pin.id);
    return { ...pin, bytes: Array.from(pin.bytes) };
  }
  sweep(): void {
    if (this.shutdownOwner) return;
    // A close can itself wait for a holder that dies later. Recover dead owners even
    // on reentry, while keeping session close and release bookkeeping non-reentrant.
    for (const session of this.sessions)
      if (Atomics.load(new Int32Array(session.connection.revocations[0]!), 0) === 2)
        this.backend.revokeOwner?.(session.connection.owner, session.epoch);
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const session of this.sessions) if (sessionRevoked(session)) this.close(session);
    } finally {
      this.sweeping = false;
    }
  }
  private close(session: Session): void {
    if (this.shutdownOwner) return;
    if (requestTransportError(session.requests)) session.transportFailed = true;
    this.releaseSession(session);
  }
  private releaseSession(session: Session): void {
    if (session.releaseState?.kind === "running") return;
    if (session.releaseState?.kind === "failed") throw session.releaseState.error;
    session.releaseState = { kind: "running" };
    try {
      this.releaseSessionPins(session);
      session.releaseState = undefined;
    } catch (error) {
      session.releaseState = { kind: "failed", error };
      throw error;
    }
  }
  private stopSessionReader(session: Session): void {
    if (session.reader && !session.readerClosing) {
      session.readerClosing = this.trackWork(session, session.reader.stop());
      void session.readerClosing.then(
        () => this.sweep(),
        () => {},
      );
    }
  }
  private clearSessionHandlesAndBuffers(session: Session): void {
    for (const key of session.handles.values()) Atomics.store(session.capabilities, key + 1, -1);
    for (const handle of Array.from(session.handles.keys())) {
      if (Atomics.load(session.capabilities, session.handles.get(handle)! + 2) > 0) continue;
      this.backend.release(handle);
      session.handles.delete(handle);
    }
    Atomics.store(session.capabilities, 0, 0);
    for (const lease of session.socketScope?.leases.values() ?? []) {
      this.backend.release(lease.binding.node);
      this.backend.release(lease.binding.parent);
    }
    session.socketScope?.leases.clear();
    session.preopens.clear();
    session.transient.clear();
    session.references.clear();
    for (const retained of session.retainedRequests.values())
      releaseRequestBuffer(retained, REQUEST_SERVICE);
    session.retainedRequests.clear();
    for (const release of session.responseMemory.values()) release();
    session.responseMemory.clear();
    session.responses.clear();
    session.preparingHandles.clear();
    if (this.backend instanceof MemoryBackend)
      for (const id of session.publicationPins ?? [])
        this.backend.shared.publication?.releasePin(id);
    session.publicationPins?.clear();
  }
  private cancelPendingRequests(session: Session): void {
    for (const [id, buffer] of session.pending) {
      const cells = requestCells(buffer);
      Atomics.store(cells, 6, 1);
      Atomics.store(cells, 0, State.Cancelled);
      Atomics.notify(cells, 0);
      session.connection.port.postMessage({ completed: id });
    }
    session.pending.clear();
  }
  private releaseSessionPins(session: Session): void {
    this.cancelSessionWatchResponses(session);
    this.watchService?.closeOwner(session.connection.owner);
    this.backend.closeWatchOwner?.(session.connection.owner);
    session.namespace?.close();
    this.stopSessionReader(session);
    if (!session.transportFailed) revokeFilesystem(session.connection);
    const ownRevocation = Atomics.load(new Int32Array(session.connection.revocations[0]!), 0);
    if (session.quiescing) return;
    // Revocation precedes the admission-count observation. Looking only at held locks misses
    // an entrant between admission and acquisition, which may still be touching a pin or page.
    if (session.transportFailed && ownRevocation !== 2 && requestMemorySections(session.requests)) {
      session.quiescing ??= this.trackWork(
        session,
        waitForRequestQuiescence(session.connection, session.requests).then(() => {
          session.quiescing = undefined;
          this.sweep();
        }),
      );
      return;
    }
    if (
      !session.transportFailed &&
      ownRevocation !== 2 &&
      Atomics.load(new Int32Array(session.connection.sections), 0)
    ) {
      session.quiescing ??= this.trackWork(
        session,
        waitForFilesystemQuiescence(session.connection).then(() => {
          // The field controls rearming; work retains this original outcome after it clears.
          session.quiescing = undefined;
          this.sweep();
        }),
      );
      return;
    }
    // Keep the session open until every already-dispatched write/append publishes its
    // authoritative commit or abort state; request()'s finally calls sweep() on completion.
    if (session.inFlightWrites.size) return;
    if (ownRevocation === 2) this.backend.revokeOwner?.(session.connection.owner, session.epoch);
    // A discard can be lost when a port closes. Retirement settles what remains, before this
    // session's file pins and request blocks go: a committed write is applied, never dropped.
    for (const id of Array.from(session.stages.keys())) this.settleStage(session, id);
    this.cancelPendingRequests(session);
    wake(session.connection);
    for (const id of session.walkTransactions.keys()) this.settleWalk(session, id, false);
    session.walks?.dispose();
    session.walkResponses.clear();
    for (const id of session.watchTransactions.keys()) this.settleWatch(session, id, false);
    this.cancelSessionWatchResponses(session);
    session.watchResponses.clear();
    this.clearSessionHandlesAndBuffers(session);
    session.connection.port.close();
    session.closed = true;
    this.retireTransport(session);
    if (!session.handles.size) {
      const publication = session.connection.publication;
      if (publication && !this.retirePublication(session)) return;
      this.sessions.delete(session);
    }
    this.closeDisposedWatchAccount();
    if (
      !this.sessions.size &&
      this.backend instanceof MemoryBackend &&
      this.backend.shared.publication?.stopped
    )
      this.backend.shared.publication.releaseStopped();
  }
  private retirePublication(session: Session): boolean {
    if (session.reader && !session.reader.lifetime.drained) return false;
    if (!(this.backend instanceof MemoryBackend)) return true;
    const domain = this.backend.shared.publication,
      connection = session.connection.publication;
    if (!domain || !connection || domain.stopped) return true;
    try {
      domain.closeSession(connection.session);
    } catch (error) {
      if (!(error instanceof FilesystemError) || error.errno !== 6) throw error;
      session.retirement ??= setTimeout(() => {
        session.retirement = undefined;
        this.sweep();
      }, 0);
      return false;
    }
    if (session.retirement) clearTimeout(session.retirement);
    session.retirement = undefined;
    return true;
  }
  resources() {
    const backend = this.backend.resources?.() ?? {};
    let socketLeases = 0,
      socketScopes = 0;
    let workspaceCursors = 0,
      walks = 0,
      walkGrants = 0;
    let retained = 0,
      transient = 0,
      responses = 0,
      capabilityBytes = 0;
    for (const session of this.sessions) {
      socketScopes += session.socketScope ? 1 : 0;
      socketLeases += session.socketScope?.leases.size ?? 0;
      workspaceCursors += session.namespace?.size ?? 0;
      walks += session.walks?.size ?? 0;
      walkGrants += session.walks?.liveGrants ?? 0;
      retained += session.handles.size;
      responses += session.responses.size;
      capabilityBytes += session.connection.capabilities.byteLength;
      for (const handle of session.transient.keys())
        if (Atomics.load(session.capabilities, session.handles.get(handle)! + 1) === 0) transient++;
    }
    const ownerStateBytes =
      this.sessions.values().next().value?.connection.ownerStates.byteLength ?? 0;
    const readers =
      this.backend instanceof MemoryBackend ? (this.readBudget?.resources(this.backend) ?? {}) : {};
    const requestTransportBytes = this.requestBudget ? requestBudgetBytes(this.requestBudget) : 0;
    return Object.assign(
      {
        ...backend,
        requestTransportBytes,
        workspaceCursors,
        walks,
        walkGrants,
        socketLeases,
        socketScopes,
        ownerStateBytes,
        clients: this.sessions.size,
        retained,
        transient,
        responses,
        capabilityBytes,
        metadataBytes: (backend.metadataBytes ?? 0) + capabilityBytes + ownerStateBytes,
        bytes: (backend.bytes ?? 0) + capabilityBytes + ownerStateBytes + requestTransportBytes,
      },
      readers,
    );
  }
  drainForOwner(): Promise<void> {
    if (this.ownerDraining) return this.ownerDraining;
    this.ownerStopping = true;
    // Keep actual records before revocation can sweep them out of the service set.
    const sessions = Array.from(
      new Set(Array.from(this.sessions).concat(Array.from(this.preparingSessions))),
    );
    const quiescence = sessions.flatMap((session) =>
      session.quiescing ? [session.quiescing] : [],
    );
    const waits = quiescence.concat(
      sessions.map((session) => waitForFilesystemQuiescence(session.connection)),
    );
    return (this.ownerDraining = this.drainOwnerWork(sessions, waits));
  }
  private async drainOwnerWork(sessions: Session[], quiescence: Promise<void>[]): Promise<void> {
    await Promise.all(quiescence);
    await Promise.all(
      sessions.flatMap((session) => (session.reader ? [session.reader.stop()] : [])),
    );
    await this.queue;
    await Promise.all(sessions.flatMap((session) => Array.from(session.preparations)));
    await this.queue;
    await Promise.all(Array.from(this.runningRequests));
    await this.queue;
    this.sweep();
    if (
      this.runningRequests.size ||
      sessions.some((session) => session.preparations.size || session.pending.size)
    )
      throw new FilesystemError(6, "filesystem owner still has pending work");
  }
  private closeDisposedWatchAccount(): void {
    if (this.disposingWatches && !this.sessions.size && this.backend instanceof MemoryBackend)
      this.backend.watchAccount.close();
  }
  beginDispose(): void {
    this.backend.beginDispose?.();
  }
  dispose(): void {
    if (this.shutdownOwner) return;
    this.disposingWatches = true;
    this.residentPublication?.dispose();
    for (const session of this.sessions) this.close(session);
    this.closeDisposedWatchAccount();
  }
  shutdown(): Promise<void> {
    if (this.shutdownOwner) return this.shutdownOwner.done;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const sessions = Array.from(
      new Set(
        Array.from(this.sessions).concat(
          Array.from(this.preparingSessions),
          Array.from(this.work.values()),
        ),
      ),
    );
    const owner = { done, sessions };
    this.shutdownOwner = owner;
    this.ownerStopping = true;
    this.backend.beginShutdown?.();
    for (const session of sessions) this.stopSessionReader(session);
    const fences = sessions.map((session) => this.shutdownFence(session));
    void this.drainShutdown(owner, fences).then(resolve, reject);
    return done;
  }
  private async shutdownFence(session: Session): Promise<void> {
    revokeFilesystemService(session.connection);
    const quiesced = waitForFilesystemQuiescence(session.connection);
    let done = false;
    void quiesced.finally(() => {
      done = true;
      wake(session.connection);
    });
    const signal = new Int32Array(session.connection.signal);
    while (!done) {
      const observed = Atomics.load(signal, 0);
      if (requestTransportError(session.requests)) {
        session.transportFailed = true;
        await this.drainFailedSessionRequests(session);
        break;
      }
      const waiting = atomicsWaitAsync(signal, 0, observed);
      if (waiting.async) await waiting.value;
    }
    await quiesced;
  }
  private async drainFailedSessionRequests(session: Session): Promise<void> {
    // A transport error stops receive() from accepting new descriptors. Drain every already-
    // accepted request (including flush/sync barriers kept outside this.queue) and preparation
    // first, then retire transport memory so undelivered client writes can release their leases.
    await waitForRequestQuiescence(session.connection, session.requests);
    for (;;) {
      const queue = this.queue;
      await queue;
      const pending = Array.from(this.runningRequests).filter(
        (done) => this.work.get(done) === session,
      );
      if (pending.length) await Promise.allSettled(pending);
      if (session.preparations.size) await Promise.allSettled(Array.from(session.preparations));
      const stillRunning = Array.from(this.runningRequests).some(
        (done) => this.work.get(done) === session,
      );
      if (
        queue === this.queue &&
        !stillRunning &&
        !session.preparations.size &&
        !session.inFlightWrites.size
      )
        break;
    }
    this.cancelPendingRequests(session);
    const failure = requestTransportError(session.requests);
    if (failure?.reason !== "stale" && !requestMemoryRetired(session.requests))
      retireRequestMemory(session.requests);
    wakeTransport(session.connection);
  }
  private async drainShutdown(owner: ShutdownOwner, fences: Promise<void>[]): Promise<void> {
    const failures: unknown[] = [];
    this.collectFailures(await Promise.allSettled(fences), failures);
    await this.drainShutdownWork(failures);
    if (
      this.residentPublication ||
      owner.sessions.some(
        (session) =>
          session.connection.residentPublication ||
          (session.connection.publication && !session.connection.publication.buffers.pageReaders),
      )
    )
      failures.push(new FilesystemError(6, "ordinary shutdown cannot finalize publication owners"));
    this.throwShutdownFailures(failures);
    this.recoverShutdownOwners(owner.sessions, failures);
    this.throwShutdownFailures(failures);
    for (const session of owner.sessions) {
      try {
        await this.releaseShutdownSession(session);
      } catch (error) {
        failures.push(error);
      }
    }
    if (
      !failures.length &&
      Array.from(this.refusedConnections).some((connection) =>
        connection.reservations.some(
          (reservation) => Atomics.load(new Int32Array(reservation.state), 1) === 0,
        ),
      )
    )
      failures.push(new FilesystemError(6, "filesystem has unresolved refused transfers"));
    this.throwShutdownFailures(failures);
    await this.backend.close?.();
    if (this.backend instanceof MemoryBackend) this.backend.watchAccount.close();
  }
  private recoverShutdownOwners(sessions: readonly Session[], failures: unknown[]): void {
    for (const session of sessions) {
      if (Atomics.load(new Int32Array(session.connection.revocations[0]!), 0) !== 2) continue;
      try {
        this.backend.revokeOwner?.(session.connection.owner, session.epoch);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  private async drainShutdownWork(failures: unknown[]): Promise<void> {
    const joined = new Set<Promise<unknown>>();
    for (;;) {
      const queue = this.queue;
      await queue;
      const work = Array.from(this.work.keys()).filter((done) => !joined.has(done));
      for (const done of work) joined.add(done);
      this.collectFailures(await Promise.allSettled(work), failures);
      if (queue !== this.queue) continue;
      if (Array.from(this.work.keys()).some((done) => !joined.has(done))) continue;
      return;
    }
  }
  private async releaseShutdownSession(session: Session): Promise<void> {
    for (;;) {
      await this.shutdownFence(session);
      this.releaseSession(session);
      if (!session.quiescing) break;
    }
    if (this.sessions.has(session))
      throw new FilesystemError(6, "filesystem session retains unresolved transfers");
  }
  private collectFailures(
    results: readonly PromiseSettledResult<unknown>[],
    failures: unknown[],
  ): void {
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  }
  private throwShutdownFailures(failures: readonly unknown[]): void {
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "filesystem shutdown failed");
  }
}
function attachSocketScopeControl(
  owner: FilesystemService,
  data: {
    connect: FilesystemConnection;
    socketScope: { guest: Pick<FilesystemIdentity, "owner" | "sections">; directory: number };
    reply: MessagePort;
  },
): void {
  try {
    data.reply.postMessage({
      value: owner.attachSocketScope(
        data.socketScope.guest,
        data.socketScope.directory,
        data.connect,
      ),
    });
  } catch (error) {
    revokeFilesystem(data.connect);
    data.connect.port.close();
    retireRequestMemory(captureRequestMemory(data.connect.requests));
    data.reply.postMessage({ error: errno(error) });
  }
  // The page closes its receiving port after delivery; closing this sender can discard replies.
}

function failureDiagnostic(error: unknown) {
  let message = "Unknown filesystem worker error";
  let stack: string | undefined;
  try {
    message = String(error) || message;
  } catch {
    /* Rejection reasons need not be printable. */
  }
  try {
    const value = error && typeof error === "object" && "stack" in error ? error.stack : undefined;
    if (typeof value === "string") stack = value;
  } catch {
    /* A stack getter can throw too. */
  }
  const detail = {
    name: diagnosticField(error, "name"),
    code: diagnosticField(error, "code"),
    vfs: diagnosticField(error, "vfs"),
  };
  if (detail.name === "VfsError") message = diagnosticField(error, "message") ?? message;
  const released = diagnosticReleased(error);
  return {
    type: "filesystem-error",
    message,
    stack,
    ...detail,
    ...(released !== undefined ? { released } : {}),
  };
}
function diagnosticField(error: unknown, key: string): string | undefined {
  try {
    if (!error || typeof error !== "object") return;
    const value: unknown = Reflect.get(error, key);
    return typeof value === "string" ? value : undefined;
  } catch {
    /* Diagnostics must survive hostile property getters. */
    return;
  }
}
function diagnosticReleased(error: unknown): boolean | undefined {
  try {
    if (!error || typeof error !== "object") return undefined;
    const value: unknown = Reflect.get(error, "released");
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}
function isCancellationError(error: unknown): boolean {
  if (error instanceof FilesystemError && error.errno === 11) return true;
  const name = diagnosticField(error, "name");
  return name === "AbortError";
}

export interface FilesystemWorkerCallbacks {
  readonly onState?: (status: "waiting" | "ready") => void;
  readonly onOwnershipLost?: () => void;
  readonly onFatalError?: (error: unknown, released: boolean) => void;
}

async function prepareAcceptance(binding: OperationBinding) {
  try {
    const { captureAcceptance } = await import("../browser/operations/writer.js");
    return captureAcceptance(binding);
  } catch {
    return undefined;
  }
}

function backendOptions(data: Record<string, unknown>): Record<string, unknown> {
  if (data.operations === undefined) return data;
  const options = { ...data };
  delete options.operations;
  return options;
}

/** Installs the service in a browser/Bun worker without importing any app code. */
export function installFilesystemWorker(
  scope: {
    onmessage: ((event: MessageEvent<any>) => void) | null;
    postMessage: (message: unknown) => void;
  },
  backendFactory: (
    options: any,
    onStartupStage?: RuntimeStartupObserver,
    signal?: AbortSignal,
    onWaiting?: () => void,
    callbacks?: FilesystemWorkerCallbacks,
  ) => FilesystemBackend | Promise<FilesystemBackend> = (options) =>
    new MemoryBackend(undefined, undefined, undefined, undefined, options.connect),
): void {
  // Selection belongs to the controller, never to guest filesystem requests.
  let service: Promise<FilesystemService> | undefined;
  let resolvedService: FilesystemService | undefined;
  let errorReported = false;
  let onStartupStage: RuntimeStartupObserver | undefined;
  const startupAbort = new AbortController();
  let disposing = false;
  let beginDisposeRequested = false;
  const callbacks: FilesystemWorkerCallbacks = {
    onState(status) {
      if (!disposing) scope.postMessage({ type: "filesystem-state", status });
    },
    onOwnershipLost() {
      scope.postMessage({ type: "filesystem-ownership-lost" });
    },
    onFatalError(error, released) {
      if (disposing || errorReported) return;
      errorReported = true;
      try {
        scope.postMessage({ ...failureDiagnostic(error), released });
      } catch {
        /* Diagnostic delivery failure is non-fatal when retaining locks. */
      }
    },
  };
  scope.onmessage = ({ data }) => {
    if (data?.beginDispose === true) {
      beginDisposeRequested = true;
      if (resolvedService) resolvedService.beginDispose();
      else
        void service?.then(
          (owner) => owner.beginDispose(),
          () => {},
        );
      return;
    }
    if (data?.dispose === true) {
      if (disposing) return;
      disposing = true;
      startupAbort.abort();
      void (service ?? Promise.resolve(undefined))
        .then(
          (owner) =>
            owner
              ? owner
                  .shutdown()
                  .then(() => ({ released: true as boolean, error: undefined as unknown }))
              : { released: true as boolean, error: undefined as unknown },
          (error) => {
            const released = diagnosticReleased(error);
            if (released === false) return { released: false, error };
            if (released === true) {
              return isCancellationError(error)
                ? { released: true, error: undefined }
                : { released: true, error };
            }
            return { released: true, error: undefined };
          },
        )
        .then(
          ({ released, error }) => {
            if (error !== undefined) {
              scope.postMessage({
                type: "filesystem-disposed",
                error: failureDiagnostic(error).message,
                released,
              });
            } else {
              scope.postMessage({ type: "filesystem-disposed", released });
            }
          },
          (error) => {
            const released = diagnosticReleased(error);
            scope.postMessage({
              type: "filesystem-disposed",
              error: failureDiagnostic(error).message,
              ...(released !== undefined ? { released } : {}),
            });
          },
        );
      return;
    }
    if (disposing) {
      data.connect?.port.close();
      return;
    }
    service ??= Promise.resolve()
      .then(() => {
        if (data.connect && data.observeStartup === true) {
          onStartupStage = (stage, timestamp) =>
            scope.postMessage({ type: "filesystem-startup", stage, timestamp });
          reportRuntimeStartup(onStartupStage, "filesystem-connected");
        }
        return backendFactory(
          backendOptions(data),
          onStartupStage,
          startupAbort.signal,
          () => {
            if (!disposing) scope.postMessage({ type: "filesystem-state", status: "waiting" });
          },
          callbacks,
        );
      })
      .then((backend) => {
        const owner = new FilesystemService(backend);
        resolvedService = owner;
        if (beginDisposeRequested) owner.beginDispose();
        return owner;
      });
    void service
      .then(async (owner) => {
        if (disposing) {
          data.connect?.port.close();
          return;
        }
        if (data.socketScope && data.connect && data.reply) {
          attachSocketScopeControl(owner, data);
        } else if (data.connect) {
          const acceptResolve = data.operations
            ? await prepareAcceptance(data.operations)
            : undefined;
          if (disposing) return data.connect.port.close();
          if (acceptResolve) connectObserved(owner, data.connect, acceptResolve);
          else owner.connect(data.connect);
          scope.postMessage({ type: "filesystem-state", status: "ready" });
          reportRuntimeStartup(onStartupStage, "filesystem-ready");
          onStartupStage = undefined;
        } else if (data.sweep) owner.sweep();
      })
      .catch((error) => {
        if (disposing) {
          data.connect?.port.close();
          return;
        }
        if (errorReported) return;
        errorReported = true;
        try {
          scope.postMessage(failureDiagnostic(error));
        } catch {
          /* The worker error below also covers a failed diagnostic transfer. */
        } finally {
          // A rejected async message handler alone does not dispatch a worker error event.
          if (diagnosticReleased(error) !== false) {
            setTimeout(() => {
              throw error;
            }, 0);
          }
        }
      });
  };
}
