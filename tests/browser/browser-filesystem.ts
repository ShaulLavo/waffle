import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium, firefox, webkit, type Browser } from "playwright";
import { buildBrowserEntries } from "../../scripts/browser-build";

let scratch: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launch: Promise<Browser> | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await launch?.catch(() => undefined))?.close(); }
    finally { server?.stop(true); if (scratch) await rm(scratch, { recursive: true, force: true }); }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("filesystem browser gate timed out"); void cleanup().finally(() => process.exit(1)); }, 90_000);
try {
  scratch = await mkdtemp(resolve(import.meta.dir, "../node_modules/.filesystem-browser-"));
  const out = join(scratch, "dist");
  const main = join(scratch, "main.ts");
  await Bun.write(main, `import ${JSON.stringify(resolve(import.meta.dir, "filesystem-browser-main.ts"))};`);
  await buildBrowserEntries([main, resolve(import.meta.dir, "../src/worker.ts"), resolve(import.meta.dir, "../src/fs-worker.ts"), resolve(import.meta.dir, "filesystem-browser-guest.ts"), resolve(import.meta.dir, "filesystem-browser-failure.ts")], out);
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./main.js"></script>');
  server = Bun.serve({
    hostname: "127.0.0.1", port: Number(process.env.FS_SMOKE_PORT ?? 4181),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      const file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
      if (!file.startsWith(out + sep) || !await Bun.file(file).exists()) return new Response(null, { status: 404 });
      return new Response(Bun.file(file), { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } });
    },
  });
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"]) {
    const type = { chromium, firefox, webkit }[name];
    if (!type) throw new Error(`unknown browser ${name}`);
    launch = type.launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
    browser = await launch;
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => (globalThis as any).filesystemResult, undefined, { timeout: 60_000 });
    const result = await page.evaluate(() => (globalThis as any).filesystemResult);
    assert.deepEqual(result, { ok: true, checks: 9 });
    assert.deepEqual(errors, []);
    console.log(`${name} ${browser.version()}: shared tree, open identity, concurrent inodes, >8 MiB, production run bootstrap and worker failure passed`);
    await browser.close(); browser = undefined; launch = undefined;
  }
} finally { clearTimeout(deadline); await cleanup(); }
