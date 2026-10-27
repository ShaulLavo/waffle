import type { ConnectionSink, PreviewConnection, PreviewSink } from "./net/helper.js";
import type { PreviewRequest } from "./net/http1.js";
import type { PreviewMessage, PreviewReply } from "./preview-protocol.js";
import type { PreviewHostOptions, PreviewHostRelay } from "./preview-host.js";

/** A server transport, independent of the guest engine or worker owning it. */
export interface PreviewServer {
  request(port: number, request: PreviewRequest, sink: PreviewSink): boolean;
  connect(port: number, sink: ConnectionSink): PreviewConnection | null;
}

interface MountPreviewOptions {
  baseURL: string;
  /** Consumer-owned mount directory, relative to baseURL (without a trailing slash). */
  prefix: string;
}

export type PreviewOptions =
  | MountPreviewOptions
  | { mode: "root"; originForPort(port: number): string };

/** Page-side request/socket routing. The consumer owns service-worker registration. */
export class PreviewRouter {
  private servers = new Map<number, PreviewServer>();
  private hosts = new Map<number, PreviewHostRelay>();
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
      binding,
    );
    for (const [port, other] of this.hosts) {
      if (port === binding.port || other.closed || other.origin !== host.origin) continue;
      host.close();
      throw new Error("Preview origin is already bound to another virtual port");
    }
    this.hosts.get(binding.port)?.close();
    this.hosts.set(binding.port, host);
    return host;
  }

  serves(port: number): boolean {
    return this.servers.has(port);
  }
  register(port: number, server: PreviewServer): void {
    this.servers.set(port, server);
  }
  unregister(port: number, server: PreviewServer): void {
    if (this.servers.get(port) !== server) return;
    this.servers.delete(port);
    this.hosts.get(port)?.close();
    this.hosts.delete(port);
  }

  private connectSocket(port: number, reply: MessagePort): void {
    const pending: { message: PreviewReply; transfer: Transferable[] }[] = [];
    let ready = false;
    let finished = false;
    let connection: PreviewConnection | null = null;
    const send = (message: PreviewReply, transfer: Transferable[] = []) => {
      if (finished) return;
      if (!ready) {
        pending.push({ message, transfer });
        return;
      }
      reply.postMessage(message, transfer);
    };
    const finish = (message: PreviewReply) => {
      send(message);
      finished = true;
      if (ready) reply.close();
    };
    reply.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!message || typeof message !== "object" || !("type" in message) || !connection) return;
      if (message.type === "data" && "chunk" in message && message.chunk instanceof Uint8Array)
        connection.write(message.chunk);
      if (message.type === "end") {
        connection.close();
        reply.close();
      }
    };
    connection =
      this.servers.get(port)?.connect(port, {
        data: (chunk) => send({ type: "data", chunk }, [chunk.buffer]),
        end: () => finish({ type: "end" }),
        error: (message) => finish({ type: "error", message }),
      }) ?? null;
    if (!connection) {
      ready = true;
      finish({ type: "error", message: "no server" });
      return;
    }
    ready = true;
    reply.postMessage({ type: "accepted" });
    for (const item of pending) reply.postMessage(item.message, item.transfer);
    pending.length = 0;
    if (finished) reply.close();
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
