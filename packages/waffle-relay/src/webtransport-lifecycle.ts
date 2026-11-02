import { cancellable, deadline } from "./tcp-async.js";
import type { CertificateMaterial } from "./webtransport-certificate.js";
import type { TcpDiscovery } from "./tcp-carrier.js";

class CertificateValidityError extends Error {}

export type EndpointState = "starting" | "serving" | "recycling" | "failed" | "closed";
export interface EndpointFailure {
  readonly code: "endpoint-failed" | "certificate-expired";
  readonly manualActionRequired: boolean;
}
export interface RotationTestDependencies {
  readonly wallNow: () => number;
  readonly monotonicNow: () => number;
  readonly scheduleCheck: (callback: () => void) => () => void;
  readonly endpointStateChanged: (state: string, generation: number) => void;
}
export interface ManagedEndpoint {
  readonly ready: Promise<unknown>;
  readonly closed: Promise<unknown>;
  start(): void;
  fence(reason: "shutdown" | "certificate-rotation", budget?: LifecycleBudget): void;
  stop(budget: LifecycleBudget): Promise<void>;
}
export interface EndpointRecord {
  readonly generation: number;
  readonly certificate: CertificateMaterial;
  readonly endpoint: ManagedEndpoint;
  open: boolean;
  closure: "active" | "stopping" | "closed";
  stopping?: Promise<void>;
}
export class LifecycleBudget {
  readonly abort = new AbortController();
  private readonly end: number;
  constructor(
    private readonly now: () => number,
    ms = 12000,
  ) {
    this.end = now() + ms;
  }
  remaining(cap = 12000): number {
    const remaining = this.end - this.now();
    if (remaining <= 0) throw new Error("WebTransport lifecycle deadline");
    return Math.min(remaining, cap);
  }
  async wait<T>(promise: Promise<T>, cap?: number): Promise<T> {
    return cancellable(this.cleanup(promise, cap), this.abort.signal);
  }
  async cleanup<T>(promise: Promise<T>, cap?: number): Promise<T> {
    // Observe work even when the absolute deadline already expired before this join.
    void promise.catch(() => {});
    const value = await deadline(promise, this.remaining(cap));
    this.remaining();
    return value;
  }
}
interface LifecycleOptions {
  readonly rotationMs: number;
  readonly hashMode: boolean;
  readonly certificate: (signal: AbortSignal, remainingMs: number) => Promise<CertificateMaterial>;
  readonly construct: (
    record: Pick<EndpointRecord, "generation" | "certificate">,
    live: () => boolean,
  ) => ManagedEndpoint;
  readonly discovery: (certificate: CertificateMaterial) => TcpDiscovery;
  readonly onEndpointFailure?: (failure: EndpointFailure) => void | Promise<void>;
  readonly log: (event: Record<string, unknown>) => void;
}
export class WebTransportLifecycle {
  readonly ready: Promise<void>;
  readonly failure: Promise<EndpointFailure>;
  private readonly failed = Promise.withResolvers<EndpointFailure>();
  private readonly owned = new Set<EndpointRecord>();
  private current: EndpointRecord | undefined;
  private candidate: EndpointRecord | undefined;
  private operation: Promise<void> | undefined;
  private generationWork: Promise<void> | undefined;
  private cleanupFailure: Error | undefined;
  private budget: LifecycleBudget | undefined;
  private terminalBudget: LifecycleBudget | undefined;
  private closing: Promise<void> | undefined;
  private terminal = false;
  private fatal: EndpointFailure | undefined;
  private notified = false;
  private expiryWarned = false;
  private generation = 0;
  private lastWall: number;
  private state: EndpointState = "starting";
  private cancelSchedule: () => void;
  constructor(
    private readonly options: LifecycleOptions,
    private readonly dependencies: RotationTestDependencies,
  ) {
    if (
      !Number.isSafeInteger(options.rotationMs) ||
      options.rotationMs < 1000 ||
      options.rotationMs > 12 * 86400000
    )
      throw new TypeError("Invalid WebTransport rotation interval");
    this.lastWall = dependencies.wallNow();
    this.failure = this.failed.promise;
    this.cancelSchedule = dependencies.scheduleCheck(() => this.check());
    this.ready = this.launch(false);
    void this.ready.catch(() => {});
  }
  discovery(): TcpDiscovery | null {
    this.check();
    if (this.state !== "serving" || !this.current?.open) return null;
    return this.options.discovery(this.current.certificate);
  }
  status() {
    this.check();
    return {
      state: this.state,
      generation: this.generation,
      candidateGeneration: this.candidate?.generation,
      ownedEndpoints: this.owned.size,
      generationPending: this.generationWork !== undefined,
      cleanupFailed: this.cleanupFailure !== undefined,
      ownedGenerations: Array.from(this.owned, (record) => record.generation),
    };
  }
  closeBudget(): LifecycleBudget {
    this.terminalBudget ??= this.budget ?? new LifecycleBudget(this.dependencies.monotonicNow);
    return this.terminalBudget;
  }
  revoke(): void {
    void this.close().catch(() => {});
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.terminal = true;
    this.cancelSchedule();
    const budget = this.closeBudget();
    this.fence("shutdown", budget);
    budget.abort.abort(new Error("WebTransport closed"));
    const cleanup = this.operation ? this.operation.catch(() => {}) : this.cleanupOwned(budget);
    this.closing = cleanup.then(
      () => this.assertClosed(),
      (error: unknown) => {
        this.setState("failed");
        throw this.retainCleanupFailure(error);
      },
    );
    return this.closing;
  }
  private check(): void {
    if (this.terminal || this.fatal || this.state !== "serving" || !this.current) return;
    const now = this.dependencies.wallNow();
    const certificate = this.current.certificate;
    const backwards = now < this.lastWall;
    this.lastWall = now;
    if (!this.options.hashMode) {
      if (now < certificate.starts || now >= certificate.expires) this.expireOperatorCertificate();
      else this.warnCertificate(certificate);
      return;
    }
    if (
      backwards ||
      now >= certificate.starts + this.options.rotationMs ||
      now < certificate.starts ||
      now >= certificate.expires - 3600000
    )
      void this.launch(true).catch(() => {});
  }
  private launch(recycle: boolean): Promise<void> {
    if (this.operation) return this.operation;
    const budget = new LifecycleBudget(this.dependencies.monotonicNow);
    this.budget = budget;
    this.fence("certificate-rotation", budget);
    this.setState(recycle ? "recycling" : "starting");
    this.operation = this.finishOperation(this.transition(budget));
    return this.operation;
  }
  private async transition(budget: LifecycleBudget): Promise<void> {
    try {
      const generation = this.options.certificate(budget.abort.signal, budget.remaining());
      const joined = generation.then(
        () => {
          this.generationWork = undefined;
        },
        () => {
          this.generationWork = undefined;
        },
      );
      this.generationWork = joined;
      const certificate = await budget.wait(generation);
      this.validate(certificate);
      await this.cleanupOwned(budget);
      budget.abort.signal.throwIfAborted();
      this.validate(certificate);
      const record = this.construct(certificate);
      this.candidate = record;
      this.owned.add(record);
      record.endpoint.start();
      budget.remaining();
      await budget.wait(record.endpoint.ready, 5000);
      this.validate(certificate);
      budget.abort.signal.throwIfAborted();
      if (record.closure !== "active") throw new Error("WebTransport endpoint closed");
      this.current = record;
      this.candidate = undefined;
      record.open = true;
      this.generation = record.generation;
      this.setState("serving");
      this.log({
        event: "webtransport-endpoint",
        result: "serving",
        generation: this.generation,
        certificateSha256: certificate.hash.value,
        notAfter: new Date(certificate.expires).toISOString(),
      });
    } catch (error) {
      await this.failedTransition(budget, error);
    }
  }
  private construct(certificate: CertificateMaterial): EndpointRecord {
    const generation = this.generation + 1;
    const record: EndpointRecord = {
      generation,
      certificate,
      endpoint: this.options.construct(
        { generation, certificate },
        () => !this.terminal && this.state === "serving" && this.current === record && record.open,
      ),
      open: false,
      closure: "active",
    };
    const endpoint = record.endpoint;
    void endpoint.closed.then(
      () => this.endpointClosed(record),
      () => this.endpointClosed(record),
    );
    void endpoint.ready.then(
      () => {
        if (!record.open && this.terminal) this.fenceRecord(record, "shutdown");
      },
      () => {},
    );
    return record;
  }
  private finishOperation(operation: Promise<void>): Promise<void> {
    return operation.finally(() => {
      this.operation = undefined;
      this.budget = undefined;
      if (this.fatal) this.notify();
    });
  }
  private endpointClosed(record: EndpointRecord): void {
    const intentional = record.closure === "stopping";
    record.closure = "closed";
    record.open = false;
    if (intentional || this.terminal || this.fatal) return;
    const budget = this.budget ?? new LifecycleBudget(this.dependencies.monotonicNow);
    this.fatal = { code: "endpoint-failed", manualActionRequired: false };
    this.terminalBudget = budget;
    this.setState("failed");
    this.cancelSchedule();
    this.fence("certificate-rotation", budget);
    const error = new Error("WebTransport endpoint closed unexpectedly");
    budget.abort.abort(error);
    if (this.operation) return;
    this.budget = budget;
    this.operation = this.finishOperation(this.failedTransition(budget, error));
    void this.operation.catch(() => {});
  }
  private async failedTransition(budget: LifecycleBudget, error: unknown): Promise<never> {
    if (!this.terminal) {
      const manual = !this.options.hashMode && error instanceof CertificateValidityError;
      this.fatal = {
        code: manual ? "certificate-expired" : "endpoint-failed",
        manualActionRequired: manual,
      };
      this.terminalBudget = budget;
      this.setState("failed");
      this.cancelSchedule();
    }
    this.fence(this.terminal ? "shutdown" : "certificate-rotation", budget);
    await this.cleanupOwned(budget).catch(() => {});
    this.current = undefined;
    this.candidate = undefined;
    throw error;
  }
  private fence(reason: "shutdown" | "certificate-rotation", budget?: LifecycleBudget): void {
    for (const record of this.owned) this.fenceRecord(record, reason, budget);
  }
  private fenceRecord(
    record: EndpointRecord,
    reason: "shutdown" | "certificate-rotation",
    budget?: LifecycleBudget,
  ): void {
    record.open = false;
    record.endpoint.fence(reason, budget);
  }
  private async cleanupOwned(budget: LifecycleBudget): Promise<void> {
    try {
      if (this.cleanupFailure) throw this.cleanupFailure;
      if (this.generationWork) await budget.cleanup(this.generationWork);
      for (const record of this.owned) await this.cleanupRecord(record, budget);
      this.current = undefined;
      this.candidate = undefined;
    } catch (error) {
      throw this.retainCleanupFailure(error);
    }
  }
  private async cleanupRecord(record: EndpointRecord, budget: LifecycleBudget): Promise<void> {
    record.closure = "stopping";
    const stopped = (record.stopping ??= record.endpoint.stop(budget));
    void stopped.then(
      () => this.owned.delete(record),
      () => {},
    );
    await budget.cleanup(stopped);
    this.owned.delete(record);
  }
  private retainCleanupFailure(error: unknown): Error {
    this.cleanupFailure ??= new Error(
      "WebTransport cleanup is unsettled within its lifecycle deadline",
      { cause: error },
    );
    return this.cleanupFailure;
  }
  private assertClosed(): void {
    if (this.cleanupFailure || this.generationWork || this.owned.size) {
      this.setState("failed");
      throw this.retainCleanupFailure(new Error("WebTransport cleanup is unsettled"));
    }
    this.setState("closed");
  }
  private validate(certificate: CertificateMaterial): void {
    const now = this.dependencies.wallNow();
    if (now < certificate.starts || now >= certificate.expires)
      throw new CertificateValidityError("Invalid certificate validity");
    if (!this.options.hashMode) {
      this.warnCertificate(certificate);
      return;
    }
    if (
      certificate.expires - certificate.starts > 14 * 86400000 ||
      certificate.expires - now < this.options.rotationMs + 3600000
    )
      throw new CertificateValidityError("Invalid generated certificate validity");
  }
  private warnCertificate(certificate: CertificateMaterial): void {
    if (this.expiryWarned || certificate.expires - this.dependencies.wallNow() >= 7 * 86400000)
      return;
    this.expiryWarned = true;
    this.log({
      event: "webtransport-endpoint",
      result: "certificate-soon-expiring",
      manualActionRequired: true,
    });
  }
  private expireOperatorCertificate(): void {
    this.fatal = { code: "certificate-expired", manualActionRequired: true };
    this.setState("failed");
    const budget = new LifecycleBudget(this.dependencies.monotonicNow);
    this.terminalBudget = budget;
    this.fence("shutdown", budget);
    this.operation = this.finishOperation(this.cleanupOwned(budget));
    void this.operation.catch(() => {});
  }
  private notify(): void {
    if (this.notified || !this.fatal) return;
    this.notified = true;
    const failure = this.fatal;
    queueMicrotask(() => {
      this.failed.resolve(failure);
      this.log({
        event: "webtransport-endpoint",
        result: "failed",
        ...failure,
        ownedGenerations: Array.from(this.owned, (record) => record.generation),
      });
      if (failure.manualActionRequired) return;
      void Promise.resolve()
        .then(() => this.options.onEndpointFailure?.(failure))
        .catch(() => this.log({ event: "webtransport-endpoint", result: "observer-failed" }));
    });
  }
  private log(event: Record<string, unknown>): void {
    try {
      this.options.log(event);
    } catch {}
  }
  private setState(state: EndpointState): void {
    this.state = state;
    this.dependencies.endpointStateChanged(state, this.generation);
  }
}
export const rotationDependencies: RotationTestDependencies = {
  wallNow: Date.now,
  monotonicNow: () => performance.now(),
  scheduleCheck(callback) {
    const timer = setInterval(callback, 60000);
    timer.unref();
    return () => clearInterval(timer);
  },
  endpointStateChanged() {},
};
