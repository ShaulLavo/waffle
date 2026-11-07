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

type AsyncPage = typeof import("./fixtures/gpu/async-page.js");
async function invoke<K extends keyof AsyncPage>(
  page: Page,
  name: K,
  args: Parameters<AsyncPage[K]>,
): Promise<Awaited<ReturnType<AsyncPage[K]>>> {
  return page.evaluate(
    async ({ name, args }) => {
      const path = "/async-page.js";
      const module = await import(path);
      return module[name](...args);
    },
    { name, args },
  );
}
async function marker(page: Page, text: string, slot = 0, failure = false) {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    const observed = await invoke(page, "drainAsync", [slot]);
    last = observed.text;
    if (observed.errors.length)
      throw new Error(`Async host errors: ${JSON.stringify(observed.errors)}`);
    if (!failure && last.includes("GPU_ASYNC_FAIL"))
      throw new Error(`C assertion failed before ${text}: ${last}`);
    if (last.includes(text)) return observed;
    await page.waitForTimeout(20);
  }
  throw new Error(`C marker deadline for ${text}: ${last}`);
}
export function requireCompiledAsyncResult(result: unknown): void {
  const value = qualificationRecord(result),
    exit = qualificationRecord(value.exit);
  if (
    exit.kind !== "exited" ||
    exit.code !== 0 ||
    typeof value.text !== "string" ||
    !Array.isArray(value.errors) ||
    value.errors.length
  )
    throw new Error(`Compiled async guest failed: ${JSON.stringify(value)}`);
  for (const expected of [
    "GPU_ASYNC_NEGOTIATED granted=checked excessive=failed",
    "GPU_ASYNC_READBACK creation=exact zeros=preserved usages=unchanged",
    "GPU_ASYNC_REMAP initial=preserved partial=checked empty=consumed",
    "GPU_ASYNC_SCOPES mapped=validation invalid=validation dependent=validation recovered=yes",
    "GPU_ASYNC_COMPILATION native=error utf8=checked statuses=checked",
    "GPU_ASYNC_LOSS device=3 reason=2 message=",
    "GPU_ASYNC_ISOLATION destroyed=unmapped second-device=progress last-release=invalidated",
    "GPU_ASYNC_OK compiled=C runtime=blocking maps=exact scopes=native payload=once loss=explicit",
  ])
    if (!value.text.includes(expected))
      throw new Error(`Missing compiled result marker: ${expected}`);
  if (value.text.includes("GPU_ASYNC_FAIL"))
    throw new Error("A failed C assertion also claimed success");
}
async function complete(page: Page, slot = 1) {
  await invoke(page, "launchAsync", [[], slot]);
  await marker(page, "GPU_ASYNC_OK", slot);
  const result = await invoke(page, "finishAsync", [slot]);
  requireCompiledAsyncResult(result);
  return result;
}
async function lifecycle(page: Page, stage: string, action: "kill" | "revoke") {
  await invoke(page, "launchAsync", [[`--pause-${stage}`], 0]);
  await marker(page, `GPU_ASYNC_PAUSED stage=${stage}`);
  await complete(page);
  if (action === "revoke") {
    await invoke(page, "revokeAsync", [0]);
    await invoke(page, "resumeAsync", [0]);
    await marker(page, "GPU_ASYNC_FAIL", 0, true);
  }
  const stopped = await invoke(page, "finishAsync", [0, action === "kill"]);
  if (action === "kill" && (stopped.exit.kind !== "signaled" || stopped.exit.code !== 9))
    throw new Error("Compiled async kill did not select SIGKILL");
  if (action === "revoke" && (stopped.exit.kind !== "exited" || stopped.exit.code !== 1))
    throw new Error("Revoked compiled async guest did not fail its import assertion");
  await complete(page);
  return { stage, action, status: "passed", compiledGuest: true };
}
async function negative(page: Page, flag: string) {
  await invoke(page, "launchAsync", [[flag], 0]);
  await marker(page, "GPU_ASYNC_FAIL", 0, true);
  const result = await invoke(page, "finishAsync", [0]);
  if (
    result.exit.kind !== "exited" ||
    result.exit.code !== 1 ||
    result.text.includes("GPU_ASYNC_OK")
  )
    throw new Error(`Negative compiled C control did not fail: ${flag}: ${JSON.stringify(result)}`);
  await complete(page);
  return {
    control: flag,
    status: "passed-negative-control",
    compiledGuest: true,
    text: result.text,
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
export async function runCompiledAsync(engines: readonly string[]): Promise<void> {
  const directory = process.env.GPU_FIXTURE_DIR;
  if (!directory) throw new Error("Set GPU_FIXTURE_DIR to the once-built producer output");
  const wasm = verifiedGpuAsyncFixture(resolve(directory));
  const runner = new GpuQualificationLifecycle();
  try {
    await runner.init(process.env.GPU_SCRATCH_ROOT ?? "/work/tmp");
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
    const url = runner.serve(routes);
    for (const requested of engines) {
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
        if (!available) {
          console.log(
            JSON.stringify({
              engine,
              version: browser.version(),
              adapter,
              status: "unsupported",
              compiledGuest: false,
            }),
          );
          continue;
        }
        await invoke(page, "openAsync", []);
        try {
          const normal = await complete(page);
          const negatives = [];
          for (const flag of [
            "--suppress-writes",
            "--corrupt-range",
            "--reuse-payload",
            "--malformed-map",
          ])
            negatives.push(await negative(page, flag));
          const lifetimes = [];
          for (const stage of ["map-pending", "payload-published", "work-pending"]) {
            lifetimes.push(await lifecycle(page, stage, "kill"));
            lifetimes.push(await lifecycle(page, stage, "revoke"));
          }
          console.log(
            JSON.stringify({
              engine,
              version: browser.version(),
              adapter,
              status: "passed",
              compiledGuest: true,
              normal,
              negatives,
              lifetimes,
            }),
          );
        } finally {
          await invoke(page, "closeAsync", []);
        }
      } finally {
        await context.close();
        await runner.closeBrowser(browser);
      }
    }
  } finally {
    await runner.close();
  }
}
if (import.meta.main)
  await runCompiledAsync(process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"]);
