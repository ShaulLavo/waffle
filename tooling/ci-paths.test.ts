import { Glob, YAML } from "bun";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected a workflow mapping");
  return value;
}

const workflow = record(
  YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")),
);
const jobs = record(workflow.jobs);
const changes = record(jobs.changes);
if (!Array.isArray(changes.steps)) throw new Error("expected change-detection steps");
const paths = changes.steps.map(record).find((step) => step.id === "paths");
const filters = record(YAML.parse(String(record(paths?.with).filters)));

function selected(name: string, path: string): boolean {
  const patterns = filters[name];
  if (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string"))
    throw new Error(`expected ${name} path patterns`);
  return patterns.some((pattern: string) => new Glob(pattern).match(path));
}

for (const name of ["browser", "libc"]) {
  test(`${name} waits for paths and runs on manual dispatch or filter failure`, () => {
    const job = record(jobs[name]);
    expect(job.needs).toBe("changes");
    expect(job.if).toBe(
      `\${{ !cancelled() && (github.event_name == 'workflow_dispatch' || needs.changes.result != 'success' || needs.changes.outputs.${name} == 'true') }}`,
    );
    expect(record(changes.outputs)[name]).toBe(`\${{ steps.paths.outputs.${name} }}`);
  });

  test(`${name} selects runtime, dependency and workflow inputs`, () => {
    for (const path of [
      "core/wasi.ts",
      "core/memory-views.js",
      "fs/persistent.ts",
      "proc/abi.ts",
      "interrupt/rewriter.ts",
      "browser/net/host.ts",
      "index.ts",
      "runtime.ts",
      "package.json",
      "bun.lock",
      ".github/workflows/ci.yml",
    ])
      expect(selected(name, path), path).toBe(true);
  });

  test(`${name} does not run for docs, site or quality-only inputs`, () => {
    for (const path of [
      "README.md",
      "docs/host-abi.md",
      "plans/browser-runtime.md",
      "site/src/pages/index.astro",
      "site/package.json",
      "site/bun.lock",
      "tooling/ci-paths.test.ts",
      "knip.config.ts",
      ".oxlintrc.json",
    ])
      expect(selected(name, path), path).toBe(false);
  });
}

test("browser selects runners, shared controls and guest fixtures", () => {
  for (const path of [
    "scripts/test-browser.ts",
    "scripts/browser-command.ts",
    "scripts/browser-supervisor.ts",
    "scripts/owned-command.ts",
    "tests/storage-browser-runner.ts",
    "tests/publication-browser-runner.ts",
    "tests/workspace-browser.ts",
    "tests/fixtures/publication-guest.ts",
  ])
    expect(selected("browser", path), path).toBe(true);
});

test("package and site gates remain unconditional", () => {
  for (const name of ["package", "site"]) {
    const job = record(jobs[name]);
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
  }
});

test("package runs each test root once without repeating preparation", () => {
  const metadata = record(
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
  );
  const scripts = record(metadata.scripts);
  expect(scripts.test).toBe("bun test ./tests");
  expect(scripts["test:ci"]).toBe("bun test ./tooling/ci-paths.test.ts");
  const steps = record(jobs.package).steps;
  if (!Array.isArray(steps)) throw new Error("expected package steps");
  const commands = steps.map((step) => record(step).run);
  expect(commands.filter((command) => command === "bun run test && bun run test:ci")).toHaveLength(
    1,
  );
  expect(commands).not.toContain("bun run prepare");
});
