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
