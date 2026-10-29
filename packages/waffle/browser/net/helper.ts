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
  OK,
  type SocketAddr,
  type TcpRequest,
} from "./protocol.js";
import {
  errnoOf,
  socketPathError,
  type HelperPaths,
  type SocketLease,
  type SocketScope,
} from "./unix-paths.js";
import { EBADF, ECANCELED, ENOBUFS, ENOTCAPABLE } from "./unix-status.js";
import { RingWriter } from "./ring.js";
import { TCP_INVALID } from "./tcp-status.js";
import {
  acceptedAddress,
  loopbackAddress,
  tcpAddress,
  lookupAddress,
  type RuntimeNetworkLookupOptions,
  type RuntimeNetworkLookupResult,
} from "./address.js";
import { NetNamespace, LoopbackSocket, tcpReply } from "./namespace.js";
export { NetNamespace } from "./namespace.js";

const encoder = new TextEncoder();
/** Hostnames that mean "this machine": fetches to them may reach the guest's own servers. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]);
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

type FetchRequest = NetRequest & { type: "fetch" };
type UnixRequest = TcpRequest & { type: "unix-listen" | "unix-connect" | "unix-close" };
interface PathBinding {
  scope: SocketScope;
  lease: SocketLease;
  unlink: boolean;
}
interface FetchResponse {
  head: FetchHead;
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  encodings: string[];
}
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

/** External network policy. Honor manual redirects and return already-decoded Fetch bodies. */
export type NetFetch = (url: string, options: RequestInit) => Promise<Response>;

/** The helper invokes the runtime's name policy on its responsive I/O thread. */
export type NetLookup = (
  hostname: string,
  options?: RuntimeNetworkLookupOptions,
) => RuntimeNetworkLookupResult[] | PromiseLike<RuntimeNetworkLookupResult[]>;

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
  private lookups = new Map<number, object>();
  private listeners = new Map<number, number>(); // listener handle -> port
  private sharedListeners = new Set<number>();
  private connections = new Map<number, ConnectionSink>();
  private nextConn = CONN_BASE;
  private disposed = false;
  private sockets = new Map<number, LoopbackSocket>();
  private pending = new Map<number, Set<number>>();
  private pathListeners = new Map<number, PathBinding>();
  /** Path requests in flight, by guest handle. Close or disposal drops the token. */
  private pathOperations = new Map<number, object>();
  private fileWrites: Promise<void> = Promise.resolve();

  constructor(
    sab: SharedArrayBuffer,
    private fetchRequest: NetFetch,
    private hooks: NetHelperHooks = {},
    private namespace = new NetNamespace(),
    private assertOwnerLive: () => void = () => {},
    private lookupRequest: NetLookup = lookupAddress,
    private paths?: HelperPaths,
  ) {
    this.ring = new RingWriter(sab);
  }

  handle(request: NetRequest): void {
    const req = snapshotRequest(request);
    if ("reply" in req) return this.tcp(req);
    if (!this.live()) return;
    switch (req.type) {
      case "lookup":
        void this.lookup(req);
        return;
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
        if (!this.claimed(req.id)) this.listen(req.id, req.port, req.host);
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
    const bindings = Array.from(this.pathListeners.values());
    this.pathListeners.clear();
    this.pathOperations.clear();
    this.sockets.clear();
    this.pending.clear();
    this.fetches.clear();
    this.lookups.clear();
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
    // The runtime owner retains and joins these; helper disposal itself stays synchronous.
    for (const { scope, lease, unlink } of bindings)
      attempt(() => void this.paths?.cleanup.unbind(scope, lease, unlink));
    attempt(() => this.paths?.retire());
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
    host?: string,
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
    connection = this.connect(
      port,
      {
        data: (bytes) => {
          parser.push(bytes);
          return delivered;
        },
        end: () => parser.end(),
        error: (message) => finish.error(message),
      },
      host,
    );
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
  connect(port: number, sink: ConnectionSink, host?: string): PreviewConnection | null {
    const captured: ConnectionSink = {
      data: sink.data.bind(sink),
      end: sink.end.bind(sink),
      error: sink.error.bind(sink),
    };
    const listener = this.listenerFor(port);
    if (!this.live()) return null;
    if (listener === undefined || this.sharedListeners.has(listener))
      return this.connectNamespace(port, captured, host);
    sink = captured;
    const bind = this.namespace.address(port);
    if (!bind) return null;
    const target = host === undefined ? loopbackAddress(bind) : tcpAddress(host);
    if (!target) return null;
    const address = acceptedAddress(bind, target);
    if (!address) return null;
    const local = { ...address, port };
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

  private connectNamespace(
    port: number,
    sink: ConnectionSink,
    host?: string,
  ): PreviewConnection | null {
    let socket: LoopbackSocket | undefined = undefined;
    const connected = this.namespace.connect(
      port,
      {
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
      },
      host,
    );
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

  private acceptSocket(
    listener: number,
    peer: SocketAddr,
    local: SocketAddr,
    socket: LoopbackSocket,
  ): void {
    const conn = this.nextConn++;
    this.sockets.set(conn, socket);
    this.pending.get(listener)?.add(conn);
    void this.ring.write(listener, Kind.Conn, json({ conn, peer, local } satisfies NewConn));
    socket.receive(this.socketSink(conn));
  }

  private tcp(req: TcpRequest): void {
    if (req.type === "unix-listen" || req.type === "unix-connect" || req.type === "unix-close")
      return this.unix(req);
    this.tcpReply(req);
  }

  private tcpReply(req: Exclude<TcpRequest, UnixRequest>): void {
    let result: [number, number] = [ERROR, 0];
    try {
      if (this.live()) result = this.executeTcp(req);
    } finally {
      tcpReply(req.reply, result[0], result[1]);
    }
  }

  /** The reply cell always completes: errors become ECANCELED rather than a stuck guest. */
  private unix(req: UnixRequest): void {
    let work: Promise<number>;
    try {
      work = this.executeUnix(req);
    } catch {
      work = Promise.resolve(ECANCELED);
    }
    void work.catch(errnoOf).then((errno) => tcpReply(req.reply, errno ? ERROR : OK, errno));
  }

  private executeUnix(req: UnixRequest): Promise<number> {
    if (req.type === "unix-close") return this.closeUnix(req.id);
    if (!this.live()) return Promise.resolve(ECANCELED);
    const invalid = socketPathError(req.path);
    if (invalid) return Promise.resolve(invalid);
    const paths = this.paths;
    if (!paths) return Promise.resolve(ENOTCAPABLE);
    if (this.claimed(req.id)) return Promise.resolve(EBADF);
    const release = paths.cleanup.admit();
    if (!release) return Promise.resolve(ENOBUFS);
    const operation = {};
    this.pathOperations.set(req.id, operation);
    return this.withScope(paths, req, operation).finally(() => {
      release();
      if (this.pathOperations.get(req.id) === operation) this.pathOperations.delete(req.id);
    });
  }

  /** Every allocating request checks this: a handle id names at most one listener, socket,
   * connection or pending path operation, so no request can overwrite another's resource. */
  private claimed(id: number): boolean {
    return (
      this.pathOperations.has(id) ||
      this.pathListeners.has(id) ||
      this.sockets.has(id) ||
      this.listeners.has(id) ||
      this.connections.has(id)
    );
  }

  /** The operation still owns its handle: not closed, not disposed. */
  private current(id: number, operation: object): boolean {
    return this.open() && this.pathOperations.get(id) === operation;
  }

  private closeUnix(id: number): Promise<number> {
    const closing = this.closePath(id);
    if (closing) return closing;
    return Promise.resolve(this.pathOperations.delete(id) ? 0 : EBADF);
  }

  private async withScope(
    paths: HelperPaths,
    req: UnixRequest & { type: "unix-listen" | "unix-connect" },
    operation: object,
  ): Promise<number> {
    const scope = await paths.scope();
    if (typeof scope === "number") return scope;
    if (!this.current(req.id, operation)) return ECANCELED;
    if (req.type === "unix-listen")
      return paths.cleanup.use(scope, () => this.listenPath(paths, scope, req, operation));
    return paths.cleanup.use(scope, () => this.connectPath(scope, req.id, req.path, operation));
  }

  private open(): boolean {
    try {
      return this.live();
    } catch {
      return false;
    }
  }

  private async listenPath(
    paths: HelperPaths,
    scope: SocketScope,
    req: UnixRequest & { type: "unix-listen" },
    operation: object,
  ): Promise<number> {
    if (!this.namespace.reservePathListener()) return ENOBUFS;
    let lease: SocketLease | number;
    try {
      lease = await scope.bind(req.path);
    } catch (error) {
      this.namespace.releasePathListener();
      throw error;
    }
    if (typeof lease === "number") {
      this.namespace.releasePathListener();
      return this.current(req.id, operation) ? lease : ECANCELED;
    }
    if (!this.current(req.id, operation)) {
      // Late bind after close or disposal: the node was never handed out; roll back by lease.
      this.namespace.releasePathListener();
      void paths.cleanup.unbind(scope, lease, true);
      return ECANCELED;
    }
    const id = req.id;
    const local: SocketAddr = { family: "Unix", path: lease.path };
    const bound = this.namespace.listenPath(lease.key, {
      owner: this,
      handle: id,
      pending: () => this.pending.get(id)?.size ?? 0,
      accept: (socket) => this.acceptSocket(id, { family: "Unix", path: null }, local, socket),
    });
    if (bound) {
      void paths.cleanup.unbind(scope, lease, true);
      return bound;
    }
    this.pathListeners.set(id, { scope, lease, unlink: req.unlinkOnClose });
    this.pending.set(id, new Set());
    return 0;
  }

  private async connectPath(
    scope: SocketScope,
    id: number,
    path: string,
    operation: object,
  ): Promise<number> {
    const key = await scope.target(path);
    if (!this.current(id, operation)) return ECANCELED;
    if (typeof key === "number") return key;
    const socket = this.namespace.connectPath(key, this.socketSink(id));
    if (typeof socket === "number") return socket;
    this.sockets.set(id, socket);
    return 0;
  }

  /** Stop routing at once; the unlink settles through the runtime-retained cleanup. */
  private closePath(id: number): Promise<number> | undefined {
    const binding = this.pathListeners.get(id);
    if (!binding || !this.paths) return undefined;
    this.pathListeners.delete(id);
    this.namespace.unlistenPath(this, id);
    for (const conn of this.pending.get(id) ?? []) this.close(conn);
    this.pending.delete(id);
    return this.paths.cleanup.unbind(binding.scope, binding.lease, binding.unlink);
  }

  private executeTcp(req: Exclude<TcpRequest, UnixRequest>): [number, number] {
    if (req.type !== "tcp-write" && this.claimed(req.id)) return [TCP_INVALID, 0];
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

  private async lookup(req: NetRequest & { type: "lookup" }): Promise<void> {
    const job = {};
    this.lookups.set(req.id, job);
    try {
      await Promise.resolve();
      if (!this.lookupLive(req.id, job)) return;
      const lookupRequest = this.lookupRequest;
      const results = await lookupRequest(req.hostname, req.options);
      if (!this.lookupLive(req.id, job)) return;
      const payload = json(results);
      if (payload.length === 0) throw new TypeError("Lookup result is not JSON serializable");
      await this.publishLookup(req.id, job, Kind.LookupHead, payload);
    } catch (error) {
      if (this.lookupLive(req.id, job))
        await this.publishLookup(req.id, job, Kind.Error, json(lookupError(error)));
    } finally {
      if (this.lookups.get(req.id) === job) this.lookups.delete(req.id);
    }
  }

  private async publishLookup(
    id: number,
    job: object,
    kind: typeof Kind.LookupHead | typeof Kind.Error,
    payload: Uint8Array,
  ): Promise<void> {
    for (let at = 0; at < payload.length; at += MAX_RECORD) {
      if (!this.lookupLive(id, job)) return;
      const end = Math.min(at + MAX_RECORD, payload.length);
      await this.ring.write(
        id,
        end === payload.length ? kind : Kind.Data,
        payload.subarray(at, end),
      );
    }
  }

  private lookupLive(id: number, job: object): boolean {
    if (this.disposed || this.lookups.get(id) !== job) return false;
    try {
      this.assertOwnerLive();
      return true;
    } catch {
      this.lookups.delete(id);
      return false;
    }
  }

  private async fetch(req: FetchRequest): Promise<void> {
    const job: FetchJob = { controller: new AbortController(), inFlight: 0, wake: null };
    this.fetches.set(req.id, job);
    try {
      const response = await this.followRedirects({ ...req, url: new URL(req.url).href }, job);
      if (!this.fetches.has(req.id)) {
        await response.body?.cancel();
        return;
      }
      await this.ring.write(req.id, Kind.Head, json(response.head));
      await this.pumpBody(req.id, job, decodedBody(response));
    } catch (err) {
      await this.failFetch(req.id, err);
    }
  }

  private async followRedirects(req: FetchRequest, job: FetchJob): Promise<FetchResponse> {
    for (let count = 0; ; count++) {
      job.controller.signal.throwIfAborted();
      const response = await this.fetchHop(req, job);
      response.head.redirected ||= count > 0;
      const location = response.head.headers.find(
        ([name]) => name.toLowerCase() === "location",
      )?.[1];
      if (!REDIRECT_STATUSES.has(response.head.status) || req.redirect === "manual")
        return response;
      if (req.redirect !== "error" && location === undefined) return response;
      await response.body?.cancel();
      if (req.redirect === "error") throw new TypeError("Fetch redirect mode is error");
      if (location === undefined) return response;
      if (count === 20) throw new TypeError("Fetch redirect limit exceeded");
      req = redirectRequest(req, response.head, location);
    }
  }

  private async fetchHop(req: FetchRequest, job: FetchJob): Promise<FetchResponse> {
    const port = this.loopbackPort(req.url);
    if (port !== undefined) return this.loopback(req, port, job.controller.signal);
    // Browser fetch can require its global receiver; do not bind it to this helper.
    const fetchRequest = this.fetchRequest;
    const response = await fetchRequest(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body as BodyInit | null,
      redirect: "manual",
      signal: job.controller.signal,
    });
    if (response.type === "opaqueredirect" && req.redirect !== "manual") {
      await response.body?.cancel();
      throw new TypeError("Network policy hides the redirect destination");
    }
    return {
      head: {
        status: response.status,
        statusText: response.statusText,
        url: response.url || req.url,
        redirected: response.redirected,
        headers: Array.from(response.headers),
      },
      body: response.body,
      encodings: [],
    };
  }

  private async pumpBody(
    id: number,
    job: FetchJob,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<void> {
    const reader = body?.getReader();
    const cancel = () => {
      void reader?.cancel().catch(() => {});
    };
    job.controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        if (!reader) break;
        await this.waitForWindow(id, job);
        if (!this.fetches.has(id)) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (!this.fetches.has(id)) return;
        await this.pumpChunk(id, job, value);
      }
    } catch (err) {
      await this.failFetch(id, err);
      return;
    } finally {
      job.controller.signal.removeEventListener("abort", cancel);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
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

  /** Adapt a virtual HTTP response to a bounded stream without publishing an intermediate head. */
  private loopback(req: FetchRequest, port: number, signal: AbortSignal): Promise<FetchResponse> {
    const result = Promise.withResolvers<FetchResponse>();
    const stream = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>();
    const writer = stream.writable.getWriter();
    const url = new URL(req.url);
    let connection: PreviewConnection | null = null;
    let sending = Promise.resolve();
    const close = () => {
      signal.removeEventListener("abort", abort);
      connection?.close();
    };
    const fail = (error: unknown) => {
      result.reject(error);
      void sending.then(() => writer.abort(error)).catch(() => {});
      close();
    };
    const abort = () => fail(signal.reason);
    // Cancelling a redirect body must close its virtual peer even if the server never ends it.
    void writer.closed.catch(close);
    connection = this.requestConnection(
      port,
      {
        method: req.method,
        target: url.pathname + url.search,
        headers: req.headers,
        body: req.body,
      },
      {
        head: (head) =>
          result.resolve({
            head: { ...head, url: req.url, redirected: false },
            body: stream.readable,
            encodings:
              req.method === "HEAD" || head.status === 204 || head.status === 304
                ? []
                : head.headers
                    .filter(([name]) => name === "content-encoding")
                    .flatMap(([, value]) => value.split(","))
                    .map((value) => value.trim().toLowerCase())
                    .filter((value) => value !== "identity"),
          }),
        data: (chunk) => {
          sending = sending.then(() => writer.write(chunk));
          return sending.catch(close);
        },
        end: () => {
          close();
          void sending.then(() => writer.close()).catch(() => {});
        },
        error: (message) => fail(new TypeError(message)),
      },
      url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
    );
    if (!connection) fail(new TypeError(`connect ECONNREFUSED ${url.host}`));
    else signal.addEventListener("abort", abort, { once: true });
    return result.promise;
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
    const job = this.fetches.get(id)!;
    this.fetches.delete(id);
    job.controller.abort();
    job.wake?.();
    // Pass the engine's own wording through ("Failed to fetch" in Chromium, "Load failed" in WebKit).
    const error: NetError =
      err instanceof Error
        ? { name: err.name || "TypeError", message: err.message }
        : { name: "TypeError", message: String(err) };
    await this.ring.write(id, Kind.Error, json(error));
  }

  // ---------- listeners and connections ----------

  private close(id: number): void {
    if (this.lookups.delete(id)) return;
    if (this.pathOperations.delete(id)) return;
    if (this.closePath(id)) return;
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
    case "lookup": {
      const hostname = req.hostname;
      const options = req.options;
      return { type, id, hostname, options: { family: options.family, hints: options.hints } };
    }
    case "tcp-listen":
      return { type, id, reply: req.reply, port: req.port, host: req.host };
    case "tcp-connect":
      return { type, id, reply: req.reply, port: req.port, host: req.host };
    case "tcp-write":
      return { type, id, reply: req.reply, data: req.data };
    case "unix-listen":
      return {
        type,
        id,
        reply: req.reply,
        path: req.path,
        unlinkOnClose: req.unlinkOnClose !== false,
      };
    case "unix-connect":
      return { type, id, reply: req.reply, path: req.path };
    case "unix-close":
      return { type, id, reply: req.reply };
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

function lookupError(error: unknown): NetError {
  try {
    return inspectLookupError(error);
  } catch {
    return { name: "Error", message: "Lookup failed" };
  }
}

function inspectLookupError(error: unknown): NetError {
  if (!error || typeof error !== "object") return { name: "Error", message: String(error) };
  const name = "name" in error ? error.name : undefined;
  const message = "message" in error ? error.message : undefined;
  const code = "code" in error ? error.code : undefined;
  const syscall = "syscall" in error ? error.syscall : undefined;
  const hostname = "hostname" in error ? error.hostname : undefined;
  return {
    name: typeof name === "string" ? name : "Error",
    message: typeof message === "string" ? message : String(error),
    code: typeof code === "string" ? code : undefined,
    syscall: typeof syscall === "string" ? syscall : undefined,
    hostname: typeof hostname === "string" ? hostname : undefined,
  };
}

function redirectRequest(req: FetchRequest, head: FetchHead, location: string): FetchRequest {
  const previous = new URL(req.url);
  const url = new URL(location, head.url);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("Fetch redirect requires HTTP or HTTPS");
  if (url.username || url.password) throw new TypeError("Fetch redirect contains credentials");
  if (!location.includes("#")) url.hash = previous.hash;
  const headers = new Headers(req.headers);
  if (url.origin !== previous.origin) {
    headers.delete("authorization");
    headers.delete("proxy-authorization");
    headers.delete("cookie");
    headers.delete("cookie2");
  }
  const discardBody =
    ((head.status === 301 || head.status === 302) && req.method === "POST") ||
    (head.status === 303 && req.method !== "GET" && req.method !== "HEAD");
  if (!discardBody) return { ...req, url: url.href, headers: Array.from(headers) };
  for (const name of [
    "content-encoding",
    "content-language",
    "content-location",
    "content-type",
    "content-length",
  ])
    headers.delete(name);
  return { ...req, url: url.href, method: "GET", body: null, headers: Array.from(headers) };
}

function decodedBody(response: FetchResponse): ReadableStream<Uint8Array<ArrayBuffer>> | null {
  if (!response.body || response.encodings.length === 0) return response.body;
  try {
    const decoders = response.encodings.toReversed().map(contentDecoder);
    return decoders.reduce((body, decoder) => {
      void body.pipeTo(decoder.writable).catch(() => {});
      return decoder.readable;
    }, response.body);
  } catch (error) {
    void response.body.cancel().catch(() => {});
    throw error;
  }
}

function contentDecoder(encoding: string): DecompressionStream {
  const format = encoding === "br" ? "brotli" : encoding === "x-gzip" ? "gzip" : encoding;
  if (!["gzip", "deflate", "brotli", "zstd"].includes(format))
    throw new TypeError(`Unsupported content encoding: ${encoding}`);
  // Browser codec support varies. Construction rejects unsupported codecs before any body read.
  const decoder: unknown = Reflect.construct(DecompressionStream, [format]);
  if (!(decoder instanceof DecompressionStream)) throw new TypeError("Invalid content decoder");
  return decoder;
}
