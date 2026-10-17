// Artifact-free step 4a gate. Optional timings reuse an existing bun.wasm; never build WASM here.
// bun tests/browser-process.ts chromium
// BUN_WASM_PROCESS_DIST=/absolute/existing/dist bun tests/browser-process.ts --artifact chromium firefox webkit
// BUN_WASM_PROCESS_DIST=/absolute/existing/dist bun tests/browser-process.ts --benchmark chromium firefox webkit
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { availableParallelism, loadavg } from "node:os";
import { chromium, firefox, webkit, type Browser } from "playwright";
import { buildBrowserEntries } from "../../scripts/browser-build";
import { prepareBaselineSource } from "./process-baseline-source";

const args = process.argv.slice(2);
const benchmark = args.includes("--benchmark");
const artifact = benchmark || args.includes("--artifact");
const names = args.filter(arg => arg !== "--benchmark" && arg !== "--artifact");
if (!names.length) names.push("chromium", "firefox", "webkit");
const types = { chromium, firefox, webkit };
for (const name of names) if (!(name in types)) throw new Error(`unknown browser ${name}`);
const port = Number(process.env.PROCESS_SMOKE_PORT ?? 4186);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid PROCESS_SMOKE_PORT");
const root = resolve(import.meta.dir, "../..");
const dist = process.env.BUN_WASM_PROCESS_DIST;
if (artifact && (!dist || !await Bun.file(join(dist, "bun.wasm")).exists())) throw new Error("--artifact/--benchmark needs BUN_WASM_PROCESS_DIST containing an existing bun.wasm (no rebuild)");
const originalTmpdir = process.env.TMPDIR;
let scratch: string | undefined;
let scratchCreation: Promise<string> | undefined;
interface OwnedCommand { exited: Promise<number>; kill(signal: "SIGTERM"): void; }
const commands = new Set<OwnedCommand>();
function track<T extends OwnedCommand>(child: T): T { commands.add(child); void child.exited.finally(() => commands.delete(child)); return child; }
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launch: Promise<Browser> | undefined;
let cleanupPromise: Promise<void> | undefined;
// Teardown is installed before creating any resource; only this run's browser/server/scratch are owned.
function cleanup(): Promise<void> {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await launch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      for (const child of commands) child.kill("SIGTERM");
      await Promise.all(Array.from(commands, child => child.exited));
      try { const directory = scratch ?? await scratchCreation?.catch(() => undefined); if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir; }
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("process browser gate timed out"); void cleanup().finally(() => process.exit(1)); }, benchmark ? 360_000 : 120_000);
async function freePort() {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen({ host: "127.0.0.1", port, exclusive: true }, resolve); });
  } finally { if (probe.listening) await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve())); }
}
try {
  await freePort();
  scratch = await (scratchCreation = mkdtemp(resolve(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-process-")));
  // Playwright's profiles and driver artifacts belong to this run too, not a host-wide temp root.
  process.env.TMPDIR = scratch;
  console.log(JSON.stringify({ resources: { port, scratch, browsers: names, wasm: artifact ? join(dist!, "bun.wasm") : null }, host: { platform: process.platform, arch: process.arch, logicalCpus: availableParallelism(), loadAverage: loadavg(), bun: Bun.version }, pool: "disabled; no pool implementation is shipped" }));
  const out = join(scratch, "current");
  await buildBrowserEntries([join(import.meta.dir, "process-browser-main.ts"), join(root, "web/src/worker.ts"), join(root, "web/src/fs-worker.ts")], out, { runtimeWorker: true });
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./process-browser-main.js"></script>');
  let baselineRevision: string | undefined;
  if (benchmark) {
    // A remote runner may receive the exact source-and-harness archive below instead
    // of an entire repository/history. Both routes unpack only into this run's owned scratch.
    const archivePath = process.env.PROCESS_BASELINE_ARCHIVE;
    baselineRevision = archivePath ? process.env.PROCESS_BASELINE_REVISION : (await new Response(track(Bun.spawn(["git", "-C", root, "rev-parse", process.env.PROCESS_BASELINE_REF ?? "origin/main"], { stdout: "pipe", stderr: "inherit" })).stdout).text()).trim();
    if (!baselineRevision || !/^[0-9a-f]{40}$/.test(baselineRevision)) throw new Error("cannot resolve baseline revision (archive input requires PROCESS_BASELINE_REVISION)");
    const snapshot = join(scratch, "baseline-source");
    await mkdir(snapshot);
    const archive = archivePath ? undefined : track(Bun.spawn(["git", "-C", root, "archive", baselineRevision, "web/src", "runtime", "web/tests/process-bench-baseline.ts", "web/tests/process-benchmark.ts"], { stdout: "pipe", stderr: "inherit" }));
    const unpack = track(Bun.spawn(["tar", "-x", "-C", snapshot], { stdin: archivePath ? Bun.file(archivePath).stream() : archive!.stdout, stdout: "inherit", stderr: "inherit" }));
    assert.equal(await unpack.exited, 0, "unpack baseline"); if (archive) assert.equal(await archive.exited, 0, "archive baseline");
    await prepareBaselineSource(snapshot);
    const baseline = join(scratch, "baseline");
    await buildBrowserEntries([join(snapshot, "web/tests/process-bench-baseline.ts"), join(snapshot, "web/src/worker.ts"), join(snapshot, "web/src/fs-worker.ts")], baseline);
    await Bun.write(join(baseline, "index.html"), '<!doctype html><script type="module" src="./process-bench-baseline.js"></script>');
  }
  server = Bun.serve({
    hostname: "127.0.0.1", port, reusePort: false,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
      if (artifact && url.pathname === "/bun.wasm") return new Response(Bun.file(join(dist!, "bun.wasm")), { headers: { ...headers, "Content-Type": "application/wasm" } });
      const file = resolve(scratch!, `.${url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname}`);
      if (!file.startsWith(scratch! + sep) || !await Bun.file(file).exists() || (!file.startsWith(out + sep) && !file.startsWith(join(scratch!, "baseline") + sep))) return new Response(null, { status: 404, headers });
      return new Response(Bun.file(file), { headers });
    },
  });
  for (const name of names) {
    launch = types[name as keyof typeof types].launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
    browser = await launch;
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/current/${artifact ? `?artifact=1${benchmark ? "&benchmark=1" : ""}` : ""}`);
    await page.waitForFunction(() => (globalThis as any).processResult, undefined, { timeout: 90_000 });
    const result = await page.evaluate(() => (globalThis as any).processResult);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.length, artifact ? 24 : 23, "process gate unexpectedly changed coverage");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: name, version: browser.version(), revision: "working-tree", ...result }));
    if (benchmark) {
      await page.goto(`http://127.0.0.1:${port}/baseline/`);
      await page.waitForFunction(() => (globalThis as any).processBaselineResult, undefined, { timeout: 90_000 });
      const baseline = await page.evaluate(() => (globalThis as any).processBaselineResult);
      assert.equal(baseline.ok, true, JSON.stringify(baseline));
      assert.equal(baseline.benchmark.wasmSha256, result.benchmark.wasmSha256, "baseline and candidate must use identical existing WASM bytes");
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ browser: name, version: browser.version(), revision: baselineRevision, baseline }));
    }
    await browser.close(); browser = undefined; launch = undefined;
  }
} finally { clearTimeout(deadline); await cleanup(); console.log(`cleanup: owned browsers closed, server ${port} stopped, scratch removed`); }
