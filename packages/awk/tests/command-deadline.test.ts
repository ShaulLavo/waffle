import assert from "node:assert/strict";
import { test } from "node:test";
import { runEvaluator } from "./evaluator-command.ts";

test("evaluator preserves completed output", () => {
  const result = runEvaluator({
    name: "completed deadline control",
    executable: process.execPath,
    args: ["-e", "process.stdout.write('complete\\n')"],
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "complete\n");
});

test("evaluator terminates a nonterminating process at its deadline", () => {
  assert.throws(
    () =>
      runEvaluator(
        {
          name: "nonterminating deadline control",
          executable: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
        150,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("nonterminating deadline control") &&
      error.cause !== null &&
      typeof error.cause === "object" &&
      "code" in error.cause &&
      error.cause.code === "ETIMEDOUT",
  );
});

test("evaluator deadlines are bounded", () => {
  for (const timeoutMs of [0, -1, 15_001, Number.NaN])
    assert.throws(
      () =>
        runEvaluator(
          { name: "invalid deadline", executable: process.execPath, args: ["--version"] },
          timeoutMs,
        ),
      RangeError,
    );
});
