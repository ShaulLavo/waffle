import { RelayError, type RelayLimits } from "./protocol.js";

type Resource = { cancel(reason: unknown): Promise<void> };

export class Exchange {
  readonly controller = new AbortController();
  private readonly setup = Promise.withResolvers<void>();
  private readonly complete = Promise.withResolvers<void>();
  private resources = new Set<Resource>();
  private setupFinished = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unlink = () => {};

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly onDone: () => void,
    signal?: AbortSignal | null,
  ) {
    const abort = () => this.abort(signal?.reason);
    if (signal?.aborted) this.controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    this.unlink = () => signal?.removeEventListener("abort", abort);
    this.touch();
  }

  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.abort(new RelayError("upstream-aborted")),
      this.idleTimeoutMs,
    );
  }

  own(resource: Resource): () => void {
    this.resources.add(resource);
    return () => {
      this.resources.delete(resource);
      this.maybeDone();
    };
  }

  finishSetup(): void {
    this.setupFinished = true;
    this.setup.resolve();
    this.maybeDone();
  }

  abort(reason: unknown): void {
    clearTimeout(this.timer);
    // Start reader cancellation before fetch abort turns its body into an errored stream.
    const cancelling = this.cancelResources(reason);
    this.controller.abort(reason);
    void cancelling.catch(() => {});
  }

  async join(): Promise<void> {
    await this.setup.promise;
    await this.cancelResources();
    await this.complete.promise;
  }

  private async cancelResources(reason: unknown = this.controller.signal.reason): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.resources, (entry) => entry.cancel(reason)),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [new RelayError("relay-unavailable")] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Relay cleanup is unsettled");
  }

  private maybeDone(): void {
    if (!this.setupFinished || this.resources.size) return;
    clearTimeout(this.timer);
    this.unlink();
    this.complete.resolve();
    this.onDone();
  }
}

export class Lifetime {
  private readonly active = new Set<Exchange>();
  private reason: unknown;
  private revoked = false;

  constructor(private readonly limits: RelayLimits) {}

  admit(signal?: AbortSignal | null): Exchange {
    if (this.revoked) throw this.reason;
    if (this.active.size >= this.limits.maxConcurrent) throw new RelayError("concurrent-limit");
    const job = new Exchange(this.limits.idleTimeoutMs, () => this.active.delete(job), signal);
    this.active.add(job);
    return job;
  }

  assertLive(): void {
    if (this.revoked) throw this.reason;
  }

  revoke(reason: unknown = new RelayError("relay-unavailable")): void {
    if (this.revoked) return;
    this.revoked = true;
    this.reason = reason;
    for (const job of this.active) job.abort(reason);
  }

  async close(): Promise<void> {
    this.revoke();
    await Promise.all(Array.from(this.active, (job) => job.join()));
  }
}
