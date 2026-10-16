// Headless, artifact-free browser gate. Run with `bun run test:browser` in web/.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

let server;
let browser;
let browserLaunch;
let scratch;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    try {
      // An interruption during launch must still reclaim the process once launch settles.
      const launched = browser ?? await browserLaunch?.catch(() => undefined);
      await launched?.close();
    } finally {
      server?.stop(true);
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}
const timeout = setTimeout(() => {
  console.error("Browser smoke exceeded 60 seconds");
  void cleanup().finally(() => process.exit(1));
}, 60_000);

try {
  // All generated files and the browser profile are task-owned and removed in finally.
  scratch = await mkdtemp(fileURLToPath(new URL("../node_modules/.browser-smoke-", import.meta.url)));
  process.env.TMPDIR = scratch; // Playwright's temporary profile/artifacts stay inside our cleanup root.
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./browser-smoke-worker.ts", import.meta.url))],
    target: "browser", format: "esm", write: false,
  });
  assert.equal(bundle.success, true, bundle.logs.map(String).join("\n"));
  const worker = await bundle.outputs[0].text();
  server = Bun.serve({
    hostname: "127.0.0.1", port: Number(process.env.SMOKE_PORT ?? 4179),
    fetch(request) {
      const path = new URL(request.url).pathname;
      const headers = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Content-Type": path === "/worker.js" ? "text/javascript" : "text/html",
      };
      if (path === "/favicon.ico") return new Response(null, { status: 204, headers });
      if (path === "/worker.js") return new Response(worker, { headers });
      if (path !== "/") return new Response("Not found", { status: 404, headers });
      return new Response("<!doctype html><title>Browser host smoke</title>", { headers });
    },
  });
  browserLaunch = chromium.launch({
    headless: true,
    timeout: 30_000,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    downloadsPath: join(scratch, "downloads"),
    tracesDir: join(scratch, "traces"),
  });
  browser = await browserLaunch;
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker("/worker.js", { type: "module" });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("Smoke worker timed out")); }, 20_000);
    worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
  }));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.checks, ["native memory views", "fallback memory views", "unbounded memory views"]);
  assert.deepEqual(errors, []);
  console.log(`Chromium ${browser.version()}: ${result.checks.join(", ")}; WASI stdout, memory growth, MemFS read, preopen confinement, descriptor rights, isolated worker passed`);
} finally {
  clearTimeout(timeout);
  await cleanup();
}
