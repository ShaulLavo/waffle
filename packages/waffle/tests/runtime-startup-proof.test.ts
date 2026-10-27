import { expect, test } from "bun:test";
import type { RuntimeStartupStage } from "../fs/startup.js";
import { assertRuntimeStartupTrace } from "./runtime-startup-proof.js";

const timeOrigin = 1_790_000_000_000;
const ownerStages: RuntimeStartupStage[] = [
  "filesystem-worker-created",
  "filesystem-connect-requested",
];
const connected: RuntimeStartupStage[] = ["filesystem-connected"];
const locks: RuntimeStartupStage[] = ["filesystem-lock-requested", "filesystem-lock-acquired"];
const ready: RuntimeStartupStage[] = ["filesystem-ready"];
const sequences = {
  memory: ownerStages.concat(connected, ready),
  opfs: ownerStages.concat(connected, locks, ready),
  indexeddb: ownerStages.concat(
    connected,
    ["indexeddb-open-requested", "indexeddb-open-resolved"],
    locks,
    ["filesystem-epoch-requested", "filesystem-epoch-resolved"],
    ready,
  ),
};
function trace(stages = sequences.indexeddb): [RuntimeStartupStage, number][] {
  return stages.map((stage, index) => [stage, timeOrigin + 20 + index]);
}

test.each(Object.entries(sequences))(
  "%s startup keeps exact stages and epoch clocks",
  (_, stages) => {
    expect(() => assertRuntimeStartupTrace(trace(stages), stages, timeOrigin)).not.toThrow();
  },
);

test("different realm clock precision may put the first worker timestamp before the owner's send", () => {
  const seen = trace();
  seen[0]![1] = timeOrigin + 20.75;
  seen[1]![1] = timeOrigin + 20.875;
  seen[2]![1] = timeOrigin + 20.5;
  const original = structuredClone(seen);
  expect(seen[2]![1]).toBeLessThan(seen[1]![1]);
  expect(() => assertRuntimeStartupTrace(seen, sequences.indexeddb, timeOrigin)).not.toThrow();
  expect(seen).toEqual(original);
});

test("coarse clocks may repeat within each realm", () => {
  const seen: [RuntimeStartupStage, number][] = sequences.indexeddb.map((stage) => [
    stage,
    timeOrigin + 20,
  ]);
  expect(() => assertRuntimeStartupTrace(seen, sequences.indexeddb, timeOrigin)).not.toThrow();
});

test.each(["missing", "duplicate", "reordered"])("rejects %s startup stages", (kind) => {
  const seen = trace();
  if (kind === "missing") seen.splice(3, 1);
  if (kind === "duplicate") seen.splice(3, 0, ["indexeddb-open-requested", timeOrigin + 23]);
  if (kind === "reordered") {
    seen[3]![0] = "indexeddb-open-resolved";
    seen[4]![0] = "indexeddb-open-requested";
  }
  expect(() => assertRuntimeStartupTrace(seen, sequences.indexeddb, timeOrigin)).toThrow(
    "unexpected startup sequence",
  );
});

test.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])("rejects invalid epoch clocks at stage %i", (index) => {
  for (const timestamp of [NaN, Infinity, -Infinity, timeOrigin - 1, 0]) {
    const seen = trace();
    seen[index]![1] = timestamp;
    expect(() => assertRuntimeStartupTrace(seen, sequences.indexeddb, timeOrigin)).toThrow(
      "comparable epoch clocks",
    );
  }
});

test.each([1, 3, 4, 5, 6, 7, 8, 9])(
  "rejects a clock regression within the emitting realm at stage %i",
  (index) => {
    const seen = trace();
    seen[index]![1] = seen[index - 1]![1] - 0.25;
    expect(() => assertRuntimeStartupTrace(seen, sequences.indexeddb, timeOrigin)).toThrow(
      "milestone clocks follow operation order",
    );
  },
);
