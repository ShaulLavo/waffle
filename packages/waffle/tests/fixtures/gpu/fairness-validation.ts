import { GPU_LIMITS } from "../../../browser/gpu/protocol.js";
import type { FairnessSnapshot, FairnessSlice } from "./fairness-observer.js";

export interface ObservationExpectation {
  readonly epoch: number;
  readonly connections: readonly number[];
  readonly phase: "checkpoint" | "complete";
}
interface Totals {
  records: number;
  draws: number;
  visits: number;
  nativeMs: number;
}
const nativeNames = [
  "draw",
  "finish",
  "submit",
  "transferToImageBitmap",
  "transferFromImageBitmap",
];
const epsilon = 0.000001;
function fail(message: string): never {
  throw new Error(`Invalid fairness observation: ${message}`);
}
function number(value: number, name: string, integer = false): void {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) fail(name);
}
function interval(start: number, end: number, at: number): void {
  number(start, "start time");
  number(end, "end time");
  if (end < start || end > at) fail("unordered timestamp");
}
function aggregate(value: FairnessSnapshot["records"][string]): void {
  if (!value) fail("missing aggregate");
  number(value.count, "aggregate count", true);
  number(value.totalMs, "aggregate duration");
  number(value.maxMs, "aggregate maximum");
  if (!value.count || value.maxMs > value.totalMs + epsilon) fail("inconsistent aggregate");
}
function total(values: Map<number, Totals>, id: number): Totals {
  const value = values.get(id);
  if (!value) fail("unexpected connection identity");
  return value;
}
export function fairnessConnectionIds(snapshot: FairnessSnapshot): number[] {
  const ids = Array.from(new Set(snapshot.slices.map((slice) => slice.connection)));
  return ids.sort((left, right) => left - right);
}
export function wireCount(snapshot: FairnessSnapshot, id: number, opcode: number): number {
  return (
    (snapshot.records[`${id}:top:${opcode}`]?.count ?? 0) +
    (snapshot.records[`${id}:nested:${opcode}`]?.count ?? 0)
  );
}
function nativeCount(snapshot: FairnessSnapshot, id: number, name: string): number {
  return snapshot.native[`${id}:${name}`]?.count ?? 0;
}
function contains(slice: FairnessSlice, id: number, at: number): boolean {
  return slice.connection === id && slice.start <= at && at <= slice.end;
}
function validateSlices(snapshot: FairnessSnapshot, totals: Map<number, Totals>): void {
  let previousEnd = 0;
  for (const slice of snapshot.slices) {
    const owner = total(totals, slice.connection);
    interval(slice.start, slice.end, snapshot.at);
    if (!["yield", "idle", "await", "terminal"].includes(slice.kind)) fail("slice result kind");
    for (const value of [
      slice.records,
      slice.draws,
      slice.firstRecord,
      slice.lastRecord,
      slice.bytes,
    ])
      number(value, "slice integer", true);
    number(slice.nativeMs, "slice native duration");
    number(slice.longestNativeMs, "slice longest native call");
    if (
      slice.start + epsilon < previousEnd ||
      slice.draws > slice.records ||
      slice.firstRecord !== owner.records + 1 ||
      slice.lastRecord !== owner.records + slice.records ||
      slice.nativeMs > slice.end - slice.start + epsilon ||
      slice.longestNativeMs > slice.nativeMs + epsilon
    )
      fail("inconsistent slice");
    previousEnd = slice.end;
    owner.records += slice.records;
    owner.draws += slice.draws;
    owner.nativeMs += slice.nativeMs;
    owner.visits++;
  }
}
function validateRecords(snapshot: FairnessSnapshot, totals: Map<number, Totals>): void {
  const counts = new Map<number, number>();
  for (const [key, value] of Object.entries(snapshot.records)) {
    const parts = /^(\d+):(top|nested):(\d+)$/.exec(key);
    if (!parts || Number(parts[3]) < 1 || Number(parts[3]) > 65535) fail("invalid record identity");
    const id = Number(parts[1]);
    total(totals, id);
    aggregate(value);
    counts.set(id, (counts.get(id) ?? 0) + value.count);
  }
  for (const [id, owner] of totals) {
    if (
      !owner.visits ||
      owner.records !== counts.get(id) ||
      owner.draws !== wireCount(snapshot, id, 14)
    )
      fail("missing or inconsistent per-connection records");
  }
}
function validateNative(snapshot: FairnessSnapshot, totals: Map<number, Totals>): void {
  const durations = new Map<number, number>();
  for (const [key, value] of Object.entries(snapshot.native)) {
    const parts = /^(\d+):(.+)$/.exec(key);
    if (!parts || !nativeNames.includes(parts[2]!)) fail("invalid native identity");
    const id = Number(parts[1]);
    total(totals, id);
    aggregate(value);
    durations.set(id, (durations.get(id) ?? 0) + value.totalMs);
  }
  for (const [id, owner] of totals) {
    const presents = wireCount(snapshot, id, 6);
    const expected = [
      owner.draws,
      wireCount(snapshot, id, 16) + presents,
      wireCount(snapshot, id, 17) + presents,
      presents,
      presents,
    ];
    if (
      nativeNames.some((name, at) => nativeCount(snapshot, id, name) !== expected[at]) ||
      Math.abs((durations.get(id) ?? 0) - owner.nativeMs) > epsilon
    )
      fail("missing or inconsistent per-connection native calls");
  }
}
function validatePresents(snapshot: FairnessSnapshot, totals: Map<number, Totals>): void {
  const counts = new Map<number, number>();
  let previous = 0;
  for (const present of snapshot.presents) {
    total(totals, present.connection);
    interval(present.at, present.at, snapshot.at);
    if (
      present.at < previous ||
      !snapshot.slices.some((slice) => contains(slice, present.connection, present.at))
    )
      fail("presentation outside its observed connection slice");
    const interleaved = snapshot.blobs.filter(
      (blob) =>
        blob.connection !== present.connection &&
        blob.start <= present.at &&
        (blob.end === null || present.at < blob.end),
    );
    const observed = interleaved.map((blob) =>
      snapshot.slices.reduce(
        (sum, slice) =>
          sum + (slice.connection === blob.connection && slice.end <= present.at ? slice.draws : 0),
        0,
      ),
    );
    if (
      present.otherLargeDraws.length !== observed.length ||
      observed.some((draws, index) => draws !== present.otherLargeDraws[index])
    )
      fail("inconsistent interleaved draw count");
    counts.set(present.connection, (counts.get(present.connection) ?? 0) + 1);
    previous = present.at;
  }
  for (const id of totals.keys())
    if ((counts.get(id) ?? 0) !== wireCount(snapshot, id, 6)) fail("presentation count mismatch");
}
function validateQueues(
  snapshot: FairnessSnapshot,
  totals: Map<number, Totals>,
  complete: boolean,
): void {
  const counts = new Map<number, number>();
  for (const sample of snapshot.queue) {
    total(totals, sample.connection);
    interval(sample.start, sample.start, snapshot.at);
    if (!snapshot.slices.some((slice) => contains(slice, sample.connection, sample.start)))
      fail("queue observation outside its connection slice");
    if (
      sample.settlement.kind === "rejected" ||
      (complete && sample.settlement.kind !== "completed")
    )
      fail("incomplete or rejected native queue observation");
    if (sample.settlement.kind !== "pending")
      interval(sample.start, sample.settlement.at, snapshot.at);
    counts.set(sample.connection, (counts.get(sample.connection) ?? 0) + 1);
  }
  for (const id of totals.keys())
    if ((counts.get(id) ?? 0) !== nativeCount(snapshot, id, "submit"))
      fail("missing native queue observation");
}
export function validateFairnessObservation(
  snapshot: FairnessSnapshot,
  expected: ObservationExpectation,
) {
  number(snapshot.at, "snapshot time");
  if (
    !Number.isSafeInteger(expected.epoch) ||
    expected.epoch < 1 ||
    snapshot.epoch !== expected.epoch ||
    !snapshot.armed ||
    snapshot.overflow
  )
    fail("epoch, arming or overflow");
  const totals = new Map<number, Totals>();
  for (const id of expected.connections) {
    number(id, "connection identity", true);
    if (!id || totals.has(id)) fail("duplicate or empty connection identity");
    totals.set(id, { records: 0, draws: 0, visits: 0, nativeMs: 0 });
  }
  if (!totals.size || totals.size > 8) fail("connection cohort");
  for (const values of [snapshot.slices, snapshot.presents, snapshot.queue, snapshot.blobs])
    if (values.length > 8192) fail("unbounded observation");
  validateSlices(snapshot, totals);
  validateRecords(snapshot, totals);
  validateNative(snapshot, totals);
  validatePresents(snapshot, totals);
  validateQueues(snapshot, totals, expected.phase === "complete");
  for (const blob of snapshot.blobs) {
    total(totals, blob.connection);
    number(blob.bytes, "blob size", true);
    number(blob.draws, "blob draws", true);
    number(blob.commandRingBytes, "ring size", true);
    interval(blob.start, blob.end ?? snapshot.at, snapshot.at);
  }
  return totals;
}
export interface SeedProgress {
  readonly connection: number;
  readonly frame: number;
  readonly stage: number;
}
export interface SeedBaseline {
  readonly presents: number;
  readonly frameTexturesCreated: number;
  readonly slices: number;
}
export interface SeedServiceSnapshot {
  readonly connections: number;
  readonly devicesLive: number;
  readonly slices: number;
  readonly heapBytes: number;
  readonly presents: number;
  readonly frameTexturesCreated: number;
  readonly frameTexturesLive: number;
  readonly presentCanvasesLive: number;
  readonly fairness: FairnessSnapshot;
}
export function validateSeededCheckpoint(
  value: SeedServiceSnapshot,
  progress: readonly SeedProgress[],
  epoch: number,
  baseline: SeedBaseline,
  phase: ObservationExpectation["phase"] = "checkpoint",
) {
  const totals = validateFairnessObservation(value.fairness, {
    epoch,
    connections: progress.map((item) => item.connection),
    phase,
  });
  for (const count of [
    value.connections,
    value.devicesLive,
    value.slices,
    value.heapBytes,
    value.presents,
    value.frameTexturesCreated,
    value.frameTexturesLive,
    value.presentCanvasesLive,
  ])
    number(count, "service resource count", true);
  for (const count of [baseline.presents, baseline.frameTexturesCreated, baseline.slices])
    number(count, "baseline resource count", true);
  if (value.heapBytes > GPU_LIMITS.serviceBytes || (value.connections > 0 && value.heapBytes === 0))
    fail("seeded service heap");
  let live = 0,
    frames = 0,
    presents = 0,
    acquired = 0;
  for (const item of progress) {
    number(item.frame, "seed frame", true);
    number(item.stage, "seed stage", true);
    if (
      item.frame < 1 ||
      item.frame > 4 ||
      item.stage > 4 ||
      (item.frame === 4 && item.stage !== 0)
    )
      fail("seed cursor");
    const closed = item.frame === 4;
    live += Number(!closed);
    frames += Number(!closed && item.stage !== 4);
    acquired += Math.min(item.frame, 3);
    const count = closed ? 3 : item.frame - 1 + Number(item.stage === 4);
    const draws = closed ? 3 : item.frame - 1 + Number(item.stage >= 2);
    const records = closed ? 79 : [9, 13, 21, 23, 31][item.stage]! + 24 * (item.frame - 1);
    const owner = total(totals, item.connection);
    if (
      owner.records !== records ||
      owner.draws !== draws ||
      wireCount(value.fairness, item.connection, 6) !== count
    )
      fail("seeded per-connection checkpoint counts");
    if (owner.visits > value.slices - baseline.slices) fail("missing service visits");
    presents += count;
  }
  if (
    value.connections !== live ||
    value.devicesLive !== live ||
    value.frameTexturesLive !== frames ||
    value.presentCanvasesLive !== live ||
    value.presents !== baseline.presents + presents ||
    value.frameTexturesCreated !== baseline.frameTexturesCreated + acquired ||
    value.slices < baseline.slices ||
    (!live && value.heapBytes !== 0)
  )
    fail("seeded resource state");
  return totals;
}
