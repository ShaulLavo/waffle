import {
  DRAIN_MS,
  MAX_DATA_BYTES,
  TcpFailure,
  TcpState,
  type TcpFrame,
  type TcpFlowCounters,
} from "./tcp-protocol.js";
import { deadline } from "./tcp-async.js";
import type { ResetCode } from "./tcp-byte-channel.js";

export interface CleanupBudget {
  remaining(cap?: number): number;
}
export interface FrameTransport {
  readonly kind: "webtransport" | "websocket";
  write(frame: TcpFrame, handoff: () => void): Promise<void>;
  finish(): Promise<void>;
  reset(code: ResetCode, budget?: CleanupBudget): Promise<void>;
}
class ByteStore {
  private readonly bytes: Uint8Array;
  private start = 0;
  size = 0;
  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }
  append(input: Uint8Array): void {
    if (input.length > this.bytes.length - this.size) throw new TcpFailure("protocol");
    const end = (this.start + this.size) % this.bytes.length;
    const first = Math.min(input.length, this.bytes.length - end);
    this.bytes.set(input.subarray(0, first), end);
    this.bytes.set(input.subarray(first), 0);
    this.size += input.length;
  }
  peek(): Uint8Array {
    const length = Math.min(this.size, MAX_DATA_BYTES);
    const result = new Uint8Array(length);
    const first = Math.min(length, this.bytes.length - this.start);
    result.set(this.bytes.subarray(this.start, this.start + first));
    result.set(this.bytes.subarray(0, length - first), first);
    return result;
  }
  consume(length: number): void {
    if (length > this.size) throw new TcpFailure("protocol");
    this.start = (this.start + length) % this.bytes.length;
    this.size -= length;
  }
}
class FrameWriter {
  private data:
    | { bytes: Uint8Array; receipt: ReturnType<typeof Promise.withResolvers<number>> }
    | undefined;
  private fin: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  private running = false;
  private stopped: unknown;
  private ended = false;
  inFlight: TcpFrame["kind"] | null = null;
  encodedBytes = 0;
  finSettled = false;
  constructor(
    private state: TcpState,
    private transport: FrameTransport,
    private changed: () => void,
    private failed: (error: unknown) => void,
  ) {}
  get idle(): boolean {
    return !this.running && !this.data && !this.inFlight && (!this.fin || this.finSettled);
  }
  send(bytes: Uint8Array): Promise<number> {
    if (this.ended) return Promise.reject(this.stopped);
    if (this.data) throw new Error("Concurrent carrier writes");
    const receipt = Promise.withResolvers<number>();
    this.data = { bytes, receipt };
    this.kick();
    return receipt.promise;
  }
  finish(): Promise<void> {
    if (this.ended) return Promise.reject(this.stopped);
    this.fin ??= Promise.withResolvers<void>();
    this.kick();
    return this.fin.promise;
  }
  stop(error: unknown): void {
    this.ended = true;
    this.stopped = error;
    this.data?.receipt.reject(error);
    this.fin?.reject(error);
  }
  kick(): void {
    if (this.running || this.ended) return;
    this.running = true;
    void this.pump()
      .catch(this.failed)
      .finally(() => {
        this.running = false;
        this.changed();
        if (
          this.state.dueCredit ||
          (this.data && this.state.sendCredit) ||
          (this.fin && !this.finSettled && !this.data)
        )
          this.kick();
      });
  }
  private async pump(): Promise<void> {
    for (;;) {
      if (this.ended) return;
      if (this.state.dueCredit) {
        await this.credit();
        continue;
      }
      if (this.data && this.state.sendCredit) {
        await this.payload();
        continue;
      }
      if (this.fin && !this.finSettled && !this.data) {
        await this.sendFin();
        continue;
      }
      return;
    }
  }
  private async payload(): Promise<void> {
    const item = this.data!;
    const length = Math.min(item.bytes.length, this.state.sendCredit, MAX_DATA_BYTES);
    await this.write({ kind: "data", bytes: item.bytes.subarray(0, length) }, () =>
      this.state.send(length),
    );
    this.data = undefined;
    item.receipt.resolve(length);
  }
  private async credit(): Promise<void> {
    const bytes = this.state.dueCredit;
    await this.write({ kind: "credit", bytes }, () => this.state.creditHanded(bytes));
  }
  private async sendFin(): Promise<void> {
    await this.write({ kind: "fin" }, () => this.state.fin());
    this.finSettled = true;
    this.fin!.resolve();
  }
  private async write(frame: TcpFrame, handoff: () => void): Promise<void> {
    this.inFlight = frame.kind;
    this.encodedBytes =
      frame.kind === "data"
        ? frame.bytes.length + (this.transport.kind === "webtransport" ? 5 : 1)
        : frame.kind === "credit"
          ? 5
          : 1;
    try {
      await this.transport.write(frame, handoff);
    } finally {
      this.inFlight = null;
      this.encodedBytes = 0;
      this.changed();
    }
  }
}
export class TcpFlow {
  readonly state: TcpState;
  readonly done: Promise<void>;
  readonly closed: Promise<void>;
  private readonly complete = Promise.withResolvers<void>();
  private readonly cleanupComplete = Promise.withResolvers<void>();
  private readonly store: ByteStore;
  private readonly writer: FrameWriter;
  private wake: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  private error: unknown;
  private terminal = false;
  private closing = false;
  private discarded = 0;
  private drain: ReturnType<typeof setTimeout> | undefined;
  private drainBudget: CleanupBudget | undefined;
  private resetReceipt: Promise<void> | undefined;
  constructor(
    receiveWindow: number,
    sendWindow: number,
    private transport: FrameTransport,
    private onActivity = () => {},
  ) {
    this.state = new TcpState(receiveWindow);
    this.state.open(sendWindow);
    this.store = new ByteStore(receiveWindow);
    this.writer = new FrameWriter(
      this.state,
      transport,
      () => this.changed(),
      (error) => void this.reset(error, 1),
    );
    this.done = this.complete.promise;
    this.closed = this.cleanupComplete.promise;
    void this.closed.catch(() => {});
    void this.done.catch(() => {});
  }
  get counters(): TcpFlowCounters {
    const state = this.state;
    return {
      receiveQueuedBytes: state.queued,
      sendOutstandingBytes: state.handed - state.creditApplied,
      payloadHandedToCarrier: state.handed,
      payloadReceived: state.received,
      consumerReleased: state.consumedBytes,
      creditHandedToCarrier: state.creditHandedBytes,
      creditApplied: state.creditApplied,
      creditPending: state.pendingCredit,
      receiveCredit: state.receiveCredit,
      sendCredit: state.sendCredit,
      dataMetadataUpperBound:
        (state.handed - state.creditApplied) * (this.transport.kind === "webtransport" ? 5 : 1),
      creditMetadataUpperBound: 25,
      creditPendingSlotBytes: state.pendingCredit ? 5 : 0,
      encodedSlotBytes: this.writer.encodedBytes,
      writeInFlight: this.writer.inFlight,
      discardedBytes: this.discarded,
      failedReceiveBytes: this.terminal && this.error !== undefined ? state.queued : 0,
    };
  }
  startData(length: number): void {
    this.state.reserveData(length);
  }
  data(bytes: Uint8Array): void {
    this.state.dataReceived(bytes.length);
    this.store.append(bytes);
    this.onActivity();
    this.wake?.resolve();
  }
  receive(frame: TcpFrame): void {
    if (frame.kind === "data") {
      this.startData(frame.bytes.length);
      this.data(frame.bytes);
      return;
    }
    this.state.receive(frame);
    this.writer.kick();
    this.changed();
  }
  async read(): Promise<Uint8Array | undefined> {
    while (!this.store.size && !this.state.remoteFin && !this.terminal) {
      this.wake ??= Promise.withResolvers<void>();
      const waiting = this.wake;
      await waiting.promise;
      if (this.wake === waiting) this.wake = undefined;
    }
    if (this.terminal) throw this.error;
    return this.store.size ? this.store.peek() : undefined;
  }
  consume(bytes: number, discarded = false): void {
    this.store.consume(bytes);
    this.state.consumed(bytes);
    if (discarded) this.discarded += bytes;
    this.writer.kick();
    this.changed();
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("TCP writes require bytes");
    for (let offset = 0; offset < bytes.length;) {
      const length = await this.writer.send(bytes.subarray(offset, offset + MAX_DATA_BYTES));
      offset += length;
      this.onActivity();
    }
  }
  fin(): Promise<void> {
    return this.writer.finish();
  }
  fullClose(): void {
    this.startDrain();
  }
  eof(): void {
    if (!this.state.remoteFin || this.state.handed !== this.state.creditApplied)
      throw new TcpFailure("protocol");
  }
  reset(error: unknown, code: ResetCode, budget?: CleanupBudget): Promise<void> {
    if (this.resetReceipt) return this.resetReceipt;
    if (this.terminal) return Promise.resolve();
    this.terminal = true;
    this.error = error;
    clearTimeout(this.drain);
    this.state.close();
    this.writer.stop(error);
    this.wake?.resolve();
    const selected = budget ?? this.drainBudget;
    let receipt: Promise<void>;
    try {
      receipt = this.transport.reset(code, selected);
    } catch (error) {
      receipt = Promise.reject(error);
    }
    void receipt.catch(() => {});
    let ms = DRAIN_MS;
    try {
      ms = (budget ?? this.drainBudget)?.remaining() ?? DRAIN_MS;
    } catch {
      ms = 0;
    }
    this.resetReceipt = deadline(receipt, ms).then(
      () => {
        this.complete.reject(error);
        this.cleanupComplete.resolve();
      },
      () => {
        const debt = new Error("TCP carrier cleanup is unsettled");
        this.complete.reject(debt);
        this.cleanupComplete.reject(debt);
        throw debt;
      },
    );
    void this.resetReceipt.catch(() => {});
    return this.resetReceipt;
  }
  private changed(): void {
    this.wake?.resolve();
    if (this.state.localFin && this.state.remoteFin) this.startDrain();
    if (
      this.terminal ||
      this.closing ||
      !this.state.drained ||
      !this.writer.idle ||
      !this.writer.finSettled
    )
      return;
    this.closing = true;
    void Promise.resolve()
      .then(() => (this.terminal ? undefined : this.transport.finish()))
      .then(
        () => {
          if (this.terminal) return;
          this.terminal = true;
          clearTimeout(this.drain);
          this.state.close();
          this.complete.resolve();
          this.cleanupComplete.resolve();
        },
        (error) => this.reset(error, 1),
      );
  }
  private startDrain(): void {
    if (this.drain) return;
    const end = performance.now() + DRAIN_MS;
    this.drainBudget = {
      remaining() {
        return Math.max(0, end - performance.now());
      },
    };
    this.drain = setTimeout(
      () => void this.reset(new Error("TCP drain timeout"), 1, this.drainBudget),
      DRAIN_MS,
    );
  }
}
