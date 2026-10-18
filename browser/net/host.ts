// Synchronous handle state for a guest networking bridge. Requests leave through the injected
// sender; responses arrive through the shared ring. No guest-memory or engine bindings live here.

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
} from "./protocol.js";
import { RingReader } from "./ring.js";

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
  writeEnded?: boolean;
}

type Handle = FetchHandle | ListenerHandle | ConnHandle;

/** Largest write accepted per call; the helper buffers it. */
const MAX_WRITE = 1 << 20;
/** Hostnames `connect` treats as this process. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"]);
/** `listen(…, 0)` hands out ports from here up. */
const EPHEMERAL_BASE = 49152;

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
  private handles = new Map<number, Handle>();
  /** Connections announced by the helper but not accepted yet (their bytes buffer here meanwhile). */
  private unaccepted = new Map<number, ConnHandle>();
  private nextHandle = 1;
  private seenGeneration: number;
  private lastError: NetError | null = null;
  /** Something changed without a ring record (a local pipe write or close): `poll` must not sleep. */
  private localNews = false;
  private fileWrite: { path: string; bytes: Uint8Array; offset: number } | null = null;

  constructor(
    sab: SharedArrayBuffer,
    private send: (msg: NetRequest, transfer?: Transferable[]) => void,
    private writeFile?: (path: string, bytes: Uint8Array) => void,
  ) {
    this.ring = new RingReader(sab);
    this.seenGeneration = this.ring.generation();
  }

  /** Register the nonblocking consumer's wake callback. Blocking consumers use poll instead. */
  onNews(cb: () => void): void {
    this.newsCallback = cb;
    this.watchRing();
  }

  private newsCallback: (() => void) | null = null;

  /** Something changed: wake a blocking `poll` (localNews) or the browser engine's loop. */
  private news(): void {
    this.localNews = true;
    if (this.newsCallback) queueMicrotask(this.newsCallback);
  }

  /** Calls onNews whenever the helper writes to the ring (Atomics.waitAsync, else a short timer). */
  private watchRing(): void {
    const seen = this.ring.generation();
    const again = () => {
      this.drain();
      if (this.ring.generation() !== seen && this.newsCallback) this.newsCallback();
      this.watchRing();
    };
    const waiting = this.ring.waitAsync(seen);
    if (waiting) waiting.then(again);
    else setTimeout(again, 4);
  }

  // ---------- handle operations ----------

  poll(timeoutMs: number): number {
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

  /** Start a request, copying body bytes before handing them to the message transport. */
  fetch(metaText: string, bodyBytes: Uint8Array | null = null): number {
    let meta: {
      method?: string;
      url?: string;
      headers?: [string, string][];
      redirect?: RequestRedirect;
    };
    try {
      meta = JSON.parse(metaText);
    } catch {
      return this.fail({ name: "TypeError", message: "fetch: malformed request metadata" });
    }
    const url = meta.url ?? "";
    if (!canParse(url))
      return this.fail({ name: "TypeError", message: `Failed to parse URL from ${url}` });

    const id = this.nextHandle++;
    const method = (meta.method ?? "GET").toUpperCase();
    const body =
      bodyBytes && bodyBytes.length > 0 && method !== "GET" && method !== "HEAD"
        ? new Uint8Array(bodyBytes)
        : null;
    this.handles.set(id, { kind: "fetch", head: null, chunks: [], ended: false, error: null });
    this.send(
      {
        type: "fetch",
        id,
        method,
        url,
        headers: meta.headers ?? [],
        body,
        redirect: meta.redirect ?? "follow",
      },
      body ? [body.buffer] : [],
    );
    return id;
  }

  fetchHead(handle: number): Uint8Array | number {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind !== "fetch") return BADF;
    if (h.head) return h.head;
    return h.error ? ERROR : AGAIN;
  }

  /** Up to cap buffered bytes, zero at EOF, or a protocol error code. */
  read(handle: number, cap: number): Uint8Array | number {
    this.drain();
    const h = this.handles.get(handle);
    if (!h || h.kind === "listener") return BADF;
    if (h.kind === "fetch" && !h.head) return h.error ? ERROR : AGAIN;
    if (h.chunks.length > 0) {
      const chunk = this.take(h, cap);
      if (h.kind === "fetch") this.send({ type: "ack", id: handle, bytes: chunk.length });
      else if (h.pipe !== null) this.news();
      return chunk;
    }
    if (h.error) return ERROR;
    return h.ended ? 0 : AGAIN;
  }

  /** Copy and queue at most MAX_WRITE bytes, without transferring the caller's buffer. */
  write(handle: number, bytes: Uint8Array): number {
    const h = this.handles.get(handle);
    if (!h) return BADF;
    if (h.kind !== "conn") return UNSUPPORTED;
    if (h.writeEnded) return ERROR;
    const n = Math.min(bytes.length, MAX_WRITE);
    if (n === 0) return 0;
    const data = new Uint8Array(bytes.subarray(0, n));
    if (h.pipe === null) {
      this.send({ type: "write", id: handle, data }, [data.buffer]);
      return n;
    }
    const other = this.connection(h.pipe);
    if (!other) {
      h.error = { name: "Error", message: "write after the other end closed", code: "EPIPE" };
      return ERROR;
    }
    const available = MAX_WRITE - other.chunks.reduce((size, chunk) => size + chunk.length, 0);
    if (available <= 0) return AGAIN;
    const count = Math.min(n, available);
    other.chunks.push(count === n ? data : data.slice(0, count));
    this.news();
    return count;
  }

  shutdown(handle: number): number {
    const h = this.handles.get(handle);
    if (h?.kind !== "conn") return BADF;
    if (h.writeEnded) return OK;
    h.writeEnded = true;
    if (h.pipe === null) this.send({ type: "close", id: handle });
    else {
      const peer = this.connection(h.pipe);
      if (peer) peer.ended = true;
      this.news();
    }
    return OK;
  }

  localAddr(handle: number): string | number {
    const h = this.handles.get(handle);
    if (!h || h.kind === "fetch") return BADF;
    const family = h.kind === "conn" ? h.peer.family : "IPv4";
    return JSON.stringify({
      address: family === "IPv4" ? "127.0.0.1" : "::1",
      family,
      port: h.port,
    });
  }

  close(handle: number): number {
    const h = this.handles.get(handle);
    if (!h) return BADF;
    this.handles.delete(handle);
    if (h.kind === "listener") {
      for (const conn of h.pending) this.closeUnaccepted(conn);
    }
    if (h.kind === "conn" && h.pipe !== null) {
      const other = this.connection(h.pipe);
      if (other) other.ended = true;
      this.news();
      return OK;
    }
    this.send({ type: "close", id: handle });
    return OK;
  }

  listen(hostname: string, port: number): number {
    const host = hostname || "0.0.0.0";
    const inUse = new Set<number>();
    for (const h of this.handles.values()) if (h.kind === "listener") inUse.add(h.port);
    if (port === 0) {
      port = EPHEMERAL_BASE;
      while (inUse.has(port)) port++;
    }
    if (port < 0 || port > 65535)
      return this.fail({ name: "RangeError", message: `port out of range: ${port}` });
    if (inUse.has(port)) {
      return this.fail({
        name: "Error",
        message: `Failed to start server. Is port ${port} in use?`,
        code: "EADDRINUSE",
      });
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
  connect(host: string, port: number): number {
    const listener = Array.from(this.handles.entries()).find(
      ([, h]) => h.kind === "listener" && h.port === port,
    );
    if (LOOPBACK.has(host) && (!listener || listener[1].kind !== "listener")) {
      return this.fail({
        name: "Error",
        message: `connect ECONNREFUSED ${host}:${port}`,
        code: "ECONNREFUSED",
      });
    }
    if (!LOOPBACK.has(host)) {
      this.lastError = {
        name: "Error",
        message: `connect ${host}:${port}: TCP connections are not available in the browser`,
        code: "ENOTSUP",
      };
      return UNSUPPORTED;
    }
    if (!listener || listener[1].kind !== "listener") return BADF;
    const state = listener[1];
    const client = this.nextHandle++;
    const server = this.nextHandle++;
    const clientPort = EPHEMERAL_BASE + 10000 + (client % 5000);
    const stream = (): Stream => ({ chunks: [], ended: false, error: null });
    this.handles.set(client, {
      kind: "conn",
      port: clientPort,
      peer: { address: "127.0.0.1", port, family: "IPv4" },
      pipe: server,
      ...stream(),
    });
    this.unaccepted.set(server, {
      kind: "conn",
      port,
      peer: { address: "127.0.0.1", port: clientPort, family: "IPv4" },
      pipe: client,
      ...stream(),
    });
    state.pending.push(server);
    this.news();
    return client;
  }

  private connection(handle: number): ConnHandle | undefined {
    const h = this.handles.get(handle) ?? this.unaccepted.get(handle);
    return h?.kind === "conn" ? h : undefined;
  }

  localPort(handle: number): number {
    const h = this.handles.get(handle);
    if (!h || h.kind === "fetch") return BADF;
    return h.port;
  }

  accept(listener: number): number {
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

  error(handle: number): string | number {
    const err = handle === 0 ? this.lastError : (this.handles.get(handle)?.error ?? null);
    if (handle !== 0 && !this.handles.has(handle)) return BADF;
    return JSON.stringify(err ?? { name: "Error", message: "no error" });
  }

  peerAddr(handle: number): string | number {
    const h = this.handles.get(handle);
    if (h?.kind !== "conn") return BADF;
    return JSON.stringify(h.peer);
  }

  // ---------- events from the helper ----------

  private drain(): void {
    for (const { handle, kind, payload } of this.ring.drain()) this.dispatch(handle, kind, payload);
  }

  private dispatch(handle: number, kind: number, payload: Uint8Array): void {
    if (kind === Kind.FileChanged) {
      const meta: unknown = JSON.parse(decoder.decode(payload));
      if (
        !meta ||
        typeof meta !== "object" ||
        !("path" in meta) ||
        typeof meta.path !== "string" ||
        !meta.path.startsWith("/") ||
        meta.path.includes("\0")
      )
        throw new TypeError("Invalid file change notification");
      // HMR polls file contents. The completed shared-FS write is already visible; wake
      // the guest to inspect it without replaying stale bytes through writeFile.
      this.news();
      return;
    }
    if (kind === Kind.FileStart || kind === Kind.FileData || kind === Kind.FileEnd) {
      this.receiveFile(kind, payload);
      return;
    }
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

  private receiveFile(kind: number, payload: Uint8Array): void {
    if (kind === Kind.FileStart) {
      const meta: unknown = JSON.parse(decoder.decode(payload));
      if (!meta || typeof meta !== "object" || !("path" in meta) || !("length" in meta))
        throw new TypeError("Invalid file update");
      if (
        typeof meta.path !== "string" ||
        !meta.path.startsWith("/") ||
        typeof meta.length !== "number" ||
        !Number.isSafeInteger(meta.length) ||
        meta.length < 0
      )
        throw new TypeError("Invalid file update metadata");
      this.fileWrite = { path: meta.path, bytes: new Uint8Array(meta.length), offset: 0 };
      return;
    }
    const pending = this.fileWrite;
    if (!pending) throw new Error("File update has no start record");
    if (kind === Kind.FileData) {
      if (pending.offset + payload.length > pending.bytes.length)
        throw new Error("File update exceeds its declared size");
      pending.bytes.set(payload, pending.offset);
      pending.offset += payload.length;
      return;
    }
    this.fileWrite = null;
    if (pending.offset !== pending.bytes.length) throw new Error("Incomplete file update");
    this.writeFile?.(pending.path, pending.bytes);
  }

  private onConn(listener: number, payload: Uint8Array): void {
    const { conn, peer } = JSON.parse(decoder.decode(payload)) as NewConn;
    const h = this.handles.get(listener);
    if (h?.kind !== "listener") {
      // The listener closed before the connection arrived: refuse it.
      this.send({ type: "close", id: conn });
      return;
    }
    this.unaccepted.set(conn, {
      kind: "conn",
      port: h.port,
      peer,
      pipe: null,
      chunks: [],
      ended: false,
      error: null,
    });
    h.pending.push(conn);
  }

  private closeUnaccepted(conn: number): void {
    const state = this.unaccepted.get(conn);
    this.unaccepted.delete(conn);
    if (!state) return;
    if (state.pipe !== null) {
      const peer = this.connection(state.pipe);
      if (peer) peer.ended = true;
      this.news();
      return;
    }
    this.send({ type: "close", id: conn });
  }

  /** Takes up to `cap` buffered bytes. */
  private take(stream: Stream, cap: number): Uint8Array {
    let size = 0;
    for (const chunk of stream.chunks) {
      size += chunk.length;
      if (size >= cap) break;
    }
    const out = new Uint8Array(Math.min(size, cap));
    let n = 0;
    while (n < out.length) {
      const chunk = stream.chunks[0]!;
      const count = Math.min(out.length - n, chunk.length);
      out.set(chunk.subarray(0, count), n);
      n += count;
      if (count === chunk.length) stream.chunks.shift();
      else stream.chunks[0] = chunk.subarray(count);
    }
    return out;
  }

  private fail(err: NetError): number {
    this.lastError = err;
    return ERROR;
  }
}
