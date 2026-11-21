import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import playwright from "playwright/package.json" with { type: "json" };
import {
  BrowserRunnerLifecycle,
  engines,
} from "../packages/waffle/tests/browser-runner-lifecycle.ts";
import { navigateTestPage } from "../packages/waffle/tests/browser-navigation.ts";
import { parseModuleMemory } from "../packages/waffle/memory/declarations.ts";
import { programBytesIdentity } from "./program-derivation.ts";

export type FamilyBrowser = keyof typeof engines;

const shell = '<!doctype html><body><script type="module" src="/app.js"></script>';

interface BrowserOptions {
  readonly entry: string;
  readonly assets: ReadonlyMap<string, URL>;
  readonly fsWorker: string;
  readonly preview1Worker: string;
  readonly engine: FamilyBrowser;
  readonly workload?: boolean;
}

async function focusControl(page: Page) {
  await page.waitForSelector('body[data-blocked="true"], body[data-done="true"]', {
    state: "attached",
    timeout: 60_000,
  });
  if (await page.locator("body").getAttribute("data-done")) return null;
  const before = await page.evaluate(() => document.visibilityState);
  const peer = await page.context().newPage();
  try {
    await peer.bringToFront();
    const background = await page.evaluate(() => document.visibilityState);
    await page.bringToFront();
    const resumed = await page.evaluate(() => {
      document.body.dataset.resumed = "true";
      return document.visibilityState;
    });
    return { before, background, resumed };
  } finally {
    await peer.close();
  }
}

async function runPage(page: Page, origin: string, workload: boolean) {
  const errors: string[] = [];
  const workers = { created: 0, closed: 0, fs: 0, preview1: 0 };
  page.on("worker", (worker) => {
    workers.created++;
    if (worker.url().endsWith("/fs-worker.js")) workers.fs++;
    if (worker.url().endsWith("/preview1-worker.js")) workers.preview1++;
    worker.on("close", () => workers.closed++);
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const cdp =
    workload && page.context().browser()?.browserType().name() === "chromium"
      ? await page.context().newCDPSession(page)
      : undefined;
  const heapBefore = cdp && (await cdp.send("Runtime.getHeapUsage"));
  await navigateTestPage(page, origin, { timeout: 30_000 });
  const focus = workload ? await focusControl(page) : null;
  await page.waitForSelector('body[data-done="true"]', { timeout: 90_000 });
  const result: unknown = JSON.parse(await page.locator("body").innerText());
  assert.ok(
    result && typeof result === "object" && "ok" in result && result.ok === true,
    JSON.stringify(result),
  );
  const disposed = await page.locator("body").getAttribute("data-disposed");
  assert.equal(disposed, "true");
  assert.deepEqual(errors, []);
  if (!workload) return { result, disposed, errors };
  const heapAfter = cdp && (await cdp.send("Runtime.getHeapUsage"));
  await cdp?.detach();
  assert.deepEqual(workers, { created: 14, closed: 14, fs: 2, preview1: 12 });
  return { result, disposed, workers, focus, heapBefore, heapAfter };
}

export async function runFamilyBrowser(options: BrowserOptions) {
  const lifecycle = new BrowserRunnerLifecycle();
  try {
    await lifecycle.init();
    const output = await lifecycle.directory(lifecycle.scratch, "bundle-");
    const entrypoints = [options.entry, options.fsWorker, options.preview1Worker];
    const [app, fsWorker, preview1Worker] = await Promise.all(
      entrypoints.map(async (entry) => {
        const bundle = await Bun.build({ entrypoints: [entry], target: "browser", outdir: output });
        assert.ok(bundle.success, String(bundle.logs));
        const js = bundle.outputs.find((artifact) => artifact.kind === "entry-point");
        assert.ok(js, "No bundled entry for " + entry);
        return js;
      }),
    );
    assert.ok(app && fsWorker && preview1Worker);
    const routes: Record<string, Blob | string> = {
      "/": shell,
      "/app.js": app,
      "/fs-worker.js": fsWorker,
      "/preview1-worker.js": preview1Worker,
    };
    for (const [name, path] of options.assets)
      routes["/dist/" + name] = Bun.file(path, { type: "application/wasm" });

    const origin = lifecycle.serve(routes);
    const browser = await lifecycle.launch(options.engine);
    const info = {
      engine: options.engine,
      version: browser.version(),
      headless: true,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      playwright: playwright.version,
      browserBuild: engines[options.engine]
        .executablePath()
        .split(sep)
        .find((part) => part.startsWith(options.engine + "-")),
      bun: Bun.version,
      headers: { coop: "same-origin", coep: "require-corp", cacheControl: "no-store" },
    };
    if (!options.workload)
      return { ...info, ...(await runPage(await browser.newPage(), origin, false)) };
    const samples = [];
    for (let index = 0; index < 3; index++) {
      const context = await browser.newContext();
      try {
        samples.push(await runPage(await context.newPage(), origin, true));
      } finally {
        await context.close();
      }
    }
    return { ...info, samples };
  } finally {
    await lifecycle.close();
  }
}

export async function runPackedWorkload(consumer: string, entry: string, engine: FamilyBrowser) {
  const installed = (await realpath(resolve(consumer, "node_modules"))) + sep;
  async function installedPath(specifier: string) {
    const path = await realpath(Bun.resolveSync(specifier, consumer));
    assert.ok(path.startsWith(installed), "Consumer escaped its tarballs: " + specifier);
    return path;
  }
  const paths = await Promise.all([
    installedPath("@waffle-os/runtime/browser/fs-worker"),
    installedPath("@waffle-os/runtime/browser/preview1-worker"),
    installedPath("@waffle-os/coreutils"),
  ]);
  const [fsWorker, preview1Worker, coreutils] = paths;
  assert.ok(fsWorker && preview1Worker && coreutils);
  const assets = new Map<string, URL>();
  const guests = [];
  for (const name of ["cat", "sha256sum"]) {
    const wasm = await realpath(resolve(coreutils, "../../dist", name + ".wasm"));
    assert.ok(wasm.startsWith(installed), "Guest escaped its tarball: " + name);
    const bytes = new Uint8Array(await Bun.file(wasm).arrayBuffer());
    const module = await WebAssembly.compile(bytes);
    const derivation: unknown = await Bun.file(
      resolve(wasm, "../" + name + "-program.json"),
    ).json();
    const identity = programBytesIdentity(bytes);
    assert.ok(derivation && typeof derivation === "object" && "output" in derivation);
    assert.deepEqual(derivation.output, identity);
    guests.push({
      name,
      ...identity,
      imports: WebAssembly.Module.imports(module),
      memory: parseModuleMemory(bytes),
      derivation,
    });
    assets.set(name + ".wasm", pathToFileURL(wasm));
  }
  const result = await runFamilyBrowser({
    entry,
    assets,
    fsWorker,
    preview1Worker,
    engine,
    workload: true,
  });
  return { guests, ...result };
}

export function familyBrowser(name: string): FamilyBrowser {
  assert.ok(
    name === "chromium" || name === "firefox" || name === "webkit",
    "Unknown browser " + name,
  );
  return name;
}
