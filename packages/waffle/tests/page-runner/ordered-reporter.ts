import {
  reportChunk,
  reportChunkLength,
  reportEventByteLimit,
  reportQueuedByteLimit,
  type ReportIdentity,
} from "./report-chunks.js";
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
    abortAny: AbortSignal.any.bind(AbortSignal),
  };
  readonly observation: Observation = {
    doc: crypto.randomUUID(),
    ackedThrough: -1,
    pending: 0,
    failure: null,
    retired: false,
  };
  private readonly encoder = new TextEncoder();
  private readonly encode = this.encoder.encode.bind(this.encoder);
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
  private queuedBytes = 0;
  private sequence = 0;
  private tail = Promise.resolve();
  private heartbeatBusy = false;
  private heartbeatEnabled = false;
  private heartbeatTask: Promise<void> | undefined;
  private controlCount = 0;
  private controlDrain = Promise.resolve();
  private controlSettled: (() => void) | undefined;
  get controlsPending(): number {
    return this.controlCount + Number(this.heartbeatBusy);
  }
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
    let bytes: number;
    let identity: ReportIdentity;
    try {
      const body = snapshot();
      this.signal.throwIfAborted();
      if (body === null) {
        this.observation.pending--;
        return Promise.resolve();
      }
      identity = {
        run: this.run,
        doc: this.observation.doc,
        seq: this.sequence,
        token: this.identity.token,
      };
      encoded = JSON.stringify({
        ...body,
        run: this.run,
        doc: this.observation.doc,
        seq: this.sequence,
      });
      this.signal.throwIfAborted();
      bytes = this.encode(encoded).byteLength;
      if (bytes > reportEventByteLimit) throw new Error("Report event exceeds 4 MiB");
      if (this.queuedBytes + bytes > reportQueuedByteLimit) {
        this.closeAdmission("capacity", "Reporter queued byte capacity exceeded");
        throw this.signal.reason;
      }
      if (bytes > resultByteLimit) {
        const snapshot: unknown = JSON.parse(encoded);
        if (
          !record(snapshot) ||
          (snapshot.token !== undefined && typeof snapshot.token !== "string")
        )
          throw new Error("Invalid chunked report identity");
        identity.token = snapshot.token;
      }
      if (bytes > resultByteLimit) this.checkEnvelope(reportChunk(encoded, identity, bytes, 0));
      this.signal.throwIfAborted();
    } catch (error) {
      this.observation.pending--;
      this.closeAdmission("conversion", "Reporter snapshot conversion or encoding failed");
      return Promise.reject(error);
    } finally {
      this.converting = false;
    }
    this.queuedBytes += bytes;
    this.sequence++;
    const next = this.tail.then(() => this.deliverReport(encoded, bytes, identity));
    const owned = next.finally(() => {
      this.observation.pending--;
      this.queuedBytes -= bytes;
    });
    this.tail = owned.catch((error: unknown) => {
      this.cancelDelivery("Reporter delivery failed");
      throw error;
    });
    void this.tail.catch(() => {});
    return owned;
  }
  private checkEnvelope(encoded: string): void {
    if (this.encode(encoded).byteLength > resultByteLimit)
      throw new Error("Report envelope exceeds 48 KiB");
  }
  private async deliverReport(
    encoded: string,
    bytes: number,
    identity: ReportIdentity,
  ): Promise<void> {
    const seq = identity.seq;
    const deadline = this.clock.now() + this.retryMs;
    if (bytes <= resultByteLimit) return this.deliver(encoded, seq, deadline);
    for (let offset = 0; offset < encoded.length; offset += reportChunkLength) {
      const part = reportChunk(encoded, identity, bytes, offset);
      this.checkEnvelope(part);
      const end = Math.min(encoded.length, offset + reportChunkLength);
      await this.deliver(part, end === encoded.length ? seq : seq - 1, deadline, end);
    }
    this.observation.ackedThrough = seq;
  }
  private async deliver(
    encoded: string,
    seq: number,
    deadline: number,
    offset?: number,
  ): Promise<void> {
    let last: unknown;
    while (this.clock.now() < deadline) {
      try {
        this.delivery.signal.throwIfAborted();
        await this.attempt(encoded, seq, offset);
        return;
      } catch (error) {
        this.delivery.signal.throwIfAborted();
        last = error;
      }
      await new Promise((resolve) => this.clock.timeout(resolve, 100));
    }
    throw new Error(`Report acknowledgement lost: ${String(last)}`);
  }
  private async attempt(encoded: string, seq: number, offset?: number): Promise<void> {
    const response = await this.post("/report", {
      method: "POST",
      body: encoded,
      signal: this.clock.abortAny([
        this.delivery.signal,
        this.clock.abortTimeout(Math.min(1500, this.retryMs)),
      ]),
    });
    const ack: unknown = await response.json();
    if (!response.ok || !record(ack) || ack.ackedThrough !== seq || ack.offset !== offset)
      throw new Error("Invalid collector acknowledgement");
    this.delivery.signal.throwIfAborted();
    if (offset === undefined) this.observation.ackedThrough = seq;
  }
  startHeartbeat(interval = 1000): void {
    this.heartbeatEnabled = true;
    this.timer = this.clock.interval(() => {
      if (!this.heartbeatEnabled || this.heartbeatBusy || this.observation.retired) return;
      this.heartbeatBusy = true;
      this.heartbeatTask = this.heartbeat();
    }, interval);
  }
  private async heartbeat(): Promise<void> {
    try {
      await this.control("/heartbeat", {
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
    } catch {
      this.cancelDelivery("Collector heartbeat failed");
    } finally {
      this.heartbeatBusy = false;
    }
  }
  async control(url: string, init: RequestInit): Promise<HostReply> {
    if (this.controlCount++ === 0) {
      const idle = Promise.withResolvers<void>();
      this.controlDrain = idle.promise;
      this.controlSettled = idle.resolve;
    }
    try {
      return await this.hostReply(await this.post(url, init));
    } finally {
      if (--this.controlCount === 0) this.controlSettled?.();
    }
  }
  async hostReply(response: Response): Promise<HostReply> {
    let reply: unknown;
    try {
      reply = await response.json();
    } catch {
      this.cancelDelivery("Invalid collector control reply");
      throw new Error("Invalid collector control reply");
    }
    if (!response.ok || !hostReply(reply)) {
      this.cancelDelivery("Invalid collector control reply");
      throw new Error("Invalid collector control reply");
    }
    if (reply.kind === "cancelled") this.cancelDelivery("Collector cancelled reporting");
    return reply;
  }
  stop(): Promise<void> {
    this.heartbeatEnabled = false;
    this.clock.clearInterval(this.timer);
    return Promise.all([this.controlDrain, this.heartbeatTask]).then(() => {});
  }
  drain(): Promise<void> {
    return this.tail;
  }
}
