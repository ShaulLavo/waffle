import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "./command.ts";

test("command helper preserves a completed process result", () => {
  const result = runCommand({
    name: "completed deadline control",
    executable: process.execPath,
    args: ["-e", "process.stdout.write('complete\\n')"],
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "complete\n");
});

test("command helper preserves a completed result when stdin closes early", () => {
  const result = runCommand({
    name: "early stdin close control",
    executable: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      "process.stdout.write(\"out\"); process.stderr.write(\"err\"); process.exit(7)",
    ],
    input: "x".repeat(4 * 1024 * 1024),
  });
  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
});

test("command helper terminates a nonterminating process at its deadline", () => {
  assert.throws(
    () =>
      runCommand(
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

test("command deadlines cannot be disabled or widened", () => {
  for (const timeoutMs of [0, -1, 15_001, Number.NaN]) {
    assert.throws(
      () =>
        runCommand(
          { name: "invalid deadline", executable: process.execPath, args: ["--version"] },
          timeoutMs,
        ),
      RangeError,
    );
  }
});
