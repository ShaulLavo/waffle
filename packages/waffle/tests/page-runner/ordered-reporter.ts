import { record, resultByteLimit } from "./protocol.js";
import { hostReply, type HostReply, type ReportingFailure } from "./report-control.js";
export type Observation = {
  doc: string;
  ackedThrough: number;
  pending: number;
  failure: string | null;
  retired: boolean;
};
declare global {
  interface Window {
    __pageRunner: Observation;
  }
}
export class OrderedReporter<B extends object> {
  readonly clock = {
    now: performance.now.bind(performance),
    timeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    interval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    abortTimeout: AbortSignal.timeout.bind(AbortSignal),
  };
  readonly observation: Observation = {
    doc: crypto.randomUUID(),
    ackedThrough: -1,
    pending: 0,
    failure: null,
    retired: false,
  };
  private readonly admission = new AbortController();
  private readonly delivery = new AbortController();
  private converting = false;
  private failureCategory: ReportingFailure | null = null;
  get signal(): AbortSignal {
    return this.admission.signal;
  }
  closeAdmission(category: ReportingFailure, detail: string): void {
    this.failureCategory ??= category;
    this.observation.failure ??= detail;
    if (!this.signal.aborted) this.admission.abort(new Error(detail));
  }
  cancelDelivery(detail: string): void {
    this.closeAdmission("cancelled", detail);
    if (!this.delivery.signal.aborted) this.delivery.abort(new Error(detail));
  }
  private sequence = 0;
  private tail = Promise.resolve();
  private heartbeatBusy = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    readonly run: string,
    readonly post: (input: string, init: RequestInit) => Promise<Response> = globalThis.fetch.bind(
      globalThis,
    ),
    readonly retryMs = 10_000,
    readonly identity: { token?: string; role?: string } = {},
  ) {}
  send(body: B): Promise<void> {
    return this.sendSnapshot(() => body);
  }
  sendSnapshot(snapshot: () => B | null): Promise<void> {
    if (this.converting) {
      this.closeAdmission("conversion", "Reporter conversion reentry refused");
      return Promise.reject(this.signal.reason);
    }
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    if (this.observation.retired) return Promise.reject(new Error("Document retired"));
    if (this.observation.pending >= 64) {
      this.closeAdmission("capacity", "Reporter outbox capacity exceeded");
      return Promise.reject(this.signal.reason);
    }
    this.observation.pending++;
    this.converting = true;
    let encoded: string;
    try {
      const body = snapshot();
      this.signal.throwIfAborted();
      if (body === null) {
        this.observation.pending--;
        return Promise.resolve();
      }
      encoded = JSON.stringify({
        ...body,
        run: this.run,
        doc: this.observation.doc,
        seq: this.sequence,
      });
      this.signal.throwIfAborted();
      if (new TextEncoder().encode(encoded).byteLength > resultByteLimit)
        throw new Error("Report envelope exceeds 48 KiB");
    } catch (error) {
      this.observation.pending--;
      this.closeAdmission("conversion", "Reporter snapshot conversion or encoding failed");
      return Promise.reject(error);
    } finally {
      this.converting = false;
    }
    const seq = this.sequence++;
    const next = this.tail.then(() => this.deliver(encoded, seq));
    const owned = next.finally(() => {
      this.observation.pending--;
    });
    this.tail = owned.catch((error: unknown) => {
      this.cancelDelivery("Reporter delivery failed");
      throw error;
    });
    void this.tail.catch(() => {});
    return owned;
  }
  private async deliver(encoded: string, seq: number): Promise<void> {
    const deadline = this.clock.now() + this.retryMs;
    let last: unknown;
    while (this.clock.now() < deadline) {
      try {
        this.delivery.signal.throwIfAborted();
        await this.attempt(encoded, seq);
        return;
      } catch (error) {
        this.delivery.signal.throwIfAborted();
        last = error;
      }
      await new Promise((resolve) => this.clock.timeout(resolve, 100));
    }
    throw new Error(`Report acknowledgement lost: ${String(last)}`);
  }
  private async attempt(encoded: string, seq: unknown): Promise<void> {
    const response = await this.post("/report", {
      method: "POST",
      body: encoded,
      signal: AbortSignal.any([
        this.delivery.signal,
        this.clock.abortTimeout(Math.min(1500, this.retryMs)),
      ]),
    });
    const ack: unknown = await response.json();
    if (!response.ok || !record(ack) || ack.ackedThrough !== seq || typeof seq !== "number")
      throw new Error("Invalid collector acknowledgement");
    this.delivery.signal.throwIfAborted();
    this.observation.ackedThrough = seq;
  }
  startHeartbeat(interval = 1000): void {
    this.timer = this.clock.interval(() => {
      void this.heartbeat();
    }, interval);
  }
  private async heartbeat(): Promise<void> {
    if (this.heartbeatBusy || this.observation.retired) return;
    this.heartbeatBusy = true;
    try {
      const response = await this.post("/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          kind: "heartbeat",
          run: this.run,
          doc: this.observation.doc,
          ...this.identity,
          failure: this.failureCategory,
        }),
        signal: this.clock.abortTimeout(1500),
      });
      await this.hostReply(response);
    } catch {
      this.cancelDelivery("Collector heartbeat failed");
    } finally {
      this.heartbeatBusy = false;
    }
  }
  async hostReply(response: Response): Promise<HostReply> {
    const reply: unknown = await response.json();
    if (!response.ok || !hostReply(reply)) {
      this.cancelDelivery("Invalid collector control reply");
      throw new Error("Invalid collector control reply");
    }
    if (reply.kind === "cancelled") this.cancelDelivery("Collector cancelled reporting");
    return reply;
  }
  stop(): void {
    this.clock.clearInterval(this.timer);
  }
  drain(): Promise<void> {
    return this.tail;
  }
}
