import { record } from "./protocol.js";
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
  ) {}
  send(body: B): Promise<void> {
    if (this.observation.retired) return Promise.reject(new Error("Document retired"));
    if (this.observation.pending >= 64) {
      this.observation.failure ??= "Reporter outbox capacity exceeded";
      return Promise.reject(new Error(this.observation.failure));
    }
    const encoded = JSON.stringify({
      run: this.run,
      doc: this.observation.doc,
      seq: this.sequence++,
      ...body,
    });
    this.observation.pending++;
    const next = this.tail.then(() => this.deliver(encoded));
    this.tail = next.catch((error: unknown) => {
      this.observation.failure ??= String(error);
      throw error;
    });
    void this.tail.catch(() => {});
    return next.finally(() => {
      this.observation.pending--;
    });
  }
  private async deliver(encoded: string): Promise<void> {
    const deadline = this.clock.now() + this.retryMs;
    const expected: unknown = JSON.parse(encoded);
    let last: unknown;
    while (this.clock.now() < deadline) {
      try {
        await this.attempt(encoded, record(expected) ? expected.seq : undefined);
        return;
      } catch (error) {
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
      signal: this.clock.abortTimeout(Math.min(1500, this.retryMs)),
    });
    const ack: unknown = await response.json();
    if (!response.ok || !record(ack) || ack.ackedThrough !== seq || typeof seq !== "number")
      throw new Error("Invalid collector acknowledgement");
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
      await this.post("/heartbeat", {
        method: "POST",
        body: JSON.stringify({ kind: "heartbeat", run: this.run, doc: this.observation.doc }),
        signal: this.clock.abortTimeout(1500),
      });
    } catch {
    } finally {
      this.heartbeatBusy = false;
    }
  }
  stop(): void {
    this.clock.clearInterval(this.timer);
  }
  drain(): Promise<void> {
    return this.tail;
  }
}
