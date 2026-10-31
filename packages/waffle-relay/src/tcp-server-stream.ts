import { Socket } from "node:net";
import { WebSocket } from "ws";
import { canonicalDestination, destinationKey } from "./tcp-destination.js";
import { base64url, verifyRelayToken } from "./token.js";
import {
  resolveDestination,
  type TcpAdmissions,
  type TcpPolicy,
  type TcpLog,
  type Resolver,
} from "./tcp-policy.js";
import {
  DRAIN_MS,
  MAX_DATA_BYTES,
  TcpFailure,
  TcpState,
  frameCredit,
  frameData,
  parseFrame,
  parseOpen,
  type TcpTarget,
  type TcpErrorCode,
} from "./tcp-protocol.js";

export interface TcpQueueCounters {
  readonly toTargetBytes: number;
  readonly toClientBytes: number;
  readonly readAheadBytes: number;
}
let nextId = 0;
export class ServerTcpStream {
  readonly done: Promise<void>;
  private complete = Promise.withResolvers<void>();
  private state: TcpState;
  private target: Socket | undefined;
  private readAhead: Uint8Array | undefined;
  private readOffset = 0;
  private readLength = 0;
  private opening = false;
  private socketClosed = true;
  private carrierClosed = false;
  private settled = false;
  private timer: ReturnType<typeof setTimeout>;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseSubject: (() => void) | undefined;
  private abort = new AbortController();
  private destination: TcpTarget | undefined;
  private subject = "unauthenticated";
  private started = Date.now();
  private id = ++nextId;
  private sent = 0;
  private received = 0;
  private reason = "carrier-loss";
  constructor(
    private ws: WebSocket,
    private policy: TcpPolicy,
    private admissions: TcpAdmissions,
    private release: () => void,
    private resolve?: Resolver,
  ) {
    this.done = this.complete.promise;
    this.state = new TcpState(policy.limits.windowBytes);
    this.timer = setTimeout(() => this.fail(1008, "header-timeout"), policy.limits.headerTimeoutMs);
    ws.on("message", (data, binary) => {
      try {
        this.message(data, binary);
      } catch {
        this.fail(1008, "protocol");
      }
    });
    ws.on("error", () => this.fail(4001, "carrier-loss"));
    ws.once("close", () => {
      this.carrierClosed = true;
      this.fail(4001, "carrier-loss");
      this.settle();
    });
  }
  get counters(): TcpQueueCounters {
    return {
      toTargetBytes: this.state.windowBytes - this.state.receiveCredit,
      toClientBytes: this.state.windowBytes - this.state.sendCredit,
      readAheadBytes: this.readLength - this.readOffset,
    };
  }
  revoke(): void {
    this.fail(4004, "shutdown");
  }
  private message(raw: import("ws").RawData, binary: boolean): void {
    if (this.state.phase === "closed") return;
    if (this.state.phase === "opening") {
      if (
        binary ||
        this.opening ||
        !(raw instanceof Uint8Array) ||
        raw.length > this.policy.limits.maxOpenBytes
      )
        throw new TcpFailure("protocol");
      const text = raw.toString();
      const request = parseOpen(text, this.policy.limits.maxOpenBytes);
      this.opening = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(
        () => this.failOpening("target-timeout"),
        this.policy.limits.connectTimeoutMs,
      );
      void this.open(request).finally(() => {
        this.opening = false;
        this.settle();
      });
      return;
    }
    if (!binary || !(raw instanceof Uint8Array)) throw new TcpFailure("protocol");
    const frame = parseFrame(raw);
    this.state.receive(frame);
    if (frame.kind === "credit") {
      this.pump();
      this.graceful();
      return;
    }
    if (frame.kind === "fin") {
      this.target!.end();
      this.startDrain();
      this.graceful();
      return;
    }
    this.received += frame.bytes.length;
    this.activity();
    this.target!.write(frame.bytes, (error) => {
      if (this.state.phase !== "open") return;
      if (error) {
        this.fail(4001, "target-reset");
        return;
      }
      this.state.consumed(frame.bytes.length);
      this.ws.send(frameCredit(frame.bytes.length));
      this.graceful();
    });
  }
  private async open(request: ReturnType<typeof parseOpen>): Promise<void> {
    try {
      const claims = await this.bounded(verifyRelayToken(await this.policy.key, request.token));
      this.subject =
        claims.sub ??
        base64url(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.token)),
          ),
        );
      if (this.abort.signal.aborted) return;
      this.releaseSubject = this.admissions.subject(this.subject);
      this.destination = canonicalDestination(request);
      const key = destinationKey(this.destination);
      if (claims.dst && !claims.dst.some((entry) => destinationKey(entry) === key))
        throw new TcpFailure("relay-auth");
      const entry = this.policy.destinations.get(key);
      if (!entry) throw new TcpFailure("destination-denied");
      const selected = await this.bounded(resolveDestination(entry, this.resolve));
      if (this.abort.signal.aborted) return;
      await this.dial(selected);
      if (this.abort.signal.aborted) return;
      clearTimeout(this.timer);
      this.state.open();
      this.ws.send(
        JSON.stringify({
          v: 1,
          ok: true,
          remote: {
            address: selected.host,
            port: selected.port,
            family: selected.host.includes(":") ? "IPv6" : "IPv4",
          },
        }),
      );
      this.log("open");
      this.activity();
      this.pump();
    } catch (error) {
      if (this.state.phase === "closed") return;
      const code = error instanceof TcpFailure ? error.code : targetError(error);
      this.ws.send(JSON.stringify({ v: 1, ok: false, code }));
      this.fail(1000, code);
    }
  }
  private async bounded<T>(promise: Promise<T>): Promise<T> {
    const signal = this.abort.signal;
    if (signal.aborted) {
      void promise.catch(() => {});
      throw new TcpFailure("target-timeout");
    }
    const cancellation = Promise.withResolvers<never>();
    const abort = () => cancellation.reject(new TcpFailure("target-timeout"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([promise, cancellation.promise]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private dial(target: TcpTarget): Promise<void> {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.failOpening("target-timeout"),
      this.policy.limits.connectTimeoutMs,
    );
    const socketOptions = {
      allowHalfOpen: true,
      onread: {
        buffer: new Uint8Array(MAX_DATA_BYTES),
        callback: (length: number, buffer: Uint8Array) => {
          this.readAhead = buffer;
          this.readOffset = 0;
          this.readLength = length;
          queueMicrotask(() => this.pump());
          return false;
        },
      },
    };
    const socket = new Socket(socketOptions);
    this.target = socket;
    this.socketClosed = false;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);
    socket.on("error", () => {
      if (this.state.phase === "open") this.fail(4001, "target-reset");
    });
    socket.once("close", () => {
      this.socketClosed = true;
      if (this.state.phase === "open" && !(this.state.localFin && this.state.remoteFin))
        this.fail(4001, "target-reset");
      this.settle();
    });
    socket.once("end", () => {
      if (this.state.phase !== "open") return;
      this.state.fin();
      this.ws.send(new Uint8Array([1]));
      this.startDrain();
      this.graceful();
    });
    return this.bounded(
      new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.connect({ host: target.host, port: target.port }, () => {
          socket.removeListener("error", reject);
          resolve();
        });
      }),
    );
  }
  private failOpening(code: TcpErrorCode): void {
    if (this.state.phase !== "opening") return;
    this.ws.send(JSON.stringify({ v: 1, ok: false, code }));
    this.fail(1000, code);
  }
  private pump(): void {
    const socket = this.target;
    if (!socket || this.state.phase !== "open" || this.state.localFin) return;
    while (
      this.readAhead &&
      this.readOffset < this.readLength &&
      this.state.sendCredit > 0 &&
      this.ws.bufferedAmount <= MAX_DATA_BYTES
    ) {
      const size = Math.min(
        MAX_DATA_BYTES,
        this.state.sendCredit,
        this.readLength - this.readOffset,
      );
      const bytes = this.readAhead.subarray(this.readOffset, this.readOffset + size);
      this.readOffset += size;
      this.state.send(size);
      this.sent += size;
      this.activity();
      this.ws.send(frameData(bytes), (error) => {
        if (error) this.fail(4001, "carrier-loss");
        else this.pump();
      });
    }
    if (
      this.readOffset === this.readLength &&
      this.state.sendCredit > 0 &&
      this.ws.bufferedAmount <= MAX_DATA_BYTES
    )
      socket.resume();
  }

  private activity(): void {
    clearTimeout(this.idleTimer);
    if (this.policy.limits.idleTimeoutMs)
      this.idleTimer = setTimeout(
        () => this.fail(4002, "idle-timeout"),
        this.policy.limits.idleTimeoutMs,
      );
  }
  private startDrain(): void {
    this.drainTimer ??= setTimeout(() => this.fail(4001, "drain-timeout"), DRAIN_MS);
  }
  private graceful(): void {
    if (this.state.drained) this.fail(1000, "fin");
  }
  private fail(code: number, reason: string): void {
    if (!this.state.close()) return;
    this.reason = reason;
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.drainTimer);
    this.abort.abort();
    this.target?.destroy();
    this.ws.close(code);
    if (!this.carrierClosed) this.drainTimer = setTimeout(() => this.ws.terminate(), DRAIN_MS);
    this.settle();
  }
  private settle(): void {
    if (
      this.settled ||
      this.state.phase !== "closed" ||
      this.opening ||
      !this.socketClosed ||
      !this.carrierClosed
    )
      return;
    this.settled = true;
    clearTimeout(this.drainTimer);
    this.releaseSubject?.();
    this.release();
    this.log("close");
    this.complete.resolve();
    this.readAhead = undefined;
    this.readOffset = 0;
    this.readLength = 0;
  }
  private log(event: TcpLog["event"]): void {
    try {
      this.policy.log({
        event,
        time: new Date().toISOString(),
        id: this.id,
        sub: this.subject,
        ...(this.destination ? { destination: this.destination } : {}),
        carrier: "websocket",
        sentBytes: this.sent,
        receivedBytes: this.received,
        durationMs: Date.now() - this.started,
        ...(event === "close" ? { reason: this.reason } : {}),
      });
    } catch {
      /* A collector cannot retain socket ownership. */
    }
  }
}
function targetError(error: unknown): TcpErrorCode {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ECONNREFUSED") return "target-refused";
    if (error.code === "ETIMEDOUT") return "target-timeout";
  }
  return "target-unreachable";
}
