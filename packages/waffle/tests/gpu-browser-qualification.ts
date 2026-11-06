import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { BrowserRunnerLifecycle, browserBundle, engines } from "./browser-runner-lifecycle.js";
import {
  stopBrowserResource,
  type BrowserResourceOwner,
} from "./process-recycling-browser-runner-control.js";
import {
  canvasSize,
  pressurePolicy,
  qualificationRecord,
  retentionSampleMs,
  type QualificationRequest,
} from "./fixtures/gpu/qualification-contract.js";

type Engine = keyof typeof engines;
type PageRequest = Exclude<QualificationRequest, { kind: "attach" }>;
type Pixels = { center: number[]; corner: number[] };
const swiftShaderArgs = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
  "--use-webgpu-adapter=swiftshader",
  "--use-angle=swiftshader",
  "--disable-vulkan-surface",
];

/** Reuses the shared runner's server, scratch, signal and deadline cleanup. Only the
 * flagged Chromium launch needs an additional owner because launch() takes no options. */
export class GpuQualificationLifecycle extends BrowserRunnerLifecycle {
  private softwareBrowsers = new Set<BrowserResourceOwner>();
  private gpuCleaning?: Promise<void>;
  override async launch(engine: Engine): Promise<Browser> {
    if (engine !== "chromium") return super.launch(engine);
    if (this.gpuCleaning || !this.scratch) throw new Error("Qualification runner is not live");
    const creation = engines.chromium.launch({
      headless: true,
      args: swiftShaderArgs,
      downloadsPath: this.scratch,
      tracesDir: this.scratch,
    });
    const owner = { creation, stopped: false };
    this.softwareBrowsers.add(owner);
    const browser = await creation;
    if (this.gpuCleaning) throw new Error("Qualification runner stopped during launch");
    return browser;
  }
  override close(): Promise<void> {
    return (this.gpuCleaning ??= this.closeGpu());
  }
  override async closeBrowser(browser: Browser): Promise<void> {
    for (const owner of this.softwareBrowsers) {
      if ((await owner.creation.catch(() => undefined)) !== browser) continue;
      await stopBrowserResource(this.softwareBrowsers, owner);
      return;
    }
    await super.closeBrowser(browser);
  }
  override async removeDirectory(path: string): Promise<void> {
    if (this.softwareBrowsers.size)
      throw new Error(`Retain scratch for unclosed GPU browser: ${path}`);
    await super.removeDirectory(path);
  }
  private async closeGpu(): Promise<void> {
    const failures: unknown[] = [];
    for (const owner of this.softwareBrowsers) {
      try {
        await stopBrowserResource(this.softwareBrowsers, owner);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await super.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "GPU browser cleanup failed");
  }
}

export function qualificationEngine(value: string): Engine {
  if (value === "chromium" || value === "firefox" || value === "webkit") return value;
  throw new Error(`Unknown qualification engine: ${value}`);
}

export function qualificationPort(value = "0"): number {
  if (!/^\d+$/.test(value)) throw new Error("GPU_QUALIFICATION_PORT must be an integer");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535)
    throw new Error("GPU_QUALIFICATION_PORT out of range");
  return port;
}

export function assertFramePixels(pixels: Pixels): void {
  const near = (actual: number[], expected: number[]) =>
    actual.length === 4 && actual.every((byte, index) => Math.abs(byte - expected[index]!) <= 8);
  if (!near(pixels.center, [255, 0, 0, 255]) || !near(pixels.corner, [0, 0, 255, 255]))
    throw new Error(`Frame pixel assertion failed: ${JSON.stringify(pixels)}`);
}

export function assertBlankPixels(pixels: Pixels): void {
  rejectSuppressedFrame(pixels);
  if (
    pixels.center.length !== 4 ||
    pixels.corner.length !== 4 ||
    pixels.center.concat(pixels.corner).some((byte) => byte !== 255)
  )
    throw new Error(`Expected cleared placeholder: ${JSON.stringify(pixels)}`);
}

function rejectSuppressedFrame(pixels: Pixels): void {
  try {
    assertFramePixels(pixels);
  } catch {
    return;
  }
  throw new Error("Suppressed-transfer negative control passed the frame pixel assertion");
}

export function requireWorkerAdapter(
  engine: Engine,
  capabilities: Record<string, unknown>,
): boolean {
  const adapter = qualificationRecord(capabilities.adapter);
  if (engine === "chromium" && adapter.kind !== "available")
    throw new Error(`Required SwiftShader worker adapter missing: ${JSON.stringify(capabilities)}`);
  if (
    adapter.kind !== "available" &&
    adapter.kind !== "missing-webgpu" &&
    adapter.kind !== "no-adapter"
  )
    throw new Error("Unknown worker adapter outcome");
  return adapter.kind === "available";
}

export async function qualificationRoutes(): Promise<Record<string, Blob | string>> {
  return {
    "/": "<!doctype html><title>Native GPU qualification, not guest acceptance</title>",
    "/qualification-page.js": await browserBundle(
      new URL("./fixtures/gpu/qualification-page.ts", import.meta.url).pathname,
    ),
    "/qualification-worker.js": await browserBundle(
      new URL("./fixtures/gpu/qualification-worker.ts", import.meta.url).pathname,
    ),
  };
}

async function open(page: Page): Promise<Record<string, unknown>> {
  const evidence = qualificationRecord(
    await page.evaluate(async () => {
      const path = "/qualification-page.js";
      const module: typeof import("./fixtures/gpu/qualification-page.js") = await import(path);
      return module.openQualification();
    }),
  );
  const response = qualificationRecord(evidence.response);
  if (
    evidence.sharedCanary !== 1 ||
    evidence.isolated !== true ||
    response.realm !== "dedicated-worker" ||
    response.hasDocument !== false ||
    response.bitmaprenderer !== true ||
    response.width !== canvasSize
  )
    throw new Error(`Worker/realm coverage control failed: ${JSON.stringify(evidence)}`);
  return evidence;
}

async function close(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const path = "/qualification-page.js";
    const module: typeof import("./fixtures/gpu/qualification-page.js") = await import(path);
    module.closeQualification();
  });
}

async function command(page: Page, request: PageRequest): Promise<Record<string, unknown>> {
  return qualificationRecord(
    await page.evaluate(async (message) => {
      const path = "/qualification-page.js";
      const module: typeof import("./fixtures/gpu/qualification-page.js") = await import(path);
      return module.qualificationCommand(message);
    }, request),
  );
}

async function pixels(page: Page): Promise<Pixels> {
  const image = await page.screenshot({
    clip: { x: 0, y: 0, width: canvasSize, height: canvasSize },
    animations: "disabled",
  });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Screenshot decoder unavailable");
    context.drawImage(image, 0, 0);
    return {
      center: Array.from(context.getImageData(32, 32, 1, 1).data),
      corner: Array.from(context.getImageData(2, 2, 1, 1).data),
    };
  }, image.toString("base64"));
}

async function bitmapNegative(page: Page) {
  await open(page);
  try {
    const reply = await command(page, { kind: "bitmap", suppressTransfer: true });
    await Bun.sleep(100);
    const observed = await pixels(page);
    assertBlankPixels(observed);
    return { reply, pixels: observed, rejectedByPixelAssertion: true };
  } finally {
    await close(page);
  }
}

async function retainedSamples(page: Page) {
  const samples = [];
  let pressureBursts = 0;
  for (const targetMs of retentionSampleMs) {
    let state = await command(page, { kind: "pressure" });
    while (typeof state.elapsedMs === "number" && state.elapsedMs < targetMs) {
      await Bun.sleep(Math.min(pressurePolicy.intervalMs, targetMs - state.elapsedMs));
      state = await command(page, { kind: "pressure" });
    }
    if (
      typeof state.elapsedMs !== "number" ||
      state.retainedCanvas !== true ||
      state.retainedContext !== true
    )
      throw new Error(`Retention owner control failed: ${JSON.stringify(state)}`);
    const observed = await pixels(page);
    assertFramePixels(observed);
    pressureBursts = Number(state.pressureBursts);
    samples.push({ targetMs, elapsedMs: state.elapsedMs, pixels: observed });
  }
  return { samples, pressureBurstsPerRealm: pressureBursts, pressurePolicy, forcedGc: false };
}

async function gpuFrames(page: Page) {
  await command(page, { kind: "dispose" });
  await close(page);
  await open(page);
  const negative = await command(page, { kind: "stable-frame", suppressTransfer: true });
  await Bun.sleep(100);
  const negativePixels = await pixels(page);
  assertBlankPixels(negativePixels);
  const positive = await command(page, { kind: "stable-frame", suppressTransfer: false });
  if (positive.deviceDestroyed !== true || positive.taskTurns !== 6)
    throw new Error("Stable-frame task/destroy control failed");
  await Bun.sleep(500);
  const observed = await pixels(page);
  assertFramePixels(observed);
  return {
    negative: { reply: negative, pixels: negativePixels, rejectedByPixelAssertion: true },
    positive,
    afterDeviceDestroyMs: 500,
    pixels: observed,
  };
}

/** Reuse with a page served by the future GPU runner. This does not instantiate
 * Waffle, replay a guest stream, or claim F1/F6 guest acceptance.
 * @public */
export async function qualifyGpuBrowser(
  page: Page,
  engine: Engine,
  options: { bitmapOnly?: boolean; record?: (stage: string, value: unknown) => void } = {},
) {
  const record = options.record ?? (() => {});
  const failures: string[] = [];
  const failedPage = (error: Error) => {
    failures.push(error.message);
  };
  page.on("pageerror", failedPage);
  try {
    const negative = await bitmapNegative(page);
    record("negative", negative);
    const realm = await open(page);
    record("realm", realm);
    const capabilities = options.bitmapOnly
      ? { adapter: { kind: "not-requested" }, reason: "F6x requires no WebGPU" }
      : await command(page, { kind: "capabilities" });
    record("capabilities", capabilities);
    const hasAdapter = options.bitmapOnly ? false : requireWorkerAdapter(engine, capabilities);
    const source = await command(page, { kind: "bitmap", suppressTransfer: false });
    // Prove this realm actually presents before spending fourteen seconds on retention.
    await Bun.sleep(100);
    const initialPixels = await pixels(page);
    assertFramePixels(initialPixels);
    record("initialPixels", initialPixels);
    const retention = await retainedSamples(page);
    record("retention", retention);
    const stableFrame = hasAdapter
      ? await gpuFrames(page)
      : {
          kind: options.bitmapOnly ? "not-requested" : "unsupported",
          reason: qualificationRecord(capabilities.adapter).kind,
        };
    record("stableFrame", stableFrame);
    const disposed = await command(page, { kind: "dispose" });
    await Bun.sleep(100);
    const clearedPixels = await pixels(page);
    assertBlankPixels(clearedPixels);
    if (failures.length) throw new Error(`Qualification page errors: ${failures.join("; ")}`);
    return {
      engine,
      browserVersion: page.context().browser()?.version(),
      qualificationOnly: true,
      bitmapOnly: options.bitmapOnly ?? false,
      realm,
      capabilities,
      negative,
      source,
      initialPixels,
      retention,
      stableFrame,
      disposed,
      clearedPixels,
    };
  } finally {
    page.off("pageerror", failedPage);
    await close(page);
  }
}

async function runEngine({
  runner,
  engine,
  url,
  bitmapOnly,
}: {
  runner: GpuQualificationLifecycle;
  engine: Engine;
  url: string;
  bitmapOnly: boolean;
}): Promise<unknown> {
  const browser = await runner.launch(engine);
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const evidence: Record<string, unknown> = {};
  try {
    await page.goto(url);
    const report = await qualifyGpuBrowser(page, engine, {
      bitmapOnly,
      record: (stage, value) => {
        evidence[stage] = value;
        console.log(JSON.stringify({ engine, stage }));
      },
    });
    console.log(JSON.stringify(report));
    return report;
  } catch (error) {
    const failure = {
      engine,
      browserVersion: browser.version(),
      failed: true,
      evidence,
      error: String(error),
    };
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
    return failure;
  } finally {
    await page.close();
    await runner.closeBrowser(browser);
  }
}

async function main() {
  const runner = new GpuQualificationLifecycle(180_000);
  const reports: unknown[] = [];
  try {
    const args = process.argv.slice(2);
    const bitmapOnly = args.includes("--bitmap-only");
    const requested = args.filter((arg) => arg !== "--bitmap-only");
    const names = (requested.length ? requested : ["chromium", "firefox", "webkit"]).map(
      qualificationEngine,
    );
    await runner.init(process.env.GPU_QUALIFICATION_SCRATCH_ROOT ?? tmpdir());
    const url = runner.serve(
      await qualificationRoutes(),
      qualificationPort(process.env.GPU_QUALIFICATION_PORT),
    );
    console.log(
      JSON.stringify({
        resources: "gpu-qualification",
        scratch: runner.scratch,
        url,
        names,
        chromiumArgs: swiftShaderArgs,
        playwright: (await import("playwright/package.json")).default.version,
      }),
    );
    for (const engine of names) reports.push(await runEngine({ runner, engine, url, bitmapOnly }));
  } catch (error) {
    reports.push({ failed: true, error: String(error) });
    process.exitCode = 1;
    console.error(error);
  } finally {
    let cleanup: "completed" | "failed" = "completed";
    try {
      await runner.close();
    } catch (error) {
      cleanup = "failed";
      reports.push({ cleanupFailed: true, error: String(error) });
      process.exitCode = 1;
    }
    if (process.env.GPU_QUALIFICATION_REPORT)
      await Bun.write(
        resolve(process.env.GPU_QUALIFICATION_REPORT),
        JSON.stringify({ reports, cleanup }, null, 2),
      );
    console.log(
      JSON.stringify({
        cleanup: "gpu-qualification",
        stopped: cleanup === "completed",
        scratchRemoved: runner.scratch,
      }),
    );
  }
}

if (import.meta.main) await main();
