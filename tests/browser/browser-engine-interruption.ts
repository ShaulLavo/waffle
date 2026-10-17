// Real-worker step 7a gate. Never builds WASM. Run after the matching fresh builds:
// BUN_WASM_INTERRUPTION_DIST=/absolute/dist bun tests/browser-engine-interruption.ts chromium firefox webkit
// BUN_WASM_INTERRUPTION_DIST=/absolute/dist bun tests/browser-engine-interruption.ts --benchmark safari
// Safari is actual desktop Safari via its existing WebDriver permission, not Playwright WebKit.
// The same page/worker harness runs on the Mac fleet host; do not enable automation settings here.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir, availableParallelism, loadavg } from "node:os";
import { buildBrowserEntries } from "../../scripts/browser-build";
import type { Browser } from "playwright";
import { allocateSafariDriverPort, assertSafariDriverAlive, ownSafariDriver, safariDriverOwnershipDiagnostic, stopSafariDriver, type SafariDriverOwnership } from "./engine-interruption-safari";

export interface RunnerCleanup {
  safe: boolean;
  errors?: string[];
  [resource: string]: unknown;
}
export interface BrowserGateReport {
  browser: string;
  ok: boolean;
  cleanup: { safe: boolean; [key: string]: any };
  [key: string]: any;
}
export interface BrowserGateOutput {
  ok: boolean;
  artifacts: readonly unknown[];
  reports: BrowserGateReport[];
  cleanup: RunnerCleanup;
  error?: string;
  unsafeCleanup?: string;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? String(error) : String(error);
}
async function boundedCleanup<T>(name: string, run: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} cleanup timed out after ${timeoutMs}ms; resource shutdown is unproved`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
// Each resource gets an independent, bounded attempt. One failed/hung close must
// never skip the session, driver, listener or scratch, nor become safe:true.
export async function collectRunnerCleanup(steps: readonly { name: string; timeoutMs?: number; run: () => unknown | Promise<unknown> }[], timeoutMs = 5_000): Promise<RunnerCleanup> {
  const result: RunnerCleanup = { safe: true };
  const errors: string[] = [];
  for (const step of steps) {
    try { await boundedCleanup(step.name, step.run, step.timeoutMs ?? timeoutMs); result[step.name] = true; }
    catch (error) { result[step.name] = false; result.safe = false; errors.push(`${step.name}: ${errorText(error)}`); }
  }
  if (errors.length) result.errors = errors;
  return result;
}
// Scratch may contain live profiles or bundle writes. Keep it intact whenever
// any consumer's shutdown is unproved, but still attempt independent teardown.
export async function finishRunnerCleanup(options: {
  prepared: RunnerCleanup;
  closed: RunnerCleanup;
  scratch?: string;
  scratchCreation?: Promise<string>;
  stopListener: () => unknown | Promise<unknown>;
  removeScratch: (directory: string) => unknown | Promise<unknown>;
  restoreEnvironment: () => unknown | Promise<unknown>;
  timeoutMs?: number;
}): Promise<RunnerCleanup> {
  const { prepared, closed } = options;
  const listener = await collectRunnerCleanup([{ name: "listenerClosed", run: options.stopListener }], options.timeoutMs);
  const rest = await collectRunnerCleanup([
    { name: "scratchRemoved", async run() {
      if (!prepared.safe || !closed.safe || !listener.safe) {
        throw new Error(`scratch retained while consumer shutdown is unproved: ${options.scratch ?? "creation pending"}`);
      }
      const directory = options.scratch ?? await options.scratchCreation?.catch(() => undefined);
      if (directory) await options.removeScratch(directory);
    } },
    { name: "temporaryEnvironmentRestored", run: options.restoreEnvironment },
  ], options.timeoutMs);
  const errors = (prepared.errors ?? []).concat(closed.errors ?? [], listener.errors ?? [], rest.errors ?? []);
  return { ...prepared, ...closed, ...listener, ...rest, safe: prepared.safe && closed.safe && listener.safe && rest.safe, ...(errors.length ? { errors } : {}) };
}
function assertGreenResult(result: Record<string, any>, benchmark: boolean): void {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cleanup?.safe, true, "page execution quiescence and cleanup");
  // WebDriver JSON cloning represents an absent undefined page field as null.
  assert.equal(result.unsafeCleanup ?? undefined, undefined, "page unsafe cleanup");
  assert.ok(Array.isArray(result.outcomes) && result.outcomes.length > 0, "page functional outcomes");
  assert.ok(result.outcomes.every((outcome: any) => outcome.ok === true && outcome.cleanup?.safe === true), "all page functional cases passed safely");
  assert.deepEqual(result.pageErrors ?? [], [], "page errors");
  assert.equal(result.checks.length, 28, "fourteen legacy host, twelve page/generic-route and two actual Preview1 clock cases");
  assert.equal(result.checks.filter((check: any) => check.route === "runtimeProcess").length, 10, "new-route fatal, pending and page-idle proof on both engines");
  for (const engine of ["quickjs", "jsc"]) {
    assert.equal(result.checks.filter((check: any) => check.engine === engine).length, 12, `${engine} complete legacy/new-route case set`);
  }
  assert.equal(new Set(result.checks.map((check: any) => `${check.engine}:${check.name}`)).size, 28, "all named proofs are distinct");
  assert.equal(result.cleanup.activeWorkers, 0, "worker cleanup");
  if (benchmark) assert.equal(result.benchmarks.length, 2, "per-engine overhead measurements");
}

// Import-safe orchestration lets failure/teardown paths be exercised without a
// browser or WASM. Functional RED is independent from unsafe resource cleanup.
export async function runBrowserGate(options: {
  names: readonly string[];
  artifacts: readonly unknown[];
  benchmark?: boolean;
  cleanupTimeoutMs?: number;
  prepare?: () => Promise<void>;
  runBrowser: (name: string, report: BrowserGateReport) => Promise<Record<string, any>>;
  teardownBrowser: (name: string) => Promise<RunnerCleanup>;
  cleanup: () => Promise<RunnerCleanup>;
  writeReport: (report: BrowserGateOutput) => Promise<void>;
  onState?: (report: BrowserGateOutput) => void;
  onReport?: (report: BrowserGateReport) => void;
}): Promise<BrowserGateOutput> {
  const output: BrowserGateOutput = { ok: false, artifacts: options.artifacts, reports: [], cleanup: { safe: false } };
  options.onState?.(output);
  try {
    await options.prepare?.();
    for (const name of options.names) {
      const report: BrowserGateReport = { browser: name, ok: false, cleanup: { safe: true } };
      output.reports.push(report);
      try {
        const result = await options.runBrowser(name, report);
        Object.assign(report, result, { browser: name });
        // Do not replace page diagnostics/outcomes when admission fails.
        if (result.cleanup?.safe === false || (result.unsafeCleanup !== undefined && result.unsafeCleanup !== null)
          || result.outcomes?.some((outcome: any) => outcome.cleanup?.safe === false)) {
          report.cleanup = { ...result.cleanup, safe: false };
          output.unsafeCleanup = `${name}: ${result.unsafeCleanup ?? "page execution quiescence or resource cleanup is unproved"}`;
        }
        assertGreenResult(result, Boolean(options.benchmark));
      } catch (error) { report.ok = false; report.error = errorText(error); }
      finally {
        let closed: RunnerCleanup;
        try { closed = await boundedCleanup(`${name} browser`, () => options.teardownBrowser(name), options.cleanupTimeoutMs ?? 45_000); }
        catch (error) { closed = { safe: false, errors: [errorText(error)] }; }
        report.browserCleanup = closed;
        report.cleanup = { ...report.cleanup, safe: report.cleanup?.safe !== false && closed.safe };
        if (!closed.safe) {
          report.ok = false;
          const failure = `${name} browser cleanup: ${closed.errors?.join("; ") ?? JSON.stringify(closed)}`;
          report.error = report.error ? `${report.error}\n${failure}` : failure;
          output.unsafeCleanup = output.unsafeCleanup ? `${output.unsafeCleanup}\n${failure}` : failure;
        }
      }
      options.onReport?.(report);
      if (output.unsafeCleanup) break;
    }
  } catch (error) { output.error = errorText(error); }
  finally {
    try { output.cleanup = await boundedCleanup("all owned resources", options.cleanup, options.cleanupTimeoutMs ?? 45_000); }
    catch (error) { output.cleanup = { safe: false, errors: [errorText(error)] }; }
    if (!output.cleanup.safe) {
      const failure = `owned resource cleanup: ${output.cleanup.errors?.join("; ") ?? JSON.stringify(output.cleanup)}`;
      output.unsafeCleanup = output.unsafeCleanup ? `${output.unsafeCleanup}\n${failure}` : failure;
    }
    output.cleanup.safe = output.cleanup.safe && !output.unsafeCleanup;
    output.ok = !output.error && output.cleanup.safe && output.reports.length === options.names.length && output.reports.every(report => report.ok);
    // Deliberately outside the cleanup try: output is still attempted if teardown
    // throws. An output write failure itself must reject, not claim a green run.
    await options.writeReport(output);
  }
  return output;
}

async function main(): Promise<boolean> {
  const functionalPageTimeoutMs = 600_000;
  const functionalDriverTimeoutMs = 615_000;
  const functionalBrowserTimeoutMs = 640_000;
  const args = process.argv.slice(2);
  const benchmark = args.includes("--benchmark");
  const names = args.filter(name => name !== "--benchmark");
  if (!names.length) names.push("chromium", "firefox", "webkit");
  const root = resolve(import.meta.dir, "../..");
  const dist = resolve(process.env.BUN_WASM_INTERRUPTION_DIST ?? join(root, "dist"));
  const baselineDist = process.env.BUN_WASM_INTERRUPTION_BASELINE_DIST;
  const artifacts: { name: string; path: string; route: string; bytes: number; modified: string }[] = [];
  const originalTmpdir = process.env.TMPDIR;
  let scratch: string | undefined;
  let scratchCreation: Promise<string> | undefined;
  let preparing: Promise<void> | undefined;
  let openingSession: Promise<any> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Browser | undefined, launching: Promise<Browser> | undefined;
  let driver: ReturnType<typeof Bun.spawn> | undefined;
  let driverOwnership: SafariDriverOwnership | undefined;
  let session: string | undefined;
  let stopping = false;
  let cleanupPromise: Promise<RunnerCleanup> | undefined;
  let browserCleanupPromise: Promise<RunnerCleanup> | undefined;
  let driverPort = 0;
  let url = "";
  let state: BrowserGateOutput | undefined;
  const requestedDriverPort = process.env.ENGINE_INTERRUPTION_SAFARI_PORT === undefined ? 0 : Number(process.env.ENGINE_INTERRUPTION_SAFARI_PORT);
  function assertRunning(): void { assert.ok(!stopping, "engine interruption runner is stopping"); }
  async function webdriver(path: string, method = "GET", body?: unknown): Promise<any> {
    assert.ok(driverOwnership, "Safari driver not started");
    assertSafariDriverAlive(driverOwnership.driver);
    const response = await fetch(`http://127.0.0.1:${driverPort}` + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(stopping ? 3_000 : benchmark ? 540_000 : functionalDriverTimeoutMs) });
    const result: any = await response.json();
    if (!response.ok || result.value?.error) throw new Error(`Safari WebDriver ${path}: ${result.value?.message ?? response.status}`);
    return result.value;
  }
  async function safariScript(script: string): Promise<any> {
    const result = await webdriver(`/session/${session}/execute/async`, "POST", {
      script: `const done=arguments[arguments.length-1]; Promise.resolve().then(async()=>{${script}}).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error.stack||error)}));`, args: [],
    });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  function teardownBrowser(): Promise<RunnerCleanup> {
    return browserCleanupPromise ??= collectRunnerCleanup([
      { name: "browsersClosed", async run() {
        const owned = browser ?? await launching?.catch(() => undefined);
        // Browser.close kills page workers even when the page/harness is broken.
        if (owned) await owned.close();
        browser = undefined; launching = undefined;
      } },
      { name: "sessionClosed", async run() {
        const owned = session ?? (await openingSession)?.sessionId;
        if (openingSession && !owned) throw new Error("Safari session creation has no confirmed session id; shutdown is unproved");
        if (owned) await webdriver(`/session/${owned}`, "DELETE");
        session = undefined; openingSession = undefined;
      } },
      { name: "driverStopped", timeoutMs: driverOwnership ? 15_000 : undefined, async run() {
        if (driverOwnership) {
          await stopSafariDriver(driverOwnership, driverPort);
          await driver?.exited;
          driver = undefined; driverOwnership = undefined;
        }
      } },
    ]);
  }
  // Installed before any scratch, listener, browser profile, driver or worker.
  function cleanup(): Promise<RunnerCleanup> {
    stopping = true;
    return cleanupPromise ??= (async () => {
      // A pending bundle write or scratch creation must settle before its
      // directory is removed. If it hangs, retain that identified directory.
      const prepared = await collectRunnerCleanup([{ name: "preparationStopped", async run() { await preparing?.catch(() => undefined); } }]);
      const closed = await teardownBrowser();
      return finishRunnerCleanup({ prepared, closed, scratch, scratchCreation,
        async stopListener() { await server?.stop(true); server = undefined; },
        removeScratch: directory => rm(directory, { recursive: true, force: true }),
        restoreEnvironment() {
          if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
        },
      });
    })();
  }
  async function writeReport(report: BrowserGateOutput): Promise<void> {
    if (process.env.ENGINE_INTERRUPTION_OUTPUT) await Bun.write(process.env.ENGINE_INTERRUPTION_OUTPUT, JSON.stringify({ ...report,
      resources: { scratch, safariDriverPort: driverPort || undefined, safariDriverPid: driver?.pid, safariSession: session,
        listenerPort: server?.port, browserConnected: browser?.isConnected(), browserLaunchPending: Boolean(launching && !browser) },
    }, null, 2) + "\n");
  }
  let interruption: Promise<void> | undefined;
  function interrupt(reason: string): void {
    interruption ??= (async () => {
      console.error(reason);
      try {
        let cleaned: RunnerCleanup;
        try { cleaned = await boundedCleanup("interrupted owned resources", cleanup, 45_000); }
        catch (error) { cleaned = { safe: false, errors: [errorText(error)] }; }
        if (state) {
          state.ok = false; state.error = reason;
          state.cleanup = { ...cleaned, safe: false };
          state.unsafeCleanup = "runner interrupted before execution quiescence was proved";
          for (const report of state.reports) if (!report.browserCleanup) { report.ok = false; report.cleanup.safe = false; }
          await writeReport(state);
        }
      } finally { process.exit(1); }
    })();
  }
  const onInterrupt = () => interrupt("engine interruption gate received SIGINT");
  const onTerminate = () => interrupt("engine interruption gate received SIGTERM");
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate);
  const deadline = setTimeout(() => interrupt("engine interruption gate exceeded its bounded deadline"), names.length * (benchmark ? 550_000 : functionalBrowserTimeoutMs) + 30_000);
  try {
    const result = await runBrowserGate({ names, artifacts, benchmark, onState(report) { state = report; }, writeReport, cleanup,
      onReport(report) { console.log(JSON.stringify(report)); },
      prepare() { return preparing = (async () => {
        for (const name of names) assert.ok(["chromium", "firefox", "webkit", "safari"].includes(name), `unknown browser ${name}`);
        if (names.includes("safari")) assert.equal(process.platform, "darwin", "actual Safari runs on the Mac fleet host");
        assert.ok(!baselineDist || benchmark, "baseline artifacts are used only with --benchmark");
        assert.ok(Number.isInteger(requestedDriverPort) && (requestedDriverPort === 0 || requestedDriverPort > 1023 && requestedDriverPort < 65536), "invalid Safari driver port");
        const inputs = ["bun.wasm", "bun-jsc.wasm", "bun-browser.wasm"].map(name => ({ name, path: join(dist, name), route: `/${name}` }))
          .concat(baselineDist ? ["bun.wasm", "bun-jsc.wasm"].map(name => ({ name, path: resolve(baselineDist, name), route: `/baseline/${name}` })) : []);
        for (const input of inputs) {
          const info = await stat(input.path);
          assert.ok(info.isFile() && info.size > 0, `missing artifact ${input.path}`);
          artifacts.push({ ...input, bytes: info.size, modified: info.mtime.toISOString() });
        }
        assertRunning();
        const scratchRoot = process.env.TMPDIR ?? (process.platform === "linux" ? "/work/tmp" : tmpdir());
        scratch = await (scratchCreation = mkdtemp(join(scratchRoot, "bun-wasm-engine-interruption-")));
        assertRunning(); process.env.TMPDIR = scratch;
        console.log(JSON.stringify({ resources: { scratch, artifacts, browsers: names, safariDriverPort: names.includes("safari") ? driverPort : null },
          host: { platform: process.platform, arch: process.arch, logicalCpus: availableParallelism(), loadAverage: loadavg(), bun: Bun.version }, benchmark }));
        // The caller owns a supplied bundle. Only this run's profile/build scratch is removed.
        const out = process.env.ENGINE_INTERRUPTION_BROWSER_BUNDLE ? resolve(process.env.ENGINE_INTERRUPTION_BROWSER_BUNDLE) : join(scratch, "browser");
        if (!process.env.ENGINE_INTERRUPTION_BROWSER_BUNDLE) {
          await buildBrowserEntries([join(import.meta.dir, "engine-interruption-main.ts"), join(import.meta.dir, "engine-interruption-worker.ts"),
            join(root, "web/src/worker.ts"), join(root, "web/src/fs-worker.ts")], out);
          assertRunning();
          await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./engine-interruption-main.js"></script>');
        }
        assertRunning();
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false, async fetch(request) {
          const path = new URL(request.url).pathname;
          const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
          const artifact = artifacts.find(entry => path === entry.route);
          if (artifact) return new Response(Bun.file(artifact.path), { headers: { ...headers, "Content-Type": "application/wasm" } });
          const file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
          if (!file.startsWith(out + sep) || !await Bun.file(file).exists()) return new Response(null, { status: 404, headers });
          return new Response(Bun.file(file), { headers });
        } });
        url = `http://127.0.0.1:${server.port}/${benchmark ? `?benchmark=1${baselineDist ? "&baseline=1" : ""}` : ""}`;
      })(); },
      teardownBrowser,
      async runBrowser(name, report) {
        assertRunning(); browserCleanupPromise = undefined;
        let result: any, version: string;
        if (name === "safari") {
          driverPort = await allocateSafariDriverPort(requestedDriverPort);
          assertRunning();
          const spawnedAfter = Date.now();
          driver = Bun.spawn(["/usr/bin/safaridriver", "--port", String(driverPort)], { stdout: "ignore", stderr: "inherit" });
          driverOwnership = ownSafariDriver(driver, spawnedAfter, driverPort);
          console.log(JSON.stringify({ resources: { safariDriverPort: driverPort, safariDriverPid: driver.pid } }));
          for (let attempt = 0; ; attempt++) {
            try { await webdriver("/status"); break; }
            catch (error) {
              if (driver.exitCode !== null || driver.signalCode !== null || attempt >= 40) throw error;
              await Bun.sleep(100); assertRunning();
            }
          }
          assertRunning();
          // Follow step9's proven free-port + owned-driver session lifecycle.
          // Strict XPC attribution is useful evidence, not a session gate.
          const diagnostic = await safariDriverOwnershipDiagnostic(driverOwnership, driverPort);
          if (diagnostic) console.log(JSON.stringify({ safariDriverOwnershipDiagnostic: diagnostic }));
          assertRunning();
          const opened = await (openingSession = webdriver("/session", "POST", { capabilities: { alwaysMatch: { browserName: "safari" } } }));
          session = opened.sessionId; version = opened.capabilities.browserVersion; report.version = version;
          assertRunning();
          await webdriver(`/session/${session}/timeouts`, "POST", { script: benchmark ? 530_000 : functionalDriverTimeoutMs, pageLoad: 30_000, implicit: 0 });
          await webdriver(`/session/${session}/url`, "POST", { url });
          result = await safariScript(`const end=Date.now()+${benchmark ? 525_000 : functionalPageTimeoutMs}; while(!globalThis.engineInterruptionResult){if(Date.now()>end)throw Error('engine interruption page timed out');await new Promise(r=>setTimeout(r,25));} return globalThis.engineInterruptionResult;`);
        } else {
          const types = await import("playwright");
          assertRunning();
          launching = types[name as "chromium" | "firefox" | "webkit"].launch({ headless: true,
            downloadsPath: join(scratch!, "downloads"), tracesDir: join(scratch!, "traces") });
          browser = await launching;
          assertRunning(); version = browser.version(); report.version = version;
          const page = await browser.newPage();
          const pageErrors: string[] = []; report.pageErrors = pageErrors;
          page.on("pageerror", error => pageErrors.push(error.message));
          await page.goto(url);
          await page.waitForFunction(() => (globalThis as any).engineInterruptionResult, undefined, { timeout: benchmark ? 530_000 : functionalPageTimeoutMs });
          result = await page.evaluate(() => (globalThis as any).engineInterruptionResult);
          result.pageErrors = pageErrors;
        }
        return { version, ...result };
      },
    });
    console.log(JSON.stringify({ cleanup: result.cleanup, unsafeCleanup: result.unsafeCleanup }));
    if (!result.ok) {
      console.error(result.error ?? result.unsafeCleanup ?? "engine interruption gate failed; see retained browser reports");
      process.exitCode = 1;
    }
    return result.cleanup.safe;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
  }
}
if (import.meta.main) {
  try {
    // A timed-out close may leave native handles alive. The unsafe report is
    // already durable; exit nonzero instead of hanging indefinitely on them.
    if (!await main()) process.exit(1);
  } catch (error) { console.error(errorText(error)); process.exit(1); }
}
