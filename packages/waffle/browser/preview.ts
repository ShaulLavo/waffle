import type {
  ConnectionSink,
  PreviewConnection,
  PreviewRequestOptions,
  PreviewSink,
} from "./net/helper.js";
import type { PreviewRequest } from "./net/http1.js";
import type { PreviewMessage, PreviewReply } from "./preview-protocol.js";
import type { PreviewHostOptions, PreviewHostRelay } from "./preview-host.js";

export type { PreviewRequestOptions };

/** A server transport, independent of the guest engine or worker owning it. */
export interface PreviewServer {
  /** Aborting `options.signal` ends this request on the server's side as well as the sink's. */
  request(
    port: number,
    request: PreviewRequest,
    sink: PreviewSink,
    options?: PreviewRequestOptions,
  ): boolean;
  connect(port: number, sink: ConnectionSink): PreviewConnection | null;
}

interface SocketLivenessOptions {
  /** Interval in ms between liveness pings on open socket tunnels (0 disables). Default 15000. */
  readonly socketPingIntervalMs?: number;
  /** Consecutive unanswered pings before closing a silent socket tunnel. Default 3. */
  readonly socketMissedPings?: number;
}

interface MountPreviewOptions extends SocketLivenessOptions {
  baseURL: string;
  /** Consumer-owned mount directory, relative to baseURL (without a trailing slash). */
  prefix: string;
}

export type PreviewOptions =
  | MountPreviewOptions
  | ({ mode: "root"; originForPort(port: number): string } & SocketLivenessOptions);

const DEFAULT_SOCKET_PING_MS = 15_000;
const DEFAULT_SOCKET_MISSED_PINGS = 3;

/** Page-side request/socket routing. The consumer owns service-worker registration. */
export class PreviewRouter {
  private servers = new Map<number, PreviewServer>();
  private hosts = new Map<number, PreviewHostRelay>();
  private sockets = new Map<number, Set<() => void>>();
  private owner: string | undefined;
  constructor(private options: PreviewOptions) {}

  url(port: number, path = "/"): string {
    if ("mode" in this.options) {
      const host = this.hosts.get(port);
      if (!host || host.closed) throw new Error(`No authenticated preview host for port ${port}`);
      const url = new URL(path, host.origin);
      if (!path.startsWith("/") || path.startsWith("//") || url.origin !== host.origin)
        throw new TypeError("Preview path must stay on its bound origin");
      return url.href;
    }
    return new URL(`${this.options.prefix}/${port}${path}`, this.options.baseURL).href;
  }

  /** Grant a private host adapter access to this owner's one virtual server. */
  async bindHost(options: PreviewHostOptions): Promise<PreviewHostRelay> {
    if (!("mode" in this.options)) throw new Error("Host bindings require root preview mode");
    const binding = { ...options, origin: this.options.originForPort(options.port) };
    const { createPreviewHostRelay } = await import("./preview-host.js");
    if (!this.servers.has(binding.port))
      throw new Error(`No preview server on port ${binding.port}`);
    this.owner ??= crypto.randomUUID();
    const host = createPreviewHostRelay(
      { connect: (port, sink) => this.servers.get(port)?.connect(port, sink) ?? null },
      this.owner,
      {
        ...binding,
        originPort: (origin) =>
          Array.from(this.hosts).find(([, host]) => !host.closed && host.origin === origin)?.[0],
      },
    );
    for (const [port, other] of this.hosts) {
      if (port === binding.port || other.closed || other.origin !== host.origin) continue;
      host.close();
      throw new Error("Preview origin is already bound to another virtual port");
    }
    const previous = this.hosts.get(binding.port);
    this.hosts.set(binding.port, host);
    try {
      previous?.close();
    } catch (error) {
      if (this.hosts.get(binding.port) === host) this.hosts.delete(binding.port);
      host.close();
      throw error;
    }
    return host;
  }

  private closePortSockets(port: number): void {
    const active = this.sockets.get(port);
    if (!active) return;
    this.sockets.delete(port);
    for (const close of Array.from(active)) close();
  }

  /** Close every active host relay and open socket tunnel owned by this router. */
  close(): void {
    for (const port of Array.from(this.sockets.keys())) this.closePortSockets(port);
    for (const [port, host] of Array.from(this.hosts)) {
      this.hosts.delete(port);
      host.close();
    }
  }

  serves(port: number): boolean {
    return this.servers.has(port);
  }
  register(port: number, server: PreviewServer): void {
    if (this.servers.get(port) === server) return;
    const previous = this.hosts.get(port);
    this.hosts.delete(port);
    this.closePortSockets(port);
    this.servers.set(port, server);
    previous?.close();
  }
  unregister(port: number, server: PreviewServer): void {
    if (this.servers.get(port) !== server) return;
    this.servers.delete(port);
    const previous = this.hosts.get(port);
    this.hosts.delete(port);
    this.closePortSockets(port);
    previous?.close();
  }

  private connectSocket(port: number, reply: MessagePort): void {
    const pending: { message: PreviewReply; transfer: Transferable[] }[] = [];
    let ready = false;
    let finished = false;
    let missedPings = 0;
    let connection: PreviewConnection | null = null;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const send = (message: PreviewReply, transfer: Transferable[] = []) => {
      if (finished) return;
      if (!ready) {
        pending.push({ message, transfer });
        return;
      }
      try {
        reply.postMessage(message, transfer);
      } catch {
        closeTunnel();
      }
    };
    const onPeerClose = () => closeTunnel();
    let closing = false;
    const closeTunnel = (finalMessage?: PreviewReply) => {
      if (finished) return;
      if (finalMessage) {
        send(finalMessage);
        finished = true;
      }
      if (closing) return;
      closing = true;
      if (pingTimer !== undefined) {
        clearInterval(pingTimer);
        pingTimer = undefined;
      }
      this.sockets.get(port)?.delete(closeTunnel);
      reply.removeEventListener?.("close", onPeerClose);
      reply.onmessage = null;
      const activeConnection = connection;
      connection = null;
      try {
        activeConnection?.close();
      } catch {}
      finished = true;
      if (ready) reply.close();
    };
    reply.addEventListener?.("close", onPeerClose);
    reply.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!message || typeof message !== "object" || !("type" in message)) return;
      missedPings = 0;
      if (message.type === "ping") {
        send({ type: "pong" });
        return;
      }
      if (message.type === "pong") return;
      if (message.type === "end") {
        closeTunnel();
        return;
      }
      if (
        message.type === "data" &&
        "chunk" in message &&
        message.chunk instanceof Uint8Array &&
        connection
      ) {
        connection.write(message.chunk);
      }
    };
    connection =
      this.servers.get(port)?.connect(port, {
        data: (chunk) => send({ type: "data", chunk }, [chunk.buffer]),
        end: () => closeTunnel({ type: "end" }),
        error: (message) => closeTunnel({ type: "error", message }),
      }) ?? null;
    if (!connection) {
      ready = true;
      closeTunnel({ type: "error", message: "no server" });
      return;
    }
    let portSockets = this.sockets.get(port);
    if (!portSockets) {
      portSockets = new Set();
      this.sockets.set(port, portSockets);
    }
    portSockets.add(closeTunnel);
    ready = true;
    try {
      reply.postMessage({ type: "accepted" });
      for (const item of pending) reply.postMessage(item.message, item.transfer);
    } catch {
      pending.length = 0;
      closeTunnel();
      return;
    }
    pending.length = 0;
    if (finished) {
      reply.close();
      return;
    }
    const pingIntervalMs = this.options.socketPingIntervalMs ?? DEFAULT_SOCKET_PING_MS;
    const maxMissedPings = this.options.socketMissedPings ?? DEFAULT_SOCKET_MISSED_PINGS;
    if (pingIntervalMs > 0 && maxMissedPings > 0) {
      pingTimer = setInterval(() => {
        if (finished) return;
        if (missedPings >= maxMissedPings) {
          closeTunnel();
          return;
        }
        missedPings++;
        send({ type: "ping" });
      }, pingIntervalMs);
    }
  }

  onMessage(event: Pick<MessageEvent<PreviewMessage>, "data" | "ports">): void {
    const ask = event.data;
    const reply = event.ports[0];
    if (!reply || !ask) return;
    if (ask.type === "preview-socket-probe") {
      reply.postMessage({ type: this.servers.has(ask.port) ? "accepted" : "none" });
      reply.close();
      return;
    }
    if (ask.type === "preview-socket") {
      this.connectSocket(ask.port, reply);
      return;
    }
    if (ask.type !== "preview-request") return;
    const send = (msg: PreviewReply, transfer: Transferable[] = []) =>
      reply.postMessage(msg, transfer);
    let dispatched = false;
    let ended = false;
    const finish = (msg: PreviewReply) => {
      send(msg);
      ended = true;
      if (dispatched) reply.close();
    };
    const request = {
      method: ask.method,
      target: ask.target,
      headers: ask.headers,
      body: ask.body ? new Uint8Array(ask.body) : null,
    };
    const accepted = this.servers.get(ask.port)?.request(ask.port, request, {
      head: (head) => send({ type: "head", ...head }),
      data: (chunk) => send({ type: "data", chunk }, [chunk.buffer]),
      end: () => finish({ type: "end" }),
      error: (message) => finish({ type: "error", message }),
    });
    // A transport may finish synchronously; post acceptance before closing its port.
    send({ type: accepted ? "accepted" : "none" });
    dispatched = true;
    if (!accepted || ended) reply.close();
  }
}
