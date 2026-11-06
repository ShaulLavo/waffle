import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("compiled fairness modes belong to the existing triangle producer", () => {
  const source = readFileSync(new URL("./fixtures/gpu/triangle.c", import.meta.url), "utf8");
  expect(source).toContain('"--fairness-heavy"');
  expect(source).toContain('"--fairness-peer"');
  expect(source).toContain('"--fairness-seed"');
});

import {
  FairnessObserver,
  fairnessMeasurements,
  type FairnessSnapshot,
} from "./fixtures/gpu/fairness-observer.js";
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

function measured(): FairnessSnapshot {
  return {
    epoch: 1,
    armed: true,
    overflow: false,
    blobs: [
      {
        connection: 1,
        commandRingBytes: 4 * 1024 * 1024,
        bytes: 4800184,
        draws: 200000,
        start: 10,
        end: 210,
      },
    ],
    records: {},
    native: {},
    queue: [],
    slices: Array.from({ length: 20 }, (_, index) => ({
      connection: 1,
      start: 10 + index * 10,
      end: 14 + index * 10,
      records: 10000,
      draws: 10000,
      nativeMs: 1,
      longestNativeMs: 0.2,
      firstRecord: 1 + index * 10000,
      lastRecord: 10000 + index * 10000,
      bytes: 240000,
      kind: "yield",
    })),
    presents: [
      { connection: 2, at: 5, otherLargeDraws: [] },
      { connection: 2, at: 60, otherLargeDraws: [50000] },
      { connection: 2, at: 130, otherLargeDraws: [120000] },
      { connection: 2, at: 200, otherLargeDraws: [190000] },
      { connection: 1, at: 220, otherLargeDraws: [] },
      { connection: 2, at: 230, otherLargeDraws: [] },
    ],
  };
}
test("fairness measurements keep slice and presentation targets and native-call overruns visible", () => {
  const normal = measured();
  expect(fairnessMeasurements(normal)).toMatchObject({
    draws: 200000,
    drawSlices: 20,
    peerPresentsDuringReplay: 3,
    sliceTargetMet: true,
    peerGapTargetMet: true,
  });
  const first = normal.slices[0]!;
  const browserCall = {
    ...normal,
    slices: [{ ...first, end: first.start + 32, longestNativeMs: 30 }].concat(
      normal.slices.slice(1),
    ),
  };
  const slow = fairnessMeasurements(browserCall);
  expect(slow.sliceTargetMet).toBe(false);
  expect(slow.oversize[0]?.classification).toBe("indivisible-browser-call");
  const replayPause = {
    ...normal,
    slices: [{ ...first, end: first.start + 32 }].concat(normal.slices.slice(1)),
  };
  expect(fairnessMeasurements(replayPause).oversize[0]?.classification).toBe(
    "replay-or-service-thread-pause",
  );
  const gap = { ...normal, presents: normal.presents.filter((present) => present.at !== 130) };
  expect(fairnessMeasurements(gap).peerGapTargetMet).toBe(false);
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
    expect(() => fairnessMeasurements(invalid)).toThrow();
});

test("native queue completion observation distinguishes pending, completed and rejected work", async () => {
  let clock = 0;
  const observer = new FairnessObserver(() => ++clock);
  const pending = Promise.withResolvers<void>();
  observer.queueCompletion(() => pending.promise);
  expect(observer.snapshot().queue[0]?.settlement.kind).toBe("pending");
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
