import type { StreamTransport } from "./tcp-frame-stream.js";
import type { MessageTransport } from "./tcp-message-transport.js";
import { TcpFlow, type CleanupBudget } from "./tcp-flow.js";
import { nativeResetCode } from "./webtransport-native.js";
import { TcpTargetSocket } from "./tcp-target.js";
import { canonicalDestination, destinationKey } from "./tcp-destination.js";
import { base64url, verifyRelayToken } from "./token.js";
import {
  nextTcpId,
  resolveDestination,
  type TcpAdmissions,
  type TcpPolicy,
  type Resolver,
} from "./tcp-policy.js";
import { cancellable, deadline } from "./tcp-async.js";
import {
  DRAIN_MS,
  TcpFailure,
  parseOpen,
  type TcpErrorCode,
  type TcpTarget,
} from "./tcp-protocol.js";
import type { ResetCode } from "./tcp-byte-channel.js";
import type { TcpQueueCounters } from "./tcp-server-stream.js";

export class TcpServerConnection {
  readonly done: Promise<void>;
  private readonly abort = new AbortController();
  private flow: TcpFlow | undefined;
  private openingFailure: Promise<void> | undefined;
  private target: TcpTargetSocket | undefined;
  private handedReply = false;
  private budget: CleanupBudget | undefined;
  private releaseSubject: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private destination: TcpTarget | undefined;
  private subject = "unauthenticated";
  private reason = "carrier-loss";
  private resetCode: ResetCode = 1;
  private started = Date.now();
  private readAhead = 0;
  private readonly id = nextTcpId();
  constructor(
    private transport: StreamTransport | MessageTransport,
    private policy: TcpPolicy,
    private admissions: TcpAdmissions,
    private release: () => void,
    private authenticated: () => void,
    private closeSession: () => void,
    private resolve?: Resolver,
  ) {
    this.transport.setFault((error) =>
      this.fail(error instanceof TcpFailure ? 3 : 1, "carrier-loss"),
    );
    this.done = this.run();
  }
  get counters(): TcpQueueCounters {
    return {
      toTargetBytes: this.flow?.state.queued ?? 0,
      toClientBytes: this.flow ? this.flow.state.handed - this.flow.state.creditApplied : 0,
      readAheadBytes: this.readAhead,
      ...this.flow?.counters,
    };
  }
  revoke(reason: "shutdown" | "certificate-rotation" = "shutdown", budget?: CleanupBudget): void {
    if (budget) this.budget = { remaining: () => budget.remaining(DRAIN_MS) };
    this.fail(4, reason);
  }
  private async run(): Promise<void> {
    try {
      await this.open();
      if (!this.flow) return;
      await Promise.all([
        this.transport.readFrames(this.flow),
        this.upload(),
        this.download(),
        this.flow.done,
      ]);
      this.reason = "fin";
    } catch (error) {
      const code = nativeResetCode(error);
      this.fail(
        code ?? (error instanceof TcpFailure ? 3 : this.resetCode),
        code ? "peer-reset" : this.reason,
      );
    } finally {
      try {
        await this.cleanup();
      } finally {
        this.log("close");
      }
    }
  }
  private async open(): Promise<void> {
    this.timer = setTimeout(
      () => this.fail(3, "header-timeout"),
      this.policy.limits.headerTimeoutMs,
    );
    try {
      const text = await this.wait(this.transport.readHeader(this.policy.limits.maxOpenBytes));
      const request = parseOpen(text, this.policy.limits.maxOpenBytes);
      this.transport.observeOpening();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.openingTimeout(), this.policy.limits.connectTimeoutMs);
      const selected = await this.admit(request);
      this.abort.signal.throwIfAborted();
      this.target = new TcpTargetSocket(selected);
      await this.wait(this.target.connected);
      this.flow = new TcpFlow(this.policy.limits.windowBytes, request.window, this.transport, () =>
        this.activity(),
      );
      this.transport.attach(this.flow);
      await this.wait(
        this.transport.handoffHeader(
          {
            v: 1,
            ok: true,
            window: this.policy.limits.windowBytes,
            remote: {
              address: selected.host,
              port: selected.port,
              family: selected.host.includes(":") ? "IPv6" : "IPv4",
            },
          },
          () => {
            this.handedReply = true;
          },
        ),
      );
      clearTimeout(this.timer);
      this.authenticated();
      this.log("open");
      this.activity();
    } catch (error) {
      await this.rejectOpen(error);
    }
  }
  private async admit(request: ReturnType<typeof parseOpen>): Promise<TcpTarget> {
    const claims = await this.wait(verifyRelayToken(await this.policy.key, request.token));
    this.subject =
      claims.sub ??
      base64url(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.token)),
        ),
      );
    this.abort.signal.throwIfAborted();
    this.releaseSubject = this.admissions.subject(this.subject);
    this.destination = canonicalDestination(request);
    const key = destinationKey(this.destination);
    if (claims.dst && !claims.dst.some((entry) => destinationKey(entry) === key))
      throw new TcpFailure("relay-auth");
    const entry = this.policy.destinations.get(key);
    if (!entry) throw new TcpFailure("destination-denied");
    return this.wait(resolveDestination(entry, this.resolve));
  }
  private async rejectOpen(error: unknown): Promise<void> {
    if (this.abort.signal.aborted || this.handedReply) throw error;
    const code = error instanceof TcpFailure ? error.code : targetError(error);
    this.reason = code;
    await this.wait(this.transport.handoffHeader({ v: 1, ok: false, code }, () => {}));
  }
  private async upload(): Promise<void> {
    for (;;) {
      const bytes = await this.wait(this.flow!.read());
      if (!bytes) break;
      await this.targetIO(this.target!.write(bytes));
      this.flow!.consume(bytes.length);
    }
    await this.wait(this.target!.end());
  }
  private async download(): Promise<void> {
    for (;;) {
      const bytes = await this.targetIO(this.target!.read());
      if (!bytes) break;
      this.readAhead = bytes.length;
      await this.wait(this.flow!.write(bytes));
      this.readAhead = 0;
    }
    await this.wait(this.flow!.fin());
  }
  private async targetIO<T>(promise: Promise<T>): Promise<T> {
    try {
      return await this.wait(promise);
    } catch (error) {
      if (!this.abort.signal.aborted) this.reason = "target-reset";
      throw error;
    }
  }
  private wait<T>(promise: Promise<T>): Promise<T> {
    return cancellable(promise, this.abort.signal);
  }
  private activity(): void {
    clearTimeout(this.idle);
    if (this.policy.limits.idleTimeoutMs)
      this.idle = setTimeout(() => this.fail(2, "idle-timeout"), this.policy.limits.idleTimeoutMs);
  }
  private openingTimeout(): void {
    if (this.handedReply || this.abort.signal.aborted) return;
    this.openingFailure = this.transport.handoffHeader(
      { v: 1, ok: false, code: "target-timeout" },
      () => {},
    );
    void this.openingFailure.catch(() => {});
    this.fail(1, "target-timeout");
  }
  private fail(code: ResetCode, reason: string): void {
    if (this.abort.signal.aborted) return;
    this.reason = reason;
    if (reason === "header-timeout" && this.transport.kind === "websocket")
      this.transport.protocolError();
    const end = performance.now() + DRAIN_MS;
    this.budget ??= { remaining: () => Math.max(0, end - performance.now()) };
    this.resetCode = code;
    this.abort.abort(new TcpFailure("protocol"));
    void this.target?.close();
    void this.flow?.reset(new TcpFailure("protocol"), code, this.budget);
    if (!this.flow && !this.openingFailure)
      void this.transport.reset(code, this.budget).catch(() => {});
  }
  private async cleanup(): Promise<void> {
    clearTimeout(this.timer);
    clearTimeout(this.idle);
    if (this.target) await deadline(this.target.close(), this.budget?.remaining() ?? DRAIN_MS);
    if (this.openingFailure)
      await deadline(this.openingFailure, this.budget?.remaining() ?? DRAIN_MS);
    if (this.reason !== "fin") {
      const reset = this.flow
        ? this.flow.reset(new TcpFailure("protocol"), this.resetCode, this.budget)
        : this.transport.reset(this.resetCode, this.budget);
      try {
        await deadline(reset, this.budget?.remaining() ?? DRAIN_MS);
      } catch (error) {
        this.closeSession();
        throw error;
      }
    }
    this.releaseSubject?.();
    this.release();
    this.readAhead = 0;
  }
  private log(event: "open" | "close"): void {
    try {
      this.policy.log({
        event,
        time: new Date().toISOString(),
        id: this.id,
        sub: this.subject,
        ...(this.destination ? { destination: this.destination } : {}),
        carrier: this.transport.kind,
        sentBytes: this.flow?.state.handed ?? 0,
        receivedBytes: this.flow?.state.received ?? 0,
        durationMs: Date.now() - this.started,
        ...(event === "close"
          ? { reason: this.reason, ...(this.reason === "fin" ? {} : { resetCode: this.resetCode }) }
          : {}),
      });
    } catch {}
  }
}
function targetError(error: unknown): TcpErrorCode {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ECONNREFUSED") return "target-refused";
    if (error.code === "ETIMEDOUT") return "target-timeout";
  }
  return "target-unreachable";
}
