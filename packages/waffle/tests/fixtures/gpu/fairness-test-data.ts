import type { FairnessSnapshot, FairnessSlice } from "./fairness-observer.js";
import type { SeedServiceSnapshot } from "./fairness-validation.js";

type Aggregate = FairnessSnapshot["records"][string];
const zero = (count: number): Aggregate => ({ count, totalMs: 0, maxMs: 0 });
export const measuredExpectation = { epoch: 1, connections: [1, 2], peerFrames: 128 };
export const seedBaseline = { presents: 1, frameTexturesCreated: 1, slices: 10 };

function inventory(id: number, frames: number, heavy = false) {
  const values: Record<string, Aggregate> = {};
  const set = (kind: string, opcode: number, count: number) => {
    values[`${id}:${kind}:${opcode}`] = zero(count);
  };
  for (const opcode of [1, 2, 3, 4, 7, 8, 9]) set("top", opcode, 1);
  for (const opcode of [5, 10, 11, 0x1001, 17, 6]) set("top", opcode, frames);
  for (const opcode of [12, 13, 15, 16]) set("nested", opcode, frames);
  set("nested", 14, heavy ? 200000 : frames);
  for (const opcode of [19, 20]) set("top", opcode, heavy ? 3 : 2 * frames);
  if (!heavy) set("top", 0x1000, 5 * frames);
  return values;
}
function native(id: number, frames: number, draws = frames) {
  return Object.fromEntries(
    [
      ["draw", draws],
      ["finish", 2 * frames],
      ["submit", 2 * frames],
      ["transferToImageBitmap", frames],
      ["transferFromImageBitmap", frames],
    ].map(([name, count]) => [`${id}:${name}`, zero(Number(count))]),
  );
}
function slice(
  connection: number,
  start: number,
  end: number,
  records: number,
  draws: number,
): FairnessSlice {
  return {
    connection,
    start,
    end,
    records,
    draws,
    nativeMs: 0,
    longestNativeMs: 0,
    firstRecord: 0,
    lastRecord: 0,
    bytes: records * 24,
    kind: "yield",
  };
}
function ordinalSlices(slices: FairnessSlice[]): FairnessSlice[] {
  const counts = new Map<number, number>();
  slices.sort((left, right) => left.start - right.start);
  return slices.map((value) => {
    const previous = counts.get(value.connection) ?? 0;
    counts.set(value.connection, previous + value.records);
    return { ...value, firstRecord: previous + 1, lastRecord: previous + value.records };
  });
}
export function measured(peerMidpoint = 135): FairnessSnapshot {
  const peerTimes = [5, 65, peerMidpoint, 195, 230].concat(
    Array.from({ length: 123 }, (_, index) => 250 + 20 * index),
  );
  const heavy = [slice(1, 1, 4, 13, 0)].concat(
    Array.from({ length: 20 }, (_, index) =>
      slice(
        1,
        10 + index * 10,
        14 + index * 10,
        10000 + (index === 0 ? 3 : 0) + (index === 19 ? 2 : 0),
        10000,
      ),
    ),
    [slice(1, 218, 224, 5, 0)],
  );
  const slices = ordinalSlices(
    heavy.concat(
      peerTimes.map((time, index) => slice(2, time - 0.5, time + 0.1, index === 0 ? 27 : 20, 1)),
    ),
  );
  const presents = peerTimes
    .map((at) => ({
      connection: 2,
      at,
      otherLargeDraws: at > 10 && at < 204 ? [Math.floor((at - 4) / 10) * 10000] : [],
    }))
    .concat([{ connection: 1, at: 220, otherLargeDraws: [] }]);
  presents.sort((left, right) => left.at - right.at);
  const queue = presents.flatMap((present) =>
    [0, 0.01].map((offset) => ({
      connection: present.connection,
      start: present.at + offset,
      settlement: { kind: "completed" as const, at: present.at + 1 },
    })),
  );
  return {
    at: 3000,
    epoch: 1,
    armed: true,
    overflow: false,
    slices,
    presents,
    queue,
    records: { ...inventory(1, 1, true), ...inventory(2, 128) },
    native: { ...native(1, 1, 200000), ...native(2, 128) },
    blobs: [
      {
        connection: 1,
        commandRingBytes: 4 * 1024 * 1024,
        bytes: 4800184,
        draws: 200000,
        start: 10,
        end: 204,
      },
    ],
  };
}
export function seededComplete(): SeedServiceSnapshot {
  const ids = [1, 2, 3];
  const slices = ordinalSlices(ids.map((id) => slice(id, 10 * id, 10 * id + 6, 79, 3)));
  const presents = ids.flatMap((id) =>
    [1, 2, 3].map((frame) => ({
      connection: id,
      at: 10 * id + frame,
      otherLargeDraws: [],
    })),
  );
  const records = Object.assign({}, ...ids.map((id) => inventory(id, 3)));
  for (const id of ids) {
    records[`${id}:top:19`] = zero(12);
    records[`${id}:top:20`] = zero(12);
  }
  return {
    connections: 0,
    devicesLive: 0,
    heapBytes: 0,
    slices: 13,
    presents: 10,
    frameTexturesCreated: 10,
    frameTexturesLive: 0,
    presentCanvasesLive: 0,
    fairness: {
      at: 50,
      epoch: 1,
      armed: true,
      overflow: false,
      slices,
      presents,
      blobs: [],
      records,
      native: Object.assign({}, ...ids.map((id) => native(id, 3))),
      queue: ids.flatMap((id) =>
        Array.from({ length: 6 }, (_, at) => ({
          connection: id,
          start: 10 * id + at,
          settlement: { kind: "completed" as const, at: 10 * id + at + 1 },
        })),
      ),
    },
  };
}
