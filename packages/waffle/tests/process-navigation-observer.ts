import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Browser, BrowserContext, Frame, Page, Request as BrowserRequest } from "playwright";

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

const retainedBudget = 32 * 1024;
const navigationHeader = "x-waffle-navigation-id";
const diagnosticErrors: unknown[] = [];
let capture: NavigationCapture | undefined;

export function navigationDiagnosticErrors(): readonly unknown[] {
  return diagnosticErrors;
}

function secondaryFailure(phase: string, error: unknown): void {
  diagnosticErrors.push(error);
  try {
    console.error("PROCESS_NAVIGATION_SECONDARY_FAILURE", phase, error);
  } catch (loggingError) {
    diagnosticErrors.push(loggingError);
  }
}

function observe(action: () => void): void {
  try {
    action();
  } catch (error) {
    secondaryFailure("observer", error);
  }
}

function diagnosticLog(label: string, value: unknown): void {
  observe(() => console.log(label, typeof value === "string" ? value : JSON.stringify(value)));
}

function navigationId(value: string | null | undefined): string | null {
  return value && /^page-[0-9]+-target$/.test(value) ? value : null;
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Navigation capture ${phase} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class CaptureBuffer {
  private readonly chunks: string[] = [];
  private retainedBytes = 0;
  private evictedBytes = 0;

  constructor(private readonly budget: number) {}

  append(text: string): void {
    if (!text) return;
    const retained = text.slice(-Math.floor(this.budget / 2));
    this.evictedBytes += (text.length - retained.length) * 2;
    this.chunks.push(retained);
    this.retainedBytes += retained.length * 2;
    while (this.retainedBytes > this.budget) {
      const removed = this.chunks.shift()!.length * 2;
      this.retainedBytes -= removed;
      this.evictedBytes += removed;
    }
  }

  snapshot(): { text: string; retainedBytes: number; evictedBytes: number } {
    return {
      text: this.chunks.join(""),
      retainedBytes: this.retainedBytes,
      evictedBytes: this.evictedBytes,
    };
  }
}

function evidenceDirectory(): string {
  const directory = process.env.PROCESS_NAVIGATION_WIRE_DIR;
  if (!directory || !isAbsolute(directory))
    throw new Error(
      "PROCESS_NAVIGATION_WIRE_DIR must name an absolute task-owned evidence directory",
    );
  const root = realpathSync(directory);
  const scratch = process.env.TMPDIR;
  if (!scratch) return root;
  const location = relative(realpathSync(scratch), root);
  if (
    location === "" ||
    (!location.startsWith(`..${sep}`) && location !== ".." && !isAbsolute(location))
  )
    throw new Error("Navigation wire evidence directory must be outside disposable TMPDIR");
  return root;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeSnapshot(directory: string, value: unknown): void {
  const pending = join(directory, "snapshot.pending");
  const descriptor = openSync(pending, "w", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(value));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(pending, join(directory, "snapshot.json"));
  syncDirectory(directory);
}

class NavigationCapture {
  private child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  private readonly output: CaptureBuffer;
  private readonly hex = process.env.PROCESS_NAVIGATION_WIRE_FORMAT === "hex";
  private updates = Promise.withResolvers<void>();
  private readonly diagnostics = new CaptureBuffer(16 * 1024);
  private readonly errors = new CaptureBuffer(16 * 1024);
  private failureCount = 0;
  private evidence: { directory: string; writable: boolean } | undefined;
  private readonly readiness = Promise.withResolvers<void>();
  private readonly readers: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    completion: Promise<void>;
  }[] = [];
  private stopping: Promise<void> | undefined;
  private ready = false;
  private stopped = false;
  private unexpectedExit = false;

  constructor(private readonly serverPort: number) {
    this.output = new CaptureBuffer(this.hex ? 8 * 1024 * 1024 : 1024 * 1024);
  }

  async start(): Promise<void> {
    const serverPort = this.serverPort;
    const root = evidenceDirectory();
    this.evidence = {
      directory: mkdtempSync(join(root, "process-navigation-wire-")),
      writable: true,
    };
    diagnosticLog("PROCESS_NAVIGATION_EVIDENCE_OWNER", {
      directory: this.evidence.directory,
      snapshot: "snapshot.json",
      collection: "task owner collects before teardown; capture stop preserves files",
    });
    writeSnapshot(this.evidence.directory, this.snapshot("capture-starting"));
    syncDirectory(root);
    this.child = Bun.spawn(
      [
        "/usr/bin/tcpdump",
        "-i",
        "lo",
        "-nn",
        "-tt",
        "-l",
        "-s",
        this.hex ? "0" : "512",
        this.hex ? "-xx" : "-A",
        `tcp and host 127.0.0.1 and port ${serverPort}`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    void this.child.exited.then(
      (status) => this.onExit(status),
      (error: unknown) => this.readerFailure("process", error),
    );
    diagnosticLog("PROCESS_NAVIGATION_CAPTURE_OWNER", {
      pid: this.child.pid,
      serverPort,
      address: "127.0.0.1",
      interface: "lo",
      snaplen: this.hex ? 0 : 512,
      monotonicMs: performance.now(),
      wallClockMs: Date.now(),
    });
    this.persist("capture-spawned");
    this.ownReader(this.child.stdout, "stdout");
    this.ownReader(this.child.stderr, "stderr");
    await bounded(this.readiness.promise, 5000, "startup");
    if (this.stopping || this.child.exitCode !== null)
      throw new Error("Navigation capture stopped before browser launch");
  }

  private ownReader(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): void {
    const reader = stream.getReader();
    this.readers.push({ reader, completion: this.read(reader, name) });
  }

  private onExit(status: number): void {
    if (!this.stopping) {
      this.unexpectedExit = true;
      this.readerFailure("unexpected exit", new Error(`Navigation capture exited with ${status}`));
    }
  }

  private failure(phase: string, error: unknown): void {
    this.failureCount++;
    this.errors.append(`${phase}: ${String(error)}\n`);
    secondaryFailure(`capture ${phase}`, error);
    this.persist("capture-error");
  }

  private readerFailure(phase: string, error: unknown): void {
    this.failure(phase, error);
    this.readiness.reject(error);
  }

  private persist(reason: string): void {
    if (!this.evidence?.writable) return;
    try {
      writeSnapshot(this.evidence.directory, this.snapshot(reason));
    } catch (error) {
      this.evidence.writable = false;
      secondaryFailure("capture evidence persistence", error);
    }
  }

  private append(text: string, stream: "stdout" | "stderr"): void {
    if (stream === "stdout") {
      this.output.append(text);
      this.persist("stdout-consumed");
      this.changed();
      return;
    }
    this.diagnostics.append(text);
    if (!this.ready && this.diagnostics.snapshot().text.includes("listening on lo,")) {
      this.ready = true;
      this.readiness.resolve();
    }
    this.persist("stderr-consumed");
    this.changed();
  }

  private async read(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    stream: "stdout" | "stderr",
  ): Promise<void> {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        this.append(decoder.decode(chunk.value, { stream: true }), stream);
      }
      this.append(decoder.decode(), stream);
    } catch (error) {
      this.readerFailure(stream, error);
    }
  }

  private changed(): void {
    this.updates.resolve();
    this.updates = Promise.withResolvers<void>();
  }

  assertReady(): void {
    this.persist("strict-admission");
    if (!this.evidence?.writable) throw new Error("Navigation capture durable sink unavailable");
    if (!this.ready || this.stopping || this.child?.exitCode !== null)
      throw new Error("Navigation capture is not live and ready");
    const state = this.snapshot("strict-admission");
    if (state.failureCount || state.output.evictedBytes || state.diagnostics.evictedBytes)
      throw new Error("Navigation capture evidence is incomplete");
  }

  async waitFor(
    check: (state: ReturnType<NavigationCapture["snapshot"]>) => boolean,
  ): Promise<void> {
    await bounded(this.until(check), 5000, "wire preflight");
    this.assertReady();
  }

  private async until(
    check: (state: ReturnType<NavigationCapture["snapshot"]>) => boolean,
  ): Promise<void> {
    while (true) {
      this.assertReady();
      if (check(this.snapshot("wire-preflight"))) return;
      await this.updates.promise;
    }
  }

  snapshot(reason: string) {
    return {
      reason,
      wallClockMs: Date.now(),
      monotonicMs: performance.now(),
      serverPort: this.serverPort,
      ready: this.ready,
      stopped: this.stopped,
      exitCode: this.child?.exitCode ?? null,
      unexpectedExit: this.unexpectedExit,
      snaplen: this.hex ? 0 : 512,
      inference:
        "retained records only; queued capture tail and cancellation window are unvalidated",
      closingBoundary: "unvalidated",
      format: this.hex ? "ethernet-hex" : "ascii",
      durable: this.evidence?.writable ?? false,
      output: this.output.snapshot(),
      diagnostics: this.diagnostics.snapshot(),
      errors: this.errors.snapshot(),
      failureCount: this.failureCount,
    };
  }

  emit(reason: string): void {
    this.persist(reason);
    diagnosticLog("PROCESS_NAVIGATION_WIRE", this.snapshot(reason));
  }

  stop(): Promise<void> {
    return (this.stopping ??= Promise.resolve().then(() => this.close()));
  }

  private async waitForExit(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
    try {
      const status = await bounded(child.exited, 2000, "SIGINT exit");
      if (status !== 0) this.failure("exit", new Error(`Capture exit status ${status}`));
    } catch (error) {
      this.failure("SIGINT shutdown", error);
      observe(() => child.kill("SIGKILL"));
      await bounded(child.exited, 2000, "SIGKILL exit");
    }
  }

  private async joinReaders(): Promise<void> {
    const completions = Promise.all(this.readers.map(({ completion }) => completion));
    try {
      await bounded(completions, 2000, "output readers");
    } catch (error) {
      this.failure("output shutdown", error);
      await this.cancelReaders();
    } finally {
      for (const { reader } of this.readers) observe(() => reader.releaseLock());
    }
  }

  private async cancelReaders(): Promise<void> {
    try {
      const cancellations = this.readers.map(({ reader }) => reader.cancel());
      const results = await bounded(Promise.allSettled(cancellations), 2000, "reader cancellation");
      const rejected = results.filter((result) => result.status === "rejected");
      for (const result of rejected) this.failure("cancellation", result.reason);
    } catch (error) {
      this.failure("cancellation", error);
    }
    await bounded(
      Promise.all(this.readers.map(({ completion }) => completion)),
      2000,
      "cancelled readers",
    );
  }

  private async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      if (child.exitCode === null) observe(() => child.kill("SIGINT"));
      await this.waitForExit(child);
    } catch (error) {
      this.failure("process shutdown", error);
    }
    try {
      await this.joinReaders();
      this.stopped = child.exitCode !== null;
    } catch (error) {
      this.failure("reader join", error);
    }
    if (!this.stopped) this.failure("ownership", new Error("Capture shutdown unconfirmed"));
    this.emit("capture-stopped");
  }
}

export async function startNavigationCapture(serverPort: number | undefined): Promise<void> {
  if (process.env.PROCESS_NAVIGATION_WIRE !== "1") return;
  if (serverPort === undefined) throw new Error("Navigation capture requires a TCP server port");
  capture = new NavigationCapture(serverPort);
  await capture.start();
}

export function navigationCaptureSnapshot() {
  if (!capture) throw new Error("Navigation capture is disabled or unstarted");
  return capture.snapshot("readback");
}

export function assertNavigationCaptureReady(): void {
  if (!capture) throw new Error("Navigation capture is disabled or unstarted");
  capture.assertReady();
}

export async function waitForNavigationCapture(
  check: (state: ReturnType<typeof navigationCaptureSnapshot>) => boolean,
): Promise<void> {
  if (!capture) throw new Error("Navigation capture is disabled or unstarted");
  await capture.waitFor(check);
}

export async function stopNavigationCapture(): Promise<void> {
  await capture?.stop();
}

export type RootRequestObservation = {
  serverRequestOrdinal: number;
  serverNavigationId: string | null;
  clientPort: number | null;
  serverPort: number | null;
  method: string;
};

export function observeRootRequest(
  request: globalThis.Request,
  peer: () => { port: number } | null,
  serverPort: number | undefined,
): RootRequestObservation | undefined {
  try {
    const detail = {
      serverRequestOrdinal: ++serverOrdinal,
      serverNavigationId: navigationId(request.headers.get(navigationHeader)),
      clientPort: peer()?.port ?? null,
      serverPort: serverPort ?? null,
      method: request.method,
    };
    observeRootHandler("entry", detail);
    return detail;
  } catch (error) {
    secondaryFailure("root request observation", error);
    return undefined;
  }
}
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
  observe(() => capture?.emit(reason));
  observe(() => {
    const header = JSON.stringify({ reason, retainedCost, retainedBudget, summary });
    diagnosticLog(
      "PROCESS_NAVIGATION_TRANSCRIPT",
      `${header.slice(0, -1)},"events":[${events.map(({ json }) => json).join(",")}]}`,
    );
  });
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
  observe(() => browser.on("disconnected", () => current?.record("browser-disconnected")));
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
  diagnosticLog("PROCESS_NAVIGATION_SUMMARY", summary);
  current = undefined;
  summary = undefined;
}

export function observeRootHandler(
  phase: "entry" | "response-return",
  detail: RootRequestObservation | undefined,
): void {
  if (!detail) return;
  current?.record(`server-root-${phase}`, {
    ...detail,
    attribution: "header-and-peer-observed; active-window-label",
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
  private readonly requests = new WeakMap<BrowserRequest, string>();

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

  requestHeaders(): Record<string, string> {
    return capture ? { [navigationHeader]: this.identity.targetDocument } : {};
  }

  record(event: string, detail: Detail = {}): void {
    try {
      retain(this.identity, event, { document: this.document, ...detail });
    } catch (error) {
      secondaryFailure("event observation", error);
    }
  }

  recordRejection(event: string, error: unknown): void {
    observe(() =>
      this.record(event, { errorType: error instanceof Error ? error.name : typeof error }),
    );
  }

  failed(error: unknown): void {
    this.rejected = true;
    if (summary) summary.failures++;
    this.recordRejection("invocation-rejected", error);
    emitTranscript("invocation-rejected-before-context-cleanup");
  }

  contextClosed(): void {
    this.record("context-close-fulfilled");
    if (this.rejected) emitTranscript("invocation-rejected-after-context-cleanup");
  }

  observeContext(context: BrowserContext): void {
    observe(() => {
      this.record("context-create-fulfilled");
      context.on("close", () => this.record("context-close-event"));
      context.on("page", () => this.record("context-page-event"));
      this.record("page-create-begin");
    });
  }

  observePage(page: Page, targetUrl: string): void {
    observe(() => this.attachPage(page, targetUrl));
  }

  private attachPage(page: Page, targetUrl: string): void {
    this.targetUrl = targetUrl;
    this.record("page-create-fulfilled", { route: route(page.url()) });
    page.on("request", (request) => this.observeRequest(page, request, "document-request"));
    page.on("response", (response) =>
      observe(() =>
        this.observeRequest(page, response.request(), "document-response", {
          status: response.status(),
        }),
      ),
    );
    page.on("requestfinished", (request) =>
      this.observeRequest(page, request, "document-finished"),
    );
    page.on("requestfailed", (request) =>
      observe(() =>
        this.observeRequest(page, request, "document-failed", {
          failure: (request.failure()?.errorText ?? "unknown")
            .replace(/https?:\/\/[^\s"'<>]+/g, "<url>")
            .slice(0, 256),
        }),
      ),
    );
    page.on("framenavigated", (frame) => observe(() => this.observeFrame(page, frame)));
    page.on("domcontentloaded", () =>
      observe(() => this.record("domcontentloaded", { route: route(page.url()) })),
    );
    page.on("load", () => observe(() => this.record("load", { route: route(page.url()) })));
    page.on("crash", () => this.record("page-crash"));
    page.on("close", () => this.record("page-close"));
  }

  private observeFrame(page: Page, frame: Frame): void {
    if (frame !== page.mainFrame()) return;
    this.document =
      frame.url() === this.targetUrl ? this.identity.targetDocument : route(frame.url());
    this.record("main-frame-navigated", { route: route(frame.url()) });
  }

  private observeRequest(
    page: Page,
    request: BrowserRequest,
    event: string,
    detail: Detail = {},
  ): void {
    try {
      this.recordRequest(page, request, event, detail);
    } catch (error) {
      secondaryFailure("native request observation", error);
    }
  }

  private recordRequest(page: Page, request: BrowserRequest, event: string, detail: Detail): void {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    let requestId = this.requests.get(request);
    if (!requestId) {
      requestId = `page-${this.identity.pageOrdinal}-request-${++this.requestOrdinal}`;
      this.requests.set(request, requestId);
    }
    this.record(event, {
      requestId,
      navigationId: navigationId(request.headers()[navigationHeader]),
      requestDocument:
        request.url() === this.targetUrl ? this.identity.targetDocument : route(request.url()),
      route: route(request.url()),
      ...detail,
    });
  }
}
