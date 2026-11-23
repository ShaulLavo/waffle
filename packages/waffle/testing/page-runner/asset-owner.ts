import { ObservationClosed, type Collector, type DocumentState } from "./collector.js";
import { bounded } from "./driver.js";
import { localPath, reservedPath } from "./fixture-owner.js";
import { HostConsumers } from "./owned-consumers.js";
import { formatHostError, type AssetHoldCallback, type HeldAssetRequest } from "./protocol.js";

export const assetHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cache-Control": "no-store",
};
type Delivery = { kind: "counting"; count: number } | { kind: "protected" } | { kind: "denied" };
type Scope = {
  state: DocumentState;
  doc: string;
  url: string;
  admission: { kind: "open"; check: () => void } | { kind: "revoked" };
  callbacks: Map<string, AssetHoldCallback>;
  pending: Set<Promise<void>>;
  errors: unknown[];
};
type Selection = { kind: "held" } | { kind: "selected" } | { kind: "failed"; error: unknown };

/** Owns ordinary responses and actual callback work, never cancellation-race receipts. */
export class AssetOwner {
  private readonly deliveries = new Map<DocumentState, Delivery>();
  private readonly scopes = new Map<DocumentState, Scope>();
  private readonly protectedPaths = new Set<string>();
  private sealed = false;
  private readonly assets: Readonly<Record<string, Blob | string>>;
  constructor(
    private readonly collector: Collector,
    assets: Readonly<Record<string, Blob | string>>,
    private readonly page: { path: string; script: string },
    private readonly consumers: HostConsumers,
  ) {
    this.assets = Object.freeze({ ...assets });
    consumers.register(() => this.revokeAll());
  }
  bind(state: DocumentState, check: () => void): void {
    if (!state.doc || this.scopes.has(state))
      throw new Error("Asset document binding repeated or missing");
    this.scopes.set(state, {
      state,
      doc: state.doc,
      url: state.expectedURL,
      admission: { kind: "open", check },
      callbacks: new Map(),
      pending: new Set(),
      errors: [],
    });
  }
  hold(state: DocumentState, path: string, callback: AssetHoldCallback): void {
    const scope = this.admit(state);
    localPath(path);
    if (
      reservedPath(path) ||
      /[*?{}[\]]/u.test(path) ||
      [this.page.path, this.page.script].includes(path) ||
      !Object.hasOwn(this.assets, path) ||
      this.collector.isWorkerScript(path)
    )
      throw new Error("Hold requires an existing ordinary asset path");
    if (typeof callback !== "function") throw new Error("Asset callback must be a function");
    if (scope.callbacks.has(path)) throw new Error("Asset hold already registered");
    const delivery = this.deliveries.get(state);
    if (delivery?.kind === "denied" || (delivery?.kind !== "protected" && delivery?.count !== 1))
      throw new Error("Asset hold requires exactly one executable HTML delivery");
    this.deliveries.set(state, { kind: "protected" });
    this.protectedPaths.add(path);
    scope.callbacks.set(path, callback);
  }
  private admit(state: DocumentState): Scope {
    const scope = this.scopes.get(state);
    const caseId = state.group.caseIds[0];
    if (
      !scope ||
      scope.admission.kind !== "open" ||
      state !== this.collector.active ||
      scope.doc !== state.doc ||
      scope.url !== state.expectedURL ||
      state.owner.kind !== "coordinator" ||
      state.group.role !== "case" ||
      state.group.execution !== "host" ||
      state.group.caseIds.length !== 1 ||
      !caseId ||
      this.collector.outcomes[caseId]?.status !== "running" ||
      state.host?.kind !== "driving" ||
      state.physical !== "live" ||
      state.cutoff !== null ||
      state.complete ||
      state.retiring
    )
      throw new ObservationClosed("Asset capability is not the live exact case document");
    scope.admission.check();
    return scope;
  }
  pageResponse(state: DocumentState, configuration: unknown, method: string): Response {
    const delivery = this.deliveries.get(state) ?? { kind: "counting", count: 0 };
    if (delivery.kind !== "counting") {
      this.deliveries.set(state, { kind: "denied" });
      this.revoke(state);
      throw new ObservationClosed("Protected document already delivered");
    }
    if (!configuration)
      return new Response("Unknown document token", { status: 404, headers: assetHeaders });
    if (method === "GET") delivery.count++;
    this.deliveries.set(state, delivery);
    const encoded = JSON.stringify(configuration).replaceAll("<", "\\u003c");
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Page suite</title><script>window.__suiteConfiguration=${encoded}</script><script type="module" src="${this.page.script.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></script>`,
      { headers: { ...assetHeaders, "Content-Type": "text/html" } },
    );
  }
  response(
    request: Request,
    transport: { timeout(request: Request, seconds: number): void },
  ): Response | Promise<Response> {
    const url = new URL(request.url);
    if (!this.protectedPaths.has(url.pathname) || request.method === "HEAD")
      return this.ordinary(url);
    const referer = request.headers.get("Referer");
    const state = this.collector.documents.find((item) => item.expectedURL === referer);
    if (
      !state ||
      new URL(state.expectedURL).origin !== url.origin ||
      request.method !== "GET" ||
      url.href !== `${url.origin}${url.pathname}`
    )
      throw new ObservationClosed("Missing or invalid exact asset document context");
    const scope = this.admit(state);
    const callback = scope.callbacks.get(url.pathname);
    if (!callback) return this.ordinary(url);
    transport.timeout(request, 0);
    return this.held(scope, request, url, callback);
  }
  private ordinary(url: URL): Response {
    const workerScope = this.collector.workerScriptScope(url);
    if (url.searchParams.has("waffle-run") && !workerScope)
      return new Response("Unknown worker script binding", { status: 404, headers: assetHeaders });
    const asset = Object.hasOwn(this.assets, url.pathname) ? this.assets[url.pathname] : undefined;
    return new Response(asset ?? "Not found", {
      status: asset === undefined ? 404 : 200,
      headers: {
        ...assetHeaders,
        ...(workerScope ? { "Service-Worker-Allowed": workerScope } : {}),
        "Content-Type":
          typeof asset === "string"
            ? "application/javascript"
            : asset?.type || "application/octet-stream",
      },
    });
  }
  private track<T>(scope: Scope, work: () => T | PromiseLike<T>): Promise<T> {
    const actual = this.consumers.invoke(work);
    const settled = actual.then(
      () => {},
      () => {},
    );
    scope.pending.add(settled);
    void settled.then(() => scope.pending.delete(settled));
    return actual;
  }
  private failure(scope: Scope, error: unknown): void {
    scope.errors.push(error);
    if (!this.sealed) this.collector.fail("asset", formatHostError(error), scope.state);
  }
  private held(
    scope: Scope,
    request: Request,
    url: URL,
    callback: AssetHoldCallback,
  ): Promise<Response> {
    const handoff = Promise.withResolvers<Response>();
    let selection: Selection = { kind: "held" };
    const response = this.track(scope, () => handoff.promise);
    const failUnselected = (error: unknown) => {
      if (selection.kind !== "held") return;
      selection = { kind: "failed", error };
      handoff.reject(error);
    };
    const aborted = () => failUnselected(request.signal.reason);
    request.signal.addEventListener("abort", aborted, { once: true });
    const detach = () => request.signal.removeEventListener("abort", aborted);
    void response.then(detach, detach);
    const continuation: HeldAssetRequest = {
      continue: () => {
        const operation = this.track(scope, () => {
          if (selection.kind === "selected") throw new Error("Asset continuation already selected");
          if (selection.kind === "failed") throw selection.error;
          selection = { kind: "selected" };
          request.signal.throwIfAborted();
          handoff.resolve(this.ordinary(url));
          return response.then(() => undefined);
        });
        void operation.catch((error) => {
          handoff.reject(error);
          this.failure(scope, error);
        });
        return operation;
      },
    };
    if (request.signal.aborted) aborted();
    const invoked = this.track(scope, () => Promise.resolve().then(() => callback(continuation)));
    void invoked.then(
      () => {
        if (selection.kind !== "held") return;
        const error = new Error("Asset callback returned without continue");
        failUnselected(error);
        this.failure(scope, error);
      },
      (error) => {
        failUnselected(error);
        this.failure(scope, error);
      },
    );
    return response;
  }
  revoke(state: DocumentState): void {
    const scope = this.scopes.get(state);
    if (scope) scope.admission = { kind: "revoked" };
  }
  private revokeAll(): void {
    for (const state of this.scopes.keys()) this.revoke(state);
  }
  seal(): void {
    this.sealed = true;
  }
  pending(state: DocumentState): boolean {
    return (this.scopes.get(state)?.pending.size ?? 0) !== 0;
  }
  errors(state: DocumentState): readonly unknown[] {
    return this.scopes.get(state)?.errors ?? [];
  }
  async join(state: DocumentState, until: number): Promise<boolean> {
    this.revoke(state);
    const scope = this.scopes.get(state);
    if (!scope) return true;
    try {
      while (scope.pending.size)
        await bounded(
          Promise.all(scope.pending),
          Math.max(0, until - performance.now()),
          "asset work join",
        );
      return performance.now() <= until;
    } catch {
      return false;
    }
  }
}
