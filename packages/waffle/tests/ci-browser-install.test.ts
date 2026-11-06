import { YAML } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const transportName = "Use Ubuntu HTTPS archives for browser dependencies";
const installCommand = "bunx playwright install --with-deps chromium firefox webkit";
const mirrorPath = "/etc/apt/apt-mirrors.txt";
// actions/runner-images configure-apt-sources.sh, blob b3f5b2b180df8eb39fcbba034f616e03a69e775c.
const azure = "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n";
const fallbacks =
  "https://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";
const officialMirrors = azure + fallbacks;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected a workflow mapping");
  return value;
}

function browserSteps() {
  const parsed = record(YAML.parse(workflow));
  const browser = record(record(parsed.jobs).browser);
  if (!Array.isArray(browser.steps)) throw new Error("expected browser steps");
  return browser.steps.map(record);
}

function transportCommand(): string {
  const matches = browserSteps().filter((step) => step.name === transportName);
  expect(matches.length).toBeLessThanOrEqual(1);
  if (matches.length === 0) return "";
  const command = matches[0]?.run;
  if (typeof command !== "string") throw new Error("expected an apt transport command");
  expect(Array.from(command.matchAll(/\/etc\/apt\/apt-mirrors\.txt/g))).toHaveLength(3);
  const adapted = command.replace(/^sudo /m, "").replaceAll(mirrorPath, '"$APT_MIRRORS_FIXTURE"');
  expect(adapted).not.toContain("/etc/apt/");
  return adapted;
}

function withMirrors(input: string | undefined, check: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "waffle-ci-apt-"));
  const path = join(directory, "apt-mirrors.txt");
  try {
    if (input !== undefined) writeFileSync(path, input);
    check(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runTransport(path: string) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", transportCommand()], {
    encoding: "utf8",
    env: { ...process.env, APT_MIRRORS_FIXTURE: path },
    timeout: 5_000,
  });
}

test("browser apt removes Azure HTTP from the official three-line mirror fixture", () => {
  expect(Buffer.byteLength(officialMirrors)).toBe(144);
  withMirrors(officialMirrors, (path) => {
    const result = runTransport(path);
    expect(result.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(fallbacks);
    expect(readFileSync(path)).toEqual(Buffer.from(fallbacks));
    expect(result.stdout).toBe(fallbacks);
  });
});

test("browser apt preserves comments, near matches, HTTPS Azure and unrelated bytes", () => {
  const preserved = [
    "# http://azure.archive.ubuntu.com/ubuntu/\tpriority:1",
    "http://azureXarchive.ubuntu.com/ubuntu/\tpriority:4",
    "http://azure.archiveXubuntu.com/ubuntu/\tpriority:4",
    "http://azure.archive.ubuntuXcom/ubuntu/\tpriority:4",
    "http://azure.archive.ubuntu.com/ubuntu-other/\tpriority:5",
    "prefix http://azure.archive.ubuntu.com/ubuntu/\tpriority:6",
    "http://azure.archive.ubuntu.com/ubuntu",
    "https://azure.archive.ubuntu.com/ubuntu/\tpriority:7",
    "",
    "# no final newline",
  ].join("\n");
  withMirrors(officialMirrors + preserved, (path) => {
    const result = runTransport(path);
    expect(result.status).toBe(0);
    expect(readFileSync(path)).toEqual(Buffer.from(fallbacks + preserved));
    expect(result.stdout).toBe(fallbacks + preserved);
  });
});

test("browser apt selection is idempotent", () => {
  withMirrors(officialMirrors, (path) => {
    expect(runTransport(path).status).toBe(0);
    const selected = readFileSync(path);
    expect(runTransport(path).status).toBe(0);
    expect(readFileSync(path)).toEqual(selected);
    expect(selected).toEqual(Buffer.from(fallbacks));
  });
});

test("browser apt rejects a missing mirror file", () => {
  withMirrors(undefined, (path) => {
    const result = runTransport(path);
    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("apt-mirrors.txt");
    expect(result.stdout).toBe("");
  });
});

test("browser apt rejects an Azure-only mirror file", () => {
  withMirrors(azure, (path) => {
    const result = runTransport(path);
    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(readFileSync(path)).toEqual(Buffer.alloc(0));
    expect(result.stdout).toBe("");
  });
});

test("browser apt rejects an empty mirror file", () => {
  withMirrors("", (path) => {
    const result = runTransport(path);
    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

test("browser apt selection immediately precedes the unchanged complete Playwright install", () => {
  const steps = browserSteps();
  const install = steps.findIndex((step) => step.run === installCommand);
  const transport = steps.findIndex((step) => step.name === transportName);
  expect(transport).toBeGreaterThanOrEqual(0);
  expect(install).toBe(transport + 1);
  expect(steps[transport]).toEqual({ name: transportName, run: expect.any(String) });
  expect(steps[install]).toEqual({ run: installCommand });
  expect(steps.filter((step) => step.run === installCommand)).toHaveLength(1);
});

const cacheKeyName = "Resolve the Playwright browser cache key";
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

function browserJob() {
  return record(record(record(YAML.parse(workflow)).jobs).browser);
}

function cacheKeyCommand(): string {
  const matches = browserSteps().filter((step) => step.name === cacheKeyName);
  expect(matches).toHaveLength(1);
  const command = matches[0]?.run;
  if (typeof command !== "string") throw new Error("expected a cache key command");
  expect(command).not.toContain("${{");
  expect(command).toContain("bun --no-install -e");
  expect(Array.from(command.matchAll(/\/etc\/os-release/g))).toHaveLength(1);
  return command.replace("/etc/os-release", '"$OS_RELEASE_FIXTURE"');
}

function resolveCacheKey(osRelease: string, cwd = repositoryRoot) {
  const directory = mkdtempSync(join(tmpdir(), "waffle-ci-playwright-"));
  try {
    const release = join(directory, "os-release");
    const output = join(directory, "github-output");
    writeFileSync(release, osRelease);
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-e", "-c", cacheKeyCommand()], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        OS_RELEASE_FIXTURE: release,
        GITHUB_OUTPUT: output,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
      },
      timeout: 10_000,
    });
    return { ...result, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function installedBrowsersHash(): string {
  const playwright = Bun.resolveSync("playwright/package.json", repositoryRoot);
  const core = Bun.resolveSync("playwright-core/package.json", playwright);
  const browsers = readFileSync(join(core, "..", "browsers.json"));
  return new Bun.CryptoHasher("sha256").update(browsers).digest("hex");
}

test("browser job pins the runner image its cached Playwright browsers were proven on", () => {
  const runsOn = browserJob()["runs-on"];
  expect(runsOn).toBe("ubuntu-24.04");
  expect(String(runsOn)).not.toContain("latest");
});

test("Playwright cache key comes from the resolved browser revisions and OS release", () => {
  const steps = browserSteps();
  const resolve = steps.findIndex((step) => step.name === cacheKeyName);
  const cache = steps.findIndex(
    (step) => record(step.with ?? {}).path === "~/.cache/ms-playwright",
  );
  const packages = steps.findIndex(
    (step) => step.run === "bun install --frozen-lockfile --ignore-scripts",
  );
  const install = steps.findIndex((step) => step.run === installCommand);
  expect(packages).toBeGreaterThanOrEqual(0);
  expect(resolve).toBeGreaterThan(packages);
  expect(cache).toBe(resolve + 1);
  expect(install).toBeGreaterThan(cache);
  expect(steps[resolve]?.id).toBe("playwright-cache");
  expect(steps[cache]?.uses).toBe("actions/cache@v4");
  expect(record(steps[cache]?.with)).toEqual({
    path: "~/.cache/ms-playwright",
    key: "${{ steps.playwright-cache.outputs.key }}",
  });
  expect(workflow).not.toContain("hashFiles('node_modules/playwright-core/browsers.json')");
});

test("Playwright cache key separates OS generations for the same browser revisions", () => {
  const noble = resolveCacheKey('ID=ubuntu\nVERSION_ID="24.04"\n');
  const resolute = resolveCacheKey('ID=ubuntu\nVERSION_ID="26.04"\n');
  expect(noble.status).toBe(0);
  expect(resolute.status).toBe(0);
  const hash = installedBrowsersHash();
  expect(noble.output).toBe(`key=Linux-X64-ubuntu24.04-playwright-v1-${hash}\n`);
  expect(resolute.output).toBe(`key=Linux-X64-ubuntu26.04-playwright-v1-${hash}\n`);
});

test("Playwright cache key fails closed without a resolvable Playwright install", () => {
  const directory = mkdtempSync(join(tmpdir(), "waffle-ci-playwright-empty-"));
  try {
    const result = resolveCacheKey('ID=ubuntu\nVERSION_ID="24.04"\n', directory);
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Playwright cache key fails closed without an OS release identity", () => {
  const result = resolveCacheKey("NAME=unknown\n");
  expect(result.status).not.toBe(0);
  expect(result.output).toBe("");
});
