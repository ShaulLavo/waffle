import { BoundedTrace, fixturePath } from "./stall-diagnostics.js";
import {
  ConsoleObservation,
  type ConsoleFailure,
  type WorkerConsoleOrder,
} from "./console-observation.js";
import type { DocumentRetirement, DocumentRetirementSource, DriverObservation } from "./driver.js";
import { HostConsumers } from "./owned-consumers.js";
import {
  record,
  type HostRequestCallback,
  type HostWorker,
  type HostWorkerCallback,
  type HostWorkerEvent,
} from "./protocol.js";

export type RequestObservation = Readonly<{
  sequence: number;
  kind: "request" | "memory-cache";
  url: string;
  requestId: string;
  frameId: string;
  loaderId: string;
  timestamp: number;
  details: Readonly<Record<string, unknown>>;
}>;
type Listener<T> = {
  callback: (event: T) => void | PromiseLike<void>;
  open: boolean;
  cursor: number;
  delivering: boolean;
  pending: Set<Promise<void>>;
  failure?: { error: unknown };
};
async function drainListener(listener: {
  pending: Set<Promise<void>>;
  failure?: { error: unknown };
}): Promise<void> {
  await Promise.allSettled(Array.from(listener.pending));
  if (listener.failure) throw listener.failure.error;
}
type Lifetime =
  | { kind: "active" | "closing" | "closed" | "revoked" }
  | { kind: "lost"; error: Error };
export type WorkerCloseSource = "safari-worker-terminated" | "playwright-worker-close";
type CloseIntent = { kind: "close" } | { kind: "navigation"; url: string };
type StopOutcome =
  | { kind: "retired"; source: DocumentRetirementSource }
  | { kind: "error"; error: Error };
export class WorkerCloseUnconfirmed extends Error {
  override readonly name = "WorkerCloseUnconfirmed";
  constructor(
    readonly worker: number,
    readonly retirement: DocumentRetirementSource,
  ) {
    super(
      `Worker ${worker} close unconfirmed: its document retired (${retirement}) and observation stopped before a termination event`,
    );
  }
}
const closeSources: ReadonlySet<DocumentRetirementSource> = new Set([
  "safari-listing-removed",
  "safari-target-destroyed",
  "playwright-page-close",
]);
type WorkerRecord = {
  ordinal: number;
  workerOrdinal: number;
  worker: HostWorker;
  close: ReturnType<typeof Promise.withResolvers<void>>;
  terminal:
    | { kind: "live" }
    | { kind: "closed"; source: WorkerCloseSource }
    | { kind: "unconfirmed"; reason: "document-retired" | "observation-stopped" };
};

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 16_384)
    throw new Error(`Invalid Inspector ${label}`);
  return value;
}
function url(value: unknown): string {
  const result = text(value, "request URL");
  try {
    new URL(result);
  } catch {
    throw new Error(`Invalid Inspector URL: ${JSON.stringify(result)}`);
  }
  return result;
}
export function workerEvent(params: unknown): { id: string; url: string } {
  if (!record(params)) throw new Error("Invalid Inspector Worker event");
  return { id: text(params.workerId, "worker ID"), url: url(params.url) };
}
export function terminatedWorker(params: unknown): string {
  if (!record(params)) throw new Error("Invalid Inspector termination event");
  return text(params.workerId, "worker ID");
}
export function requestEvent(
  method: string,
  params: unknown,
  sequence: number,
): RequestObservation {
  if (!record(params) || typeof params.timestamp !== "number" || !Number.isFinite(params.timestamp))
    throw new Error("Invalid Inspector request event");
  const cached = method === "Network.requestServedFromMemoryCache";
  const resource = cached ? params.resource : params.request;
  if (!record(resource)) throw new Error("Missing Inspector request/resource payload");
  return Object.freeze({
    sequence,
    kind: cached ? "memory-cache" : "request",
    url: url(resource.url),
    requestId: text(params.requestId, "request ID"),
    frameId: text(params.frameId, "frame ID"),
    loaderId: text(params.loaderId, "loader ID"),
    timestamp: params.timestamp,
    details: Object.freeze(params),
  });
}

/** A single exact target lifetime. Reduction is independent of awaited driver commands. */
export class BrowserObservation implements DriverObservation {
  private readonly diagnostics = new BoundedTrace("host-monotonic-ms");
  diagnosticSnapshot() {
    return {
      lifetime: this.lifetime.kind,
      retirement: this.retirementRecord ?? null,
      workers: this.diagnostics.snapshot(),
    };
  }
  workerOrdinal(worker: HostWorker | string): number | null {
    return (
      (typeof worker === "string" ? this.latest.get(worker) : this.owned.get(worker))
        ?.workerOrdinal ?? null
    );
  }
  initialized(id: string, success: boolean): void {
    const entry = this.identities.get(id);
    if (entry)
      this.diagnostics.mark(
        entry.ordinal,
        success ? "initialization-acknowledged" : "initialization-failed",
      );
  }
  private lifetime: Lifetime = { kind: "active" };
  private readonly failureResult = Promise.withResolvers<Error>();
  readonly failure = this.failureResult.promise;
  private readonly retired = Promise.withResolvers<DocumentRetirement>();
  private retirementRecord: DocumentRetirement | undefined;
  private intent: CloseIntent | undefined;
  private callbackFailure: { error: unknown } | undefined;
  private readonly identities = new Map<string, WorkerRecord>();
  private readonly live = new Map<string, WorkerRecord>();
  private readonly listeners = new Set<Listener<string>>();
  private readonly workerListeners = new Set<Listener<HostWorkerEvent>>();
  private readonly lifecycle: HostWorkerEvent[] = [];
  private readonly owned = new WeakMap<HostWorker, WorkerRecord>();
  private readonly latest = new Map<string, WorkerRecord>();
  private readonly requests: RequestObservation[] = [];
  private readonly requestURLs: string[] = [];
  private requestBytes = 0;
  private stopState: { promise: Promise<void>; outcome: StopOutcome } | undefined;
  get closingNavigationURL(): string | undefined {
    return this.intent?.kind === "navigation" ? this.intent.url : undefined;
  }
  readonly consoleState = new ConsoleObservation(() => this.consoleOrders());
  constructor(
    readonly target: string,
    private readonly consumers: HostConsumers,
    private readonly cleanup: () => Promise<void>,
    private readonly bounds = { workers: 4096, requests: 20_000, bytes: 32 << 20 },
    private readonly confirmNavigation: () => void = () => {},
    readonly settleConsole: () => Promise<void> = async () => {
      throw new Error("Console observation not enabled");
    },
    private readonly consoleOrders: () => readonly WorkerConsoleOrder[] = () => [],
  ) {
    void this.retired.promise.catch(() => {});
  }
  console(): ReturnType<ConsoleObservation["summary"]> {
    return this.consoleState.summary();
  }
  consoleMessage(context: "page" | string, failure: Omit<ConsoleFailure, "context">): void {
    if (context === "page") return this.consoleState.added({ ...failure, context });
    const worker = this.identities.get(context)?.worker;
    if (!worker) throw new Error("Console message from an unobserved Worker");
    this.consoleState.added({ ...failure, context: worker });
  }
  workerIdentity(id: string): HostWorker {
    const worker = this.identities.get(id)?.worker;
    if (!worker) throw new Error("Unknown console Worker");
    return worker;
  }
  navigationComplete(): void {
    this.check();
    this.confirmNavigation();
  }
  check(): void {
    if (this.lifetime.kind === "lost") throw this.lifetime.error;
    if (this.lifetime.kind !== "active") throw new Error("Browser observation revoked");
  }
  lose(error: unknown): void {
    if (this.lifetime.kind === "lost") return;
    this.lifetime = {
      kind: "lost",
      error: error instanceof Error ? error : new Error(String(error)),
    };
    this.consoleState.lose(this.lifetime.error.message);
    this.diagnostics.end(this.diagnostics.begin("observer-lost"), "failed");
    this.failureResult.resolve(this.lifetime.error);
    this.retired.reject(this.lifetime.error);
    this.closeAdmission();
  }
  private reduceCheck(): void {
    if (this.lifetime.kind === "lost") throw this.lifetime.error;
  }
  created(id: string, workerURL: string): boolean {
    this.reduceCheck();
    const metadata = text(workerURL, "worker URL");
    if (metadata.startsWith("/") && !metadata.startsWith("//"))
      new URL(metadata, "https://browser-worker.invalid");
    else url(metadata);
    const prior = this.identities.get(id);
    if (prior?.terminal.kind === "closed")
      throw new Error("Terminated Worker ID reused within target lifetime");
    if (prior && prior.worker.url !== metadata)
      throw new Error("Worker URL changed within target lifetime");
    if (prior) return false;
    if (this.identities.size >= this.bounds.workers)
      throw new Error("Worker observation bound exceeded");
    if (this.lifetime.kind === "closed") throw new Error("Worker creation after document close");
    const worker: HostWorker = Object.freeze({ kind: "dedicated-worker", url: metadata });
    const ordinal = this.diagnostics.begin("native-created", {
      worker: this.identities.size + 1,
      fixture: fixturePath(metadata),
    });
    const entry: WorkerRecord = {
      ordinal,
      workerOrdinal: this.identities.size + 1,
      worker,
      close: Promise.withResolvers<void>(),
      terminal: { kind: "live" },
    };
    void entry.close.promise.catch(() => {});
    this.identities.set(id, entry);
    this.owned.set(worker, entry);
    this.latest.set(metadata, entry);
    this.live.set(id, entry);
    if (this.stopState) this.settleWorker(id, entry, this.stopState.outcome);
    this.lifecycle.push(Object.freeze({ kind: "created", worker }));
    this.deliverWorkers();
    return true;
  }
  terminated(id: string, source: WorkerCloseSource): void {
    this.reduceCheck();
    const unconfirmed = this.identities.get(id);
    if (unconfirmed?.terminal.kind === "unconfirmed") {
      this.diagnostics.mark(unconfirmed.ordinal, source);
      return;
    }
    const entry = this.live.get(id);
    if (!entry) throw new Error("Termination for an unobserved Worker");
    entry.terminal = { kind: "closed", source };
    this.diagnostics.end(entry.ordinal, source);
    this.live.delete(id);
    entry.close.resolve();
    this.lifecycle.push(Object.freeze({ kind: "closed", worker: entry.worker }));
    this.deliverWorkers();
  }
  private deliverWorkers(): void {
    for (const listener of this.workerListeners) this.deliver(listener, this.lifecycle);
  }
  requested(event: RequestObservation): void {
    this.reduceCheck();
    this.requestBytes += Buffer.byteLength(JSON.stringify(event));
    if (this.requests.length >= this.bounds.requests || this.requestBytes > this.bounds.bytes)
      throw new Error("Request observation bound exceeded");
    this.requests.push(event);
    this.requestURLs.push(event.url);
    for (const listener of this.listeners) this.deliver(listener, this.requestURLs);
  }
  private deliver<T>(listener: Listener<T>, history: readonly T[]): void {
    if (listener.delivering) return;
    listener.delivering = true;
    try {
      while (listener.open && listener.cursor < history.length)
        this.deliverOne(listener, history[listener.cursor++]!);
    } finally {
      listener.delivering = false;
    }
  }
  private deliverOne<T>(listener: Listener<T>, event: T): void {
    const work = this.consumers.invoke(() => listener.callback(event)).then(() => {});
    listener.pending.add(work);
    void work.then(
      () => listener.pending.delete(work),
      (error: unknown) => {
        listener.pending.delete(work);
        listener.failure ??= { error };
        this.callbackFailure ??= { error };
        this.lose(error);
      },
    );
  }
  workers(): readonly HostWorker[] {
    this.check();
    return Array.from(this.live.values(), (entry) => entry.worker);
  }
  evidence(): readonly RequestObservation[] {
    this.check();
    return this.requests.slice();
  }
  private subscribe<T>(
    callback: Listener<T>["callback"],
    listeners: Set<Listener<T>>,
    history: readonly T[],
  ): () => Promise<void> {
    this.check();
    if (typeof callback !== "function") throw new TypeError("Observation callback required");
    const listener: Listener<T> = {
      callback,
      open: true,
      cursor: 0,
      delivering: false,
      pending: new Set(),
    };
    listeners.add(listener);
    this.deliver(listener, history);
    let drain: Promise<void> | undefined;
    return () => {
      listener.open = false;
      drain ??= drainListener(listener).finally(() => listeners.delete(listener));
      void drain.catch(() => {});
      return drain;
    };
  }
  onRequest(callback: HostRequestCallback): () => Promise<void> {
    return this.subscribe(callback, this.listeners, this.requestURLs);
  }
  onWorker(callback: HostWorkerCallback): () => Promise<void> {
    return this.subscribe(callback, this.workerListeners, this.lifecycle);
  }
  waitForWorkerClose(worker: HostWorker): Promise<void> {
    this.reduceCheck();
    const entry = this.owned.get(worker);
    if (!entry) return Promise.reject(new Error("Worker belongs to another document observation"));
    return this.consumers.invoke(() =>
      Promise.race([
        entry.close.promise,
        this.failure.then((error) => {
          throw error;
        }),
      ]),
    );
  }
  waitForWorkerURLClose(workerURL: string): Promise<void> {
    this.check();
    const entry = this.latest.get(workerURL);
    if (!entry)
      return Promise.reject(new Error(`Worker was not observed by the browser: ${workerURL}`));
    return this.waitForWorkerClose(entry.worker);
  }
  beginDocumentClose(nextURL?: string): void {
    this.check();
    this.intent =
      nextURL === undefined ? { kind: "close" } : { kind: "navigation", url: url(nextURL) };
    this.lifetime = { kind: "closing" };
  }
  get closing(): boolean {
    return this.lifetime.kind === "closing" || this.lifetime.kind === "closed";
  }
  documentClosed(source: DocumentRetirementSource): void {
    if (this.lifetime.kind === "closed") return;
    if (this.lifetime.kind !== "closing" || !this.intent)
      return this.lose(new Error("Unexpected observed document close"));
    if (this.intent.kind === "close" && !closeSources.has(source))
      return this.lose(new Error("Navigation cannot retire a closing document"));
    const outstandingWorkers = Array.from(this.live.values(), (entry) => entry.workerOrdinal);
    this.retirementRecord = Object.freeze({
      intent: this.intent.kind,
      source,
      at: performance.now(),
      outstandingWorkers: Object.freeze(outstandingWorkers.slice(0, 64)),
      outstandingCount: outstandingWorkers.length,
    });
    this.lifetime = { kind: "closed" };
    this.retired.resolve(this.retirementRecord);
  }
  documentRetirement(): Promise<DocumentRetirement> {
    return this.consumers.invoke(() => {
      if (this.intent?.kind !== "close") throw new Error("Document close was not requested");
      return this.retired.promise;
    });
  }
  private closeAdmission(): void {
    for (const listener of this.listeners) listener.open = false;
    for (const listener of this.workerListeners) listener.open = false;
  }
  revokeActions(): void {
    if (this.lifetime.kind === "active") this.lifetime = { kind: "revoked" };
    for (const listener of this.listeners) listener.open = false;
  }
  revoke(): void {
    this.revokeActions();
    this.closeAdmission();
  }
  stop(): Promise<void> {
    if (this.stopState) return this.stopState.promise;
    const missing = this.closing && this.live.size > 0 && this.retirementRecord?.intent !== "close";
    const outcome: StopOutcome =
      this.lifetime.kind === "lost"
        ? { kind: "error", error: this.lifetime.error }
        : missing
          ? { kind: "error", error: new Error("Missing final browser Worker close") }
          : this.retirementRecord?.intent === "close"
            ? { kind: "retired", source: this.retirementRecord.source }
            : { kind: "error", error: new Error("Worker observation retired") };
    const stopped = Promise.withResolvers<void>();
    void stopped.promise.catch(() => {});
    this.stopState = { promise: stopped.promise, outcome };
    const work = this.consumers.invoke(() => {
      if (missing && outcome.kind === "error") this.lose(outcome.error);
      for (const [id, entry] of this.live) this.settleWorker(id, entry, outcome);
      this.retired.reject(new Error("Observation stopped before document retirement"));
      this.diagnostics.end(this.diagnostics.begin("observer-retired"), "completed");
      this.revoke();
      return this.stopOnce();
    });
    void work.then(stopped.resolve, stopped.reject);
    return stopped.promise;
  }
  private settleWorker(id: string, entry: WorkerRecord, outcome: StopOutcome): void {
    if (entry.terminal.kind !== "live") return;
    entry.terminal = {
      kind: "unconfirmed",
      reason: outcome.kind === "retired" ? "document-retired" : "observation-stopped",
    };
    this.live.delete(id);
    entry.close.reject(
      outcome.kind === "retired"
        ? new WorkerCloseUnconfirmed(entry.workerOrdinal, outcome.source)
        : outcome.error,
    );
    this.diagnostics.end(entry.ordinal, "receipt-unconfirmed");
  }
  private async stopOnce(): Promise<void> {
    try {
      const results = await Promise.allSettled(
        Array.from(this.listeners, drainListener).concat(
          Array.from(this.workerListeners, drainListener),
        ),
      );
      const cleanup = await Promise.allSettled([this.consumers.invoke(this.cleanup)]);
      const failed = results.find((result) => result.status === "rejected");
      const callback =
        failed?.status === "rejected" ? { error: failed.reason } : this.callbackFailure;
      if (callback && cleanup[0]?.status === "rejected")
        throw new AggregateError(
          [callback.error, cleanup[0].reason],
          "Callback and observation cleanup failed",
        );
      if (callback) throw callback.error;
      if (cleanup[0]?.status === "rejected") throw cleanup[0].reason;
      if (this.lifetime.kind === "lost") throw this.lifetime.error;
    } finally {
      this.consoleState.freeze();
    }
  }
}
