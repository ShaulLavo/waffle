import { expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserRunnerLifecycle } from "./browser-runner-lifecycle.js";
import { GpuQualificationLifecycle } from "./gpu-browser-qualification.js";
import {
  gpuMeasurementRoutes,
  runGpuMeasurementBrowser,
  measurementFailed,
  desktopSafariCapabilities,
  prepareGpuMeasurement,
} from "../tooling/gpu-measure.js";
import {
  assertImagePixel,
  assertUpload,
  assertWake,
  defaultMeasurementOptions,
  distribution,
  measure,
  measurementOptions,
  measurementRequest,
  unavailableMemory,
} from "./fixtures/gpu/measurement-contract.js";

const options = { ...defaultMeasurementOptions, trials: 2, warmup: 0, extraWorkers: 1 };
test("bounded options reject non-integers, unbounded trials and malformed commands", () => {
  expect(measurementOptions(options)).toEqual(options);
  for (const patch of [
    { trials: 0 },
    { trials: 31 },
    { warmup: 6 },
    { extraWorkers: 5 },
    { timeoutMs: Infinity },
    { runtimeFixture: "yes" },
  ])
    expect(() => measurementOptions({ ...options, ...patch })).toThrow();
  expect(measurementRequest({ kind: "device" })).toEqual({ kind: "device" });
  expect(() =>
    measurementRequest({
      kind: "image",
      options,
      width: 100_000,
      height: 100_000,
      suppress: false,
    }),
  ).toThrow("bounded");
  expect(() =>
    measurementRequest({ kind: "wait", control: new SharedArrayBuffer(8), timeoutMs: 100 }),
  ).toThrow("16-byte");
  expect(() => measurementRequest({ kind: "upload", options, corrupt: "yes" })).toThrow();
});
test("raw samples are retained and quantiles never mutate caller order", () => {
  const samples = [9, 1, 3, 2, 4];
  expect(distribution(samples)).toEqual({
    samplesMs: samples,
    count: 5,
    minMs: 1,
    medianMs: 3,
    p95Ms: 9,
    maxMs: 9,
  });
  expect(samples).toEqual([9, 1, 3, 2, 4]);
  for (const input of [[], [-1], [NaN], [Infinity]]) expect(() => distribution(input)).toThrow();
});
test("oracles reject corrupt upload, missing pixels and unnotified or synchronous waits", () => {
  assertUpload(new Uint32Array([1, 2]), new Uint32Array([1, 2]));
  expect(() => assertUpload(new Uint32Array([1, 3]), new Uint32Array([1, 2]))).toThrow(
    "readback differs",
  );
  assertImagePixel([255, 0, 0, 255], 255);
  expect(() => assertImagePixel([0, 0, 0, 0], 255)).toThrow();
  expect(assertWake({ async: true, result: "ok", notified: 1, elapsedMs: 0.25 })).toBe(0.25);
  for (const patch of [
    { async: false },
    { result: "not-equal" },
    { result: "timed-out" },
    { notified: 0 },
    { elapsedMs: -1 },
  ])
    expect(() =>
      assertWake({ async: true, result: "ok", notified: 1, elapsedMs: 1, ...patch }),
    ).toThrow();
});
test("failed controls remain explicit and unknown physical memory is never estimated", async () => {
  expect(
    await measure(async () => {
      throw new Error("actual failure");
    }),
  ).toEqual({ kind: "failed", reason: "Error: actual failure" });
  expect(measurementFailed({ native: { kind: "failed", reason: "x" } })).toBe(true);
  expect(
    measurementFailed({
      uploadControl: { kind: "failed" },
      imageControl: { kind: "failed" },
      other: { kind: "unsupported" },
    }),
  ).toBe(false);
  expect(unavailableMemory().kind).toBe("unavailable");
  expect(unavailableMemory()).not.toHaveProperty("bytes");
});
test("Safari evidence rejects Playwright WebKit, iOS and simulator sessions", () => {
  expect(
    desktopSafariCapabilities({ browserName: "Safari", platformName: "macOS" }).platformName,
  ).toBe("macOS");
  for (const capabilities of [
    { browserName: "webkit", platformName: "mac" },
    { browserName: "Safari", platformName: "iOS" },
    { browserName: "Safari", platformName: "mac", "safari:useSimulator": true },
  ])
    expect(() => desktopSafariCapabilities(capabilities)).toThrow("desktop");
});
test("native routes bundle independently and own isolated server teardown", async () => {
  const runner = new BrowserRunnerLifecycle(30_000);
  let url = "";
  try {
    await runner.init(process.env.GPU_MEASURE_SCRATCH_ROOT ?? tmpdir());
    const routes = await gpuMeasurementRoutes(options);
    const source = await new Response(routes["/measurement-worker.js"]).text();
    expect(source).toContain("writeBuffer");
    expect(source).toContain("getMappedRange");
    expect(source).not.toContain("createRuntime");
    url = runner.serve(routes);
    const response = await fetch(url);
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect((await fetch(`${url}/unknown`)).status).toBe(404);
    await expect(gpuMeasurementRoutes({ ...options, runtimeFixture: true })).rejects.toThrow(
      "GPU_FIXTURE_DIR",
    );
  } finally {
    await runner.close();
  }
  await expect(access(runner.scratch)).rejects.toThrow();
  await expect(fetch(url)).rejects.toThrow();
});
test("portable packet includes standalone Safari driver and exact options", async () => {
  const directory = await mkdtemp(join(process.env.GPU_MEASURE_SCRATCH_ROOT ?? tmpdir(), "gm-"));
  try {
    await prepareGpuMeasurement(directory, options);
    expect(await Bun.file(join(directory, "measurement-options.json")).json()).toEqual(options);
    const source = await Bun.file(join(directory, "runner.mjs")).text();
    expect(source).toContain("Safari-only");
    expect(source).not.toContain('from "playwright"');
    const child = Bun.spawn(
      [process.execPath, join(directory, "runner.mjs"), "--packet", directory],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("requires --safari");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
const browserTest = process.env.GPU_MEASURE_BROWSER_TESTS === "1" ? test : test.skip;
for (const engine of ["chromium", "firefox", "webkit"] as const)
  browserTest(
    `real ${engine} measurements run controls without fake guest streams`,
    async () => {
      const runner =
        engine === "chromium"
          ? new GpuQualificationLifecycle(120_000)
          : new BrowserRunnerLifecycle(120_000);
      try {
        await runner.init(process.env.GPU_MEASURE_SCRATCH_ROOT ?? tmpdir());
        const url = runner.serve(await gpuMeasurementRoutes(options));
        const result = await runGpuMeasurementBrowser(runner, engine, url, options);
        expect(result.report.schema).toBe("waffle-gpu-measure-v1");
        expect(result.report.cleanup).toEqual({ workersLive: 0 });
        expect(measurementFailed(result)).toBe(false);
        if (engine === "chromium") {
          const native = result.report.native;
          expect(native).toHaveProperty("kind", "measured");
          expect(native).toHaveProperty("value.sabUpload.kind", "measured");
          expect(native).toHaveProperty("value.image1080p.kind", "measured");
          expect(native).toHaveProperty("value.image4k.kind", "measured");
          expect(native).toHaveProperty("value.wakeLatency.kind", "measured");
        }
      } finally {
        await runner.close();
      }
    },
    120_000,
  );
