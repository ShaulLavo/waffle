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
  YAML.parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")),
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
    // libc is also the single producer of the memory group fixture the browser gate consumes.
    expect(job.needs).toEqual(name === "browser" ? ["changes", "network-wasm", "libc"] : "changes");
    const producer = name === "libc" ? " || needs.changes.outputs.browser == 'true'" : "";
    expect(job.if).toBe(
      `\${{ !cancelled() && (github.event_name == 'workflow_dispatch' || needs.changes.result != 'success' || needs.changes.outputs.${name} == 'true'${producer}) }}`,
    );
    expect(record(changes.outputs)[name]).toBe(`\${{ steps.paths.outputs.${name} }}`);
  });

  test(`${name} selects runtime, dependency and workflow inputs`, () => {
    for (const path of [
      "packages/waffle/core/wasi.ts",
      "packages/waffle/core/memory-views.ts",
      "packages/waffle/fs/persistent.ts",
      "packages/waffle/proc/abi.ts",
      "packages/waffle/interrupt/rewriter.ts",
      "packages/waffle/browser/net/host.ts",
      "packages/waffle/index.ts",
      "packages/waffle/runtime.ts",
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

test("release workflow publishes only the runtime tarball and checksum", () => {
  const release = record(
    YAML.parse(
      readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8"),
    ),
  );
  expect(record(release.permissions).contents).toBe("write");
  const steps = record(record(release.jobs).release).steps;
  if (!Array.isArray(steps)) throw new Error("expected release steps");
  const publish = steps
    .map(record)
    .find((step) => step.name === "Publish the GitHub release assets");
  expect(publish).toBeDefined();
  expect(String(publish?.run)).toContain("gh release create");
  expect(String(publish?.run)).toContain(".sha256");
  expect(String(publish?.run)).not.toContain("npm publish");
});

test("browser selects runners, shared controls and guest fixtures", () => {
  for (const path of [
    "packages/waffle/scripts/test-browser.ts",
    "packages/waffle/scripts/browser-command.ts",
    "packages/waffle/scripts/browser-supervisor.ts",
    "packages/waffle/scripts/owned-command.ts",
    "packages/waffle/tests/storage-browser-runner.ts",
    "packages/waffle/tests/publication-browser-runner.ts",
    "packages/waffle/tests/workspace-browser.ts",
    "packages/waffle/tests/fixtures/publication-guest.ts",
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
  expect(record(browserTest?.env).DEBUG).toBeUndefined();
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

test("the package tarball smoke uses the runner temporary directory", () => {
  const smoke = stepsFor("package").find((step) => step.run === "bun run pack:check");
  expect(record(smoke?.env).TMPDIR).toBe("${{ runner.temp }}");
  expect(smoke?.if).toBeUndefined();
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
  for (const path of [
    "packages/waffle/network/src/lib.rs",
    "packages/waffle/Cargo.lock",
    "packages/waffle/tooling/build-network.ts",
  ])
    expect(selected("browser", path), path).toBe(true);
  for (const path of [
    "packages/waffle/Cargo.toml",
    "packages/waffle/Cargo.lock",
    "packages/waffle/rust-toolchain.toml",
    "packages/waffle/network/src/lib.rs",
    "packages/waffle/network/tests/module.rs",
    "packages/waffle/tooling/build-network.ts",
    "packages/waffle/browser/net/module.ts",
    "packages/waffle/tests/network-module.test.ts",
    "packages/waffle/tests/network-module-host.test.ts",
    "packages/waffle/tests/network-wire.test.ts",
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

test("network consumers verify restored bytes before install and forbid Cargo", () => {
  for (const name of ["package", "browser"]) {
    const steps = stepsFor(name);
    const restored = steps.findIndex((step) => step.id === "network-artifact");
    const verified = steps.findIndex(
      (step) => step.run === "bun run --cwd packages/waffle tooling/build-network.ts --verify",
    );
    const installed = steps.findIndex(
      (step) => typeof step.run === "string" && step.run.startsWith("bun install"),
    );
    expect(verified).toBeGreaterThan(restored);
    expect(verified).toBeLessThan(installed);
    expect(record(record(jobs[name]).env).WAFFLE_NETWORK_PREBUILT).toBe("1");
    expect(steps.some((step) => typeof step.run === "string" && /cargo\s/.test(step.run))).toBe(
      false,
    );
    expect(String(record(steps[restored]?.with).path)).toContain("browser/net/network.sha256");
  }
});

test("network producer checks Rust target ownership with lockfile-sensitive caches", () => {
  const steps = stepsFor("network-wasm");
  const cache = steps.find((step) => step.id === "rust-cache");
  expect(String(record(cache?.with).key)).toContain(
    "hashFiles('packages/waffle/Cargo.lock', 'packages/waffle/rust-toolchain.toml')",
  );
  expect(String(record(cache?.with).path)).toContain("~/.rustup/toolchains");
  expect(String(record(cache?.with).path)).toContain("target");
  const commands = steps.map((step) => step.run).join("\n");
  expect(commands).toContain("bun tooling/check-network-rust.ts");
});

test("network packaging and acceptance inputs select the producer and browser consumer", () => {
  for (const path of [
    "packages/waffle/build.ts",
    "packages/waffle/prepare.ts",
    "packages/waffle/tooling/check-network-rust.ts",
    "packages/waffle/tests/network-lazy.test.ts",
    "packages/waffle/tests/packaging.test.ts",
    "packages/waffle/tests/git-install.test.ts",
    "packages/waffle/tests/node-exports.test.ts",
    "packages/waffle/tests/runtime-size.test.ts",
  ])
    for (const name of ["network", "browser"])
      expect(selected(name, path), `${name}: ${path}`).toBe(true);
  for (const path of ["docs/development.md", "site/src/pages/index.astro", "site/bun.lock"])
    expect(selected("network", path), path).toBe(false);
});

test("programs selects every consumed tool, workspace dependency, installer and libc input", () => {
  for (const path of [
    "package.json",
    "bun.lock",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "tools/source-contract-test.ts",
    "tools/test-family-build-routes.ts",
    "tools/program-family-manifest.test.ts",
    "tools/family-acceptance.ts",
    "tools/program-package.ts",
    "scripts/program-release.ts",
    "scripts/program-release.test.ts",
    "scripts/tsconfig.json",
    "tools/program-notices.ts",
    "packages/waffle/programs/index.ts",
    "packages/waffle/runtime.ts",
    "packages/waffle/scripts/build-wasi-libc.sh",
    "packages/waffle/patches/wasi-libc/preopen-scan.patch",
    "packages/coreutils/package-artifacts.json",
    "packages/python/src/launcher.ts",
  ])
    expect(selected("programs", path), path).toBe(true);
  expect(String(record(jobs.programs).if)).toContain("needs.changes.outputs.programs");
  for (const path of ["docs/development.md", "site/src/pages/index.astro", "site/bun.lock"])
    expect(selected("programs", path), path).toBe(false);
});

test("programs normal CI runs the release closure test from the folded source checkpoint", () => {
  expect(
    stepsFor("programs").some((step) => step.run === "bun test scripts/program-release.test.ts"),
  ).toBe(true);
});

test("the browser gate runs memory groups on the fixture built once by libc", () => {
  for (const path of [
    "packages/waffle/group/state.ts",
    "packages/waffle/link/code.ts",
    "packages/waffle/scripts/build-memory-group-fixture.ts",
    "packages/waffle/tests/fixtures/memory-group-member.c",
  ])
    expect(selected("browser", path), path).toBe(true);
  const libc = record(jobs.libc).steps as unknown[];
  const browser = record(jobs.browser).steps as unknown[];
  const run = (steps: unknown[]) => steps.map((step) => String(record(step).run ?? ""));
  const uses = (steps: unknown[]) => steps.map((step) => String(record(step).uses ?? ""));
  expect(run(libc).filter((line) => line.includes("build-memory-group-fixture.ts")).length).toBe(2);
  expect(uses(libc)).toContain("actions/upload-artifact@v4");
  expect(uses(browser)).toContain("actions/download-artifact@v4");
  expect(run(browser).some((line) => line.includes("build-memory-group-fixture.ts"))).toBe(false);
  const gate = browser
    .map(record)
    .find((step) => String(step.run).startsWith("bun run test:browser"));
  expect(record(gate?.env).MEMORY_GROUP_FIXTURE_DIR).toBeDefined();
});

test("a browser-only rerun downloads the reused producer's exact fixture artifact", () => {
  const upload = artifactStep(stepsFor("libc"), "${{ runner.temp }}/memory-group-fixture");
  const context: Record<string, string> = {
    "github.run_id": "40899462745",
    "github.run_attempt": "1",
    "steps.memory-group-artifact.outputs.artifact-id": "12345",
    "needs.libc.outputs.memory-group-artifact-id": "12345",
  };
  const expand = (value: unknown) =>
    String(value).replace(/\$\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
      const resolved = context[key];
      if (resolved === undefined) throw new Error(`unexpected workflow expression: ${key}`);
      return resolved;
    });
  const artifact = { id: "12345", name: expand(record(upload.with).name) };
  context["github.run_attempt"] = "2";

  const download = stepsFor("browser").find((step) => step.uses === "actions/download-artifact@v4");
  const inputs = record(download?.with);
  expect(artifact.name).toBe("memory-group-fixture-40899462745-1");
  expect(expand(inputs.name ?? inputs["artifact-ids"])).toBe(
    inputs.name ? artifact.name : artifact.id,
  );
  expect(upload.id).toBe("memory-group-artifact");
  expect(record(upload.with)["if-no-files-found"]).toBe("error");
  const output = record(record(jobs.libc).outputs)["memory-group-artifact-id"];
  expect(output).toBe("${{ steps.memory-group-artifact.outputs.artifact-id }}");
  expect(expand(output)).toBe(artifact.id);
  expect(inputs["artifact-ids"]).toBe("${{ needs.libc.outputs.memory-group-artifact-id }}");
  expect(expand(inputs["artifact-ids"])).toBe(artifact.id);
  expect(inputs.name).toBeUndefined();
  expect(inputs.pattern).toBeUndefined();
  expect(inputs["merge-multiple"]).toBe(true);
  expect(inputs.path).toBe(record(upload.with).path);
});

test("the browser rejects a missing fixture artifact ID before download", () => {
  const steps = stepsFor("browser");
  const guard = steps.find((step) => step.name === "Require the producer's fixture artifact ID");
  expect(record(guard?.env).MEMORY_GROUP_ARTIFACT_ID).toBe(
    "${{ needs.libc.outputs.memory-group-artifact-id }}",
  );
  expect(guard?.if).toBeUndefined();
  expect(guard?.["continue-on-error"]).toBeUndefined();
  const downloadIndex = steps.findIndex((step) => step.uses === "actions/download-artifact@v4");
  expect(guard).toBeDefined();
  expect(steps.indexOf(record(guard))).toBeLessThan(downloadIndex);
  for (const id of ["", "12345"]) {
    const result = Bun.spawnSync(["bash", "-e", "-c", String(guard?.run)], {
      env: { ...process.env, MEMORY_GROUP_ARTIFACT_ID: id },
    });
    expect(result.exitCode).toBe(id ? 0 : 1);
  }
});

test("gh selects its inputs without selecting native program jobs for gh-only changes", () => {
  const job = record(jobs.gh);
  expect(record(changes.outputs).gh).toBe("${{ steps.paths.outputs.gh }}");
  expect(job.needs).toEqual(["changes", "network-wasm"]);
  expect(String(job.if)).toContain("needs.changes.outputs.gh == 'true'");
  for (const path of [
    "packages/gh/src/program.ts",
    "packages/gh/tests/fixtures.ts",
    "packages/waffle/runtime.ts",
    "tools/program-package.ts",
    "package.json",
    "bun.lock",
    ".github/workflows/ci.yml",
  ])
    expect(selected("gh", path), path).toBe(true);
  for (const path of [
    "docs/development.md",
    "site/package.json",
    "packages/jq/src/index.ts",
    "packages/git/src/index.ts",
  ])
    expect(selected("gh", path), path).toBe(false);
  for (const name of ["programs", "coreutils", "findutils", "network", "browser", "libc"])
    expect(selected(name, "packages/gh/src/program.ts"), name).toBe(false);
});

test("gh restores the exact network asset and does not set up native compilers", () => {
  const steps = stepsFor("gh");
  const producer = stepsFor("network-wasm").find((step) => step.id === "network-artifact");
  const restore = steps.find((step) => step.id === "network-artifact");
  expect(record(restore?.with).key).toBe(record(producer?.with).key);
  expect(record(restore?.with)["fail-on-cache-miss"]).toBe(true);
  const verify = steps.findIndex(
    (step) => step.run === "bun run --cwd packages/waffle tooling/build-network.ts --verify",
  );
  const install = steps.findIndex(
    (step) => step.run === "bun install --frozen-lockfile --ignore-scripts",
  );
  expect(steps.indexOf(record(restore))).toBeLessThan(verify);
  expect(verify).toBeLessThan(install);
  expect(record(record(jobs.gh).env).WAFFLE_NETWORK_PREBUILT).toBe("1");
  expect(
    steps.some((step) =>
      /cargo|rust-toolchain|wasi-sdk|wasmtime/i.test(
        String(step.uses ?? "") + " " + String(step.run ?? ""),
      ),
    ),
  ).toBe(false);
  expect(
    record(steps.find((step) => step.uses === "actions/setup-node@v4")?.with)["node-version"],
  ).toBe("26.12.1");
  expect(steps.map((step) => step.run)).toContain("bun run programs:gh");
});
