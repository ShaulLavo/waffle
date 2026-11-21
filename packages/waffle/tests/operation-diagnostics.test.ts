import { expect, test } from "bun:test";
import {
  ACKNOWLEDGED,
  Field,
  MAX_VALUE,
  OPERATION_BYTES,
  OPERATION_SLOTS,
  OperationCells,
  PIPE_OFFSET,
  RESOLVE_OFFSET,
} from "../browser/operations/cells.js";
import { OperationOwner } from "../browser/operations/owner.js";
import { captureAcceptance, createOperationWriters } from "../browser/operations/writer.js";

function setup() {
  const live = new Map<number, { generation: number; captureId: number }>();
  const allocations: number[] = [];
  const owner = new OperationOwner(
    (length) => {
      allocations.push(length);
      return new SharedArrayBuffer(length);
    },
    ({ pid, generation, captureId }) => {
      const current = live.get(pid);
      return current?.generation === generation && current.captureId === captureId;
    },
  );
  function enroll(pid: number, generation = 1) {
    const binding = owner.enroll(pid, generation);
    if (binding) live.set(pid, { generation, captureId: binding.captureId });
    return binding;
  }
  function sample() {
    const snapshot = owner.snapshot();
    if (snapshot.status !== "recording") throw new Error("Expected a recording");
    return snapshot;
  }
  return { allocations, owner, live, enroll, sample };
}

test("correlates acceptance and leaves confirmed counts unchanged by rescans and samples", () => {
  const { owner, enroll, sample, allocations } = setup();
  expect(owner.snapshot()).toEqual({ status: "empty" });
  expect(allocations).toEqual([]);
  const binding = enroll(22)!;
  expect(allocations).toEqual([2560]);
  const { pipe, resolve } = createOperationWriters(binding);
  const accept = captureAcceptance(binding);
  pipe.begin(1);
  resolve.begin(42);
  accept(41);
  expect(sample().owned[0]!.pipeReadWait?.active?.phase).toBe("waiting");
  expect(sample().owned[0]!.fsResolve?.active?.phase).toBe("submitted");
  accept(42);
  const row = sample().owned[0]!;
  expect(row.fsResolve?.active?.phase).toBe("accepted");
  expect(row.fsResolve?.completed).toBe(0);
  expect(Reflect.set(row.fsResolve!.active!, "phase", "submitted")).toBe(true);
  expect(sample().owned[0]!.fsResolve?.active?.phase).toBe("accepted");
  pipe.begin(1);
  pipe.settle("signalPending");
  pipe.settle("pollError");
  resolve.settle("resolveError");
  expect(sample().owned[0]!.fsResolve).toMatchObject({
    latest: { phase: "failed", reason: "resolve-error" },
    completed: 0,
    cancelled: 0,
    failed: 1,
  });
  expect(sample().owned[0]!.pipeReadWait).toMatchObject({
    latest: { phase: "cancelled", reason: "signal-pending" },
    completed: 0,
    cancelled: 1,
    failed: 0,
  });
});

test("retirement uses the last stable sample and rejects every old writer after same-PID exec", () => {
  const { live, enroll, sample } = setup();
  const old = enroll(7)!;
  const cells = new OperationCells(old);
  const { pipe, resolve } = createOperationWriters(old);
  pipe.begin(1);
  pipe.settle("completed");
  pipe.begin(1);
  resolve.begin(10);
  expect(sample().owned[0]?.pipeReadWait?.active?.phase).toBe("waiting");
  // The producer died after publishing the odd edge and touching some payload cells.
  expect(cells.write(PIPE_OFFSET + Field.sequence, 7)).toBe(true);
  expect(cells.write(PIPE_OFFSET + Field.completed, 2)).toBe(true);
  expect(sample().owned[0]?.pipeReadWait).toBeUndefined();
  live.delete(7);
  const next = enroll(7, 2)!;
  expect(next.slot).toBe(old.slot);
  expect(next.captureId).not.toBe(old.captureId);
  for (let index = 0; index <= ACKNOWLEDGED; index++) expect(cells.write(index, 99)).toBe(false);
  captureAcceptance(old)(10);
  const nextWriters = createOperationWriters(next);
  nextWriters.resolve.begin(10);
  pipe.settle("completed");
  resolve.settle("completed");
  const { owned, departed } = sample();
  expect(owned[0]?.fsResolve?.active?.phase).toBe("submitted");
  expect(departed[0]).toMatchObject({
    pid: 7,
    generation: 1,
    captureId: old.captureId,
    pipeReadWait: {
      latest: { phase: "completed" },
      retirement: { phase: "retired-unconfirmed" },
      completed: 1,
    },
    fsResolve: { retirement: { phase: "retired-unconfirmed" }, completed: 0 },
  });
});

test("bounds backing, capture count and history, and saturates confirmed counts", () => {
  const { live, enroll, sample, allocations } = setup();
  const first = enroll(1)!;
  const cells = new OperationCells(first);
  for (let pid = 2; pid <= OPERATION_SLOTS; pid++) expect(enroll(pid)).toBeDefined();
  expect(enroll(17)).toBeUndefined();
  expect(sample().owned).toHaveLength(OPERATION_SLOTS);
  expect(sample().skippedImages).toBe(1);
  expect(cells.write(RESOLVE_OFFSET + Field.failed, MAX_VALUE)).toBe(true);
  createOperationWriters(first).resolve.submissionFailed("submissionError");
  expect(sample().owned[0]?.fsResolve).toMatchObject({
    latest: { phase: "failed", reason: "submission-error", elapsedMs: null },
    failed: MAX_VALUE,
  });
  for (let pid = 1; pid <= OPERATION_SLOTS; pid++) live.delete(pid);
  for (let pid = 18; pid <= 21; pid++) {
    expect(enroll(pid)).toBeDefined();
    live.delete(pid);
  }
  const { owned, departed, skippedImages } = sample();
  expect(owned).toEqual([]);
  expect(departed).toHaveLength(OPERATION_SLOTS);
  expect(departed.at(0)?.pid).toBe(5);
  expect(departed.at(-1)?.pid).toBe(21);
  expect(skippedImages).toBe(1);
  expect(allocations).toEqual([OPERATION_BYTES]);
});

test("an optional backing allocation can fail without throwing from enrollment", () => {
  const owner = new OperationOwner(
    () => {
      throw new Error("allocation failed");
    },
    () => true,
  );
  expect(owner.enroll(1, 1)).toBeUndefined();
  expect(owner.snapshot()).toEqual({ status: "unavailable" });
});
