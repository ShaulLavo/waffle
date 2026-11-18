import { YAML } from "bun";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const archiveAction = "./.github/actions/ubuntu-main-archive";
const installCommand = "bunx playwright install --with-deps chromium firefox webkit";

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

/** The action's command, pointed at a fixture apt tree instead of /etc/apt, without sudo. */
function archiveCommand(): string {
  const action = record(
    YAML.parse(
      readFileSync(new URL(`../../.${archiveAction}/action.yml`, import.meta.url), "utf8"),
    ),
  );
  const steps = record(action.runs).steps;
  if (!Array.isArray(steps) || steps.length !== 1) throw new Error("expected one action step");
  const command = record(steps[0]).run;
  if (typeof command !== "string") throw new Error("expected an apt archive command");
  const adapted = command.replaceAll("sudo ", "").replaceAll("/etc/apt", '"$APT_FIXTURE"');
  expect(adapted).not.toContain("/etc/apt");
  return adapted;
}

function withApt(files: Record<string, string>, check: (apt: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "waffle-ci-apt-"));
  try {
    mkdirSync(join(directory, "sources.list.d"));
    for (const [name, contents] of Object.entries(files))
      writeFileSync(join(directory, name), contents);
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runArchive(apt: string) {
  return spawnSync("bash", ["-eo", "pipefail", "-c", archiveCommand()], {
    encoding: "utf8",
    env: { ...process.env, APT_FIXTURE: apt },
    timeout: 5_000,
  });
}

// actions/runner-images mirror list shape, with the AWS host seen on bash-web run 44383081889.
const mirrors =
  "http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:1\n" +
  "http://azure.archive.ubuntu.com/ubuntu/\tpriority:2\n" +
  "https://security.ubuntu.com/ubuntu/\tpriority:3\n";
const sources =
  "URIs: http://azure.archive.ubuntu.com/ubuntu/\nURIs: http://security.ubuntu.com/ubuntu/\n" +
  "URIs: http://ports.ubuntu.com/ubuntu-ports/\n";
const rewritten = {
  "apt-mirrors.txt":
    "https://archive.ubuntu.com/ubuntu/\tpriority:1\n" +
    "https://archive.ubuntu.com/ubuntu/\tpriority:2\n" +
    "https://security.ubuntu.com/ubuntu/\tpriority:3\n",
  "sources.list.d/ubuntu.sources":
    "URIs: https://archive.ubuntu.com/ubuntu/\nURIs: http://security.ubuntu.com/ubuntu/\n" +
    "URIs: http://ports.ubuntu.com/ubuntu-ports/\n",
};

test("apt moves regional archive mirrors to the main archive and keeps security and ports", () => {
  withApt({ "apt-mirrors.txt": mirrors, "sources.list.d/ubuntu.sources": sources }, (apt) => {
    const result = runArchive(apt);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("apt archive host: https://archive.ubuntu.com/ubuntu\n");
    for (const [name, contents] of Object.entries(rewritten))
      expect(readFileSync(join(apt, name), "utf8")).toBe(contents);
  });
});

test("apt archive rewrite is idempotent", () => {
  withApt({ "apt-mirrors.txt": mirrors, "sources.list.d/ubuntu.sources": sources }, (apt) => {
    expect(runArchive(apt).status).toBe(0);
    expect(runArchive(apt).status).toBe(0);
    for (const [name, contents] of Object.entries(rewritten))
      expect(readFileSync(join(apt, name), "utf8")).toBe(contents);
  });
});

test("apt archive rewrite reports when no archive host is configured", () => {
  withApt({}, (apt) => {
    const result = runArchive(apt);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("apt archive host: none found\n");
  });
});

function jobSteps(name: string) {
  const job = record(record(record(YAML.parse(workflow)).jobs)[name]);
  return Array.isArray(job.steps) ? job.steps.map(record) : [];
}

test("the main-archive action immediately precedes the unchanged complete Playwright install", () => {
  const steps = browserSteps();
  const install = steps.findIndex((step) => step.run === installCommand);
  expect(install).toBeGreaterThan(0);
  expect(steps[install - 1]).toEqual({ uses: archiveAction });
  expect(steps[install]).toEqual({ run: installCommand });
  expect(steps.filter((step) => step.run === installCommand)).toHaveLength(1);
});

test("every workflow apt-get install runs right after the main-archive action", () => {
  const jobs = Object.keys(record(record(YAML.parse(workflow)).jobs));
  let installs = 0;
  for (const name of jobs) {
    const steps = jobSteps(name);
    steps.forEach((step, index) => {
      if (typeof step.run !== "string" || !step.run.includes("apt-get install")) return;
      installs++;
      expect(steps[index - 1]).toEqual({ uses: archiveAction });
    });
  }
  expect(installs).toBeGreaterThan(0);
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
