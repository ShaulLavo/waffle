import { expect, test } from "bun:test";
import {
  requireCompiledAsyncNegative,
  requireCompiledAsyncResult,
  requireCompiledAsyncRevocation,
  runAsyncSuite,
  requireCompleteAsyncResult,
  type AsyncCommand,
} from "./gpu-async-command.js";

test("shared command retains the original strict compiled parsers", () => {
  expect(() =>
    requireCompiledAsyncResult({
      exit: { kind: "exited", code: 0 },
      text: "GPU_ASYNC_OK",
      errors: [],
    }),
  ).toThrow("Missing compiled result marker");
  expect(() =>
    requireCompiledAsyncNegative(
      {
        exit: { kind: "exited", code: 1 },
        text: "GPU_ASYNC_TERMINAL reason=20\nGPU_ASYNC_FAIL stage=completion-correlation",
        errors: [],
      },
      "--malformed-map",
    ),
  ).toThrow("Missing protocol terminal");
  expect(() =>
    requireCompiledAsyncRevocation(
      {
        exit: { kind: "exited", code: 0 },
        text: "GPU_ASYNC_PAUSED stage=map-pending\nGPU_ASYNC_REVOKED stage=map-pending errno=-64 repeated=2 append=-64 drained=65",
        errors: [],
      },
      "map-pending",
    ),
  ).toThrow("Missing exact compiled revocation proof");
});

const normalText = [
  "GPU_ASYNC_NEGOTIATED granted=checked excessive=failed",
  "GPU_ASYNC_READBACK creation=exact zeros=preserved usages=unchanged",
  "GPU_ASYNC_REMAP initial=preserved partial=checked empty=consumed",
  "GPU_ASYNC_SCOPES mapped=validation invalid=validation dependent=validation recovered=yes",
  "GPU_ASYNC_COMPILATION native=error utf8=checked statuses=checked",
  "GPU_ASYNC_LOSS device=3 reason=2 message=destroyed",
  "GPU_ASYNC_ISOLATION destroyed=unmapped second-device=progress last-release=invalidated",
  "GPU_ASYNC_OK compiled=C runtime=blocking maps=exact scopes=native payload=once loss=explicit",
  "vendor=test architecture=test",
].join("\n");
const adapter = { vendor: "test", architecture: "test" };

// These are orchestration controls, never native GPU or compiled acceptance evidence.
function mechanics(fault = "none") {
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const slots = new Map<number, string[]>();
  let firstDrain = true;
  const command: AsyncCommand = {
    async invoke(name, args) {
      calls.push({ name, args });
      if (
        name === "openAsync" ||
        name === "closeAsync" ||
        name === "revokeAsync" ||
        name === "resumeAsync"
      )
        return;
      const slot = args[0];
      if (name === "launchAsync") {
        if (!Array.isArray(slot) || typeof args[1] !== "number")
          throw new Error("Wrong launch arguments");
        slots.set(args[1], slot);
        return { pid: 1 };
      }
      if (name === "asyncServiceSnapshot")
        return { connections: fault === "snapshot" ? 1 : 0, devicesLive: 0, heapBytes: 0 };
      if (typeof slot !== "number") throw new Error("Missing slot");
      const flags = slots.get(slot);
      if (!flags) throw new Error("Missing launched control");
      const flag = flags[0],
        stage = flag?.replace("--pause-", "");
      let text = normalText,
        code = 0;
      if (flag?.startsWith("--pause-"))
        text = `GPU_ASYNC_PAUSED stage=${stage}\nGPU_ASYNC_REVOKED stage=${stage} errno=-64 repeated=2 append=-64 drained=1`;
      else if (flag) {
        code = 1;
        text =
          flag === "--suppress-writes"
            ? "GPU_ASYNC_FAIL stage=exact-native-readback"
            : flag === "--reuse-payload"
              ? "GPU_ASYNC_FAIL stage=payload-once"
              : "GPU_ASYNC_TERMINAL reason=2\nGPU_ASYNC_FAIL stage=completion-correlation";
      }
      if (name === "drainAsync") {
        if (firstDrain) {
          firstDrain = false;
          return { text: "", errors: [] };
        }
        return {
          text: fault === "assertion" ? "GPU_ASYNC_FAIL stage=unexpected" : text,
          errors: fault === "host-error" ? ["HOST_ERROR"] : [],
        };
      }
      if (name !== "finishAsync") throw new Error("Unexpected command");
      slots.delete(slot);
      return {
        exit: {
          kind: args[1] ? "signaled" : "exited",
          code: args[1] ? (fault === "kill" ? 15 : 9) : code,
        },
        text,
        errors: [],
        snapshot: { actualControl: true },
      };
    },
    async sleep(ms) {
      expect(ms).toBe(20);
      const start = performance.now();
      await Bun.sleep(ms);
      expect(performance.now() - start).toBeGreaterThanOrEqual(18);
    },
  };
  return { command, calls, slots };
}

test("shared imperative command preserves all 27 guest calls, order, neighbors and final close", async () => {
  const control = mechanics();
  const result = await runAsyncSuite(control.command, adapter);
  requireCompleteAsyncResult(result, adapter);
  const launches = control.calls.filter((call) => call.name === "launchAsync");
  expect(launches).toHaveLength(27);
  expect(
    launches.filter((call) => Array.isArray(call.args[0]) && call.args[0].length === 0),
  ).toHaveLength(17);
  expect(launches.slice(0, 9).map((call) => call.args)).toEqual([
    [[], 1],
    [["--suppress-writes"], 0],
    [[], 1],
    [["--corrupt-range"], 0],
    [[], 1],
    [["--reuse-payload"], 0],
    [[], 1],
    [["--malformed-map"], 0],
    [[], 1],
  ]);
  expect(result.lifetimes.map(({ stage, action }) => [stage, action])).toEqual([
    ["map-pending", "kill"],
    ["map-pending", "revoke"],
    ["payload-published", "kill"],
    ["payload-published", "revoke"],
    ["work-pending", "kill"],
    ["work-pending", "revoke"],
  ]);
  for (let index = 9; index < launches.length; index += 3) {
    expect(launches[index]?.args[1]).toBe(0);
    expect(launches[index + 1]?.args).toEqual([[], 1]);
    expect(launches[index + 2]?.args).toEqual([[], 1]);
  }
  expect(control.calls.filter((call) => call.name === "revokeAsync")).toHaveLength(3);
  expect(control.calls.filter((call) => call.name === "resumeAsync")).toHaveLength(3);
  expect(control.slots.size).toBe(0);
  expect(control.calls.slice(-2).map((call) => call.name)).toEqual([
    "asyncServiceSnapshot",
    "closeAsync",
  ]);
});

for (const fault of ["assertion", "host-error", "kill", "snapshot"]) {
  test(`original command rejects ${fault} and keeps its finally`, async () => {
    const control = mechanics(fault);
    await expect(runAsyncSuite(control.command, adapter)).rejects.toThrow();
    expect(control.calls.at(-1)?.name).toBe("closeAsync");
    expect(control.calls.filter((call) => call.name === "openAsync")).toHaveLength(1);
    expect(control.calls.filter((call) => call.name === "closeAsync")).toHaveLength(1);
  });
}

test("complete result rejects missing phases, wrong order, wrong exits and nonzero service state", async () => {
  const result = await runAsyncSuite(mechanics().command, adapter);
  const bad = [
    { ...result, negatives: result.negatives.slice(1) },
    { ...result, lifetimes: result.lifetimes.toReversed() },
    { ...result, retired: { connections: 0, devicesLive: 0, heapBytes: 1 } },
    { ...result, normal: { ...result.normal, exit: { kind: "exited", code: 1 } } },
    { ...result, compiledGuest: false },
  ];
  for (const value of bad) expect(() => requireCompleteAsyncResult(value, adapter)).toThrow();
});

test("command cancellation during polling still reaches original close without fresh admission", async () => {
  const control = mechanics();
  const controller = new AbortController();
  const command: AsyncCommand = {
    invoke: control.command.invoke,
    async sleep(ms) {
      expect(ms).toBe(20);
      controller.abort(new Error("CANCELLED_WHILE_POLLING"));
      controller.signal.throwIfAborted();
    },
  };
  await expect(runAsyncSuite(command, adapter)).rejects.toThrow("CANCELLED_WHILE_POLLING");
  expect(control.calls.map(({ name }) => name)).toEqual([
    "openAsync",
    "launchAsync",
    "drainAsync",
    "closeAsync",
  ]);
});

test("host result gate rejects absent cleanup, retired flags and truncated successful commands", async () => {
  const { checkGpuAsyncResult } = await import("./page-runner/gpu-async-suite.js");
  const body = {
    engine: "firefox",
    qualification: { capabilities: { adapter: { kind: "available", ...adapter } } },
    ...(await runAsyncSuite(mechanics().command, adapter)),
  };
  const teardown = {
    status: "pass",
    result: {
      qualificationClosed: true,
      asyncStarted: true,
      closeAttempted: true,
      closed: { errors: [], workers: [{ url: "/gpu-guest.js", stopped: true }] },
    },
  };
  const result = { body: { status: "pass", result: body }, teardown };
  expect(() => checkGpuAsyncResult("firefox", result)).not.toThrow();
  for (const value of [
    { ...result, teardown: { status: "fail" } },
    { ...result, teardown: { ...teardown, result: { ...teardown.result, closeAttempted: false } } },
    {
      ...result,
      teardown: {
        ...teardown,
        result: {
          ...teardown.result,
          closed: { errors: [], workers: [{ url: "/gpu-guest.js", stopped: false }] },
        },
      },
    },
    {
      ...result,
      body: { status: "pass", result: { ...body, lifetimes: body.lifetimes.slice(1) } },
    },
  ])
    expect(() => checkGpuAsyncResult("firefox", value)).toThrow();
});
