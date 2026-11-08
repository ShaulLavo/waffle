import { navigateTestPage } from "../browser-navigation.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { isAbsolute, join } from "node:path";
import { chromium, webkit, type Browser, type Page, type Frame } from "playwright";
import {
  createFrameworkControl,
  type FrameworkHost,
  type FrameworkResult,
} from "waffle/testing/page-runner/framework";
import { writeResult } from "./suite-host.js";
import { record } from "./protocol.js";

export const frameworkControlModes = [
  "pass",
  "delayed-admission",
  "declared-clock",
  "entry-tester",
  "known-frame-error",
  "replace",
  "extra",
  "reload",
  "between-cutoffs",
  "missing-cleanup",
  "final-ack-loss",
  "explicit-viewport",
  "repeat-viewport",
  "wrong-frame",
  "wrong-permit",
  "different-size",
  "missing-geometry",
  "operation-pass",
  "operation-viewport-changed",
  "operation-correlation",
  "operation-fractional",
  "operation-malformed",
  "operation-wrong-file",
  "operation-selected-lie",
  "operation-flush-held",
  "operation-cleanup-held",
  "operation-top-cleanup-held",
  "operation-queued-closed",
  "operation-transient-frame",
  "operation-transient-ancestor",
  "operation-same-url",
  "operation-top-pagehide",
  "operation-tester-pagehide",
  "operation-callback-rejection",
] as const;
async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing control listener address");
  return `http://127.0.0.1:${address.port}`;
}
async function stopServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text ? JSON.parse(text) : null;
}
type DOMState = {
  host: FrameworkHost | undefined;
  middleware: FrameworkHost["middleware"] | undefined;
  page: Page | undefined;
  active: Page | Frame | undefined;
  selected: boolean;
  entryRestored: boolean;
  sessionDeletes: number;
  sessionPosts: number;
  scripts: string[];
  delayed: boolean;
  mode: string;
  operations: string[];
  viewportObservations: unknown[];
  viewportChanged: boolean;
  concurrentRequests: number;
  concurrentRelease: PromiseWithResolvers<void>;
  concurrentSettled: PromiseWithResolvers<void>;
  releaseReport: (() => void) | undefined;
  reportHeld: PromiseWithResolvers<void>;
};
async function webdriver(
  state: DOMState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = request.url ?? "/",
    payload = await body(request);
  let value: unknown = null;
  if (path === "/session") {
    state.sessionPosts++;
    value = {
      sessionId: "dom-control",
      capabilities: {
        browserName: "Safari",
        browserVersion: "HTTP DOM CONTROL, NOT SAFARI",
        platformName: "iOS",
        "safari:useSimulator": true,
        "safari:deviceUDID": "dom-control",
      },
    };
  }
  if (request.method === "DELETE") state.sessionDeletes++;
  if (path.endsWith("/window")) value = "actual-owned-window";
  if (path.endsWith("/window/handles")) value = ["actual-owned-window"];
  if (path.endsWith("/execute/sync")) value = await execute(state, payload);
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ value }));
}
async function execute(state: DOMState, payload: unknown): Promise<unknown> {
  if (!record(payload) || typeof payload.script !== "string" || !state.active)
    throw new Error("Bad actual DOM script");
  const source = payload.script;
  if (state.mode === "missing-geometry" && source.includes("bridge.geometry")) return {};
  if (state.mode === "known-frame-error" && source.includes("b.challenge(")) return false;
  state.scripts.push(source);
  if (state.delayed && source.includes("bridge.capture")) {
    state.delayed = false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const value: unknown = await state.active.evaluate((source) => {
    const returned = new Function(source)();
    if (returned?.frame instanceof HTMLIFrameElement)
      return {
        ...returned,
        frame: { "element-6066-11e4-a52e-4f735466cecf": "actual-retained-element" },
      };
    return returned;
  }, source);
  if (
    state.mode === "operation-viewport-changed" &&
    !state.viewportChanged &&
    state.viewportObservations.length &&
    source.includes("bridge.geometry")
  ) {
    state.viewportChanged = true;
    await state.page?.evaluate(() => {
      const frame = document.querySelector("iframe[data-vitest]");
      if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing viewport frame");
      frame.style.width = "640px";
    });
  }
  if (state.mode === "between-cutoffs" && source.includes("bridge.testerCutoff"))
    await state.page?.evaluate(() => {
      const observation = Reflect.get(globalThis, Symbol.for("waffle.framework.observation"))();
      observation.error("BETWEEN_DOCUMENT_CUTOFFS", "synthetic-top");
    });
  return value;
}
async function documentRequest(
  state: DOMState,
  script: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const host = state.host;
  if (!host) throw new Error("No framework host");
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/initial") {
    let input = await body(request);
    if (state.mode === "entry-tester")
      await host.provider("framework-cleanup", async () => {
        state.entryRestored = state.selected;
        state.active = state.page;
        state.selected = false;
      });
    if (state.mode === "wrong-frame")
      await host.provider("test-frame", async () => {
        state.selected = true;
      });
    if (state.mode === "wrong-permit" && record(input)) input = { ...input, permit: "not-owned" };
    if (state.mode === "different-size" && record(input)) input = { ...input, width: 415 };
    if (state.mode === "explicit-viewport") await host.initialViewport({ width: 414, height: 896 });
    await host.initialViewport(input);
    if (state.mode === "repeat-viewport") await host.initialViewport(input);
    response.end("accepted");
    return;
  }
  if (url.pathname === "/viewport") {
    const input = await body(request);
    if (!record(input) || typeof input.width !== "number" || typeof input.height !== "number")
      throw new Error("Missing synthetic viewport dimensions");
    const concurrentIndex = input.concurrent === true ? ++state.concurrentRequests : 0;
    if (concurrentIndex === 2) await state.concurrentRelease.promise;
    state.viewportObservations.push(
      await state.page?.evaluate(() => {
        const frame = document.querySelector("iframe[data-vitest]");
        if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing viewport frame");
        const rect = frame.getBoundingClientRect();
        return {
          width: frame.contentWindow?.innerWidth,
          height: frame.contentWindow?.innerHeight,
          rectangle: { width: rect.width, height: rect.height },
          css: { width: frame.style.width, height: frame.style.height },
        };
      }),
    );
    try {
      await host.provider({ kind: "viewport", width: input.width, height: input.height });
    } catch (reason) {
      state.operations.push(reason instanceof Error ? reason.message : "Viewport rejected");
      throw reason;
    }
    state.operations.push(`viewport:${input.width}:${input.height}`);
    if (concurrentIndex === 2) state.concurrentSettled.resolve();
    response.end("done");
    return;
  }
  if (url.pathname === "/correlation-release") {
    if (
      state.concurrentRequests !== 2 ||
      state.operations.filter((item) => item.startsWith("viewport:")).length !== 1
    )
      throw new Error("Second ordinary promise did not resolve before its provider started");
    state.operations.push("two-ordinary-promises-resolved-after-one-provider");
    state.concurrentRelease.resolve();
    await state.concurrentSettled.promise;
    response.end("observed");
    return;
  }
  if (url.pathname === "/operation") {
    await operationControl(state);
    response.end("done");
    return;
  }
  if (url.pathname === "/case.js") {
    response.setHeader("Content-Type", "application/javascript");
    response.end(script);
    return;
  }
  const tester = url.pathname === "/tester.html";
  const original = `<!doctype html><html><head><meta charset="utf-8"></head><body>${tester ? "" : '<iframe data-vitest src="/tester.html" style="width:414px;height:896px;border:0"></iframe>'}<script type="module" src="/case.js"></script></body></html>`;
  response.setHeader("Content-Type", "text/html");
  response.end(
    host.instrumentDocument({
      kind: tester ? "tester" : "orchestrator",
      url: url.href,
      html: original,
    }),
  );
}
async function selectTester(state: DOMState): Promise<void> {
  const element = await state.page?.$("iframe[data-vitest]");
  const frame = await element?.contentFrame();
  if (!frame) throw new Error("Actual synthetic frame missing");
  state.active = frame;
  state.selected = true;
}
async function invalidateDOM(state: DOMState): Promise<void> {
  const page = state.page;
  if (!page) throw new Error("No control page");
  await page.evaluate((mode) => {
    const frame = document.querySelector("iframe[data-vitest]");
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing retained frame");
    const ancestor = frame.parentElement;
    if (!ancestor) throw new Error("Missing retained ancestor");
    if (mode === "operation-top-pagehide") dispatchEvent(new PageTransitionEvent("pagehide"));
    if (mode === "operation-tester-pagehide")
      frame.contentWindow?.dispatchEvent(new PageTransitionEvent("pagehide"));
    if (mode === "operation-same-url") frame.replaceWith(frame.cloneNode());
    if (mode === "operation-transient-frame") {
      frame.remove();
      document.body.append(frame);
    }
    if (mode === "operation-transient-ancestor") {
      ancestor.remove();
      document.documentElement.append(ancestor);
    }
    const target = mode === "operation-tester-pagehide" ? frame.contentWindow : window;
    if (target?.__waffleFramework?.snapshot().valid !== false)
      throw new Error("Retained document invalidation was not latched");
    if (target?.__waffleFramework?.snapshot().valid !== false)
      throw new Error("Same-object observation revived authority");
  }, state.mode);
  state.operations.push("permanent-invalidation-observed");
}
async function closeContent(state: DOMState): Promise<void> {
  const page = state.page;
  if (!page) throw new Error("No control page");
  await page.evaluate((mode) => {
    const frame = document.querySelector("iframe[data-vitest]");
    if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error("No tester");
    const target = mode === "operation-top-cleanup-held" ? window : frame.contentWindow;
    const observe = Reflect.get(target, Symbol.for("waffle.framework.observation"))();
    if (target === window) observe.error("held predecessor", "synthetic-closure-control");
    else
      observe.taskUpdate([
        { id: "actual-synthetic-task", state: "pass", errors: [], hooks: null, retryCount: 0 },
      ]);
    if (mode === "operation-top-cleanup-held") observe.cleanupResponseReceived();
    else if (mode === "operation-cleanup-held") observe.testerCleanupSettled();
    else observe.executionFlushed();
    if (target.__waffleFramework?.snapshot().contentClosed !== true)
      throw new Error("Closure was not synchronous");
  }, state.mode);
  await state.reportHeld.promise;
}
async function operationControl(state: DOMState): Promise<void> {
  const host = state.host;
  if (!host) throw new Error("Missing host");
  const file =
    state.mode === "operation-wrong-file" ? "wrong-file.ts" : "synthetic-observer.browser.test.ts";
  const expected = Object.freeze({
    buffer: Buffer.from("LABELLED FIXTURE BYTES, NOT A DOM IMAGE"),
    path: "fixture-only.png",
  });
  const reason: unknown = Object.create(null, {
    message: {
      get() {
        throw new Error("Hostile rejection inspected");
      },
    },
  });
  const callback = async () => {
    state.operations.push("callback-entered");
    if (state.mode === "operation-pass")
      await host.provider("test-frame", () => selectTester(state));
    if (state.mode.endsWith("-held")) await closeContent(state);
    if (/transient|same-url|pagehide/.test(state.mode)) await invalidateDOM(state);
    if (state.mode === "operation-callback-rejection") {
      await invalidateDOM({ ...state, mode: "operation-top-pagehide" });
      throw reason;
    }
    return expected;
  };
  if (state.mode === "operation-selected-lie") state.selected = true;
  let release: (() => void) | undefined;
  if (state.mode === "operation-queued-closed") {
    const gate = Promise.withResolvers<void>();
    release = gate.resolve;
    void host.provider("framework-cleanup", () => gate.promise).catch(() => {});
  }
  const result = host.provider({ kind: "screenshot", file }, callback);
  void result.catch(() => {});
  try {
    if (release) {
      state.operations.push("queued-close");
      await closeContent(state);
      release();
    }
    const actual = await result;
    if (actual !== expected || actual.buffer !== expected.buffer)
      throw new Error("Callback value identity changed");
    state.operations.push("exact-result");
    if (state.mode === "operation-pass") {
      if (state.selected || state.active !== state.page)
        throw new Error("Entry frame was not restored");
      state.operations.push("entry-frame-restored");
    }
  } catch (error) {
    if (state.mode === "operation-callback-rejection") {
      if (error !== reason) throw new Error("Callback rejection identity changed");
      state.operations.push("exact-rejection");
    }
    if (state.mode.endsWith("-held") || release) {
      if (!state.releaseReport) throw new Error("Closure report was not held at rejection");
      state.operations.push("rejected-before-closure-report");
    }
    state.operations.push("operation-rejected");
    throw error;
  } finally {
    release?.();
    state.releaseReport?.();
  }
}
function holdClosureReport(
  state: DOMState,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  let text = "";
  request.on("data", (chunk) => {
    text += String(chunk);
  });
  request.on("end", () => {
    const input: unknown = JSON.parse(text);
    const predecessor =
      record(input) &&
      record(input.event) &&
      ["task-update", "error"].includes(String(input.event.kind));
    if (!predecessor) throw new Error("Expected an earlier report before queued closure");
    state.operations.push("report-predecessor-held");
    state.releaseReport = () => {
      if (!response.writableEnded) response.end(JSON.stringify({ ackedThrough: input.seq }));
    };
    state.reportHeld.resolve();
  });
}
function replyError(response: ServerResponse, error: unknown): void {
  response.statusCode = 500;
  response.end(error instanceof Error ? error.message : "Synthetic callback rejected");
}
function dropFinalAck(request: IncomingMessage, response: ServerResponse): void {
  let text = "";
  request.on("data", (chunk) => {
    text += String(chunk);
  });
  const original = response.end;
  response.end = function (...args: unknown[]) {
    const payload: unknown = JSON.parse(text);
    if (record(payload) && payload.kind === "retire-ready") {
      this.statusCode = 503;
      original.call(this, "Deliberate final acknowledgement loss", "utf8");
      return this;
    }
    Reflect.apply(original, this, args);
    return this;
  };
}
function documents(
  state: DOMState,
  script: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (state.mode === "final-ack-loss" && request.url === "/report") dropFinalAck(request, response);
  if (
    (state.mode.endsWith("-held") || state.mode === "operation-queued-closed") &&
    request.url === "/report" &&
    (state.operations.includes("callback-entered") || state.operations.includes("queued-close")) &&
    !state.releaseReport
  ) {
    holdClosureReport(state, request, response);
    return;
  }
  state.middleware?.(request, response, () => {
    void documentRequest(state, script, request, response).catch((error) =>
      replyError(response, error),
    );
  });
}
function assertOperations(state: DOMState, mode: string): void {
  if (
    mode === "operation-correlation" &&
    !state.operations.includes("two-ordinary-promises-resolved-after-one-provider")
  )
    throw new Error("No ordinary event-correlation limitation proof");
  if (
    /operation-(?:transient|same-url|.*pagehide|callback-rejection)/.test(mode) &&
    !state.operations.includes("permanent-invalidation-observed")
  )
    throw new Error("No permanent invalidation proof");
  if (mode === "operation-callback-rejection" && !state.operations.includes("exact-rejection"))
    throw new Error("No exact callback rejection proof");
  if (
    ["operation-fractional", "operation-viewport-changed"].includes(mode) &&
    !state.operations.some((item) => item.includes("Viewport target unrealized"))
  )
    throw new Error("Fractional request was not rejected as an unrealized actual target");
  if (
    mode === "operation-malformed" &&
    !state.operations.some((item) => item.includes("finite positive"))
  )
    throw new Error("Malformed viewport did not fail at its boundary");
  if (
    mode === "operation-pass" &&
    state.operations.join(",") !==
      "viewport:800:600,viewport:800:600,callback-entered,exact-result,entry-frame-restored,viewport:414:896"
  )
    throw new Error(`Sequential operation controls incomplete: ${state.operations.join(",")}`);
  if (
    (mode.endsWith("-held") || mode === "operation-queued-closed") &&
    (!state.operations.includes("rejected-before-closure-report") ||
      !state.operations.includes("report-predecessor-held"))
  )
    throw new Error("No held-report completion rejection proof");
  if (
    ["operation-wrong-file", "operation-selected-lie", "operation-queued-closed"].includes(mode) &&
    state.operations.includes("callback-entered")
  )
    throw new Error("Denied operation invoked its callback");
}
function assertDeclaredClock(result: FrameworkResult, mode: string): void {
  if (mode !== "declared-clock") return;
  if (
    result.cases[0]?.expected.timeoutMs !== 20000 ||
    result.collection.find((item) => item.type === "test")?.timeoutMs !== 20000
  )
    throw new Error("Declared case clock was not preserved through collection");
}
function assertResult(state: DOMState, result: FrameworkResult, mode: string): void {
  if (state.sessionPosts !== 1 || state.sessionDeletes !== 1)
    throw new Error("DOM control did not retain one session owner");
  if (
    Object.values(result.cleanup).some(
      (value) => typeof value === "object" && value.status === "unconfirmed",
    )
  )
    throw new Error(`DOM cleanup unconfirmed: ${JSON.stringify(result.cleanup)}`);
  const pass =
    mode === "pass" ||
    mode === "delayed-admission" ||
    mode === "entry-tester" ||
    mode === "operation-pass" ||
    mode === "operation-correlation" ||
    mode === "declared-clock";
  if (
    pass &&
    (result.exit !== 4 ||
      !result.fileComplete ||
      result.geometry?.tester.width !== 414 ||
      result.geometry.tester.height !== 896)
  )
    throw new Error(`Expected complete synthetic observer: ${JSON.stringify(result)}`);
  if (!pass && result.exit !== 2)
    throw new Error(`Fault did not fail closed: ${JSON.stringify(result)}`);
  if (
    (mode === "entry-tester" && !state.entryRestored) ||
    (mode === "known-frame-error" && !state.selected)
  )
    throw new Error("Public entry frame bookkeeping was not restored");
  if (
    mode === "final-ack-loss" &&
    !result.documents.some(
      (document) =>
        document.pending !== null &&
        document.pending > 0 &&
        document.ackedThrough !== document.acceptedThrough,
    )
  )
    throw new Error("Accepted reports were mislabeled as received page ACKs");
  assertOperations(state, mode);
  assertDeclaredClock(result, mode);
  if (result.rootBrowserSuiteComplete) throw new Error("Synthetic observer claimed root scope");
  if (pass && result.events.filter((event) => event.kind === "task-update").length !== 2)
    throw new Error("Repeated actual updates lost");
}
export async function frameworkDOMControl(
  engine: "chromium" | "webkit",
  mode: string,
  root: string,
): Promise<void> {
  const file = "synthetic-observer.browser.test.ts";
  const timeoutMs = mode === "declared-clock" ? 20000 : 15000;
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "framework-dom-page.ts")],
    target: "browser",
    define: {
      FRAMEWORK_DOM_MODE: JSON.stringify(mode),
      FRAMEWORK_DOM_FILE: JSON.stringify(file),
      FRAMEWORK_DOM_TIMEOUT: JSON.stringify(timeoutMs),
    },
  });
  if (!built.success || !built.outputs[0])
    throw new AggregateError(built.logs, "Synthetic observer bundle failed");
  const script = await built.outputs[0].text();
  const state: DOMState = {
    host: undefined,
    middleware: undefined,
    page: undefined,
    active: undefined,
    selected: false,
    entryRestored: false,
    sessionDeletes: 0,
    sessionPosts: 0,
    scripts: [],
    delayed: mode === "delayed-admission",
    mode,
    operations: [],
    viewportObservations: [],
    viewportChanged: false,
    concurrentRequests: 0,
    concurrentRelease: Promise.withResolvers<void>(),
    concurrentSettled: Promise.withResolvers<void>(),
    releaseReport: undefined,
    reportHeld: Promise.withResolvers<void>(),
  };
  const fake = createServer((request, response) => {
    void webdriver(state, request, response).catch((error) => replyError(response, error));
  });
  const server = createServer((request, response) => documents(state, script, request, response));
  let browser: Browser | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const endpoint = await listen(fake),
      origin = await listen(server);
    const host = createFrameworkControl(
      {
        suite: `dom-observer-${engine}-${mode}`,
        native: { udid: "dom-control" },
        expected: [
          {
            file,
            fullName: "synthetic case",
            sourceKey: "synthetic:1",
            timeoutMs,
            retries: 0,
          },
        ],
        scope: { kind: "root-selection", command: "test:browser", files: [file] },
        resultPath: join(root, `framework-${engine}-${mode}.json`),
      },
      endpoint,
    );
    state.host = host;
    host.mount({
      stack: [],
      use(handler) {
        state.middleware = handler;
      },
    });
    const result = await host.run(async (registerClose) => {
      browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: true });
      registerClose(async () => {
        state.releaseReport?.();
        state.concurrentRelease.resolve();
        state.concurrentSettled.resolve();
        await browser?.close();
        await stopServer(server);
      });
      const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
      state.page = page;
      state.active = page;
      await host.attach({
        connect: async () => ({}),
        detach: () => host.detach(),
        frames: {
          isTestFrame: () => state.selected,
          main: () =>
            host.provider("main-frame", async () => {
              state.active = page;
              state.selected = false;
            }),
          tester: () => host.provider("test-frame", () => selectTester(state)),
        },
      });
      watchdog = setTimeout(
        () => {
          void host.abort("Synthetic control deadline reached");
        },
        mode === "missing-cleanup" ? 1800 : 12000,
      );
      await host.openPage(origin + "/", async () => {
        await navigateTestPage(page, origin + "/");
        if (mode === "entry-tester" || mode === "known-frame-error") {
          const element = await page.$("iframe[data-vitest]");
          const frame = await element?.contentFrame();
          if (!frame) throw new Error("Missing entry tester frame");
          state.active = frame;
          state.selected = true;
        }
      });
      await page.waitForFunction(
        () => Reflect.get(window, "__frameworkControlEnd") === true,
        null,
        { timeout: 14000 },
      );
      return { status: "passed" };
    });
    assertResult(state, result, mode);
    const evidenceDirectory = process.env.PAGE_RUNNER_CONTROL_ARTIFACTS ?? root;
    if (!isAbsolute(evidenceDirectory))
      throw new Error("Control artifacts directory must be absolute");
    await writeResult(join(evidenceDirectory, `framework-${engine}-${mode}-control.json`), {
      result,
      scripts: state.scripts.length,
      operations: state.operations,
      viewportObservations: state.viewportObservations,
      browserExecuted: "synthetic DOM observer only",
      nativeCredit: false,
    });
  } finally {
    clearTimeout(watchdog);
    await browser?.close();
    await stopServer(server);
    await stopServer(fake);
  }
}
