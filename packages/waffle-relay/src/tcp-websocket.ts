import {
  DRAIN_MS,
  MAX_DATA_BYTES,
  RelayConnectError,
  TcpState,
  connectError,
  frameCredit,
  frameData,
  parseFrame,
  parseReply,
  type TcpStream,
  type TcpTarget,
} from "./tcp-protocol.js";

export interface WebSocketEvents {
  open(): void;
  message(data: unknown): void;
  close(code: number): void;
  error(): void;
}
/** Trusted host adapter, not a guest capability. */
export interface ClientWebSocket {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code: number): void;
  listen(events: WebSocketEvents): () => void;
  terminate?(): void;
}
function browserWebSocket(url: string): ClientWebSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    listen(events) {
      const message = (event: MessageEvent<unknown>) => events.message(event.data);
      const close = (event: CloseEvent) => events.close(event.code);
      ws.addEventListener("open", events.open);
      ws.addEventListener("message", message);
      ws.addEventListener("close", close);
      ws.addEventListener("error", events.error);
      return () => {
        ws.removeEventListener("open", events.open);
        ws.removeEventListener("message", message);
        ws.removeEventListener("close", close);
        ws.removeEventListener("error", events.error);
      };
    },
  };
}
export function openWebSocket(options: {
  endpoint: string;
  factory?: (url: string) => ClientWebSocket;
  destination: TcpTarget;
  token: string;
  signal: AbortSignal;
  windowBytes: number;
}): { opened: Promise<TcpStream>; closed: Promise<void> } {
  const connection = new ClientTcpStream(options);
  return { opened: connection.opened, closed: connection.closed };
}
class ClientTcpStream {
  private ready = Promise.withResolvers<TcpStream>();
  private complete = Promise.withResolvers<void>();
  readonly opened = this.ready.promise;
  readonly closed = this.complete.promise;
  private ws: ClientWebSocket;
  private state: TcpState;
  private chunks: Uint8Array[] = [];
  private queued = 0;
  private reader: ReadableStreamDefaultController<Uint8Array> | undefined;
  private readRequested = false;
  private readEnded = false;
  private discarding = false;
  private readable: ReadableStream<Uint8Array>;
  private writable: WritableStream<Uint8Array>;
  private writer: WritableStreamDefaultController | undefined;
  private wake: (() => void) | undefined;
  private failure: unknown;
  private drain: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private detach: () => void;
  private abort: () => void;
  private signal: AbortSignal;
  private finished = false;
  constructor(options: Parameters<typeof openWebSocket>[0]) {
    this.state = new TcpState(options.windowBytes);
    this.signal = options.signal;
    this.ws = (options.factory ?? browserWebSocket)(options.endpoint);
    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.reader = controller;
        },
        pull: () => {
          this.readRequested = true;
          this.deliver();
        },
        cancel: () => this.cancelRead(),
      },
      { highWaterMark: 0 },
    );
    this.writable = new WritableStream<Uint8Array>(
      {
        start: (controller) => {
          this.writer = controller;
        },
        write: (bytes) => this.write(bytes),
        close: () => {
          this.state.fin();
          this.ws.send(new Uint8Array([1]));
          this.startDrain();
          this.graceful();
        },
        abort: () => this.reset(),
      },
      { highWaterMark: 1 },
    );
    this.abort = () => this.reset(this.signal.reason);
    this.detach = this.ws.listen({
      open: () => {
        if (this.state.phase !== "opening") return;
        const text = JSON.stringify({ v: 1, token: options.token, ...options.destination });
        if (new TextEncoder().encode(text).length > 8192) {
          this.reset(new RelayConnectError("EACCES"));
          return;
        }
        this.ws.send(text);
      },
      message: (data) => {
        try {
          this.message(data);
        } catch {
          this.reset(new RelayConnectError("ECONNRESET"), 1008);
        }
      },
      error: () =>
        this.reset(
          new RelayConnectError(this.state.phase === "opening" ? "ENETUNREACH" : "ECONNRESET"),
        ),
      close: (code) => {
        if (code !== 1000 || !this.state.drained)
          this.reset(
            new RelayConnectError(
              code === 1008 || this.state.phase !== "opening" ? "ECONNRESET" : "ENETUNREACH",
            ),
          );
        this.finish();
      },
    });
    this.signal.addEventListener("abort", this.abort, { once: true });
    if (this.signal.aborted) this.abort();
  }
  private message(data: unknown): void {
    if (this.state.phase === "closed") return;
    if (this.state.phase === "opening") {
      if (typeof data !== "string") throw new Error("protocol");
      const reply = parseReply(data);
      if (!reply.ok) {
        this.reset(connectError(reply.code));
        return;
      }
      this.state.open();
      const counters = () => ({
        receiveQueuedBytes: this.queued,
        sendOutstandingBytes: this.state.windowBytes - this.state.sendCredit,
      });
      this.ready.resolve({
        readable: this.readable,
        writable: this.writable,
        remote: reply.remote,
        get counters() {
          return counters();
        },
      });
      return;
    }
    if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array))
      throw new Error("protocol");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const frame = parseFrame(bytes);
    this.state.receive(frame);
    if (frame.kind === "credit") {
      this.wake?.();
      this.graceful();
      return;
    }
    if (frame.kind === "fin") {
      this.deliver();
      this.startDrain();
      this.graceful();
      return;
    }
    if (this.discarding) {
      this.state.consumed(frame.bytes.length);
      this.ws.send(frameCredit(frame.bytes.length));
      this.graceful();
      return;
    }
    this.chunks.push(frame.bytes);
    this.queued += frame.bytes.length;
    this.deliver();
  }
  private deliver(): void {
    if (this.readEnded || this.state.phase !== "open") return;
    if (this.readRequested && this.chunks.length) {
      const bytes = this.chunks.shift()!;
      this.queued -= bytes.length;
      this.readRequested = false;
      this.reader!.enqueue(bytes);
      this.state.consumed(bytes.length);
      this.ws.send(frameCredit(bytes.length));
      this.graceful();
    }
    if (!this.chunks.length && this.state.remoteFin && !this.readEnded) {
      this.readEnded = true;
      this.reader!.close();
    }
  }
  private cancelRead(): Promise<void> {
    if (!this.state.localFin || this.state.phase !== "open") return this.reset();
    this.readEnded = true;
    this.discarding = true;
    if (this.queued) {
      this.state.consumed(this.queued);
      this.ws.send(frameCredit(this.queued));
      this.chunks.length = 0;
      this.queued = 0;
    }
    this.graceful();
    return this.closed;
  }
  private async write(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("TCP writes require bytes");
    for (let offset = 0; offset < bytes.length;) {
      await this.writableCredit();
      const length = Math.min(bytes.length - offset, MAX_DATA_BYTES, this.state.sendCredit);
      this.state.send(length);
      this.ws.send(frameData(bytes.subarray(offset, offset + length)));
      offset += length;
    }
  }
  private async writableCredit(): Promise<void> {
    while (
      this.state.phase === "open" &&
      (!this.state.sendCredit || this.ws.bufferedAmount > MAX_DATA_BYTES)
    ) {
      await new Promise<void>((resolve) => {
        this.wake = () => {
          clearTimeout(this.poll);
          this.wake = undefined;
          resolve();
        };
        // bufferedAmount has no browser drain event. One bounded waiter polls it.
        if (this.ws.bufferedAmount > MAX_DATA_BYTES) this.poll = setTimeout(this.wake, 4);
      });
    }
    if (this.state.phase !== "open") throw this.failure ?? new RelayConnectError("ECONNRESET");
  }
  private startDrain(): void {
    this.drain ??= setTimeout(() => this.reset(), DRAIN_MS);
  }
  private graceful(): void {
    if (!this.state.drained || !this.state.close()) return;
    clearTimeout(this.drain);
    this.ws.close(1000);
    this.drain = setTimeout(() => {
      this.ws.terminate?.();
      this.finish();
    }, DRAIN_MS);
  }
  private reset(reason: unknown = new RelayConnectError("ECONNRESET"), code = 4001): Promise<void> {
    if (!this.state.close()) return this.closed;
    this.failure = reason;
    this.ready.reject(reason);
    this.writer!.error(reason);
    if (!this.readEnded) {
      this.readEnded = true;
      this.reader!.error(reason);
    }
    this.chunks.length = 0;
    this.queued = 0;
    this.wake?.();
    clearTimeout(this.poll);
    clearTimeout(this.drain);
    this.ws.close(code);
    this.drain = setTimeout(() => {
      this.ws.terminate?.();
      this.finish();
    }, DRAIN_MS);
    return this.closed;
  }
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.state.close();
    this.state.sendCredit = this.state.windowBytes;
    this.state.receiveCredit = this.state.windowBytes;
    clearTimeout(this.drain);
    clearTimeout(this.poll);
    this.signal.removeEventListener("abort", this.abort);
    this.detach();
    this.complete.resolve();
  }
}
