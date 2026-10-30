import assert from "node:assert/strict";
import { test } from "node:test";
import { executeNative } from "./record-jq-oracle.ts";
import { runEvaluator } from "./evaluator-command.ts";

test("native oracle preserves a completed command's output", () => {
  const result = executeNative(process.execPath, {
    name: "completed deadline control",
    args: ["-e", "process.stdout.write('complete\\n')"],
  });
  assert.equal(result.exit, 0);
  assert.equal(result.stdout, "complete\n");
});

test("native oracle terminates a nonterminating evaluator at its deadline", () => {
  assert.throws(
    () =>
      executeNative(
        process.execPath,
        {
          name: "nonterminating deadline control",
          args: ["-e", "process.title='jq-deadline-test'; setInterval(() => {}, 1000)"],
        },
        150,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("nonterminating deadline control") &&
      error.message.includes(process.execPath) &&
      error.cause !== null &&
      typeof error.cause === "object" &&
      "code" in error.cause &&
      error.cause.code === "ETIMEDOUT",
  );
});

test("evaluator deadlines cannot be disabled or widened", () => {
  for (const timeoutMs of [0, -1, 15_001, Number.NaN]) {
    assert.throws(
      () =>
        runEvaluator(
          { name: "invalid deadline", executable: process.execPath, args: ["--version"] },
          timeoutMs,
        ),
      RangeError,
    );
  }
});
