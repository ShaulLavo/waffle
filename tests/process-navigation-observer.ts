import type { Browser, BrowserContext, Page, Request } from "playwright";

type NavigationIdentity = {
  engine: string;
  caseLabel: string;
  pageOrdinal: number;
  targetDocument: string;
};
type Detail = Record<string, string | number | boolean | null>;
type EngineSummary = {
  engine: string;
  pages: number;
  events: number;
  dropped: number;
  failures: number;
  maxEventLoopGapMs: number;
  counts: Record<string, number>;
};

// Leave ample room below 256 KiB for serialization and event/string overhead.
// Retain recent events, including the preceding context's retirement, not whole runs.
const retainedBudget = 32 * 1024;
const events: { json: string; cost: number }[] = [];
let retainedCost = 0;
let ordinal = 0;
let serverOrdinal = 0;
let current: NavigationObservation | undefined;
let summary: EngineSummary | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function retain(identity: NavigationIdentity, event: string, detail: Detail): void {
  const json = JSON.stringify({ ...identity, monotonicMs: performance.now(), event, ...detail });
  const cost = json.length * 2 + 64;
  if (cost > retainedBudget) return;
  while (retainedCost + cost > retainedBudget) {
    retainedCost -= events.shift()!.cost;
    if (summary) summary.dropped++;
  }
  events.push({ json, cost });
  retainedCost += cost;
  if (summary) {
    summary.events++;
    summary.counts[event] = (summary.counts[event] ?? 0) + 1;
  }
}

function emitTranscript(reason: string): void {
  const header = JSON.stringify({ reason, retainedCost, retainedBudget, summary });
  console.log(
    "PROCESS_NAVIGATION_TRANSCRIPT",
    `${header.slice(0, -1)},"events":[${events.map(({ json }) => json).join(",")}]}`,
  );
}

function route(url: string): string {
  if (url === "about:blank") return url;
  const parsed = URL.parse(url);
  if (parsed?.hostname === "127.0.0.1") return parsed.pathname.slice(0, 128);
  return "other-document";
}

export function startNavigationEngine(engine: string): void {
  summary = {
    engine,
    pages: 0,
    events: 0,
    dropped: 0,
    failures: 0,
    maxEventLoopGapMs: 0,
    counts: {},
  };
  current = undefined;
  let last = performance.now();
  let ticks = 0;
  heartbeat = setInterval(() => {
    const now = performance.now();
    const elapsedMs = now - last;
    last = now;
    const gapMs = Math.max(0, elapsedMs - 1000);
    if (summary) summary.maxEventLoopGapMs = Math.max(summary.maxEventLoopGapMs, gapMs);
    ticks++;
    if (ticks === 1 || ticks % 5 === 0 || gapMs >= 100)
      current?.record("host-heartbeat", { elapsedMs, gapMs, ticks });
  }, 1000);
  heartbeat.unref();
}

export function observeNavigationBrowser(browser: Browser): void {
  browser.on("disconnected", () => current?.record("browser-disconnected"));
}

export function failNavigationEngine(error: unknown): void {
  if (current) {
    current.failed(error);
    return;
  }
  if (summary) summary.failures++;
  emitTranscript("engine-setup-rejected");
}

export function finishNavigationEngine(): void {
  clearInterval(heartbeat);
  if (summary?.failures) emitTranscript("engine-finished-with-failure");
  console.log("PROCESS_NAVIGATION_SUMMARY", JSON.stringify(summary));
  current = undefined;
  summary = undefined;
}

// The server sees no Playwright request ID. Attribution is only to the active
// window; the server request ordinal is deliberately not a client request ID.
export function observeRootHandler(phase: "entry" | "response-return"): void {
  if (phase === "entry") serverOrdinal++;
  current?.record(`server-root-${phase}`, {
    serverRequestOrdinal: serverOrdinal,
    attribution: "active-window-only",
    route: "/",
  });
}

export class NavigationObservation {
  static begin(engine: string, label?: string): NavigationObservation {
    const observation = new NavigationObservation(engine, label);
    current = observation;
    return observation;
  }

  readonly identity: NavigationIdentity;
  private document = "about:blank";
  private targetUrl = "";
  private requestOrdinal = 0;
  private rejected = false;
  private readonly requests = new WeakMap<Request, string>();

  constructor(engine: string, label?: string) {
    ordinal++;
    this.identity = {
      engine,
      caseLabel: (label ?? "<case-discovery>").slice(0, 512),
      pageOrdinal: ordinal,
      targetDocument: `page-${ordinal}-target`,
    };
    if (summary) summary.pages++;
    this.record("context-create-begin");
  }

  record(event: string, detail: Detail = {}): void {
    retain(this.identity, event, { document: this.document, ...detail });
  }

  failed(error: unknown): void {
    this.rejected = true;
    if (summary) summary.failures++;
    this.record("invocation-rejected", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    emitTranscript("invocation-rejected-before-context-cleanup");
  }

  contextClosed(): void {
    this.record("context-close-fulfilled");
    if (this.rejected) emitTranscript("invocation-rejected-after-context-cleanup");
  }

  observeContext(context: BrowserContext): void {
    this.record("context-create-fulfilled");
    context.on("close", () => this.record("context-close-event"));
    context.on("page", () => this.record("context-page-event"));
    this.record("page-create-begin");
  }

  observePage(page: Page, targetUrl: string): void {
    this.targetUrl = targetUrl;
    this.record("page-create-fulfilled", { route: route(page.url()) });
    page.on("request", (request) => this.observeRequest(page, request, "document-request"));
    page.on("response", (response) =>
      this.observeRequest(page, response.request(), "document-response", {
        status: response.status(),
      }),
    );
    page.on("requestfinished", (request) =>
      this.observeRequest(page, request, "document-finished"),
    );
    page.on("requestfailed", (request) =>
      this.observeRequest(page, request, "document-failed", {
        failure: (request.failure()?.errorText ?? "unknown")
          .replace(/https?:\/\/[^\s"'<>]+/g, "<url>")
          .slice(0, 256),
      }),
    );
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      this.document =
        frame.url() === this.targetUrl ? this.identity.targetDocument : route(frame.url());
      this.record("main-frame-navigated", { route: route(frame.url()) });
    });
    page.on("domcontentloaded", () =>
      this.record("domcontentloaded", { route: route(page.url()) }),
    );
    page.on("load", () => this.record("load", { route: route(page.url()) }));
    page.on("crash", () => this.record("page-crash"));
    page.on("close", () => this.record("page-close"));
  }

  private observeRequest(page: Page, request: Request, event: string, detail: Detail = {}): void {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    let requestId = this.requests.get(request);
    if (!requestId) {
      requestId = `page-${this.identity.pageOrdinal}-request-${++this.requestOrdinal}`;
      this.requests.set(request, requestId);
    }
    this.record(event, {
      requestId,
      requestDocument:
        request.url() === this.targetUrl ? this.identity.targetDocument : route(request.url()),
      route: route(request.url()),
      ...detail,
    });
  }
}
