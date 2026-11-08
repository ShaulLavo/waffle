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
  controller: AbortController;
  requests: Set<RequestLease>;
  pending: Set<Promise<void>>;
  frame: Scope | null;
  failure: { reason: unknown } | null;
  id: string;
  phase: string | null;
};
type Scope = {
  operation: Operation;
  live: boolean;
  frame: Scope | null;
  outerFrame: Scope | null;
};
type Completion<T> = { kind: "fulfilled"; value: T } | { kind: "rejected"; reason: unknown };
type RunOptions = {
  rootOnly?: boolean;
  finalize?: () => Promise<void>;
  complete?: () => void;
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
    [
      "attach",
      "observation",
      "open",
      "test-frame",
      "main-frame",
      "framework-cleanup",
      "viewport",
      "screenshot",
    ].includes(value)
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
    const operation = this.local.getStore()?.operation;
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
  private readonly local = new AsyncLocalStorage<Scope>();
  private tail = Promise.resolve();
  private closed = false;
  private observersReleaseRequested = false;
  private sessionId: string | null = null;
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
  run<T>(
    callback: () => Promise<T>,
    phase: string | null = null,
    options: RunOptions = {},
  ): Promise<T> {
    const current = this.local.getStore();
    if (current) return this.child(current, callback, phase, options);
    const next = this.consumers.invoke(() =>
      this.tail.then(() => this.enter(callback, phase, options)),
    );
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private child<T>(
    scope: Scope,
    callback: () => Promise<T>,
    phase: string | null,
    options: RunOptions,
  ): Promise<T> {
    try {
      this.assert(scope);
      if (options.rootOnly) throw this.reject(scope.operation, "Nested framework domain operation");
      const frame = phase === "test-frame" || phase === "main-frame";
      if (frame && scope.operation.frame && this.liveFrame(scope.frame) !== scope.operation.frame)
        throw this.reject(scope.operation, "Overlapping sibling frame transitions");
      return this.invoke(scope.operation, callback, scope, frame);
    } catch (reason) {
      return Promise.reject(reason);
    }
  }
  private invoke<T>(
    operation: Operation,
    callback: () => Promise<T>,
    parent: Scope | null = null,
    frame = false,
  ): Promise<T> {
    const outerFrame = this.liveFrame(parent?.frame ?? null);
    const scope: Scope = { operation, live: true, frame: outerFrame, outerFrame };
    if (frame) {
      scope.frame = scope;
      operation.frame = scope;
    }
    const result = this.local.run(scope, () => this.consumers.invoke(callback));
    const settled = result.then(
      () => this.seal(scope),
      (reason: unknown) => {
        operation.failure ??= { reason };
        this.seal(scope);
      },
    );
    operation.pending.add(settled);
    void settled.then(() => operation.pending.delete(settled));
    return result;
  }
  private liveFrame(frame: Scope | null): Scope | null {
    while (frame && !frame.live) frame = frame.outerFrame;
    return frame;
  }
  private seal(scope: Scope): void {
    scope.live = false;
    if (scope.operation.frame === scope) scope.operation.frame = this.liveFrame(scope.outerFrame);
  }
  private async outcome<T>(
    operation: Operation,
    callback: () => Promise<T>,
  ): Promise<Completion<T>> {
    try {
      return { kind: "fulfilled", value: await this.invoke(operation, callback) };
    } catch (reason) {
      return { kind: "rejected", reason };
    }
  }
  private async drain(operation: Operation): Promise<void> {
    while (operation.pending.size || operation.requests.size) {
      const callbacks = Array.from(operation.pending);
      const requests = Array.from(operation.requests, (request) => request.done);
      await Promise.all(callbacks.concat(requests));
    }
  }
  private async joinOperation(operation: Operation): Promise<void> {
    try {
      await bounded(this.drain(operation), 6000, "owned callback and HTTP settlement");
    } catch {
      this.revoke();
      throw this.reject(operation, "Owned callback and HTTP settlement timed out");
    }
  }
  private async enter<T>(
    callback: () => Promise<T>,
    phase: string | null,
    options: RunOptions,
  ): Promise<T> {
    const operation: Operation = {
      controller: new AbortController(),
      requests: new Set(),
      pending: new Set(),
      failure: null,
      frame: null,
      id: crypto.randomUUID(),
      phase,
    };
    this.checkRoot(operation);
    this.active.add(operation);
    const outcome = await this.outcome(operation, callback);
    try {
      await this.joinOperation(operation);
      this.checkRoot(operation);
      if (options.finalize) {
        await this.outcome(operation, options.finalize);
        await this.joinOperation(operation);
      }
      this.checkRoot(operation);
      options.complete?.();
    } catch (reason) {
      operation.failure ??= { reason };
    } finally {
      operation.controller.abort(new Error("Framework operation settled"));
      void this.drain(operation).then(() => {
        this.active.delete(operation);
        if (this.observersReleaseRequested) this.releaseObservers();
      });
    }
    if (outcome.kind === "rejected") throw outcome.reason;
    if (operation.failure) throw operation.failure.reason;
    return outcome.value;
  }
  private reject(operation: Operation, detail: string): Error {
    const reason = new Error(detail);
    operation.failure ??= { reason };
    operation.controller.abort(reason);
    this.fault(detail);
    return reason;
  }
  private checkRoot(operation: Operation): void {
    if (this.closed || operation.controller.signal.aborted)
      throw this.reject(operation, "Unowned or revoked WebDriver dispatch");
    this.check();
    this.checkClients(operation);
  }
  private assert(scope: Scope): void {
    if (!scope.live) throw this.reject(scope.operation, "Unowned or revoked WebDriver dispatch");
    this.checkRoot(scope.operation);
  }
  guard<T extends RequestInit>(request: T): T {
    const scope = this.local.getStore();
    if (!scope) {
      this.fault("Unowned WebDriver request");
      throw new Error("Unowned WebDriver request");
    }
    this.assert(scope);
    const operation = scope.operation;
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
    void lease.done.then(() => operation.requests.delete(lease));
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
      this.reject(lease.operation, "Malformed WebDriver envelope");
    }
    lease.finish();
    return response;
  }
  commandStarted(): void {
    const scope = this.local.getStore();
    const operation = scope?.operation;
    const revoked = !scope?.live || operation?.controller.signal.aborted === true || this.closed;
    this.commandHooks.push({ operation: operation?.id ?? null, phase: "started", revoked });
    if (revoked) this.fault("Unowned or revoked SDK command hook");
  }
  commandSettled(): void {
    const scope = this.local.getStore();
    const operation = scope?.operation;
    this.commandHooks.push({
      operation: operation?.id ?? null,
      phase: "settled",
      revoked: !scope?.live || operation?.controller.signal.aborted === true || this.closed,
    });
  }
  bindSession(sessionId: string): void {
    if (this.sessionId !== null) throw new Error("Framework session already bound");
    this.sessionId = sessionId;
  }
  private checkClients(operation: Operation): void {
    if (this.sessionId === null) return;
    for (const client of this.clients.keys()) {
      if (!record(client) || client.sessionId !== this.sessionId)
        throw this.reject(operation, "Observed SDK session identity changed");
    }
  }
  observe(value: unknown): void {
    if (this.closed) return;
    if (!record(value) || typeof value.on !== "function" || typeof value.off !== "function")
      throw new Error("SDK command hook did not supply a transport event emitter");
    if (this.clients.has(value)) return;
    const scope = this.local.getStore();
    if (this.sessionId !== null && value.sessionId !== this.sessionId) {
      if (scope) throw this.reject(scope.operation, "Observed SDK session identity changed");
      throw new Error("Observed SDK session identity changed");
    }
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
      this.reject(lease.operation, "WebDriver transport failed before an observed parsed response");
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
    this.observersReleaseRequested = true;
    if (this.active.size) return;
    for (const { client, listener } of this.clients.values()) {
      client.off("request.performance", listener);
    }
    this.clients.clear();
  }
}
