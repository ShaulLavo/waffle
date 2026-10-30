import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { prepareFields } from "../src/api-fields.ts";
import { runGh } from "../src/cli.ts";
import { nodeFileSystem } from "../src/filesystem.ts";
import { decode, encode } from "../src/json.ts";
import { executeJq } from "../src/jq.ts";
import { PlaceholderResolver, discoverGit } from "../src/repository.ts";
import type { HttpRequest, HttpResponse, Invocation } from "../src/types.ts";

test("invalid jq fails explicitly after the API response", async () => {
  const result = await execute({
    argv: ["api", "repos/cli/cli", "--jq", ".["],
    responses: [jsonResponse({})],
  });
  assert.equal(result.exit, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /jq|parse|compile/i);
});

test("a foreign pagination URL fails before another request", async () => {
  const requests: HttpRequest[] = [];
  const first = jsonResponse([{ id: 1 }], {
    link: '<https://example.invalid/steal?page=2>; rel="next"',
  });
  const result = await execute({
    argv: ["api", "repos/octo/example/issues", "--paginate"],
    responses: [first],
    requests,
  });
  assert.equal(result.exit, 1);
  assert.equal(requests.length, 1);
  assert.match(result.stderr, /only https:\/\/api\.github\.com/);
  assert.ok(!result.stderr.includes("fixture-token"));
});

test("typed fields preserve nested arrays and scalar types", async () => {
  const root = await mkdtemp("/work/tmp/gh-fields-");
  try {
    const invocation = baseInvocation(root, []);
    const fields = await prepareFields(
      invocation,
      [],
      ["items[][name]=one", "items[][enabled]=true", "items[][count]=2", "empty[]"],
      new PlaceholderResolver(invocation),
    );
    assert.deepEqual(fields.values, {
      items: [{ name: "one", enabled: true, count: 2 }],
      empty: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GraphQL pagination supplies the cursor and evaluates each page", async () => {
  const query =
    "query($endCursor: String) { viewer { repositories(first: 100, after: $endCursor) { nodes { name } pageInfo { hasNextPage endCursor } } } }";
  const requests: HttpRequest[] = [];
  const result = await execute({
    argv: [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "--paginate",
      "--jq",
      ".data.viewer.repositories.nodes[].name",
    ],
    responses: [
      jsonResponse({
        data: {
          viewer: {
            repositories: {
              nodes: [{ name: "one" }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        },
      }),
      jsonResponse({
        data: {
          viewer: {
            repositories: {
              nodes: [{ name: "two" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    ],
    requests,
  });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.stdout, "one\ntwo\n");
  assert.equal(requests.length, 2);
  const secondBody = requests[1].body;
  assert.ok(secondBody);
  const second = JSON.parse(decode(secondBody));
  assert.equal(second.variables.endCursor, "cursor-1");
});

test("Git discovery reads worktree metadata and preserves remote case", async (context) => {
  const root = await mkdtemp("/work/tmp/gh-git-discovery-");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(`${root}/.git`, { recursive: true });
  await writeFile(`${root}/.git/HEAD`, "ref: refs/heads/topic\n");
  await writeFile(
    `${root}/.git/config`,
    `[remote "origin"]\n  url = git@github.com:Octo/Example.git\n[branch "topic"]\n  gh-merge-base = main\n`,
  );
  const invocation = baseInvocation(root, []);
  assert.deepEqual(await discoverGit(invocation), {
    repository: { owner: "Octo", name: "Example" },
    source: "git",
    branch: "topic",
    mergeBase: "main",
  });
});

test("real jq returns compact structures and raw scalars", async () => {
  const context = { cwd: "/", env: {} };
  assert.equal(
    await executeJq('map(select(. > 1)) | sort | join("\\n")', [3, 1, 2], context),
    "2\n3\n",
  );
  assert.equal(await executeJq("{answer: 42}", null, context), '{"answer":42}\n');
  assert.equal(await executeJq("empty", null, context), "");
});

interface ExecuteOptions {
  argv: string[];
  responses: HttpResponse[];
  requests?: HttpRequest[];
}

async function execute(options: ExecuteOptions) {
  const root = await mkdtemp("/work/tmp/gh-core-test-");
  try {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const invocation = baseInvocation(root, options.responses);
    const originalTransport = invocation.transport;
    const tracked: Invocation = {
      ...invocation,
      argv: options.argv,
      stdout: (bytes) => {
        stdout.push(bytes);
      },
      stderr: (bytes) => {
        stderr.push(bytes);
      },
      transport: async (request) => {
        options.requests?.push(request);
        return originalTransport(request);
      },
    };
    const exit = await runGh(tracked);
    return {
      exit,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function baseInvocation(root: string, responses: HttpResponse[]): Invocation {
  let index = 0;
  return {
    argv: [],
    cwd: root,
    env: { HOME: root, GH_CONFIG_DIR: "fixture-config", GH_TOKEN: "fixture-token" },
    stdin: async () => new Uint8Array(),
    stdout: () => {},
    stderr: () => {},
    filesystem: nodeFileSystem,
    evaluator: executeJq,
    transport: async () => {
      const response = responses[index++];
      assert.ok(response, "unexpected request");
      return response;
    },
  };
}

function jsonResponse(
  value: import("../src/types.ts").JsonValue,
  headers: Record<string, string> = {},
): HttpResponse {
  return { status: 200, headers, body: encode(JSON.stringify(value)) };
}
