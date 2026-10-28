import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
mkdirSync(resolve(root, ".build"), { recursive: true });
const scratch = mkdtempSync(resolve(root, ".build/installed-sed-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const server = createServer();
const hits = new Map<string, number>();

async function serve(files: Map<string, string>) {
  server.on("request", (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (path === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end('<script type="module" src="/app.js"></script>');
      return;
    }
    const file = files.get(path);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "Content-Type",
      path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
    );
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.BASH_WEB_SED_PORT ?? 4283), "127.0.0.1", resolve);
  });
}
let cleanupPending: Promise<void> | undefined;
function cleanup() {
  cleanupPending ??= (async () => {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  })();
  return cleanupPending;
}
process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});
try {
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--workspaces=false", "--pack-destination", scratch],
    {
      cwd: root,
      stdio: "pipe",
    },
  );
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const modules = resolve(scratch, "node_modules");
  const installed = resolve(modules, "bash-web");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    resolve(scratch, `bash-web-${manifest.version}.tgz`),
    "--strip-components=1",
    "-C",
    installed,
  ]);
  symlinkSync(resolve(root, "node_modules/waffle"), resolve(modules, "waffle"));
  cpSync(resolve(root, "tests/sed-installed-app.ts"), resolve(scratch, "app.ts"));
  await build({
    entryPoints: [resolve(scratch, "app.ts")],
    outfile: resolve(scratch, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["browser"],
    target: "esnext",
  });
  const files = new Map([
    ["/app.js", resolve(scratch, "app.js")],
    ["/sed.wasm", resolve(installed, "dist/sed.wasm")],
    ["/shell-worker.js", resolve(installed, "dist/shell-worker.js")],
    ["/fs-worker.js", resolve(installed, "dist/fs-worker.js")],
    ["/shell-engine.wasm", resolve(root, "public/programs/shell-engine.wasm")],
  ]);
  await serve(files);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.goto(`http://127.0.0.1:${process.env.BASH_WEB_SED_PORT ?? 4283}`);
  await page.waitForFunction(() => Reflect.get(globalThis, "sedCleaned") === true, undefined, {
    timeout: 120000,
  });
  const result = await page.evaluate(() => Reflect.get(globalThis, "sedResult"));
  console.log(JSON.stringify({ result, requests: Object.fromEntries(hits) }, null, 2));
  assert.equal(result.ok, true, result.error);
  assert.equal(hits.get("/sed.wasm"), 1, "source should be fetched on first use only");
} finally {
  await cleanup();
}
