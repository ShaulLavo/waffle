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
  command: { method: string; endpoint: string } | null;
};
export class FrameworkQueue {
  private readonly local = new AsyncLocalStorage<Operation>();
  private tail = Promise.resolve();
  private closed = false;
  private readonly signals = new WeakMap<AbortSignal, RequestLease>();
  private readonly clients = new Map<
    object,
    {
      client: TransportEvents;
      listener: (event: unknown) => void;
      command: (event: unknown) => void;
    }
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
      command: null,
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
    if (this.clients.size && !this.allowed(operation.command)) {
      this.fault("Unsupported native SDK command");
      throw new Error("Unsupported native SDK command");
    }
    operation.command = null;
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
    const command = (event: unknown) => {
      const operation = this.local.getStore();
      if (
        !operation ||
        !record(event) ||
        typeof event.method !== "string" ||
        typeof event.endpoint !== "string"
      )
        return;
      operation.command = { method: event.method, endpoint: event.endpoint };
    };
    this.clients.set(value, { client, listener, command });
    client.on("request.performance", listener);
    client.on("command", command);
  }
  private allowed(command: Operation["command"]): boolean {
    if (!command) return false;
    const path = command.endpoint.replace(/^\/session\/[^/]+/, "");
    if (command.method === "GET")
      return (
        ["/context", "/window", "/window/handles", "/url"].includes(path) ||
        /^\/element\/[^/]+\/(name|enabled)$/.test(path)
      );
    return (
      command.method === "POST" &&
      ["/url", "/element", "/elements", "/frame", "/frame/parent", "/execute/sync"].includes(path)
    );
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
    for (const { client, listener, command } of this.clients.values()) {
      client.off("request.performance", listener);
      client.off("command", command);
    }
    this.clients.clear();
  }
}
