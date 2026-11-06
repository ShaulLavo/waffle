import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BrowserRunnerLifecycle, browserBundle } from "../tests/browser-runner-lifecycle.js";
import {
  GpuQualificationLifecycle,
  qualificationEngine,
  qualificationPort,
} from "../tests/gpu-browser-qualification.js";
import { qualificationRecord } from "../tests/fixtures/gpu/qualification-contract.js";
import {
  defaultMeasurementOptions,
  measurementOptions,
  measure,
  type MeasurementOptions,
} from "../tests/fixtures/gpu/measurement-contract.js";
import { verifiedGpuFixture } from "../scripts/build-gpu-fixture.js";

type Controller = {
  call: (module: "page" | "runtime", method: string, args?: unknown[]) => Promise<unknown>;
  screenshot: () => Promise<string>;
};
const fixtures = new URL("../tests/fixtures/gpu/", import.meta.url);
const runtimeMethods = [
  "startMeasuredTriangle",
  "stopMeasuredTriangle",
  "pressureMeasuredTriangle",
  "closeMeasuredTriangle",
  "observeTriangleScreenshot",
];
const pageMethods = ["runGpuMeasurement", "measurementResources"];
/** The same prepared routes work in Playwright and actual desktop Safari. */
export async function gpuMeasurementRoutes(
  options: MeasurementOptions,
  fixtureDirectory?: string,
): Promise<Record<string, Blob | string>> {
  const routes: Record<string, Blob | string> = {
    "/": "<!doctype html><title>GPU measurements, not G0.3 qualification</title>",
    "/measurement-page.js": await browserBundle(new URL("measurement-page.ts", fixtures).pathname),
    "/measurement-worker.js": await browserBundle(
      new URL("measurement-worker.ts", fixtures).pathname,
    ),
    "/measurement-options.json": JSON.stringify(options),
  };
  if (!options.runtimeFixture) return routes;
  if (!fixtureDirectory)
    throw new Error(
      "Runtime measurement requires GPU_FIXTURE_DIR with the existing compiled triangle",
    );
  routes["/triangle.wasm"] = new Blob([verifiedGpuFixture(resolve(fixtureDirectory))], {
    type: "application/wasm",
  });
  routes["/measurement-runtime.js"] = await browserBundle(
    new URL("measurement-runtime.ts", fixtures).pathname,
  );
  routes["/gpu-guest.js"] = await browserBundle(new URL("integration-guest.ts", fixtures).pathname);
  routes["/gpu/service-worker.ts"] = await browserBundle(
    new URL("integration-service-worker.ts", fixtures).pathname,
  );
  routes["/fs-worker.js"] = await browserBundle(
    new URL("../browser/fs-worker.ts", import.meta.url).pathname,
  );
  return routes;
}
function nativeDevice(report: Record<string, unknown>): boolean {
  const native = qualificationRecord(report.native);
  if (native.kind !== "measured") return false;
  return qualificationRecord(qualificationRecord(native.value).device).kind === "measured";
}
async function runtimeMeasurements(controller: Controller, options: MeasurementOptions) {
  try {
    const startup = await controller.call("runtime", "startMeasuredTriangle", [options.timeoutMs]);
    // The marker precedes a browser rendering update. Pixels, not the marker, prove display.
    await Bun.sleep(100);
    const initialPixels = await controller.call("runtime", "observeTriangleScreenshot", [
      await controller.screenshot(),
    ]);
    const stoppedAt = performance.now();
    const stopped = await controller.call("runtime", "stopMeasuredTriangle");
    const retention = [];
    for (const targetMs of [500, 3000, 10_000]) {
      await Bun.sleep(Math.max(0, targetMs - (performance.now() - stoppedAt)));
      const pressure = await controller.call("runtime", "pressureMeasuredTriangle");
      const pixels = await controller.call("runtime", "observeTriangleScreenshot", [
        await controller.screenshot(),
      ]);
      retention.push({ targetMs, elapsedMs: performance.now() - stoppedAt, pixels, pressure });
    }
    return {
      startup,
      initialPixels,
      stopped,
      retention,
      scope:
        "Existing compiled C triangle, real runtime startup and bitmap retention after SIGKILL. No high-draw fairness claim.",
    };
  } finally {
    await controller.call("runtime", "closeMeasuredTriangle");
  }
}
async function collect(controller: Controller, options: MeasurementOptions): Promise<Record<string, unknown>> {
  const report = qualificationRecord(await controller.call("page", "runGpuMeasurement", [options]));
  const runtime =
    options.runtimeFixture && nativeDevice(report)
      ? await measure(() => runtimeMeasurements(controller, options))
      : {
          kind: "unmet",
          reason: options.runtimeFixture
            ? "No working native worker device; compiled triangle not run"
            : "Pass --runtime with GPU_FIXTURE_DIR to reuse the compiled triangle",
        };
  const cleanup = qualificationRecord(await controller.call("page", "measurementResources"));
  if (cleanup.workersLive !== 0) throw new Error("Measurement workers remain live");
  return { ...report, runtime, cleanup };
}
/** Failed probes stay failures even when other measurements succeed. */
export function measurementFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ("kind" in value && value.kind === "failed") return true;
  return Object.entries(value).some(([key, item]) => {
    // These deliberate failures are executable negative controls, not successful measurements.
    if (key === "uploadControl" || key === "imageControl") return false;
    return measurementFailed(item);
  });
}
/** Execute real browser controls; --software is explicit and never hardware qualification. */
export async function runGpuMeasurementBrowser(
  runner: BrowserRunnerLifecycle,
  engine: "chromium" | "firefox" | "webkit",
  url: string,
  options: MeasurementOptions,
) {
  const browser = await runner.launch(engine);
  const page = await browser.newPage({
    viewport: { width: 400, height: 300 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url);
    const controller: Controller = {
      call: (module, method, args = []) =>
        page.evaluate(
          async ({ module, method, args }) => {
            const path = `/measurement-${module}.js`;
            const api = await import(path);
            return api[method](...args);
          },
          { module, method, args },
        ),
      screenshot: async () => (await page.screenshot()).toString("base64"),
    };
    const report = await collect(controller, options);
    if (errors.length) throw new Error(`Measurement page errors: ${errors.join("; ")}`);
    return { engine, browserVersion: browser.version(), report };
  } finally {
    await page.close();
    await runner.closeBrowser(browser);
  }
}
async function webdriver(
  driver: string,
  path: string,
  body?: unknown,
  method = "POST",
): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(120_000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${driver}${path}`, init);
  const payload = qualificationRecord(await response.json());
  if (!response.ok) throw new Error(`WebDriver ${path}: ${JSON.stringify(payload)}`);
  return payload.value;
}
/** No iOS/simulator session can be reported as desktop Safari hardware evidence. */
export function desktopSafariCapabilities(value: unknown) {
  const capabilities = qualificationRecord(value);
  if (
    String(capabilities.browserName).toLowerCase() !== "safari" ||
    !/mac/i.test(String(capabilities.platformName)) ||
    capabilities["safari:useSimulator"] === true
  )
    throw new Error("Expected actual desktop macOS Safari WebDriver capabilities");
  return capabilities;
}
async function runSafari(driver: string, url: string, options: MeasurementOptions) {
  const session = qualificationRecord(
    await webdriver(driver, "/session", {
      capabilities: { alwaysMatch: { browserName: "safari", platformName: "mac" } },
    }),
  );
  if (typeof session.sessionId !== "string" || !session.sessionId)
    throw new Error("WebDriver session ID missing");
  const path = `/session/${encodeURIComponent(session.sessionId)}`;
  try {
    const capabilities = desktopSafariCapabilities(session.capabilities);
    await webdriver(driver, `${path}/timeouts`, { script: 120_000 });
    await webdriver(driver, `${path}/url`, { url });
    const controller: Controller = {
      call: async (module, method, args = []) => {
        if (!(module === "page" ? pageMethods : runtimeMethods).includes(method))
          throw new Error("Unknown measurement method");
        const value = qualificationRecord(
          await webdriver(driver, `${path}/execute/async`, {
            script: `const done = arguments[arguments.length - 1]; import('/measurement-${module}.js').then(api => api[${JSON.stringify(method)}](...arguments[0])).then(value => done({value}), error => done({error: String(error)}));`,
            args: [args],
          }),
        );
        if ("error" in value) throw new Error(String(value.error));
        return value.value;
      },
      screenshot: async () => {
        const image = await webdriver(driver, `${path}/screenshot`, undefined, "GET");
        if (typeof image !== "string") throw new Error("WebDriver screenshot missing");
        return image;
      },
    };
    return { engine: "desktop-safari", capabilities, report: await collect(controller, options) };
  } finally {
    await webdriver(driver, path, undefined, "DELETE");
  }
}
/** Prepare a dependency-free Safari packet. BrowserRunnerLifecycle still owns server/scratch/signals.
 * The portable driver cannot launch Playwright; those unused engine imports are explicit stubs. */
export async function prepareGpuMeasurement(
  directory: string,
  options: MeasurementOptions,
  fixtureDirectory?: string,
) {
  const routes = await gpuMeasurementRoutes(options, fixtureDirectory);
  await mkdir(directory, { recursive: true });
  const manifest: Record<string, string> = {};
  for (const [path, body] of Object.entries(routes)) {
    const filename = path === "/" ? "index.html" : path.slice(1);
    await Bun.write(resolve(directory, filename), body);
    manifest[path] = filename;
  }
  await Bun.write(resolve(directory, "routes.json"), JSON.stringify(manifest));
  const bundle = await Bun.build({
    entrypoints: [import.meta.path],
    target: "bun",
    plugins: [
      {
        name: "safari-only",
        setup(build) {
          build.onResolve({ filter: /^playwright$/ }, () => ({
            path: "playwright",
            namespace: "safari-only",
          }));
          build.onLoad({ filter: /.*/, namespace: "safari-only" }, () => ({
            contents:
              'const engine = { launch() { throw new Error("Prepared packet is Safari-only; use the source runner for Playwright"); } }; export const chromium = engine, firefox = engine, webkit = engine;',
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!bundle.success || !bundle.outputs[0])
    throw new AggregateError(bundle.logs, "Measurement driver build failed");
  await Bun.write(resolve(directory, "runner.mjs"), bundle.outputs[0]);
}
async function packetRoutes(directory: string): Promise<Record<string, Blob | string>> {
  const manifest = qualificationRecord(
    JSON.parse(await readFile(resolve(directory, "routes.json"), "utf8")),
  );
  const routes: Record<string, Blob | string> = {};
  for (const [path, filename] of Object.entries(manifest)) {
    if (typeof filename !== "string" || filename.includes("..") || filename.startsWith("/"))
      throw new Error("Invalid packet route");
    routes[path] = Bun.file(resolve(directory, filename));
  }
  return routes;
}
function argument(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Expected ${flag} value`);
  return value;
}
async function main() {
  const args = process.argv.slice(2);
  const prepare = argument(args, "--prepare"),
    packet = argument(args, "--packet"),
    safari = argument(args, "--safari");
  const options = measurementOptions({
    ...defaultMeasurementOptions,
    trials: Number(argument(args, "--trials") ?? 5),
    extraWorkers: Number(argument(args, "--extra-workers") ?? 2),
    runtimeFixture: args.includes("--runtime"),
  });
  if (prepare) {
    await prepareGpuMeasurement(resolve(prepare), options, process.env.GPU_FIXTURE_DIR);
    return;
  }
  if (packet && !safari)
    throw new Error("Prepared packet requires --safari with a task-owned running SafariDriver URL");
  const software = args.includes("--software");
  if (safari && software) throw new Error("Safari cannot use --software SwiftShader mode");
  const runner = software
    ? new GpuQualificationLifecycle(300_000)
    : new BrowserRunnerLifecycle(300_000);
  const reports: unknown[] = [];
  let cleanup = "completed";
  try {
    await runner.init(process.env.GPU_MEASURE_SCRATCH_ROOT);
    const routes = packet
      ? await packetRoutes(resolve(packet))
      : await gpuMeasurementRoutes(options, process.env.GPU_FIXTURE_DIR);
    const activeOptions = packet
      ? measurementOptions(
          JSON.parse(String(await new Response(routes["/measurement-options.json"]).text())),
        )
      : options;
    const url = runner.serve(routes, qualificationPort(process.env.GPU_MEASURE_PORT));
    console.log(
      JSON.stringify({
        resources: "gpu-measure",
        scratch: runner.scratch,
        url,
        created: [
          "loopback server",
          "owned browser session",
          "measurement workers/devices",
          "short browser profiles",
        ],
        softwareDiagnostic: software,
        host: { platform: process.platform, arch: process.arch },
        qualification: false,
      }),
    );
    if (safari) reports.push(await runSafari(safari, url, activeOptions));
    else {
      const engine = qualificationEngine(argument(args, "--engine") ?? "chromium");
      reports.push(await runGpuMeasurementBrowser(runner, engine, url, activeOptions));
    }
  } catch (error) {
    reports.push({ kind: "failed", reason: String(error) });
  } finally {
    try {
      await runner.close();
    } catch (error) {
      cleanup = "failed";
      reports.push({
        kind: "failed",
        reason: `Cleanup: ${String(error)}`,
        retainedScratch: runner.scratch,
      });
    }
    const result = {
      reports,
      cleanup,
      softwareDiagnostic: software,
      host: { platform: process.platform, arch: process.arch },
      qualification: false,
    };
    if (process.env.GPU_MEASURE_REPORT)
      await Bun.write(resolve(process.env.GPU_MEASURE_REPORT), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (measurementFailed(result)) process.exitCode = 1;
  }
}
if (import.meta.main) await main();
