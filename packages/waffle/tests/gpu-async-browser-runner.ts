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
  await invoke(page, "launchAsync", [
    action === "revoke" ? [`--pause-${stage}`, "--expect-revoke"] : [`--pause-${stage}`],
    0,
  ]);
  await marker(page, `GPU_ASYNC_PAUSED stage=${stage}`);
  await complete(page);
  if (action === "revoke") {
    await invoke(page, "revokeAsync", [0]);
    await invoke(page, "resumeAsync", [0]);
    await marker(page, `GPU_ASYNC_REVOKED stage=${stage}`, 0);
  }
  const stopped = await invoke(page, "finishAsync", [0, action === "kill"]);
  if (action === "kill" && (stopped.exit.kind !== "signaled" || stopped.exit.code !== 9))
    throw new Error("Compiled async kill did not select SIGKILL");
  if (stopped.errors.length) throw new Error("Lifecycle guest has host errors");
  if (action === "revoke") requireCompiledAsyncRevocation(stopped, stage);
  await complete(page);
  return {
    stage,
    action,
    status: "passed",
    compiledGuest: true,
    termination: { exit: stopped.exit, text: stopped.text, errors: stopped.errors },
  };
}
type NegativeControl =
  | "--suppress-writes"
  | "--corrupt-range"
  | "--reuse-payload"
  | "--malformed-map";
const negativeControls: readonly NegativeControl[] = [
  "--suppress-writes",
  "--corrupt-range",
  "--reuse-payload",
  "--malformed-map",
];
export function requireCompiledAsyncNegative(result: unknown, control: NegativeControl): void {
  const value = qualificationRecord(result),
    exit = qualificationRecord(value.exit);
  if (
    exit.kind !== "exited" ||
    exit.code !== 1 ||
    typeof value.text !== "string" ||
    value.text.includes("GPU_ASYNC_OK") ||
    !Array.isArray(value.errors) ||
    value.errors.length
  )
    throw new Error(`Invalid negative C result: ${control}`);
  const stage =
    control === "--suppress-writes"
      ? "exact-native-readback"
      : control === "--reuse-payload"
        ? "payload-once"
        : "completion-correlation";
  const lines = value.text.split(/\r?\n/);
  const failures = lines.filter((line) => line.startsWith("GPU_ASYNC_FAIL"));
  if (failures.length !== 1 || failures[0] !== `GPU_ASYNC_FAIL stage=${stage}`)
    throw new Error(`Wrong negative C assertion: ${control}`);
  const terminals = lines.filter((line) => line.startsWith("GPU_ASYNC_TERMINAL"));
  const protocol = control === "--corrupt-range" || control === "--malformed-map";
  if (
    protocol
      ? terminals.length !== 1 || terminals[0] !== "GPU_ASYNC_TERMINAL reason=2"
      : terminals.length !== 0
  )
    throw new Error(`Missing protocol terminal or unexpected terminal for ${control}`);
}
export function requireCompiledAsyncRevocation(result: unknown, stage: string): void {
  const value = qualificationRecord(result),
    exit = qualificationRecord(value.exit);
  if (
    !["map-pending", "payload-published", "work-pending"].includes(stage) ||
    exit.kind !== "exited" ||
    exit.code !== 0 ||
    typeof value.text !== "string" ||
    !Array.isArray(value.errors) ||
    value.errors.length ||
    value.text.includes("GPU_ASYNC_FAIL") ||
    value.text.includes("GPU_ASYNC_OK") ||
    value.text.includes("GPU_ASYNC_TERMINAL")
  )
    throw new Error("Invalid compiled revocation result");
  const lines = value.text.split(/\r?\n/);
  const paused = lines.filter((line) => line.startsWith("GPU_ASYNC_PAUSED"));
  const revoked = lines.filter((line) => line.startsWith("GPU_ASYNC_REVOKED"));
  const expected = new RegExp(
    `^GPU_ASYNC_REVOKED stage=${stage} errno=-64 repeated=2 append=-64 drained=(0|[1-9][0-9]*)$`,
  );
  const line = revoked[0];
  const match = revoked.length === 1 && line !== undefined ? expected.exec(line) : null;
  if (
    paused.length !== 1 ||
    paused[0] !== `GPU_ASYNC_PAUSED stage=${stage}` ||
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    Number(match[1]) > 64
  )
    throw new Error("Missing exact compiled revocation proof");
}
async function negative(page: Page, flag: NegativeControl) {
  await invoke(page, "launchAsync", [[flag], 0]);
  await marker(page, "GPU_ASYNC_FAIL", 0, true);
  const result = await invoke(page, "finishAsync", [0]);
  requireCompiledAsyncNegative(result, flag);
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
function assertAdapterIdentity(text: string, adapter: Record<string, unknown>): void {
  for (const field of ["vendor", "architecture"]) {
    const identity = adapter[field];
    if (typeof identity === "string" && !text.includes(`${field}=${identity}`))
      throw new Error(`Compiled adapter identity differs for ${field}`);
  }
}
async function asyncSuite(page: Page, adapter: Record<string, unknown>) {
  await invoke(page, "openAsync", []);
  try {
    const normal = await complete(page);
    assertAdapterIdentity(normal.text, adapter);
    const negatives = [],
      lifetimes = [];
    for (const flag of negativeControls) negatives.push(await negative(page, flag));
    for (const stage of ["map-pending", "payload-published", "work-pending"]) {
      lifetimes.push(await lifecycle(page, stage, "kill"));
      lifetimes.push(await lifecycle(page, stage, "revoke"));
    }
    const retired = qualificationRecord(await invoke(page, "asyncServiceSnapshot", []));
    if (retired.connections !== 0 || retired.devicesLive !== 0 || retired.heapBytes !== 0)
      throw new Error(`Compiled async service retained resources: ${JSON.stringify(retired)}`);
    return { status: "passed", compiledGuest: true, normal, negatives, lifetimes, retired };
  } finally {
    await invoke(page, "closeAsync", []);
  }
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
      ? await asyncSuite(page, adapter)
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
