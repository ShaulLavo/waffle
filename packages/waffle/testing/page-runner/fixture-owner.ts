import { bounded, type CleanupStep } from "./driver.js";
import { jsonSnapshot } from "./json-snapshot.js";
import { formatHostError } from "./protocol.js";
export interface FixtureContext {
  readonly origin: string;
  readonly run: string;
  readonly scratch: string;
  readonly signal: AbortSignal;
}
export interface FixtureRequest {
  /** Earliest original case/document/run performance.now() deadline. Completion is
   * authorized before it; HTTP delivery can occur later. Synchronous work is cooperative. */
  readonly deadline: number;
  readonly signal: AbortSignal;
}
export interface FixtureRoute {
  readonly path: string;
  readonly get: (request: FixtureRequest) => Promise<unknown>;
}
export interface SuiteFixture {
  start(context: FixtureContext): Promise<readonly FixtureRoute[]>;
  close(): Promise<void>;
}
/** create must be inert. The host owns close before any listener or asynchronous acquisition. */
export interface FixtureDeclaration {
  readonly caseId: string;
  readonly create: () => SuiteFixture;
}
export function localPath(path: string): void {
  const url = new URL(path, "http://localhost");
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    url.origin !== "http://localhost" ||
    url.pathname !== path ||
    url.search ||
    url.hash ||
    /[%\\\s<>"']/u.test(path)
  )
    throw new Error("Expected a canonical same-origin local path");
}
export function reservedPath(path: string): boolean {
  return (
    [
      "/report",
      "/heartbeat",
      "/retire",
      "/favicon.ico",
      "/_waffle_worker_close",
      "/_waffle_observation_bootstrap",
      "/_waffle_observation_arrival",
    ].includes(path) ||
    path === "/_waffle_owned" ||
    path.startsWith("/_waffle_owned/")
  );
}
/** Owns real promises, including JSON serialization. A deadline never settles them. */
export class FixtureOwner {
  private readonly fixture: SuiteFixture;
  private readonly controller = new AbortController();
  private readonly pending = new Map<Promise<void>, string>();
  private readonly routes = new Map<string, FixtureRoute["get"]>();
  private startup: Promise<void> | undefined;
  private startupSettled = true;
  private completion: Promise<void> | undefined;
  private callbacksJoined = false;
  private closeState:
    | { kind: "pending" }
    | { kind: "closed" }
    | { kind: "failed"; error: unknown } = { kind: "pending" };
  private revoked = false;
  private readonly done = Promise.withResolvers<void>();
  readonly closed = this.done.promise;
  constructor(
    readonly declaration: FixtureDeclaration,
    private readonly fail: (detail: string) => void = () => {},
  ) {
    this.fixture = declaration.create();
    void this.closed.catch(() => {});
  }
  start(
    context: FixtureContext,
    validate: (routes: readonly FixtureRoute[]) => void = () => {},
  ): Promise<void> {
    if (this.startup || this.revoked) throw new Error("Fixture start already consumed or revoked");
    this.startupSettled = false;
    this.startup = Promise.resolve().then(async () => {
      const signal = AbortSignal.any([context.signal, this.controller.signal]);
      signal.throwIfAborted();
      const routes = await this.fixture.start({ ...context, signal });
      signal.throwIfAborted();
      validate(routes);
      for (const route of routes) this.routes.set(route.path, route.get);
    });
    void this.startup.then(
      () => {
        this.startupSettled = true;
      },
      (error: unknown) => {
        this.startupSettled = true;
        this.fail(formatHostError(error));
      },
    );
    return this.startup;
  }
  paths(): string[] {
    return Array.from(this.routes.keys());
  }
  has(path: string): boolean {
    return this.routes.has(path);
  }
  get(path: string, request: FixtureRequest): Promise<string> {
    if (this.revoked) return Promise.reject(new Error("Fixture admission revoked"));
    const route = this.routes.get(path);
    if (!route) return Promise.reject(new Error("Unknown fixture route"));
    const signal = AbortSignal.any([
      request.signal,
      this.controller.signal,
      AbortSignal.timeout(Math.max(0, Math.ceil(request.deadline - performance.now()))),
    ]);
    const operation = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      if (performance.now() >= request.deadline)
        throw new DOMException("Fixture deadline expired", "TimeoutError");
      const value = await route({ signal, deadline: request.deadline });
      signal.throwIfAborted();
      const encoded = jsonSnapshot(value);
      signal.throwIfAborted();
      return encoded;
    });
    const settled = operation.then(
      () => {},
      (error: unknown) => {
        this.fail(formatHostError(error));
      },
    );
    this.pending.set(settled, path);
    void settled.then(() => this.pending.delete(settled));
    return operation;
  }
  revoke(reason: string): void {
    this.revoked = true;
    this.controller.abort(reason);
  }
  private async closeWhenJoined(): Promise<void> {
    await this.startup?.catch(() => {});
    await Promise.all(this.pending.keys());
    this.callbacksJoined = true;
    try {
      await this.fixture.close();
      this.closeState = { kind: "closed" };
    } catch (error) {
      this.closeState = { kind: "failed", error };
      throw error;
    }
  }
  async finish(deadline: number): Promise<{ callbacks: CleanupStep; fixture: CleanupStep }> {
    this.revoke("fixture teardown");
    this.completion ??= this.closeWhenJoined();
    void this.completion.then(this.done.resolve, this.done.reject);
    try {
      await bounded(
        this.completion,
        Math.max(1, deadline - performance.now()),
        "fixture containment",
      );
    } catch {
      /* The actual completion remains owned by this instance. */
    }
    return {
      callbacks: this.callbacksJoined
        ? { status: "confirmed", detail: "Startup and callback serialization joined" }
        : {
            status: "unconfirmed",
            detail: `Fixture ${this.declaration.caseId}: startup settled=${this.startupSettled}; callbacks ${JSON.stringify(Array.from(this.pending.values()))} still owned; one late close owner retained`,
          },
      fixture:
        this.closeState.kind === "closed"
          ? { status: "confirmed", detail: "Single fixture close settled" }
          : {
              status: "unconfirmed",
              detail:
                this.closeState.kind === "failed"
                  ? formatHostError(this.closeState.error)
                  : "Single close waits for actual startup/callback settlement",
            },
    };
  }
}
