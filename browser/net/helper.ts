// The I/O side of the networking bridge. One NetHelper per guest worker. It lives on a thread
// that has an event loop, receives the
// worker's NetRequests, performs real `fetch`es, runs virtual preview connections, and writes every
// result into the worker's ring.

import {
  type ResponseHead,
  type ResponseSink,
  ResponseParser,
  type PreviewRequest,
  serializeRequest,
} from "./http1.js";
import {
  CONN_BASE,
  AGAIN,
  FETCH_WINDOW,
  type FetchHead,
  Kind,
  MAX_RECORD,
  type NetError,
  type NetRequest,
  type NewConn,
  ERROR,
  UNSUPPORTED,
  type PeerAddr,
  type TcpRequest,
} from "./protocol.js";
import { RingWriter } from "./ring.js";
import { loopbackAddress, tcpAddress } from "./address.js";
import { NetNamespace, LoopbackSocket, tcpReply } from "./namespace.js";
export { NetNamespace } from "./namespace.js";

const encoder = new TextEncoder();
/** Hostnames that mean "this machine": fetches to them may reach the guest's own servers. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]);
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

interface FetchJob {
  controller: AbortController;
  /** Body bytes sent minus bytes the guest has read. */
  inFlight: number;
  /** Resolves a pump waiting for the guest to catch up. */
  wake: (() => void) | null;
}

/** Raw duplex stream for upgraded preview connections, including WebSockets. */
export interface PreviewConnection {
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface ConnectionSink {
  /** Completion releases receive credit; an omitted receipt means synchronous consumption. */
  data(bytes: Uint8Array): void | Promise<void>;
  end(): void;
  error(message: string): void;
}

/** The application supplies its network policy (plain fetch, caching, authentication, etc.). */
export type NetFetch = (url: string, options: RequestInit) => Promise<Response>;

export interface NetHelperHooks {
  /** A guest server started listening on `port`. */
  listening?(port: number, host: string): void;
  /** That server stopped (closed, or its worker ended). */
  stopped?(port: number): void;
}

/** Streams a preview response back to whoever asked (the service worker, a test). */
export type PreviewSink = ResponseSink;

export class NetHelper {
  private ring: RingWriter;
  private fetches = new Map<number, FetchJob>();
  private listeners = new Map<number, number>(); // listener handle -> port
  private sharedListeners = new Set<number>();
  private connections = new Map<number, ConnectionSink>();
  private nextConn = CONN_BASE;
  private disposed = false;
  private sockets = new Map<number, LoopbackSocket>();
  private pending = new Map<number, Set<number>>();
  private fileWrites: Promise<void> = Promise.resolve();

  constructor(
    sab: SharedArrayBuffer,
    private fetchRequest: NetFetch,
    private hooks: NetHelperHooks = {},
    private namespace = new NetNamespace(),
    private assertOwnerLive: () => void = () => {},
  ) {
    this.ring = new RingWriter(sab);
  }

  handle(request: NetRequest): void {
    const req = snapshotRequest(request);
    if ("reply" in req) return this.tcp(req);
    if (!this.live()) return;
    switch (req.type) {
      case "fetch":
        void this.fetch(req);
        return;
      case "ack":
        this.ack(req.id, req.bytes);
        return;
      case "close":
        this.close(req.id);
        return;
      case "listen":
        this.listen(req.id, req.port, req.host);
        return;
      case "tcp-accept":
        this.pending.get(req.listener)?.delete(req.id);
        return;
      case "tcp-read":
        this.sockets.get(req.id)?.consumed(req.bytes);
        return;
      case "shutdown":
        if (this.sockets.has(req.id)) this.sockets.get(req.id)!.shutdown();
        else this.close(req.id);
        return;
      case "write":
        this.connections.get(req.id)?.data(req.data);
        return;
    }
  }

  /** The worker ended: abort fetches, fail open preview requests, forget listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ring.dispose();
    this.namespace.release(this);
    const sockets = Array.from(this.sockets.values());
    const fetches = Array.from(this.fetches.values());
    const connections = Array.from(this.connections.values());
    const ports = Array.from(this.listeners.values());
    this.sockets.clear();
    this.pending.clear();
    this.fetches.clear();
    this.connections.clear();
    this.listeners.clear();
    this.sharedListeners.clear();
    const failures: unknown[] = [];
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    for (const socket of sockets) attempt(() => socket.close());
    for (const job of fetches) {
      attempt(() => job.controller.abort());
      job.wake?.();
    }
    for (const conn of connections) attempt(() => conn.error("the server stopped"));
    for (const port of ports) attempt(() => this.hooks.stopped?.(port));
    if (failures.length) throw new AggregateError(failures, "Network helper disposal failed");
  }

  /** The listener handle for `port`, if this worker is serving it. */
  listenerFor(port: number): number | undefined {
    for (const [id, p] of this.listeners) if (p === port) return id;
    return undefined;
  }

  /**
   * Delivers `req` to the guest server on `port` as a new connection and streams the parsed response
   * into `sink`. Returns false when nothing listens there.
   */
  request(port: number, req: PreviewRequest, sink: PreviewSink): boolean {
    return this.requestConnection(port, req, sink) !== null;
  }

  private requestConnection(
    port: number,
    req: PreviewRequest,
    sink: PreviewSink,
  ): PreviewConnection | null {
    const captured = {
      method: req.method,
      target: req.target,
      headers: req.headers,
      body: req.body,
    };
    const request = serializeRequest(captured, `localhost:${port}`);
    const isHead = captured.method === "HEAD";
    const sinkHead = sink.head.bind(sink),
      data = sink.data.bind(sink);
    const end = sink.end.bind(sink),
      error = sink.error.bind(sink);
    let delivered: Promise<void> | undefined;
    let connection: PreviewConnection | null = null;
    const finish: PreviewSink = {
      head: (head: ResponseHead) => sinkHead(head),
      data: (chunk) => {
        const receipt = data(chunk);
        if (receipt) delivered = Promise.all([delivered, receipt]).then(() => {});
      },
      end: () => {
        connection?.close();
        end();
      },
      error: (message) => {
        connection?.close();
        error(message);
      },
    };
    const parser = new ResponseParser(finish, isHead);
    connection = this.connect(port, {
      data: (bytes) => {
        parser.push(bytes);
        return delivered;
      },
      end: () => parser.end(),
      error: (message) => finish.error(message),
    });
    if (!connection) return null;
    connection.write(request);
    return connection;
  }

  /** Wake a running guest after a shared-filesystem write has completed. No bytes are reapplied:
   * an older notification must not overwrite a newer save already visible to the guest.
   */
  notifyFileChanged(path: string): Promise<void> {
    if (!path.startsWith("/") || path.includes("\0"))
      return Promise.reject(new TypeError("Expected an absolute guest path"));
    this.fileWrites = this.fileWrites.then(async () => {
      if (this.disposed) throw new Error("The server stopped");
      await this.ring.write(0, Kind.FileChanged, json({ path }));
      if (this.disposed) throw new Error("The server stopped");
    });
    return this.fileWrites;
  }

  /** Replace a running worker's file, even while wasm blocks its event loop. For callers that
   * have not already written to its shared filesystem; editor saves use notifyFileChanged instead.
   */
  changeFile(path: string, contents: string | Uint8Array): Promise<void> {
    if (!path.startsWith("/") || path.includes("\0"))
      return Promise.reject(new TypeError("Expected an absolute guest path"));
    const bytes = typeof contents === "string" ? encoder.encode(contents) : contents.slice();
    this.fileWrites = this.fileWrites.then(() => this.sendFile(path, bytes));
    return this.fileWrites;
  }

  private async sendFile(path: string, bytes: Uint8Array): Promise<void> {
    if (this.disposed) throw new Error("The server stopped");
    await this.ring.write(0, Kind.FileStart, json({ path, length: bytes.length }));
    for (let at = 0; at < bytes.length; at += MAX_RECORD) {
      if (this.disposed) throw new Error("The server stopped");
      await this.ring.write(0, Kind.FileData, bytes.subarray(at, at + MAX_RECORD));
    }
    if (this.disposed) throw new Error("The server stopped");
    await this.ring.write(0, Kind.FileEnd);
  }

  /** Connects a host-side byte stream to the guest without HTTP response framing. */
  connect(port: number, sink: ConnectionSink): PreviewConnection | null {
    const captured: ConnectionSink = {
      data: sink.data.bind(sink),
      end: sink.end.bind(sink),
      error: sink.error.bind(sink),
    };
    const listener = this.listenerFor(port);
    if (!this.live()) return null;
    if (listener === undefined || this.sharedListeners.has(listener))
      return this.connectNamespace(port, captured);
    sink = captured;
    const bind = this.namespace.address(port);
    if (!bind) return null;
    const local = { ...loopbackAddress(bind), port };
    const conn = this.nextConn++;
    this.connections.set(conn, sink);
    this.pending.get(listener)?.add(conn);
    const announce: NewConn = {
      conn,
      peer: { ...local, port: 40000 + (conn % 20000) },
      local,
    };
    let sending = this.ring.write(listener, Kind.Conn, json(announce));
    return {
      write: (bytes) => {
        if (!this.connections.has(conn)) return;
        const owned = bytes.slice();
        sending = sending.then(() => this.writeChunks(conn, owned));
      },
      close: () => {
        if (!this.connections.delete(conn)) return;
        sending = sending.then(() => this.ring.write(conn, Kind.End));
      },
    };
  }

  private connectNamespace(port: number, sink: ConnectionSink): PreviewConnection | null {
    let socket: LoopbackSocket | undefined = undefined;
    const connected = this.namespace.connect(port, {
      data: (bytes) => {
        const receipt = sink.data(bytes);
        if (!receipt) socket?.consumed(bytes.length);
        else
          void receipt.then(
            () => socket?.consumed(bytes.length),
            (error: unknown) => {
              socket?.close();
              sink.error(String(error));
            },
          );
      },
      end: () => sink.end(),
    });
    if (typeof connected === "number") return null;
    const id = this.nextConn++;
    socket = connected.socket;
    this.sockets.set(id, socket);
    this.connections.set(id, sink);
    const ownedSocket = socket;
    let live = true;
    let sending = Promise.resolve();
    return {
      write: (bytes) => {
        const owned = bytes.slice();
        sending = sending.then(() =>
          this.sendSocket(ownedSocket, owned, () => live && !this.disposed, sink),
        );
      },
      close: () => {
        live = false;
        this.sockets.delete(id);
        this.connections.delete(id);
        ownedSocket.close();
      },
    };
  }

  private async sendSocket(
    socket: LoopbackSocket,
    bytes: Uint8Array,
    live: () => boolean,
    sink: ConnectionSink,
  ): Promise<void> {
    let at = 0;
    while (live() && at < bytes.length) {
      const count = socket.write(bytes.subarray(at));
      if (count === AGAIN) {
        await socket.writable();
        continue;
      }
      if (count < 0) {
        sink.error("the server stopped");
        return;
      }
      at += count;
    }
  }

  private live(): boolean {
    this.assertOwnerLive();
    return !this.disposed;
  }

  private listen(id: number, port: number, host: string, shared = false): number {
    const listening = this.hooks.listening;
    if (!this.live()) return ERROR;
    const address = tcpAddress(host);
    if (!address) return UNSUPPORTED;
    const bound = this.namespace.listen(port, {
      owner: this,
      handle: id,
      local: { ...address, port },
      accept: (peer, local, socket) => this.acceptSocket(id, peer, local, socket),
    });
    if (bound < 0) return bound;
    this.listeners.set(id, bound);
    this.pending.set(id, new Set());
    if (shared) this.sharedListeners.add(id);
    try {
      listening?.call(this.hooks, bound, host);
      if (this.live()) return bound;
    } catch (error) {
      this.close(id);
      throw error;
    }
    this.close(id);
    return ERROR;
  }

  private socketSink(id: number) {
    let sending = Promise.resolve();
    return {
      data: (bytes: Uint8Array) => {
        sending = sending.then(() => this.writeChunks(id, bytes));
      },
      end: () => {
        sending = sending.then(() => this.ring.write(id, Kind.End));
      },
      writable: () => {
        void this.ring.write(id, Kind.Writable);
      },
    };
  }

  private acceptSocket(listener: number, peer: PeerAddr, local: PeerAddr, socket: LoopbackSocket): void {
    const conn = this.nextConn++;
    this.sockets.set(conn, socket);
    this.pending.get(listener)?.add(conn);
    void this.ring.write(listener, Kind.Conn, json({ conn, peer, local } satisfies NewConn));
    socket.receive(this.socketSink(conn));
  }

  private tcp(req: TcpRequest): void {
    let result: [number, number] = [ERROR, 0];
    try {
      if (this.live()) result = this.executeTcp(req);
    } finally {
      tcpReply(req.reply, result[0], result[1]);
    }
  }

  private executeTcp(req: TcpRequest): [number, number] {
    if (req.type === "tcp-listen") {
      const port = this.listen(req.id, req.port, req.host, true);
      return [port < 0 ? port : 0, port];
    }
    if (req.type === "tcp-write") {
      const socket = this.sockets.get(req.id);
      if (socket) return [socket.write(req.data), 0];
      const sink = this.connections.get(req.id);
      if (!sink) return [ERROR, 0];
      sink.data(req.data);
      return [req.data.length, 0];
    }
    if (!this.live()) return [ERROR, 0];
    const connected = this.namespace.connect(req.port, this.socketSink(req.id), req.host);
    if (typeof connected === "number") return [connected, 0];
    this.sockets.set(req.id, connected.socket);
    return [0, connected.port];
  }

  // ---------- fetch ----------

  private async fetch(req: NetRequest & { type: "fetch" }): Promise<void> {
    const job: FetchJob = { controller: new AbortController(), inFlight: 0, wake: null };
    this.fetches.set(req.id, job);
    const port = this.loopbackPort(req.url);
    if (port !== undefined) {
      this.loopback(req, port);
      return;
    }
    let response: Response;
    try {
      // Browser fetch can require its global receiver; do not bind it to this helper.
      const fetchRequest = this.fetchRequest;
      response = await fetchRequest(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body as BodyInit | null,
        redirect: req.redirect,
        signal: job.controller.signal,
      });
    } catch (err) {
      await this.failFetch(req.id, err);
      return;
    }
    if (!this.fetches.has(req.id)) return;
    const head: FetchHead = {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      redirected: response.redirected,
      headers: Array.from(response.headers),
    };
    await this.ring.write(req.id, Kind.Head, json(head));
    await this.pumpBody(req.id, job, response.body);
  }

  private async pumpBody(
    id: number,
    job: FetchJob,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<void> {
    const reader = body?.getReader();
    try {
      for (;;) {
        if (!reader) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (!this.fetches.has(id)) return;
        await this.pumpChunk(id, job, value);
      }
    } catch (err) {
      await this.failFetch(id, err);
      return;
    }
    if (!this.fetches.has(id)) return;
    this.fetches.delete(id);
    await this.ring.write(id, Kind.End);
  }

  private async pumpChunk(id: number, job: FetchJob, value: Uint8Array): Promise<void> {
    for (let at = 0; at < value.length; at += MAX_RECORD) {
      const piece = value.subarray(at, at + MAX_RECORD);
      await this.waitForWindow(id, job);
      if (!this.fetches.has(id)) return;
      job.inFlight += piece.length;
      await this.ring.write(id, Kind.Data, piece);
    }
  }

  /** The port when `url` addresses one of this worker's own servers (http://localhost:<port>/…). */
  private loopbackPort(url: string): number | undefined {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || !LOOPBACK.has(parsed.hostname)) return undefined;
    const port = Number(parsed.port || 80);
    return this.namespace.has(port) ? port : undefined;
  }

  /**
   * A fetch to the guest's own server, over a virtual connection: the page's network can't reach
   * it. (Redirects are not followed; the response comes back as the server sent it.)
   */
  private loopback(req: NetRequest & { type: "fetch" }, port: number): void {
    const id = req.id;
    const job = this.fetches.get(id)!;
    const live = () => this.fetches.get(id) === job;
    // Queue whole response operations, not individual ring records: splitting a large data
    // chunk must finish before the next chunk or terminal record can overtake it.
    let sending: Promise<void> = Promise.resolve();
    const enqueue = (operation: () => Promise<void>) => {
      sending = sending.then(() => (live() ? operation() : undefined));
      return sending;
    };
    const finish = (kind: number, payload?: Uint8Array) =>
      enqueue(async () => {
        await this.ring.write(id, kind, payload);
        if (live()) this.fetches.delete(id);
      });
    const url = new URL(req.url);
    const connection = this.requestConnection(
      port,
      {
        method: req.method,
        target: url.pathname + url.search,
        headers: req.headers,
        body: req.body,
      },
      {
        head: (head) => {
          const payload = json({ ...head, url: req.url, redirected: false } satisfies FetchHead);
          enqueue(() => this.ring.write(id, Kind.Head, payload));
        },
        data: (chunk) => {
          const owned = chunk.slice();
          return enqueue(() => this.pumpChunk(id, job, owned));
        },
        end: () => finish(Kind.End),
        error: (message) =>
          finish(Kind.Error, json({ name: "TypeError", message } satisfies NetError)),
      },
    );
    // A cancelled fetch owns the other end of this virtual connection, not just its job entry.
    job.controller.signal.addEventListener("abort", () => connection?.close(), { once: true });
  }

  /** Backpressure: don't send more than FETCH_WINDOW bytes ahead of what the guest has read. */
  private async waitForWindow(id: number, job: FetchJob): Promise<void> {
    while (job.inFlight >= FETCH_WINDOW && this.fetches.has(id)) {
      await new Promise<void>((resolve) => (job.wake = resolve));
    }
  }

  private ack(id: number, bytes: number): void {
    const job = this.fetches.get(id);
    if (!job) return;
    job.inFlight -= bytes;
    const wake = job.wake;
    job.wake = null;
    wake?.();
  }

  private async failFetch(id: number, err: unknown): Promise<void> {
    if (!this.fetches.has(id)) return; // closed by the guest: the abort is expected
    this.fetches.delete(id);
    // Pass the engine's own wording through ("Failed to fetch" in Chromium, "Load failed" in WebKit).
    const error: NetError =
      err instanceof Error
        ? { name: err.name || "TypeError", message: err.message }
        : { name: "TypeError", message: String(err) };
    await this.ring.write(id, Kind.Error, json(error));
  }

  // ---------- listeners and connections ----------

  private close(id: number): void {
    const socket = this.sockets.get(id);
    if (socket) {
      this.sockets.delete(id);
      socket.close();
      return;
    }
    const job = this.fetches.get(id);
    if (job) {
      this.fetches.delete(id);
      job.controller.abort();
      job.wake?.();
      return;
    }
    const port = this.listeners.get(id);
    if (port !== undefined) {
      this.listeners.delete(id);
      this.sharedListeners.delete(id);
      this.namespace.unlisten(this, id);
      for (const conn of this.pending.get(id) ?? []) this.close(conn);
      this.pending.delete(id);
      this.hooks.stopped?.(port);
      return;
    }
    const conn = this.connections.get(id);
    if (conn) {
      this.connections.delete(id);
      conn.end();
    }
  }

  /** Data records for `bytes`, split to fit the ring's record size. */
  private async writeChunks(
    handle: number,
    bytes: Uint8Array,
    live?: () => boolean,
  ): Promise<void> {
    for (let at = 0; at < bytes.length; at += MAX_RECORD) {
      if (live && !live()) return;
      await this.ring.write(handle, Kind.Data, bytes.subarray(at, at + MAX_RECORD));
    }
  }
}

/** Read caller accessors once, before the final admission check or any allocation. */
function snapshotRequest(req: NetRequest): NetRequest {
  const type = req.type,
    id = req.id;
  switch (type) {
    case "tcp-listen":
      return { type, id, reply: req.reply, port: req.port, host: req.host };
    case "tcp-connect":
      return { type, id, reply: req.reply, port: req.port, host: req.host };
    case "tcp-write":
      return { type, id, reply: req.reply, data: req.data };
    case "listen":
      return { type, id, port: req.port, host: req.host };
    case "fetch":
      return {
        type,
        id,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        redirect: req.redirect,
      };
    case "write":
      return { type, id, data: req.data };
    case "tcp-accept":
      return { type, id, listener: req.listener };
    case "ack":
    case "tcp-read":
      return { type, id, bytes: req.bytes };
    case "close":
    case "shutdown":
      return { type, id };
  }
}
