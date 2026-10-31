import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

async function closeServer(server: Server) {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
  });
}
function responder(files: ReadonlyMap<string, string>, hits: Map<string, number>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    hits.set(path, 1 + (hits.get(path) ?? 0));
    const headers = {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    };
    if (path === "/") {
      response.writeHead(200, { ...headers, "Content-Type": "text/html" });
      response.end('<script type="module" src="/app.js"></script>');
      return;
    }
    const file = files.get(path);
    if (!file) {
      response.writeHead(404, headers).end();
      return;
    }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, {
        ...headers,
        "Content-Type": path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(500, headers).end(String(error));
    }
  };
}

test(
  "clear runs lazily on the caller runtime and clears the existing terminal",
  { timeout: 70000 },
  async (context) => {
    const resources = new AsyncDisposableStack();
    context.after(() => resources.disposeAsync());
    const interrupted = () => {
      void resources.disposeAsync().finally(() => process.exit(143));
    };
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    context.after(() => {
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
    });
    const root = resolve(import.meta.dirname, "..");
    const scratch = await mkdtemp(resolve(root, ".build/clear-browser-"));
    resources.defer(() => rm(scratch, { recursive: true, force: true }));
    const app = resolve(scratch, "app.js");
    await build({
      stdin: { contents: 'import "./tests/clear-browser.ts";', resolveDir: root },
      outfile: app,
      platform: "browser",
      target: "esnext",
      bundle: true,
      conditions: ["browser"],
      format: "esm",
    });
    const release = resolve(
      root,
      "../..",
      process.env.CARGO_TARGET_DIR ?? ".build/coreutils",
      "wasm32-wasip1/release",
    );
    const assets = new Map([
      ["/app.js", app],
      ["/clear.wasm", resolve(root, "dist/clear.wasm")],
      ["/dist/clear.wasm", resolve(root, "dist/clear.wasm")],
      ["/shell-worker.js", resolve(root, "dist/shell-worker.js")],
      ["/fs-worker.js", resolve(root, "dist/fs-worker.js")],
      ["/shell-runtime.wasm", resolve(release, "shell-runtime.wasm")],
      ["/ghostty-vt.wasm", resolve(root, ".sources/ghostty-webgpu/ghostty-vt.wasm")],
      ["/bridge.wasm", resolve(root, ".sources/ghostty-webgpu/bridge.wasm")],
    ]);
    const hits = new Map<string, number>();
    const server = createServer(responder(assets, hits));
    resources.defer(() => closeServer(server));
    await new Promise<void>((listening, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", listening);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      headless: true,
    });
    resources.defer(() => browser.close());
    const page = await browser.newPage();
    const workerClosures: Promise<unknown>[] = [];
    page.on("worker", (worker) => workerClosures.push(worker.waitForEvent("close")));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => Reflect.get(globalThis, "clearCleaned"), undefined, {
      timeout: 60000,
    });
    const result: unknown = await page.evaluate(() => Reflect.get(globalThis, "clearResult"));
    console.log(JSON.stringify({ result, requests: Object.fromEntries(hits) }, null, 2));
    assert.ok(result && typeof result === "object" && "ok" in result && result.ok === true);
    await Promise.all(workerClosures);
    assert.equal(page.workers().length, 0, "workers remain after runtime disposal");
    assert.equal(hits.get("/clear.wasm"), 1, "custom source must load once");
    assert.equal(hits.get("/dist/clear.wasm"), 1, "default source must load once");
  },
);
