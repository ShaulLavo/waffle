import { expect, test } from "bun:test";
import { FaultScheduler, runFaultSchedules } from "./storage-crash-r2-scheduler.js";
import { crashMatrixBundle } from "../tooling/storage-crash-r2.js";
import { opfsCrashMatrix } from "./storage-crash-r2-opfs.js";

const event = { adapter: "indexeddb", operation: "put-success", target: "data/chunk:1" } as const;
test("fault schedules match exact boundaries, fire once, and replay identically", () => {
  const schedule = { id: "second-chunk", at: event, occurrence: 2 };
  const replay = () => {
    const scheduler = new FaultScheduler(schedule);
    expect(scheduler.visit({ ...event, target: "data/chunk:0" })).toBe(false);
    expect(scheduler.visit(event)).toBe(false);
    expect(scheduler.visit(event)).toBe(true);
    expect(scheduler.visit(event)).toBe(false);
    scheduler.assertReached();
    return scheduler.events;
  };
  expect(replay()).toEqual(replay());
});
test("an unreached fault fails, while a normal control never injects", () => {
  const scheduler = new FaultScheduler({ id: "missing", at: event, occurrence: 1 });
  expect(() => scheduler.assertReached()).toThrow("Unreached schedule: missing");
  const control = new FaultScheduler(null);
  expect(control.visit(event)).toBe(false);
  control.assertReached();
});
test("bounded OPFS publication, flush and rotation schedules preserve one complete checkpoint", async () => {
  const results = await opfsCrashMatrix();
  expect(results).toHaveLength(9);
  expect(results.filter((result) => !result.ok)).toEqual([]);
});

test("native crash proof bundles the actual browser adapter and scheduler", async () => {
  expect((await crashMatrixBundle()).size).toBeGreaterThan(0);
});

test("a failed schedule keeps its causal trace and does not stop the next control", async () => {
  const schedule = { id: "injected-failure", at: event, occurrence: 1 };
  const cells = [
    { id: schedule.id, schedule },
    { id: "control", schedule: null },
  ];
  const results = await runFaultSchedules(cells, async (cell, scheduler) => {
    if (scheduler.visit(event)) throw scheduler.reason;
    scheduler.assertReached();
    return { id: cell.id, ok: true };
  });
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({
    id: schedule.id,
    ok: false,
    error: expect.stringContaining("Injected storage fault: injected-failure"),
    events: [{ ...event, ordinal: 1, injected: true }],
  });
  expect(results[1]).toEqual({ id: "control", ok: true });
});
