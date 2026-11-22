import { YAML } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedThreadFixture } from "../scripts/build-thread-fixture.ts";
import { inspectThreadFixture } from "./threads-fixture-inspect.ts";

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

test("real fixture compilation follows browser selection on the single CI runner", () => {
  const ci = record(
    YAML.parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")),
  );
  const jobs = record(ci.jobs);
  expect(Object.keys(jobs)).toEqual(["gate"]);
  const gate = record(jobs.gate);
  if (!Array.isArray(gate.steps)) throw new Error("expected gate steps");
  const ciSteps = gate.steps.map(record);
  const buildIndex = ciSteps.findIndex((step) => String(step.run ?? "").includes(compile));
  const verifyIndex = ciSteps.findIndex(
    (step) => step.run === "bun packages/waffle/scripts/build-thread-fixture.ts --verify",
  );
  const browserIndex = ciSteps.findIndex((step) =>
    String(step.run ?? "").startsWith("bun run test:browser "),
  );
  const build = ciSteps[buildIndex];
  const verify = ciSteps[verifyIndex];
  const browser = ciSteps[browserIndex];
  expect(events.workflow_call).toBeDefined();
  expect(events.push).toBeUndefined();
  expect(events.pull_request).toBeUndefined();
  expect(build).toBeDefined();
  expect(verify).toBeDefined();
  expect(browser).toBeDefined();
  expect(build?.if).toBe("steps.select.outputs.browser == 'true'");
  expect(verify?.if).toBe(build?.if);
  expect(browser?.if).toBe(build?.if);
  expect(buildIndex).toBeLessThan(verifyIndex);
  expect(verifyIndex).toBeLessThan(browserIndex);
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
  expect(record(steps.find((step) => step.run === compile)?.env).THREAD_FIXTURE_EXPORT_DIR).toBe(
    "${{ runner.temp }}/threads-fixture",
  );
  const upload = steps.find((step) => step.uses === "actions/upload-artifact@v4");
  expect(record(upload?.with).path).toBe("${{ runner.temp }}/threads-fixture");
  expect(record(upload?.with)["if-no-files-found"]).toBe("error");
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

test("artifact inspection validates shared memory without a Rust compiler", () => {
  const bytes = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 2, 18, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 3,
    17, 128, 128, 1,
  ]);
  const inspected = inspectThreadFixture(bytes);
  expect(inspected.imports).toEqual([
    { kind: "memory", module: "env", name: "memory", minimum: 17, maximum: 16384, shared: true },
  ]);
  expect(inspected.fixed32MiBImportCompatible).toBe(true);
  expect(inspected.start).toBeNull();
  expect(() => inspectThreadFixture(bytes.slice(0, -1))).toThrow(WebAssembly.CompileError);
});
