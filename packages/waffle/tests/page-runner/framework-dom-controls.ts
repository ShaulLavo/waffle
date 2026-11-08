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
function replyError(response: ServerResponse, error: unknown): void {
  response.statusCode = 500;
  response.end(String(error));
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
  state.middleware?.(request, response, () => {
    void documentRequest(state, script, request, response).catch((error) =>
      replyError(response, error),
    );
  });
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
  if (
    mode === "declared-clock" &&
    (result.cases[0]?.expected.timeoutMs !== 20000 ||
      result.collection.find((item) => item.type === "test")?.timeoutMs !== 20000)
  )
    throw new Error("Declared case clock was not preserved through collection");
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
          tester: () =>
            host.provider("test-frame", async () => {
              const element = await page.$("iframe[data-vitest]");
              const frame = await element?.contentFrame();
              if (!frame) throw new Error("Actual synthetic frame missing");
              state.active = frame;
              state.selected = true;
            }),
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
