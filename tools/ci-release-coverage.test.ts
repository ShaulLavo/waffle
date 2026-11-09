import { YAML } from "bun";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function workflowFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? workflowFiles(path) : [path];
  });
}

test("CI release downloads cannot use public-only setup actions or curl", () => {
  const findings = workflowFiles(join(root, ".github")).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return text
      .split("\n")
      .flatMap((line, index) =>
        /uses:\s*(?:oven-sh\/setup-bun|actions\/setup-node|mozilla-actions\/sccache-action|bytecodealliance\/actions\/wasmtime\/setup)@/.test(
          line,
        ) || /curl[^\n]*https:\/\/github\.com\/[^\s]+\/releases\/download\//.test(line)
          ? [`${path.slice(root.length)}:${index + 1}: ${line.trim()}`]
          : [],
      );
  });
  expect(findings).toEqual([]);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected mapping");
  return value;
}
function steps(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected steps");
  return value.map(record);
}
const workflows = workflowFiles(join(root, ".github/workflows")).map((path) => ({
  path,
  workflow: record(YAML.parse(readFileSync(path, "utf8"))),
}));
const safeActions = new Set([
  "actions/cache",
  "actions/cache/restore",
  "actions/cache/save",
  "actions/checkout",
  "actions/download-artifact",
  "actions/upload-artifact",
  "dorny/paths-filter",
  "dtolnay/rust-toolchain",
  "docker/login-action",
]);

test("new remote CI actions must be audited for implicit release downloads", () => {
  for (const path of workflowFiles(join(root, ".github"))) {
    const source = readFileSync(path, "utf8");
    const actions = source.matchAll(/uses:\s*([^\s@]+)@[^\s]+/g);
    for (const match of actions)
      expect(safeActions.has(match[1] ?? ""), `${path}: ${match[1]}`).toBe(true);
  }
});

function verifyShellDownloads(path: string, list: Record<string, unknown>[]) {
  for (const step of list) {
    if (typeof step.run !== "string") continue;
    const expanded = step.run + JSON.stringify(step.env ?? {});
    if (/releases\/download\//.test(expanded))
      expect(step.run, path).not.toMatch(/\b(curl|wget)\b/);
  }
}

function verifyJob(path: string, job: Record<string, unknown>) {
  if (!job.steps) return;
  const list = steps(job.steps);
  const cache = list.findIndex((step) => step.uses === "./.github/actions/release-downloads");
  const consumers = list.flatMap((step, index) =>
    /^\.\/\.github\/actions\/(setup-tools|program-optimizer|rust-build-cache|setup-wasmtime)$/.test(
      String(step.uses),
    )
      ? [index]
      : [],
  );
  if (cache >= 0) {
    const saved = list.at(-1);
    expect(saved?.uses).toBe("./.github/actions/save-release-downloads");
    expect(saved?.if).toBe("always() && env.CI_RELEASE_CACHE_INITIAL != ''");
  }
  for (const index of consumers) {
    expect(cache, `${path}: cache before ${list[index]?.uses}`).toBeGreaterThanOrEqual(0);
    expect(cache).toBeLessThan(index);
  }
  verifyShellDownloads(path, list);
}

test("every download consumer restores release bytes before bootstrap and has a job token", () => {
  for (const { path, workflow } of workflows) {
    expect(record(workflow.env).GITHUB_TOKEN, path).toBe("${{ github.token }}");
    for (const value of Object.values(record(workflow.jobs))) verifyJob(path, record(value));
  }
});

test("local download actions cannot bypass the shared transport with a multiline curl", () => {
  for (const path of workflowFiles(join(root, ".github/actions"))) {
    const action = record(YAML.parse(readFileSync(path, "utf8")));
    verifyShellDownloads(path, steps(record(action.runs).steps));
  }
});

test("release cache saves an asset inventory only when new complete assets arrived", () => {
  const action = record(
    YAML.parse(readFileSync(join(root, ".github/actions/release-downloads/action.yml"), "utf8")),
  );
  const cache = steps(record(action.runs).steps).find(
    (step) => step.uses === "actions/cache/restore@v4",
  );
  const inputs = record(cache?.with);
  expect(inputs.path).toBe("${{ runner.temp }}/github-release-assets");
  expect(String(inputs.key)).toContain("${{ github.job }}");
  expect(String(inputs["restore-keys"])).toContain("${{ github.job }}-");
  const saved = record(
    YAML.parse(
      readFileSync(join(root, ".github/actions/save-release-downloads/action.yml"), "utf8"),
    ),
  );
  const save = steps(record(saved.runs).steps).find(
    (step) => step.uses === "actions/cache/save@v4",
  );
  expect(save?.if).toBe("steps.inventory.outputs.changed == 'true'");
  expect(String(record(save?.with).key)).toContain("${{ steps.inventory.outputs.inventory }}");
  expect(String(record(save?.with).key)).not.toMatch(/run_id|run_attempt/);
});

test("indirect native and package downloads enter the shared transport", () => {
  for (const path of [
    "packages/waffle-relay/scripts/prepare-relay-image.ts",
    "packages/waffle-relay/scripts/install-check.ts",
    "scripts/program-release.ts",
    "scripts/program-rebind.ts",
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    expect(source, path).toContain("releaseDownload");
    expect(source, path).not.toMatch(/await fetch\(url|execFileSync\("curl"/);
  }
  const native = readFileSync(
    join(root, "packages/waffle-relay/scripts/prepare-native.ts"),
    "utf8",
  );
  expect(native).toContain('if (process.env.GITHUB_ACTIONS === "true") await seedNativePrebuild()');
  expect(native).toContain('resolve("prebuild-install/bin.js")');
  for (const path of ["bun.lock", "site/bun.lock"]) {
    const lock = readFileSync(join(root, path), "utf8");
    expect(lock, path).not.toMatch(/https:\/\/github\.com\/[^"\s]+\/releases\/download\//);
  }
});
