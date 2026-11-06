import { record, type Body } from "./protocol.js";
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
export class Reporter {
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
    readonly post: (input: string, init: RequestInit) => Promise<Response> = (input, init) =>
      fetch(input, init),
    readonly retryMs = 10_000,
  ) {
    window.__pageRunner = this.observation;
  }
  send(body: Body): Promise<void> {
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
    const deadline = performance.now() + this.retryMs;
    const expected: unknown = JSON.parse(encoded);
    let last: unknown;
    while (performance.now() < deadline) {
      try {
        await this.attempt(encoded, record(expected) ? expected.seq : undefined);
        return;
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Report acknowledgement lost: ${String(last)}`);
  }
  private async attempt(encoded: string, seq: unknown): Promise<void> {
    const response = await this.post("/report", {
      method: "POST",
      body: encoded,
      signal: AbortSignal.timeout(Math.min(1500, this.retryMs)),
    });
    const ack: unknown = await response.json();
    if (!response.ok || !record(ack) || ack.ackedThrough !== seq || typeof seq !== "number")
      throw new Error("Invalid collector acknowledgement");
    this.observation.ackedThrough = seq;
  }
  startHeartbeat(interval = 1000): void {
    this.timer = setInterval(() => {
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
        signal: AbortSignal.timeout(1500),
      });
    } catch {
    } finally {
      this.heartbeatBusy = false;
    }
  }
  async readyForRetirement(): Promise<void> {
    const url = `/retire?run=${encodeURIComponent(this.run)}&doc=${encodeURIComponent(this.observation.doc)}`;
    while (!this.observation.retired) {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const command: unknown = await response.json();
      if (command === true) {
        await this.send({ kind: "retire-ready" });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  stop(): void {
    clearInterval(this.timer);
  }
  drain(): Promise<void> {
    return this.tail;
  }
}
