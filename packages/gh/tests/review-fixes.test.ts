import assert from "node:assert/strict";
import { test } from "node:test";
import { runGh } from "../src/cli.ts";
import { decode, encode } from "../src/json.ts";
import { executeJq } from "../src/jq.ts";
import type { HttpRequest, HttpResponse, Invocation, JsonValue } from "../src/types.ts";

test("raw API responses preserve bytes without JSON parsing", async () => {
  const bytes = Uint8Array.from([0xff, 0x00, 0x41, 0x0a]);
  const result = await execute({
    argv: [
      "api",
      "repos/octo/example/contents/file.txt",
      "-H",
      "Accept: application/vnd.github.raw+json",
    ],
    responses: [{ status: 200, headers: {}, body: bytes }],
  });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(Buffer.concat(result.stdout), Buffer.from(bytes));
});

test("inherited JSON field names fail before transport", async () => {
  for (const field of ["toString", "constructor", "__proto__"]) {
    const result = await execute({
      argv: ["pr", "view", "1", "-R", "octo/example", "--json", field],
      responses: [],
    });
    assert.equal(result.exit, 1, field);
    assert.equal(result.requests.length, 0, field);
    assert.match(result.stderr, /Unknown JSON field/, field);
  }
});

test("mergeCommit is present only for a merged pull request", async () => {
  const cases = [
    { state: "open", merged_at: null, expectedState: "OPEN", expectedCommit: null },
    { state: "closed", merged_at: null, expectedState: "CLOSED", expectedCommit: null },
    {
      state: "closed",
      merged_at: "2026-01-01T00:00:00Z",
      expectedState: "MERGED",
      expectedCommit: { oid: "actual-merge-sha" },
    },
  ];
  for (const fixture of cases) {
    const result = await execute({
      argv: ["pr", "view", "7", "-R", "octo/example", "--json", "state,mergeCommit"],
      responses: [jsonResponse({ ...fixture, merge_commit_sha: "actual-merge-sha" })],
    });
    const output = JSON.parse(result.stdoutText);
    assert.equal(output.state, fixture.expectedState);
    assert.deepEqual(output.mergeCommit, fixture.expectedCommit);
  }
});

test("nested typed GET fields preserve every query-key segment", async () => {
  const result = await execute({
    argv: [
      "api",
      "-X",
      "GET",
      "repos/octo/example/issues",
      "-F",
      "issue[title]=Fixture",
      "-F",
      "issue[meta][active]=true",
    ],
    responses: [jsonResponse([])],
  });
  assert.equal(result.exit, 0, result.stderr);
  const query = Array.from(new URL(result.requests[0].url).searchParams.entries());
  assert.deepEqual(query, [
    ["issue[title]", "Fixture"],
    ["issue[meta][active]", "true"],
  ]);
});

test("explicit Boolean flag values control draft creation", async () => {
  for (const expected of [false, true]) {
    const result = await execute({
      argv: [
        "pr",
        "create",
        "-R",
        "octo/example",
        "--head",
        "topic",
        "--base",
        "main",
        "--title",
        "Fixture",
        `--draft=${expected}`,
      ],
      responses: [jsonResponse({ html_url: "https://github.com/octo/example/pull/1" }, 201)],
    });
    assert.equal(result.exit, 0, result.stderr);
    const requestBody = result.requests[0].body;
    assert.ok(requestBody);
    const body = JSON.parse(decode(requestBody));
    assert.equal(body.draft, expected);
  }
});

test("stored and login tokens are redacted from transport diagnostics", async () => {
  const storedToken = "fixture-stored-secret";
  const stored = await execute({
    argv: ["api", "repos/octo/example"],
    env: {},
    files: { "hosts.yml": `github.com:\n  oauth_token: ${storedToken}\n` },
    transport: async () => {
      throw new Error(`synthetic diagnostic contains ${storedToken}`);
    },
  });
  assert.equal(stored.exit, 1);
  assert.ok(!stored.stderr.includes(storedToken), stored.stderr);
  assert.match(stored.stderr, /\[REDACTED\]/);

  const loginToken = "fixture-login-secret";
  const login = await execute({
    argv: ["auth", "login", "--with-token"],
    env: {},
    stdin: `${loginToken}\n`,
    transport: async () => {
      throw new Error(`synthetic diagnostic contains ${loginToken}`);
    },
  });
  assert.equal(login.exit, 1);
  assert.ok(!login.stderr.includes(loginToken), login.stderr);
  assert.match(login.stderr, /\[REDACTED\]/);
  assert.equal(login.writes.length, 0);
});

test("active tokens are redacted from API error bodies and diagnostics", async () => {
  const token = "fixture-environment-secret";
  const result = await execute({
    argv: ["api", "repos/octo/example"],
    env: { GH_TOKEN: token },
    responses: [jsonResponse({ message: `synthetic response contains ${token}` }, 401)],
  });
  assert.equal(result.exit, 1);
  assert.ok(!result.stdoutText.includes(token), result.stdoutText);
  assert.ok(!result.stderr.includes(token), result.stderr);
  assert.match(result.stdoutText, /\[REDACTED\]/);
  assert.match(result.stderr, /\[REDACTED\]/);
});

test("include emits response headers for an empty 204 response", async () => {
  const result = await execute({
    argv: ["api", "-X", "DELETE", "repos/octo/example/issues/comments/1", "--include"],
    responses: [{ status: 204, headers: { "x-fixture": "present" }, body: new Uint8Array() }],
  });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.stdoutText, "HTTP/1.1 204\nx-fixture: present\n\n");
});

test("silent suppresses jq output", async () => {
  const result = await execute({
    argv: ["api", "repos/octo/example", "--silent", "--jq", ".name"],
    responses: [jsonResponse({ name: "fixture" })],
  });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.stdoutText, "");
});

interface ExecuteOptions {
  argv: string[];
  responses?: HttpResponse[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  stdin?: string;
  transport?: Invocation["transport"];
}

async function execute(options: ExecuteOptions) {
  const responses = options.responses ?? [];
  const requests: HttpRequest[] = [];
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const writes: string[] = [];
  let index = 0;
  const invocation: Invocation = {
    argv: options.argv,
    cwd: "/",
    env: options.env ?? { GH_TOKEN: "fixture-token" },
    stdin: async () => encode(options.stdin ?? ""),
    stdout: (bytes) => {
      stdout.push(bytes);
    },
    stderr: (bytes) => {
      stderr.push(bytes);
    },
    filesystem: {
      readFile: async (path) => {
        const name = path.split("/").at(-1) ?? "";
        const contents = options.files?.[name];
        return contents === undefined ? undefined : encode(contents);
      },
      writeFile: async (path) => {
        writes.push(path);
      },
      mkdir: async () => {},
    },
    evaluator: executeJq,
    transport:
      options.transport ??
      (async (request) => {
        requests.push(request);
        const response = responses[index++];
        assert.ok(response, "unexpected request");
        return response;
      }),
  };
  const exit = await runGh(invocation);
  return {
    exit,
    requests,
    writes,
    stdout,
    stdoutText: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function jsonResponse(value: JsonValue, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: encode(JSON.stringify(value)),
  };
}
