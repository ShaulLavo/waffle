// Paired diagnostic experiment, not a hardware performance claim. BASELINE_ROOT is an archive of
// the named main commit (runtime/, web/src/fs.ts); no Rust or WASM artifacts are needed.
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium, firefox, webkit, type Browser } from "playwright";
import { browserBuildConfig } from "../../scripts/browser-build";
import { filesystemBaselinePlugin } from "./filesystem-bench-baseline";
let scratch: string | undefined, server: ReturnType<typeof Bun.serve> | undefined, browser: Browser | undefined, launch: Promise<Browser> | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await launch?.catch(() => undefined))?.close(); }
    finally { server?.stop(true); if (scratch) await rm(scratch, { recursive: true, force: true }); }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("filesystem benchmark exceeded 10 minutes"); void cleanup().finally(() => process.exit(1)); }, 600_000);
try {
  assert.ok(process.env.BASELINE_ROOT, "BASELINE_ROOT must name the main source archive");
  assert.ok(process.env.BASELINE_SHA, "BASELINE_SHA must name its commit");
  scratch = await mkdtemp(resolve(import.meta.dir, "../node_modules/.filesystem-benchmark-"));
  const out = join(scratch, "dist"), main = join(scratch, "main.ts");
  await Bun.write(main, `import ${JSON.stringify(resolve(import.meta.dir, "filesystem-bench-main.ts"))};`);
  const config = browserBuildConfig([main, resolve(import.meta.dir, "filesystem-bench-worker.ts"), resolve(import.meta.dir, "../src/fs-worker.ts")], out);
  config.plugins!.unshift(filesystemBaselinePlugin(process.env.BASELINE_ROOT));
  const built = await Bun.build(config);
  assert.ok(built.success, built.logs.map(String).join("\n"));
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./main.js"></script>');
  server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.FS_BENCH_PORT ?? 18464), async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(out + sep) || !await Bun.file(file).exists()) return new Response(null, { status: 404 });
    return new Response(Bun.file(file), { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } });
  } });
  let rows: any[] = [];
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox", "webkit"]) {
    const type = { chromium, firefox, webkit }[name];
    assert.ok(type, `unknown browser ${name}`);
    launch = type.launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
    browser = await launch;
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => (globalThis as any).filesystemBench);
    // Smoke every arm/syscall before spending the bounded seven-round measurement window.
    await page.evaluate(() => (globalThis as any).filesystemBench(0, true));
    for (let round = 0; round < 7; round++) {
      const result = await page.evaluate(round => (globalThis as any).filesystemBench(round), round);
      rows = rows.concat(result.map((row: any) => ({ ...row, browser: name, version: browser!.version(), round, warmup: round === 0 })));
      console.log(`${name} round ${round} complete`);
    }
    await page.evaluate(() => (globalThis as any).disposeFilesystemBench());
    await browser.close(); browser = undefined; launch = undefined;
  }
  const median = (values: number[]) => { values.sort((a, b) => a - b); return (values[(values.length - 1) >> 1]! + values[values.length >> 1]!) / 2; };
  const summary = [];
  for (const name of new Set(rows.map(row => row.browser))) for (const syscall of new Set(rows.map(row => row.syscall))) {
    const samples = rows.filter(row => row.browser === name && row.syscall === syscall && !row.warmup);
    const main = median(samples.filter(row => row.arm === "main").map(row => row.nsPerCall));
    const head = median(samples.filter(row => row.arm === "head").map(row => row.nsPerCall));
    summary.push({ browser: name, syscall, mainNs: main, headNs: head, ratio: head / main });
  }
  const report = { method: "Spike 4 micro fixtures/counts, public WASI wrappers; headless paired diagnostic, seven alternating rounds, first warmup discarded, median of six. No reruns or speed threshold. Same machine/browser per pair; no Rust/WASM builds.", baseline: process.env.BASELINE_SHA, head: process.env.HEAD_SHA ?? "working-tree", platform: process.platform, arch: process.arch, headless: true, rows, summary };
  if (process.env.FS_BENCH_OUTPUT) await Bun.write(process.env.FS_BENCH_OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { clearTimeout(deadline); await cleanup(); }
