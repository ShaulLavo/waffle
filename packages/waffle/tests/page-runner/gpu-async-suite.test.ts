import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type HostCase, runPageSuite } from "waffle/testing/page-runner";
import { admitAsync } from "../gpu-async-command.js";
import { asyncFixture } from "../gpu-async-assets.js";
import { FakeDriver } from "./fake-driver.js";
import { checkGpuAsyncResult, driveGpuAsync, gpuAsyncAdapter } from "./gpu-async-suite.js";
import { gpuAsyncId } from "./gpu-async-request.js";
import { runGpuAsyncControls } from "./gpu-async-controls-runner.js";

const root = await mkdtemp(join(process.env.GPU_SCRATCH_ROOT ?? tmpdir(), "waffle-ga-unit-"));
afterAll(() => rm(root, { recursive: true, force: true }));

test("unit scratch uses the configured GPU root or platform temporary directory", () => {
  expect(dirname(resolve(root))).toBe(resolve(process.env.GPU_SCRATCH_ROOT ?? tmpdir()));
});

test("one complete command, not internal scenarios, is the framework inventory", () => {
  const adapter = gpuAsyncAdapter("ios-safari");
  expect(adapter.inventory().map(({ id }) => id)).toEqual([gpuAsyncId]);
  expect(adapter.policy.listIds({ ids: [gpuAsyncId] })).toEqual([gpuAsyncId]);
  for (const ids of [[], [gpuAsyncId, gpuAsyncId], ["normal"], [gpuAsyncId, "negative"]])
    expect(() => adapter.policy.listIds({ ids })).toThrow("inventory");
  expect(adapter.budgets(1)).toEqual({
    hello: 20000,
    heartbeat: 10000,
    operation: 30000,
    case: 600000,
    group: 600000,
    run: 600000,
    teardown: 30000,
  });
});

const qualification = (kind: string, architecture = "swiftshader") => ({
  opened: { sharedCanary: 1, isolated: true },
  capabilities: { adapter: { kind, architecture } },
});
for (const engine of ["chromium", "firefox", "webkit", "ios-safari"] as const) {
  test(`${engine} requires an actual known Worker adapter outcome`, () => {
    expect(admitAsync(engine, qualification("available")).available).toBe(true);
    expect(() => admitAsync(engine, qualification("invented-success"))).toThrow();
    expect(() => admitAsync(engine, {})).toThrow();
    if (engine === "chromium") {
      expect(() => admitAsync(engine, qualification("no-adapter"))).toThrow("missing");
      expect(() => admitAsync(engine, qualification("available", "hardware"))).toThrow(
        "Wrong Chromium",
      );
    } else
      for (const kind of ["no-adapter", "missing-webgpu"])
        expect(admitAsync(engine, qualification(kind)).available).toBe(false);
  });
}

test("unsupported remains explicitly uncompiled, and missing or wrong results cannot pass", () => {
  const result = {
    body: {
      status: "pass",
      result: {
        engine: "ios-safari",
        qualification: qualification("missing-webgpu"),
        status: "unsupported",
        compiledGuest: false,
      },
    },
    teardown: {
      status: "pass",
      result: {
        qualificationClosed: true,
        asyncStarted: false,
        closeAttempted: false,
        closed: null,
      },
    },
  };
  expect(() => checkGpuAsyncResult("ios-safari", result)).not.toThrow();
  expect(() => checkGpuAsyncResult("chromium", result)).toThrow("Wrong GPU async engine");
  for (const value of [
    undefined,
    {},
    { ...result, teardown: null },
    { ...result, body: { status: "pass", result: { ...result.body.result, compiledGuest: true } } },
    {
      ...result,
      teardown: { status: "pass", result: { ...result.teardown.result, asyncStarted: true } },
    },
  ])
    expect(() => checkGpuAsyncResult("ios-safari", value)).toThrow();
});

test("pre-aborted command does not import, qualify or launch a guest", async () => {
  let calls = 0;
  const signal = AbortSignal.abort(new Error("CANCELLED"));
  const host: HostCase = {
    workers: async () => {
      throw new Error("Browser observation not declared");
    },
    onRequest: () => {
      throw new Error("Browser observation not declared");
    },
    async press() {
      throw new Error("Unexpected key press");
    },
    signal,
    remainingMs: () => 0,
    setTimeout: () => signal.throwIfAborted(),
    holdAsset: () => {
      throw new Error("No asset holds");
    },
    task: async () => {
      calls++;
    },
    script: async () => {
      calls++;
    },
    sleep: async () => {
      calls++;
    },
    openPeer: async () => {
      throw new Error("No peers");
    },
    allocateDatabase: async () => {
      throw new Error("No durable state");
    },
  };
  await expect(driveGpuAsync(host, "chromium")).rejects.toThrow("CANCELLED");
  expect(calls).toBe(0);
});

test("missing and wrong producer artifacts fail before browser preparation", async () => {
  const previous = process.env.GPU_FIXTURE_DIR;
  try {
    delete process.env.GPU_FIXTURE_DIR;
    expect(() => asyncFixture()).toThrow("GPU_FIXTURE_DIR");
    process.env.GPU_FIXTURE_DIR = root;
    await expect(
      gpuAsyncAdapter("chromium").assets({ scratch: root, signal: new AbortController().signal }),
    ).rejects.toThrow();
    await Bun.write(
      join(root, "async.inputs.json"),
      JSON.stringify({ contract: { inputs: [] }, artifact: { size: 1, sha256: "wrong" } }),
    );
    expect(() => asyncFixture()).toThrow("inputs changed");
  } finally {
    if (previous === undefined) delete process.env.GPU_FIXTURE_DIR;
    else process.env.GPU_FIXTURE_DIR = previous;
  }
});

test("absolute command clock includes time before preparation and allocates no driver", async () => {
  let prepared = false,
    allocated = false;
  const adapter = gpuAsyncAdapter("chromium");
  const result = await runPageSuite(
    {
      ...adapter,
      assets: async () => {
        prepared = true;
        return {};
      },
    },
    () => {
      allocated = true;
      return new FakeDriver("pass");
    },
    {
      resultPath: join(root, "expired.json"),
      startedAt: performance.now() - 600001,
      scratchRoot: root,
    },
  );
  expect(result.exit).toBe(2);
  expect(result.failures.some(({ category }) => category === "run-timeout")).toBe(true);
  expect(prepared).toBe(false);
  expect(allocated).toBe(false);
  expect(result.cleanup.session.status).toBe("not-created");
});

test("local complete browser controls require explicit absolute output and scratch", async () => {
  await expect(runGpuAsyncControls("relative", root, ["chromium"])).rejects.toThrow("absolute");
});
