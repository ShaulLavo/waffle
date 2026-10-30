import { createScratch } from "./scratch.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { runGh } from "../src/cli.ts";
import { nodeFileSystem } from "../src/filesystem.ts";
import { decode, encode } from "../src/json.ts";
import { executeJq } from "../src/jq.ts";
import type { HttpRequest, HttpResponse, Invocation, JsonObject, JsonValue } from "../src/types.ts";

interface Observation {
  id: string;
  exit: number;
  stdout: string;
  stderr: string;
}
interface Case {
  id: string;
  argv: string[];
  env?: Record<string, string>;
}
const cases = JSON.parse(await readFile(new URL("../fixtures/cases.json", import.meta.url), "utf8"))
  .cases as Case[];
const oracleBytes = await readFile(new URL("../fixtures/online-oracle.json", import.meta.url));
const lock = JSON.parse(await readFile(new URL("../sources.lock.json", import.meta.url), "utf8"));
assert.equal(
  createHash("sha256").update(oracleBytes).digest("hex"),
  lock.fixtures["online-oracle.json"].sha256,
);
const observations = JSON.parse(decode(oracleBytes)).observations as Observation[];
const onlineIds = new Set([
  "repo-discovery-env",
  "repo-view-json",
  "pr-view-json",
  "pr-view-jq",
  "pr-list-filter",
  "issue-view-json",
  "issue-list-state",
  "run-list-filter",
  "run-view-json-exit-status",
  "run-view-plain-failed-exit-status",
  "api-view-jq",
  "api-get-fields",
  "api-error-404",
  "fake-token-redaction",
]);
const oracle = new Map(observations.map((observation) => [observation.id, observation]));
const online = cases.filter((fixture) => onlineIds.has(fixture.id));

for (const fixture of online)
  test(`online oracle: ${fixture.id}`, async (context) => {
    const root = await createScratch("gh-online-oracle-");
    context.after(() => rm(root, { recursive: true, force: true }));
    const observation = oracle.get(observationId(fixture.id));
    assert.ok(observation, fixture.id);
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const requests: string[] = [];
    const invocation: Invocation = {
      argv: fixture.argv.slice(1),
      cwd: root,
      env: {
        HOME: root,
        GH_CONFIG_DIR: "fixture-config",
        GH_TOKEN: "fixture-token",
        ...fixture.env,
      },
      stdin: async () => new Uint8Array(),
      stdout: (bytes) => {
        stdout.push(bytes);
      },
      stderr: (bytes) => {
        stderr.push(bytes);
      },
      filesystem: nodeFileSystem,
      evaluator: executeJq,
      transport: async (request) => {
        requests.push(request.url);
        return oracleResponse(fixture.id, observation, request);
      },
    };
    const exit = await runGh(invocation);
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    assert.equal(requests.length, requestCount(fixture.id), `${fixture.id}: request count`);
    assert.equal(exit, observation.exit, `${fixture.id}: ${err}`);
    assert.equal(err, observation.stderr, fixture.id);
    if (fixture.id === "run-view-plain-failed-exit-status") assert.ok(out.length > 0, fixture.id);
    else assert.equal(out, observation.stdout, fixture.id);
    for (const secret of Object.values(fixture.env ?? {}).filter((value) =>
      value.includes("TOKEN"),
    )) {
      assert.ok(!out.includes(secret) && !err.includes(secret), `${fixture.id}: redaction`);
    }
  });

function oracleResponse(id: string, observation: Observation, request: HttpRequest): HttpResponse {
  const path = new URL(request.url).pathname;
  if (id === "api-error-404" || id === "fake-token-redaction")
    return rawResponse(id === "api-error-404" ? 404 : 401, observation.stdout);
  if (id === "repo-discovery-env" || id === "api-view-jq") {
    assert.equal(path, "/repos/cli/cli", id);
    return jsonResponse({ full_name: "cli/cli" });
  }
  if (id === "api-get-fields") {
    assert.equal(path, "/repos/cli/cli/issues", id);
    return jsonResponse([{ number: 1 }]);
  }
  return highLevelResponse(id, observation, path);
}

function highLevelResponse(id: string, observation: Observation, path: string): HttpResponse {
  const source = id === "pr-view-jq" ? oracle.get("pr-view-json") : observation;
  assert.ok(source, id);
  const expected =
    id === "run-view-plain-failed-exit-status" ? {} : (JSON.parse(source.stdout) as JsonValue);
  if (id === "repo-view-json") {
    const value = expected as JsonObject;
    assert.equal(path, "/repos/ShaulLavo/waffle");
    return jsonResponse({ full_name: value.nameWithOwner, html_url: value.url });
  }
  if (id === "pr-view-json" || id === "pr-view-jq") {
    const value = expected as JsonObject;
    assert.equal(path, "/repos/ShaulLavo/waffle/pulls/231");
    return jsonResponse({ number: value.number, title: value.title, state: "open" });
  }
  if (id === "pr-list-filter") {
    assert.equal(path, "/repos/ShaulLavo/waffle/pulls");
    const values = expected as JsonObject[];
    return jsonResponse(
      values.map((value) => ({ number: value.number, title: value.title, state: "open" })),
    );
  }
  if (id === "issue-view-json") return issueViewResponse(path, expected as JsonObject);
  if (id === "issue-list-state") {
    assert.equal(path, "/repos/cli/cli/issues");
    const values = expected as JsonObject[];
    return jsonResponse(
      values.map((value) => ({ number: value.number, title: value.title, state: "closed" })),
    );
  }
  return runResponse(id, path, expected);
}

function issueViewResponse(path: string, expected: JsonObject): HttpResponse {
  if (path === "/repos/cli/cli/issues/1")
    return jsonResponse({
      number: expected.number,
      title: expected.title,
      state: "closed",
      pull_request: {},
    });
  assert.equal(path, "/repos/cli/cli/pulls/1");
  return jsonResponse({ state: "closed", merged_at: "2020-01-01T00:00:00Z" });
}

function runResponse(id: string, path: string, expected: JsonValue): HttpResponse {
  if (id === "run-list-filter" && path === "/repos/ShaulLavo/waffle/actions/runs") {
    const values = expected as JsonObject[];
    return jsonResponse({
      workflow_runs: values.map((value) => ({
        id: value.databaseId,
        status: value.status,
        conclusion: value.conclusion,
        workflow_id: 301,
      })),
    });
  }
  if (path === "/repos/ShaulLavo/waffle/actions/workflows") return jsonResponse({ workflows: [] });
  if (path === "/repos/ShaulLavo/waffle/actions/workflows/301")
    return jsonResponse({ id: 301, name: "CI" });
  if (path.endsWith("/jobs")) return jsonResponse({ jobs: [] });
  assert.match(path, /\/actions\/runs\/41036415169$/, id);
  const value = expected as JsonObject;
  return jsonResponse({
    id: value.databaseId ?? 41036415169,
    status: "completed",
    conclusion: "failure",
    workflow_id: 301,
  });
}

function jsonResponse(value: JsonValue, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: encode(JSON.stringify(value)),
  };
}

function rawResponse(status: number, body: string): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: encode(body) };
}

function observationId(id: string): string {
  return id === "run-view-plain-failed-exit-status" ? "run-view-plain-exit-status" : id;
}

function requestCount(id: string): number {
  if (id === "issue-view-json" || id === "run-list-filter" || id === "run-view-json-exit-status")
    return 2;
  if (id === "run-view-plain-failed-exit-status") return 3;
  return 1;
}
