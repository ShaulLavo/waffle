import {
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  typedArraySet,
  atomicsLoad,
  atomicsStore,
  sharedArrayBufferByteLength,
} from "../proc/intrinsics.js";
import { FilesystemError } from "../core/filesystem.js";
import {
  decodeEffects,
  encodeEffects,
  type PublicationCut,
  type MutationId,
} from "./publication.js";
import {
  ResidentGrantCell,
  type ResidentDescriptor,
  type ResidentGrant,
  type ResidentOutcome,
  type ResidentRequest,
  type ResidentSession,
  type ResidentSettlement,
} from "./publication-grant.js";

import {
  CAPABILITY_HEADER,
  CAPABILITY_LENGTH,
  CAPABILITY_SLOTS,
  CAPABILITY_WORDS,
  HEADER,
  PAGE,
  State,
  isRevoked,
  pack,
  unpack,
  wake,
  type FilesystemIdentity,
  CONNECTION_SHARED_BYTES,
  MAX_CONNECTION_OWNERS,
  connectFilesystemIdentity,
  createFilesystemIdentity,
  SHARED_SEGMENT_BYTES,
  type FilesystemConnection,
} from "./protocol.js";

const NativeChannel = globalThis.BroadcastChannel;
const NativeMessageChannel = globalThis.MessageChannel;
const NativeMessagePort = globalThis.MessagePort;
const continuityKey = (workspace: string): string => `waffle:publication:continuity:${workspace}`;
const callBound = 3000;

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FilesystemError(28);
  return Object.fromEntries(Object.entries(value));
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1024)
    throw new FilesystemError(28);
  return value;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new FilesystemError(28);
  return value;
}
export function residentDescriptor(value: unknown): ResidentDescriptor {
  const data = record(value);
  if (data.kind !== "file" && data.kind !== "workspace") throw new FilesystemError(28);
  return {
    kind: data.kind,
    workspace: text(data.workspace),
    instance: text(data.instance),
    epoch: integer(data.epoch),
    description: text(data.description),
    handle: integer(data.handle),
  };
}
export function residentRequest(value: unknown): ResidentRequest {
  const data = record(value),
    kind = data.kind,
    maxBytes = integer(data.maxBytes);
  if (kind === "append") return { kind, maxBytes };
  if (kind !== "read" && kind !== "write") throw new FilesystemError(28);
  return { kind, maxBytes, offset: integer(data.offset) };
}
function cut(value: unknown): PublicationCut {
  const data = record(value);
  return { history: text(data.history), generation: integer(data.generation) };
}
export function residentSession(value: unknown): ResidentSession {
  const data = record(value),
    session = record(data.session);
  return {
    descriptor: residentDescriptor(data.descriptor),
    token: text(data.token),
    session: { slot: integer(session.slot), serial: integer(session.serial) },
  };
}
export function residentGrant(value: unknown): ResidentGrant {
  const data = record(value),
    stat = record(data.stat),
    file = record(data.file);
  if (stat.kind !== "file") throw new FilesystemError(28);
  const base = {
    handle: integer(data.handle),
    key: text(data.key),
    session: residentSession(data.session),
    file: { birthHistory: text(file.birthHistory), ino: integer(file.ino) },
    stat: {
      kind: "file" as const,
      ino: integer(stat.ino),
      size: integer(stat.size),
      mtime: integer(stat.mtime),
      mode: integer(stat.mode),
    },
    cut: cut(data.cut),
    offset: integer(data.offset),
    maxBytes: integer(data.maxBytes, 65536),
    effectBytes: integer(data.effectBytes, 1024 * 1024),
    resultBytes: integer(data.resultBytes, 65536),
  };
  if (
    data.kind === "read" &&
    data.bytes instanceof Uint8Array &&
    data.bytes.length <= base.maxBytes
  )
    return { ...base, kind: "read", bytes: data.bytes };
  if (data.kind !== "write" && data.kind !== "append") throw new FilesystemError(28);
  const id = record(data.id);
  return {
    ...base,
    kind: data.kind,
    version: integer(data.version),
    id: { session: integer(id.session), sequence: integer(id.sequence) },
  };
}
export function encodeResidentOutcome(outcome: ResidentOutcome): unknown {
  if (outcome.kind !== "committed") return outcome;
  return {
    kind: outcome.kind,
    grant: outcome.grant,
    bytes: encodeEffects(outcome.publication.receipt, outcome.publication.changes, 1024 * 1024),
  };
}
export function residentOutcome(value: unknown): ResidentOutcome {
  const data = record(value),
    grant = text(data.grant);
  switch (data.kind) {
    case "ready":
    case "claimed":
    case "cancelled":
    case "stopped":
      return { kind: data.kind, grant };
    case "read":
      return { kind: "read", grant, count: integer(data.count), cut: cut(data.cut) };
    case "committed":
      if (!(data.bytes instanceof Uint8Array) || data.bytes.length > 1024 * 1024)
        throw new FilesystemError(28);
      return { kind: "committed", grant, publication: decodeEffects(data.bytes) };
    default:
      throw new FilesystemError(28);
  }
}
function settlement(value: unknown): ResidentSettlement {
  const data = record(value);
  if (data.kind === "read") return { kind: "read", cut: cut(data.cut) };
  if (data.kind === "unknown" || data.kind === "pending" || data.kind === "retired")
    return { kind: data.kind };
  if (data.kind !== "committed" || !(data.bytes instanceof Uint8Array))
    throw new FilesystemError(29);
  return { kind: "committed", receipt: decodeEffects(data.bytes).receipt };
}
export function encodeResidentSettlement(result: ResidentSettlement): unknown {
  return result.kind !== "committed"
    ? result
    : { kind: result.kind, bytes: encodeEffects(result.receipt, [], 65536) };
}

export interface PublicationGuard {
  release(): Promise<void>;
}
/** Each caller owns this lock in its actual realm. No timer or heartbeat steals it. */
export async function acquirePublicationGuard(
  workspace: string,
  mode: "shared" | "exclusive",
  signal: AbortSignal,
  ifAvailable = false,
): Promise<PublicationGuard> {
  const ready = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  if (signal.aborted) throw new FilesystemError(11);
  const options: LockOptions = ifAvailable ? { mode, ifAvailable } : { mode, signal };
  const done = navigator.locks.request(continuityKey(workspace), options, async (lock) => {
    if (!lock) {
      ready.reject(new FilesystemError(6));
      return;
    }
    ready.resolve();
    await held.promise;
  });
  void done.catch((error: unknown) => ready.reject(error));
  try {
    await ready.promise;
  } catch (error) {
    held.resolve();
    await done.catch(() => {});
    throw error;
  }
  let released: Promise<void> | undefined;
  return {
    release() {
      held.resolve();
      return (released ??= done);
    },
  };
}

type CallAnswer = ReturnType<typeof Promise.withResolvers<unknown>>;
type ReceiveValue = (value: unknown, late: boolean) => void;
type PendingCall = { readonly terminal: CallAnswer; readonly receive: ReceiveValue | undefined } & (
  | {
      readonly kind: "waiting";
      readonly answer: CallAnswer;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  | { readonly kind: "unconfirmed" }
);
/** The channel never transfers an authority SAB. Status asks the original cell owner. */
export class ResidentChannel {
  readonly id = crypto.randomUUID();
  readonly channel: BroadcastChannel;
  private pending = new Map<string, PendingCall>();
  private closed = false;
  status: (() => ResidentOutcome | undefined) | undefined;
  constructor(workspace: string) {
    this.channel = new NativeChannel(`waffle:resident:${workspace}`);
    this.channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      try {
        this.receive(record(data));
      } catch {
        /* Malformed unrelated channel data grants nothing. */
      }
    };
  }
  private receive(data: Record<string, unknown>): void {
    if (data.client !== this.id) return;
    const id = text(data.id);
    if (data.kind === "status") {
      const outcome = this.status?.();
      this.channel.postMessage({
        kind: "statusReply",
        id,
        client: this.id,
        outcome: outcome ? encodeResidentOutcome(outcome) : null,
      });
      return;
    }
    if (data.kind !== "reply") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    const error =
      data.errno === undefined ? undefined : new FilesystemError(integer(data.errno, 76));
    if (!error) pending.receive?.(data.value, pending.kind === "unconfirmed");
    this.pending.delete(id);
    if (pending.kind === "waiting") {
      clearTimeout(pending.timer);
      if (error) pending.answer.reject(error);
      else pending.answer.resolve(data.value);
    }
    if (error) pending.terminal.reject(error);
    else pending.terminal.resolve(data.value);
  }
  private send(
    operation: string,
    body: unknown,
    signal?: AbortSignal,
    receive?: ReceiveValue,
  ): { answer: Promise<unknown>; terminal: Promise<unknown> } {
    if (this.closed || this.pending.size >= 16) throw new FilesystemError(6);
    if (signal?.aborted) throw new FilesystemError(11);
    const id = crypto.randomUUID();
    const answer = Promise.withResolvers<unknown>();
    const terminal = Promise.withResolvers<unknown>();
    void terminal.promise.catch(() => {});
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending || pending.kind !== "waiting") return;
      this.pending.set(id, { kind: "unconfirmed", terminal, receive });
      this.channel.postMessage({ kind: "cancel", client: this.id, id });
      answer.reject(new FilesystemError(6));
    }, callBound);
    this.pending.set(id, { kind: "waiting", answer, terminal, timer, receive });
    try {
      this.channel.postMessage({ kind: "request", id, client: this.id, operation, body });
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      answer.reject(error);
      terminal.reject(error);
    }
    const cancel = () => this.channel.postMessage({ kind: "cancel", client: this.id, id });
    signal?.addEventListener("abort", cancel, { once: true });
    return {
      answer: answer.promise.finally(() => signal?.removeEventListener("abort", cancel)),
      terminal: terminal.promise,
    };
  }
  async call(
    operation: string,
    body: unknown,
    signal?: AbortSignal,
    receive?: ReceiveValue,
  ): Promise<unknown> {
    return this.send(operation, body, signal, receive).answer;
  }
  /** Cleanup consumes the original reply even when its caller deadline expires. */
  async finish(operation: "close" | "closeConnection" | "settle", body: unknown): Promise<unknown> {
    const request = this.send(operation, body);
    void request.answer.catch(() => {});
    return request.terminal;
  }
  async joinSettled(): Promise<void> {
    await Promise.all(
      Array.from(this.pending.values(), (pending) => pending.terminal.promise.catch(() => {})),
    );
    this.assertSettled();
  }
  assertSettled(): void {
    if (this.closed || this.pending.size) throw new FilesystemError(6);
  }
  cancelSession(token: string): void {
    this.channel.postMessage({ kind: "cancelSession", token });
  }
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.kind === "waiting") {
        clearTimeout(pending.timer);
        pending.answer.reject(new FilesystemError(11));
      }
      pending.terminal.reject(new FilesystemError(11));
    }
    this.pending.clear();
    this.channel.close();
  }
}

type AttemptResources =
  | { readonly kind: "none" }
  | { readonly kind: "guard"; readonly guard: PublicationGuard }
  | {
      readonly kind: "channel";
      readonly guard: PublicationGuard;
      readonly channel: ResidentChannel;
    }
  | { readonly kind: "client"; readonly client: ResidentGrantClient };
interface AttachmentAttempt {
  readonly abort: AbortController;
  readonly joined: Promise<void>;
  readonly cleanup: ReturnType<typeof Promise.withResolvers<void>>;
  resources: AttemptResources;
}
type AttachmentOwner =
  | { readonly kind: "none" }
  | { readonly kind: "attempt"; readonly attempt: AttachmentAttempt }
  | { readonly kind: "client"; readonly client: ResidentGrantClient };
type AttachmentState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "attaching"; readonly attempt: AttachmentAttempt }
  | { readonly kind: "current"; readonly client: ResidentGrantClient }
  | { readonly kind: "stopped"; readonly owner: AttachmentOwner };

export class ResidentGrantClient {
  private cell: ResidentGrantCell | undefined;
  private stopped = false;
  private stoppedJoin: Promise<void> | undefined;
  private preparing: Promise<void> | undefined;
  constructor(
    readonly session: ResidentSession,
    private channel: ResidentChannel,
    private guard: PublicationGuard,
    private revoked: () => boolean = () => false,
  ) {
    channel.status = () => this.cell?.snapshot();
  }
  prepare(request: ResidentRequest, handle = this.session.descriptor.handle): Promise<void> {
    const owned = residentRequest(request);
    if (this.stopped || this.revoked()) return Promise.reject(new FilesystemError(11));
    if (this.preparing) return Promise.reject(new FilesystemError(6));
    const preparing = this.prepareOwned(owned, handle);
    this.preparing = preparing;
    void preparing.then(
      () => this.clearPreparing(preparing),
      () => this.clearPreparing(preparing),
    );
    return preparing;
  }
  private clearPreparing(preparing: Promise<void>): void {
    if (this.preparing === preparing) this.preparing = undefined;
  }
  private async prepareOwned(request: ResidentRequest, handle: number): Promise<void> {
    if (this.cell) {
      this.cell.cancel();
      const status = await this.settle();
      if (status.kind === "pending" || status.kind === "unknown") throw new FilesystemError(6);
    }
    if (this.stopped || this.revoked()) throw new FilesystemError(11);
    await this.channel.call(
      "prepare",
      { token: this.session.token, request, handle },
      undefined,
      (value, late) => this.receiveGrant(value, late),
    );
    if (!this.stopped && !this.revoked()) return;
    this.cell?.cancel();
    await this.settle();
    throw new FilesystemError(11);
  }
  private receiveGrant(value: unknown, late: boolean): void {
    const grant = residentGrant(value);
    if (JSON.stringify(grant.session) !== JSON.stringify(this.session))
      throw new FilesystemError(11);
    this.cell = new ResidentGrantCell(grant, undefined, () => !this.stopped && !this.revoked());
    if (late || this.stopped || this.revoked()) this.cell.cancel();
  }
  tryRead(handle: number, chunks: readonly Uint8Array[], offset: number): number {
    return this.stopped || this.revoked()
      ? -11
      : (this.cell?.tryRead(handle, chunks, offset) ?? -6);
  }
  tryWrite(handle: number, chunks: readonly Uint8Array[], offset: number): number {
    return this.stopped || this.revoked()
      ? -11
      : (this.cell?.tryWrite(handle, chunks, offset) ?? -6);
  }
  tryAppend(
    handle: number,
    chunks: readonly Uint8Array[],
  ): number | { written: number; offset: number } {
    return this.stopped || this.revoked() ? -11 : (this.cell?.tryAppend(handle, chunks) ?? -6);
  }
  async settle(): Promise<ResidentSettlement> {
    const cell = this.cell;
    if (!cell) return { kind: "unknown" };
    return settlement(
      await this.channel.call("settle", {
        token: this.session.token,
        outcome: encodeResidentOutcome(cell.snapshot()),
      }),
    );
  }
  invalidate(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cell?.cancel();
    this.channel.cancelSession(this.session.token);
  }
  stop(): Promise<void> {
    this.invalidate();
    return (this.stoppedJoin ??= this.stopOwned());
  }
  private async stopOwned(): Promise<void> {
    await this.preparing?.catch(() => {});
    await this.channel.joinSettled();
    if (this.cell) {
      const result = settlement(
        await this.channel.finish("settle", {
          token: this.session.token,
          outcome: encodeResidentOutcome(this.cell.snapshot()),
        }),
      );
      if (result.kind === "pending" || result.kind === "unknown") throw new FilesystemError(6);
    }
    await this.channel.finish("close", { token: this.session.token });
    this.channel.close();
    await this.guard.release();
  }
}

export class ResidentAttachment {
  private state: AttachmentState = { kind: "unavailable" };
  constructor(
    private descriptor: ResidentDescriptor,
    private revoked: () => boolean,
  ) {}
  get client(): ResidentGrantClient | undefined {
    return this.state.kind === "current" ? this.state.client : undefined;
  }
  attach(signal?: AbortSignal): Promise<void> {
    if (this.state.kind === "stopped") return Promise.reject(new FilesystemError(11));
    if (this.state.kind === "current") return Promise.resolve();
    if (this.state.kind === "attaching") return this.state.attempt.joined;
    const abort = new AbortController(),
      completion = Promise.withResolvers<void>();
    const attempt: AttachmentAttempt = {
      abort,
      joined: completion.promise,
      cleanup: Promise.withResolvers<void>(),
      resources: { kind: "none" },
    };
    // Stop joins cleanup separately from the caller-visible cancelled attachment.
    void attempt.cleanup.promise.catch(() => {});
    this.state = { kind: "attaching", attempt };
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) abort.abort();
    const timer = setTimeout(cancel, callBound);
    void this.acquire(attempt)
      .then(completion.resolve, completion.reject)
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      });
    return completion.promise;
  }
  private active(attempt: AttachmentAttempt): boolean {
    return this.state.kind === "attaching" && this.state.attempt === attempt && !this.revoked();
  }
  private async acquire(attempt: AttachmentAttempt): Promise<void> {
    const signal = attempt.abort.signal;
    try {
      const guard = await acquirePublicationGuard(this.descriptor.workspace, "shared", signal);
      attempt.resources = { kind: "guard", guard };
      if (signal.aborted || !this.active(attempt)) throw new FilesystemError(11);
      const channel = new ResidentChannel(this.descriptor.workspace);
      attempt.resources = { kind: "channel", channel, guard };
      const session = residentSession(await channel.call("open", this.descriptor));
      if (JSON.stringify(session.descriptor) !== JSON.stringify(this.descriptor))
        throw new FilesystemError(11);
      const client = new ResidentGrantClient(session, channel, guard, this.revoked);
      attempt.resources = { kind: "client", client };
      if (signal.aborted || !this.active(attempt)) throw new FilesystemError(11);
      this.state = { kind: "current", client };
    } catch (error) {
      await this.cleanupAttempt(attempt);
      if (this.state.kind === "attaching" && this.state.attempt === attempt)
        this.state = { kind: "unavailable" };
      throw error;
    }
  }
  private async cleanupAttempt(attempt: AttachmentAttempt): Promise<void> {
    try {
      const resources = attempt.resources;
      if (resources.kind === "client") await resources.client.stop();
      if (resources.kind === "channel") {
        await resources.channel.joinSettled();
        await resources.channel.finish("closeConnection", null);
        resources.channel.close();
        await resources.guard.release();
      }
      if (resources.kind === "guard") await resources.guard.release();
      attempt.resources = { kind: "none" };
      attempt.cleanup.resolve();
    } catch (error) {
      attempt.cleanup.reject(error);
      this.state = { kind: "stopped", owner: { kind: "attempt", attempt } };
      throw error;
    }
  }
  invalidate(): void {
    const previous = this.state;
    if (previous.kind === "stopped") return;
    if (previous.kind === "attaching") {
      previous.attempt.abort.abort();
      this.state = { kind: "stopped", owner: { kind: "attempt", attempt: previous.attempt } };
      return;
    }
    if (previous.kind === "current") {
      previous.client.invalidate();
      this.state = { kind: "stopped", owner: { kind: "client", client: previous.client } };
      return;
    }
    this.state = { kind: "stopped", owner: { kind: "none" } };
  }
  async stop(): Promise<void> {
    this.invalidate();
    if (this.state.kind !== "stopped") throw new FilesystemError(29);
    const owner = this.state.owner;
    if (owner.kind === "attempt") await owner.attempt.cleanup.promise;
    if (owner.kind === "client") await owner.client.stop();
  }
}

export async function attachResidentPublication(
  descriptor: ResidentDescriptor,
  signal: AbortSignal,
): Promise<ResidentGrantClient> {
  const attachment = new ResidentAttachment(residentDescriptor(descriptor), () => signal.aborted);
  await attachment.attach(signal);
  const client = attachment.client;
  if (!client) throw new FilesystemError(11);
  return client;
}

function workspaceIdentityBuffer(source: SharedArrayBuffer, words: number): SharedArrayBuffer {
  const buffer = new SharedArrayBufferConstructor((words + 1) * 4);
  typedArraySet(
    new Int32ArrayConstructor(buffer, 0, words),
    new Int32ArrayConstructor(source, 0, words),
  );
  new Int32ArrayConstructor(buffer, words * 4, 1)[0] = 0;
  return buffer;
}
/** Synthetic local liveness/capabilities, never an authority backend or writable tree.
 * Workspace buffers append three non-operational backing-identity words, twelve bytes total. */
export function createResidentConnection(value: ResidentDescriptor): FilesystemConnection {
  const descriptor = residentDescriptor(value);
  const identity = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES);
  identity.residentPublication = descriptor;
  if (descriptor.kind === "workspace") {
    identity.shared = workspaceIdentityBuffer(identity.shared, CONNECTION_SHARED_BYTES / 4);
    identity.ownerStates = workspaceIdentityBuffer(identity.ownerStates, MAX_CONNECTION_OWNERS);
    identity.capabilities = workspaceIdentityBuffer(identity.capabilities, CAPABILITY_LENGTH);
  }
  const entries = new Int32ArrayConstructor(identity.capabilities, 0, CAPABILITY_LENGTH);
  entries[0] = 1;
  entries[CAPABILITY_HEADER] = descriptor.handle;
  entries[CAPABILITY_HEADER + 1] = 0;
  entries[CAPABILITY_HEADER + 2] = 0;
  const connection = connectFilesystemIdentity(identity);
  if (descriptor.kind === "workspace") installWorkspaceBridge(connection.server);
  else connection.server.port.close();
  return connection.client;
}

const requestBound = PAGE + 8192;
const backingWords = {
  shared: CONNECTION_SHARED_BYTES / 4,
  owners: MAX_CONNECTION_OWNERS,
  capabilities: CAPABILITY_LENGTH,
};
/** Host-only trailers are never part of a guest operation's views or slot scans.
 * This proves aliasing under exclusive host trailer writes, not hostile raw-SAB authentication.
 * Comparisons run synchronously in the one bridge realm; operational guest writes stay independent. */
export function sameWorkspaceBacking(
  left: SharedArrayBuffer,
  right: SharedArrayBuffer,
  kind: keyof typeof backingWords,
): boolean {
  const words = backingWords[kind],
    bytes = (words + 1) * 4;
  if (sharedArrayBufferByteLength(left) !== bytes || sharedArrayBufferByteLength(right) !== bytes)
    return false;
  const a = new Int32ArrayConstructor(left, words * 4, 1);
  const b = new Int32ArrayConstructor(right, words * 4, 1);
  const before = atomicsLoad(a, 0);
  if (before !== 0 || atomicsLoad(b, 0) !== 0) return false;
  const probe = -1;
  try {
    atomicsStore(a, 0, probe);
    return atomicsLoad(b, 0) === probe;
  } finally {
    atomicsStore(a, 0, before);
  }
}
function reservationKey(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= CAPABILITY_HEADER &&
    value < CAPABILITY_LENGTH &&
    (value - CAPABILITY_HEADER) % CAPABILITY_WORDS === 0
  );
}

function identity(value: unknown): MutationId {
  const data = record(value);
  return { session: integer(data.session), sequence: integer(data.sequence) };
}
type WorkspaceCleanupResult =
  | { readonly kind: "workspace-stopped" }
  | { readonly kind: "workspace-stop-failed"; readonly errno: number };

function receiveWorkspaceCleanup(
  value: unknown,
  answer: ReturnType<typeof Promise.withResolvers<void>>,
): void {
  try {
    const result = record(value);
    if (result.kind === "workspace-stopped") answer.resolve();
    else if (result.kind === "workspace-stop-failed")
      answer.reject(new FilesystemError(integer(result.errno, 76)));
    else answer.reject(new FilesystemError(28));
  } catch (error) {
    answer.reject(error);
  }
}
/** Join only this connection's local bridge after its data identity is revoked. */
export async function stopWorkspaceBridge(connection: FilesystemConnection): Promise<void> {
  const ports = new NativeMessageChannel();
  const answer = Promise.withResolvers<void>();
  try {
    ports.port1.onmessage = ({ data }: MessageEvent<unknown>) =>
      receiveWorkspaceCleanup(data, answer);
    ports.port1.onmessageerror = () => answer.reject(new FilesystemError(29));
    ports.port1.start();
    connection.port.postMessage({ stopWorkspace: ports.port2 }, [ports.port2]);
    await answer.promise;
  } finally {
    ports.port1.close();
    ports.port2.close();
  }
}
type WorkspaceEndpoint =
  | { readonly kind: "live"; readonly channel: ResidentChannel }
  | { readonly kind: "cleanup-only" };

function workspaceBuffer(value: unknown, bytes?: number): SharedArrayBuffer {
  if (!(value instanceof SharedArrayBufferConstructor)) throw new FilesystemError(28);
  if (bytes !== undefined && sharedArrayBufferByteLength(value) !== bytes)
    throw new FilesystemError(28);
  return value;
}
function workspaceBuffers(value: unknown, max: number, bytes?: number): SharedArrayBuffer[] {
  if (!Array.isArray(value) || value.length > max) throw new FilesystemError(28);
  return value.map((buffer: unknown) => workspaceBuffer(buffer, bytes));
}
function workspaceReservation(value: unknown): FilesystemIdentity["reservations"][number] {
  const data = record(value);
  return {
    handle: integer(data.handle),
    source: workspaceBuffer(data.source, (CAPABILITY_LENGTH + 1) * 4),
    sourceKey: integer(data.sourceKey),
    target: workspaceBuffer(data.target, (CAPABILITY_LENGTH + 1) * 4),
    targetKey: integer(data.targetKey),
    targetOwner: integer(data.targetOwner, MAX_CONNECTION_OWNERS - 1),
    state: workspaceBuffer(data.state, 8),
  };
}
function workspaceConnection(value: unknown, parent: FilesystemConnection): FilesystemConnection {
  const data = record(value);
  const descriptor = residentDescriptor(data.residentPublication);
  if (
    !(data.port instanceof NativeMessagePort) ||
    descriptor.kind !== "workspace" ||
    JSON.stringify(descriptor) !== JSON.stringify(parent.residentPublication) ||
    !Array.isArray(data.reservations) ||
    data.reservations.length > CAPABILITY_SLOTS ||
    data.publication !== undefined ||
    data.maxBytes !== parent.maxBytes
  )
    throw new FilesystemError(28);
  const revocations = workspaceBuffers(data.revocations, MAX_CONNECTION_OWNERS, 4);
  const segments = workspaceBuffers(data.segments, parent.segments.length);
  if (!revocations.length || segments.length !== parent.segments.length)
    throw new FilesystemError(28);
  return {
    residentPublication: descriptor,
    port: data.port,
    epoch: workspaceBuffer(data.epoch, 4),
    signal: workspaceBuffer(data.signal, 4),
    revocations,
    shared: workspaceBuffer(data.shared, CONNECTION_SHARED_BYTES + 4),
    segments,
    capabilities: workspaceBuffer(data.capabilities, (CAPABILITY_LENGTH + 1) * 4),
    sections: workspaceBuffer(data.sections, 4),
    owner: integer(data.owner, MAX_CONNECTION_OWNERS - 1),
    maxBytes: parent.maxBytes,
    ownerStates: workspaceBuffer(data.ownerStates, (MAX_CONNECTION_OWNERS + 1) * 4),
    reservations: data.reservations.map(workspaceReservation),
  };
}
interface BridgeOperation {
  readonly abort: AbortController;
  readonly buffer: SharedArrayBuffer;
  readonly joined: Promise<void>;
}
interface BridgeParent {
  readonly bridge: WorkspaceBridge;
  readonly handles: readonly number[];
}
class WorkspaceBridge {
  private endpoint: WorkspaceEndpoint;
  private session: ResidentSession | undefined;
  private pending = new Map<number, BridgeOperation>();
  private responses = new Map<number, Uint8Array>();
  private bound: Promise<void> = Promise.resolve();
  private bindingStarted = false;
  private children = new Set<WorkspaceBridge>();
  private transfer = Promise.withResolvers<void>();
  private stopping: Promise<void> | undefined;
  constructor(
    private connection: FilesystemConnection,
    private parent?: BridgeParent,
    admission: WorkspaceEndpoint["kind"] = "live",
  ) {
    this.endpoint =
      admission === "cleanup-only"
        ? { kind: "cleanup-only" }
        : { kind: "live", channel: new ResidentChannel(connection.residentPublication!.workspace) };
    void this.transfer.promise.catch(() => {});
    connection.port.onmessage = ({ data }: MessageEvent<unknown>) => this.receive(data);
    connection.port.start();
  }
  private get channel(): ResidentChannel {
    if (this.endpoint.kind !== "live") throw new FilesystemError(11);
    return this.endpoint.channel;
  }
  private connect(value: unknown): void {
    const child = workspaceConnection(value, this.connection);
    if (
      !sameWorkspaceBacking(child.shared, this.connection.shared, "shared") ||
      !sameWorkspaceBacking(child.ownerStates, this.connection.ownerStates, "owners") ||
      !child.owner ||
      child.owner === this.connection.owner ||
      child.owner > Atomics.load(new Int32ArrayConstructor(child.shared), 5)
    )
      throw new FilesystemError(11);
    for (const reservation of child.reservations) this.validateProvenance(child, reservation);
    const admission = this.cancelledConnection(child) ? "cleanup-only" : "live";
    if (admission === "live") this.validateChildAdmission(child);
    if (this.children.size >= 16) throw new FilesystemError(6);
    const handles = child.reservations.map((reservation) => reservation.handle);
    const bridge = new WorkspaceBridge(child, { bridge: this, handles }, admission);
    this.children.add(bridge);
    void bridge.transfer.promise.then(
      () => this.children.delete(bridge),
      () => {},
    );
    if (admission === "live" && !handles.length) bridge.transfer.resolve();
  }
  private validateProvenance(
    child: FilesystemConnection,
    reservation: FilesystemIdentity["reservations"][number],
  ): void {
    if (
      !sameWorkspaceBacking(reservation.source, this.connection.capabilities, "capabilities") ||
      !sameWorkspaceBacking(reservation.target, child.capabilities, "capabilities") ||
      reservation.targetOwner !== child.owner ||
      !reservationKey(reservation.sourceKey) ||
      !reservationKey(reservation.targetKey)
    )
      throw new FilesystemError(8);
    const source = new Int32ArrayConstructor(reservation.source, 0, CAPABILITY_LENGTH),
      target = new Int32ArrayConstructor(reservation.target, 0, CAPABILITY_LENGTH);
    if (
      Atomics.load(source, reservation.sourceKey) !== reservation.handle ||
      Atomics.load(target, reservation.targetKey) !== reservation.handle
    )
      throw new FilesystemError(8);
  }
  private cancelledConnection(child: FilesystemConnection): boolean {
    const revoked = Atomics.load(new Int32ArrayConstructor(child.revocations[0]!), 0);
    const owner = Atomics.load(new Int32ArrayConstructor(child.ownerStates), child.owner);
    if ((revoked !== 1 && revoked !== 2) || (owner !== 1 && owner !== 2)) return false;
    return child.reservations.every((reservation) => {
      const state = new Int32ArrayConstructor(reservation.state);
      const source = new Int32ArrayConstructor(reservation.source, 0, CAPABILITY_LENGTH);
      const target = new Int32ArrayConstructor(reservation.target, 0, CAPABILITY_LENGTH);
      return (
        Atomics.load(state, 0) === 1 &&
        Atomics.load(state, 1) === 2 &&
        Atomics.load(source, reservation.sourceKey + 2) >= 0 &&
        Atomics.load(target, reservation.targetKey + 1) === 0 &&
        Atomics.load(target, reservation.targetKey + 2) === 0
      );
    });
  }
  private validateChildAdmission(child: FilesystemConnection): void {
    if (this.stopping || isRevoked(this.connection) || isRevoked(child))
      throw new FilesystemError(11);
    for (const reservation of child.reservations) this.validateReservation(child, reservation);
  }
  private validateReservation(
    child: FilesystemConnection,
    reservation: FilesystemIdentity["reservations"][number],
  ): void {
    const source = new Int32ArrayConstructor(this.connection.capabilities, 0, CAPABILITY_LENGTH),
      target = new Int32ArrayConstructor(child.capabilities, 0, CAPABILITY_LENGTH);
    this.validateProvenance(child, reservation);
    if (
      Atomics.load(source, reservation.sourceKey) !== reservation.handle ||
      Atomics.load(source, reservation.sourceKey + 2) <= 0 ||
      Atomics.load(target, reservation.targetKey) !== reservation.handle ||
      Atomics.load(target, reservation.targetKey + 1) <= 0
    )
      throw new FilesystemError(8);
    const state = new Int32Array(reservation.state);
    if (Atomics.load(state, 0) || Atomics.load(state, 1)) throw new FilesystemError(11);
  }
  private receive(value: unknown): void {
    try {
      this.message(record(value));
    } catch {
      /* Malformed local data owns no request. */
    }
  }
  private message(data: Record<string, unknown>): void {
    if ("stopWorkspace" in data) return this.replyStopped(data.stopWorkspace);
    if ("connect" in data && this.endpoint.kind === "live") return this.connect(data.connect);
    if (this.stopping || this.endpoint.kind === "cleanup-only") {
      if (data.buffer instanceof SharedArrayBuffer) this.fail(integer(data.id), data.buffer, 11);
      return;
    }
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
    if (buffer.byteLength > requestBound || this.pending.size >= 16)
      return this.fail(id, buffer, 6);
    const abort = new AbortController();
    const joined = this.execute(id, buffer, abort.signal).catch((error: unknown) =>
      this.fail(id, buffer, error instanceof FilesystemError ? error.errno : 29),
    );
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
    if (
      session.descriptor.kind !== "workspace" ||
      JSON.stringify(session.descriptor) !== JSON.stringify(this.connection.residentPublication)
    )
      throw new FilesystemError(11);
    this.session = session;
    const parent = this.parent;
    if (!parent || !parent.handles.length) return;
    await parent.bridge.bound;
    const source = parent.bridge.session;
    if (!source) throw new FilesystemError(11);
    await this.channel.call("workspaceAdopt", {
      token: session.token,
      source: source.token,
      handles: parent.handles,
    });
    for (const reservation of this.connection.reservations) this.finishReservation(reservation);
    this.transfer.resolve();
  }
  private cancelTransferred(): void {
    if (this.endpoint.kind === "cleanup-only" || this.bindingStarted) return;
    if (
      !isRevoked(this.connection) &&
      this.connection.reservations.some(
        (reservation) => !Atomics.load(new Int32Array(reservation.state), 0),
      )
    )
      return;
    this.transfer.resolve();
  }
  private finishReservation(reservation: FilesystemIdentity["reservations"][number]): void {
    const parent = this.parent;
    if (!parent) throw new FilesystemError(11);
    parent.bridge.validateReservation(this.connection, reservation);
    const state = new Int32Array(reservation.state);
    if (Atomics.compareExchange(state, 1, 0, 1)) throw new FilesystemError(11);
    Atomics.sub(
      new Int32ArrayConstructor(reservation.source, 0, CAPABILITY_LENGTH),
      reservation.sourceKey + 2,
      1,
    );
  }
  private mirror(value: unknown): unknown {
    const response = record(value);
    if (!Array.isArray(response.handles) || response.handles.length > CAPABILITY_SLOTS)
      throw new FilesystemError(29);
    const entries = new Int32ArrayConstructor(this.connection.capabilities, 0, CAPABILITY_LENGTH);
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
  private replyStopped(value: unknown): void {
    if (!(value instanceof NativeMessagePort)) throw new FilesystemError(28);
    const stopped = this.stop();
    void stopped.then(
      () => this.cleanupReply(value, { kind: "workspace-stopped" }),
      (error: unknown) =>
        this.cleanupReply(value, {
          kind: "workspace-stop-failed",
          errno: error instanceof FilesystemError ? error.errno : 29,
        }),
    );
  }
  private cleanupReply(port: MessagePort, result: WorkspaceCleanupResult): void {
    try {
      port.postMessage(result);
    } catch {
      // A vanished receiver cannot turn a failed join into successful cleanup.
    } finally {
      port.close();
    }
  }
  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const answer = Promise.withResolvers<void>();
    this.stopping = answer.promise;
    void this.stopOwned().then(answer.resolve, answer.reject);
    return this.stopping;
  }
  private async stopOwned(): Promise<void> {
    for (const pending of this.pending.values()) pending.abort.abort();
    await Promise.all(Array.from(this.pending.values(), (pending) => pending.joined));
    await this.bound;
    if (this.endpoint.kind === "live") await this.endpoint.channel.joinSettled();
    while (this.children.size) {
      for (const child of this.children) child.cancelTransferred();
      await Promise.all(Array.from(this.children, (child) => child.transfer.promise));
    }
    this.responses.clear();
    if (this.endpoint.kind === "live") this.endpoint.channel.close();
    this.connection.port.close();
    if (!this.bindingStarted) this.transfer.resolve();
  }
  private async execute(id: number, buffer: SharedArrayBuffer, signal: AbortSignal): Promise<void> {
    const cells = new Int32Array(buffer, 0, HEADER / 4);
    const inputLength = integer(cells[1], 8192),
      dataLength = integer(cells[2], PAGE);
    if (inputLength + dataLength > buffer.byteLength - HEADER) throw new FilesystemError(28);
    const input: unknown = unpack(new Uint8Array(buffer, HEADER, inputLength));
    const call = record(input),
      operation = text(call.operation);
    if (!Array.isArray(call.args)) throw new FilesystemError(28);
    if (operation === "workspaceBind") {
      this.bindingStarted = true;
      this.bound = this.bind(call.args[0]);
      void this.bound.catch((error: unknown) => this.transfer.reject(error));
      await this.bound;
      return this.complete(id, buffer, undefined);
    }
    if (operation === "take") {
      const key = integer(call.args[0]),
        at = integer(call.args[1]),
        count = integer(call.args[2], PAGE);
      const response = this.responses.get(key);
      if (!response) throw new FilesystemError(11);
      const part = response.slice(at, at + count);
      if (at + count >= response.length) this.responses.delete(key);
      return this.complete(id, buffer, part);
    }
    await this.bound;
    const session = this.session;
    if (!session || signal.aborted || Atomics.load(cells, 6)) throw new FilesystemError(11);
    const token = session.token;
    if (
      operation === "workspaceNext" ||
      operation === "workspaceReceipt" ||
      operation === "workspaceReceipts"
    ) {
      const value = await this.channel.call(operation, { token, id: call.args[0] }, signal);
      return this.complete(id, buffer, value);
    }
    const args = call.args;
    const explicit = operation === "workspaceMutation";
    const actualOperation = explicit ? text(args[1]) : operation;
    const actualArgs = explicit ? args[2] : args;
    const mutationId = explicit ? identity(args[0]) : undefined;
    const value = await this.channel.call(
      "workspace",
      {
        token,
        request: {
          operation: actualOperation,
          args: actualArgs,
          input: new Uint8Array(new Uint8Array(buffer, HEADER + inputLength, dataLength)),
          id: mutationId,
        },
      },
      signal,
    );
    if (signal.aborted || Atomics.load(cells, 6) || isRevoked(this.connection))
      throw new FilesystemError(11);
    this.complete(id, buffer, this.mirror(value));
  }
}
function installWorkspaceBridge(connection: FilesystemConnection): void {
  new WorkspaceBridge(connection);
}
