import { createScratch } from "../tests/scratch.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

interface CompareCase {
  id: string;
  argv: string[];
  expect: { exit: number; stdout: Expectation; stderr: Expectation };
}
type Expectation =
  | { kind: "empty" | "any" | "json" | "jsonArray"; value?: string }
  | { kind: "text" | "contains"; value: string };

const selected = new Set([
  "jq-requires-json",
  "invalid-limit",
  "repo-view-rejects-repo-flag",
  "api-rejects-json-flag",
  "slurp-requires-paginate",
  "missing-auth",
]);
const contract = JSON.parse(
  await readFile(new URL("../fixtures/cases.json", import.meta.url), "utf8"),
);
const cases = (contract.cases as CompareCase[]).filter((fixture) => selected.has(fixture.id));
const root = await createScratch("gh-native-compare-");
const cleanup = () => rm(root, { recursive: true, force: true });
process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));
process.once("SIGTERM", () => void cleanup().then(() => process.exit(143)));

try {
  for (const fixture of cases) compare(fixture);
  console.log(`native gh offline comparison: ${cases.length} cases passed`);
} finally {
  await cleanup();
}

function compare(fixture: CompareCase): void {
  const native = execute("gh", fixture.argv.slice(1), fixture.id);
  const candidate = execute(
    process.execPath,
    [resolve(import.meta.dirname, "../dist/gh-cli.js"), ...fixture.argv.slice(1)],
    fixture.id,
  );
  for (const result of [native, candidate]) {
    assert.equal(result.status, fixture.expect.exit, `${fixture.id}: exit`);
    assert.equal(
      result.stdout,
      expectedText(fixture.expect.stdout, result.stdout),
      `${fixture.id}: stdout`,
    );
    assert.equal(
      result.stderr,
      expectedText(fixture.expect.stderr, result.stderr),
      `${fixture.id}: stderr`,
    );
  }
  assert.equal(native.stdout, candidate.stdout, `${fixture.id}: native stdout`);
  assert.equal(
    firstLine(native.stderr),
    firstLine(candidate.stderr),
    `${fixture.id}: native diagnostic`,
  );
}

function execute(command: string, argv: string[], id: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_CONFIG_DIR: root,
    HOME: root,
    NO_COLOR: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_REPO", "GH_HOST", "GITHUB_ACTIONS"])
    delete env[name];
  if (id !== "missing-auth") env.GH_TOKEN = "GH_CONTRACT_FAKE_TOKEN_NEVER_VALID";
  const result = spawnSync(command, argv, { env, encoding: "utf8", timeout: 10_000 });
  if (result.error) throw result.error;
  return result;
}

function expectedText(expectation: Expectation, actual: string): string {
  if (expectation.kind === "any") return actual;
  if (expectation.kind === "empty") return "";
  if (expectation.kind === "text") return expectation.value;
  if (expectation.kind === "contains") {
    assert.ok(actual.includes(expectation.value), actual);
    return actual;
  }
  return actual;
}

function firstLine(value: string): string {
  return value.split("\n")[0];
}
