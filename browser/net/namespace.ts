import { AGAIN, ERROR, UNSUPPORTED, type PeerAddr } from "./protocol.js";
import { acceptedAddress, loopbackAddress, tcpAddress } from "./address.js";

export const TCP_IN_USE = -10;
export const TCP_REFUSED = -11;
export const TCP_PIPE = -12;
export const TCP_INVALID = -13;
const BUFFER_LIMIT = 1 << 20;
const FIRST_PORT = 49152;

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

/** Both endpoints live with the helpers. Only owned byte copies cross worker boundaries. */
export class LoopbackSocket {
  private peer: LoopbackSocket | null = null;
  private sink: SocketSink | null = null;
  private buffered = 0;
  private writeEnded = false;
  private closed = false;
  private writers = new Set<() => void>();
  private release = () => {};

  static pair(client: SocketSink, release: () => void): [LoopbackSocket, LoopbackSocket] {
    const a = new LoopbackSocket();
    const b = new LoopbackSocket();
    a.peer = b;
    b.peer = a;
    a.sink = client;
    a.release = release;
    return [a, b];
  }

  receive(sink: SocketSink): void {
    this.sink = sink;
  }

  write(bytes: Uint8Array): number {
    const peer = this.peer;
    if (this.closed || this.writeEnded || !peer || peer.closed) return TCP_PIPE;
    const count = Math.min(bytes.length, BUFFER_LIMIT - peer.buffered);
    if (count === 0) return bytes.length === 0 ? 0 : AGAIN;
    peer.buffered += count;
    peer.sink?.data(bytes.slice(0, count));
    return count;
  }

  consumed(bytes: number): void {
    const wasFull = this.buffered === BUFFER_LIMIT;
    this.buffered = Math.max(0, this.buffered - bytes);
    if (!wasFull || this.buffered === BUFFER_LIMIT) return;
    this.peer?.wakeWriters();
    this.peer?.sink?.writable?.();
  }

  writable(): Promise<void> {
    if (this.closed || !this.peer || this.peer.closed || this.peer.buffered < BUFFER_LIMIT)
      return Promise.resolve();
    return new Promise((resolve) => this.writers.add(resolve));
  }

  private wakeWriters(): void {
    for (const resolve of this.writers) resolve();
    this.writers.clear();
  }

  shutdown(): void {
    if (this.writeEnded) return;
    this.writeEnded = true;
    this.peer?.sink?.end();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
    try {
      this.shutdown();
    } finally {
      this.sink = null;
      this.wakeWriters();
      this.peer?.wakeWriters();
    }
  }
}

/** One runtime's localhost. Share this object among helpers on their event-loop thread. */
export class NetNamespace {
  private listeners = new Map<number, Listener>();
  private nextClientPort = FIRST_PORT;
  private clientPorts = new Set<number>();

  listen(port: number, listener: Listener): number {
    if (!Number.isInteger(port) || port < 0 || port > 65535) return TCP_INVALID;
    if (port === 0) port = this.availablePort();
    if (port === ERROR) return ERROR;
    if (this.listeners.has(port) || this.clientPorts.has(port)) return TCP_IN_USE;
    this.listeners.set(port, { ...listener, local: { ...listener.local, port } });
    return port;
  }

  unlisten(owner: object, handle: number): void {
    for (const [port, listener] of this.listeners) {
      if (listener.owner === owner && listener.handle === handle) this.listeners.delete(port);
    }
  }

  release(owner: object): void {
    for (const [port, listener] of this.listeners) {
      if (listener.owner === owner) this.listeners.delete(port);
    }
  }

  has(port: number): boolean {
    return this.listeners.has(port);
  }

  address(port: number): PeerAddr | undefined {
    return this.listeners.get(port)?.local;
  }

  connect(port: number, sink: SocketSink, host?: string): { socket: LoopbackSocket; port: number } | number {
    const listener = this.listeners.get(port);
    if (!listener) return TCP_REFUSED;
    const target = host === undefined ? loopbackAddress(listener.local) : tcpAddress(host);
    if (!target) return UNSUPPORTED;
    const address = acceptedAddress(listener.local, target);
    if (!address) return TCP_REFUSED;
    const localPort = this.availablePort(this.nextClientPort);
    if (localPort === ERROR) return ERROR;
    this.nextClientPort = localPort === 65535 ? FIRST_PORT : localPort + 1;
    this.clientPorts.add(localPort);
    const [client, server] = LoopbackSocket.pair(sink, () => this.clientPorts.delete(localPort));
    listener.accept({ ...address, port: localPort }, { ...address, port }, server);
    return { socket: client, port: localPort };
  }

  private availablePort(start = FIRST_PORT): number {
    const count = 65536 - FIRST_PORT;
    for (let offset = 0; offset < count; offset++) {
      const port = FIRST_PORT + ((start - FIRST_PORT + offset) % count);
      if (!this.listeners.has(port) && !this.clientPorts.has(port)) return port;
    }
    return ERROR;
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
