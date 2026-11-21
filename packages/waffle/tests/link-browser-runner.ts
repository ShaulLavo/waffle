import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, firefox, webkit, type Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { captureWebKitDiagnostics, observeWebKitPage } from "./webkit-diagnostics.js";

const root = process.env.PROCESS_SCRATCH_ROOT;
if (!root) throw new Error("PROCESS_SCRATCH_ROOT must name an owned data-drive directory");
const requested = process.argv.slice(2);
const engines = { chromium, firefox, webkit };
const names = requested.length ? requested : Object.keys(engines);
const profiles: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
const interrupted = new AbortController();

async function cleanup() {
  const errors: unknown[] = [];
  try {
    server?.stop(true);
  } catch (error) {
    errors.push(error);
  }
  const removed = await Promise.allSettled(
    profiles.map((path) => rm(path, { recursive: true, force: true })),
  );
  for (const result of removed) if (result.status === "rejected") errors.push(result.reason);
  if (errors.length) throw new AggregateError(errors, "link browser cleanup failed");
}

const onSignal = (signal: NodeJS.Signals) => {
  process.exitCode = 1;
  interrupted.abort(new Error(`Link runner interrupted by ${signal}`));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

async function bundle(path: string) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, path)],
    target: "browser",
  });
  if (!result.success || !result.outputs[0])
    throw new AggregateError(result.logs, `bundle ${path}`);
  return result.outputs[0];
}

async function evaluateLink(
  page: Page,
  url: string,
  signal: AbortSignal,
  diagnostics: ReturnType<typeof observeWebKitPage> | undefined,
) {
  try {
    diagnostics?.enter("navigation");
    await navigateTestPage(page, url);
    signal.throwIfAborted();
    diagnostics?.enter("evaluation");
    return await page.evaluate(async () => {
      const path = "/page.js";
      const fixture: typeof import("./link-browser.js") = await import(path);
      return fixture.sharedLinkBrowser();
    });
  } catch (error) {
    diagnostics?.fail();
    throw error;
  }
}

async function runLink(engine: keyof typeof engines, url: string, scratch: string) {
  const signal = interrupted.signal;
  signal.throwIfAborted();
  const restore = engine === "webkit" ? captureWebKitDiagnostics() : undefined;
  const startup = engines[engine].launch({
    handleSIGINT: false,
    handleSIGTERM: false,
    env: { ...process.env, TMPDIR: process.env.TMPDIR ?? scratch },
  });
  let diagnostics: ReturnType<typeof observeWebKitPage> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= startup.then(
      (browser) => browser.close(),
      () => {},
    ));
  const stop = () => {
    diagnostics?.shutdown("signal shutdown");
    void close().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const browser = await startup;
    signal.throwIfAborted();
    const page = await browser.newPage();
    signal.throwIfAborted();
    if (engine === "webkit") diagnostics = observeWebKitPage(page, "link");
    return await evaluateLink(page, url, signal, diagnostics);
  } finally {
    if (!signal.aborted) diagnostics?.shutdown("runner cleanup");
    await close().finally(() => {
      signal.removeEventListener("abort", stop);
      restore?.();
    });
  }
}

try {
  const [page, worker, relayWorker, filesystemWorker] = await Promise.all([
    bundle("link-browser.ts"),
    bundle("fixtures/link-initialization-worker.ts"),
    bundle("fixtures/link-relay-worker.ts"),
    bundle("../browser/fs-worker.ts"),
  ]);
  interrupted.signal.throwIfAborted();
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/relay-worker.js" || path === "/fs-worker.js")
        return new Response(path === "/relay-worker.js" ? relayWorker : filesystemWorker, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      if (path === "/worker.js" || path === "/page.js")
        return new Response(path === "/worker.js" ? worker : page, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      return new Response("<!doctype html><title>Shared compiled link plans</title>", { headers });
    },
  });
  for (const name of names) {
    if (name !== "chromium" && name !== "firefox" && name !== "webkit")
      throw new Error(`unknown browser ${name}`);
    const scratch = await mkdtemp(join(root, "link-"));
    profiles.push(scratch);
    const result = await runLink(name, `http://127.0.0.1:${server.port}/`, scratch);
    interrupted.signal.throwIfAborted();
    console.log(JSON.stringify({ engine: name, ...result }));
  }
} finally {
  await cleanup().finally(() => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  });
}
