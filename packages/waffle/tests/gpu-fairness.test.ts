import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("compiled fairness modes belong to the existing triangle producer", () => {
  const source = readFileSync(new URL("./fixtures/gpu/triangle.c", import.meta.url), "utf8");
  expect(source).toContain('"--fairness-heavy"');
  expect(source).toContain('"--fairness-peer"');
  expect(source).toContain('"--fairness-seed"');
});

import { FairnessObserver, fairnessMeasurements } from "./fixtures/gpu/fairness-observer.js";
import {
  measured,
  measuredExpectation,
  seedBaseline,
  seededComplete,
} from "./fixtures/gpu/fairness-test-data.js";
import { validateSeededCheckpoint } from "./fixtures/gpu/fairness-validation.js";
import { encodeBlob, words, rig } from "./fixtures/gpu/core-fixture.js";

test("fairness observer refuses unproven or partial service-realm coverage", () => {
  const observer = new FairnessObserver();
  expect(() => observer.arm()).toThrow("positive coverage");
  observer.native("draw", () => 1);
  observer.native("finish", () => 1);
  observer.native("submit", () => 1);
  expect(() => observer.arm()).toThrow("positive coverage");
});

test("observation preserves step and native results, records nested ordinals, and resets an armed epoch", async () => {
  let clock = 0;
  const observer = new FairnessObserver(() => ++clock);
  const { connection } = rig({ root: {} });
  const encoded = encodeBlob(10, words(14, [3, 1, 0, 0]));
  const accepted = { bytes: encoded, release() {} };
  const step = { kind: "progress", bytes: 24, presented: false } as const;
  try {
    observer.slice(connection, () => {
      observer.accept(connection.replay, accepted);
      expect(observer.step(connection.replay, () => step)).toBe(step);
      expect(observer.native("draw", () => 123)).toBe(123);
      observer.step(connection.replay, () => step);
      observer.step(connection.replay, () => ({ ...step, bytes: 0 }));
      for (const name of ["finish", "submit", "transferToImageBitmap", "transferFromImageBitmap"])
        observer.native(name, () => undefined);
      observer.queueCompletion(() => Promise.resolve());
      observer.accept(connection.replay, { bytes: words(6, [1, 4, 1]), release() {} });
      observer.step(connection.replay, () => ({ ...step, presented: true }));
      return { kind: "yield", bytes: encoded.length + 24 };
    });
    await Promise.resolve();
    const coverage = observer.arm();
    expect(coverage.slices[0]).toMatchObject({
      records: 3,
      draws: 1,
      firstRecord: 1,
      lastRecord: 3,
    });
    expect(coverage.records["1:nested:14"]?.count).toBe(1);
    expect(coverage.presents).toHaveLength(1);
    expect(observer.snapshot()).toMatchObject({ epoch: 1, armed: true, records: {}, slices: [] });
  } finally {
    connection.close();
  }
});

test("fairness measurements keep slice and presentation targets and native-call overruns visible", () => {
  const normal = measured();
  expect(fairnessMeasurements(normal, measuredExpectation)).toMatchObject({
    draws: 200000,
    drawSlices: 20,
    peerPresentsDuringReplay: 3,
    sliceTargetMet: true,
    peerGapTargetMet: true,
  });
  const first = normal.slices.find((value) => value.draws === 10000)!;
  const extend = (nativeMs: number) => ({
    ...normal,
    slices: normal.slices.map((value) =>
      value === first
        ? { ...first, end: first.start + 9, nativeMs, longestNativeMs: nativeMs }
        : value,
    ),
    native: { ...normal.native, "1:draw": { count: 200000, totalMs: nativeMs, maxMs: nativeMs } },
  });
  const slow = fairnessMeasurements(extend(8.5), measuredExpectation);
  expect(slow.sliceTargetMet).toBe(false);
  expect(slow.oversize[0]?.classification).toBe("indivisible-browser-call");
  expect(fairnessMeasurements(extend(0), measuredExpectation).oversize[0]?.classification).toBe(
    "replay-or-service-thread-pause",
  );
  // A complete observation may miss the unchanged latency target without missing evidence.
  expect(fairnessMeasurements(measured(185), measuredExpectation).peerGapTargetMet).toBe(false);
});
test("fairness rejects stale, missing, truncated and noninterleaved evidence", () => {
  const normal = measured();
  for (const invalid of [
    { ...normal, armed: false },
    { ...normal, overflow: true },
    { ...normal, epoch: 0 },
    { ...normal, blobs: [] },
    { ...normal, blobs: normal.blobs.concat(normal.blobs) },
    {
      ...normal,
      blobs: normal.blobs.map((blob) => ({ ...blob, commandRingBytes: 8 * 1024 * 1024 })),
    },
    { ...normal, slices: normal.slices.slice(1) },
    {
      ...normal,
      presents: normal.presents.map((present) => ({ ...present, otherLargeDraws: [] })),
    },
  ])
    expect(() => fairnessMeasurements(invalid, measuredExpectation)).toThrow();
});

test("native queue completion observation distinguishes pending, completed and rejected work", async () => {
  let clock = 0;
  const observer = new FairnessObserver(() => clock);
  const pending = Promise.withResolvers<void>();
  observer.queueCompletion(() => pending.promise);
  expect(observer.snapshot().queue[0]?.settlement.kind).toBe("pending");
  clock = 2;
  pending.resolve();
  await Promise.resolve();
  expect(observer.snapshot().queue[0]?.settlement).toEqual({ kind: "completed", at: 2 });
  observer.queueCompletion(() => Promise.reject(new Error("device closed")));
  await Promise.resolve();
  expect(observer.snapshot().queue[1]?.settlement.kind).toBe("rejected");
  observer.queueCompletion(() => {
    throw new Error("native failure");
  });
  expect(observer.snapshot().queue[2]?.settlement.kind).toBe("rejected");
});

test("large-blob proof rejects missing native, record, peer and queue observations", () => {
  const normal = measured();
  for (const invalid of [
    { ...normal, records: {} },
    { ...normal, native: {} },
    { ...normal, queue: [] },
    { ...normal, slices: normal.slices.filter((slice) => slice.connection === 1) },
    { ...normal, slices: normal.slices.map((slice) => ({ ...slice, firstRecord: 999999 })) },
    { ...normal, presents: normal.presents.map((present) => ({ ...present, at: -present.at })) },
  ])
    expect(() => fairnessMeasurements(invalid, measuredExpectation)).toThrow();
});

test("large-blob proof rejects incomplete and inconsistent per-connection queue accounting", () => {
  const normal = measured();
  for (const invalid of [
    { ...normal, epoch: 2 },
    {
      ...normal,
      queue: normal.queue.map((sample) => ({
        ...sample,
        settlement: { kind: "pending" as const },
      })),
    },
    {
      ...normal,
      queue: normal.queue.map((sample) => ({
        ...sample,
        settlement: { kind: "rejected" as const, at: 1 },
      })),
    },
    { ...normal, queue: normal.queue.slice(1) },
    { ...normal, queue: normal.queue.map((sample) => ({ ...sample, connection: 1 })) },
    { ...normal, at: Infinity },
    { ...normal, native: { ...normal.native, "1:submit": { count: 1, totalMs: 0, maxMs: 0 } } },
    {
      ...normal,
      records: { ...normal.records, "2:nested:14": { count: 127, totalMs: 0, maxMs: 0 } },
    },
    { ...normal, slices: normal.slices.map((sample) => ({ ...sample, records: -1 })) },
  ])
    expect(() => fairnessMeasurements(invalid, measuredExpectation)).toThrow();
});

test("seeded completion binds exact epochs, observed totals and physically retired resources", () => {
  const normal = seededComplete();
  const progress = [1, 2, 3].map((connection) => ({ connection, frame: 4, stage: 0 }));
  const validate = (value: typeof normal) =>
    validateSeededCheckpoint(value, progress, 1, seedBaseline, "complete");
  expect(validate(normal).size).toBe(3);
  for (const invalid of [
    { ...normal, connections: -123 },
    { ...normal, frameTexturesLive: -456 },
    { ...normal, slices: -789 },
    { ...normal, devicesLive: 1 },
    { ...normal, presentCanvasesLive: 1 },
    { ...normal, heapBytes: 1 },
    { ...normal, presents: 9 },
    { ...normal, frameTexturesCreated: 9 },
    { ...normal, fairness: { ...normal.fairness, epoch: 0 } },
    { ...normal, fairness: { ...normal.fairness, overflow: true } },
    { ...normal, fairness: { ...normal.fairness, armed: false } },
    { ...normal, fairness: { ...normal.fairness, records: {} } },
    { ...normal, fairness: { ...normal.fairness, native: {} } },
    { ...normal, fairness: { ...normal.fairness, slices: [] } },
    { ...normal, fairness: { ...normal.fairness, queue: [] } },
  ])
    expect(() => validate(invalid)).toThrow("Invalid fairness observation");
});
