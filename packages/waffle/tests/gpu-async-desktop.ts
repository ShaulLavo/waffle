import { asyncFixture, asyncRoutes } from "./gpu-async-assets.js";
import { runAsyncSuite, admitAsync, type AsyncCommand } from "./gpu-async-command.js";
import type { Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { GpuQualificationLifecycle, qualificationEngine } from "./gpu-browser-qualification.js";

function command(page: Page): AsyncCommand {
  return {
    invoke: (name, args) =>
      page.evaluate(
        async ({ name, args }) => {
          const path = "/async-page.js";
          const module = await import(path);
          return module[name](...args);
        },
        { name, args },
      ),
    sleep: (ms) => page.waitForTimeout(ms),
  };
}
async function capabilities(page: Page) {
  return page.evaluate(async () => {
    const path = "/gpu-async-operations.js";
    const module: typeof import("./page-runner/gpu-async-operations.js") = await import(path);
    return module.gpuAsyncCapabilities();
  });
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
    const qualification = await capabilities(page);
    const { available, adapter } = admitAsync(engine, qualification);
    console.log(
      JSON.stringify({
        engine,
        version: browser.version(),
        adapter,
        stage: "compiled-async-admitted",
        artifactBytes,
        qualification,
      }),
    );
    const result = available
      ? await runAsyncSuite(command(page), adapter)
      : { status: "unsupported", compiledGuest: false };
    console.log(
      JSON.stringify({ engine, version: browser.version(), adapter, qualification, ...result }),
    );
  } finally {
    await context.close();
    await runner.closeBrowser(browser);
  }
}
export async function runCompiledAsync(
  engines: readonly string[],
  startedAt: number,
): Promise<void> {
  const remaining = 600_000 - (performance.now() - startedAt);
  if (remaining <= 0) throw new Error("GPU async absolute command deadline");
  const runner = new GpuQualificationLifecycle(remaining);
  try {
    const wasm = asyncFixture();
    await runner.init(process.env.GPU_SCRATCH_ROOT ?? "/work/tmp");
    const url = runner.serve(await asyncRoutes(wasm));
    for (const requested of engines) await runEngine(runner, requested, url, wasm.byteLength);
  } finally {
    await runner.close();
  }
}
