import { AsyncLocalStorage } from "node:async_hooks";
import { bounded } from "./driver.js";
import { HostConsumers } from "./owned-consumers.js";
import { record } from "./protocol.js";
import type { TransportEvents } from "./framework-types.js";

type RequestLease = { done: Promise<void>; finish(): void; parsed: boolean };
type Operation = {
  live: boolean;
  controller: AbortController;
  requests: Set<RequestLease>;
};
export class FrameworkQueue {
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
  run<T>(callback: () => Promise<T>): Promise<T> {
    const current = this.local.getStore();
    if (current) {
      this.assert(current);
      return this.consumers.invoke(callback);
    }
    const next = this.consumers.invoke(() => this.tail.then(() => this.enter(callback)));
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private async enter<T>(callback: () => Promise<T>): Promise<T> {
    const operation: Operation = {
      live: true,
      controller: new AbortController(),
      requests: new Set(),
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
    const signal = AbortSignal.any([
      operation.controller.signal,
      ...(request.signal ? [request.signal] : []),
    ]);
    const completion = Promise.withResolvers<void>();
    const lease: RequestLease = {
      done: completion.promise,
      finish: completion.resolve,
      parsed: false,
    };
    operation.requests.add(lease);
    this.signals.set(signal, lease);
    return { ...request, signal };
  }
  response<T extends { statusCode: number; body?: unknown }>(response: T, request: RequestInit): T {
    const lease = request.signal ? this.signals.get(request.signal) : undefined;
    if (!lease) {
      this.fault("Response without owned request");
      throw new Error("Response without owned request");
    }
    lease.parsed = true;
    if (!record(response.body) || !Object.hasOwn(response.body, "value"))
      this.fault("Malformed WebDriver envelope");
    lease.finish();
    return response;
  }
  observe(value: unknown): void {
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
    if (!lease.parsed) this.fault(`WebDriver transport failed: ${String(event.error)}`);
    lease.finish();
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
