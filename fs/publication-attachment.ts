import { installWorkspaceBridge } from "./publication-workspace.js";
import { FilesystemError } from "../core/filesystem.js";
import { decodeEffects, encodeEffects, type PublicationCut } from "./publication.js";
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
  connectFilesystemIdentity,
  createFilesystemIdentity,
  SHARED_SEGMENT_BYTES,
  type FilesystemConnection,
} from "./protocol.js";

const NativeChannel = globalThis.BroadcastChannel;
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

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
/** The channel never transfers an authority SAB. Status asks the original cell owner. */
export class ResidentChannel {
  readonly id = crypto.randomUUID();
  readonly channel: BroadcastChannel;
  private pending = new Map<string, PendingCall>();
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
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (data.errno !== undefined) pending.reject(new FilesystemError(integer(data.errno)));
    else pending.resolve(data.value);
  }
  call(operation: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.pending.size >= 16) return Promise.reject(new FilesystemError(6));
    if (signal?.aborted) return Promise.reject(new FilesystemError(11));
    const id = crypto.randomUUID();
    const answer = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.channel.postMessage({ kind: "cancel", client: this.id, id });
      answer.reject(new FilesystemError(6));
    }, callBound);
    this.pending.set(id, { ...answer, timer });
    try {
      this.channel.postMessage({ kind: "request", id, client: this.id, operation, body });
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      answer.reject(error);
    }
    const cancel = () => this.channel.postMessage({ kind: "cancel", client: this.id, id });
    signal?.addEventListener("abort", cancel, { once: true });
    return answer.promise.finally(() => signal?.removeEventListener("abort", cancel));
  }
  cancelSession(token: string): void {
    this.channel.postMessage({ kind: "cancelSession", token });
  }
  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new FilesystemError(11));
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
    const grant = residentGrant(
      await this.channel.call("prepare", { token: this.session.token, request, handle }),
    );
    if (JSON.stringify(grant.session) !== JSON.stringify(this.session))
      throw new FilesystemError(11);
    this.cell = new ResidentGrantCell(grant, undefined, () => !this.stopped && !this.revoked());
    if (!this.stopped && !this.revoked()) return;
    this.cell.cancel();
    await this.settle();
    throw new FilesystemError(11);
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
    if (this.cell) {
      const result = await this.settle();
      if (result.kind === "pending" || result.kind === "unknown") throw new FilesystemError(6);
    }
    await this.channel.call("close", { token: this.session.token });
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
        await resources.channel.call("closeConnection", null);
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

/** Local liveness and capabilities reuse a full root-format allocation: 25,477,140 bytes
 * before objects, ports and offsets. No backend or authority root is copied; namespace is unsupported. */
export function createResidentConnection(value: ResidentDescriptor): FilesystemConnection {
  const descriptor = residentDescriptor(value);
  const identity = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES);
  identity.residentPublication = descriptor;
  const entries = new Int32Array(identity.capabilities);
  entries[0] = 1;
  entries[CAPABILITY_HEADER] = descriptor.handle;
  entries[CAPABILITY_HEADER + 1] = 0;
  entries[CAPABILITY_HEADER + 2] = 0;
  const connection = connectFilesystemIdentity(identity);
  if (descriptor.kind === "workspace") installWorkspaceBridge(connection.server);
  else connection.server.port.close();
  return connection.client;
}
