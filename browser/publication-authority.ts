import { WorkspacePeer, workspaceRequest } from "../fs/publication-workspace.js";
import { FilesystemError } from "../core/filesystem.js";
import {
  ResidentGrantAuthority,
  type ResidentOutcome,
  type ResidentSession,
} from "../fs/publication-grant.js";
import {
  acquirePublicationGuard,
  encodeResidentSettlement,
  record,
  integer,
  residentDescriptor,
  residentOutcome,
  residentRequest,
  text,
  type PublicationGuard,
} from "../fs/publication-attachment.js";

interface StatusWaiter {
  readonly client: string;
  readonly resolve: (value: ResidentOutcome) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
type TerminalOutcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "error"; readonly errno: number };
interface OwnerDrain {
  kind: "draining" | "blocked";
  readonly answer: ReturnType<typeof Promise.withResolvers<void>>;
}
const cleanupOperations = new Set(["closeConnection", "close", "settle"]);
/** Private transport for the real MemoryBackend authority. It never sends its root SAB. */
export class ResidentAuthorityServer {
  private channel: BroadcastChannel;
  private sessions = new Map<string, ResidentSession>();
  private peers = new Map<string, WorkspacePeer>();
  private requests = new Map<string, { client: string; token: unknown; abort: AbortController }>();
  private terminal = new Map<string, TerminalOutcome>();
  private reconciling = new Set<string>();
  private status = new Map<string, StatusWaiter>();
  private outstanding:
    | { readonly client: string; readonly token: string; readonly grant: string }
    | undefined;
  private queue = Promise.resolve();
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private draining: OwnerDrain | undefined;
  private finalizing: Promise<void> | undefined;
  constructor(
    readonly authority: ResidentGrantAuthority,
    private guard: PublicationGuard,
    private bootstrap: PublicationGuard,
  ) {
    this.channel = new BroadcastChannel(`waffle:resident:${authority.workspace}`);
    this.channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      let message: Record<string, unknown>;
      try {
        message = record(data);
      } catch {
        return;
      }
      if (message.kind === "statusReply") {
        this.receiveStatus(message);
        return;
      }
      if (message.kind === "cancel" || message.kind === "ack") return this.control(message);
      if (message.kind === "reconcile") {
        this.reconcile(message);
        return;
      }
      if (message.kind === "cancelSession") {
        this.cancelSession(message.token);
        return;
      }
      if (message.kind !== "request") return;
      this.admit(message);
    };
  }
  private key(client: string, id: string): string {
    return JSON.stringify([client, id]);
  }
  private control(message: Record<string, unknown>): void {
    let key: string;
    try {
      key = this.key(text(message.client), text(message.id));
    } catch {
      return;
    }
    if (message.kind === "cancel") this.requests.get(key)?.abort.abort();
    else this.terminal.delete(key);
  }
  private postTerminal(client: string, id: string, outcome: TerminalOutcome): void {
    const key = this.key(client, id);
    this.terminal.set(key, outcome);
    this.channel.postMessage(
      outcome.kind === "value"
        ? { kind: "reply", client, id, value: outcome.value }
        : { kind: "reply", client, id, errno: outcome.errno },
    );
    if (this.reconciling.delete(key)) this.reconcile({ client, id });
  }
  private reconcile(message: Record<string, unknown>): void {
    let client: string, id: string;
    try {
      client = text(message.client);
      id = text(message.id);
    } catch {
      return;
    }
    const key = this.key(client, id),
      terminal = this.terminal.get(key);
    if (terminal) {
      this.channel.postMessage(
        terminal.kind === "value"
          ? { kind: "reconcileReply", client, id, state: "terminal", value: terminal.value }
          : { kind: "reconcileReply", client, id, state: "terminal", errno: terminal.errno },
      );
      return;
    }
    if (this.requests.has(key)) this.reconciling.add(key);
    this.channel.postMessage({
      kind: "reconcileReply",
      client,
      id,
      state: this.requests.has(key) ? "pending" : "unknown",
    });
  }
  private cancelSession(token: unknown): void {
    for (const active of this.requests.values()) if (active.token === token) active.abort.abort();
  }
  private admit(message: Record<string, unknown>): void {
    let client: string, id: string;
    try {
      client = text(message.client);
      id = text(message.id);
    } catch {
      return;
    }
    const key = this.key(client, id);
    const terminal = this.terminal.get(key);
    if (terminal) {
      this.postTerminal(client, id, terminal);
      return;
    }
    if (this.requests.has(key)) return;
    if (
      this.requests.size + this.terminal.size >=
      this.authority.backend.shared.publication!.limits.operations
    ) {
      this.channel.postMessage({ kind: "reply", client, id, errno: 6 });
      return;
    }
    const operation = typeof message.operation === "string" ? message.operation : undefined;
    if (this.stopped && (!operation || !cleanupOperations.has(operation))) {
      this.postTerminal(client, id, { kind: "error", errno: 11 });
      return;
    }
    if (message.operation === "workspace") {
      try {
        const body = record(message.body),
          limits = this.authority.backend.shared.publication!.limits;
        message.body = {
          token: text(body.token),
          request: workspaceRequest(body.request, limits.inputBytes, limits.argumentBytes),
        };
      } catch (error) {
        this.postTerminal(client, id, {
          kind: "error",
          errno: error instanceof FilesystemError ? error.errno : 29,
        });
        return;
      }
    }
    const abort = new AbortController();
    const body = message.body;
    const token = body && typeof body === "object" && "token" in body ? body.token : undefined;
    this.requests.set(key, { client, token, abort });
    this.queue = this.queue
      .then(() => this.request(message, abort.signal))
      .catch(() => {})
      .finally(() => this.requests.delete(key));
  }
  private token(value: unknown): ResidentSession {
    const token = text(value);
    const session = Array.from(this.sessions.values()).find((session) => session.token === token);
    if (!session) throw new FilesystemError(11);
    return session;
  }
  private peer(session: ResidentSession): WorkspacePeer {
    if (session.descriptor.kind !== "workspace") throw new FilesystemError(58);
    let peer = this.peers.get(session.token);
    if (peer) return peer;
    const host = this.authority.workspaceHost;
    if (!host) throw new FilesystemError(58);
    peer = new WorkspacePeer(session, host);
    this.peers.set(session.token, peer);
    return peer;
  }
  private async closeSession(session: ResidentSession): Promise<void> {
    await this.peers.get(session.token)?.stop();
    this.peers.delete(session.token);
    this.authority.close(session);
  }
  private receiveStatus(data: Record<string, unknown>): void {
    try {
      const id = text(data.id),
        waiting = this.status.get(id);
      if (!waiting || data.client !== waiting.client) return;
      this.status.delete(id);
      clearTimeout(waiting.timer);
      try {
        waiting.resolve(residentOutcome(data.outcome));
      } catch (error) {
        waiting.reject(error);
      }
    } catch {
      /* Unmatched status is not evidence of cancellation or death. */
    }
  }
  private async settleOutstanding(): Promise<void> {
    const active = this.outstanding;
    if (!active) return;
    const session = this.sessions.get(active.client);
    if (!session || session.token !== active.token) throw new FilesystemError(11);
    const id = crypto.randomUUID(),
      answer = Promise.withResolvers<ResidentOutcome>();
    const timer = setTimeout(() => {
      this.status.delete(id);
      answer.reject(new FilesystemError(6));
    }, 3000);
    this.status.set(id, { client: active.client, ...answer, timer });
    this.channel.postMessage({ kind: "status", id, client: active.client });
    const outcome = await answer.promise;
    if (this.stopped) throw new FilesystemError(11);
    const result = this.authority.settle(session, outcome);
    if (result.kind === "pending") throw new FilesystemError(6);
    this.outstanding = undefined;
  }
  private session(client: string, token: unknown): ResidentSession {
    const session = this.sessions.get(client);
    if (!session || session.token !== text(token)) throw new FilesystemError(11);
    return session;
  }
  private adoptWorkspace(peer: WorkspacePeer, body: Record<string, unknown>): number[] {
    if (!Array.isArray(body.handles) || body.handles.length > 4096) throw new FilesystemError(28);
    return peer.adopt(
      this.peer(this.token(body.source)),
      body.handles.map((handle: unknown) => integer(handle)),
    );
  }
  private async execute(
    client: string,
    operation: string,
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (operation === "closeConnection") {
      const session = this.sessions.get(client);
      if (session) await this.closeSession(session);
      this.sessions.delete(client);
      return null;
    }
    if (operation === "close" || operation === "settle")
      return this.finish(client, operation, record(value));
    if (this.stopped) throw new FilesystemError(11);
    if (signal.aborted) throw new FilesystemError(11);
    if (operation === "open") {
      if (this.sessions.has(client)) throw new FilesystemError(6);
      const session = this.authority.open(residentDescriptor(value));
      this.sessions.set(client, session);
      return session;
    }
    const body = record(value);
    if (operation.startsWith("workspace")) {
      const session = this.token(body.token);
      await this.settleOutstanding();
      if (this.stopped || signal.aborted) throw new FilesystemError(11);
      const peer = this.peer(session);
      if (operation === "workspaceNext") return peer.next();
      if (operation === "workspaceReceipts") return peer.receipts();
      if (operation === "workspaceReceipt") return peer.receipt(body.id);
      if (operation === "workspaceAdopt") return this.adoptWorkspace(peer, body);
      if (operation === "workspace") return peer.execute(body.request, signal);
      throw new FilesystemError(2);
    }
    const session = this.session(client, body.token);
    if (operation === "prepare") {
      const request = residentRequest(body.request);
      await this.settleOutstanding();
      if (this.stopped || signal.aborted) throw new FilesystemError(11);
      const handle = body.handle === undefined ? session.descriptor.handle : integer(body.handle);
      if (
        session.descriptor.kind === "file"
          ? handle !== session.descriptor.handle
          : !this.peer(session).owns(handle)
      )
        throw new FilesystemError(8);
      const grant = this.authority.prepare(session, request, handle);
      this.outstanding = { client, token: session.token, grant: grant.key };
      return grant;
    }
    throw new FilesystemError(58);
  }
  private async finish(
    client: string,
    operation: "close" | "settle",
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const session = this.session(client, body.token);
    if (operation === "settle") {
      const outcome = residentOutcome(body.outcome);
      const result = this.authority.settle(session, outcome);
      if (
        result.kind !== "pending" &&
        this.outstanding?.token === session.token &&
        this.outstanding.grant === outcome.grant
      )
        this.outstanding = undefined;
      return encodeResidentSettlement(result);
    }
    await this.closeSession(session);
    this.sessions.delete(client);
    return null;
  }
  private async request(data: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    let client: string, id: string;
    try {
      client = text(data.client);
      id = text(data.id);
    } catch {
      return;
    }
    let outcome: TerminalOutcome;
    try {
      const value = await this.execute(client, text(data.operation), data.body, signal);
      outcome = { kind: "value", value };
    } catch (error) {
      const errno = error instanceof FilesystemError ? error.errno : 29;
      outcome = { kind: "error", errno };
    }
    this.postTerminal(client, id, outcome);
  }
  stop(): Promise<void> {
    this.stopped = true;
    for (const active of this.requests.values()) active.abort.abort();
    return (this.stopping ??= this.stopOwned());
  }
  private async stopOwned(): Promise<void> {
    await this.drainTransport();
    await this.finishStop();
  }
  drainForOwner(): Promise<void> {
    this.stopped = true;
    for (const active of this.requests.values()) active.abort.abort();
    const current = this.draining;
    if (current && (current.kind === "draining" || this.sessions.size || this.outstanding))
      return current.answer.promise;
    const drain: OwnerDrain = { kind: "draining", answer: Promise.withResolvers<void>() };
    this.draining = drain;
    void this.drainPersistentTransport(drain).then(drain.answer.resolve, drain.answer.reject);
    return drain.answer.promise;
  }
  private async drainPersistentTransport(drain: OwnerDrain): Promise<void> {
    await this.queue;
    if (this.sessions.size || this.outstanding) {
      drain.kind = "blocked";
      throw new FilesystemError(6, "resident clients must finish their original cleanup");
    }
    await this.drainTransport();
  }
  private async drainTransport(): Promise<void> {
    await this.queue;
    // A pending/unknown claimant keeps both continuity and bootstrap held.
    if (this.outstanding) throw new FilesystemError(6);
    for (const peer of this.peers.values()) await peer.stop();
    this.peers.clear();
  }
  finishStop(): Promise<void> {
    return (this.finalizing ??= this.finalizeTransport());
  }
  private async finalizeTransport(): Promise<void> {
    this.channel.close();
    this.terminal.clear();
    this.reconciling.clear();
    this.authority.dispose();
    await this.guard.release();
    await this.bootstrap.release();
  }
}

/** Recovery owns bootstrap first and requests exclusive workspace continuity without
 * holding an incoming shared guard. The authority's own shared guard follows recovery. */
export async function serveResidentAuthority(
  authority: ResidentGrantAuthority,
  signal: AbortSignal,
): Promise<ResidentAuthorityServer> {
  let bootstrap: PublicationGuard | undefined;
  let prospective: PublicationGuard | undefined;
  try {
    bootstrap = await acquirePublicationGuard(
      `bootstrap:${authority.workspace}`,
      "exclusive",
      signal,
      true,
    );
    prospective = await acquirePublicationGuard(authority.workspace, "exclusive", signal, true);
    await prospective.release();
    prospective = undefined;
    prospective = await acquirePublicationGuard(authority.workspace, "shared", signal);
    if (signal.aborted) throw new FilesystemError(11);
    authority.activate();
    return new ResidentAuthorityServer(authority, prospective, bootstrap);
  } catch (error) {
    authority.dispose();
    await prospective?.release();
    await bootstrap?.release();
    throw error;
  }
}
