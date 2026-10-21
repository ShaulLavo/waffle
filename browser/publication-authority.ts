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
      if (message.kind !== "request" || this.stopped) return;
      this.queue = this.queue.then(() => this.request(message)).catch(() => {});
    };
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
  private async execute(client: string, operation: string, value: unknown): Promise<unknown> {
    if (operation === "open") {
      if (this.sessions.has(client)) throw new FilesystemError(6);
      const session = this.authority.open(residentDescriptor(value));
      this.sessions.set(client, session);
      return session;
    }
    if (operation === "closeConnection") {
      const session = this.sessions.get(client);
      if (session) this.authority.close(session);
      this.sessions.delete(client);
      return null;
    }
    const body = record(value),
      session = this.session(client, body.token);
    if (operation === "prepare") {
      const request = residentRequest(body.request);
      await this.settleOutstanding();
      if (this.stopped) throw new FilesystemError(11);
      const grant = this.authority.prepare(session, request);
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
      this.authority.close(session);
      this.sessions.delete(client);
      return null;
    }
    throw new FilesystemError(58);
  }
  private async request(data: Record<string, unknown>): Promise<void> {
    let client: string, id: string;
    try {
      client = text(data.client);
      id = text(data.id);
    } catch {
      return;
    }
    try {
      const value = await this.execute(client, text(data.operation), data.body);
      this.channel.postMessage({ kind: "reply", client, id, value });
    } catch (error) {
      const errno = error instanceof FilesystemError ? error.errno : 29;
      this.channel.postMessage({ kind: "reply", client, id, errno });
    }
  }
  stop(): Promise<void> {
    this.stopped = true;
    return (this.stopping ??= this.stopOwned());
  }
  private async stopOwned(): Promise<void> {
    await this.queue;
    // A pending/unknown claimant keeps both continuity and bootstrap held.
    if (this.outstanding) throw new FilesystemError(6);
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
  const bootstrap = await acquirePublicationGuard(
    `bootstrap:${authority.workspace}`,
    "exclusive",
    signal,
    true,
  );
  let prospective: PublicationGuard | undefined;
  try {
    prospective = await acquirePublicationGuard(authority.workspace, "exclusive", signal, true);
    await prospective.release();
    prospective = await acquirePublicationGuard(authority.workspace, "shared", signal);
    if (signal.aborted) throw new FilesystemError(11);
    return new ResidentAuthorityServer(authority, prospective, bootstrap);
  } catch (error) {
    await prospective?.release();
    await bootstrap.release();
    throw error;
  }
}
