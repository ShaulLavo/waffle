// Real scoped module-worker regression; no Rust, WASM artifacts, app dist, or template install.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { buildBrowserEntries, buildClassicWorker } from "../../scripts/browser-build.ts";

let server;
let browser;
let browserLaunch;
let scratch;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await browserLaunch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}
const timeout = setTimeout(() => {
  console.error("Split-worker smoke exceeded 60 seconds");
  void cleanup().finally(() => process.exit(1));
}, 60_000);

try {
  const port = Number(process.env.SPLIT_SMOKE_PORT ?? 4180);
  assert.equal(execFileSync("ss", ["-H", "-ltn", `sport = :${port}`], { encoding: "utf8" }).trim(), "", `Port ${port} is already in use`);
  // Only this directory, server, browser and profile belong to this test.
  scratch = await mkdtemp(resolve(import.meta.dir, "../node_modules/.browser-splitting-"));
  process.env.TMPDIR = scratch;
  const out = join(scratch, "dist");
  const fsSource = JSON.stringify(resolve(import.meta.dir, "../src/fs.ts"));
  await Bun.write(join(scratch, "shared.ts"), `
    import { MemFS, decode } from ${fsSource};
    export { MemFS };
    export const shared = (value: string) => {
      const fs = new MemFS(); fs.writeFile('/result', value);
      return decode(fs.readFile('/result')!).toUpperCase();
    };
  `);
  await Bun.write(join(scratch, "lazy.ts"), "export const lazy = 'dynamic chunk';\n");
  await Bun.write(join(scratch, "main.ts"), "import { shared } from './shared'; globalThis.pageResult = shared('page');");
  await Bun.write(join(scratch, "worker.ts"), `
    import { Wasi, memoryViews } from '@bun-wasm/runtime/core';
    import { MemFS, shared } from './shared';
    // Tiny real guest: one memory and a no-op _start, assembled without a toolchain.
    const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,0,1,7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,10,4,1,2,0,11]));
    const wasi = new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {} });
    const instance = new WebAssembly.Instance(module, wasi.imports(module));
    const code = wasi.start(instance);
    const memoryBytes = memoryViews(instance.exports.memory as WebAssembly.Memory).bytes().length;
    wasi.descriptors.dispose();
    postMessage({ value: shared('worker'), lazy: (await import('./lazy')).lazy, code, memoryBytes,
      control: await (await fetch('./control-check')).text() });
  `);
  const split = await buildBrowserEntries([join(scratch, "main.ts"), join(scratch, "worker.ts")], out);
  assert.ok(split.outputs.filter((output) => output.kind === "chunk").length >= 2, "Fixture must exercise shared and dynamic chunks");
  // Exercise the production scope forwarding, not a replacement service-worker fixture.
  await buildClassicWorker(resolve(import.meta.dir, "../src/sw.ts"), out, { __PREVIEW_SOCKET_SCRIPT__: '""' });
  await Bun.write(join(out, "index.html"), '<!doctype html><title>Split-worker smoke</title><script type="module" src="./main.js"></script>');
  const requests = [];
  server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      const local = path.replace(/^\/nested\/app\//, "/");
      const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
      // A controlled worker's scoped request is forwarded to the app root by the real SW.
      if (local === "/control-check") return new Response("controlled", { headers });
      if (local === "/__bunwasm/control-check") return new Response("direct", { headers });
      const file = resolve(out, `.${local.endsWith("/") ? `${local}index.html` : local}`);
      if (!file.startsWith(out + sep) || !(await Bun.file(file).exists())) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(file), { headers });
    },
  });
  browserLaunch = chromium.launch({
    headless: true, timeout: 30_000,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces"),
  });
  browser = await browserLaunch;
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  for (const prefix of ["/", "/nested/app/"]) {
    await page.goto(`http://127.0.0.1:${port}${prefix}`, { waitUntil: "load" });
    for (const controlled of [false, true]) {
      const result = await page.evaluate(async (controlled) => {
        if (controlled) {
          const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./__bunwasm/" });
          const active = registration.active ?? registration.installing ?? registration.waiting;
          if (!active) throw new Error("Missing classic service worker");
          if (active.state !== "activated") await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Service worker activation timed out")), 10_000);
            active.addEventListener("statechange", () => {
              if (active.state === "activated") { clearTimeout(timer); resolve(); }
              if (active.state === "redundant") { clearTimeout(timer); reject(new Error("Classic service worker failed")); }
            });
          });
        }
        const workerResult = await new Promise((resolve, reject) => {
          const worker = new Worker(`./__bunwasm/worker.js?controlled=${controlled}`, { type: "module" });
          const timer = setTimeout(() => { worker.terminate(); reject(new Error("Split worker timed out")); }, 10_000);
          worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
          worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
        });
        return { page: globalThis.pageResult, worker: workerResult };
      }, controlled);
      assert.deepEqual(result, { page: "PAGE", worker: { value: "WORKER", lazy: "dynamic chunk", code: 0, memoryBytes: 65536, control: controlled ? "controlled" : "direct" } });
    }
    assert.ok(requests.some((path) => path.startsWith(`${prefix}chunks/`)), "Page must fetch its shared chunk");
    assert.ok(requests.filter((path) => path.startsWith(`${prefix}__bunwasm/chunks/`)).length >= 2, "Uncontrolled worker must fetch mirrored static/dynamic chunks directly");
  }
  assert.deepEqual(errors, []);
  assert.ok(!requests.some((path) => path.endsWith(".map")));
  console.log(`Chromium ${browser.version()}: runtime core/MemFS in split page+worker, static/dynamic chunks, direct/production classic SW, root/nested hosting passed`);
} finally {
  clearTimeout(timeout);
  await cleanup();
}
