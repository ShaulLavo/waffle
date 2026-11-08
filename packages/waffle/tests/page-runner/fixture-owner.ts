import { bounded, type CleanupStep } from "./driver.js";
import { jsonSnapshot } from "./json-snapshot.js";
export interface FixtureContext {
  readonly origin: string;
  readonly run: string;
  readonly scratch: string;
  readonly signal: AbortSignal;
}
export interface FixtureRequest { readonly signal: AbortSignal }
export interface FixtureRoute {
  readonly path: string;
  readonly get: (request: FixtureRequest) => Promise<unknown>;
}
export interface SuiteFixture {
  start(context: FixtureContext): Promise<readonly FixtureRoute[]>;
  close(): Promise<void>;
}
export interface FixtureDeclaration {
  readonly caseId: string;
  readonly create: () => SuiteFixture;
}
export function localPath(path: string): void {
  const url = new URL(path, "http://localhost");
  if (!path.startsWith("/") || path.startsWith("//") || url.origin !== "http://localhost" ||
      url.pathname !== path || url.search || url.hash || /[%\\\s<>"']/u.test(path))
    throw new Error("Expected a canonical same-origin local path");
}
export function reservedPath(path: string): boolean {
  return ["/report", "/heartbeat", "/retire", "/favicon.ico"].includes(path) ||
    path.startsWith("/_waffle_owned/");
}
/** Owns real promises, including JSON serialization. A deadline never settles them. */
export class FixtureOwner {
  private readonly fixture: SuiteFixture;
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private routes: readonly FixtureRoute[] = [];
  private startup: Promise<void> | undefined;
  private startupSettled = true;
  private completion: Promise<void> | undefined;
  private callbacksJoined = false;
  private closeSettled = false;
  private closeFailure: unknown;
  private revoked = false;
  private readonly done = Promise.withResolvers<void>();
  readonly closed = this.done.promise;
  constructor(readonly declaration: FixtureDeclaration, private readonly fail: (detail: string) => void = () => {}) {
    this.fixture = declaration.create();
    void this.closed.catch(() => {});
  }
  start(context: FixtureContext, validate: (routes: readonly FixtureRoute[]) => void = () => {}): Promise<void> {
    if (this.startup || this.revoked) throw new Error("Fixture start already consumed or revoked");
    this.startupSettled = false;
    this.startup = Promise.resolve().then(async () => {
      const signal = AbortSignal.any([context.signal, this.controller.signal]);
      signal.throwIfAborted();
      const routes = await this.fixture.start({ ...context, signal });
      signal.throwIfAborted();
      validate(routes);
      this.routes = routes;
    });
    void this.startup.then(() => { this.startupSettled = true; }, (error: unknown) => {
      this.startupSettled = true;
      this.fail(String(error));
    });
    return this.startup;
  }
  paths(): string[] { return this.routes.map((route) => route.path); }
  has(path: string): boolean { return this.routes.some((route) => route.path === path); }
  get(path: string, requestSignal: AbortSignal): Promise<string> {
    if (this.revoked) return Promise.reject(new Error("Fixture admission revoked"));
    const route = this.routes.find((item) => item.path === path);
    if (!route) return Promise.reject(new Error("Unknown fixture route"));
    const signal = AbortSignal.any([requestSignal, this.controller.signal]);
    const operation = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const value = await route.get({ signal });
      signal.throwIfAborted();
      const encoded = jsonSnapshot(value);
      signal.throwIfAborted();
      return encoded;
    });
    const settled = operation.then(() => {}, (error: unknown) => { this.fail(String(error)); });
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return operation;
  }
  revoke(reason: string): void {
    this.revoked = true;
    this.controller.abort(reason);
  }
  private async closeWhenJoined(): Promise<void> {
    await this.startup?.catch(() => {});
    await Promise.all(this.pending);
    this.callbacksJoined = true;
    try { await this.fixture.close(); }
    catch (error) { this.closeFailure = error; throw error; }
    finally { this.closeSettled = true; }
  }
  async finish(deadline: number): Promise<{ callbacks: CleanupStep; fixture: CleanupStep }> {
    this.revoke("fixture teardown");
    this.completion ??= this.closeWhenJoined();
    void this.completion.then(this.done.resolve, this.done.reject);
    try { await bounded(this.completion, Math.max(1, deadline - performance.now()), "fixture containment"); }
    catch { /* The actual completion remains owned by this instance. */ }
    return {
      callbacks: this.callbacksJoined ? { status: "confirmed", detail: "Startup and callback serialization joined" } :
        { status: "unconfirmed", detail: `Startup settled=${this.startupSettled}; ${this.pending.size} callbacks still owned; late close owner retained` },
      fixture: this.closeSettled && !this.closeFailure ? { status: "confirmed", detail: "Single fixture close settled" } :
        { status: "unconfirmed", detail: this.closeFailure ? String(this.closeFailure) : "Single close waits for actual startup/callback settlement" },
    };
  }
}
