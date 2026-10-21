import { ResidentGrantAuthority } from "./publication-grant.js";
import {
  mutationIntent,
  mutationValue,
  publicationAdmission,
  publicationCut,
  type PublicationAdmission,
} from "./publication.js";
import { reportRuntimeStartup, type RuntimeStartupObserver } from "./startup.js";
import { MemoryBackend, type FilesystemBackend } from "./backend.js";
import {
  CAPABILITY_HEADER,
  CAPABILITY_SLOTS,
  CAPABILITY_WORDS,
  HEADER,
  TRANSIENT_HANDLES,
  State,
  FilesystemError,
  errno,
  isRevoked,
  pack,
  revokeFilesystem,
  waitForFilesystemQuiescence,
  unpack,
  wake,
  type FilesystemConnection,
  type RequestMessage,
} from "./protocol.js";

const mutations = new Set([
  "preopen",
  "release",
  "write",
  "append",
  "resize",
  "setMtime",
  "setMode",
  "create",
  "link",
  "removePath",
  "rename",
  "writeFile",
  "mkdirp",
  "remove",
  "move",
]);
interface Session {
  connection: FilesystemConnection;
  handles: Map<number, number>;
  capabilities: Int32Array;
  freeEntries: number[];
  preopens: Set<number>;
  transient: Map<number, true>;
  references: Map<number, number>;
  responses: Map<number, Uint8Array>;
  pending: Map<number, SharedArrayBuffer>;
  preparingHandles: Map<number, number>;
  quiescing?: Promise<void>;
  closed?: boolean;
  retirement?: ReturnType<typeof setTimeout>;
  publicationPins?: Set<number>;
}
interface PreparedRequest {
  handles: number[];
  failure?: { error: unknown };
}
/** One serial owner of the tree. No request ever waits for a guest acknowledgment. */
export class FilesystemService {
  private sessions = new Set<Session>();
  private queue = Promise.resolve();
  private sweeping = false;
  residentPublication: ResidentGrantAuthority | undefined;
  constructor(private backend: FilesystemBackend) {}
  connect(connection: FilesystemConnection): void {
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
    }
    const session: Session = {
      connection,
      handles: new Map(),
      capabilities: new Int32Array(connection.capabilities),
      freeEntries: Array.from(
        { length: CAPABILITY_SLOTS },
        (_, index) => CAPABILITY_HEADER + (CAPABILITY_SLOTS - index - 1) * CAPABILITY_WORDS,
      ),
      preopens: new Set(),
      transient: new Map(),
      references: new Map(),
      responses: new Map(),
      pending: new Map(),
      preparingHandles: new Map(),
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
        Atomics.sub(new Int32Array(reservation.source), reservation.sourceKey + 2, 1);
      }
    }
    Atomics.store(session.capabilities, 0, session.transient.size);
    this.sweep();
    // Adopting a child pin can make the live parent's final detached pin collectible.
    for (const peer of this.sessions) if (!isRevoked(peer.connection)) this.trim(peer);
    for (const segment of this.backend.sharedSegments?.() ?? [])
      connection.port.postMessage({ segment: segment.buffer, index: segment.index });
    connection.port.onmessage = ({ data }: MessageEvent<RequestMessage>) => {
      if ("connect" in data) {
        if (!isRevoked(connection)) this.connect(data.connect);
        else data.connect.port.close();
      } else if ("sweep" in data) {
        this.sweep();
        // A controller can release a transfer for another live identity. Its notifier need
        // not own that identity's port, so sweep notifications also trim live peers in queue
        // order. Internal contention sweeps stay lock-free until an owner has quiesced.
        this.queue = this.queue.then(() => {
          for (const peer of this.sessions) if (!isRevoked(peer.connection)) this.trim(peer);
        });
      } else if ("discard" in data) session.responses.delete(data.discard);
      else if ("trim" in data)
        this.queue = this.queue.then(() => {
          if (this.sessions.has(session) && !isRevoked(connection)) this.trim(session);
        });
      else {
        session.pending.set(data.id, data.buffer);
        this.enqueue(session, data.id, data.buffer);
      }
    };
    connection.port.start();
  }
  private enqueue(
    session: Session,
    id: number,
    buffer: SharedArrayBuffer,
    prepared?: PreparedRequest,
  ): void {
    // Barriers capture their checkpoint in queue order without holding the mutation lock
    // while storage commits. Cold preparation likewise rejoins the queue only when ready.
    let barrier = false;
    try {
      const cells = new Int32Array(buffer, 0, HEADER / 4);
      const input = unpack(new Uint8Array(buffer, HEADER, cells[1]!));
      barrier = input.operation === "flush" || input.operation === "sync";
    } catch {
      /* request() reports malformed input through its completion */
    }
    this.queue = this.queue.then(() => {
      const request = this.request(session, id, buffer, prepared);
      if (!barrier) return request;
      void request;
    });
  }
  private pin(session: Session, handle: number | undefined, preopen = false): void {
    if (handle === undefined) return;
    if (!session.handles.has(handle)) {
      const key = session.freeEntries.pop();
      if (key === undefined) throw new FilesystemError(51, "session capability table exhausted");
      try {
        this.backend.retain(handle);
        // Contention can run sweep() and close a cancelled session before retain returns.
        if (isRevoked(session.connection) || !this.sessions.has(session)) {
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
  private trim(session: Session): void {
    let idle = 0,
      detached = false;
    const shared = this.backend instanceof MemoryBackend ? this.backend.shared : undefined;
    for (const handle of session.transient.keys())
      if (
        !session.preparingHandles.has(handle) &&
        Atomics.load(session.capabilities, session.handles.get(handle)! + 1) === 0
      ) {
        idle++;
        if (shared?.isUnlinked(handle)) detached = true;
      }
    if (idle <= TRANSIENT_HANDLES && !detached) return;
    // Eviction is a capability mutation, serialized against direct guest mutations too.
    const epoch = new Int32Array(session.connection.epoch);
    const invalidate = !shared?.ownsServiceMutation;
    if (invalidate) {
      if (shared) shared.beginServiceMutation(epoch);
      else Atomics.add(epoch, 0, 1);
    }
    try {
      for (const handle of session.transient.keys()) {
        if (session.preparingHandles.has(handle)) continue;
        if (idle <= TRANSIENT_HANDLES && !shared?.isUnlinked(handle)) continue;
        const key = session.handles.get(handle)!;
        // A local retain racing this CAS either owns a live pin or sees a revoked entry.
        if (Atomics.compareExchange(session.capabilities, key + 1, 0, -1) !== 0) continue;
        if (Atomics.load(session.capabilities, key + 2) > 0) {
          Atomics.store(session.capabilities, key + 1, 0);
          continue;
        }
        this.forget(session, handle, key);
        idle--;
      }
    } finally {
      if (invalidate) {
        if (shared) shared.endServiceMutation(epoch);
        else Atomics.add(epoch, 0, 1);
      }
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
    if (operation === "publicationPin") {
      const grant = session.connection.publication?.observer;
      if (!grant || a !== grant) throw new FilesystemError(2);
      if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 0) throw new FilesystemError(28);
      this.check(session, b, held);
    }
    if (
      [
        "retain",
        "release",
        "sync",
        "stat",
        "permissions",
        "setMode",
        "read",
        "write",
        "append",
        "grow",
        "resize",
        "setMtime",
        "readdir",
        "resolve",
      ].includes(operation)
    )
      this.check(session, a, held);
    if (["create", "link", "removePath", "rename"].includes(operation)) {
      this.check(session, a.parent, held);
      this.check(session, a.node, held);
      if (operation === "link" || operation === "rename") {
        this.check(session, b.parent, held);
        this.check(session, b.node, held);
      }
    }
  }
  private releasePrepared(session: Session, prepared: PreparedRequest | undefined): void {
    for (const handle of prepared?.handles ?? []) {
      const count = session.preparingHandles.get(handle) ?? 0;
      if (count > 1) session.preparingHandles.set(handle, count - 1);
      else session.preparingHandles.delete(handle);
    }
    if (prepared) prepared.handles.length = 0;
  }
  private execute(
    session: Session,
    id: number,
    operation: string,
    args: any[],
    data: Uint8Array,
  ): unknown | Promise<unknown> {
    const [a, b, c] = args;
    if (operation === "take") {
      const response = session.responses.get(a);
      if (!response) throw new FilesystemError(11);
      const part = response.slice(b, b + c);
      if (b + c >= response.length) session.responses.delete(a);
      return part;
    }
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
      const flushing = this.backend.flush?.(
        operation === "sync" ? a : typeof a === "string" ? a : undefined,
      );
      return Promise.resolve(flushing).then(() =>
        this.finishResult(session, id, operation, operation === "sync" ? 0 : undefined),
      );
    }
    const result = this.backend.execute(operation, args, data);
    if (result instanceof Promise)
      return result.then((value) => this.finishResult(session, id, operation, value));
    return this.finishResult(session, id, operation, result);
  }
  private finishResult(session: Session, id: number, operation: string, result: any): unknown {
    const pending = session.pending.get(id);
    if (
      isRevoked(session.connection) ||
      !this.sessions.has(session) ||
      !pending ||
      Atomics.load(new Int32Array(pending, 0, HEADER / 4), 6)
    )
      throw new FilesystemError(11);
    if (operation === "preopen" || (operation === "create" && typeof result === "number"))
      this.pin(session, result, operation === "preopen");
    // Touch every returned identity before choosing an eviction victim: a new parent may point
    // to a hard-linked node that was previously the oldest transient capability.
    if (operation === "resolve" && typeof result !== "number") {
      this.pin(session, result.parent);
      this.pin(session, result.node);
    }
    if (mutations.has(operation)) {
      for (const peer of this.sessions) if (!isRevoked(peer.connection)) this.trim(peer);
    } else this.trim(session);
    return result;
  }
  private assertBackendAccess(): void {
    if (this.backend instanceof MemoryBackend) this.backend.shared.publication?.assertAccess();
  }
  private async request(
    session: Session,
    id: number,
    buffer: SharedArrayBuffer,
    prepared?: PreparedRequest,
  ): Promise<void> {
    const cells = new Int32Array(buffer, 0, HEADER / 4);
    const bytes = new Uint8Array(buffer, HEADER);
    let state = State.Complete;
    let mutation = false;
    let preparing = false;
    let admission: PublicationAdmission | undefined;
    const epoch = new Int32Array(session.connection.epoch);
    try {
      if (isRevoked(session.connection) || !this.sessions.has(session) || Atomics.load(cells, 6))
        throw new FilesystemError(11);
      const inputLength = cells[1]!;
      const dataLength = cells[2]!;
      const input = unpack(bytes.subarray(0, inputLength));
      const { operation, args } = input;
      if (session.connection.publication && input.publication)
        admission = publicationAdmission(input.publication);
      this.checkRequest(session, operation, args);
      if (prepared?.failure) throw prepared.failure.error;
      this.assertBackendAccess();
      if (operation !== "flush" && operation !== "sync") {
        const preparation = this.backend.prepare?.(
          operation === "publicationPin" ? "read" : operation,
          operation === "publicationPin" ? [args[1]] : args,
          bytes.subarray(inputLength, inputLength + dataLength),
        );
        if (preparation) {
          // Storage waits never own the serial execute queue. Re-enter through prepare:
          // the path, capability or resident data may have changed while this read waited.
          // A pending request's transient capabilities must survive unrelated cache churn.
          const continuation = prepared ?? { handles: [] };
          this.checkRequest(session, operation, args, continuation.handles);
          prepared = continuation;
          preparing = true;
          void preparation.then(
            () => this.enqueue(session, id, buffer, continuation),
            (error) => {
              continuation.failure = { error };
              this.enqueue(session, id, buffer, continuation);
            },
          );
          return;
        }
      }
      // From here to completion the serial execute queue owns the request again.
      this.releasePrepared(session, prepared);
      const local = this.backend instanceof MemoryBackend && this.backend.shared.publication;
      mutation = mutations.has(operation) && !local;
      if (mutation) {
        if (this.backend instanceof MemoryBackend) this.backend.shared.beginServiceMutation(epoch);
        else Atomics.add(epoch, 0, 1);
      }
      const payload = bytes.subarray(inputLength, inputLength + dataLength);
      const value =
        local && operation !== "flush" && operation !== "sync"
          ? this.executePublication(session, id, operation, args, payload, admission)
          : await this.execute(session, id, operation, args, payload);
      const segments = this.backend.takeSharedSegments?.() ?? [];
      for (const segment of segments)
        for (const peer of this.sessions)
          peer.connection.port.postMessage({ segment: segment.buffer, index: segment.index });
      const binary = value instanceof Uint8Array;
      const result = binary ? value : pack(value);
      cells[2] = result.length;
      cells[4] = binary ? 1 : 0;
      if (result.length > bytes.length) {
        session.responses.set(id, result);
        state = State.Overflow;
      } else bytes.set(result);
    } catch (error) {
      cells[3] = errno(error);
      state = cells[3] === 11 ? State.Cancelled : State.Failed;
    } finally {
      // Allocation may complete before cancellation/failure. Publish every allocated segment,
      // indexed so a newly connected peer can receive both its snapshot and this broadcast.
      for (const segment of this.backend.takeSharedSegments?.() ?? [])
        for (const peer of this.sessions)
          peer.connection.port.postMessage({ segment: segment.buffer, index: segment.index });
      if (!preparing) {
        this.cancelPublication(session, admission);
        this.releasePrepared(session, prepared);
        if (mutation) {
          if (this.backend instanceof MemoryBackend) this.backend.shared.endServiceMutation(epoch);
          else Atomics.add(epoch, 0, 1);
        }
        cells[5] = Atomics.load(epoch, 0);
        if (isRevoked(session.connection) || Atomics.load(cells, 6)) {
          session.responses.delete(id);
          state = State.Cancelled;
        }
        Atomics.store(cells, 0, state);
        Atomics.notify(cells, 0);
        wake(session.connection);
        session.pending.delete(id);
        session.connection.port.postMessage({ completed: id });
        this.sweep();
      }
    }
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
    backend.shared.beginServiceMutation(new Int32Array(session.connection.epoch));
    try {
      domain.assertLive();
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
        publication = domain.prepare(admission, plan.result, plan.changes);
      } catch (error) {
        backend.discardPublication(plan);
        throw error;
      }
      return this.applyPublication(session, id, operation, plan, publication);
    } finally {
      backend.shared.endServiceMutation(new Int32Array(session.connection.epoch));
    }
  }
  private applyPublication(
    session: Session,
    id: number,
    operation: string,
    plan: import("./backend.js").LocalMutationPlan,
    publication: import("./publication.js").PreparedPublication,
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
    return this.finishResult(session, id, operation, mutationValue(plan.result));
  }
  private publicationControl(session: Session, operation: string, args: unknown[]): unknown {
    if (!(this.backend instanceof MemoryBackend)) throw new FilesystemError(58);
    const grant = session.connection.publication?.observer;
    if (!grant || args[0] !== grant) throw new FilesystemError(2);
    const domain = this.backend.shared.publication!;
    switch (operation) {
      case "publicationResident": {
        const handle = args[1],
          workspace = args[2];
        if (typeof handle !== "number" || typeof workspace !== "string" || !workspace.length)
          throw new FilesystemError(28);
        this.check(session, handle);
        this.residentPublication ??= new ResidentGrantAuthority(
          this.backend,
          new Int32Array(session.connection.epoch),
          workspace,
        );
        if (this.residentPublication.workspace !== workspace) throw new FilesystemError(28);
        const descriptor = this.residentPublication.retain(handle);
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
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // Recover all proven-dead lock owners before any close can need the allocator lock.
      for (const session of this.sessions)
        if (Atomics.load(new Int32Array(session.connection.revocations[0]!), 0) === 2)
          this.backend.revokeOwner?.(
            session.connection.owner,
            new Int32Array(session.connection.epoch),
          );
      for (const session of this.sessions) if (isRevoked(session.connection)) this.close(session);
    } finally {
      this.sweeping = false;
    }
  }
  private close(session: Session): void {
    revokeFilesystem(session.connection);
    const ownRevocation = Atomics.load(new Int32Array(session.connection.revocations[0]!), 0);
    // Revocation precedes the admission-count observation. Looking only at held locks misses
    // an entrant between admission and acquisition, which may still be touching a pin or page.
    if (ownRevocation !== 2 && Atomics.load(new Int32Array(session.connection.sections), 0)) {
      session.quiescing ??= waitForFilesystemQuiescence(session.connection).then(() => {
        // A later rejected entrant can briefly raise the count again. Let close() re-arm
        // its waiter if the next sweep observes that admission before it aborts.
        session.quiescing = undefined;
        this.sweep();
      });
      return;
    }
    if (ownRevocation === 2)
      this.backend.revokeOwner?.(
        session.connection.owner,
        new Int32Array(session.connection.epoch),
      );
    for (const [id, buffer] of session.pending) {
      const cells = new Int32Array(buffer, 0, HEADER / 4);
      Atomics.store(cells, 6, 1);
      Atomics.store(cells, 0, State.Cancelled);
      Atomics.notify(cells, 0);
      session.connection.port.postMessage({ completed: id });
    }
    session.pending.clear();
    wake(session.connection);
    for (const key of session.handles.values()) Atomics.store(session.capabilities, key + 1, -1);
    for (const handle of Array.from(session.handles.keys())) {
      if (Atomics.load(session.capabilities, session.handles.get(handle)! + 2) > 0) continue;
      session.handles.delete(handle);
      this.backend.release(handle);
    }
    Atomics.store(session.capabilities, 0, 0);
    session.preopens.clear();
    session.transient.clear();
    session.references.clear();
    session.responses.clear();
    session.preparingHandles.clear();
    if (this.backend instanceof MemoryBackend)
      for (const id of session.publicationPins ?? [])
        this.backend.shared.publication?.releasePin(id);
    session.publicationPins?.clear();
    session.connection.port.close();
    session.closed = true;
    if (!session.handles.size) {
      const publication = session.connection.publication;
      if (publication && !this.retirePublication(session)) return;
      this.sessions.delete(session);
    }
    if (
      !this.sessions.size &&
      this.backend instanceof MemoryBackend &&
      this.backend.shared.publication?.stopped
    )
      this.backend.shared.publication.releaseStopped();
  }
  private retirePublication(session: Session): boolean {
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
    let retained = 0,
      transient = 0,
      responses = 0,
      capabilityBytes = 0;
    for (const session of this.sessions) {
      retained += session.handles.size;
      responses += session.responses.size;
      capabilityBytes += session.connection.capabilities.byteLength;
      for (const handle of session.transient.keys())
        if (Atomics.load(session.capabilities, session.handles.get(handle)! + 1) === 0) transient++;
    }
    const ownerStateBytes =
      this.sessions.values().next().value?.connection.ownerStates.byteLength ?? 0;
    return {
      ...backend,
      ownerStateBytes,
      clients: this.sessions.size,
      retained,
      transient,
      responses,
      capabilityBytes,
      metadataBytes: (backend.metadataBytes ?? 0) + capabilityBytes + ownerStateBytes,
      bytes: (backend.bytes ?? 0) + capabilityBytes + ownerStateBytes,
    };
  }
  dispose(): void {
    this.residentPublication?.dispose();
    for (const session of this.sessions) this.close(session);
  }
  async shutdown(): Promise<void> {
    await this.queue;
    this.dispose();
    await this.backend.close?.();
  }
}
function failureDiagnostic(error: unknown) {
  let message = "Unknown filesystem worker error";
  let stack: string | undefined;
  try {
    message = String(error);
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
  return { type: "filesystem-error", message, stack, ...detail };
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
  ) => FilesystemBackend | Promise<FilesystemBackend> = () => new MemoryBackend(),
): void {
  // Selection belongs to the controller, never to guest filesystem requests.
  let service: Promise<FilesystemService> | undefined;
  let errorReported = false;
  let onStartupStage: RuntimeStartupObserver | undefined;
  const startupAbort = new AbortController();
  let disposing = false;
  scope.onmessage = ({ data }) => {
    if (data?.dispose === true) {
      if (disposing) return;
      disposing = true;
      startupAbort.abort();
      void (service ?? Promise.resolve(undefined))
        .then(
          (owner) => owner?.shutdown(),
          () => {},
        )
        .then(
          () => scope.postMessage({ type: "filesystem-disposed" }),
          (error) =>
            scope.postMessage({
              type: "filesystem-disposed",
              error: failureDiagnostic(error).message,
            }),
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
        return backendFactory(data, onStartupStage, startupAbort.signal, () => {
          if (!disposing) scope.postMessage({ type: "filesystem-state", status: "waiting" });
        });
      })
      .then((backend) => new FilesystemService(backend));
    void service
      .then((owner) => {
        if (disposing) {
          data.connect?.port.close();
          return;
        }
        if (data.connect) {
          owner.connect(data.connect);
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
          setTimeout(() => {
            throw error;
          }, 0);
        }
      });
  };
}
