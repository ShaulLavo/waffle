import { allocateSharedControl } from "../../memory/control.js";
import {
  afterMicrotask,
  afterNativePromise,
  atomicsAdd,
  atomicsLoad,
  atomicsNotify,
  atomicsWaitAsync,
  scheduleTimeout,
  SetConstructor,
  setAdd,
  setDelete,
  setForEach,
} from "../../proc/intrinsics.js";
// Synchronous handle state for a guest networking bridge. Requests leave through the injected
// sender; responses arrive through the shared ring. No guest-memory or engine bindings live here.

import {
  AGAIN,
  BADF,
  ERROR,
  Kind,
  type NetError,
  type NetRequest,
  type TcpCommand,
  type NewConn,
  OK,
  TCP_PENDING,
  type PeerAddr,
  type SocketAddr,
  UNSUPPORTED,
} from "./protocol.js";
import { ENOTSUP, unixCode } from "./unix-status.js";
import { TCP_IN_USE, TCP_REFUSED, TCP_PIPE, TCP_INVALID, TCP_RESET } from "./tcp-status.js";
import { RingReader } from "./ring.js";
import type { NotificationWaitSet } from "../notification-wait.js";
import type { GuestWatchReadiness } from "../../fs/guest-watch.js";
import {
  acceptedAddress,
  loopbackAddress,
  tcpAddress,
  isPeerAddr,
  type RuntimeNetworkLookupOptions,
} from "./address.js";

interface NetworkByteStream {
  chunks: Uint8Array[];
  ended: boolean;
  error: NetError | null;
}

interface FetchHandle extends NetworkByteStream {
  kind: "fetch";
  head: Uint8Array | null;
}

interface LookupHandle {
  kind: "lookup";
  chunks: Uint8Array[];
  head: Uint8Array | null;
  error: NetError | null;
}

interface ListenerHandle {
  kind: "listener";
  local: SocketAddr;
  pending: number[];
  error: NetError | null;
}

interface ConnHandle extends NetworkByteStream {
  kind: "conn";
  local: SocketAddr;
  peer: SocketAddr | null;
  connecting: boolean;
  /** For a connection between two of the guest's own handles (connect to its own listener): the other end. */
  pipe: number | null;
  writeEnded?: boolean;
  readEnded?: boolean;
}

type Handle = FetchHandle | LookupHandle | ListenerHandle | ConnHandle;

/** Largest write accepted per call; the helper buffers it. */
const MAX_WRITE = 1 << 20;
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
const now = performance.now.bind(performance);
// Private wait loops schedule through captured natives; their waits never reject.
const ignore = () => {};

interface AttachedNotifications {
  readonly set: NotificationWaitSet;
  readonly watches: () => GuestWatchReadiness | undefined;
}

export class NetHost {
  private ring: RingReader;
  private handles = new Map<number, Handle>();
  private readonly listenerPorts = new Set<number>();
  /** Lowest free standalone listener port, or 65536 when exhausted. */
  private nextEphemeralPort = EPHEMERAL_BASE;
  /** Connections announced by the helper but not accepted yet (their bytes buffer here meanwhile). */
  private unaccepted = new Map<number, ConnHandle>();
  private nextHandle = 1;
  private disposed = false;
  private seenGeneration: number;
  private lastError: NetError | null = null;
  /** Something changed without a ring record (a local pipe write or close): `poll` must not sleep. */
  private localNews = false;
  private readonly notificationSinks = new SetConstructor<Int32Array>();
  private fileWrite: { path: string; bytes: Uint8Array; offset: number } | null = null;
  private notifications: AttachedNotifications | undefined;
  /** The filesystem word the onNews loop waits on, while that wait is pending. */
  private filesystemWait: Int32Array | undefined;

  constructor(
    sab: SharedArrayBuffer,
    private send: (msg: NetRequest, transfer?: Transferable[]) => void,
    private writeFile?: (path: string, bytes: Uint8Array) => void,
    private options: { shared?: boolean } = {},
  ) {
    this.ring = new RingReader(sab);
    this.seenGeneration = this.ring.generation();
  }

  /** The helper ring word. Local news remains outside this shared word and poll(0) still drains it. */
  get notification(): Int32Array {
    return this.ring.notification;
  }

  /** Synchronous local-news forwarding. Ring GEN remains independently observed. */
  registerNotificationSink(wake: Int32Array): () => void {
    if (this.disposed) throw new Error("network host is disposed");
    setAdd(this.notificationSinks, wake);
    if (this.localNews) {
      atomicsAdd(wake, 0, 1);
      atomicsNotify(wake, 0);
    }
    return () => {
      setDelete(this.notificationSinks, wake);
    };
  }

  /** Register the nonblocking consumer's wake callback. Blocking consumers use poll instead. */
  onNews(cb: () => void): void {
    if (this.disposed) return;
    this.newsCallback = cb;
    this.watchRing();
    this.watchFilesystem();
  }

  /** Wait on the guest's armed set, which covers this host and the filesystem watch counter.
   * `poll` then also returns when a guest filesystem watch has something to read. */
  attachNotifications(
    set: NotificationWaitSet,
    watches: () => GuestWatchReadiness | undefined,
  ): void {
    if (this.disposed) throw new Error("network host is disposed");
    this.notifications = { set, watches };
    this.watchFilesystem();
  }

  private newsCallback: (() => void) | null = null;

  /** Something changed: wake a blocking `poll` (localNews) or the browser engine's loop. */
  private news(): void {
    this.localNews = true;
    setForEach(this.notificationSinks, (wake) => {
      atomicsAdd(wake, 0, 1);
      atomicsNotify(wake, 0);
    });
    if (this.newsCallback)
      queueMicrotask(() => {
        if (!this.disposed) this.newsCallback?.();
      });
  }

  /** Calls onNews whenever the helper writes to the ring (Atomics.waitAsync, else a short timer). */
  private watchRing(): void {
    if (this.disposed) return;
    const seen = this.ring.generation();
    const again = () => {
      if (this.disposed) return;
      this.drain();
      if (this.ring.generation() !== seen && this.newsCallback) this.newsCallback();
      this.watchRing();
    };
    const waiting = this.ring.waitAsync(seen);
    if (waiting) afterNativePromise(waiting, again, ignore);
    else scheduleTimeout(again, 4);
  }

  /** Wake the engine when a guest watch becomes readable. Each commit in the root costs one
   * readiness check; there is no timer. Runs once both the callback and readiness exist. */
  private watchFilesystem(): void {
    if (this.disposed || this.filesystemWait || !this.newsCallback) return;
    const word = this.notifications?.watches()?.word;
    if (!word) return;
    this.filesystemWait = word;
    const turn = (): void => {
      if (this.disposed) return;
      const seen = atomicsLoad(word, 3);
      if (this.notifications?.watches()?.pending()) this.newsCallback?.();
      const waiting = atomicsWaitAsync(word, 3, seen);
      if (waiting.async) afterNativePromise(waiting.value, turn, ignore);
      else afterMicrotask(turn);
    };
    turn();
  }

  // ---------- handle operations ----------

  poll(timeoutMs: number): number {
    if (this.disposed) return 0;
    if (this.notifications) return this.pollNotifications(this.notifications, timeoutMs);
    if (this.ready()) return 1;
    if (timeoutMs === 0) return 0;
    if (this.ring.wait(this.seenGeneration, timeoutMs) === "timed-out") return 0;
    this.seenGeneration = this.ring.generation();
    this.drain();
    return 1;
  }

  /** Sample before every readiness check so a publication racing the check ends the wait. */
  private pollNotifications(notifications: AttachedNotifications, timeoutMs: number): number {
    const deadline = timeoutMs < 0 ? Infinity : now() + timeoutMs;
    for (;;) {
      const sample = notifications.set.sample();
      if (this.ready() || notifications.watches()?.pending()) return 1;
      if (timeoutMs === 0) return 0;
      const result = notifications.set.wait(sample, deadline);
      if (result === "closed" || (result === "timed-out" && now() >= deadline)) return 0;
    }
  }

  /** Consumes local news or a ring generation change, after delivering ring records. */
  private ready(): boolean {
    this.drain();
    if (this.localNews) {
      this.localNews = false;
      return true;
    }
    const generation = this.ring.generation();
    if (generation === this.seenGeneration) return false;
    this.seenGeneration = generation;
    return true;
  }

  /** Start a request, copying body bytes before handing them to the message transport. */
  fetch(metaText: string, bodyBytes: Uint8Array | null = null): number {
    if (this.disposed) return BADF;
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

  /** Start runtime-owned name lookup on the same handle/ring transport as fetch. */
  lookupStart(hostname: string, options: RuntimeNetworkLookupOptions = {}): number {
    if (this.disposed) return BADF;
    const captured = { family: options.family, hints: options.hints };
    if (this.disposed) return BADF;
    const id = this.nextHandle++;
    this.handles.set(id, { kind: "lookup", chunks: [], head: null, error: null });
    try {
      this.send({ type: "lookup", id, hostname, options: captured });
    } catch (error) {
      this.handles.delete(id);
      throw error;
    }
    return id;
  }

  /** Repeatable UTF-8 JSON result array; AGAIN pending, ERROR failed, BADF wrong/closed handle. */
  lookupHead(handle: number): Uint8Array | number {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind !== "lookup") return BADF;
    if (h.head) return h.head;
    return h.error ? ERROR : AGAIN;
  }

  /** Up to cap buffered bytes, zero at EOF, or a protocol error code. */
  read(handle: number, cap: number): Uint8Array | number {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind !== "conn" && h?.kind !== "fetch") return BADF;
    if (h.kind === "conn" && h.readEnded) return 0;
    if (h.kind === "fetch" && !h.head) return h.error ? ERROR : AGAIN;
    if (h.chunks.length > 0) {
      const chunk = this.take(h, cap);
      if (h.kind === "fetch") this.send({ type: "ack", id: handle, bytes: chunk.length });
      else if (h.pipe !== null) this.news();
      else if (this.options.shared)
        this.send({ type: "tcp-read", id: handle, bytes: chunk.length });
      return chunk;
    }
    if (h.error) return this.fail(h.error);
    return h.ended ? 0 : AGAIN;
  }

  /** Copy and queue at most MAX_WRITE bytes, without transferring the caller's buffer. */
  write(handle: number, bytes: Uint8Array): number {
    this.drain();
    const h = this.handles.get(handle);
    if (!h) return BADF;
    if (h.kind !== "conn") return UNSUPPORTED;
    if (h.connecting) return AGAIN;
    if (h.error) return this.fail(h.error);
    if (h.writeEnded) return ERROR;
    const n = Math.min(bytes.length, MAX_WRITE);
    if (n === 0) return 0;
    const data = new Uint8Array(bytes.subarray(0, n));
    if (h.pipe === null && this.options.shared) {
      const [written] = this.call({ type: "tcp-write", id: handle, data }, [data.buffer]);
      if (written === AGAIN) return AGAIN;
      if (written < 0) {
        h.error = this.tcpError(written);
        return this.fail(h.error);
      }
      return written;
    }
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

  /** Non-consuming socket state for descriptor adapters. Does not perform I/O. */
  socketState(handle: number) {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind === "listener")
      return {
        readable: h.pending.length > 0 || !!h.error,
        writable: false,
        hangup: !!h.error,
        nbytes: 0,
        error: h.error?.code,
      };
    if (h?.kind !== "conn")
      return { readable: true, writable: true, hangup: true, nbytes: 0, error: "EBADF" };
    const nbytes = h.chunks.reduce((size, chunk) => size + chunk.length, 0);
    return {
      readable: nbytes > 0 || h.ended || !!h.readEnded || !!h.error,
      writable: !!h.error || !!h.writeEnded || (!h.connecting && this.socketWritable(handle, h)),
      hangup: h.ended || !!h.readEnded || !!h.error,
      nbytes,
      error: h.error?.code,
    };
  }

  private socketWritable(handle: number, socket: ConnHandle): boolean {
    if (socket.pipe !== null) {
      const peer = this.connection(socket.pipe);
      return !peer || peer.chunks.reduce((size, chunk) => size + chunk.length, 0) < MAX_WRITE;
    }
    if (!this.options.shared) return true;
    return this.call({ type: "tcp-ready", id: handle })[0] !== 0;
  }

  /** Local SHUT_RD discards present and future bytes while releasing helper receive credit. */
  shutdownRead(handle: number): number {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind !== "conn") return BADF;
    if (h.readEnded) return OK;
    h.readEnded = true;
    const bytes = h.chunks.reduce((size, chunk) => size + chunk.length, 0);
    h.chunks = [];
    if (bytes && this.options.shared) this.send({ type: "tcp-read", id: handle, bytes });
    this.news();
    return OK;
  }

  shutdown(handle: number): number {
    const h = this.handles.get(handle);
    if (h?.kind !== "conn") return BADF;
    if (h.writeEnded) return OK;
    h.writeEnded = true;
    if (h.pipe === null)
      this.send({ type: this.options.shared ? "shutdown" : "close", id: handle });
    else {
      const peer = this.connection(h.pipe);
      if (peer) peer.ended = true;
      this.news();
    }
    return OK;
  }

  localAddr(handle: number): string | number {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind === "conn" && (h.connecting || !h.peer))
      return this.fail({ name: "Error", message: "socket is not connected", code: "ENOTCONN" });
    if (h?.kind !== "conn" && h?.kind !== "listener") return BADF;
    return JSON.stringify(h.local);
  }

  close(handle: number): number {
    const h = this.handles.get(handle);
    if (!h) return BADF;
    this.handles.delete(handle);
    if (h.kind === "listener") {
      if (h.local.family !== "Unix" && !this.options.shared) this.releasePort(h.local.port);
      for (const conn of h.pending) this.closeUnaccepted(conn);
      if (h.local.family === "Unix" && !this.disposed) return this.closePath(handle, h.local);
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

  /** Pathname listener in the shared runtime namespace; the helper creates a real socket node. */
  listenPath(path: string, options?: { readonly unlinkOnClose?: boolean }): number {
    if (this.disposed) return BADF;
    const unlinkOnClose = options?.unlinkOnClose ?? true;
    if (!this.options.shared) return this.unixUnsupported("listen", path);
    const id = this.nextHandle++;
    const [status, errno] = this.call({ type: "unix-listen", id, path, unlinkOnClose });
    if (status < 0) return this.fail(this.unixError("listen", errno, path));
    this.handles.set(id, {
      kind: "listener",
      local: { family: "Unix", path },
      pending: [],
      error: null,
    });
    return id;
  }

  connectPath(path: string): number {
    if (this.disposed) return BADF;
    if (!this.options.shared) return this.unixUnsupported("connect", path);
    const id = this.nextHandle++;
    const [status, errno] = this.call({ type: "unix-connect", id, path });
    if (status < 0) return this.fail(this.unixError("connect", errno, path));
    this.handles.set(id, {
      kind: "conn",
      local: { family: "Unix", path: null },
      peer: { family: "Unix", path },
      pipe: null,
      connecting: false,
      chunks: [],
      ended: false,
      error: null,
    });
    return id;
  }

  /** Blocks until the requested unlink settles. The handle is gone either way. */
  private closePath(handle: number, local: SocketAddr): number {
    const [status, errno] = this.call({ type: "unix-close", id: handle });
    if (status >= 0) return OK;
    const path = local.family === "Unix" ? (local.path ?? "") : "";
    return this.fail(this.unixError("close", errno, path));
  }

  private unixUnsupported(syscall: string, path: string): number {
    this.lastError = {
      name: "Error",
      message: `${syscall} ENOTSUP ${path}: Unix sockets need a shared runtime network`,
      code: unixCode(ENOTSUP),
      syscall,
    };
    return UNSUPPORTED;
  }

  private unixError(syscall: string, errno: number, path: string): NetError {
    const code = unixCode(errno);
    return { name: "Error", message: `${syscall} ${code} ${path}`, code, syscall };
  }

  listen(hostname: string, port: number): number {
    if (this.disposed) return BADF;
    const host = hostname || "0.0.0.0";
    const address = tcpAddress(host);
    if (!address) {
      this.lastError = {
        name: "Error",
        message: `listen ${host}: only virtual loopback binds are available in the browser`,
        code: "ENOTSUP",
      };
      return UNSUPPORTED;
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      return this.fail({ name: "RangeError", message: `port out of range: ${port}` });
    if (this.options.shared) return this.listenShared(host, port, address);
    if (port === 0) port = this.nextEphemeralPort;
    if (port > 65535)
      return this.fail({ name: "RangeError", message: `port out of range: ${port}` });
    if (this.listenerPorts.has(port)) {
      return this.fail({
        name: "Error",
        message: `Failed to start server. Is port ${port} in use?`,
        code: "EADDRINUSE",
      });
    }
    const id = this.nextHandle++;
    this.handles.set(id, {
      kind: "listener",
      local: { ...address, port },
      pending: [],
      error: null,
    });
    this.listenerPorts.add(port);
    while (this.listenerPorts.has(this.nextEphemeralPort)) this.nextEphemeralPort++;
    try {
      this.send({ type: "listen", id, port, host });
    } catch (error) {
      if (this.handles.delete(id)) this.releasePort(port);
      throw error;
    }
    return id;
  }

  private releasePort(port: number): void {
    this.listenerPorts.delete(port);
    if (port >= EPHEMERAL_BASE) this.nextEphemeralPort = Math.min(this.nextEphemeralPort, port);
  }

  /**
   * Shared hosts route loopback through their runtime's helpers. Standalone hosts use an in-host
   * pipe. Only shared hosts can use a helper's injected outbound connector.
   */
  connect(host: string, port: number): number {
    if (this.disposed) return BADF;
    const address = tcpAddress(host);
    if (address) {
      const target = loopbackAddress(address);
      if (this.options.shared) return this.connectShared(target, port);
      const state = Array.from(this.handles.values()).find(
        (handle): handle is ListenerHandle & { local: PeerAddr } =>
          handle.kind === "listener" &&
          handle.local.family !== "Unix" &&
          handle.local.port === port,
      );
      const accepted = state && acceptedAddress(state.local, target);
      if (!state || !accepted) {
        return this.fail({
          name: "Error",
          message: `connect ECONNREFUSED ${host}:${port}`,
          code: "ECONNREFUSED",
        });
      }
      return this.connectPipe(port, target, state, accepted);
    }
    if (!this.options.shared) {
      this.lastError = {
        name: "Error",
        message: `connect ${host}:${port}: TCP connections are not available in the browser`,
        code: "ENOTSUP",
      };
      return UNSUPPORTED;
    }
    return this.connectExternal(host, port);
  }

  private connectPipe(
    port: number,
    target: Omit<PeerAddr, "port">,
    state: ListenerHandle & { local: PeerAddr },
    accepted: Omit<PeerAddr, "port">,
  ): number {
    const client = this.nextHandle++;
    const server = this.nextHandle++;
    const clientPort = EPHEMERAL_BASE + 10000 + (client % 5000);
    const stream = (): NetworkByteStream => ({ chunks: [], ended: false, error: null });
    this.handles.set(client, {
      kind: "conn",
      local: { ...target, port: clientPort },
      peer: { ...target, port },
      connecting: false,
      pipe: server,
      ...stream(),
    });
    this.unaccepted.set(server, {
      kind: "conn",
      local: { ...accepted, port },
      peer: { ...accepted, port: clientPort },
      connecting: false,
      pipe: client,
      ...stream(),
    });
    state.pending.push(server);
    this.news();
    return client;
  }

  private connectExternal(host: string, port: number): number {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return this.fail({ name: "RangeError", message: `port out of range: ${port}` });
    const id = this.nextHandle++;
    const [status] = this.call({ type: "tcp-connect", id, host, port });
    if (status < 0) {
      if (status === UNSUPPORTED) {
        this.lastError = {
          name: "Error",
          message: `connect ${host}:${port}: TCP connections are not available in the browser`,
          code: "ENOTSUP",
        };
        return UNSUPPORTED;
      }
      return this.fail(this.tcpError(status));
    }
    this.handles.set(id, {
      kind: "conn",
      local: { address: "0.0.0.0", family: "IPv4", port: 0 },
      peer: null,
      connecting: status === TCP_PENDING,
      pipe: null,
      chunks: [],
      ended: false,
      error: null,
    });
    return id;
  }

  /** Close this host's handles. The launcher must also dispose its helper on worker exit. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.newsCallback = null;
    this.notifications = undefined;
    // Settle the pending onNews filesystem wait; other waiters on the word re-check and re-wait.
    if (this.filesystemWait) atomicsNotify(this.filesystemWait, 3);
    this.filesystemWait = undefined;
    setForEach(this.notificationSinks, (wake) => setDelete(this.notificationSinks, wake));
    const failures: unknown[] = [];
    for (const handle of Array.from(this.handles.keys())) this.closeForDispose(handle, failures);
    this.handles.clear();
    this.unaccepted.clear();
    this.listenerPorts.clear();
    this.fileWrite = null;
    this.ring.wake();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Network host disposal failed");
  }

  private closeForDispose(handle: number, failures: unknown[]): void {
    try {
      this.close(handle);
    } catch (error) {
      failures.push(error);
    }
  }

  private tcpError(status: number): NetError {
    const codes: Record<number, string> = {
      [TCP_IN_USE]: "EADDRINUSE",
      [TCP_REFUSED]: "ECONNREFUSED",
      [TCP_PIPE]: "EPIPE",
      [TCP_INVALID]: "EINVAL",
      [TCP_RESET]: "ECONNRESET",
      [UNSUPPORTED]: "ENOTSUP",
    };
    const code = codes[status] ?? "ECANCELED";
    return {
      name: "Error",
      message: `${status === TCP_RESET ? "outbound" : "loopback"} TCP: ${code}`,
      code,
    };
  }

  private call(request: TcpCommand, transfer: Transferable[] = []): [number, number] {
    const reply = allocateSharedControl(12);
    const cells = new Int32Array(reply);
    this.send({ ...request, reply }, transfer);
    while (Atomics.load(cells, 0) === 0) Atomics.wait(cells, 0, 0);
    return [Atomics.load(cells, 1), Atomics.load(cells, 2)];
  }

  private listenShared(host: string, port: number, address: Omit<PeerAddr, "port">): number {
    const id = this.nextHandle++;
    const [status, bound] = this.call({ type: "tcp-listen", id, host, port });
    if (status < 0) return this.fail(this.tcpError(status));
    this.handles.set(id, {
      kind: "listener",
      local: { ...address, port: bound },
      pending: [],
      error: null,
    });
    return id;
  }

  private connectShared(target: Omit<PeerAddr, "port">, port: number): number {
    const id = this.nextHandle++;
    const [status, local] = this.call({ type: "tcp-connect", id, host: target.address, port });
    if (status < 0) return this.fail(this.tcpError(status));
    this.handles.set(id, {
      kind: "conn",
      local: { ...target, port: local },
      peer: { ...target, port },
      pipe: null,
      connecting: false,
      chunks: [],
      ended: false,
      error: null,
    });
    return id;
  }

  private connection(handle: number): ConnHandle | undefined {
    const h = this.handles.get(handle) ?? this.unaccepted.get(handle);
    return h?.kind === "conn" ? h : undefined;
  }

  localPort(handle: number): number {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind !== "conn" && h?.kind !== "listener") return BADF;
    return h.local.family === "Unix" ? UNSUPPORTED : h.local.port;
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
    this.send({ type: "tcp-accept", id: conn, listener });
    return conn;
  }

  error(handle: number): string | number {
    this.drain();
    const err = handle === 0 ? this.lastError : (this.handles.get(handle)?.error ?? null);
    if (handle !== 0 && !this.handles.has(handle)) return BADF;
    return JSON.stringify(err ?? { name: "Error", message: "no error" });
  }

  peerAddr(handle: number): string | number {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind !== "conn") return BADF;
    if (h.connecting || !h.peer)
      return this.fail({ name: "Error", message: "socket is not connected", code: "ENOTCONN" });
    return JSON.stringify(h.peer);
  }

  // ---------- events from the helper ----------

  private drain(): void {
    if (this.disposed) return;
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
    if (kind === Kind.Open) {
      this.onOpen(handle, payload);
      return;
    }
    // Events for handles the guest already closed are dropped.
    const h = this.handles.get(handle) ?? this.unaccepted.get(handle);
    if (!h || h.kind === "listener") return;
    if (h.kind === "lookup") {
      if (kind === Kind.Data) h.chunks.push(payload);
      if (kind === Kind.LookupHead) h.head = this.lookupPayload(h, payload);
      if (kind === Kind.Error)
        h.error = JSON.parse(decoder.decode(this.lookupPayload(h, payload))) as NetError;
      return;
    }
    if (kind === Kind.Head && h.kind === "fetch") h.head = payload;
    else if (kind === Kind.Data) {
      if (h.kind === "conn" && h.readEnded)
        this.send({ type: "tcp-read", id: handle, bytes: payload.length });
      else h.chunks.push(payload);
    } else if (kind === Kind.End) h.ended = true;
    else if (kind === Kind.Error) {
      h.error = JSON.parse(decoder.decode(payload)) as NetError;
      if (h.kind === "conn") h.connecting = false;
    }
  }

  private lookupPayload(state: LookupHandle, payload: Uint8Array): Uint8Array {
    if (state.chunks.length === 0) return payload;
    state.chunks.push(payload);
    const bytes = new Uint8Array(state.chunks.reduce((size, chunk) => size + chunk.length, 0));
    let at = 0;
    for (const chunk of state.chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    state.chunks = [];
    return bytes;
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
    const { conn, peer, local } = JSON.parse(decoder.decode(payload)) as NewConn;
    const h = this.handles.get(listener);
    if (h?.kind !== "listener") {
      // The listener closed before the connection arrived: refuse it.
      this.send({ type: "close", id: conn });
      return;
    }
    this.unaccepted.set(conn, {
      kind: "conn",
      local,
      peer,
      pipe: null,
      connecting: false,
      chunks: [],
      ended: false,
      error: null,
    });
    h.pending.push(conn);
  }

  private onOpen(handle: number, payload: Uint8Array): void {
    const h = this.handles.get(handle);
    if (h?.kind !== "conn" || !h.connecting) return;
    const opened = JSON.parse(decoder.decode(payload)) as { local: SocketAddr; peer: SocketAddr };
    if (!isPeerAddr(opened.peer) || !isPeerAddr(opened.local, true))
      throw new TypeError("Invalid outbound open record");
    h.local = opened.local;
    h.peer = opened.peer;
    h.connecting = false;
    this.news();
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
  private take(stream: NetworkByteStream, cap: number): Uint8Array {
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
