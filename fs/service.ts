import { MemoryBackend, type FilesystemBackend } from "./backend";
import { CAPABILITY_HEADER, CAPABILITY_SLOTS, CAPABILITY_WORDS, HEADER, TRANSIENT_HANDLES, State, FilesystemError, errno, isRevoked, pack, revokeFilesystem, waitForFilesystemQuiescence, unpack, wake, type FilesystemConnection, type RequestMessage } from "./protocol";

const mutations = new Set(["preopen", "release", "write", "append", "resize", "setMtime", "create", "link", "removePath", "rename", "writeFile", "mkdirp", "remove", "move"]);
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
  quiescing?: Promise<void>;
}
/** One serial owner of the tree. No request ever waits for a guest acknowledgment. */
export class FilesystemService {
  private sessions = new Set<Session>();
  private queue = Promise.resolve();
  private sweeping = false;
  constructor(private backend: FilesystemBackend) {}
  connect(connection: FilesystemConnection): void {
    if (this.backend instanceof MemoryBackend) {
      this.backend.attachShared(connection.shared, connection.maxBytes, connection.segments);
      this.backend.shared.onContention = () => this.sweep();
    }
    const session: Session = { connection, handles: new Map(), capabilities: new Int32Array(connection.capabilities), freeEntries: Array.from({ length: CAPABILITY_SLOTS }, (_, index) => CAPABILITY_HEADER + (CAPABILITY_SLOTS - index - 1) * CAPABILITY_WORDS), preopens: new Set(), transient: new Map(), references: new Map(), responses: new Map(), pending: new Map() };
    this.sessions.add(session);
    for (const segment of this.backend.sharedSegments?.() ?? []) connection.port.postMessage({ segment: segment.buffer, index: segment.index });
    connection.port.onmessage = ({ data }: MessageEvent<RequestMessage>) => {
      if ("connect" in data) {
        if (!isRevoked(connection)) this.connect(data.connect);
        else data.connect.port.close();
      } else if ("sweep" in data) this.sweep();
      else if ("discard" in data) session.responses.delete(data.discard);
      else if ("trim" in data) this.queue = this.queue.then(() => {
        if (this.sessions.has(session) && !isRevoked(connection)) this.trim(session);
      });
      else {
        session.pending.set(data.id, data.buffer);
        this.queue = this.queue.then(() => this.request(session, data.id, data.buffer));
      }
    };
    connection.port.start();
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
      } catch (error) { session.freeEntries.push(key); throw error; }
      session.handles.set(handle, key);
      Atomics.store(session.capabilities, key, handle);
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
    let idle = 0, detached = false;
    const shared = this.backend instanceof MemoryBackend ? this.backend.shared : undefined;
    for (const handle of session.transient.keys()) if (Atomics.load(session.capabilities, session.handles.get(handle)! + 1) === 0) {
      idle++;
      if (shared?.isUnlinked(handle)) detached = true;
    }
    if (idle <= TRANSIENT_HANDLES && !detached) return;
    // Eviction is a capability mutation, serialized against direct guest mutations too.
    const epoch = new Int32Array(session.connection.epoch);
    const invalidate = !shared?.ownsServiceMutation;
    if (invalidate) { if (shared) shared.beginServiceMutation(epoch); else Atomics.add(epoch, 0, 1); }
    try {
      for (const handle of session.transient.keys()) {
        if (idle <= TRANSIENT_HANDLES && !shared?.isUnlinked(handle)) continue;
        const key = session.handles.get(handle)!;
        // A local retain racing this CAS either owns a live pin or sees a revoked entry.
        if (Atomics.compareExchange(session.capabilities, key + 1, 0, -1) !== 0) continue;
        this.forget(session, handle, key);
        idle--;
      }
    } finally { if (invalidate) { if (shared) shared.endServiceMutation(epoch); else Atomics.add(epoch, 0, 1); } }
  }
  private check(session: Session, handle: number | undefined): void {
    if (handle === undefined) return;
    if (!session.handles.has(handle)) throw new FilesystemError(8);
    if (session.transient.delete(handle)) session.transient.set(handle, true);
  }
  private async execute(session: Session, id: number, operation: string, args: any[], data: Uint8Array): Promise<unknown> {
    const [a, b, c] = args;
    if (operation === "take") {
      const response = session.responses.get(a);
      if (!response) throw new FilesystemError(11);
      const part = response.slice(b, b + c);
      if (b + c >= response.length) session.responses.delete(a);
      return part;
    }
    if (["retain", "release", "stat", "read", "write", "append", "grow", "resize", "setMtime", "readdir", "resolve"].includes(operation)) this.check(session, a);
    if (["create", "link", "removePath", "rename"].includes(operation)) {
      this.check(session, a.parent); this.check(session, a.node);
      if (operation === "link" || operation === "rename") { this.check(session, b.parent); this.check(session, b.node); }
    }
    if (operation === "retain") {
      const key = session.handles.get(a)!;
      for (;;) {
        const count = Atomics.load(session.capabilities, key + 1);
        if (count < 0) throw new FilesystemError(8);
        if (count === 0x7fffffff) throw new FilesystemError(33);
        if (Atomics.compareExchange(session.capabilities, key + 1, count, count + 1) === count) break;
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
        if (Atomics.compareExchange(session.capabilities, key + 1, count, count === 1 ? -1 : count - 1) !== count) continue;
        if (owned > 1) session.references.set(a, owned - 1); else session.references.delete(a);
        if (count === 1) this.forget(session, a, key);
        break;
      }
      return;
    }
    const result: any = await this.backend.execute(operation, args, data);
    const pending = session.pending.get(id);
    if (isRevoked(session.connection) || !this.sessions.has(session) || !pending || Atomics.load(new Int32Array(pending, 0, HEADER / 4), 6)) throw new FilesystemError(11);
    if (operation === "preopen" || operation === "create" && typeof result === "number") this.pin(session, result, operation === "preopen");
    // Touch every returned identity before choosing an eviction victim: a new parent may point
    // to a hard-linked node that was previously the oldest transient capability.
    if (operation === "resolve" && typeof result !== "number") { this.pin(session, result.parent); this.pin(session, result.node); }
    if (mutations.has(operation)) {
      for (const peer of this.sessions) if (!isRevoked(peer.connection)) this.trim(peer);
    } else this.trim(session);
    return result;
  }
  private async request(session: Session, id: number, buffer: SharedArrayBuffer): Promise<void> {
    const cells = new Int32Array(buffer, 0, HEADER / 4);
    const bytes = new Uint8Array(buffer, HEADER);
    let state = State.Complete;
    let mutation = false;
    const epoch = new Int32Array(session.connection.epoch);
    try {
      if (isRevoked(session.connection) || !this.sessions.has(session) || Atomics.load(cells, 6)) throw new FilesystemError(11);
      const inputLength = cells[1]!;
      const dataLength = cells[2]!;
      const { operation, args } = unpack(bytes.subarray(0, inputLength));
      mutation = mutations.has(operation);
      if (mutation) {
        if (this.backend instanceof MemoryBackend) this.backend.shared.beginServiceMutation(epoch);
        else Atomics.add(epoch, 0, 1);
      }
      const value = await this.execute(session, id, operation, args, bytes.subarray(inputLength, inputLength + dataLength));
      const segments = this.backend.takeSharedSegments?.() ?? [];
      for (const segment of segments) for (const peer of this.sessions) peer.connection.port.postMessage({ segment: segment.buffer, index: segment.index });
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
      for (const segment of this.backend.takeSharedSegments?.() ?? []) for (const peer of this.sessions)
        peer.connection.port.postMessage({ segment: segment.buffer, index: segment.index });
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
  sweep(): void {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // Recover all proven-dead lock owners before any close can need the allocator lock.
      for (const session of this.sessions) if (Atomics.load(new Int32Array(session.connection.revocations[0]!), 0) === 2)
        this.backend.revokeOwner?.(session.connection.owner, new Int32Array(session.connection.epoch));
      for (const session of this.sessions) if (isRevoked(session.connection)) this.close(session);
    } finally { this.sweeping = false; }
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
    if (ownRevocation === 2) this.backend.revokeOwner?.(session.connection.owner, new Int32Array(session.connection.epoch));
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
      session.handles.delete(handle);
      this.backend.release(handle);
    }
    Atomics.store(session.capabilities, 0, 0);
    session.handles.clear(); session.preopens.clear(); session.transient.clear(); session.references.clear(); session.responses.clear();
    session.connection.port.close();
    this.sessions.delete(session);
  }
  resources() {
    const backend = this.backend.resources?.() ?? {};
    let retained = 0, transient = 0, responses = 0, capabilityBytes = 0;
    for (const session of this.sessions) {
      retained += session.handles.size;
      responses += session.responses.size;
      capabilityBytes += session.connection.capabilities.byteLength;
      for (const handle of session.transient.keys()) if (Atomics.load(session.capabilities, session.handles.get(handle)! + 1) === 0) transient++;
    }
    return {
      ...backend, clients: this.sessions.size, retained, transient, responses, capabilityBytes,
      metadataBytes: (backend.metadataBytes ?? 0) + capabilityBytes,
      bytes: (backend.bytes ?? 0) + capabilityBytes,
    };
  }
  dispose(): void { for (const session of this.sessions) this.close(session); }
}
/** Installs the service in a browser/Bun worker without importing any app code. */
export function installFilesystemWorker(scope: { onmessage: ((event: MessageEvent<any>) => void) | null; }): void {
  // The backend is deliberately selected at the worker entrypoint, not by guest requests.
  const service = new FilesystemService(new MemoryBackend());
  scope.onmessage = ({ data }) => {
    if (data.connect) service.connect(data.connect);
    else if (data.sweep) service.sweep();
  };
}
