import { expect, test } from "bun:test";
import { checkTeardownDeadline } from "./host-drive-controls.js";

type DeadlineResult = Parameters<typeof checkTeardownDeadline>[0];
function hostTimeout(): DeadlineResult {
  return {
    results: {
      host: { body: { status: "pass", result: { ok: true } }, teardown: { status: "not-entered" } },
    },
    failures: [
      { group: "host", category: "host", detail: "TimeoutError: The operation timed out." },
    ],
    runComplete: false,
  };
}

test("independent teardown control accepts the host cutoff before the page report arrives", () => {
  expect(() => checkTeardownDeadline(hostTimeout())).not.toThrow();
});

test("independent teardown control still accepts the original page timeout evidence", () => {
  const result = hostTimeout();
  result.results.host = {
    body: { status: "pass" },
    teardown: { status: "timeout", settled: false },
  };
  result.failures = [];
  expect(() => checkTeardownDeadline(result)).not.toThrow();
});

test("independent teardown control rejects a completed hook without timeout evidence", () => {
  const result = hostTimeout();
  result.results.host = { body: { status: "pass" }, teardown: { status: "pass" } };
  result.failures = [];
  result.runComplete = true;
  expect(() => checkTeardownDeadline(result)).toThrow(
    "Body timeout extension changed the independent teardown clock",
  );
});

for (const mismatch of ["body", "category", "group", "detail", "extra", "complete"] as const) {
  test(`independent teardown control rejects unrelated ${mismatch} failure`, () => {
    const result = hostTimeout();
    const failure = result.failures[0];
    if (!failure) throw new Error("Missing test failure");
    if (mismatch === "body")
      result.results.host = { body: { status: "fail" }, teardown: { status: "not-entered" } };
    if (mismatch === "category") failure.category = "page-unresponsive";
    if (mismatch === "group") failure.group = "list";
    if (mismatch === "detail") failure.detail = "Uncertain host dispatch";
    if (mismatch === "extra")
      result.failures.push({ group: "host", category: "host", detail: "Other failure" });
    if (mismatch === "complete") result.runComplete = true;
    expect(() => checkTeardownDeadline(result)).toThrow(
      "Body timeout extension changed the independent teardown clock",
    );
  });
}
