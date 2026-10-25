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
    expect(job.needs).toEqual(name === "browser" ? ["changes", "network-wasm"] : "changes");
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

function stepsFor(name: string): Array<Record<string, unknown>> {
  const steps = record(jobs[name]).steps;
  if (!Array.isArray(steps)) throw new Error(`expected ${name} steps`);
  return steps.map(record);
}

function artifactStep(steps: readonly Record<string, unknown>[], path: string) {
  const step = steps.find(
    (step) => step.uses === "actions/upload-artifact@v4" && record(step.with).path === path,
  );
  if (!step) throw new Error(`expected artifact upload for ${path}`);
  return step;
}

const recoveryReportPath = "${{ runner.temp }}/recovery-r42-report.json";
const browserProtocolPath = "${{ runner.temp }}/waffle-browser-protocol.log";

test("browser failure retains structured recovery evidence before full protocol", () => {
  const steps = stepsFor("browser");
  const browserTest = steps.find(
    (step) =>
      step.run === 'bun run test:browser 2>&1 | tee "$RUNNER_TEMP/waffle-browser-protocol.log"',
  );
  expect(record(browserTest?.env).RECOVERY_R42_REPORT).toBe(recoveryReportPath);
  const recoveryUpload = artifactStep(steps, recoveryReportPath);
  const protocolUpload = artifactStep(steps, browserProtocolPath);
  expect(recoveryUpload.if).toBe("failure()");
  expect(record(recoveryUpload.with).name).toBe(
    "browser-recovery-report-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  expect(steps.indexOf(recoveryUpload)).toBeLessThan(steps.indexOf(protocolUpload));
  expect(record(recoveryUpload.with).path).not.toBe(record(protocolUpload.with).path);
});

test("missing recovery report does not replace the browser failure", () => {
  const recoveryUpload = artifactStep(stepsFor("browser"), recoveryReportPath);
  expect(recoveryUpload.if).toBe("failure()");
  expect(record(recoveryUpload.with)["if-no-files-found"]).toBe("ignore");
});

test("package installs share one Bun package-manager cache contract", () => {
  const expectedCacheUses = {
    package: "actions/cache@v4",
    browser: "actions/cache/restore@v4",
    site: "actions/cache/restore@v4",
  };
  let sharedKey: string | undefined;
  for (const name of ["package", "browser", "site"] as const) {
    const steps = stepsFor(name);
    const cacheSteps = steps.filter((step) => {
      if (step.uses !== expectedCacheUses[name]) return false;
      return record(step.with).path === "~/.bun/install/cache";
    });
    expect(cacheSteps).toHaveLength(1);

    const cache = cacheSteps.at(0);
    if (!cache) throw new Error(`expected ${name} Bun cache`);
    const cachePath = String(record(cache.with).path);
    const cacheKey = String(record(cache.with).key);
    expect(cache.uses).toBe(expectedCacheUses[name]);
    expect(cachePath).toBe("~/.bun/install/cache");
    expect(cachePath).not.toContain("node_modules");
    expect(cacheKey).toContain("${{ runner.os }}");
    expect(cacheKey).toContain("${{ runner.arch }}");
    expect(cacheKey).toContain("${{ env.BUN_VERSION }}");
    expect(cacheKey).toContain("${{ hashFiles('bun.lock', 'site/bun.lock') }}");
    expect(cacheKey).toBe(
      "${{ runner.os }}-${{ runner.arch }}-bun-pm-v2-${{ env.BUN_VERSION }}-${{ hashFiles('bun.lock', 'site/bun.lock') }}",
    );
    if (sharedKey === undefined) sharedKey = cacheKey;
    expect(cacheKey).toBe(sharedKey);

    const cacheIndex = steps.indexOf(cache);
    const installIndexes = steps.flatMap((step, index) =>
      typeof step.run === "string" && step.run.startsWith("bun install") ? [index] : [],
    );
    expect(installIndexes.length).toBeGreaterThan(0);
    expect(cacheIndex).toBeLessThan(Math.min(...installIndexes));
    for (const index of installIndexes) {
      const step = steps[index];
      if (!step) throw new Error(`expected install step ${index}`);
      expect(step.if).toBeUndefined();
    }
  }
});

test("package and site gates remain unconditional", () => {
  for (const name of ["package", "site"]) {
    const job = record(jobs[name]);
    expect(job.if).toBeUndefined();
    expect(job.needs).toBe(name === "package" ? "network-wasm" : undefined);
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

test("Rust network inputs select one release test/build lane and an exact WASM cache", () => {
  for (const path of ["network/src/lib.rs", "Cargo.lock", "tooling/build-network.ts"])
    expect(selected("browser", path), path).toBe(true);
  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "network/src/lib.rs",
    "network/tests/module.rs",
    "tooling/build-network.ts",
    "browser/net/module.ts",
    "tests/network-module.test.ts",
  ])
    expect(selected("network", path), path).toBe(true);
  expect(selected("network", "docs/network.md")).toBe(false);
  const steps = stepsFor("network-wasm");
  expect(
    steps.filter((step) => typeof step.run === "string" && step.run.includes("cargo test")),
  ).toHaveLength(1);
  const testStep = steps.find(
    (step) => typeof step.run === "string" && step.run.includes("cargo test"),
  );
  expect(String(testStep?.run)).toContain("--release");
  expect(String(testStep?.run)).toContain("--features module-tests");
  expect(record(testStep?.env).WAFFLE_TCP_MODULE).toContain("network.wasm");
  const cache = steps.find((step) => step.id === "network-artifact");
  expect(record(cache?.with)["restore-keys"]).toBeUndefined();
  for (const job of ["package", "browser"]) {
    const restore = stepsFor(job).find((step) => step.id === "network-artifact");
    expect(record(restore?.with).key).toBe(record(cache?.with).key);
    expect(record(restore?.with)["fail-on-cache-miss"]).toBe(true);
  }
});
