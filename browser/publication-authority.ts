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
/** Private transport for the real MemoryBackend authority. It never sends its root SAB. */
export class ResidentAuthorityServer {
  private channel: BroadcastChannel;
  private sessions = new Map<string, ResidentSession>();
  private peers = new Map<string, WorkspacePeer>();
  private requests = new Map<string, { client: string; token: unknown; abort: AbortController }>();
  private status = new Map<string, StatusWaiter>();
  private outstanding:
    | { readonly client: string; readonly token: string; readonly grant: string }
    | undefined;
  private queue = Promise.resolve();
  private stopped = false;
  private stopping: Promise<void> | undefined;
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
      if (message.kind === "cancel") {
        this.requests.get(`${String(message.client)}:${String(message.id)}`)?.abort.abort();
        return;
      }
      if (message.kind === "cancelSession") {
        for (const active of this.requests.values())
          if (active.token === message.token) active.abort.abort();
        return;
      }
      if (message.kind !== "request" || this.stopped) return;
      this.admit(message);
    };
  }
  private admit(message: Record<string, unknown>): void {
    let client: string, id: string;
    try { client = text(message.client); id = text(message.id); } catch { return; }
    const key = `${client}:${id}`;
    if (message.operation === "workspace") {
      try {
        const body = record(message.body), limits = this.authority.backend.shared.publication!.limits;
        message.body = { token: text(body.token), request: workspaceRequest(body.request, limits.inputBytes, limits.argumentBytes) };
      } catch (error) {
        this.channel.postMessage({ kind: "reply", client, id, errno: error instanceof FilesystemError ? error.errno : 29 });
        return;
      }
    }
    if (this.requests.has(key)) return;
    if (this.requests.size >= this.authority.backend.shared.publication!.limits.operations) {
      this.channel.postMessage({ kind: "reply", client, id, errno: 6 });
      return;
    }
    const abort = new AbortController();
    const body = message.body;
    const token = body && typeof body === "object" && "token" in body ? body.token : undefined;
    this.requests.set(key, { client, token, abort });
    this.queue = this.queue.then(() => this.request(message, abort.signal)).catch(() => {}).finally(() => this.requests.delete(key));
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
  private async execute(client: string, operation: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.stopped || signal.aborted) throw new FilesystemError(11);
    if (operation === "open") {
      if (this.sessions.has(client)) throw new FilesystemError(6);
      const session = this.authority.open(residentDescriptor(value));
      this.sessions.set(client, session);
      return session;
    }
    if (operation === "closeConnection") {
      const session = this.sessions.get(client);
      if (session) await this.closeSession(session);
      this.sessions.delete(client);
      return null;
    }
    const body = record(value);
    if (operation.startsWith("workspace")) {
      const session = this.token(body.token);
      await this.settleOutstanding();
      if (this.stopped || signal.aborted) throw new FilesystemError(11);
      const peer = this.peer(session);
      if (operation === "workspaceNext") return peer.next();
      if (operation === "workspaceReceipt") return peer.receipt(body.id);
      if (operation === "workspaceAdopt") {
        if (!Array.isArray(body.handles) || body.handles.length > 4096) throw new FilesystemError(28);
        return peer.adopt(this.peer(this.token(body.source)), body.handles.map((handle: unknown) => integer(handle)));
      }
      if (operation === "workspace") return peer.execute(body.request, signal);
      throw new FilesystemError(2);
    }
    const session = this.session(client, body.token);
    if (operation === "prepare") {
      const request = residentRequest(body.request);
      await this.settleOutstanding();
      if (this.stopped) throw new FilesystemError(11);
      const handle = body.handle === undefined ? session.descriptor.handle : integer(body.handle);
      if (session.descriptor.kind === "workspace" && !this.peer(session).owns(handle))
        throw new FilesystemError(8);
      const grant = this.authority.prepare(session, request, handle);
      this.outstanding = { client, token: session.token, grant: grant.key };
      return grant;
    }
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
    if (operation === "close") {
      await this.closeSession(session);
      this.sessions.delete(client);
      return null;
    }
    throw new FilesystemError(58);
  }
  private async request(data: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    let client: string, id: string;
    try {
      client = text(data.client);
      id = text(data.id);
    } catch {
      return;
    }
    try {
      const value = await this.execute(client, text(data.operation), data.body, signal);
      this.channel.postMessage({ kind: "reply", client, id, value });
    } catch (error) {
      const errno = error instanceof FilesystemError ? error.errno : 29;
      this.channel.postMessage({ kind: "reply", client, id, errno });
    }
  }
  stop(): Promise<void> {
    this.stopped = true;
    for (const active of this.requests.values()) active.abort.abort();
    return (this.stopping ??= this.stopOwned());
  }
  private async stopOwned(): Promise<void> {
    await this.queue;
    // A pending/unknown claimant keeps both continuity and bootstrap held.
    if (this.outstanding) throw new FilesystemError(6);
    for (const peer of this.peers.values()) await peer.stop();
    this.peers.clear();
    this.channel.close();
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
