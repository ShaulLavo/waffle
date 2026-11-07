import { expect, test } from "bun:test";
import { desktopSchedule, desktopMeasurements } from "./fixtures/gpu/desktop-fairness-contract.js";
import { measured } from "./fixtures/gpu/fairness-test-data.js";
import {
  runDesktopMeasurements,
  type MeasurementController,
} from "../tooling/gpu-desktop-measure.js";
import { desktopObservation } from "./fixtures/gpu/desktop-fairness-observation.js";
import { processMemorySample } from "../tooling/gpu-measure-host.js";
import {
  gpuMeasurementRoutes,
  runGpuMeasurementBrowser,
  measurementFailed,
} from "../tooling/gpu-measure.js";
import { defaultMeasurementOptions } from "./fixtures/gpu/measurement-contract.js";
import { GpuQualificationLifecycle } from "./gpu-browser-qualification.js";

test("desktop schedule pairs both workloads and counterbalances arms without sorting samples", () => {
  expect(desktopSchedule(2).map(({ pair, caps, draws }) => `${pair}:${caps}:${draws}`)).toEqual([
    "0:on:20000",
    "0:on:50000",
    "0:off:20000",
    "0:off:50000",
    "1:off:20000",
    "1:off:50000",
    "1:on:20000",
    "1:on:50000",
  ]);
  for (const pairs of [0, 6, 1.5, Infinity]) expect(() => desktopSchedule(pairs)).toThrow();
});
function boundedObservation() {
  const source = measured();
  let removedBefore = 0;
  return {
    ...source,
    records: { ...source.records, "1:nested:14": { count: 20000, totalMs: 0, maxMs: 0 } },
    native: { ...source.native, "1:draw": { count: 20000, totalMs: 0, maxMs: 0 } },
    slices: source.slices.map((slice) => {
      if (slice.connection !== 1) return slice;
      const removed = slice.draws * 0.9;
      const result = {
        ...slice,
        draws: slice.draws - removed,
        records: slice.records - removed,
        firstRecord: slice.firstRecord - removedBefore,
        lastRecord: slice.lastRecord - removedBefore - removed,
      };
      removedBefore += removed;
      return result;
    }),
    presents: source.presents.map((present) => ({
      ...present,
      otherLargeDraws: present.otherLargeDraws.map((draws) => draws / 10),
    })),
    blobs: source.blobs.map((blob) => ({ ...blob, bytes: 480184, draws: 20000 })),
  };
}
test("bounded desktop validator keeps workload, native, queue, and epoch controls strict", () => {
  const snapshot = boundedObservation();
  expect(desktopObservation({ fairness: snapshot })).toBe(snapshot);
  for (const patch of [
    { queue: [null] },
    { blobs: [{}] },
    { native: { "1:draw": {} } },
    { armed: 1 },
    { slices: [false] },
  ])
    expect(() => desktopObservation({ fairness: { ...snapshot, ...patch } })).toThrow();
  expect(desktopMeasurements(snapshot, 20000, "on")).toMatchObject({
    draws: 20000,
    drawSlices: 20,
    targetStatus: "met",
    nativeQueueExecutionMeasured: false,
  });
  expect(() => desktopMeasurements(snapshot, 20000, "off")).toThrow("cap arm");
  for (const invalid of [
    { ...snapshot, epoch: 0 },
    { ...snapshot, blobs: [] },
    { ...snapshot, queue: [] },
    { ...snapshot, native: {} },
    { ...snapshot, presents: [] },
    { ...snapshot, armed: false },
  ])
    expect(() => desktopMeasurements(invalid, 20000, "on")).toThrow();
  expect(() => desktopMeasurements(snapshot, 50000, "on")).toThrow("workload");
  expect(() => desktopMeasurements(measured(), 20000, "on")).toThrow("workload");
});
test("failed controls retain their raw sample, clean up, and stop later timed arms", async () => {
  const calls: string[] = [];
  const controller: MeasurementController = {
    async call(_module, method) {
      calls.push(method);
      if (method === "openDesktopArm") return { positive: "raw" };
      if (method === "observeTriangleScreenshot") throw new Error("pixel sensitivity");
      return { stopped: true };
    },
    async screenshot() {
      return "pixels";
    },
    async reset() {
      calls.push("reset");
    },
  };
  const result = await runDesktopMeasurements(controller, 2);
  expect(result.samples).toHaveLength(1);
  expect(result.samples[0]).toMatchObject({
    kind: "failed",
    control: { positive: "raw" },
    cleanup: { stopped: true },
  });
  expect(calls).toEqual([
    "reset",
    "openDesktopArm",
    "observeTriangleScreenshot",
    "closeDesktopArm",
  ]);
});
test("host memory is explicitly process RSS rather than physical GPU or logical image bytes", () => {
  const sample = processMemorySample();
  expect(["observed", "unavailable"]).toContain(sample.kind);
  expect(sample).not.toHaveProperty("physicalGpuBytes");
});
const live =
  process.env.GPU_DESKTOP_BROWSER_TESTS === "1" && process.env.GPU_FIXTURE_DIR ? test : test.skip;
live(
  "portable desktop flow exercises real compiled paired caps arms and native controls",
  async () => {
    const runner = new GpuQualificationLifecycle(300000);
    try {
      await runner.init(process.env.GPU_MEASURE_SCRATCH_ROOT);
      const options = {
        ...defaultMeasurementOptions,
        trials: 1,
        warmup: 0,
        extraWorkers: 1,
        desktopFairnessPairs: 1,
      };
      const url = runner.serve(await gpuMeasurementRoutes(options, process.env.GPU_FIXTURE_DIR));
      const result = await runGpuMeasurementBrowser(runner, "chromium", url, options);
      if (process.env.GPU_DESKTOP_TEST_REPORT)
        await Bun.write(process.env.GPU_DESKTOP_TEST_REPORT, JSON.stringify(result, null, 2));
      const desktop = result.report.desktopFairness;
      expect(measurementFailed(result), JSON.stringify(desktop)).toBe(false);
      expect(result.report.desktopFairness).toHaveProperty("samples.length", 4);
    } finally {
      await runner.close();
    }
  },
  300000,
);
