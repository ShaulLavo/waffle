import { Glob, YAML } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const gate = record(jobs.gate);
const packageTestsCommand = "bun run test --parallel=4 && bun run test:ci";
if (!Array.isArray(gate.steps)) throw new Error("expected gate steps");
const gateSteps = gate.steps.map(record);
const paths = gateSteps.find((step) => step.id === "paths");
const select = gateSteps.find((step) => step.id === "select");
const filters = record(YAML.parse(String(record(paths?.with).filters)));

function selected(name: string, path: string): boolean {
  const patterns = filters[name];
  if (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string"))
    throw new Error(`expected ${name} path patterns`);
  return patterns.some((pattern: string) => new Glob(pattern).match(path));
}

function artifactStep(steps: readonly Record<string, unknown>[], path: string) {
  const step = steps.find(
    (step) => step.uses === "actions/upload-artifact@v4" && record(step.with).path === path,
  );
  if (!step) throw new Error(`expected artifact upload for ${path}`);
  return step;
}

test("CI runs as a single Complete CI gate job on pinned ubuntu-24.04", () => {
  expect(Object.keys(jobs)).toEqual(["gate"]);
  expect(gate.name).toBe("Complete CI gate");
  expect(gate["runs-on"]).toBe("ubuntu-24.04");
  expect(gate.needs).toBeUndefined();
  expect(gateSteps[0]?.name).toBe("Require a ready PR");
  expect(gateSteps[0]?.if).toBe(
    "github.event_name == 'pull_request' && github.event.pull_request.draft",
  );
  expect(gateSteps.filter((step) => step.uses === "actions/checkout@v4")).toHaveLength(1);
  expect(paths?.["continue-on-error"]).toBe(true);
  expect(gateSteps.indexOf(record(paths))).toBeLessThan(gateSteps.indexOf(record(select)));
});

test("selection step resolves path filters, workflow dispatch and filter-failure fallbacks", () => {
  const runSelect = (env: Record<string, string>) => {
    const scratch = mkdtempSync(join(tmpdir(), "waffle-ci-select-"));
    const out = join(scratch, "output");
    try {
      const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", String(select?.run)], {
        env: {
          ...process.env,
          GITHUB_OUTPUT: out,
          EVENT_NAME: "pull_request",
          PATHS_OUTCOME: "success",
          P_NETWORK: "false",
          P_BROWSER: "false",
          P_LIBC: "false",
          P_PROGRAMS: "false",
          P_COREUTILS: "false",
          P_CHECKSUMS: "false",
          P_FINDUTILS: "false",
          P_DIFFUTILS: "false",
          P_GH: "false",
          P_JQ: "false",
          P_CURL: "false",
          P_AWK: "false",
          P_TAR: "false",
          P_PROCPS: "false",
          ...env,
        },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return Object.fromEntries(
        readFileSync(out, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const docsOnly = runSelect({});
  expect(docsOnly.browser).toBe("false");
  expect(docsOnly.libc_or_browser).toBe("false");
  expect(docsOnly.need_wasi_sdk).toBe("false");
  expect(docsOnly.need_rust_wasip1).toBe("false");

  const echoOnly = runSelect({ P_COREUTILS: "true" });
  expect(echoOnly.coreutils).toBe("true");
  expect(echoOnly.findutils).toBe("false");
  expect(echoOnly.xargs_or_echo).toBe("true");
  expect(echoOnly.need_wasi_sdk).toBe("true");
  expect(echoOnly.need_rust_wasip1).toBe("true");
  expect(echoOnly.browser).toBe("false");

  const browserOnly = runSelect({ P_BROWSER: "true" });
  expect(browserOnly.browser).toBe("true");
  expect(browserOnly.libc).toBe("false");
  expect(browserOnly.libc_or_browser).toBe("true");
  expect(browserOnly.need_wasi_sdk).toBe("true");
  expect(browserOnly.need_wasmtime).toBe("true");

  const fallbacks: readonly Record<string, string>[] = [
    { EVENT_NAME: "workflow_dispatch" },
    { PATHS_OUTCOME: "failure" },
  ];
  for (const fallbackEnv of fallbacks) {
    const all = runSelect(fallbackEnv);
    for (const key of [
      "network",
      "browser",
      "libc",
      "libc_or_browser",
      "programs",
      "coreutils",
      "checksums",
      "findutils",
      "xargs_or_echo",
      "diffutils",
      "gh",
      "jq",
      "curl",
      "awk",
      "tar",
      "procps",
    ])
      expect(all[key], `${JSON.stringify(fallbackEnv)}: ${key}`).toBe("true");
  }
});

for (const name of ["browser", "libc"]) {
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

test("browser relay inputs select the normal gate and native prebuild runs before relay and browser checks", () => {
  for (const path of [
    "packages/waffle/tests/network-relay-browser-runner.ts",
    "packages/waffle/tests/network-relay-worker.ts",
    "packages/waffle/tests/fixtures/preview1-relay.wat",
    "packages/waffle-relay/src/tcp-client.ts",
    "packages/waffle-relay/src/node-webtransport.ts",
    "packages/waffle-relay/package.json",
    "packages/waffle-relay/scripts/prepare-native.ts",
    "packages/waffle-relay/tests/prepare-native.test.ts",
    "packages/waffle/tooling/workspace-safari-runner.ts",
  ])
    expect(selected("browser", path), path).toBe(true);
  const install = gateSteps.findIndex(
    (step) => step.run === "bun install --frozen-lockfile --ignore-scripts",
  );
  const cache = gateSteps.findIndex(
    (step) => step.name === "Cache standard native relay prebuild downloads",
  );
  const prepare = gateSteps.findIndex(
    (step) => step.run === "bun packages/waffle-relay/scripts/prepare-native.ts",
  );
  const relay = gateSteps.findIndex((step) => step.run === "bun run relay:check");
  const browser = gateSteps.findIndex((step) =>
    String(step.run ?? "").startsWith("bun run test:browser "),
  );
  expect(install).toBeGreaterThanOrEqual(0);
  expect(cache).toBeGreaterThan(install);
  expect(prepare).toBeGreaterThan(cache);
  expect(prepare).toBeLessThan(relay);
  expect(prepare).toBeLessThan(browser);
  expect(gateSteps[cache]?.uses).toBe("actions/cache@v4");
  expect(record(gateSteps[cache]?.with).path).toBe("~/.npm/_prebuilds");
  const key = String(record(gateSteps[cache]?.with).key);
  expect(key).toContain("${{ runner.os }}-${{ runner.arch }}");
  expect(key).toContain("bun.lock");
  expect(key).toContain("src/webtransport-integrity.ts");
  expect(record(gateSteps[cache]?.with)["restore-keys"]).toBeUndefined();
});

const consumerFilters = [
  "network",
  "coreutils",
  "sed",
  "findutils",
  "grep",
  "ripgrep",
  "base",
  "programs",
  "diffutils",
  "gh",
  "jq",
  "curl",
  "awk",
  "tar",
  "procps",
  "browser",
  "libc",
] as const;

test("relay image inputs stay out of unrelated consumer gates", () => {
  for (const path of [
    ".github/workflows/relay-image.yml",
    "packages/waffle-relay/Dockerfile",
    "packages/waffle-relay/.dockerignore",
    "packages/waffle-relay/scripts/prepare-relay-image.ts",
  ])
    for (const name of consumerFilters)
      expect(selected(name, path), `${name}: ${path}`).toBe(false);
});

test("shared workflow inputs select the gates that consume them", () => {
  for (const name of consumerFilters) {
    expect(selected(name, ".github/workflows/ci.yml"), name).toBe(true);
    for (const path of [
      ".github/actions/release-downloads/action.yml",
      ".github/actions/save-release-downloads/action.yml",
      ".github/actions/setup-tools/action.yml",
      "tools/ci-release-download.ts",
      "tools/ci-bootstrap-tools.ts",
    ])
      expect(selected(name, path), `${name}: ${path}`).toBe(true);
  }
  for (const name of ["diffutils", "jq", "awk", "tar", "libc"])
    expect(selected(name, ".github/actions/setup-wasmtime/action.yml"), name).toBe(true);
  for (const name of [
    "network",
    "coreutils",
    "findutils",
    "programs",
    "gh",
    "curl",
    "procps",
    "browser",
  ])
    expect(selected(name, ".github/actions/setup-wasmtime/action.yml"), name).toBe(false);
  expect(selected("findutils", ".github/workflows/findutils-xargs.yml")).toBe(true);
  expect(selected("coreutils", ".github/workflows/findutils-xargs.yml")).toBe(true);
  expect(selected("coreutils", ".github/workflows/coreutils-echo.yml")).toBe(true);
  for (const name of [
    "network",
    "programs",
    "diffutils",
    "gh",
    "jq",
    "curl",
    "awk",
    "tar",
    "procps",
    "browser",
    "libc",
  ]) {
    expect(selected(name, ".github/workflows/findutils-xargs.yml"), name).toBe(false);
    expect(selected(name, ".github/workflows/coreutils-echo.yml"), name).toBe(false);
  }
  expect(selected("programs", ".github/actions/rust-build-cache/action.yml")).toBe(true);
  expect(selected("browser", ".github/actions/rust-build-cache/action.yml")).toBe(false);
  expect(selected("network", ".github/actions/rust-build-cache/action.yml")).toBe(false);
});

test("release workflow publishes to npm with Changesets and OIDC provenance", () => {
  const release = record(
    YAML.parse(
      readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8"),
    ),
  );
  const trigger = record(record(release.on).push);
  expect(trigger.branches).toEqual(["main"]);
  expect(record(release.permissions)["id-token"]).toBe("write");
  const releaseJob = record(record(release.jobs).release);
  if (!Array.isArray(releaseJob.steps)) throw new Error("expected release steps");
  const changesets = releaseJob.steps
    .map(record)
    .find((step) => step.uses === "changesets/action@v1");
  expect(changesets).toBeDefined();
  expect(record(changesets?.with).publish).toBe("bun run release:publish");
  expect(record(changesets?.env).NPM_CONFIG_PROVENANCE).toBe("true");
});

test("browser selects runners, shared controls and guest fixtures", () => {
  for (const path of [
    "packages/waffle/scripts/test-browser.ts",
    "packages/waffle/scripts/browser-command.ts",
    "packages/waffle/scripts/browser-supervisor.ts",
    "packages/waffle/scripts/owned-command.ts",
    "packages/waffle/scripts/build-memory-group-fixture.ts",
    "packages/waffle/scripts/build-gpu-fixture.ts",
    "packages/waffle/tests/gpu-browser-runner.ts",
    "packages/waffle/tests/gpu-native-browser-runner.ts",
    "packages/waffle/tests/gpu-async-browser-runner.ts",
    "packages/waffle/tests/page-runner/browser-controls-runner.ts",
    "packages/waffle/tests/page-runner/browser-controls-suite.ts",
    "packages/waffle/tests/page-runner/gpu-async-controls-runner.ts",
    "packages/waffle/tests/threads-runtime-browser-runner.ts",
    "packages/waffle/tests/fixtures/threads.rs",
    "packages/waffle/scripts/build-thread-fixture.ts",
    "packages/waffle/scripts/threads-fixture-producer.test.ts",
    "packages/waffle/thread/runtime-owner.ts",
    "packages/waffle/memory/reservations.ts",
    "packages/waffle/group/state.ts",
    "packages/waffle/link/code.ts",
    "packages/waffle/tests/fixtures/memory-group-member.c",
    "packages/waffle/rust-toolchain.toml",
    "rust-toolchain.toml",
    ".github/workflows/threads-fixture.yml",
  ])
    expect(selected("browser", path), path).toBe(true);
});

test("reusable threads-fixture workflow keeps its standalone producer contract", () => {
  const threadsWorkflow = record(
    YAML.parse(
      readFileSync(
        new URL("../../../.github/workflows/threads-fixture.yml", import.meta.url),
        "utf8",
      ),
    ),
  );
  const threadsProducer = record(record(threadsWorkflow.jobs).producer);
  if (!Array.isArray(threadsProducer.steps)) throw new Error("expected threads producer steps");
  const threadsSteps = threadsProducer.steps.map(record);
  const triggers = record(threadsWorkflow.on);
  expect(Object.keys(triggers).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
  expect(String(record(threadsWorkflow.concurrency).group)).not.toBe(
    String(record(workflow.concurrency).group),
  );
  const upload = artifactStep(threadsSteps, "${{ runner.temp }}/threads-fixture");
  expect(record(upload.with)["if-no-files-found"]).toBe("error");
  expect(record(threadsProducer.outputs)["artifact-id"]).toBe(
    `\${{ steps.${upload.id}.outputs.artifact-id }}`,
  );
});

const recoveryReportPath = "${{ runner.temp }}/recovery-r42-report.json";
const browserProtocolPath = "${{ runner.temp }}/waffle-browser-protocol.log";

test("browser runs the complete suite once, preserves publication checks and retains evidence", () => {
  const browserTest = gateSteps.find(
    (step) =>
      step.run === 'bun run test:browser 2>&1 | tee "$RUNNER_TEMP/waffle-browser-protocol.log"',
  );
  expect(browserTest?.id).toBe("browser-tests");
  expect(browserTest?.if).toBe("steps.select.outputs.browser == 'true'");
  expect(browserTest?.shell).toBe("bash");
  expect(browserTest?.["continue-on-error"]).toBeUndefined();
  expect(record(browserTest?.env).DEBUG).toBeUndefined();
  expect(record(browserTest?.env).WAFFLE_BROWSER_GROUP).toBeUndefined();
  expect(record(browserTest?.env).RECOVERY_R42_REPORT).toBe(recoveryReportPath);
  expect(record(browserTest?.env).GPU_FIXTURE_DIR).toBe("${{ runner.temp }}/gpu-fixture");
  expect(record(browserTest?.env).MEMORY_GROUP_FIXTURE_DIR).toBe(
    "${{ runner.temp }}/memory-group-fixture",
  );
  expect(record(browserTest?.env).THREAD_FIXTURE_DIR).toBe("${{ runner.temp }}/threads-fixture");
  const result = "${{ runner.temp }}/browser-controls-results.json";
  expect(record(browserTest?.env).BROWSER_CONTROLS_RESULT).toBe(result);

  const publication = gateSteps.find(
    (step) =>
      step.run === "bun packages/waffle/tests/publication-browser-runner.ts --workspace chromium",
  );
  expect(publication?.if).toBe(
    "${{ !cancelled() && steps.select.outputs.browser == 'true' && (steps.browser-tests.outcome == 'success' || steps.browser-tests.outcome == 'failure') }}",
  );

  const recoveryUpload = artifactStep(gateSteps, recoveryReportPath);
  const controlsUpload = artifactStep(gateSteps, `${result}*`);
  const protocolUpload = artifactStep(gateSteps, browserProtocolPath);
  expect(recoveryUpload.if).toBe("failure() && steps.select.outputs.browser == 'true'");
  expect(record(recoveryUpload.with)["if-no-files-found"]).toBe("ignore");
  expect(controlsUpload.if).toBe("always() && steps.select.outputs.browser == 'true'");
  expect(record(controlsUpload.with)["if-no-files-found"]).toBe("warn");
  expect(protocolUpload.if).toBe("failure() && steps.select.outputs.browser == 'true'");
  expect(gateSteps.indexOf(recoveryUpload)).toBeLessThan(gateSteps.indexOf(protocolUpload));
});

test("site runs independently before network preparation and blocks Complete CI gate on failure", () => {
  const site = gateSteps.filter((step) => step["working-directory"] === "site");
  expect(site.map((step) => step.run)).toEqual([
    "bun install --frozen-lockfile",
    "bun run build",
    "bun run typecheck",
  ]);
  const [install, build, typecheck] = site;
  expect(install?.if).toBeUndefined();
  expect(build?.if).toBe("steps.site-install.outcome == 'success'");
  expect(typecheck?.if).toBe("steps.site-install.outcome == 'success'");
  const networkCache = gateSteps.findIndex((step) => step.id === "network-artifact");
  for (const step of site) {
    expect(step["continue-on-error"]).toBe(true);
    expect(gateSteps.indexOf(step)).toBeLessThan(networkCache);
  }
  const finalGate = gateSteps.find(
    (step) => step.name === "Require successful change detection and site checks",
  );
  expect(finalGate?.if).toBe(
    "${{ !cancelled() && (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}",
  );
  const env = {
    ...process.env,
    PATHS_RESULT: "success",
    SITE_BUILD: "success",
    SITE_TYPECHECK: "success",
  };
  const command = ["bash", "-eo", "pipefail", "-c", String(finalGate?.run)];
  expect(Bun.spawnSync(command, { env }).exitCode).toBe(0);
  for (const field of ["PATHS_RESULT", "SITE_BUILD", "SITE_TYPECHECK"])
    for (const bad of ["failure", "skipped", "cancelled", ""])
      expect(Bun.spawnSync(command, { env: { ...env, [field]: bad } }).exitCode).toBe(1);
});

test("Bun cache, network verification, workspace install and package checks run once in order", () => {
  const bunCaches = gateSteps.filter(
    (step) => step.uses === "actions/cache@v4" && record(step.with).path === "~/.bun/install/cache",
  );
  expect(bunCaches).toHaveLength(1);
  expect(record(bunCaches[0]?.with).key).toBe(
    "${{ runner.os }}-${{ runner.arch }}-bun-pm-v2-${{ env.BUN_VERSION }}-${{ hashFiles('bun.lock', 'site/bun.lock') }}",
  );

  const networkCache = gateSteps.findIndex((step) => step.id === "network-artifact");
  const verify = gateSteps.findIndex((step) =>
    String(step.run ?? "").includes(
      "bun run --cwd packages/waffle tooling/build-network.ts --verify",
    ),
  );
  const install = gateSteps.findIndex(
    (step) => step.run === "bun install --frozen-lockfile --ignore-scripts",
  );
  const native = gateSteps.findIndex(
    (step) => step.run === "bun packages/waffle-relay/scripts/prepare-native.ts",
  );
  const prepare = gateSteps.findIndex((step) => step.run === "bun run prepare:package");
  const adapter = gateSteps.findIndex(
    (step) => step.run === "bun run --cwd packages/git/node_modules/bun-wasm prepare",
  );
  const quality = gateSteps.findIndex(
    (step) => step.run === "bun run --cwd packages/waffle quality",
  );
  const allocRef = gateSteps.findIndex(
    (step) => step.run === "bun packages/waffle/tooling/prepare-allocation-reference.ts",
  );
  const tests = gateSteps.findIndex((step) => step.run === packageTestsCommand);
  const smoke = gateSteps.find((step) => step.run === "bun run pack:check");

  expect(networkCache).toBeGreaterThan(gateSteps.indexOf(bunCaches[0]!));
  expect(verify).toBeGreaterThan(networkCache);
  expect(install).toBeGreaterThan(verify);
  expect(native).toBeGreaterThan(install);
  expect(prepare).toBeGreaterThan(native);
  expect(adapter).toBeGreaterThan(prepare);
  expect(quality).toBeGreaterThan(adapter);
  expect(allocRef).toBeGreaterThan(quality);
  expect(tests).toBeGreaterThan(allocRef);
  expect(record(smoke?.env).TMPDIR).toBe("${{ runner.temp }}");
  expect(gateSteps.filter((step) => step.run === packageTestsCommand)).toHaveLength(1);
  expect(
    gateSteps.filter((step) =>
      String(step.run ?? "").includes("bun run --cwd packages/waffle build:network"),
    ),
  ).toHaveLength(1);

  const manifest = record(
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
  );
  expect(record(manifest.scripts).test).toBe("bun test ./tests");
  expect(record(manifest.scripts)["test:ci"]).toBe("bun test ./tooling/ci-paths.test.ts");
  const allocSource = readFileSync(
    new URL("./prepare-allocation-reference.ts", import.meta.url),
    "utf8",
  );
  expect(allocSource).toContain("fd1d23c223acbc854b8113fe1e37a7a183728697");
  expect(allocSource).toContain('"--depth=1"');
  expect(allocSource).not.toMatch(/--unshallow|fetch.*--all/);
});

test("network producer shares its exact cache key with release, echo and xargs workflows", async () => {
  for (const path of [
    "packages/waffle/Cargo.toml",
    "packages/waffle/Cargo.lock",
    "packages/waffle/rust-toolchain.toml",
    "packages/waffle/network/src/lib.rs",
    "packages/waffle/network/tests/module.rs",
    "packages/waffle/tooling/build-network.ts",
    "packages/waffle/tooling/network-translator.ts",
    "packages/waffle/tooling/network-translator/package.json",
    "packages/waffle/tooling/network-translator/bun.lock",
    "packages/waffle/tooling/network-growth.ts",
    "packages/waffle/tooling/check-network-rust.ts",
    "packages/waffle/build.ts",
    "packages/waffle/prepare.ts",
    "packages/waffle/browser/net/module.ts",
    "packages/waffle/tests/network-module.test.ts",
    "packages/waffle/tests/network-module-host.test.ts",
    "packages/waffle/tests/network-wire.test.ts",
    "packages/waffle/tests/network-lazy.test.ts",
    "packages/waffle/tests/packaging.test.ts",
    "packages/waffle/tests/git-install.test.ts",
    "packages/waffle/tests/node-exports.test.ts",
    "packages/waffle/tests/runtime-size.test.ts",
  ])
    expect(selected("network", path), path).toBe(true);
  for (const path of ["docs/network.md", "site/src/pages/index.astro", "site/bun.lock"])
    expect(selected("network", path), path).toBe(false);

  const producer = gateSteps.find((step) => step.id === "network-artifact");
  expect(record(producer?.with)["restore-keys"]).toBeUndefined();
  const key = String(record(producer?.with).key);
  expect(key).toContain("network-wasm-v2-");
  expect(key).toContain("tooling/network-translator/**");
  expect(key).toContain("tooling/network-growth.ts");
  for (const artifact of [
    "network.sha256",
    "network.buffer.js",
    "network.buffer.sha256",
    "network.growth.json",
  ])
    expect(String(record(producer?.with).path)).toContain(artifact);

  const rustTest = gateSteps.find(
    (step) => step.name === "Rust native, state and actual WASM tests",
  );
  expect(String(rustTest?.run)).toContain("bun tooling/check-network-rust.ts");
  expect(String(rustTest?.run)).toContain(
    "cargo test --release -p waffle-tcp --features module-tests --locked",
  );
  expect(record(rustTest?.env).WAFFLE_TCP_MODULE).toContain("network.wasm");
  expect(gateSteps.some((step) => String(step.run ?? "").includes("network-source-smoke.ts"))).toBe(
    true,
  );

  for (const name of ["release", "coreutils-echo", "findutils-xargs"]) {
    const source = await Bun.file(
      new URL(`../../../.github/workflows/${name}.yml`, import.meta.url),
    ).text();
    const other = record(YAML.parse(source));
    for (const job of Object.values(record(other.jobs))) {
      const steps = record(job).steps;
      if (!Array.isArray(steps)) continue;
      const cache = steps
        .map(record)
        .find((step) => ["network", "network-artifact"].includes(String(step.id)));
      if (!cache) continue;
      expect(record(cache.with).key).toBe(key);
      for (const artifact of ["network.buffer.js", "network.buffer.sha256", "network.growth.json"])
        expect(String(record(cache.with).path)).toContain(artifact);
    }
  }
});

test("programs, program leaves and oracles preserve path selection and ordering", async () => {
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
    "scripts/program-rebind.test.ts",
    "scripts/tsconfig.json",
    "packages/waffle/programs/index.ts",
    "packages/coreutils/package-artifacts.json",
    "packages/python/src/launcher.ts",
  ])
    expect(selected("programs", path), path).toBe(true);
  for (const path of ["docs/development.md", "site/src/pages/index.astro", "site/bun.lock"])
    expect(selected("programs", path), path).toBe(false);

  const optimizer = gateSteps.findIndex(
    (step) => step.uses === "./.github/actions/program-optimizer",
  );
  const sdk = gateSteps.findIndex((step) => step.id === "sdk");
  const fetchCargo = gateSteps.findIndex((step) => step.run === "cargo fetch --locked");
  expect(optimizer).toBeGreaterThanOrEqual(0);
  expect(sdk).toBeGreaterThanOrEqual(0);
  expect(fetchCargo).toBeGreaterThan(optimizer);
  for (const command of [
    "bun run programs:tools",
    "bun run programs:awk",
    "bun run programs:diffutils",
    "bun run programs:jq",
    "bun run --cwd packages/findutils build:xargs",
    "bun run --cwd packages/coreutils build:echo",
    "bun run --cwd packages/coreutils build:checksums",
  ]) {
    const index = gateSteps.findIndex((step) => String(step.run ?? "").includes(command));
    expect(index, command).toBeGreaterThan(optimizer);
  }
  for (const filter of [
    "programs",
    "coreutils",
    "findutils",
    "jq",
    "diffutils",
    "awk",
    "tar",
    "checksums",
  ]) {
    expect(selected(filter, "tools/program-optimize.ts"), filter).toBe(true);
    expect(selected(filter, "tools/program-derivation.ts"), filter).toBe(true);
    expect(selected(filter, ".github/actions/program-optimizer/action.yml"), filter).toBe(true);
  }

  // Verify specific leaf contracts: diffutils, jq, awk, tar, gh, procps, curl, checksums
  const diffutilsOracle = gateSteps.findIndex(
    (step) => step.run === "bun run --cwd packages/diffutils native-oracle",
  );
  const diffutilsBuild = gateSteps.findIndex((step) => step.name === "Build and test diffutils");
  expect(diffutilsOracle).toBeGreaterThan(0);
  expect(diffutilsBuild).toBeGreaterThan(diffutilsOracle);
  expect(record(gateSteps[diffutilsBuild]?.env).GNU_DIFF).toBe(
    "${{ github.workspace }}/.build/diffutils-native-oracle/diff",
  );
  const { diffutils } = await import("../../diffutils/src/index.ts");
  expect(diffutils.pick("diff", "/bin/cmp").programs.map((program) => program.path)).toEqual([
    "/usr/bin/diff",
    "/usr/bin/cmp",
  ]);

  const jqStep = gateSteps.find(
    (step) => step.name === "Verify pinned jq native oracle and run jq checks",
  );
  expect(String(jqStep?.run)).toContain('test "$(command -v jq)" = "$JQ_NATIVE_DIR/jq"');
  expect(String(jqStep?.run)).toContain('test "$(jq --version)" = "jq-1.8.2"');
  expect(String(jqStep?.run)).toContain("bun run programs:jq");
  expect(String(jqStep?.run)).not.toContain("apt-get");

  const awkStep = gateSteps.find((step) => step.run === "bun run programs:awk");
  expect(record(awkStep?.env).AWK_SCRATCH_ROOT).toBe("${{ runner.temp }}");

  const tarScratch = gateSteps.findIndex((step) => step.name === "Set run-owned tar scratch root");
  const tarBuild = gateSteps.findIndex((step) => step.name === "Build and verify tar");
  expect(tarScratch).toBeGreaterThan(0);
  expect(tarBuild).toBeGreaterThan(tarScratch);
  expect(String(gateSteps[tarScratch]?.run)).toContain("TAR_SCRATCH_ROOT=%s");

  const procpsLint = gateSteps.find((step) => step.name === "Lint procps");
  const procpsFmt = gateSteps.find((step) => step.name === "Check procps formatting");
  expect(procpsLint?.["working-directory"]).toBe("packages/procps");
  expect(procpsFmt?.["working-directory"]).toBe("packages/procps");

  const checksumOracle = gateSteps.findIndex(
    (step) =>
      step.run === "node packages/coreutils/scripts/build-native-checksum-oracle.ts --verify-only",
  );
  const checksumBuild = gateSteps.findIndex(
    (step) => step.run === "bun run --cwd packages/coreutils build:checksums",
  );
  const checksumReadback = gateSteps.findIndex(
    (step) => step.name === "Read back the exact admitted checksum guests",
  );
  const checksumTest = gateSteps.findIndex(
    (step) => step.run === "bun run --cwd packages/coreutils test:checksums:wasi",
  );
  expect(checksumBuild).toBeGreaterThan(fetchCargo);
  expect(checksumBuild).toBeGreaterThan(checksumOracle);
  expect(checksumReadback).toBeGreaterThan(checksumBuild);
  expect(checksumTest).toBeGreaterThan(checksumReadback);

  const matrix = await Bun.file(new URL("../scripts/test-browser.ts", import.meta.url)).text();
  expect(matrix.match(/"tests\/network-browser-runner.ts"/g)).toHaveLength(2);
  expect(matrix).toContain('engines: ["--page-controls", "chromium"]');
});

test("leaf filters stay isolated from unrelated packages", () => {
  expect(selected("gh", "packages/gh/src/program.ts")).toBe(true);
  for (const name of ["programs", "coreutils", "findutils", "network", "browser", "libc"])
    expect(selected(name, "packages/gh/src/program.ts"), name).toBe(false);
  expect(selected("procps", "packages/procps/src/index.ts")).toBe(true);
  for (const name of [
    "programs",
    "coreutils",
    "findutils",
    "network",
    "browser",
    "libc",
    "jq",
    "diffutils",
  ])
    expect(selected(name, "packages/procps/src/index.ts"), name).toBe(false);
  expect(selected("curl", "packages/curl/src/index.ts")).toBe(true);
  expect(selected("awk", "packages/awk/scripts/build-awk.ts")).toBe(true);
  expect(selected("awk", "packages/jq/src/index.ts")).toBe(false);
  expect(selected("jq", "packages/jq/scripts/build-jaq.ts")).toBe(true);
  expect(selected("jq", "packages/coreutils/src/lib.rs")).toBe(false);
  expect(selected("diffutils", "packages/diffutils/src/index.ts")).toBe(true);
  expect(selected("diffutils", "packages/grep/src/index.ts")).toBe(false);
  expect(selected("checksums", "packages/coreutils/crates/checksums/src/bin/sha256sum.rs")).toBe(
    true,
  );
  expect(selected("checksums", "packages/coreutils/crates/date/src/main.rs")).toBe(false);
});

import "../../../tools/ci-release-coverage.test.ts";
import "../../../tools/ci-release-download.test.ts";
