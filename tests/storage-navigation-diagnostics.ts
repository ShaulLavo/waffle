import type {
  Browser,
  BrowserContext,
  Frame,
  Page,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from "playwright";

export type NavigationServerEvent =
  | { kind: "request"; method: string; path: string }
  | { kind: "response-constructed"; path: string; status: number }
  | { kind: "request-aborted"; path: string }
  | { kind: "server-error"; name: string };

export class NavigationDiagnostics {
  private events: string[] = [];
  private capacity = 96;
  private dropped = 0;
  private started = Date.now();

  record(event: string): void {
    const clean = event.replace(/[\r\n]+/g, " ").slice(0, 240);
    if (this.events.length === this.capacity) {
      this.events.shift();
      this.dropped++;
    }
    this.events.push(`+${Date.now() - this.started}ms ${clean}`);
  }

  report(caseName: string): string {
    const lines = [`Navigation diagnostics for ${caseName}`].concat(
      this.events,
      this.dropped ? [`${this.dropped} earlier event(s) dropped`] : [],
      [
        "response-constructed is local only; wire delivery and native cancellation reason remain unknown",
      ],
    );
    return lines.join("\n");
  }
}

export function formatNavigationServerEvent(event: NavigationServerEvent): string {
  switch (event.kind) {
    case "request":
      return `server request ${event.method} ${event.path}`;
    case "response-constructed":
      return `server response-constructed ${event.status} ${event.path}`;
    case "request-aborted":
      return `server request-aborted ${event.path}`;
    case "server-error":
      return `server error ${event.name}`;
  }
}

export function storageNavigationResponse(
  request: Request,
  routes: Record<string, Blob | string>,
  observe: (event: NavigationServerEvent) => void,
): Response {
  const path = new URL(request.url).pathname;
  const body = routes[path];
  emitNavigationEvent(observe, { kind: "request", method: request.method, path });
  const aborted = () => emitNavigationEvent(observe, { kind: "request-aborted", path });
  if (request.signal.aborted) aborted();
  else request.signal.addEventListener("abort", aborted, { once: true });
  const response = new Response(body ?? "Not found", {
    status: body === undefined ? 404 : 200,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "cache-control": "no-store",
      "content-type": path.endsWith(".js") ? "text/javascript" : "text/html",
    },
  });
  emitNavigationEvent(observe, { kind: "response-constructed", path, status: response.status });
  return response;
}

function emitNavigationEvent(
  observe: (event: NavigationServerEvent) => void,
  event: NavigationServerEvent,
): void {
  try {
    observe(event);
  } catch {}
}

const errorCategories = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

function navigationErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "NonError";
  return errorCategories.has(error.name) ? error.name : "Error";
}

function requestFailureCategory(request: PlaywrightRequest): string {
  switch (request.failure()?.errorText) {
    case "Load request cancelled":
      return "cancelled";
    case "net::ERR_ABORTED":
    case "NS_BINDING_ABORTED":
      return "aborted";
    case undefined:
      return "unknown";
    default:
      return "failed";
  }
}

export function navigationServerError(error: unknown): NavigationServerEvent {
  return { kind: "server-error", name: navigationErrorCategory(error) };
}

type PageEvents = Pick<Page, "on" | "off" | "mainFrame">;
type NavigationPage = PageEvents & Pick<Page, "goto">;
type ContextEvents = Pick<BrowserContext, "on" | "off">;
type BrowserEvents = Pick<Browser, "on" | "off">;

function observeNavigation(
  diagnostics: NavigationDiagnostics,
  page: PageEvents,
  context: ContextEvents,
  browser: BrowserEvents,
): () => void {
  const requested = (request: PlaywrightRequest) =>
    diagnostics.record(`page request ${request.method()} ${new URL(request.url()).pathname}`);
  const responded = (response: PlaywrightResponse) =>
    diagnostics.record(`page response ${response.status()} ${new URL(response.url()).pathname}`);
  const failed = (request: PlaywrightRequest) =>
    diagnostics.record(
      `page requestfailed ${new URL(request.url()).pathname} ${requestFailureCategory(request)}`,
    );
  const finished = (request: PlaywrightRequest) =>
    diagnostics.record(`page requestfinished ${new URL(request.url()).pathname}`);
  const navigated = (frame: Frame) => {
    if (frame === page.mainFrame())
      diagnostics.record(`page framenavigated ${new URL(frame.url()).pathname}`);
  };
  const loaded = () => diagnostics.record("page load");
  const dom = () => diagnostics.record("page domcontentloaded");
  const crashed = () => diagnostics.record("page crash");
  const pageClosed = () => diagnostics.record("page close");
  const errored = (error: Error) =>
    diagnostics.record(`page pageerror ${navigationErrorCategory(error)}`);
  const contextClosed = () => diagnostics.record("context close");
  const disconnected = () => diagnostics.record("browser disconnected");
  page.on("request", requested);
  page.on("response", responded);
  page.on("requestfailed", failed);
  page.on("requestfinished", finished);
  page.on("framenavigated", navigated);
  page.on("load", loaded);
  page.on("domcontentloaded", dom);
  page.on("crash", crashed);
  page.on("close", pageClosed);
  page.on("pageerror", errored);
  context.on("close", contextClosed);
  browser.on("disconnected", disconnected);
  let observing = true;
  return () => {
    if (!observing) return;
    observing = false;
    page.off("request", requested);
    page.off("response", responded);
    page.off("requestfailed", failed);
    page.off("requestfinished", finished);
    page.off("framenavigated", navigated);
    page.off("load", loaded);
    page.off("domcontentloaded", dom);
    page.off("crash", crashed);
    page.off("close", pageClosed);
    page.off("pageerror", errored);
    context.off("close", contextClosed);
    browser.off("disconnected", disconnected);
  };
}

type StorageNavigation = {
  diagnostics: NavigationDiagnostics;
  page: NavigationPage;
  context: ContextEvents;
  browser: BrowserEvents;
  target: string;
  caseName: string;
  report: (diagnostic: string) => void;
};

export async function storageNavigate({
  diagnostics,
  page,
  context,
  browser,
  target,
  caseName,
  report,
}: StorageNavigation): Promise<void> {
  const stop = observeNavigation(diagnostics, page, context, browser);
  try {
    await page.goto(target);
  } catch (error) {
    try {
      report(diagnostics.report(caseName));
    } catch {}
    throw error;
  } finally {
    stop();
  }
}
