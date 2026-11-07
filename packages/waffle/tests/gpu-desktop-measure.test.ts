import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { desktopSchedule, desktopMeasurements } from "./fixtures/gpu/desktop-fairness-contract.js";
import { desktopRetired } from "./fixtures/gpu/desktop-arm-contract.js";
import { measured, measuredExpectation } from "./fixtures/gpu/fairness-test-data.js";
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
  expect(desktopMeasurements(snapshot, 20000, "on", measuredExpectation)).toMatchObject({
    draws: 20000,
    drawSlices: 20,
    targetStatus: "met",
    nativeQueueExecutionMeasured: false,
  });
  expect(() => desktopMeasurements(snapshot, 20000, "off", measuredExpectation)).toThrow("cap arm");
  for (const invalid of [
    { ...snapshot, epoch: 0 },
    { ...snapshot, blobs: [] },
    { ...snapshot, queue: [] },
    { ...snapshot, native: {} },
    { ...snapshot, presents: [] },
    { ...snapshot, armed: false },
  ])
    expect(() => desktopMeasurements(invalid, 20000, "on", measuredExpectation)).toThrow();
  expect(() => desktopMeasurements(snapshot, 50000, "on", measuredExpectation)).toThrow("workload");
  expect(() => desktopMeasurements(measured(), 20000, "on", measuredExpectation)).toThrow(
    "workload",
  );
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
  expect(calls).toEqual(["reset", "openDesktopArm", "closeDesktopArm"]);
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

test("desktop validation rejects a peer with presents but no actual draws", () => {
  const source = boundedObservation();
  const invalid = {
    ...source,
    records: Object.fromEntries(
      Object.entries(source.records)
        .filter(([key]) => key !== "2:nested:14")
        .map(([key, value]) => [key, key === "2:nested:13" ? { ...value, count: 256 } : value]),
    ),
    native: Object.fromEntries(Object.entries(source.native).filter(([key]) => key !== "2:draw")),
    slices: source.slices.map((slice) => (slice.connection === 2 ? { ...slice, draws: 0 } : slice)),
  };
  expect(() => desktopMeasurements(invalid, 20000, "on", measuredExpectation)).toThrow();
});
test("desktop measurement Playwright navigation always uses the shared helper", () => {
  const source = readFileSync(new URL("../tooling/gpu-measure.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/[.]goto\s*[(]/);
  expect(source).toContain("navigateTestPage");
});
test("desktop driver refuses missing positive controls before measuring any arm", async () => {
  const result = await runDesktopMeasurements(
    {
      reset: async () => {},
      screenshot: async () => "unused",
      call: async (_module, method) =>
        method === "runDesktopWorkload"
          ? { fairness: boundedObservation() }
          : method === "retireDesktopArm"
            ? {
                service: {
                  connections: 0,
                  devicesLive: 0,
                  heapBytes: 0,
                  frameTexturesLive: 0,
                  presentCanvasesLive: 0,
                },
              }
            : undefined,
    },
    1,
  );
  expect(result.samples).toHaveLength(1);
  expect(result.samples[0]).toHaveProperty("kind", "failed");
});

function desktopController() {
  let token = "",
    resets = 0;
  let caps: "on" | "off" = "on";
  const ownAuthority = [
    { canaries: Array.from({ length: 10 }, (_, i) => `canary-${i}`), leaks: [] },
  ];
  const exit = () => ({
    exit: { kind: "exited", code: 0 },
    text: "GPU_STAGE closed",
    ownAuthority,
  });
  const identity = () => ({
    token,
    caps,
    document: {
      url: `http://localhost/?arm=${token}`,
      timeOrigin: 1000 + resets,
      isolated: true,
      userAgent: "test",
    },
  });
  const zero = {
    connections: 0,
    devicesLive: 0,
    heapBytes: 0,
    frameTexturesLive: 0,
    presentCanvasesLive: 0,
  };
  const service = (connections: number) => ({
    ...zero,
    connections,
    devicesLive: connections,
    desktopCaps: caps,
    fairness: boundedObservation(),
  });
  const calls: string[] = [];
  const controller: MeasurementController = {
    reset: async (value) => {
      token = value;
      resets++;
    },
    screenshot: async () => "pixels",
    call: async (_module, method, args = []) => {
      calls.push(method);
      if (method === "openDesktopArm") {
        if (args[0] !== "on" && args[0] !== "off") throw new Error("caps");
        caps = args[0];
        return {
          identity: identity(),
          firstCompiledFrameMarkerMs: 1,
          incomplete: { observerError: "positive coverage missing" },
          frame: { text: "GPU_FRAME colour=red frame=1 validation=none", errors: [] },
        };
      }
      if (method === "armDesktopWorkload")
        return {
          identity: identity(),
          controlExit: exit(),
          armed: { ...service(0), coverage: { ...boundedObservation(), epoch: 0, armed: false } },
          ready: service(2),
        };
      if (method === "observeDesktopPixels")
        return {
          identity: identity(),
          pixels: {
            center: args[2] === "green" ? [0, 255, 0, 255] : [255, 0, 0, 255],
            corner: [0, 0, 0, 255],
          },
        };
      if (method === "runDesktopWorkload") return { identity: identity(), ...service(1) };
      if (method === "retireDesktopArm")
        return { identity: identity(), exits: [exit(), exit()], service: service(0) };
      if (method === "closeDesktopArm")
        return { identity: identity(), errors: [], workers: [{ url: "owned", stopped: true }] };
      throw new Error(method);
    },
  };
  return { controller, calls, identity, exit, service };
}
test("desktop driver validates a complete current arm before starting another", async () => {
  const { controller } = desktopController();
  const result = await runDesktopMeasurements(controller, 1);
  expect(result.samples[0]).toHaveProperty("kind", "measured");
});
for (const method of [
  "openDesktopArm",
  "observeDesktopPixels",
  "armDesktopWorkload",
  "runDesktopWorkload",
  "retireDesktopArm",
  "closeDesktopArm",
]) {
  test(`desktop driver rejects missing ${method} result`, async () => {
    const { controller } = desktopController(),
      call = controller.call;
    controller.call = async (module, name, args) =>
      name === method ? undefined : call(module, name, args);
    const result = await runDesktopMeasurements(controller, 1);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toHaveProperty("kind", "failed");
  });
}
for (const patch of [{ identity: { token: "wrong" } }, { firstCompiledFrameMarkerMs: NaN }]) {
  test("desktop driver rejects wrong-document or nonfinite control observations", async () => {
    const { controller } = desktopController(),
      call = controller.call;
    controller.call = async (module, name, args) => {
      const value = await call(module, name, args);
      return name === "openDesktopArm" ? { ...Object(value), ...patch } : value;
    };
    const result = await runDesktopMeasurements(controller, 1);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toHaveProperty("kind", "failed");
  });
}
for (const missing of [0, 1]) {
  test(`desktop retirement rejects missing measured guest ${missing} authority despite control report`, () => {
    const fixture = desktopController(),
      exits = [fixture.exit(), fixture.exit()];
    exits[missing] = { ...fixture.exit(), ownAuthority: [] };
    const identity = fixture.identity();
    expect(() =>
      desktopRetired(
        { identity, exits, service: fixture.service(0), authority: fixture.exit().ownAuthority },
        identity,
      ),
    ).toThrow("authority");
  });
}

for (const patch of [
  { desktopCaps: "off" },
  { connections: Infinity },
  { devicesLive: -1 },
  { fairness: { ...boundedObservation(), epoch: 2 } },
]) {
  test("desktop final result must retain ready caps, finite resources and epoch", async () => {
    const { controller } = desktopController(),
      call = controller.call;
    controller.call = async (module, name, args) => {
      const value = await call(module, name, args);
      return name === "runDesktopWorkload" ? { ...Object(value), ...patch } : value;
    };
    const result = await runDesktopMeasurements(controller, 1);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toHaveProperty("kind", "failed");
  });
}
