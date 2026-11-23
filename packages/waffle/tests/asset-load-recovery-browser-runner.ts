import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright";
import { navigateTestPage } from "../testing/browser-navigation.ts";
import type {} from "./fixtures/asset-load-recovery-page.ts";

const scratch = await mkdtemp(
  join(process.env.PROCESS_SCRATCH_ROOT ?? tmpdir(), "waffle-asset-recovery-"),
);
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let removed = false;
const missing: string[] = [];
const packageRoot = resolve(import.meta.dir, "..");

async function buildConsumer(): Promise<string> {
  const archive = join(scratch, "runtime.tgz");
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", archive], {
    cwd: packageRoot,
    stdio: "pipe",
    timeout: 120_000,
  });
  const packed = join(scratch, "node_modules/@waffle-os/runtime");
  await mkdir(packed, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", packed]);
  const entry = join(scratch, "page.ts");
  await cp(join(import.meta.dir, "fixtures/asset-load-recovery-page.ts"), entry);
  const example = resolve(packageRoot, "../../docs/examples/asset-load-recovery.ts");
  const result = await Bun.build({
    entrypoints: [entry, join(packed, "browser/fs-worker.ts")],
    outdir: join(scratch, "site"),
    target: "browser",
    splitting: true,
    naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" },
    plugins: [
      {
        name: "consumer-example",
        setup(build) {
          build.onResolve({ filter: /docs\/examples\/asset-load-recovery[.]ts$/ }, () => ({
            path: example,
          }));
        },
      },
    ],
  });
  assert.ok(result.success, String(result.logs));
  assert.ok(result.outputs.some((output) => output.kind === "chunk"));
  return join(scratch, "site");
}

async function ready(page: Page, url: string): Promise<void> {
  await navigateTestPage(page, url);
  await page.waitForFunction(() => window.assetRecovery?.ready, null, { timeout: 60_000 });
}

async function run(): Promise<void> {
  const directory = await buildConsumer();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const headers = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cache-Control": "no-store",
      };
      if (path === "/")
        return new Response('<script type="module" src="/page.js"></script>', {
          headers: { ...headers, "Content-Type": "text/html" },
        });
      if ((removed && path.startsWith("/chunks/")) || path === "/missing-worker.js") {
        missing.push(path);
        return new Response("removed asset", { status: 404, headers });
      }
      if (path === "/throws-worker.js")
        return new Response('throw new Error("entry evaluation failed");', {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      if (path === "/ready-worker.js")
        return new Response(
          'postMessage("ready"); onmessage = () => { throw new Error("guest execution failed"); };',
          {
            headers: { ...headers, "Content-Type": "text/javascript" },
          },
        );
      const file = Bun.file(join(directory, path));
      return new Response(file, { status: (await file.exists()) ? 200 : 404, headers });
    },
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const url = server.url.href;
  await ready(page, url);
  assert.equal(await page.evaluate(() => window.assetRecovery.load()), "loaded");
  await page.evaluate(() => window.assetRecovery.dispose());
  await page.close();

  const failed = await context.newPage();
  await ready(failed, url);
  removed = true;
  assert.equal(await failed.evaluate(() => window.assetRecovery.load()), "failed");
  assert.ok(missing.some((path) => path.startsWith("/chunks/")));
  const state = await failed.evaluate(() => window.assetRecovery.snapshot());
  assert.equal(state.failures[0]?.kind, "lazy-service");
  assert.equal(state.failures[0]?.resource, "process service");
  assert.equal(state.file, "unflushed file contents");
  assert.equal(state.editor, "unsaved editor buffer");
  assert.equal(state.guarded, null);
  assert.match(await failed.evaluate(() => window.assetRecovery.reload(true)), /flush failed/);
  assert.deepEqual(await failed.evaluate(() => window.assetRecovery.snapshot()), state);
  removed = false;
  await failed.evaluate(() => window.assetRecovery.dispose());
  await failed.close();

  await workerRecovery(context, url);
  await context.close();
  console.log(
    "packed consumer: lazy chunk removal, early worker errors, preservation failure, bounded reload passed",
  );
}

async function workerRecovery(
  context: Awaited<ReturnType<Browser["newContext"]>>,
  url: string,
): Promise<void> {
  const page = await context.newPage();
  await ready(page, url);
  await page.evaluate(() => window.assetRecovery.worker("/ready-worker.js"));
  await page.waitForFunction(
    async () => (await window.assetRecovery.snapshot()).workerErrors === 1,
  );
  assert.equal((await page.evaluate(() => window.assetRecovery.snapshot())).failures.length, 0);
  await page.evaluate(() => window.assetRecovery.worker("/missing-worker.js"));
  await page.waitForFunction(
    async () => (await window.assetRecovery.snapshot()).failures.length === 1,
  );
  await page.evaluate(() => window.assetRecovery.worker("/throws-worker.js"));
  await page.waitForFunction(
    async () => (await window.assetRecovery.snapshot()).workerErrors === 3,
  );
  assert.equal((await page.evaluate(() => window.assetRecovery.snapshot())).failures.length, 1);
  await page.evaluate(() => {
    void window.assetRecovery.reload(false);
  });
  await page.waitForFunction(
    () => window.assetRecovery?.restored.editor === "unsaved editor buffer",
  );
  assert.deepEqual(await page.evaluate(() => window.assetRecovery.restored), {
    editor: "unsaved editor buffer",
    file: "unflushed file contents",
  });
  await page.evaluate(() => window.assetRecovery.worker("/throws-worker.js"));
  await page.waitForFunction(
    async () => (await window.assetRecovery.snapshot()).failures.length === 1,
  );
  assert.equal(await page.evaluate(() => window.assetRecovery.reload(false)), "blocked");
  await page.evaluate(() => window.assetRecovery.dispose());
  await page.close();
}

try {
  await run();
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.stop(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
