import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { discoverScoreboardTests } from "./scoreboard-tests.mjs";

const source = readFileSync(new URL("../fixtures/file-utilities.json", import.meta.url), "utf8");
const mutations = [
  { name: "schema", path: "schema", value: 2, reason: "schema" },
  { name: "case script", path: "cases.0.script", value: "false", reason: "case identities" },
  { name: "GNU identities", path: "coreutils", value: undefined, reason: "record keys" },
  { name: "Bash hash", path: "bash.sha256", value: "0".repeat(64), reason: "Bash identity" },
  {
    name: "Bash version",
    path: "bash.version",
    value: "GNU bash, version 5.3.16",
    reason: "Bash identity",
  },
  {
    name: "GNU version",
    path: "coreutils.cp.version",
    value: "cp (GNU coreutils) 8.0",
    reason: "GNU identities",
  },
  { name: "GNU hash", path: "coreutils.cp.sha256", value: "not-a-sha", reason: "GNU identities" },
  { name: "GNU path", path: "coreutils.cp.path", value: "/bin/cp", reason: "GNU identities" },
  {
    name: "valid changed answer",
    path: "cases.0.result.tree.new",
    value: [42],
    reason: "recording (digest|byte length)",
  },
  { name: "null status", path: "cases.0.result.status", value: null, reason: "observation status" },
  {
    name: "fractional status",
    path: "cases.0.result.status",
    value: 0.5,
    reason: "observation status",
  },
  {
    name: "out-of-range status",
    path: "cases.0.result.status",
    value: 256,
    reason: "observation status",
  },
  {
    name: "invalid stdout",
    path: "cases.0.result.stdout",
    value: [256, -1],
    reason: "observation bytes",
  },
  {
    name: "non-array stdout",
    path: "cases.0.result.stdout",
    value: "",
    reason: "observation bytes",
  },
  {
    name: "string stderr",
    path: "cases.0.result.stderr",
    value: "false",
    reason: "diagnostic presence",
  },
  {
    name: "inconsistent stderr",
    path: "cases.0.result.stderr",
    value: true,
    reason: "diagnostic presence",
  },
  {
    name: "missing diagnostics",
    path: "cases.0.diagnosticBytes",
    value: undefined,
    reason: "record keys",
  },
  {
    name: "invalid diagnostics",
    path: "cases.0.diagnosticBytes",
    value: [1.5],
    reason: "observation bytes",
  },
  { name: "missing tree", path: "cases.0.result.tree", value: undefined, reason: "record keys" },
  {
    name: "invalid file bytes",
    path: "cases.0.result.tree.new",
    value: "not-bytes",
    reason: "observation bytes",
  },
  {
    name: "invalid tree path",
    path: "cases.0.result.tree./escape",
    value: [],
    reason: "tree path",
  },
  {
    name: "missing tree parent",
    path: "cases.0.result.tree.nested",
    value: undefined,
    reason: "tree parent",
  },
  { name: "missing runtime gaps", path: "runtimeGaps", value: undefined, reason: "record keys" },
  { name: "empty runtime gaps", path: "runtimeGaps", value: [], reason: "runtime gap identities" },
  {
    name: "changed runtime gap",
    path: "runtimeGaps.0.script",
    value: "mv -f input existing",
    reason: "runtime gap identities",
  },
  {
    name: "malformed runtime result",
    path: "runtimeGaps.0.result.status",
    value: null,
    reason: "observation status",
  },
  {
    name: "changed runtime answer",
    path: "runtimeGaps.0.result.tree.existing",
    value: [42],
    reason: "recording (digest|byte length)",
  },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function mutate(path: string, value: unknown) {
  const fixture: unknown = JSON.parse(source);
  const keys = path.split(".");
  const key = keys.pop();
  assert.ok(key);
  const parent = keys.reduce<unknown>((entry, part) => object(entry)[part], fixture);
  if (value === undefined) delete object(parent)[key];
  else object(parent)[key] = value;
  return JSON.stringify(fixture);
}

function load(context: TestContext, recording: string, helperReplacement?: [string, string]) {
  const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "bash-web-record-boundary-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "fixtures"), { recursive: true });
  mkdirSync(join(directory, "tests/helpers"), { recursive: true });
  copyFileSync(
    new URL("./file-utilities-observations.ts", import.meta.url),
    join(directory, "scripts/file-utilities-observations.ts"),
  );
  let helper = readFileSync(
    new URL("../tests/helpers/file-utility-cases.ts", import.meta.url),
    "utf8",
  );
  if (helperReplacement) helper = helper.replace(...helperReplacement);
  writeFileSync(join(directory, "tests/helpers/file-utility-cases.ts"), helper);
  writeFileSync(join(directory, "fixtures/file-utilities.json"), recording);
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(join(directory, "scripts/file-utilities-observations.ts"))})`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.ifError(run.error);
  return run;
}

test("frozen file observation boundary test is discovered by the scoreboard", () => {
  assert.ok(discoverScoreboardTests(import.meta.dirname).includes(import.meta.filename));
});

test("approved original recording loads unchanged", (context) => {
  const run = load(context, source);
  assert.equal(run.status, 0, run.stderr);
});

for (const mutation of mutations) {
  test(`frozen file observations reject ${mutation.name}`, (context) => {
    const run = load(context, mutate(mutation.path, mutation.value));
    assert.notEqual(run.status, 0, `accepted altered ${mutation.name}`);
    assert.match(run.stderr, new RegExp(mutation.reason));
  });
}

test("frozen file observations reject same-size changed answer bytes", (context) => {
  const altered = source.replace('"-odd": [120]', '"-odd": [121]');
  assert.notEqual(altered, source);
  assert.equal(Buffer.byteLength(altered), Buffer.byteLength(source));
  const run = load(context, altered);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /recording digest/);
});

test("frozen file observations reject reformatting", (context) => {
  assert.notEqual(load(context, source + "\n").status, 0);
});

test("frozen file observations bind the initial tree", (context) => {
  const run = load(context, source, ['"-odd": [120]', '"-odd": [42]']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /recording context digest/);
});

test("frozen file observations bind the recording environment", (context) => {
  const run = load(context, source, ['LC_ALL: "C"', 'LC_ALL: "en_US.UTF-8"']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /recording context digest/);
});
