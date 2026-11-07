import { runAsyncSuite, type AsyncCommand } from "./gpu-async-command.js";
export { requireCompiledAsyncResult, requireCompiledAsyncNegative, requireCompiledAsyncRevocation } from "./gpu-async-command.js";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { verifiedGpuAsyncFixture } from "../scripts/build-gpu-fixture.js";
import { browserBundle } from "./browser-runner-lifecycle.js";
import { navigateTestPage } from "./browser-navigation.js";
import {
  GpuQualificationLifecycle,
  qualificationEngine,
  qualificationRoutes,
  requireWorkerAdapter,
} from "./gpu-browser-qualification.js";
import { qualificationRecord } from "./fixtures/gpu/qualification-contract.js";

function command(page: Page): AsyncCommand {
  return {
    invoke: (name, args) => page.evaluate(async ({ name, args }) => {
      const path = "/async-page.js";
      const module = await import(path);
      return module[name](...args);
    }, { name, args }),
    sleep: (ms) => page.waitForTimeout(ms),
  };
}
async function capabilities(page: Page) {
  return page.evaluate(async () => {
    const path = "/qualification-page.js";
    const module: typeof import("./fixtures/gpu/qualification-page.js") = await import(path);
    try {
      await module.openQualification();
      return await module.qualificationCommand({ kind: "capabilities" });
    } finally {
      module.closeQualification();
    }
  });
}
async function asyncRoutes(wasm: Uint8Array<ArrayBuffer>) {
  const routes = await qualificationRoutes();
  for (const [route, source] of [
    ["/async-page.js", "./fixtures/gpu/async-page.ts"],
    ["/gpu-guest.js", "./fixtures/gpu/integration-guest.ts"],
    ["/gpu/service-worker.ts", "./fixtures/gpu/integration-service-worker.ts"],
    ["/fs-worker.js", "../browser/fs-worker.ts"],
  ]) {
    if (!route || !source) throw new Error("Invalid async route");
    routes[route] = await browserBundle(new URL(source, import.meta.url).pathname);
  }
  routes["/async.wasm"] = new Blob([wasm], { type: "application/wasm" });
  return routes;
}
async function runEngine(
  runner: GpuQualificationLifecycle,
  requested: string,
  url: string,
  artifactBytes: number,
) {
  const engine = qualificationEngine(requested),
    browser = await runner.launch(engine);
  const context = await browser.newContext(),
    page = await context.newPage();
  try {
    await navigateTestPage(page, url);
    const observed = qualificationRecord(await capabilities(page));
    const available = requireWorkerAdapter(engine, observed),
      adapter = qualificationRecord(observed.adapter);
    if (engine === "chromium" && adapter.architecture !== "swiftshader")
      throw new Error(`Wrong Chromium adapter: ${JSON.stringify(adapter)}`);
    console.log(
      JSON.stringify({
        engine,
        version: browser.version(),
        adapter,
        stage: "compiled-async-admitted",
        artifactBytes,
      }),
    );
    const result = available
      ? await runAsyncSuite(command(page), adapter)
      : { status: "unsupported", compiledGuest: false };
    console.log(JSON.stringify({ engine, version: browser.version(), adapter, ...result }));
  } finally {
    await context.close();
    await runner.closeBrowser(browser);
  }
}
export async function runCompiledAsync(engines: readonly string[]): Promise<void> {
  const directory = process.env.GPU_FIXTURE_DIR;
  if (!directory) throw new Error("Set GPU_FIXTURE_DIR to the once-built producer output");
  const wasm = verifiedGpuAsyncFixture(resolve(directory));
  const runner = new GpuQualificationLifecycle();
  try {
    await runner.init(process.env.GPU_SCRATCH_ROOT ?? "/work/tmp");
    const url = runner.serve(await asyncRoutes(wasm));
    for (const requested of engines) await runEngine(runner, requested, url, wasm.byteLength);
  } finally {
    await runner.close();
  }
}
if (import.meta.main)
  await runCompiledAsync(process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"]);
