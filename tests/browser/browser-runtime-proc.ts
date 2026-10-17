// Artifact-free actual Worker ABI gate. No downloads, guest compiler or Bun WASM rebuild.
// source env.sh && bun web/tests/browser-runtime-proc.ts chromium
// Defaults to cached Chromium; pass firefox/webkit explicitly to extend the matrix.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { buildBrowserEntries } from "../../scripts/browser-build";
import { runtimeProcChecks, runtimeProcJobWaitChecks } from "./runtime-proc-fixtures";

const names = process.argv.slice(2);
if (!names.length) names.push("chromium");
const types = { chromium, firefox, webkit };
for (const name of names) {
  if (!(name in types)) throw new Error(`unknown browser ${name}`);
  assert.ok(existsSync(types[name as keyof typeof types].executablePath()), `cached ${name} browser required; this gate never downloads dependencies`);
}
const originalTmpdir = process.env.TMPDIR;
let scratch: string | undefined;
let scratchCreation: Promise<string> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launch: Promise<Browser> | undefined;
let cleanupPromise: Promise<void> | undefined;
// Install teardown before setup. Only the ephemeral listener, this run's browser and its scratch
// (bundles, browser profile, downloads and traces) belong to this run; shared browser caches do not.
function cleanup(): Promise<void> {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await launch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      try { const directory = scratch ?? await scratchCreation?.catch(() => undefined); if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir; }
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("runtime_proc browser gate timed out"); void cleanup().finally(() => process.exit(1)); }, Math.max(120_000, names.length * 100_000));
try {
  const base = process.env.RUNNER_TEMP ?? process.env.SCRATCH ?? originalTmpdir ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  scratch = await (scratchCreation = mkdtemp(join(base, "bun-wasm-runtime-proc-browser-")));
  process.env.TMPDIR = scratch;
  console.log(JSON.stringify({ resources: { scratch, listener: "ephemeral loopback port", browsers: names, downloads: "none", wasm: "original byte-encoded guest" } }));
  // A captured pre-wiring bundle can run after implementation changes without checking out or
  // modifying shared source. External bundles are caller-owned and are never removed by this gate.
  const captured = process.env.BUN_WASM_RUNTIME_PROC_BUNDLE;
  const out = captured ? resolve(captured) : join(scratch, "dist"), root = resolve(import.meta.dir, "../..");
  if (captured) assert.ok(await Bun.file(join(out, "index.html")).exists(), "captured bundle needs index.html");
  else {
    await buildBrowserEntries([join(import.meta.dir, "runtime-proc-browser-main.ts"), join(root, "web/src/worker.ts"), join(root, "web/src/fs-worker.ts")], out, { runtimeWorker: true });
    await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./runtime-proc-browser-main.js"></script>');
  }
  server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
      const path = resolve(out, `.${url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname}`);
      if (!path.startsWith(out + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
      return new Response(Bun.file(path), { headers });
    },
  });
  let failed = false;
  for (const name of names) {
    launch = types[name as keyof typeof types].launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
    browser = await launch;
    for (const scenario of ["pipes", "job-wait"]) for (const mode of ["automatic", "explicit"]) {
      const page: Page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      try {
        // slots=off also lets the pre-wiring baseline fail on missing ABI imports, rather than
        // on unrelated Bun slot setup; the production preview1 adapter independently skips slots.
        await page.goto(`http://127.0.0.1:${server.port}/?slots=off${mode === "explicit" ? "&explicit=1" : ""}${scenario === "job-wait" ? "&job-wait=1" : ""}`);
        await page.waitForFunction(() => (globalThis as any).runtimeProcResult, undefined, { timeout: 40_000 });
        const result: { ok: boolean; checks: string[]; cleanup: { activeWorkers: number };
          teardown: { forcedWorkers: number; activeWorkers: number } } = await page.evaluate(() => (globalThis as any).runtimeProcResult);
        console.log(JSON.stringify({ browser: name, version: browser.version(), mode, scenario, ...result, pageErrors: errors }));
        try {
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.deepEqual(result.checks, Array.from<string>(scenario === "job-wait" ? runtimeProcJobWaitChecks : runtimeProcChecks));
          assert.equal(result.cleanup.activeWorkers, 0);
          assert.equal(result.teardown.forcedWorkers, 0);
          assert.equal(result.teardown.activeWorkers, 0);
          assert.deepEqual(errors, []);
        } catch (error) { failed = true; console.error(error); }
      } finally { await page.close(); }
    }
    await browser.close(); browser = undefined; launch = undefined;
  }
  assert.equal(failed, false, "real worker runtime_proc regression gate failed (see mode results above)");
} finally { clearTimeout(deadline); await cleanup(); console.log("cleanup: owned browsers closed, ephemeral listener stopped, scratch removed"); }
