import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { cleanupInterruptResources } from "./interrupt-browser-runner-control.js";

// On demand. INTERRUPT_CACHE_LS supplies existing program bytes; no producer build runs here.
const artifact = process.env.INTERRUPT_CACHE_LS;
const report = process.env.INTERRUPT_CACHE_REPORT;
if (!artifact || !report) throw new Error("Set INTERRUPT_CACHE_LS and INTERRUPT_CACHE_REPORT");
let scratch: string | undefined;
let context: BrowserContext | undefined;
let contextCreation: Promise<BrowserContext> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cleaned: ReturnType<typeof cleanupInterruptResources> | undefined;
const results: Record<string, unknown> = {
  source: resolve(artifact),
  sourceBytes: (await stat(artifact)).size,
};
const traces: Record<string, number> = {};
const previousTmp = process.env.TMPDIR;
const observedStreams: { url: string; contentType: string | null }[] = [];

function cleanup() {
  return (cleaned ??= cleanupInterruptResources([
    {
      name: "workerRescue",
      timeoutMs: 1500,
      run: async () => {
        await context?.pages()[0]?.evaluate(async () => {
          const { admittedHarness }: typeof import("./interrupt-admitted-browser.js") =
            await import(location.origin + "/main.js");
          await admittedHarness.clean();
        });
      },
    },
    {
      name: "browserClosed",
      timeoutMs: 20000,
      run: async () => {
        const owned = context ?? (await contextCreation?.catch(() => undefined));
        await owned?.close();
        context = undefined;
        contextCreation = undefined;
      },
    },
    {
      name: "listenerStopped",
      run: () => {
        server?.stop(true);
      },
    },
    {
      name: "scratchRemoved",
      run: async () => {
        if (scratch && !context) await rm(scratch, { recursive: true, force: true });
      },
    },
  ]));
}
async function finish() {
  const cleanupResults = await cleanup();
  results.cleanup = cleanupResults;
  if (cleanupResults.some((result) => !result.ok)) {
    process.exitCode = 1;
    results.ok = false;
    results.cleanupFailed = true;
  }
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  await Bun.write(report!, JSON.stringify({ ...results, traces, observedStreams }, null, 2));
}
const abort = () => {
  void finish().finally(() => process.exit(1));
};
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
const deadline = setTimeout(abort, 120000);

async function launch() {
  if (!scratch) throw new Error("scratch missing");
  contextCreation = chromium.launchPersistentContext(join(scratch, "profile"), {
    headless: true,
    timeout: 10000,
  });
  context = await contextCreation;
  if (cleaned) throw new Error("Browser launch completed during teardown");
  const page = context.pages()[0]!;
  page.setDefaultTimeout(15000);
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.exposeFunction("observeStream", (value: { url: string; contentType: string | null }) =>
    observedStreams.push(value),
  );
  await page.addInitScript(() => {
    const original = WebAssembly.compileStreaming;
    WebAssembly.compileStreaming = (...args: Parameters<typeof original>) => {
      const source = args[0];
      if (source instanceof Response)
        void Reflect.get(
          globalThis,
          "observeStream",
        )({
          url: source.url,
          contentType: source.headers.get("content-type"),
        });
      return original(...args);
    };
  });
  return page;
}

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

try {
  scratch = await mkdtemp("/work/tmp/wt5-");
  process.env.TMPDIR = scratch;
  const build = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "interrupt-admitted-browser.ts"),
      resolve(import.meta.dir, "fixtures/interrupt-browser-worker.ts"),
    ],
    outdir: scratch,
    target: "browser",
    naming: "[name].js",
  });
  check(build.success, build.logs.join("\n"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const headers = {
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cache-control": "public, max-age=3600",
      };
      if (path === "/ls.wasm")
        return new Response(Bun.file(artifact), {
          headers: { ...headers, "content-type": "application/wasm" },
        });
      if (path === "/main.js")
        return new Response(Bun.file(join(scratch!, "interrupt-admitted-browser.js")), { headers });
      if (path === "/interrupt-browser-worker.js")
        return new Response(Bun.file(join(scratch!, "interrupt-browser-worker.js")), { headers });
      return new Response("<!doctype html><title>Admitted cache control</title>", {
        headers: { ...headers, "content-type": "text/html" },
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  let page = await launch();
  results.browser = context!.browser()?.version();
  results.scratch = scratch;
  results.port = server.port;
  const cdp = await context!.newCDPSession(page);
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const event of value) {
      const name = String(event.name);
      traces[name] = (traces[name] ?? 0) + 1;
    }
  });
  await cdp.send("Tracing.start", {
    categories: "v8.wasm,disabled-by-default-v8.wasm.detailed",
    transferMode: "ReportEvents",
  });
  async function navigate() {
    await page.goto("about:blank");
    await page.goto(url);
  }
  async function run(cancel = false) {
    return page.evaluate(async (cancel) => {
      const { admittedHarness }: typeof import("./interrupt-admitted-browser.js") = await import(
        location.origin + "/main.js"
      );
      return admittedHarness.load(cancel);
    }, cancel);
  }
  const cold = [],
    hits = [];
  for (let i = 0; i < 5; i++) {
    await navigate();
    await page.evaluate(async () => {
      const { admittedHarness }: typeof import("./interrupt-admitted-browser.js") = await import(
        location.origin + "/main.js"
      );
      await admittedHarness.clear();
    });
    const miss = await run();
    check(
      miss.stages.some((stage) => stage.name.endsWith(":admit")),
      "cold load did not admit",
    );
    cold.push(miss);
    await navigate();
    const hit = await run(true);
    check(
      !hit.stages.some((stage) => stage.name.endsWith(":admit")),
      "cache hit repeated admission",
    );
    check(
      hit.stages.filter(
        (stage) => stage.name.endsWith(":store-verify") && stage.detail.result === "hit",
      ).length === 2,
      "both store hits not verified",
    );
    hits.push(hit);
  }
  results.cold = cold;
  results.hits = hits;
  const tamper = [];
  for (const kind of ["raw", "digest", "malformed"] as const) {
    await page.evaluate(async (kind) => {
      const { admittedHarness }: typeof import("./interrupt-admitted-browser.js") = await import(
        location.origin + "/main.js"
      );
      await admittedHarness.tamper(kind);
    }, kind);
    await navigate();
    const result = await run(true);
    check(
      result.stages.some(
        (stage) => stage.name.endsWith(":store-verify") && stage.detail.result === "rejected",
      ),
      `${kind} entry accepted`,
    );
    check(
      result.stages.some((stage) => stage.name.endsWith(":admit")),
      `${kind} did not fall back`,
    );
    tamper.push({ kind, result });
  }
  results.tamper = tamper;
  await page.evaluate(async () => {
    const { admittedHarness }: typeof import("./interrupt-admitted-browser.js") = await import(
      location.origin + "/main.js"
    );
    await admittedHarness.clear();
  });
  await navigate();
  const deleted = await run(true);
  check(
    deleted.stages.filter((stage) => stage.name.endsWith(":admit")).length === 2,
    "deleted cache did not admit both modules",
  );
  results.deleted = deleted;
  results.structuredCloneWrite = await page.evaluate(async () => {
    const { admittedHarness }: typeof import("./interrupt-admitted-browser.js") = await import(
      location.origin + "/main.js"
    );
    return admittedHarness.persistModuleControl();
  });
  const tracingComplete = new Promise<void>((resolve) =>
    cdp.once("Tracing.tracingComplete", () => resolve()),
  );
  await cdp.send("Tracing.end");
  await tracingComplete;
  await context!.close();
  context = undefined;
  contextCreation = undefined;
  page = await launch();
  await navigate();
  results.structuredCloneReadAfterBrowserRestart = await page.evaluate(async () => {
    const { admittedHarness }: typeof import("./interrupt-admitted-browser.js") = await import(
      location.origin + "/main.js"
    );
    return admittedHarness.readModuleControl();
  });
  const restarted = await run(true);
  check(
    !restarted.stages.some((stage) => stage.name.endsWith(":admit")),
    "persistent bytes lost across browser restart",
  );
  results.restarted = restarted;
  results.ok = true;
} catch (error) {
  results.error = String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  await finish();
}
console.log(
  JSON.stringify({ ok: results.ok, error: results.error, report, cleanup: results.cleanup }),
);
