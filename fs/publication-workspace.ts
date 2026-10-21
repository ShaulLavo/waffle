import { FilesystemClient, type FilesystemCompletion } from "./client.js";
import { localPublication } from "./publication-internal.js";
import { mutationIntent, mutationValue, type MutationId } from "./publication.js";
import type { ResidentSession } from "./publication-grant.js";
import { ResidentChannel, integer, record, residentSession, text } from "./publication-attachment.js";
import {
  CAPABILITY_HEADER, CAPABILITY_SLOTS, CAPABILITY_WORDS, HEADER, PAGE, State,
  FilesystemError, connectFilesystemIdentity, createFilesystemIdentity, isRevoked,
  pack, unpack, wake, type FilesystemConnection, type FilesystemIdentity,
} from "./protocol.js";

export interface WorkspaceHost {
  readonly root: FilesystemIdentity;
  connect(connection: FilesystemConnection): void;
  close(connection: FilesystemConnection): Promise<void>;
  adopt(connection: FilesystemConnection, reservation: FilesystemIdentity["reservations"][number]): void;
}
interface WorkspaceCall {
  readonly operation: string;
  readonly args: unknown[];
  readonly input: Uint8Array;
  readonly id?: MutationId;
}
const requestBound = PAGE + 8192;
function sameBuffer(left: SharedArrayBuffer, right: SharedArrayBuffer, index = 0): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Int32Array(left), b = new Int32Array(right);
  const before = Atomics.load(a, index), probe = before ^ -1;
  Atomics.store(a, index, probe);
  const same = Atomics.load(b, index) === probe;
  Atomics.store(a, index, before);
  return same;
}
const queryOperations = new Set(["stat", "permissions", "resolve", "lookup", "readdir", "read", "grow", "sync", "flush"]);

function identity(value: unknown): MutationId {
  const data = record(value);
  return { session: integer(data.session), sequence: integer(data.sequence) };
}
function argumentSize(value: unknown, budget: number, depth = 0): number {
  if (budget < 0 || depth > 4) throw new FilesystemError(6);
  if (value === undefined || value === null || typeof value === "boolean") return 8;
  if (typeof value === "number") { integer(value); return 24; }
  if (typeof value === "string") {
    if (value.length > budget) throw new FilesystemError(6);
    return value.length * 3 + 4;
  }
  if (typeof value !== "object") throw new FilesystemError(28);
  if (value instanceof Map) {
    if (value.size > 4096) throw new FilesystemError(6);
    let size = 2;
    for (const [key, item] of value) {
      size += argumentSize(key, budget - size, depth + 1) + argumentSize(item, budget - size, depth + 1);
      if (size > budget) throw new FilesystemError(6);
    }
    return size;
  }
  const keys = Object.keys(value);
  if (keys.length > (Array.isArray(value) ? 4096 : 8)) throw new FilesystemError(6);
  let size = 2;
  for (const key of keys) {
    size += key.length + argumentSize(Reflect.get(value, key), budget - size, depth + 1);
    if (size > budget) throw new FilesystemError(6);
  }
  return size;
}
export function workspaceRequest(value: unknown, inputBound: number, argumentBound: number): WorkspaceCall {
  const data = record(value), operation = text(data.operation);
  if (!Array.isArray(data.args) || data.args.length > 4) throw new FilesystemError(28);
  if (!(data.input instanceof Uint8Array) || data.input.length > inputBound)
    throw new FilesystemError(6);
  argumentSize(data.args, argumentBound);
  if (pack(data.args).length > argumentBound) throw new FilesystemError(6);
  const args: unknown[] = data.args;
  const intent = mutationIntent(operation, args);
  if (!intent && !queryOperations.has(operation)) throw new FilesystemError(2);
  if (intent) return { operation, args, input: data.input, ...(data.id ? { id: identity(data.id) } : {}) };
  if (operation === "lookup") text(args[0]);
  else if (operation !== "flush") integer(args[0]);
  if (operation === "resolve") text(args[1]);
  if (operation === "read") {
    integer(args[1], inputBound);
    integer(args[2]);
  }
  if (operation === "grow") integer(args[1]);
  return { operation, args, input: data.input };
}

/** A service identity is derived from the real authority root. Its observer is never copied. */
export class WorkspacePeer {
  readonly client: FilesystemClient;
  private retained = new Set<number>();
  private pending = new Set<FilesystemCompletion>();
  private identities = new Map<number, MutationId>();
  private stopped = false;
  constructor(readonly session: ResidentSession, private host: WorkspaceHost) {
    const root = { ...host.root };
    delete root.publication;
    delete root.residentPublication;
    const local = createFilesystemIdentity(root);
    const publication = host.root.publication;
    if (!publication) throw new FilesystemError(58);
    local.publication = { buffers: publication.buffers, session: session.session };
    const pair = connectFilesystemIdentity(local);
    host.connect(pair.server);
    this.client = new FilesystemClient(pair.client);
  }
  owns(handle: number): boolean {
    return !this.stopped && this.retained.has(handle);
  }
  private holdResults(): number[] {
    const entries = new Int32Array(this.client.connection.capabilities);
    for (let key = CAPABILITY_HEADER; key < entries.length; key += CAPABILITY_WORDS) {
      const handle = Atomics.load(entries, key);
      if (Atomics.load(entries, key + 1) < 0 || this.retained.has(handle)) continue;
      this.client.retain(handle);
      this.retained.add(handle);
    }
    return Array.from(this.retained);
  }
  adopt(source: WorkspacePeer, handles: readonly number[]): number[] {
    if (this.stopped || this.retained.size + handles.length > CAPABILITY_SLOTS)
      throw new FilesystemError(6);
    for (const handle of handles) if (!source.owns(handle)) throw new FilesystemError(8);
    // Use the real service reservation path, including its exact target identity and pin.
    for (const handle of handles) {
      const reservation = source.client.reserve(handle, this.client.connection);
      this.host.adopt(this.client.connection, reservation);
      this.client.adopt(reservation);
      this.retained.add(handle);
    }
    return Array.from(this.retained);
  }
  next(): MutationId {
    if (this.stopped) throw new FilesystemError(11);
    const id = this.client.shared.publication!.next(this.session.session);
    if (this.identities.size >= this.client.shared.publication!.limits.operations) {
      const oldest = this.identities.keys().next().value;
      if (oldest !== undefined) this.identities.delete(oldest);
    }
    this.identities.set(id.sequence, id);
    return id;
  }
  receipt(value: unknown) {
    return this.client.shared.publication!.lookup(this.session.session, identity(value));
  }
  receipts() {
    return Array.from(this.identities.values(), (id) => ({ id, outcome: this.receipt(id) }));
  }
  async execute(value: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.stopped || signal.aborted) throw new FilesystemError(11);
    const limits = this.client.shared.publication!.limits;
    const call = workspaceRequest(value, limits.inputBytes, limits.argumentBytes);
    let admission;
    if (mutationIntent(call.operation, call.args)) {
      const admitted = this.client[localPublication](call.operation, call.args, call.input, call.id ?? this.next());
      if (admitted.kind === "duplicate")
        return { value: mutationValue(admitted.receipt.result), receipt: admitted.receipt, handles: this.holdResults() };
      admission = admitted.admission;
    }
    const completion = this.client.submit(call.operation, call.args, call.input, PAGE, admission);
    const cancel = () => completion.cancel();
    this.pending.add(completion);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const result: unknown = await completion.value();
      argumentSize(result instanceof Uint8Array ? undefined : result, requestBound);
      if (result instanceof Uint8Array && result.length > limits.inputBytes) throw new FilesystemError(6);
      const handles = this.holdResults();
      const receipt = admission ? this.receipt(admission.id) : undefined;
      return { value: result, handles, ...(receipt?.kind === "committed" ? { receipt: receipt.receipt } : {}) };
    } finally {
      signal.removeEventListener("abort", cancel);
      this.pending.delete(completion);
      completion.release();
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const completion of this.pending) completion.cancel();
    await this.host.close(this.client.connection);
    this.client.dispose();
    this.retained.clear();
  }
}

interface BridgeOperation {
  readonly abort: AbortController;
  readonly buffer: SharedArrayBuffer;
  readonly joined: Promise<void>;
}
interface BridgeParent { readonly bridge: WorkspaceBridge; readonly handles: readonly number[] }
class WorkspaceBridge {
  private channel: ResidentChannel;
  private session: ResidentSession | undefined;
  private pending = new Map<number, BridgeOperation>();
  private responses = new Map<number, Uint8Array>();
  private bound: Promise<void> = Promise.resolve();
  private children = new Set<WorkspaceBridge>();
  private transfer = Promise.withResolvers<void>();
  constructor(private connection: FilesystemConnection, private parent?: BridgeParent) {
    this.channel = new ResidentChannel(connection.residentPublication!.workspace);
    connection.port.onmessage = ({ data }: MessageEvent<unknown>) => this.receive(data);
    connection.port.start();
  }
  private connect(value: unknown): void {
    const child = value as FilesystemConnection;
    if (isRevoked(this.connection) || !sameBuffer(child.shared, this.connection.shared, 6) || !sameBuffer(child.ownerStates, this.connection.ownerStates))
      throw new FilesystemError(11);
    const handles: number[] = [];
    for (const reservation of child.reservations) {
      this.validateReservation(child, reservation);
      handles.push(reservation.handle);
    }
    if (this.children.size >= 16) throw new FilesystemError(6);
    const bridge = new WorkspaceBridge(child, { bridge: this, handles });
    this.children.add(bridge);
    void bridge.transfer.promise.finally(() => this.children.delete(bridge));
    if (!handles.length) bridge.transfer.resolve();
  }
  private validateReservation(child: FilesystemConnection, reservation: FilesystemIdentity["reservations"][number]): void {
    const source = new Int32Array(this.connection.capabilities), target = new Int32Array(child.capabilities);
    if (!sameBuffer(reservation.source, this.connection.capabilities) || !sameBuffer(reservation.target, child.capabilities) || reservation.targetOwner !== child.owner)
      throw new FilesystemError(8);
    if (Atomics.load(source, reservation.sourceKey) !== reservation.handle || Atomics.load(source, reservation.sourceKey + 2) <= 0 || Atomics.load(target, reservation.targetKey) !== reservation.handle || Atomics.load(target, reservation.targetKey + 1) <= 0)
      throw new FilesystemError(8);
    const state = new Int32Array(reservation.state);
    if (Atomics.load(state, 0) || Atomics.load(state, 1)) throw new FilesystemError(11);
  }
  private receive(value: unknown): void {
    try { this.message(record(value)); } catch { /* Malformed local data owns no request. */ }
  }
  private message(data: Record<string, unknown>): void {
    if ("connect" in data) return this.connect(data.connect);
    if ("discard" in data) {
      const id = integer(data.discard);
      this.pending.get(id)?.abort.abort();
      this.responses.delete(id);
      return;
    }
    if ("sweep" in data || "trim" in data) {
      for (const child of this.children) child.cancelTransferred();
      return;
    }
    const id = integer(data.id);
    if (!(data.buffer instanceof SharedArrayBuffer)) throw new FilesystemError(28);
    const buffer = data.buffer;
    if (buffer.byteLength > requestBound || this.pending.size >= 16) return this.fail(id, buffer, 6);
    const abort = new AbortController();
    const joined = this.execute(id, buffer, abort.signal).catch((error: unknown) => this.fail(id, buffer, error instanceof FilesystemError ? error.errno : 29));
    this.pending.set(id, { abort, buffer, joined });
    void joined.finally(() => this.pending.delete(id));
  }
  private fail(id: number, buffer: SharedArrayBuffer, errno: number): void {
    this.complete(id, buffer, undefined, errno);
  }
  private complete(id: number, buffer: SharedArrayBuffer, value: unknown, errno = 0): void {
    const cells = new Int32Array(buffer, 0, HEADER / 4);
    if (Atomics.load(cells, 6) || isRevoked(this.connection)) errno = 11;
    const binary = value instanceof Uint8Array;
    const bytes = binary ? value : pack(value);
    cells[3] = errno;
    cells[4] = binary ? 1 : 0;
    cells[2] = bytes.length;
    let state = errno === 11 ? State.Cancelled : errno ? State.Failed : State.Complete;
    if (!errno && bytes.length > buffer.byteLength - HEADER) {
      if (this.responses.size >= 16 || bytes.length > requestBound) return this.fail(id, buffer, 6);
      this.responses.set(id, bytes);
      state = State.Overflow;
    } else if (!errno) new Uint8Array(buffer, HEADER).set(bytes);
    Atomics.store(cells, 0, state);
    Atomics.notify(cells, 0);
    wake(this.connection);
    this.connection.port.postMessage({ completed: id });
  }
  private async bind(value: unknown): Promise<void> {
    if (this.session) throw new FilesystemError(6);
    const session = residentSession(value);
    if (session.descriptor.kind !== "workspace" || JSON.stringify(session.descriptor) !== JSON.stringify(this.connection.residentPublication)) throw new FilesystemError(11);
    this.session = session;
    const parent = this.parent;
    if (!parent || !parent.handles.length) return;
    await parent.bridge.bound;
    const source = parent.bridge.session;
    if (!source) throw new FilesystemError(11);
    await this.channel.call("workspaceAdopt", { token: session.token, source: source.token, handles: parent.handles });
    for (const reservation of this.connection.reservations) this.finishReservation(reservation);
    this.transfer.resolve();
  }
  private cancelTransferred(): void {
    if (!isRevoked(this.connection) && this.connection.reservations.some((reservation) => !Atomics.load(new Int32Array(reservation.state), 0))) return;
    this.transfer.resolve();
  }
  private finishReservation(reservation: FilesystemIdentity["reservations"][number]): void {
    const parent = this.parent;
    if (!parent) throw new FilesystemError(11);
    parent.bridge.validateReservation(this.connection, reservation);
    const state = new Int32Array(reservation.state);
    if (Atomics.compareExchange(state, 1, 0, 1)) throw new FilesystemError(11);
    Atomics.sub(new Int32Array(reservation.source), reservation.sourceKey + 2, 1);
  }
  private mirror(value: unknown): unknown {
    const response = record(value);
    if (!Array.isArray(response.handles) || response.handles.length > CAPABILITY_SLOTS) throw new FilesystemError(29);
    const entries = new Int32Array(this.connection.capabilities);
    for (const raw of response.handles) this.mirrorHandle(entries, integer(raw));
    return response.value;
  }
  private mirrorHandle(entries: Int32Array, handle: number): void {
    let free = -1;
    for (let key = CAPABILITY_HEADER; key < entries.length; key += CAPABILITY_WORDS) {
      if (Atomics.load(entries, key) === handle && Atomics.load(entries, key + 1) >= 0) return;
      if (free < 0 && Atomics.load(entries, key + 1) < 0) free = key;
    }
    if (free < 0) throw new FilesystemError(51);
    Atomics.store(entries, free, handle);
    Atomics.store(entries, free + 2, 0);
    Atomics.store(entries, free + 1, 0);
    Atomics.add(entries, 0, 1);
  }
  private async execute(id: number, buffer: SharedArrayBuffer, signal: AbortSignal): Promise<void> {
    const cells = new Int32Array(buffer, 0, HEADER / 4);
    const inputLength = integer(cells[1], 8192), dataLength = integer(cells[2], PAGE);
    if (inputLength + dataLength > buffer.byteLength - HEADER) throw new FilesystemError(28);
    const input: unknown = unpack(new Uint8Array(buffer, HEADER, inputLength));
    const call = record(input), operation = text(call.operation);
    if (!Array.isArray(call.args)) throw new FilesystemError(28);
    if (operation === "workspaceBind") {
      this.bound = this.bind(call.args[0]);
      await this.bound;
      return this.complete(id, buffer, undefined);
    }
    if (operation === "take") {
      const key = integer(call.args[0]), at = integer(call.args[1]), count = integer(call.args[2], PAGE);
      const response = this.responses.get(key);
      if (!response) throw new FilesystemError(11);
      const part = response.slice(at, at + count);
      if (at + count >= response.length) this.responses.delete(key);
      return this.complete(id, buffer, part);
    }
    if (operation === "workspaceBridgeStop") {
      for (const [key, pending] of this.pending) if (key !== id) pending.abort.abort();
      await Promise.all(Array.from(this.pending, ([key, pending]) => key === id ? Promise.resolve() : pending.joined));
      for (const child of this.children) child.cancelTransferred();
      await Promise.all(Array.from(this.children, (child) => child.transfer.promise));
      this.responses.clear();
      this.channel.close();
      return this.complete(id, buffer, undefined);
    }
    await this.bound;
    const session = this.session;
    if (!session || signal.aborted || Atomics.load(cells, 6)) throw new FilesystemError(11);
    const token = session.token;
    if (operation === "workspaceNext" || operation === "workspaceReceipt" || operation === "workspaceReceipts") {
      const value = await this.channel.call(operation, { token, id: call.args[0] }, signal);
      return this.complete(id, buffer, value);
    }
    const args = call.args;
    const explicit = operation === "workspaceMutation";
    const actualOperation = explicit ? text(args[1]) : operation;
    const actualArgs = explicit ? args[2] : args;
    const mutationId = explicit ? identity(args[0]) : undefined;
    const value = await this.channel.call("workspace", { token, request: { operation: actualOperation, args: actualArgs, input: new Uint8Array(new Uint8Array(buffer, HEADER + inputLength, dataLength)), id: mutationId } }, signal);
    if (signal.aborted || Atomics.load(cells, 6) || isRevoked(this.connection)) throw new FilesystemError(11);
    this.complete(id, buffer, this.mirror(value));
  }
}
export function installWorkspaceBridge(connection: FilesystemConnection): void {
  new WorkspaceBridge(connection);
}
