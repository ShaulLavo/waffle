// The bun_wasm host functions as seen from the bun worker (docs/host-abi.md).
// Everything here is synchronous and, except `poll`, never blocks: requests go out with postMessage,
// results come back through the shared ring (ring.ts), which is drained into per-handle state on
// every call.

import {
  AGAIN,
  BADF,
  ERROR,
  Kind,
  type NetError,
  type NetRequest,
  type NewConn,
  OK,
  type PeerAddr,
  UNSUPPORTED,
} from "./protocol";
import { RingReader } from "./ring";
import type { SlotImpls } from "./trampoline";

interface Stream {
  chunks: Uint8Array[];
  ended: boolean;
  error: NetError | null;
}

interface FetchHandle extends Stream {
  kind: "fetch";
  head: Uint8Array | null;
}

interface ListenerHandle {
  kind: "listener";
  port: number;
  pending: number[];
  error: NetError | null;
}

interface ConnHandle extends Stream {
  kind: "conn";
  port: number;
  peer: PeerAddr;
  /** For a connection between two of the guest's own handles (connect to its own listener): the other end. */
  pipe: number | null;
}

type Handle = FetchHandle | ListenerHandle | ConnHandle;

/** Largest write accepted per call; the helper buffers it. */
const MAX_WRITE = 1 << 20;
/** Hostnames `connect` treats as this process. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"]);
/** `listen(…, 0)` hands out ports from here up. */
const EPHEMERAL_BASE = 49152;

const encoder = new TextEncoder();
// URL.canParse is newer than the rest of what we need (Safari 17).
const canParse = (url: string) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};
const decoder = new TextDecoder();

export class NetHost {
  private ring: RingReader;
  private memory: WebAssembly.Memory | null = null;
  private handles = new Map<number, Handle>();
  /** Connections announced by the helper but not accepted yet (their bytes buffer here meanwhile). */
  private unaccepted = new Map<number, ConnHandle>();
  private nextHandle = 1;
  private seenGeneration: number;
  private lastError: NetError | null = null;
  /** Something changed without a ring record (a local pipe write or close): `poll` must not sleep. */
  private localNews = false;

  constructor(
    sab: SharedArrayBuffer,
    private send: (msg: NetRequest, transfer?: Transferable[]) => void,
  ) {
    this.ring = new RingReader(sab);
    this.seenGeneration = this.ring.generation();
  }

  attach(memory: WebAssembly.Memory): void {
    this.memory = memory;
  }

  /** The slot implementations to install (no `connect`: browsers have no raw sockets). */
  slots(): SlotImpls {
    return {
      poll: (timeout) => this.poll(timeout),
      fetch: (metaPtr, metaLen, bodyPtr, bodyLen) => this.fetch(metaPtr, metaLen, bodyPtr, bodyLen),
      fetch_head: (handle, ptr, cap) => this.fetchHead(handle, ptr, cap),
      read: (handle, ptr, cap) => this.read(handle, ptr, cap),
      write: (handle, ptr, len) => this.write(handle, ptr, len),
      close: (handle) => this.close(handle),
      listen: (hostPtr, hostLen, port) => this.listen(hostPtr, hostLen, port),
      local_port: (handle) => this.localPort(handle),
      accept: (listener) => this.accept(listener),
      connect: (hostPtr, hostLen, port) => this.connect(hostPtr, hostLen, port),
      error: (handle, ptr, cap) => this.error(handle, ptr, cap),
      peer_addr: (handle, ptr, cap) => this.peerAddr(handle, ptr, cap),
    };
  }

  // ---------- slots ----------

  private poll(timeoutMs: number): number {
    this.drain();
    if (this.localNews) {
      this.localNews = false;
      return 1;
    }
    const generation = this.ring.generation();
    if (generation !== this.seenGeneration) {
      this.seenGeneration = generation;
      return 1;
    }
    if (timeoutMs === 0) return 0;
    if (this.ring.wait(generation, timeoutMs) === "timed-out") return 0;
    this.seenGeneration = this.ring.generation();
    this.drain();
    return 1;
  }

  private fetch(metaPtr: number, metaLen: number, bodyPtr: number, bodyLen: number): number {
    let meta: { method?: string; url?: string; headers?: [string, string][]; redirect?: RequestRedirect };
    try {
      meta = JSON.parse(decoder.decode(this.bytes(metaPtr, metaLen)));
    } catch {
      return this.fail({ name: "TypeError", message: "fetch: malformed request metadata" });
    }
    const url = meta.url ?? "";
    if (!canParse(url)) return this.fail({ name: "TypeError", message: `Failed to parse URL from ${url}` });

    const id = this.nextHandle++;
    const method = (meta.method ?? "GET").toUpperCase();
    const body = bodyLen > 0 && method !== "GET" && method !== "HEAD" ? this.bytes(bodyPtr, bodyLen) : null;
    this.handles.set(id, { kind: "fetch", head: null, chunks: [], ended: false, error: null });
    this.send(
      { type: "fetch", id, method, url, headers: meta.headers ?? [], body, redirect: meta.redirect ?? "follow" },
      body ? [body.buffer] : [],
    );
    return id;
  }

  private fetchHead(handle: number, ptr: number, cap: number): number {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind !== "fetch") return BADF;
    if (h.head) return this.writeSized(h.head, ptr, cap);
    return h.error ? ERROR : AGAIN;
  }

  private read(handle: number, ptr: number, cap: number): number {
    this.drain();
    const h = this.handles.get(handle);
    if (!h || h.kind === "listener") return BADF;
    if (h.kind === "fetch" && !h.head) return h.error ? ERROR : AGAIN;
    if (h.chunks.length > 0) {
      const n = this.take(h, ptr, cap);
      if (h.kind === "fetch") this.send({ type: "ack", id: handle, bytes: n });
      return n;
    }
    if (h.error) return ERROR;
    return h.ended ? 0 : AGAIN;
  }

  private write(handle: number, ptr: number, len: number): number {
    const h = this.handles.get(handle);
    if (!h) return BADF;
    if (h.kind !== "conn") return UNSUPPORTED;
    const n = Math.min(len, MAX_WRITE);
    if (n === 0) return 0;
    const data = this.bytes(ptr, n);
    if (h.pipe === null) {
      this.send({ type: "write", id: handle, data }, [data.buffer]);
      return n;
    }
    const other = this.connection(h.pipe);
    if (!other) {
      h.error = { name: "Error", message: "write after the other end closed", code: "EPIPE" };
      return ERROR;
    }
    other.chunks.push(data);
    this.localNews = true;
    return n;
  }

  private close(handle: number): number {
    const h = this.handles.get(handle);
    if (!h) return BADF;
    this.handles.delete(handle);
    if (h.kind === "listener") {
      for (const conn of h.pending) this.closeUnaccepted(conn);
    }
    if (h.kind === "conn" && h.pipe !== null) {
      const other = this.connection(h.pipe);
      if (other) other.ended = true;
      this.localNews = true;
      return OK;
    }
    this.send({ type: "close", id: handle });
    return OK;
  }

  private listen(hostPtr: number, hostLen: number, port: number): number {
    const host = decoder.decode(this.bytes(hostPtr, hostLen)) || "0.0.0.0";
    const inUse = new Set<number>();
    for (const h of this.handles.values()) if (h.kind === "listener") inUse.add(h.port);
    if (port === 0) {
      port = EPHEMERAL_BASE;
      while (inUse.has(port)) port++;
    }
    if (port < 0 || port > 65535) return this.fail({ name: "RangeError", message: `port out of range: ${port}` });
    if (inUse.has(port)) {
      return this.fail({ name: "Error", message: `Failed to start server. Is port ${port} in use?`, code: "EADDRINUSE" });
    }
    const id = this.nextHandle++;
    this.handles.set(id, { kind: "listener", port, pending: [], error: null });
    this.send({ type: "listen", id, port, host });
    return id;
  }

  /**
   * Browsers have no TCP. A connection to one of the guest's own listeners is a local pipe between
   * two handles; anything else is unsupported.
   */
  private connect(hostPtr: number, hostLen: number, port: number): number {
    const host = decoder.decode(this.bytes(hostPtr, hostLen));
    const listener = Array.from(this.handles.entries()).find(([, h]) => h.kind === "listener" && h.port === port);
    if (!LOOPBACK.has(host) || !listener) {
      this.lastError = { name: "Error", message: `connect ${host}:${port}: TCP connections are not available in the browser`, code: "ENOTSUP" };
      return UNSUPPORTED;
    }
    const state = listener[1] as ListenerHandle;
    const client = this.nextHandle++;
    const server = this.nextHandle++;
    const clientPort = EPHEMERAL_BASE + 10000 + (client % 5000);
    const stream = (): Stream => ({ chunks: [], ended: false, error: null });
    this.handles.set(client, { kind: "conn", port: clientPort, peer: { address: "127.0.0.1", port, family: "IPv4" }, pipe: server, ...stream() });
    this.unaccepted.set(server, { kind: "conn", port, peer: { address: "127.0.0.1", port: clientPort, family: "IPv4" }, pipe: client, ...stream() });
    state.pending.push(server);
    this.localNews = true;
    return client;
  }

  private connection(handle: number): ConnHandle | undefined {
    const h = this.handles.get(handle) ?? this.unaccepted.get(handle);
    return h?.kind === "conn" ? h : undefined;
  }

  private localPort(handle: number): number {
    const h = this.handles.get(handle);
    if (!h || h.kind === "fetch") return BADF;
    return h.port;
  }

  private accept(listener: number): number {
    this.drain();
    const h = this.handles.get(listener);
    if (h?.kind !== "listener") return BADF;
    const conn = h.pending.shift();
    if (conn === undefined) return AGAIN;
    const state = this.unaccepted.get(conn);
    if (!state) return AGAIN;
    this.unaccepted.delete(conn);
    this.handles.set(conn, state);
    return conn;
  }

  private error(handle: number, ptr: number, cap: number): number {
    const err = handle === 0 ? this.lastError : (this.handles.get(handle)?.error ?? null);
    if (handle !== 0 && !this.handles.has(handle)) return BADF;
    return this.writeSized(encoder.encode(JSON.stringify(err ?? { name: "Error", message: "no error" })), ptr, cap);
  }

  private peerAddr(handle: number, ptr: number, cap: number): number {
    const h = this.handles.get(handle);
    if (h?.kind !== "conn") return BADF;
    return this.writeSized(encoder.encode(JSON.stringify(h.peer)), ptr, cap);
  }

  // ---------- events from the helper ----------

  private drain(): void {
    for (const { handle, kind, payload } of this.ring.drain()) this.dispatch(handle, kind, payload);
  }

  private dispatch(handle: number, kind: number, payload: Uint8Array): void {
    if (kind === Kind.Conn) {
      this.onConn(handle, payload);
      return;
    }
    // Events for handles the guest already closed are dropped.
    const h = this.handles.get(handle) ?? this.unaccepted.get(handle);
    if (!h || h.kind === "listener") return;
    if (kind === Kind.Head && h.kind === "fetch") h.head = payload;
    else if (kind === Kind.Data) h.chunks.push(payload);
    else if (kind === Kind.End) h.ended = true;
    else if (kind === Kind.Error) h.error = JSON.parse(decoder.decode(payload)) as NetError;
  }

  private onConn(listener: number, payload: Uint8Array): void {
    const { conn, peer } = JSON.parse(decoder.decode(payload)) as NewConn;
    const h = this.handles.get(listener);
    if (h?.kind !== "listener") {
      // The listener closed before the connection arrived: refuse it.
      this.send({ type: "close", id: conn });
      return;
    }
    this.unaccepted.set(conn, { kind: "conn", port: h.port, peer, pipe: null, chunks: [], ended: false, error: null });
    h.pending.push(conn);
  }

  private closeUnaccepted(conn: number): void {
    this.unaccepted.delete(conn);
    this.send({ type: "close", id: conn });
  }

  // ---------- memory ----------

  /** A copy of guest memory [ptr, ptr+len). */
  private bytes(ptr: number, len: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.memory!.buffer).slice(ptr >>> 0, (ptr >>> 0) + len);
  }

  /** The `fetch_head` length protocol: write when it fits, return the full length either way. */
  private writeSized(data: Uint8Array, ptr: number, cap: number): number {
    if (data.length <= cap) new Uint8Array(this.memory!.buffer).set(data, ptr >>> 0);
    return data.length;
  }

  /** Moves up to `cap` buffered bytes into guest memory. */
  private take(stream: Stream, ptr: number, cap: number): number {
    const memory = new Uint8Array(this.memory!.buffer);
    let n = 0;
    while (n < cap && stream.chunks.length > 0) {
      const chunk = stream.chunks[0]!;
      const count = Math.min(cap - n, chunk.length);
      memory.set(chunk.subarray(0, count), (ptr >>> 0) + n);
      n += count;
      if (count === chunk.length) stream.chunks.shift();
      else stream.chunks[0] = chunk.subarray(count);
    }
    return n;
  }

  private fail(err: NetError): number {
    this.lastError = err;
    return ERROR;
  }
}
