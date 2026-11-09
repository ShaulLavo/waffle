import { expect, test } from "bun:test";
import { Collector, type Group } from "./collector.js";

function interrupted() {
  const collector = new Collector("run", ["case"], ["case"], {
    listIds: () => ["case"],
    check() {},
  });
  const prior = collector.expect(
    { id: "case", role: "case", caseIds: ["case"] },
    "old",
    "http://fixture/old",
    "root",
  );
  collector.receive({
    run: "run",
    doc: "old-document",
    seq: 0,
    kind: "hello",
    token: "old",
    group: "case",
  });
  collector.fail("page-error", "ORIGINAL_FAILURE", prior);
  collector.abandon("ORIGINAL_FAILURE");
  return { collector, prior };
}
function cleanup(
  collector: Collector,
  group: Group = { id: "cleanup-finish", role: "finish", caseIds: [] },
) {
  return collector.expect(group, "cleanup", "http://fixture/cleanup", "root", true);
}

test("fresh host cleanup can retire without reviving the failed execution document", () => {
  const { collector, prior } = interrupted();
  const state = cleanup(collector);
  collector.receive({
    run: "run",
    doc: "cleanup-document",
    seq: 0,
    kind: "hello",
    token: "cleanup",
    group: "cleanup-finish",
  });
  expect(collector.reply(false, state)).toEqual({ kind: "live", retire: false });
  expect(collector.reply(true, prior)).toEqual({ kind: "cancelled" });
  expect(collector.reply()).toEqual({ kind: "cancelled" });
  expect(
    collector.heartbeat({ run: "run", doc: "cleanup-document", kind: "heartbeat", failure: null }),
  ).toEqual({ kind: "live", retire: false });
  collector.receive({
    run: "run",
    doc: "cleanup-document",
    seq: 1,
    kind: "run-complete",
    remaining: [],
  });
  collector.receive({ run: "run", doc: "cleanup-document", seq: 2, kind: "doc-complete" });
  state.retiring = true;
  expect(collector.reply(true, state)).toEqual({ kind: "live", retire: true });
  collector.receive({ run: "run", doc: "cleanup-document", seq: 3, kind: "retire-ready" });
  collector.retire(state, 3);
  expect(collector.reply(true, state)).toEqual({ kind: "cancelled" });
  expect(collector.failures).toEqual([
    { group: "case", category: "page-error", detail: "ORIGINAL_FAILURE" },
  ]);
  expect(collector.outcomes.case?.status).toBe("host");
});

test("ordinary new documents cannot execute after run cancellation", () => {
  const { collector } = interrupted();
  const count = collector.documents.length;
  expect(() =>
    collector.expect(
      { id: "finish", role: "finish", caseIds: [] },
      "normal",
      "http://fixture/normal",
      "root",
    ),
  ).toThrow("cancelled");
  expect(collector.documents).toHaveLength(count);
  expect(collector.reply()).toEqual({ kind: "cancelled" });
});

for (const role of ["list", "case", "peer"] as const) {
  test(`cleanup admission refuses an execution ${role} scope`, () => {
    const { collector } = interrupted();
    const count = collector.documents.length;
    expect(() => cleanup(collector, { id: "wrong", role, caseIds: [] })).toThrow("cleanup");
    expect(collector.documents).toHaveLength(count);
    expect(collector.reply()).toEqual({ kind: "cancelled" });
  });
}
test("cleanup admission refuses guest cases in a finish group", () => {
  const { collector } = interrupted();
  expect(() => cleanup(collector, { id: "wrong", role: "finish", caseIds: ["case"] })).toThrow(
    "cleanup",
  );
});

test("fresh cleanup failure closes its own admission and cannot be resumed again", () => {
  const { collector } = interrupted();
  const state = cleanup(collector);
  collector.fail("collector", "CLEANUP_FAILURE", state);
  expect(collector.reply(true, state)).toEqual({ kind: "cancelled" });
  expect(() => cleanup(collector)).toThrow("cleanup");
  expect(collector.failures.map((failure) => failure.detail)).toEqual([
    "ORIGINAL_FAILURE",
    "CLEANUP_FAILURE",
  ]);
});

test("cleanup permission belongs to the exact document object, not copied metadata", () => {
  const { collector } = interrupted();
  const state = cleanup(collector);
  expect(collector.reply(true, { ...state })).toEqual({ kind: "cancelled" });
  expect(collector.reply(true, state)).toEqual({ kind: "live", retire: true });
});
