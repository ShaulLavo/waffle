import { TCP_IN_USE, TCP_REFUSED, TCP_PIPE, TCP_INVALID, TCP_RESET } from "./tcp-status.js";
import { AGAIN, ERROR, UNSUPPORTED, type PeerAddr } from "./protocol.js";
import {
  loadBufferNetworkModule,
  NetworkOwnerFailure,
  type BufferNetworkModule as NetworkModule,
} from "./buffer-module.js";
import { tcpAddress } from "./address.js";
import { ECONNREFUSED, EADDRINUSE, ENOBUFS } from "./unix-status.js";

// Keep module evaluation synchronous. A suspended network compile can expose uninitialized
// class bindings to concurrent dynamic imports on affected module loaders.
let compilation: ReturnType<typeof loadBufferNetworkModule> | undefined;
export interface SocketSink {
  data(bytes: Uint8Array): void;
  end(): void;
  writable?(): void;
  /** The network module failed: bytes not yet delivered are lost. Called at most once. */
  reset?(): void;
}
/** Runs a module operation; a terminal failure retires the namespace and yields `failed`. */
type Guard = <T>(operation: () => T, failed: T) => T;
type Listener = {
  owner: object;
  handle: number;
  local: PeerAddr;
  accept(peer: PeerAddr, local: PeerAddr, socket: LoopbackSocket): void;
};
/** Backend node identity of a socket, scoped by the root of the path scope that reached it. */
export interface SocketKey {
  readonly rootIno: number;
  readonly ino: number;
}
export interface PathListener {
  owner: object;
  handle: number;
  /** Connections announced to the guest and not accepted yet. */
  pending(): number;
  accept(socket: LoopbackSocket): void;
}
/** Runtime-wide caps shared by pathname and abstract sockets. Unaccepted connections count as
 * pairs. */
const PATH_LISTENERS = 128;
const PATH_PAIRS = 128;
const PATH_BACKLOG = 64;
const bindingKey = (key: SocketKey) => `${key.rootIno}:${key.ino}`;
function status(value: number): number {
  switch (value) {
    case -1:
      return AGAIN;
    case -2:
      return TCP_INVALID;
    case -3:
      return TCP_IN_USE;
    case -5:
      return TCP_REFUSED;
    case -6:
      return TCP_PIPE;
    case -10:
      return UNSUPPORTED;
    default:
      return value < 0 ? ERROR : value;
  }
}
function kind(local: Omit<PeerAddr, "port">): number {
  if (local.family === "IPv4") return local.address === "0.0.0.0" ? 40 : 4;
  return local.address === "::" ? 60 : 6;
}
function target(host: string | undefined, local: PeerAddr): number {
  if (host === undefined) return local.family === "IPv4" ? 4 : 6;
  const address = tcpAddress(host);
  if (!address) return 0;
  return address.family === "IPv4" ? 4 : 6;
}
function address(bytes: Uint8Array): PeerAddr {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const v4 = data.getUint32(0, true) === 4;
  const mapped = !v4 && bytes[18] === 255 && bytes[19] === 255;
  return {
    address: v4 ? "127.0.0.1" : mapped ? "::ffff:127.0.0.1" : "::1",
    family: v4 ? "IPv4" : "IPv6",
    port: data.getUint32(4, true),
  };
}
/** Event/ring edge only. Rust owns bytes, credit, half-close and token validity. */
export class LoopbackSocket {
  private peer: LoopbackSocket | null = null;
  private sink: SocketSink | null = null;
  private closed = false;
  private ended = false;
  /** Set once by a terminal module failure. The socket then never calls the module. */
  private failed = false;
  private writers = new Set<() => void>();
  constructor(
    private module: NetworkModule,
    private id: number,
    private release: () => void,
    private guard: Guard,
    private reset: (sink: SocketSink) => void,
  ) {}
  pair(peer: LoopbackSocket): void {
    this.peer = peer;
  }
  receive(sink: SocketSink): void {
    if (this.failed) return this.reset(sink);
    this.sink = sink;
    this.drain();
  }
  private take(): Uint8Array | number {
    return this.guard(() => this.module.read("net_take", this.id, this.module.capacity), 0);
  }
  private drain(): void {
    if (this.closed || this.failed || !this.sink) return;
    for (;;) {
      const bytes = this.take();
      if (typeof bytes === "number" || bytes.length === 0) break;
      this.sink.data(bytes);
      if (this.closed || !this.sink) return;
    }
    if (this.failed || this.ended) return;
    if (!this.guard(() => this.module.call("net_ended", this.id), 0)) return;
    this.ended = true;
    this.sink.end();
  }
  /** Module failure: a reset, not an end. Unblocks writers so they observe TCP_RESET. */
  fail(): SocketSink | null {
    if (this.closed || this.failed) return null;
    this.failed = true;
    const sink = this.sink;
    this.sink = null;
    this.wakeWriters();
    return sink;
  }
  write(bytes: Uint8Array): number {
    if (this.closed) return TCP_PIPE;
    if (this.failed) return TCP_RESET;
    let count = 0;
    while (count < bytes.length) {
      if (this.failed) return count || TCP_RESET;
      const chunk = bytes.subarray(count, count + this.module.capacity);
      const written = this.guard(
        () => status(this.module.write("net_write", this.id, chunk)),
        TCP_RESET,
      );
      if (written < 0) return count || written;
      count += written;
      this.peer?.drain();
    }
    return count;
  }
  consumed(bytes: number): void {
    if (this.closed || this.failed) return;
    if (!this.guard(() => this.module.call("net_consumed", this.id, bytes), 0)) return;
    this.peer?.wakeWriters();
    this.peer?.sink?.writable?.();
  }
  /** A failed socket reports writable so its next write returns the sticky TCP_RESET. */
  writableNow(): boolean {
    if (this.closed) return false;
    return this.failed || !!this.guard(() => this.module.call("net_writable", this.id), 1);
  }
  writable(): Promise<void> {
    if (this.closed || this.writableNow()) return Promise.resolve();
    return new Promise((resolve) => this.writers.add(resolve));
  }
  private wakeWriters(): void {
    for (const resolve of this.writers) resolve();
    this.writers.clear();
  }
  shutdown(): void {
    if (this.closed || this.failed) return;
    this.guard(() => this.module.call("net_shutdown", this.id), 0);
    this.peer?.drain();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
    if (!this.failed) this.guard(() => this.module.call("net_close", this.id), 0);
    try {
      this.peer?.drain();
    } finally {
      this.sink = null;
      this.wakeWriters();
      this.peer?.wakeWriters();
    }
  }
}
/** One module instance per namespace; JS retains only callbacks and owner identity. */
export class NetNamespace {
  static async create(assertActive: () => void = () => {}): Promise<NetNamespace> {
    const compiled = await (compilation ??= loadBufferNetworkModule());
    assertActive();
    return new NetNamespace(compiled.create());
  }

  private constructor(private readonly module: NetworkModule) {}
  private failure: NetworkOwnerFailure | undefined;
  /** The terminal module failure, if any. The namespace is never revived or recreated. */
  failed(): NetworkOwnerFailure | undefined {
    return this.failure;
  }
  private readonly guard: Guard = (operation, failed) => {
    if (this.failure) return failed;
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof NetworkOwnerFailure)) throw error;
      this.retire(error);
      return failed;
    }
  };
  /** Runs once. Resets every live socket and forgets every listener; calls no module code. */
  private retire(failure: NetworkOwnerFailure): void {
    if (this.failure) return;
    this.failure = failure;
    this.listeners.clear();
    this.bindings.clear();
    this.abstract.clear();
    const sinks = Array.from(this.sockets, (socket) => socket.fail());
    for (const sink of sinks) if (sink) this.reset(sink);
  }
  private readonly reset = (sink: SocketSink): void => {
    try {
      sink.reset?.();
    } catch (error) {
      this.failure?.callbackErrors.push(error);
    }
  };
  private listeners = new Map<number, Listener>();
  private sockets = new Set<LoopbackSocket>();
  private bindings = new Map<string, PathListener>();
  /** Abstract names, keyed by the exact string with its leading NUL. */
  private abstract = new Map<string, PathListener>();
  /** Listener slots promised to binds still waiting on the filesystem. */
  private reservedListeners = 0;
  private pathPairs = 0;
  /** Take a listener slot before any FS work, so a refused bind creates nothing. */
  reservePathListener(): boolean {
    if (this.failure || this.listenerSlots() >= PATH_LISTENERS) return false;
    this.reservedListeners++;
    return true;
  }
  private listenerSlots(): number {
    return this.bindings.size + this.abstract.size + this.reservedListeners;
  }
  releasePathListener(): void {
    this.reservedListeners--;
  }
  /** Consumes one reservation. The FS created the node exclusively, so a live key is a bug. */
  listenPath(key: SocketKey, listener: PathListener): number {
    this.reservedListeners--;
    if (this.failure) return ENOBUFS;
    const name = bindingKey(key);
    if (this.bindings.has(name)) return EADDRINUSE;
    this.bindings.set(name, listener);
    return 0;
  }
  unlistenPath(owner: object, handle: number): void {
    for (const [name, listener] of this.bindings)
      if (listener.owner === owner && listener.handle === handle) this.bindings.delete(name);
  }
  /** Synchronous: no filesystem work, so no reservation. */
  listenAbstract(name: string, listener: PathListener): number {
    if (this.failure) return ENOBUFS;
    if (this.abstract.has(name)) return EADDRINUSE;
    if (this.listenerSlots() >= PATH_LISTENERS) return ENOBUFS;
    this.abstract.set(name, listener);
    return 0;
  }
  /** The name is free again at once: abstract names leave nothing stale. */
  unlistenAbstract(owner: object, handle: number): void {
    for (const [name, listener] of this.abstract)
      if (listener.owner === owner && listener.handle === handle) this.abstract.delete(name);
  }
  connectPath(key: SocketKey, sink: SocketSink): LoopbackSocket | number {
    return this.connectListener(this.bindings.get(bindingKey(key)), sink);
  }
  connectAbstract(name: string, sink: SocketSink): LoopbackSocket | number {
    return this.connectListener(this.abstract.get(name), sink);
  }
  /** Atomic: refusals and exhaustion allocate nothing. */
  private connectListener(
    listener: PathListener | undefined,
    sink: SocketSink,
  ): LoopbackSocket | number {
    if (!listener || listener.pending() >= PATH_BACKLOG) return ECONNREFUSED;
    if (this.pathPairs >= PATH_PAIRS) return ENOBUFS;
    // A failed namespace refuses like one with no listener; a full one has no buffers.
    const ids = this.guard(() => this.open(() => this.module.call("net_pair")), ECONNREFUSED);
    if (typeof ids === "number") return ids === ECONNREFUSED ? ECONNREFUSED : ENOBUFS;
    this.pathPairs++;
    let open = 2;
    const closed = () => {
      if (--open === 0) this.pathPairs--;
    };
    const [client, server] = this.pair(ids, closed);
    client.receive(sink);
    listener.accept(server);
    return client;
  }
  /** One guarded step: create a pair and learn its peer, or the refusal status. */
  private open(create: () => number): [number, number] | number {
    const id = status(create());
    if (id < 0) return id;
    return [id, this.module.call("net_peer", id)];
  }
  private pair([id, peer]: [number, number], closed: () => void): [LoopbackSocket, LoopbackSocket] {
    const client = new LoopbackSocket(
      this.module,
      id,
      () => {
        this.sockets.delete(client);
        closed();
      },
      this.guard,
      this.reset,
    );
    const server = new LoopbackSocket(
      this.module,
      peer,
      () => {
        this.sockets.delete(server);
        closed();
      },
      this.guard,
      this.reset,
    );
    client.pair(server);
    server.pair(client);
    this.sockets.add(client);
    this.sockets.add(server);
    return [client, server];
  }
  listen(port: number, listener: Listener): number {
    if (!Number.isInteger(port) || port < 0 || port > 65535) return TCP_INVALID;
    const bound = this.guard(
      () => status(this.module.call("net_listen", kind(listener.local), port)),
      ERROR,
    );
    if (bound < 0) return bound;
    this.listeners.set(bound, { ...listener, local: { ...listener.local, port: bound } });
    return bound;
  }
  unlisten(owner: object, handle: number): void {
    for (const [port, listener] of this.listeners) {
      if (listener.owner !== owner || listener.handle !== handle) continue;
      this.guard(() => this.module.call("net_unlisten", port), 0);
      this.listeners.delete(port);
    }
  }
  release(owner: object): void {
    for (const [port, listener] of this.listeners) {
      if (listener.owner !== owner) continue;
      this.guard(() => this.module.call("net_unlisten", port), 0);
      this.listeners.delete(port);
    }
    for (const [name, listener] of this.bindings)
      if (listener.owner === owner) this.bindings.delete(name);
    for (const [name, listener] of this.abstract)
      if (listener.owner === owner) this.abstract.delete(name);
  }
  has(port: number): boolean {
    return this.listeners.has(port);
  }
  address(port: number): PeerAddr | undefined {
    return this.listeners.get(port)?.local;
  }
  connect(
    port: number,
    sink: SocketSink,
    host?: string,
  ): { socket: LoopbackSocket; port: number } | number {
    const listener = this.listeners.get(port);
    if (!listener) return TCP_REFUSED;
    // One guarded step creates the pair and reads its addresses, before any socket exists.
    const opened = this.guard(() => {
      const ids = this.open(() =>
        this.module.call("net_connect", target(host, listener.local), port),
      );
      if (typeof ids === "number") return ids;
      const [id, peer] = ids;
      return {
        ids,
        local: address(this.module.address(id)),
        remote: address(this.module.address(peer, true)),
        accepted: address(this.module.address(peer)),
      };
    }, TCP_REFUSED);
    if (typeof opened === "number") return opened;
    const [client, server] = this.pair(opened.ids, () => {});
    client.receive(sink);
    listener.accept(opened.remote, opened.accepted, server);
    return { socket: client, port: opened.local.port };
  }
  dispose(): void {
    try {
      for (const socket of this.sockets) socket.close();
    } finally {
      this.sockets.clear();
      this.listeners.clear();
      this.bindings.clear();
      this.abstract.clear();
      this.module.dispose();
    }
  }
}

/** Reply cells are private to one synchronous host call, never guest memory. */
export function tcpReply(reply: SharedArrayBuffer, status: number, value = 0): void {
  const cells = new Int32Array(reply);
  Atomics.store(cells, 1, status);
  Atomics.store(cells, 2, value);
  Atomics.store(cells, 0, 1);
  Atomics.notify(cells, 0);
}
