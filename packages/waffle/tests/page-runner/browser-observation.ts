import type { DriverObservation } from "./driver.js";
import { HostConsumers } from "./owned-consumers.js";
import { record, type HostRequestCallback, type HostWorker } from "./protocol.js";

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
type Listener = { callback: HostRequestCallback; open: boolean; pending: Set<Promise<void>> };
type Lifetime = { kind: "active" } | { kind: "revoked" } | { kind: "lost"; error: Error };

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 16_384)
    throw new Error(`Invalid Inspector ${label}`);
  return value;
}
function url(value: unknown): string {
  const result = text(value, "request URL");
  new URL(result);
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
  private lifetime: Lifetime = { kind: "active" };
  private readonly failureResult = Promise.withResolvers<Error>();
  readonly failure = this.failureResult.promise;
  private readonly identities = new Map<string, HostWorker>();
  private readonly live = new Map<string, HostWorker>();
  private readonly listeners = new Set<Listener>();
  private readonly requests: RequestObservation[] = [];
  private requestBytes = 0;
  private retirement: Promise<void> | undefined;
  constructor(
    readonly target: string,
    private readonly consumers: HostConsumers,
    private readonly cleanup: () => Promise<void>,
    private readonly bounds = { workers: 4096, requests: 20_000, bytes: 32 << 20 },
    private readonly confirmNavigation: () => void = () => {},
  ) {}
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
    this.failureResult.resolve(this.lifetime.error);
    for (const listener of this.listeners) listener.open = false;
  }
  private reduceCheck(): void {
    if (this.lifetime.kind === "lost") throw this.lifetime.error;
  }
  created(id: string): boolean {
    this.reduceCheck();
    if (this.live.has(id)) return false;
    if (this.identities.has(id))
      throw new Error("Terminated Worker ID reused within target lifetime");
    if (this.identities.size >= this.bounds.workers)
      throw new Error("Worker observation bound exceeded");
    const worker: HostWorker = Object.freeze({ kind: "dedicated-worker" });
    this.identities.set(id, worker);
    this.live.set(id, worker);
    return true;
  }
  terminated(id: string): void {
    this.reduceCheck();
    if (!this.live.delete(id)) throw new Error("Termination for an unobserved Worker");
  }
  requested(event: RequestObservation): void {
    this.reduceCheck();
    this.requestBytes += Buffer.byteLength(JSON.stringify(event));
    if (this.requests.length >= this.bounds.requests || this.requestBytes > this.bounds.bytes)
      throw new Error("Request observation bound exceeded");
    this.requests.push(event);
    for (const listener of this.listeners) this.deliver(listener, event.url);
  }
  private deliver(listener: Listener, requestURL: string): void {
    if (!listener.open) return;
    const work = this.consumers.invoke(() => listener.callback(requestURL)).then(() => {});
    listener.pending.add(work);
    void work.then(
      () => listener.pending.delete(work),
      (error: unknown) => {
        listener.pending.delete(work);
        this.lose(error);
      },
    );
  }
  workers(): readonly HostWorker[] {
    this.check();
    return Array.from(this.live.values());
  }
  evidence(): readonly RequestObservation[] {
    this.check();
    return this.requests.slice();
  }
  onRequest(callback: HostRequestCallback): () => Promise<void> {
    this.check();
    if (typeof callback !== "function") throw new TypeError("Request callback required");
    const listener: Listener = { callback, open: true, pending: new Set() };
    this.listeners.add(listener);
    for (const request of this.requests) this.deliver(listener, request.url);
    let drain: Promise<void> | undefined;
    return () => {
      listener.open = false;
      this.listeners.delete(listener);
      drain ??= Promise.all(Array.from(listener.pending)).then(() => {});
      return drain;
    };
  }
  revoke(): void {
    if (this.lifetime.kind === "active") this.lifetime = { kind: "revoked" };
    for (const listener of this.listeners) listener.open = false;
  }
  stop(): Promise<void> {
    this.revoke();
    return (this.retirement ??= this.consumers.invoke(() => this.stopOnce()));
  }
  private async stopOnce(): Promise<void> {
    const callbacks = Array.from(this.listeners, (listener) => Array.from(listener.pending)).flat();
    const results = await Promise.allSettled(callbacks.concat([this.cleanup()]));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (this.lifetime.kind === "lost") throw this.lifetime.error;
  }
}
