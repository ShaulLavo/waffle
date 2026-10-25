import { TCP_IN_USE, TCP_REFUSED, TCP_PIPE, TCP_INVALID } from "./tcp-status.js";
import { AGAIN, ERROR, UNSUPPORTED, type PeerAddr } from "./protocol.js";
import { loadNetworkModule, type NetworkModule } from "./module.js";

// This module is reached by runtime.network(), never by the core or process entries.
const compiled = await loadNetworkModule();
export interface SocketSink {
  data(bytes: Uint8Array): void;
  end(): void;
  writable?(): void;
}
type Listener = {
  owner: object;
  handle: number;
  local: PeerAddr;
  accept(peer: PeerAddr, local: PeerAddr, socket: LoopbackSocket): void;
};
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
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return 4;
  if (host === "::" || host === "::1") return 6;
  return 0;
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
  private writers = new Set<() => void>();
  constructor(
    private module: NetworkModule,
    private id: number,
    private release: () => void,
  ) {}
  pair(peer: LoopbackSocket): void {
    this.peer = peer;
  }
  receive(sink: SocketSink): void {
    this.sink = sink;
    this.drain();
  }
  private drain(): void {
    if (this.closed || !this.sink) return;
    for (;;) {
      const bytes = this.module.read("net_take", this.id, this.module.capacity);
      if (typeof bytes === "number" || bytes.length === 0) break;
      this.sink.data(bytes);
      if (this.closed || !this.sink) return;
    }
    if (this.ended || !this.module.call("net_ended", this.id)) return;
    this.ended = true;
    this.sink.end();
  }
  write(bytes: Uint8Array): number {
    if (this.closed) return TCP_PIPE;
    let count = 0;
    while (count < bytes.length) {
      const written = status(
        this.module.write(
          "net_write",
          this.id,
          bytes.subarray(count, count + this.module.capacity),
        ),
      );
      if (written < 0) return count || written;
      count += written;
      this.peer?.drain();
    }
    return count;
  }
  consumed(bytes: number): void {
    if (this.closed || !this.module.call("net_consumed", this.id, bytes)) return;
    this.peer?.wakeWriters();
    this.peer?.sink?.writable?.();
  }
  writable(): Promise<void> {
    if (this.closed || this.module.call("net_writable", this.id)) return Promise.resolve();
    return new Promise((resolve) => this.writers.add(resolve));
  }
  private wakeWriters(): void {
    for (const resolve of this.writers) resolve();
    this.writers.clear();
  }
  shutdown(): void {
    if (this.closed) return;
    this.module.call("net_shutdown", this.id);
    this.peer?.drain();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
    this.module.call("net_close", this.id);
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
  private module = compiled.create();
  private listeners = new Map<number, Listener>();
  private sockets = new Set<LoopbackSocket>();
  listen(port: number, listener: Listener): number {
    if (!Number.isInteger(port) || port < 0 || port > 65535) return TCP_INVALID;
    const bound = status(this.module.call("net_listen", kind(listener.local), port));
    if (bound < 0) return bound;
    this.listeners.set(bound, { ...listener, local: { ...listener.local, port: bound } });
    return bound;
  }
  unlisten(owner: object, handle: number): void {
    for (const [port, listener] of this.listeners) {
      if (listener.owner !== owner || listener.handle !== handle) continue;
      this.module.call("net_unlisten", port);
      this.listeners.delete(port);
    }
  }
  release(owner: object): void {
    for (const [port, listener] of this.listeners) {
      if (listener.owner !== owner) continue;
      this.module.call("net_unlisten", port);
      this.listeners.delete(port);
    }
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
    const id = status(this.module.call("net_connect", target(host, listener.local), port));
    if (id < 0) return id;
    const peer = this.module.call("net_peer", id);
    const client = new LoopbackSocket(this.module, id, () => this.sockets.delete(client));
    const server = new LoopbackSocket(this.module, peer, () => this.sockets.delete(server));
    client.pair(server);
    server.pair(client);
    client.receive(sink);
    this.sockets.add(client);
    this.sockets.add(server);
    const local = address(this.module.address(id));
    listener.accept(
      address(this.module.address(peer, true)),
      address(this.module.address(peer)),
      server,
    );
    return { socket: client, port: local.port };
  }
  dispose(): void {
    try {
      for (const socket of this.sockets) socket.close();
    } finally {
      this.sockets.clear();
      this.listeners.clear();
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
