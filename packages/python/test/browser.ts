import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { serveTestFiles } from "./assets-server.ts";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
rmSync(dist, { recursive: true, force: true });
const built = await Bun.build({
  entrypoints: [resolve(root, "test/browser-main.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
  splitting: true,
  naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
});
if (!built.success) throw new AggregateError(built.logs, "Browser fixture build failed");
writeFileSync(resolve(dist, "index.html"), '<!doctype html><meta charset="utf-8"><script type="module" src="./browser-main.js"></script>');

const server = await serveTestFiles(root);
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const diagnostics: string[] = [];
  page.on("console", message => diagnostics.push(`console:${message.type()}:${message.text()}`));
  page.on("pageerror", error => diagnostics.push(`pageerror:${error.stack ?? error.message}`));
  page.on("requestfailed", request => diagnostics.push(`requestfailed:${request.url()}:${request.failure()?.errorText}`));
  page.on("response", response => { if (response.status() >= 400) diagnostics.push(`http:${response.status()}:${response.url()}`); });
  await page.goto(`${server.origin}/dist/index.html`);
  await page.waitForFunction(() => Reflect.has(globalThis, "pythonPackageResult"), undefined, { timeout: 30000 });
  const results = await page.evaluate(() => Reflect.get(globalThis, "pythonPackageResult"));
  console.log(JSON.stringify({ browser: "chromium", results, diagnostics }));
  assert.equal(results.length, 3);
} finally {
  await browser?.close();
  await server.close();
}
