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

test("jq has a separate leaf with the shared network artifact prerequisite", () => {
  const job = record(jobs.jq);
  expect(job.needs).toEqual(["changes", "network-wasm"]);
  expect(job.if).toBe(
    "${{ !cancelled() && (github.event_name == 'workflow_dispatch' || needs.changes.result != 'success' || needs.changes.outputs.jq == 'true') }}",
  );
  expect(record(changes.outputs).jq).toBe("${{ steps.paths.outputs.jq }}");
  const steps = stepsFor("jq");
  expect(steps.some((step) => step.run === "bun run prepare:package")).toBe(true);
  expect(steps.some((step) => step.run === "bun run programs:check")).toBe(true);
  expect(steps.some((step) => step.run === "bun run programs:jq")).toBe(true);
  expect(record(job.env).WAFFLE_NETWORK_PREBUILT).toBe("1");
});

test("jq selects only its package and shared runtime inputs", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    "package.json",
    "bun.lock",
    "rust-toolchain.toml",
    "tools/program-build-tools.ts",
    "tools/program-package.ts",
    "tools/family-acceptance.ts",
    "tools/tsconfig.programs.json",
    "packages/base/src/index.ts",
    "packages/jq/src/index.ts",
    "packages/jq/scripts/build-jaq.ts",
    "packages/jq/tests/jq-wasi.test.ts",
    "packages/waffle/runtime.ts",
    "packages/waffle/programs/collection.ts",
    "packages/waffle/browser/fs-worker.ts",
  ])
    expect(selected("jq", path), path).toBe(true);
  for (const path of [
    "Cargo.toml",
    "packages/coreutils/src/lib.rs",
    "packages/findutils/src/index.ts",
    "packages/grep/src/index.ts",
    "packages/sed/src/index.ts",
    "packages/ripgrep/src/index.ts",
    "packages/python/src/launcher.ts",
    "packages/git/src/index.ts",
    "docs/bun-patches.md",
    "site/src/pages/index.astro",
  ])
    expect(selected("jq", path), path).toBe(false);
});

test("jq restores and verifies the single network artifact before install", () => {
  const steps = stepsFor("jq");
  const restore = steps.find((step) => step.id === "network-artifact");
  const verify = steps.find(
    (step) => step.run === "bun run --cwd packages/waffle tooling/build-network.ts --verify",
  );
  const install = steps.find(
    (step) => typeof step.run === "string" && step.run.startsWith("bun install"),
  );
  expect(restore).toBeDefined();
  expect(verify).toBeDefined();
  expect(install).toBeDefined();
  expect(record(restore?.with)["fail-on-cache-miss"]).toBe(true);
  expect(String(record(restore?.with).path)).toContain("packages/waffle/browser/net/network.wasm");
  expect(steps.indexOf(record(restore))).toBeLessThan(steps.indexOf(record(verify)));
  expect(steps.indexOf(record(verify))).toBeLessThan(steps.indexOf(record(install)));
  expect(
    steps.some((step) => typeof step.run === "string" && step.run.includes("build:network")),
  ).toBe(false);
  const cache = steps.find((step) => step.id === "jq-cache");
  expect(cache).toBeDefined();
  for (const path of [
    "~/.rustup/toolchains",
    "~/.cargo/registry",
    "~/.cargo/git",
    ".build/jq",
    ".build/wasi-libc",
    "packages/jq/.build",
    "packages/jq/.sources",
  ])
    expect(String(record(cache?.with).path)).toContain(path);
  expect(String(record(cache?.with).key)).toContain("packages/jq/sources.lock.json");
  expect(String(record(cache?.with).key)).toContain("tools/program-build-tools.ts");
});

test("jq provisions the pinned SDK before its native program build", () => {
  const job = record(jobs.jq);
  expect(record(job.env)).toEqual({ WAFFLE_NETWORK_PREBUILT: "1" });
  const steps = stepsFor("jq");
  const build = steps.find((step) => step.run === "bun run programs:jq");
  expect(record(build?.env).WASI_SDK_PATH).toBe("${{ runner.temp }}/wasi-sdk-34.0-x86_64-linux");
  expect(record(build?.env).WASI_LIBC_SCRATCH_ROOT).toBe("${{ runner.temp }}");
  const sdk = steps.find((step) => step.id === "sdk");
  expect(record(sdk?.with).path).toBe("${{ runner.temp }}/wasi-sdk-34.0-x86_64-linux");
  expect(record(sdk?.with).key).toBe(
    "${{ runner.os }}-wasi-sdk-34-b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4",
  );
  const provision = steps.find((step) => step.name === "Install pinned wasi-sdk 34");
  expect(provision?.if).toBe("steps.sdk.outputs.cache-hit != 'true'");
  expect(String(provision?.run)).toContain(
    "b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4  wasi-sdk.tar.gz",
  );
  expect(steps.indexOf(record(provision))).toBeLessThan(
    steps.findIndex((step) => step.run === "bun run programs:jq"),
  );
});

test("jq pins and verifies its native oracle without a host-jq fallback", () => {
  const steps = stepsFor("jq");
  const cache = steps.find((step) => step.id === "jq-native");
  const download = steps.find((step) => step.name === "Download pinned jq native oracle");
  const verify = steps.find((step) => step.name === "Verify and expose pinned jq native oracle");
  const version = steps.find((step) => step.name === "Assert pinned jq native oracle");
  const oracle = steps.find((step) => step.run === "bun run programs:jq");
  expect(cache).toBeDefined();
  expect(record(cache?.with).path).toBe("${{ runner.temp }}/jq-native");
  expect(record(cache?.with).key).toBe(
    "${{ runner.os }}-${{ runner.arch }}-jq-native-1.8.2-x86_64-b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f",
  );
  expect(download?.if).toBe("steps.jq-native.outputs.cache-hit != 'true'");
  expect(record(download?.env).JQ_NATIVE_DIR).toBe("${{ runner.temp }}/jq-native");
  expect(record(download?.env).JQ_NATIVE_URL).toBe(
    "https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-linux-amd64",
  );
  expect(String(download?.run)).toContain('curl -fL --retry 3 "$JQ_NATIVE_URL"');
  expect(String(download?.run)).toContain('"$JQ_NATIVE_DIR/jq"');
  expect(record(verify?.env).JQ_NATIVE_DIR).toBe("${{ runner.temp }}/jq-native");
  expect(record(verify?.env).JQ_NATIVE_SHA256).toBe(
    "b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f",
  );
  expect(String(verify?.run)).toContain("sha256sum -c -");
  expect(String(verify?.run)).toContain('chmod 700 "$JQ_NATIVE_DIR/jq"');
  expect(String(verify?.run)).toContain('echo "$JQ_NATIVE_DIR" >> "$GITHUB_PATH"');
  expect(record(version?.env).JQ_NATIVE_DIR).toBe("${{ runner.temp }}/jq-native");
  expect(String(version?.run)).toContain('test "$(command -v jq)" = "$JQ_NATIVE_DIR/jq"');
  expect(String(version?.run)).toContain('test "$(jq --version)" = "jq-1.8.2"');
  expect(String(version?.run)).not.toContain("|| jq");
  expect(String(version?.run)).not.toContain("apt-get");
  expect(steps.indexOf(record(cache))).toBeLessThan(steps.indexOf(record(download)));
  expect(steps.indexOf(record(download))).toBeLessThan(steps.indexOf(record(verify)));
  expect(steps.indexOf(record(verify))).toBeLessThan(steps.indexOf(record(version)));
  expect(steps.indexOf(record(version))).toBeLessThan(steps.indexOf(record(oracle)));
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

test("program producers explicitly provision the pinned optimizer before running build routes", () => {
  const steps = stepsFor("programs");
  const optimizer = steps.findIndex((step) => step.uses === "./.github/actions/program-optimizer");
  const tools = steps.findIndex((step) => step.run === "bun run programs:tools");
  expect(optimizer).toBeGreaterThanOrEqual(0);
  expect(tools).toBeGreaterThan(optimizer);
  expect(steps[optimizer]?.if).toBeUndefined();
  expect(steps[optimizer]?.["continue-on-error"]).toBeUndefined();
  expect(
    stepsFor("network-wasm").some((step) => step.uses === "./.github/actions/program-optimizer"),
  ).toBe(false);
  for (const path of [
    "ci.yml",
    "coreutils-echo.yml",
    "findutils-xargs.yml",
    "program-release.yml",
  ]) {
    const source = readFileSync(
      new URL(`../../../.github/workflows/${path}`, import.meta.url),
      "utf8",
    );
    expect(source).toContain("uses: ./.github/actions/program-optimizer");
  }
  for (const filter of ["programs", "coreutils", "findutils"]) {
    expect(selected(filter, "tools/program-optimize.ts")).toBe(true);
    expect(selected(filter, "tools/program-derivation.ts")).toBe(true);
    expect(selected(filter, ".github/actions/program-optimizer/action.yml")).toBe(true);
  }
});
