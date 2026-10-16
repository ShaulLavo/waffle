// Artifact-free editor durability gate: actual pages, editors and IndexedDB worker, no wasm build.
// bun web/tests/browser-editor.ts [chromium|firefox|webkit]
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const engine = process.argv[2] ?? "chromium";
const browserType = engine === "chromium" ? chromium : engine === "firefox" ? firefox : engine === "webkit" ? webkit : undefined;
if (!browserType) throw new Error(`Unknown browser ${engine}`);
const assets = new Map<string, Blob>();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let browserLaunch: ReturnType<typeof chromium.launch> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await browserLaunch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
}
const timeout = setTimeout(() => {
  console.error("Editor browser gate exceeded 90 seconds");
  void cleanup().finally(() => process.exit(1));
}, 90_000);

try {
  scratch = await mkdtemp(join(process.env.EDITOR_SCRATCH_ROOT ?? "/work/tmp", "bun-wasm-browser-editor-"));
  process.env.TMPDIR = scratch;
  for (const app of ["sandbox", "web"]) {
    const prefix = app === "web" ? "/playground" : "/sandbox";
    const outdir = join(scratch, app);
    const build = await Bun.build({
      outdir,
      entrypoints: [join(root, app, "src/main.ts"), join(root, "web/src/fs-worker.ts")],
      target: "browser", format: "esm", splitting: true,
      naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
      plugins: [{
        name: "artifact-free-editor-host",
        setup(build) {
          // Only the engine and preview host are replaced. All editor, startup, save and
          // persistence code runs as shipped, including the real filesystem worker.
          build.onLoad({ filter: /\/web\/src\/runner\.ts$/ }, () => ({ loader: "ts", contents: `
            export const ENGINES = Object.fromEntries(["browser", "quickjs", "jsc"].map(key => [key, { name: key, wasm: "not-built.wasm" }]));
            export class WasmMissing extends Error {}
            export const isEngine = (key) => Object.hasOwn(ENGINES, key);
            export async function loadWasm() { throw new WasmMissing("Artifact-free editor test"); }
            export async function registerModuleScope() { return false; }
            export const mb = (size) => String(size);
            export function startRun() { throw new Error("This test must not start a guest"); }
          ` }));
          build.onLoad({ filter: /\/web\/src\/preview\.ts$/ }, () => ({ loader: "ts", contents: `
            export class Previews { ready = Promise.resolve("disabled in editor test"); }
          ` }));
        },
      }],
    });
    assert.equal(build.success, true, build.logs.map(String).join("\n"));
    for (const output of build.outputs) assets.set(`${prefix}/${output.path.slice(outdir.length + 1)}`, output);
    assets.set(`${prefix}/`, Bun.file(join(root, app, "index.html")));
  }
  assets.set("/sandbox/template.json", new Blob([JSON.stringify({ files: {
    "index.html": "<!doctype html><h1>Editor persistence test</h1>",
    "src/App.tsx": "export default 'original template';",
    "deleted.ts": "delete me",
    "package.json": "{}",
  } })], { type: "application/json" }));
  server = Bun.serve({
    hostname: "127.0.0.1", port: Number(process.env.EDITOR_PORT ?? 0),
    fetch(request) {
      const path = new URL(request.url).pathname;
      const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
      if (path === "/favicon.ico") return new Response(null, { status: 204, headers });
      const asset = assets.get(path);
      return asset ? new Response(asset, { headers }) : new Response("Not found", { status: 404, headers });
    },
  });
  browserLaunch = browserType.launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
  browser = await browserLaunch;
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(`Page error: ${error.message}`); });
  page.on("response", response => { if (response.status() >= 400) console.error(`HTTP ${response.status()}: ${response.url()}`); });
  const base = `http://127.0.0.1:${server.port}`;

  await page.goto(`${base}/sandbox/`);
  await page.waitForFunction(() => (globalThis as any).sandbox?.editor.path === "src/App.tsx");
  await page.evaluate(async () => {
    const { editor, fs } = (globalThis as any).sandbox;
    editor.setText("export default 'saved edit';");
    await editor.flush("src/App.tsx");
    await fs.remove("/home/user/app/deleted.ts");
    await fs.writeFile("/home/user/app/custom.ts", "custom file");
    await fs.flush();
  });
  assert.equal(await page.locator("#save-state").innerText(), "saved");
  // No delay: the page is discarded immediately after its durable save resolves.
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).sandbox?.editor.path === "src/App.tsx");
  assert.deepEqual(await page.evaluate(async () => {
    const { fs } = (globalThis as any).sandbox;
    return {
      text: new TextDecoder().decode(await fs.readFile("/home/user/app/src/App.tsx")),
      deleted: await fs.lookup("/home/user/app/deleted.ts"),
      custom: new TextDecoder().decode(await fs.readFile("/home/user/app/custom.ts")),
    };
  }), { text: "export default 'saved edit';", deleted: undefined, custom: "custom file" });
  // Fail an actual reset after the first seed write, persist that prefix, then discard
  // the page. The next startup must finish the reset, not accept APP as a complete seed.
  await page.evaluate(() => {
    const { fs } = (globalThis as any).sandbox;
    const write = fs.writeFile.bind(fs);
    let writes = 0;
    fs.writeFile = (...args: unknown[]) => {
      if (++writes === 2) throw new Error("interrupted reset");
      return write(...args);
    };
  });
  page.once("dialog", dialog => { void dialog.accept(); });
  await page.locator("#reset").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("interrupted reset"));
  await page.evaluate(async () => {
    const { fs } = (globalThis as any).sandbox;
    await fs.flush();
    if (await fs.lookup("/home/user/app/.bunwasm-initialized")) throw new Error("Partial reset published its completion marker");
  });
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).sandbox?.editor.path === "src/App.tsx");
  assert.equal(await page.evaluate(async () => new TextDecoder().decode(await (globalThis as any).sandbox.fs.readFile("/home/user/app/src/App.tsx"))), "export default 'original template';");
  await page.evaluate(async () => {
    const { fs } = (globalThis as any).sandbox;
    await fs.writeFile("/home/user/app/custom.ts", "reset removes me");
    await fs.flush();
  });
  page.once("dialog", dialog => { void dialog.accept(); });
  await Promise.all([page.waitForEvent("load"), page.locator("#reset").click()]);
  await page.waitForFunction(() => (globalThis as any).sandbox?.editor.path === "src/App.tsx");
  assert.deepEqual(await page.evaluate(async () => {
    const { fs } = (globalThis as any).sandbox;
    return {
      text: new TextDecoder().decode(await fs.readFile("/home/user/app/src/App.tsx")),
      deletedRestored: !!await fs.lookup("/home/user/app/deleted.ts"),
      custom: await fs.lookup("/home/user/app/custom.ts"),
    };
  }), { text: "export default 'original template';", deletedRestored: true, custom: undefined });
  // Exercise the responsive reset control with the actual stylesheet.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#reset").isVisible(), true);
  if (process.env.EDITOR_SCREENSHOT) await page.screenshot({ path: process.env.EDITOR_SCREENSHOT });

  await page.goto(`${base}/playground/`);
  await page.waitForFunction(() => (globalThis as any).playground?.editor.path === "/home/user/index.ts");
  // Simulate the durable image left if background persistence ran halfway through seed.
  await page.evaluate(async () => {
    const { fs } = (globalThis as any).playground;
    await fs.remove("/home/user");
    await fs.mkdirp("/home/user");
    await fs.writeFile("/home/user/index.ts", "partial seed");
    await fs.flush();
  });
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).playground?.editor.path === "/home/user/index.ts");
  assert.equal(await page.evaluate(async () => !!await (globalThis as any).playground.fs.lookup("/home/user/math.test.ts")), true);
  await page.evaluate(async () => {
    const { editor, fs } = (globalThis as any).playground;
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "console.log('saved playground');" } });
    await editor.save();
    await fs.remove("/home/user/math.test.ts");
    await fs.flush();
  });
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).playground?.editor.path === "/home/user/index.ts");
  assert.deepEqual(await page.evaluate(async () => {
    const { fs } = (globalThis as any).playground;
    return { text: new TextDecoder().decode(await fs.readFile("/home/user/index.ts")), deleted: await fs.lookup("/home/user/math.test.ts") };
  }), { text: "console.log('saved playground');", deleted: undefined });
  assert.deepEqual(errors, []);
  console.log(`${engine} ${browser.version()}: durable editor saves, immediate reload, deleted files, interrupted seed/reset recovery, explicit template reset and mobile reset control passed`);
} finally {
  clearTimeout(timeout);
  await cleanup();
}
