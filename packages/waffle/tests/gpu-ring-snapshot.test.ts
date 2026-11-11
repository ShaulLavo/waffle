import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { captureRingSnapshots } from "./fixtures/gpu/ring-snapshot.js";

test("one checkpoint samples an original shared ring once across owner and attempt", () => {
  const backing = new SharedArrayBuffer(128);
  const capture = captureRingSnapshots();
  const owner = capture(backing);
  Atomics.store(new Int32Array(backing), 3, 1);
  const attempt = capture(backing);
  expect(attempt).toBe(owner);
  expect(attempt.writer).toBe(0);
  expect(Atomics.load(new Int32Array(backing), 3)).toBe(1);
  expect(captureRingSnapshots()(backing).writer).toBe(1);
});

test("the next checkpoint reads fresh publication and consumption without mutating the old one", () => {
  const backing = new SharedArrayBuffer(128);
  const capture = captureRingSnapshots();
  const before = capture(backing);
  Atomics.store(new BigUint64Array(backing, 0, 1), 0, (5n << 32n) | 24n);
  Atomics.store(new Int32Array(backing), 2, 16);
  expect(capture(backing)).toBe(before);
  expect(before).toEqual({ capacity: 64, head: 0, tail: 0, used: 0, writer: 0, terminal: 0 });
  expect(captureRingSnapshots()(backing)).toEqual({
    capacity: 64,
    head: 24,
    tail: 16,
    used: 8,
    writer: 0,
    terminal: 5,
  });
});

test("equal-size original rings stay distinct inside a checkpoint", () => {
  const first = new SharedArrayBuffer(128);
  const second = new SharedArrayBuffer(128);
  Atomics.store(new Int32Array(second), 3, 1);
  const capture = captureRingSnapshots();
  expect(capture(first).writer).toBe(0);
  expect(capture(second).writer).toBe(1);
  expect(capture(first)).not.toBe(capture(second));
});

test("the service uses one checkpoint capture for both original ring views", () => {
  const source = readFileSync(
    new URL("./fixtures/gpu/ownership-service-worker.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("const capture = captureRingSnapshots();");
  expect(source).toContain("owners.map((owner) => ownerSnapshot(owner, capture))");
  expect(source).toContain("attempts.map((attempt) => attemptSnapshot(attempt, capture))");
});
