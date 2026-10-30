import { createScratch } from "./scratch.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runGh } from "../src/cli.ts";
import { nodeFileSystem } from "../src/filesystem.ts";
import { decode, encode, parseJson } from "../src/json.ts";
import { executeJq } from "../src/jq.ts";
import type { HttpRequest, HttpResponse, Invocation } from "../src/types.ts";

interface FixtureCase {
  id: string;
  argv: string[];
  execution: string;
  env?: Record<string, string>;
  stdin?: string;
  fixtureFiles?: Record<string, string>;
  transport?: ExpectedRequest;
  transportSequence?: ExpectedRequest[];
  fixtureResponses?: FixtureResponse[];
  expect: {
    exit: number;
    stdout: StreamExpectation;
    stderr: StreamExpectation;
    files?: Record<string, { yamlContains: Record<string, Record<string, string>> }>;
    fileAbsent?: string;
    outputOmits?: string[];
  };
}
interface ExpectedRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}
interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
type StreamExpectation =
  | { kind: "empty" }
  | { kind: "text" | "contains"; value: string }
  | { kind: "json"; value: unknown }
  | { kind: "jsonArray"; minItems: number; maxItems: number }
  | { kind: "any" };

const fixtureBytes = await readFile(new URL("../fixtures/cases.json", import.meta.url));
const lock = JSON.parse(await readFile(new URL("../sources.lock.json", import.meta.url), "utf8"));
assert.equal(
  createHash("sha256").update(fixtureBytes).digest("hex"),
  lock.fixtures["cases.json"].sha256,
);
const contract = JSON.parse(decode(fixtureBytes));
const cases = contract.cases as FixtureCase[];
const selected = cases.filter(
  (fixture) =>
    fixture.execution === "fixture-only" ||
    (fixture.execution === "oracle-offline" && fixture.id !== "invalid-jq"),
);
const temporary = new Set<string>();
const cleanup = () =>
  Promise.all(Array.from(temporary, (path) => rm(path, { recursive: true, force: true })));
process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));
process.once("SIGTERM", () => void cleanup().then(() => process.exit(143)));

try {
  for (const fixture of selected) await runFixture(fixture);
  console.log(`gh fixture contract: ${selected.length} cases passed`);
} finally {
  await cleanup();
}

async function runFixture(fixture: FixtureCase): Promise<void> {
  const root = await createScratch("gh-fixtures-");
  temporary.add(root);
  try {
    for (const [name, contents] of Object.entries(fixture.fixtureFiles ?? {})) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    const expected = fixture.transportSequence ?? (fixture.transport ? [fixture.transport] : []);
    const responses = fixture.fixtureResponses ?? [];
    let requestIndex = 0;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const env: Record<string, string> = {
      HOME: root,
      GH_CONFIG_DIR: "fixture-config",
      GH_TOKEN: "fixture-token",
      ...fixture.env,
    };
    if (["missing-auth", "auth-stored-fallback", "auth-login-with-token"].includes(fixture.id)) {
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
    }
    const invocation: Invocation = {
      argv: fixture.argv.slice(1),
      cwd: root,
      env,
      stdin: async () => encode(fixture.stdin ?? ""),
      stdout: (bytes) => {
        stdout.push(bytes);
      },
      stderr: (bytes) => {
        stderr.push(bytes);
      },
      filesystem: nodeFileSystem,
      evaluator: executeJq,
      transport: async (request) => {
        const wanted = expected[requestIndex];
        assert.ok(wanted, `${fixture.id}: unexpected request ${request.method} ${request.url}`);
        const response = responses[requestIndex++];
        assert.ok(response, `${fixture.id}: missing fixture response`);
        checkRequest(fixture.id, request, wanted);
        return responseBytes(response);
      },
    };
    const exit = await runGh(invocation);
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    assert.equal(requestIndex, expected.length, `${fixture.id}: request count; ${err}`);
    assert.equal(exit, fixture.expect.exit, `${fixture.id}: exit; ${err}`);
    checkStream(`${fixture.id}: stdout`, out, fixture.expect.stdout);
    checkStream(`${fixture.id}: stderr`, err, fixture.expect.stderr);
    for (const secret of fixture.expect.outputOmits ?? []) {
      assert.ok(!out.includes(secret) && !err.includes(secret), `${fixture.id}: token redaction`);
    }
    if (fixture.expect.fileAbsent)
      await assert.rejects(
        readFile(join(root, fixture.expect.fileAbsent)),
        `${fixture.id}: file absent`,
      );
    await checkFiles(root, fixture);
  } catch (error) {
    throw new Error(`${fixture.id} failed`, { cause: error });
  } finally {
    await rm(root, { recursive: true, force: true });
    temporary.delete(root);
  }
}

function checkRequest(id: string, request: HttpRequest, expected: ExpectedRequest): void {
  const url = new URL(request.url);
  assert.equal(request.method, expected.method, `${id}: method`);
  assert.equal(url.pathname, expected.path, `${id}: path`);
  const actualQuery = Object.fromEntries(url.searchParams.entries());
  const wantedQuery = Object.fromEntries(
    Object.entries(expected.query ?? {}).map(([name, value]) => [name, String(value)]),
  );
  assert.deepEqual(actualQuery, wantedQuery, `${id}: query`);
  for (const [name, value] of Object.entries(expected.headers ?? {})) {
    const actual = Object.entries(request.headers).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    assert.equal(actual?.[1], value, `${id}: header ${name}`);
  }
  if (expected.body !== undefined) {
    assert.ok(request.body, `${id}: request body`);
    assert.deepEqual(parseJson(request.body), expected.body, `${id}: body`);
  }
}

function responseBytes(response: FixtureResponse): HttpResponse {
  return {
    status: response.status,
    headers: Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
    body:
      response.body === null ? new Uint8Array() : encode(JSON.stringify(response.body, null, 2)),
  };
}

function checkStream(id: string, actual: string, expected: StreamExpectation): void {
  if (expected.kind === "empty") assert.equal(actual, "", id);
  if (expected.kind === "text") assert.equal(actual, expected.value, id);
  if (expected.kind === "contains") assert.ok(actual.includes(expected.value), `${id}: ${actual}`);
  if (expected.kind === "json") assert.deepEqual(JSON.parse(actual), expected.value, id);
  if (expected.kind === "jsonArray") {
    const value = JSON.parse(actual);
    assert.ok(Array.isArray(value), id);
    assert.ok(value.length >= expected.minItems && value.length <= expected.maxItems, id);
  }
}

async function checkFiles(root: string, fixture: FixtureCase): Promise<void> {
  for (const [name, expectation] of Object.entries(fixture.expect.files ?? {})) {
    const source = await readFile(join(root, name), "utf8");
    for (const [host, values] of Object.entries(expectation.yamlContains)) {
      assert.ok(source.includes(`${host}:`), `${fixture.id}: host ${host}`);
      for (const [key, value] of Object.entries(values))
        assert.ok(source.includes(`${key}: ${JSON.stringify(value)}`), `${fixture.id}: ${key}`);
    }
  }
}
