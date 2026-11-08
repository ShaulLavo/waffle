import { AsyncLocalStorage } from "node:async_hooks";
import { bounded } from "./driver.js";
import { HostConsumers } from "./owned-consumers.js";
import { record } from "./protocol.js";
import type { CommandFailure, TransportEvents } from "./framework-types.js";

type RequestLease = {
  done: Promise<void>;
  finish(): void;
  parsed: boolean;
  failureRecorded: boolean;
  status: number | null;
  dispatchedAt: number;
  method: string | null;
  signal: AbortSignal;
  callerSignal: AbortSignal | null;
  operation: Operation;
};
type Operation = {
  live: boolean;
  controller: AbortController;
  requests: Set<RequestLease>;
  id: string;
  phase: string | null;
};
export function commandMethod(method: unknown): string | null {
  return typeof method === "string" && /^(GET|POST|DELETE|PUT|PATCH|HEAD|OPTIONS)$/.test(method)
    ? method
    : null;
}
export function commandPath(path: string): string | null {
  const safe = path.replace(/^\/session\/[^/]+/, "/session/:session");
  return /^\/(status|session|session\/:session(\/(timeouts|url|window(\/(handles|new))?|refresh|execute\/(sync|async)))?)$/.test(
    safe,
  )
    ? safe
    : null;
}
function commandPhase(value: string | null): string | null {
  return value !== null &&
    ["attach", "observation", "open", "test-frame", "main-frame", "framework-cleanup"].includes(
      value,
    )
    ? value
    : null;
}
function responseStatus(response: object): number | null {
  try {
    const status: unknown = Object.getOwnPropertyDescriptor(response, "statusCode")?.value;
    return typeof status === "number" && Number.isFinite(status) ? status : null;
  } catch {
    return null;
  }
}
function failedPerformance(event: object): boolean {
  try {
    return Object.getOwnPropertyDescriptor(event, "success")?.value === false;
  } catch {
    return false;
  }
}
export class FrameworkQueue {
  readonly commandFailures: CommandFailure[] = [];
  recordFailure(facts: CommandFailure): void {
    const operation = this.local.getStore();
    if (this.commandFailures.length >= 128) return;
    this.commandFailures.push({
      ...facts,
      operation: facts.operation ?? operation?.id ?? null,
      phase: commandPhase(facts.phase ?? operation?.phase ?? null),
    });
  }
  readonly commandHooks: {
    operation: string | null;
    phase: "started" | "settled";
    revoked: boolean;
  }[] = [];
  private readonly local = new AsyncLocalStorage<Operation>();
  private tail = Promise.resolve();
  private closed = false;
  private readonly signals = new WeakMap<AbortSignal, RequestLease>();
  private readonly clients = new Map<
    object,
    { client: TransportEvents; listener: (event: unknown) => void }
  >();
  private readonly active = new Set<Operation>();
  constructor(
    readonly consumers: HostConsumers,
    private readonly check: () => void,
    private readonly fault: (detail: string) => void,
  ) {}
  run<T>(callback: () => Promise<T>, phase: string | null = null): Promise<T> {
    const current = this.local.getStore();
    if (current) {
      this.assert(current);
      return this.consumers.invoke(callback);
    }
    const next = this.consumers.invoke(() => this.tail.then(() => this.enter(callback, phase)));
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private async enter<T>(callback: () => Promise<T>, phase: string | null): Promise<T> {
    const operation: Operation = {
      live: true,
      controller: new AbortController(),
      requests: new Set(),
      id: crypto.randomUUID(),
      phase,
    };
    this.assert(operation);
    this.active.add(operation);
    try {
      const value = await this.local.run(operation, () => this.consumers.invoke(callback));
      this.assert(operation);
      return value;
    } finally {
      operation.live = false;
      try {
        await bounded(
          Promise.all(Array.from(operation.requests, (request) => request.done)),
          6000,
          "owned HTTP settlement",
        );
      } catch (error) {
        this.fault(String(error));
      }
      this.active.delete(operation);
    }
  }
  private assert(operation: Operation): void {
    if (this.closed || !operation.live) {
      this.fault("Unowned or revoked WebDriver dispatch");
      throw new Error("Unowned or revoked WebDriver dispatch");
    }
    this.check();
  }
  guard<T extends RequestInit>(request: T): T {
    const operation = this.local.getStore();
    if (!operation) {
      this.fault("Unowned WebDriver request");
      throw new Error("Unowned WebDriver request");
    }
    this.assert(operation);
    const callerSignal = request.signal;
    const signal = AbortSignal.any(
      [operation.controller.signal].concat(callerSignal ? [callerSignal] : []),
    );
    const guarded = { ...request, signal };
    const completion = Promise.withResolvers<void>();
    const lease: RequestLease = {
      done: this.consumers.invoke(() => completion.promise),
      finish: completion.resolve,
      parsed: false,
      failureRecorded: false,
      status: null,
      dispatchedAt: performance.now(),
      method: commandMethod(guarded.method),
      signal,
      callerSignal: callerSignal ?? null,
      operation,
    };
    operation.requests.add(lease);
    this.signals.set(signal, lease);
    return guarded;
  }
  response<T extends { statusCode: number; body?: unknown }>(response: T, request: RequestInit): T {
    const lease = request.signal ? this.signals.get(request.signal) : undefined;
    if (!lease) {
      this.fault("Response without owned request");
      throw new Error("Response without owned request");
    }
    lease.parsed = true;
    lease.status = responseStatus(response);
    if (!record(response.body) || !Object.hasOwn(response.body, "value")) {
      this.failedRequest(lease, "envelope", lease.status);
      this.fault("Malformed WebDriver envelope");
    }
    lease.finish();
    return response;
  }
  commandStarted(): void {
    const operation = this.local.getStore();
    const revoked = !operation || !operation.live || this.closed;
    this.commandHooks.push({ operation: operation?.id ?? null, phase: "started", revoked });
    if (revoked) this.fault("Unowned or revoked SDK command hook");
  }
  commandSettled(): void {
    const operation = this.local.getStore();
    this.commandHooks.push({
      operation: operation?.id ?? null,
      phase: "settled",
      revoked: !operation?.live || this.closed,
    });
  }
  observe(value: unknown): void {
    if (this.closed) return;
    if (!record(value) || typeof value.on !== "function" || typeof value.off !== "function")
      throw new Error("SDK command hook did not supply a transport event emitter");
    if (this.clients.has(value)) return;
    const on = value.on,
      off = value.off;
    const client: TransportEvents = {
      on: (event, listener) => Reflect.apply(on, value, [event, listener]),
      off: (event, listener) => Reflect.apply(off, value, [event, listener]),
    };
    const listener = (event: unknown) => this.performance(event);
    this.clients.set(value, { client, listener });
    client.on("request.performance", listener);
  }
  private performance(event: unknown): void {
    if (!record(event) || !record(event.request)) {
      this.fault("Malformed SDK transport performance event");
      return;
    }
    const signal = event.request.signal;
    const lease = signal instanceof AbortSignal ? this.signals.get(signal) : undefined;
    if (!lease) {
      this.fault("Unowned SDK transport settlement");
      return;
    }
    if (lease.parsed && failedPerformance(event))
      this.failedRequest(lease, "envelope", lease.status);
    if (!lease.parsed) {
      this.failedRequest(lease, "unknown", null);
      this.fault("WebDriver transport failed before an observed parsed response");
    }
    lease.finish();
  }
  private failedRequest(
    lease: RequestLease,
    stage: CommandFailure["stage"],
    status: number | null,
  ): void {
    if (lease.failureRecorded) return;
    lease.failureRecorded = true;
    const revoked = lease.operation.controller.signal;
    this.recordFailure({
      client: "attached",
      operation: lease.operation.id,
      phase: lease.operation.phase,
      method: lease.method,
      path: null,
      dispatchedAt: lease.dispatchedAt,
      settledAt: performance.now(),
      stage,
      status,
      abort:
        revoked.aborted && lease.signal.reason === revoked.reason
          ? "revoked"
          : lease.callerSignal?.aborted && lease.signal.reason === lease.callerSignal.reason
            ? "caller"
            : lease.signal.aborted
              ? "unknown"
              : null,
    });
  }
  revoke(): void {
    this.closed = true;
    for (const operation of this.active)
      operation.controller.abort(new Error("Framework dispatch revoked"));
  }
  async join(): Promise<void> {
    await this.tail;
  }
  releaseObservers(): void {
    for (const { client, listener } of this.clients.values()) {
      client.off("request.performance", listener);
    }
    this.clients.clear();
  }
}
