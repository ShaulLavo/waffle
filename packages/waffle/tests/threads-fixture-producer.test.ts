import { Glob, YAML } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedThreadFixture } from "../scripts/build-thread-fixture.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected a workflow mapping");
  return Object.fromEntries(Object.entries(value));
}

const workflow = record(
  YAML.parse(
    readFileSync(
      new URL("../../../.github/workflows/threads-fixture.yml", import.meta.url),
      "utf8",
    ),
  ),
);
const events = record(workflow.on);
const producer = record(record(workflow.jobs).producer);
const compile =
  "bun test ./packages/waffle/scripts/threads-fixture-producer.test.ts --timeout 120000";

function patterns(event: "push" | "pull_request"): string[] {
  const paths = record(events[event]).paths;
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string"))
    throw new Error("expected fixture input paths");
  return paths;
}

test("real fixture compilation is selected for every producer input, not unrelated runtime jobs", () => {
  expect(patterns("push")).toEqual(patterns("pull_request"));
  for (const path of [
    ".github/workflows/threads-fixture.yml",
    "rust-toolchain.toml",
    "packages/waffle/rust-toolchain.toml",
    "packages/waffle/scripts/build-thread-fixture.ts",
    "packages/waffle/scripts/threads-fixture-producer.test.ts",
    "packages/waffle/tests/threads-fixture-inspect.ts",
    "packages/waffle/tests/threads-fixture-producer.test.ts",
    "packages/waffle/tests/fixtures/threads.rs",
  ])
    expect(
      patterns("pull_request").some((pattern) => new Glob(pattern).match(path)),
      path,
    ).toBe(true);
  for (const path of [
    "docs/concepts.md",
    "packages/waffle/runtime.ts",
    "packages/waffle/core/wasi.ts",
  ])
    expect(
      patterns("pull_request").some((pattern) => new Glob(pattern).match(path)),
      path,
    ).toBe(false);
});

test("the dedicated compiler job owns its pinned target and scratch without changing default discovery", () => {
  if (!Array.isArray(producer.steps)) throw new Error("expected producer steps");
  const steps = producer.steps.map(record);
  const toolchain = steps.find((step) => step.uses === "dtolnay/rust-toolchain@stable");
  expect(record(toolchain?.with)).toEqual({
    toolchain: "1.98.1",
    targets: "wasm32-wasip1-threads",
    components: "rustfmt",
  });
  expect(steps.filter((step) => step.run === compile)).toHaveLength(1);
  expect(record(steps.find((step) => step.run === compile)?.env).THREAD_FIXTURE_TEST_ROOT).toBe(
    "${{ runner.temp }}",
  );
  expect(
    steps.some((step) => /bun install|prepare:package|cargo build/.test(String(step.run))),
  ).toBe(false);
  const manifest = record(
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
  );
  expect(record(manifest.scripts).test).toBe("bun test ./tests");
  expect(compile).toContain("/scripts/");
});

test("receipt verification fails closed without invoking a compiler or creating output", () => {
  const directory = mkdtempSync(join(tmpdir(), "threads-receipt-"));
  try {
    expect(() => verifiedThreadFixture(directory)).toThrow();
    expect(readdirSync(directory)).toEqual([]);
    writeFileSync(join(directory, "threads.receipt.json"), '{"schema":1,"sha256":"tampered"}');
    expect(() => verifiedThreadFixture(directory)).toThrow("receipt digest does not match");
    expect(readdirSync(directory)).toEqual(["threads.receipt.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
