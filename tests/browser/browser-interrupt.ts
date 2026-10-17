// Artifact-free: INTERRUPT_PLAYWRIGHT_ROOT=/existing/web bun tests/browser-interrupt.ts chromium firefox
// Existing bytes only: INTERRUPT_BUN_WASM=... INTERRUPT_BRUSH_WASM=... INTERRUPT_PROTOTYPE=... bun tests/browser-interrupt.ts --benchmark chromium firefox
// Real Safari: run the same file on a reserved Mac with `... bun tests/browser-interrupt.ts --benchmark safari`.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadavg } from "node:os";
import type { Browser, Page } from "playwright";
import { cleanupInterruptResources, finishInterruptCleanup } from "../../runtime/tests/interrupt-browser-runner-control";

const root = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2), benchmark = args.includes("--benchmark");
const names = args.filter(name => name !== "--benchmark"); if (!names.length) names.push("chromium", "firefox");
for (const name of names) assert.ok(["chromium", "firefox", "webkit", "safari"].includes(name), `unknown browser ${name}`);
if (names.includes("safari")) assert.equal(process.platform, "darwin", "real Safari requires the reserved Mac fleet host");
const repetitions = Number(process.env.INTERRUPT_REPETITIONS ?? 5);
assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 100, "invalid INTERRUPT_REPETITIONS");
const artifacts = { bun: process.env.INTERRUPT_BUN_WASM, brush: process.env.INTERRUPT_BRUSH_WASM, prototype: process.env.INTERRUPT_PROTOTYPE };
if (benchmark) for (const [name, path] of Object.entries(artifacts)) assert.ok(path && await Bun.file(path).exists(), `--benchmark requires existing INTERRUPT_${name === "prototype" ? "PROTOTYPE" : name.toUpperCase() + "_WASM"}`);

// Owned resources: ephemeral HTTP listener, build/profile scratch, one browser or Safari
// automation session, and its own safaridriver. Never owner windows/profiles/artifact bytes.
let scratch: string | undefined, scratchCreation: Promise<string> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined, browser: Browser | undefined, page: Page | undefined;
let launching: Promise<Browser> | undefined;
let driver: ReturnType<typeof Bun.spawn> | undefined, session: string | undefined;
let cleaning: Promise<void> | undefined, stopping = false;
const previousTmp = process.env.TMPDIR;
const report: { resources?: unknown; results: unknown[]; error?: string; cleanup?: unknown } = { results: [] };
const driverPort = Number(process.env.INTERRUPT_SAFARI_PORT ?? 43186), driverOrigin = `http://127.0.0.1:${driverPort}`;
assert.ok(Number.isInteger(driverPort) && driverPort >= 1024 && driverPort <= 65535, "invalid INTERRUPT_SAFARI_PORT");
async function webdriver(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(driverOrigin + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(stopping ? 5000 : 600_000) });
  const result = await response.json() as any;
  if (!response.ok || result.value?.error) throw new Error(`Safari ${path}: ${result.value?.message ?? response.status}`);
  return result.value;
}
async function safariEvaluate(script: string, params: unknown[] = []): Promise<any> {
  const result = await webdriver(`/session/${session}/execute/async`, "POST", {
    script: `const done=arguments[arguments.length-1]; Promise.resolve().then(async()=>{${script}}).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error.stack||error)}));`, args: params,
  });
  if (!result.ok) throw new Error(result.error); return result.value;
}
async function cleanup(): Promise<void> {
  stopping = true;
  return cleaning ??= finishInterruptCleanup(async () => {
    const rescueAttempted = { page: !!page, safari: !!session };
    const steps = await cleanupInterruptResources([
      // A wedged page must not block the watchdog before physical browser teardown.
      { name: "pageRescue", timeoutMs: 2000, async run() { if (page) await page.evaluate(async () => { await (globalThis as any).interruptHarness?.clean(); }); } },
      { name: "safariRescue", timeoutMs: 2000, async run() { if (session) await safariEvaluate("await globalThis.interruptHarness?.clean();return true;"); } },
      { name: "safariSessionDeleted", async run() { if (session) { await webdriver(`/session/${session}`, "DELETE"); session = undefined; } } },
      { name: "browserClosed", async run() { await (browser ?? await launching?.catch(() => undefined))?.close(); } },
      { name: "ownedDriverExited", async run() {
        if (!driver) return;
        const ownedDriver = driver; ownedDriver.kill("SIGTERM");
        const watchdog = setTimeout(() => ownedDriver.kill("SIGKILL"), 5000);
        try { await ownedDriver.exited; } finally { clearTimeout(watchdog); driver = undefined; }
      } },
      { name: "listenerStopped", run() { server?.stop(true); } },
      { name: "scratchRemoved", async run() {
        const directory = scratch ?? await scratchCreation?.catch(() => undefined);
        if (directory) await rm(directory, { recursive: true, force: true });
      } },
      { name: "environmentRestored", run() { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; } },
    ]);
    const errors = steps.filter(step => !step.ok).map(step => `${step.name}: ${step.error}`);
    report.cleanup = { ...Object.fromEntries(steps.map(step => [step.name, step.ok])), rescueAttempted,
      rescuePublishedBeforeTermination: steps.filter(step => step.name === "pageRescue" || step.name === "safariRescue").every(step => step.ok), steps, errors };
    if (errors.length) {
      report.error ??= "interrupt browser teardown failed";
      throw new AggregateError(errors, "interrupt browser teardown failed");
    }
  }, async () => {
    if (process.env.INTERRUPT_OUTPUT) await Bun.write(process.env.INTERRUPT_OUTPUT, JSON.stringify(report, null, 2) + "\n");
  });
}
let aborting = false;
function abort(message: string, code: number): void {
  if (aborting) return; aborting = true; report.error ??= message;
  void cleanup().catch(error => console.error(error)).finally(() => process.exit(code));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort(`interrupt browser gate received ${signal}`, signal === "SIGINT" ? 130 : 143));
const deadline = setTimeout(() => abort("interrupt browser gate exceeded deadline", 1), Number(process.env.INTERRUPT_TIMEOUT_MS ?? 600_000));
try {
  const preexisting = Bun.spawn(["ps", "-eo", "pid,comm"], { stdout: "pipe", stderr: "inherit" });
  const browserProcesses = (await new Response(preexisting.stdout).text()).split("\n").filter(line => /Safari|safaridriver|WebKit|chromium|firefox|chrome/.test(line));
  assert.equal(await preexisting.exited, 0);
  if (stopping) throw new Error("interrupt browser setup was cancelled");
  console.log(JSON.stringify({ beforeSetup: { browserProcesses, loadAverage: loadavg(), taskOwns: ["ephemeral HTTP listener", "unique build/profile scratch", "automation browser/session", "own safaridriver if Safari"] } }));
  scratch = await (scratchCreation = mkdtemp(join(process.env.INTERRUPT_SCRATCH_ROOT ?? (process.platform === "darwin" ? process.env.HOME! + "/tmp" : "/work/tmp"), "bun-wasm-interrupt-")));
  if (stopping) throw new Error("interrupt browser setup was cancelled");
  process.env.TMPDIR = scratch;
  const out = join(scratch, "dist");
  const built = await Bun.build({ entrypoints: [join(root, "runtime/tests/interrupt-browser.ts"), join(root, "runtime/tests/fixtures/interrupt-browser-worker.ts")], outdir: out, target: "browser", format: "esm", splitting: true, minify: true, naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" } });
  assert.ok(built.success, built.logs.map(String).join("\n"));
  await Bun.write(join(out, "index.html"), '<!doctype html><title>Interrupt gate</title><script type="module" src="/interrupt-browser.js"></script>');
  let prototypeSha256: string | undefined;
  if (benchmark) {
    const source = await Bun.file(artifacts.prototype!).text(); prototypeSha256 = new Bun.CryptoHasher("sha256").update(source).digest("hex");
    const prototypeSource = join(scratch, "prototype.ts"); await Bun.write(prototypeSource, source);
    const baseline = await Bun.build({ entrypoints: [prototypeSource], outdir: out, target: "browser", format: "esm", minify: true });
    assert.ok(baseline.success, baseline.logs.map(String).join("\n"));
  }
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    if (benchmark && (pathname === "/bun.wasm" || pathname === "/brush.wasm")) return new Response(Bun.file(pathname === "/bun.wasm" ? artifacts.bun! : artifacts.brush!), { headers: { ...headers, "Content-Type": "application/wasm" } });
    const file = resolve(out, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(out + sep) || !await Bun.file(file).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(file), { headers });
  } });
  report.resources = { scratch, port: server.port, artifacts: benchmark ? artifacts : null, prototypeSha256, platform: process.platform, arch: process.arch, bun: Bun.version, loadAverage: loadavg() };
  for (const name of names) {
    const url = `http://127.0.0.1:${server.port}/`;
    if (name === "safari") {
      // Never issue a session request to an existing driver's listener.
      const probe = Bun.spawn(["/usr/sbin/lsof", "-nP", `-iTCP:${driverPort}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" });
      const listeners = await new Response(probe.stdout).text(); await probe.exited;
      assert.equal(listeners, "", `Safari driver port ${driverPort} already occupied`);
      driver = Bun.spawn(["/usr/bin/safaridriver", "--port", String(driverPort)], { stdout: "ignore", stderr: "inherit" });
      for (let attempt = 0; ; attempt++) {
        try { await webdriver("/status"); break; } catch (error) { if (attempt >= 50 || driver.exitCode !== null) throw error; await Bun.sleep(100); }
      }
      const opened = await webdriver("/session", "POST", { capabilities: { alwaysMatch: { browserName: "safari" } } }); session = opened.sessionId;
      await webdriver(`/session/${session}/timeouts`, "POST", { script: 600_000, pageLoad: 30_000, implicit: 0 });
      await webdriver(`/session/${session}/url`, "POST", { url });
      const result = await safariEvaluate("const deadline=Date.now()+15000;while(!globalThis.interruptHarness){if(Date.now()>deadline)throw Error('harness not loaded');await new Promise(r=>setTimeout(r,10));}return await globalThis.interruptHarness.run(arguments[0]);", [{ benchmark, repetitions }]);
      assert.equal(result.ok, true); assert.equal(result.rescues.length, 5); assert.equal(result.cancellations.length, repetitions * 10);
      const row = { browser: "safari", version: opened.capabilities.browserVersion, ...result }; report.results.push(row); console.log(JSON.stringify(row));
      await safariEvaluate("await globalThis.interruptHarness.clean();return true;");
      await webdriver(`/session/${session}`, "DELETE"); session = undefined;
      driver.kill("SIGTERM"); await driver.exited; driver = undefined;
    } else {
      const require = createRequire(join(process.env.INTERRUPT_PLAYWRIGHT_ROOT ?? join(root, "web"), "package.json"));
      const playwright = await import(pathToFileURL(require.resolve("playwright")).href) as typeof import("playwright");
      const engine = playwright[name as "chromium" | "firefox" | "webkit"];
      launching = engine.launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") }); browser = await launching;
      page = await browser.newPage(); const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => !!(globalThis as any).interruptHarness);
      const result = await page.evaluate(async options => await (globalThis as any).interruptHarness.run(options), { benchmark, repetitions });
      assert.equal(result.ok, true); assert.equal(result.rescues.length, 5); assert.equal(result.cancellations.length, repetitions * 10); assert.deepEqual(errors, []);
      const row = { browser: name, version: browser.version(), ...result }; report.results.push(row); console.log(JSON.stringify(row));
      await page.evaluate(async () => await (globalThis as any).interruptHarness.clean());
      await browser.close(); browser = undefined; launching = undefined; page = undefined;
    }
  }
} catch (error) { report.error ??= error instanceof Error ? error.stack : String(error); throw error; }
finally {
  clearTimeout(deadline);
  try { await cleanup(); }
  finally { console.log(JSON.stringify({ cleanup: report.cleanup })); }
}
