import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createFrameworkHost,
  type FrameworkOptions,
  type TesterTraceCapture,
  type TraceCheckpoint,
  type TraceSettlement,
} from "./framework.js";

test("an armed but unadmitted public host never waits for a hypothetical producer or restarts cleanup accounting", async () => {
  const root = await mkdtemp(
    join(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp", "waffle-trace-host-"),
  );
  let calls = 0;
  const options: FrameworkOptions = {
    suite: "trace-unadmitted-cpu",
    native: { udid: "not-launched" },
    expected: [
      {
        file: "cpu-only",
        fullName: "not executed",
        sourceKey: "cpu",
        timeoutMs: 15000,
        retries: 0,
      },
    ],
    scope: { kind: "root-selection", command: "test:browser", files: ["cpu-only"] },
    resultPath: join(root, "result.json"),
  };
  try {
    const host = createFrameworkHost(options);
    const capture = host.captureTesterTrace({
      collectorResponse: async () => {
        calls++;
        return "unchanged";
      },
    });
    expect(() => host.captureTesterTrace({ collectorResponse: async () => "unchanged" })).toThrow(
      "exactly once",
    );
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let closes = 0;
    const running = host.run(async (registerClose) => {
      entered.resolve();
      await release.promise;
      registerClose(async () => {
        closes++;
        void host.abort("late closer reentry");
      });
      return { status: "interrupted", errors: ["CPU only"] };
    });
    await entered.promise;
    const before = performance.now();
    const aborted = host.abort("no admitted source");
    release.resolve();
    const result = await aborted;
    expect(await running).toBe(result);
    expect(result.trace).toEqual({ status: "incomplete", reason: "not-admitted", retained: null });
    expect(result.cleanupDeadlineAt).toBeGreaterThanOrEqual(before + 60000);
    expect(result.cleanupDeadlineAt).toBeLessThan(before + 60100);
    expect(result.cleanup.session.status).toBe("not-created");
    expect(result.cleanup.context.status).toBe("confirmed");
    expect(result.cleanup.trace.status).toBe("confirmed");
    expect(result.cleanup.scratch.status).toBe("confirmed");
    expect(result.exit).toBe(2);
    expect(closes).toBe(1);
    expect(calls).toBe(0);
    expect(() => capture.checkpoint()).toThrow("not live");
    expect(JSON.parse(await readFile(options.resultPath, "utf8")).cleanupDeadlineAt).toBe(
      result.cleanupDeadlineAt,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the public capture exposes only its two fixture operations, and checkpoints cannot confirm terminal evidence", () => {
  const operations: Record<keyof TesterTraceCapture, true> = {
    checkpoint: true,
    releaseOriginalRpc: true,
  };
  const checkpointIsTerminal: TraceCheckpoint extends Extract<
    TraceSettlement,
    { status: "confirmed" }
  >
    ? true
    : false = false;
  expect(Object.keys(operations)).toEqual(["checkpoint", "releaseOriginalRpc"]);
  expect(checkpointIsTerminal).toBe(false);
});
