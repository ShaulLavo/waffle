import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserContext } from "playwright";
import { networkBrowserCases } from "./network-browser.js";
import { installNetworkServiceWorker } from "./network-browser-service-worker.js";
import {
  closeBrowserResources,
  type BrowserResourceOwner,
} from "./process-recycling-browser-runner-control.js";

const engines = { chromium, firefox, webkit };
type Engine = keyof typeof engines;

export async function runNetworkBrowser(names: readonly string[] = ["chromium"]): Promise<void> {
  const browsers = new Set<BrowserResourceOwner>();
  const contexts = new Set<BrowserResourceOwner>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let scratchCreation: Promise<string> | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      const errors = await closeBrowserResources(contexts, browsers);
      server?.stop(true);
      const scratch = await scratchCreation;
      if (scratch && browsers.size === 0) await rm(scratch, { recursive: true, force: true });
      if (errors.length) throw new AggregateError(errors, "Network browser cleanup failed");
    })());
  const stop = () => {
    void cleanup().finally(() => process.exit(1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const deadline = setTimeout(stop, 600_000);
  try {
    const root = resolve(
      process.env.NETWORK_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp",
    );
    await mkdir(root, { recursive: true });
    scratchCreation = mkdtemp(resolve(root, "wnet-"));
    const scratch = await scratchCreation;
    console.log(
      JSON.stringify({
        resources: "network-browser",
        scratch,
        port: Number(process.env.NETWORK_TEST_PORT ?? 43827),
        entries: [networkBrowserCases.name, installNetworkServiceWorker.name],
      }),
    );
    const sources = [
      "network-browser.ts",
      "network-browser-worker.ts",
      "network-browser-service-worker.ts",
      "../browser/fs-worker.ts",
    ];
    const paths = ["/tests.js", "/network-worker.js", "/network-sw.js", "/network-fs.js"];
    const scripts = new Map<string, Blob>();
    for (const [index, source] of sources.entries()) {
      const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, source)],
        target: "browser",
      });
      if (!build.success) throw new AggregateError(build.logs, `Failed to build ${source}`);
      scripts.set(paths[index]!, build.outputs[0]!);
    }
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(process.env.NETWORK_TEST_PORT ?? 43827),
      fetch(request) {
        const path = new URL(request.url).pathname;
        const headers = {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Content-Type": path === "/" ? "text/html" : "text/javascript",
        };
        if (path.endsWith("/network.wasm"))
          return new Response(Bun.file(new URL("../browser/net/network.wasm", import.meta.url)), {
            headers: { ...headers, "Content-Type": "application/wasm" },
          });
        if (path === "/")
          return new Response("<!doctype html><title>Network workers</title>", { headers });
        return new Response(scripts.get(path) ?? "Not found", {
          status: scripts.has(path) ? 200 : 404,
          headers,
        });
      },
    });
    for (const name of names) {
      if (!Object.hasOwn(engines, name)) throw Error(`Unknown browser ${name}`);
      await inBrowser(name as Engine, server.url.href, root, browsers, contexts);
    }
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await cleanup();
  }
}

async function inBrowser(
  name: Engine,
  url: string,
  tmp: string,
  browsers: Set<BrowserResourceOwner>,
  contexts: Set<BrowserResourceOwner>,
): Promise<void> {
  const creation: Promise<Browser> = engines[name].launch({
    headless: true,
    env: { ...process.env, TMPDIR: tmp },
  });
  const owner = { creation, stopped: false };
  browsers.add(owner);
  const browser = await creation;
  const contextCreation: Promise<BrowserContext> = browser.newContext();
  contexts.add({ creation: contextCreation, stopped: false });
  const page = await (await contextCreation).newPage();
  page.on("pageerror", (error) => console.error(`Network page: ${error.message}`));
  await page.goto(url);
  const results = await page.evaluate(async () => {
    const path = "/tests.js";
    const fixture: typeof import("./network-browser.js") = await import(path);
    return fixture.networkBrowserCases();
  });
  console.log(JSON.stringify({ engine: name, passed: results }));
  const errors = await closeBrowserResources(contexts, browsers);
  if (errors.length) throw new AggregateError(errors, `${name} cleanup failed`);
}

if (import.meta.main)
  await runNetworkBrowser(process.argv.length > 2 ? process.argv.slice(2) : undefined);
