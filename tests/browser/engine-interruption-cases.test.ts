import { expect, test } from "bun:test";
import { FunctionalCases, assertGuestQuiescence, cleanupFunctionalResources, waitFunctionalCondition } from "./engine-interruption-cases";
import { probeCell, probeLength, snapshotProbe } from "./engine-interruption-probe";

test("safe failed legacy/default retains full context and later independent native/generic/light cases run", async () => {
  const cases = new FunctionalCases();
  const probe = new Int32Array(new SharedArrayBuffer(probeLength * 4));
  Atomics.store(probe, probeCell.startEntered, 1);
  Atomics.store(probe, probeCell.startLeft, 1);
  Atomics.store(probe, probeCell.runReturned, 1);
  const events: string[] = [];
  let owned = true;
  await cases.run({ engine: "jsc", route: "legacy", name: "default-15" }, async () => {
    events.push("failed proof"); throw new Error("injected checkpoint assertion");
  }, () => ({ evidence: snapshotProbe(probe), stdout: "out", stderr: "ready\n", requestedSignal: 15, ordinaryStatus: 143 }), () => {
    events.push("cleanup failed case"); owned = false;
  });
  for (const name of ["native", "generic", "light"]) {
    await cases.run({ engine: name, route: name, name }, async () => {
      expect(owned).toBe(false); events.push(name); return { completed: true };
    }, () => ({}), () => { events.push(`cleanup ${name}`); });
  }
  expect(events).toEqual(["failed proof", "cleanup failed case", "native", "cleanup native", "generic", "cleanup generic", "light", "cleanup light"]);
  expect(cases.ok).toBe(false);
  expect(cases.outcomes.map(outcome => outcome.ok)).toEqual([false, true, true, true]);
  const failed = cases.outcomes[0]!;
  expect(failed.error).toContain("injected checkpoint assertion");
  expect(failed.context).toEqual({ evidence: snapshotProbe(probe), stdout: "out", stderr: "ready\n", requestedSignal: 15, ordinaryStatus: 143 });
  expect(Object.keys((failed.context as any).evidence)).toHaveLength(Object.keys(probeCell).length);
  expect(failed.cleanup.safe).toBe(true);
});

test("independent idle delivery/control outcomes retain earlier successes after safe failure", async () => {
  const cases = new FunctionalCases();
  for (const delivery of ["page-kill", "page-killJob"]) {
    for (const control of ["notify-removal", "positive"]) {
      await cases.run({ engine: "quickjs", route: "legacy", name: "idle", delivery, control }, async () => {
        if (delivery === "page-kill" && control === "positive") throw new Error("positive causal proof failed");
        return { generation: 17, evidence: { idleWaitSampleCompleted: 17 } };
      }, () => ({ fullProbe: true }), () => {});
    }
  }
  expect(cases.ok).toBe(false);
  expect(cases.outcomes).toHaveLength(4);
  expect(cases.outcomes[0]!.result).toEqual({ generation: 17, evidence: { idleWaitSampleCompleted: 17 } });
  expect(cases.outcomes[1]!.error).toContain("positive causal proof failed");
  expect(cases.outcomes[3]!.delivery).toBe("page-killJob");
  expect(cases.outcomes[3]!.ok).toBe(true);
});

test("actual cleanup exception is unsafe, retains original proof and stops all later cases", async () => {
  const cases = new FunctionalCases();
  let later = false;
  await expect(cases.run({ engine: "jsc", route: "legacy", name: "default" }, async () => {
    throw new Error("original proof failure");
  }, () => ({ probe: "retained before cleanup" }), () => { throw new Error("owned worker still executing"); })).rejects.toThrow("unsafe functional cleanup");
  await expect(cases.run({ engine: "quickjs", route: "runtimeProcess", name: "later" }, async () => { later = true; }, () => ({}), () => {})).rejects.toThrow("unsafe functional cleanup");
  expect(later).toBe(false);
  expect(cases.ok).toBe(false);
  expect(cases.outcomes).toHaveLength(1);
  expect(cases.outcomes[0]!.error).toContain("original proof failure");
  expect(cases.outcomes[0]!.cleanup).toEqual({ safe: false, error: "Error: owned worker still executing" });
});

test("Worker.terminate bookkeeping is not quiescence for an entered CPU-bound guest", () => {
  const probe = new Int32Array(new SharedArrayBuffer(probeLength * 4));
  Atomics.store(probe, probeCell.startEntered, 1);
  Atomics.store(probe, probeCell.terminateRequests, 1);
  expect(() => assertGuestQuiescence([{ evidence: snapshotProbe(probe) }])).toThrow("execution quiescence");
  Atomics.store(probe, probeCell.startLeft, 1);
  expect(() => assertGuestQuiescence([{ evidence: snapshotProbe(probe) }])).toThrow("execution quiescence");
  Atomics.store(probe, probeCell.runReturned, 1);
  expect(() => assertGuestQuiescence([{ evidence: snapshotProbe(probe) }])).not.toThrow();
});

test("failed mutation restoration still cleans scopes/workers and marks unsafe without masking original proof", async () => {
  const cases = new FunctionalCases(); const errors: unknown[] = [], events: string[] = [];
  await expect(cases.run({ engine: "jsc", route: "legacy", name: "idle" }, async () => {
    try { throw new Error("original causal proof"); }
    finally {
      cleanupFunctionalResources([
        () => { events.push("restore"); throw new Error("notify restore failed"); },
        () => { events.push("scope disposed"); },
        () => { events.push("worker stopped"); },
      ], error => { errors.push(error); });
    }
  }, () => ({}), () => { if (errors.length) throw new AggregateError(errors, "unsafe owned cleanup"); })).rejects.toThrow("unsafe functional cleanup");
  expect(events).toEqual(["restore", "scope disposed", "worker stopped"]);
  expect(cases.outcomes[0]!.error).toContain("original causal proof");
  expect(cases.outcomes[0]!.cleanup.safe).toBe(false);
});

test("failed Bun light physical termination is not a guest completion acknowledgement", () => {
  const probe = new Int32Array(new SharedArrayBuffer(probeLength * 4));
  Atomics.store(probe, probeCell.terminateRequests, 1);
  expect(() => assertGuestQuiescence([{ evidence: snapshotProbe(probe) }])).toThrow("execution quiescence");
  const logicalExit = { evidence: snapshotProbe(probe), exitObserved: true };
  expect(() => assertGuestQuiescence([logicalExit])).toThrow("execution quiescence");
});

test("completed guest missing a marker fails immediately instead of spending a per-case timeout", async () => {
  let pauses = 0;
  await expect(waitFunctionalCondition(() => false, "handler-ready", { completed: () => true, timeoutMs: 15_000,
    pause: async () => { pauses++; }, now: () => 0 })).rejects.toThrow("handler-ready cannot complete after guest execution finished");
  expect(pauses).toBe(0);
});

test("drain and marker admission precede completion rejection; live timeout remains bounded", async () => {
  let marker = false, completed = false, ticks = 0;
  await waitFunctionalCondition(() => marker, "ready", { completed: () => completed, timeoutMs: 15_000,
    now: () => ticks, pause: async () => { ticks++; marker = true; completed = true; } });
  expect(ticks).toBe(1);
  ticks = 0;
  await expect(waitFunctionalCondition(() => false, "live guest ready", { completed: () => false,
    timeoutMs: 2, now: () => ticks, pause: async () => { ticks++; } })).rejects.toThrow("live guest ready timed out");
  expect(ticks).toBe(3);
});

test("diagnostic errors cannot suppress cleanup or the original failed case", async () => {
  const cases = new FunctionalCases(); let cleaned = false;
  await cases.run({ engine: "quickjs", route: "legacy", name: "default" }, async () => { throw new Error("original"); },
    () => { throw new Error("diagnostic callback"); }, () => { cleaned = true; });
  expect(cleaned).toBe(true);
  expect(cases.outcomes[0]!.error).toContain("original");
  expect(cases.outcomes[0]!.context).toEqual({ diagnosticError: "Error: diagnostic callback" });
});
