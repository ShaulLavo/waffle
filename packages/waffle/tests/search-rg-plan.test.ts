import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FilesystemClient } from "../fs/client.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import type { WalkCursor, WalkPage, WalkPlan } from "../fs/walk.js";
import { compileMatcher, searchFile } from "../search/matcher.js";
import type { CompiledMatcher, OutputPlan, SearchPlan } from "../search/types.js";
import { planRg } from "../../ripgrep/src/plan.js";

const required = ["--color", "never", "--no-ignore", "--hidden", "--text"];
const workloads = [
  ["-c", "-F", "--glob", "*.tsx", "--glob", "!node_modules/**", "--", "export", "."],
  ["-c", "-i", "--glob", "*.js", "--", "workUnitAsyncStorage|createServer", "."],
  ["-c", "-F", "--glob", "*.js", "--", "search_lane_absent_729f3d", "."],
  ["-c", "-F", "--glob", "*.js", "--", "require", "."],
  ["-l", "-F", "--glob", "*.js", "--", "workUnitAsyncStorage", "."],
];

for (const argv of workloads) {
  test(`admits frozen workload ${argv.at(-2)}`, () => {
    const result = planRg(required.concat(argv));
    expect(result.kind).toBe("supported");
    if (result.kind === "fallback") throw new Error(result.reason);
    expect(result.plan.tool).toBe("rg");
    expect(result.plan.operands).toEqual(["."]);
    expect(result.plan.output.kind).toBe(argv[0] === "-l" ? "files-with-matches" : "count");
    expect(result.plan.walk.hidden).toBe(true);
  });
}

test("option clusters consume attached values and later output switches win", () => {
  const result = planRg(required.concat(["-lcnNiFHeone", "-e", "two", "--", "."]));
  expect(result.kind).toBe("supported");
  if (result.kind === "fallback") throw new Error(result.reason);
  expect(result.plan.matcher).toEqual({
    kind: "literal",
    patterns: ["one", "two"],
    ignoreCase: true,
  });
  expect(result.plan.output).toEqual({ kind: "count", zeroCounts: false, withFilename: true });
});

test("unproved patterns and unsupported options fall back without mutating argv or env", () => {
  const env = Object.freeze({ RIPGREP_CONFIG_PATH: "", LANG: "C" });
  for (const tail of [["a.*", "."], ["-u", "hit", "."], ["hit", "-"], ["hit"]]) {
    const argv = Object.freeze(required.concat(tail));
    expect(planRg(argv, env, { stdoutIsTTY: false }).kind).toBe("fallback");
    expect(argv).toEqual(required.concat(tail));
    expect(env).toEqual({ RIPGREP_CONFIG_PATH: "", LANG: "C" });
  }
});

function supported(argv: readonly string[]): SearchPlan {
  const result = planRg(required.concat(argv), {}, { stdoutIsTTY: false });
  if (result.kind === "fallback") throw new Error(result.reason);
  return result.plan;
}

test("successful admission leaves frozen argv and environment unchanged", () => {
  const argv = Object.freeze(required.concat(["-Fic", "-eone", "-etwo", "."]));
  const env = Object.freeze({ RIPGREP_CONFIG_PATH: "", LC_ALL: "unqualified" });
  const before = JSON.stringify({ argv, env });
  expect(planRg(argv, env).kind).toBe("supported");
  expect(JSON.stringify({ argv, env })).toBe(before);
});

test("last output and line-number switches win, including inside clusters", () => {
  expect(supported(["-cl", "hit", "."]).output).toEqual({ kind: "files-with-matches" });
  expect(supported(["-lc", "hit", "."]).output).toEqual({
    kind: "count",
    withFilename: true,
    zeroCounts: false,
  });
  expect(supported(["-nN", "hit", "."]).output).toEqual({
    kind: "lines",
    withFilename: true,
    lineNumbers: false,
  });
  expect(supported(["-Nn", "hit", "."]).output).toEqual({
    kind: "lines",
    withFilename: true,
    lineNumbers: true,
  });
});

test("explicit patterns make every positional argument an operand", () => {
  const plan = supported(["first", "-e", "one|two", "-e", "three", "second"]);
  expect(plan.operands).toEqual(["first", "second"]);
  expect(plan.matcher).toEqual({ kind: "regex", source: "one|two|three", ignoreCase: false });
  expect(supported(["-F", "--", "-literal", "."]).matcher).toEqual({
    kind: "literal",
    patterns: ["-literal"],
    ignoreCase: false,
  });
  expect(supported(["-e", "--", "."]).matcher).toEqual({
    kind: "regex",
    source: "--",
    ignoreCase: false,
  });
});

test("glob translation keeps basenames separate from rooted paths", () => {
  const walk = supported(["-g*.js", "--glob=/sub/*.js", "-g!node_modules/**", "hit", "."]).walk;
  expect(walk.include).toEqual([
    { kind: "basename", glob: "*.js" },
    { kind: "path", glob: "sub/*.js" },
  ]);
  expect(walk.exclude).toEqual([{ kind: "path", glob: "node_modules/**" }]);
  expect(walk.excludeDirectories).toEqual([
    { kind: "path", glob: "node_modules/**" },
    { kind: "path", glob: "node_modules" },
  ]);
});

const alternativeOverflow = "**/".repeat(8) + "a.js";
const tokenOverflow = "**/".repeat(6) + "a".repeat(64) + ".js";
const walkBudgetCases: readonly [string, string, string][] = [
  ["positive alternatives", alternativeOverflow, alternativeOverflow],
  ["anchored alternatives", "/" + alternativeOverflow, alternativeOverflow],
  ["negative alternatives", "!" + alternativeOverflow, alternativeOverflow],
  ["expanded tokens", tokenOverflow, tokenOverflow],
];

for (const [label, source, glob] of walkBudgetCases) {
  test(`canonical S1 ${label} rejection falls back before host selection`, async () => {
    const service = new FilesystemService(new MemoryBackend());
    const pair = createFilesystemConnection();
    service.connect(pair.server);
    const client = new FilesystemClient(pair.client);
    const pattern = { kind: "path", glob } satisfies WalkPlan["include"][number];
    const negative = source.startsWith("!");
    const walk: WalkPlan = {
      include: negative ? [] : [pattern],
      exclude: negative ? [pattern] : [],
      excludeDirectories: negative ? [pattern] : [],
      hidden: true,
      maxDepth: null,
    };
    try {
      const root: number = await client.asyncCall("preopen", ["/"]);
      const failure = await client
        .asyncCall("walkOpen", [root, walk])
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ errno: 28 });
      expect(planRg(required.concat(["-l", "-g", source, "hit", "."]))).toEqual({
        kind: "fallback",
        reason: "walk glob admission failed: glob alternatives exceed bound",
      });
      expect(service.resources().walks).toBe(0);
      expect(service.resources().walkGrants).toBe(0);
    } finally {
      client.dispose();
      service.dispose();
    }
  });
}

test("strict option, environment, glob and matcher boundaries fall back", () => {
  const cases = [
    ["--json", "hit", "."],
    ["-ciZ", "hit", "."],
    ["--config=x", "hit", "."],
    ["--color=always", "hit", "."],
    ["--glob"],
    ["-g"],
    ["-e"],
    ["--color"],
    ["-c=1", "hit", "."],
    ["--hidden=yes", "hit", "."],
    ["-F", "", "."],
    ["-e", "", "."],
    ["-e", "a|", "-e", "b", "."],
    ["-e", "a.*", "-e", "b", "."],
    ["-F", "a\nb", "."],
    ["é", "."],
    ["-F", "x".repeat(4097), "."],
    ["hit", "file"],
    ["hit", ""],
    ["--", "hit", "-"],
    ["--", "hit"],
    ["-g!a.js", "-g*.js", "hit", "."],
    ["-g[ab].js", "hit", "."],
    ["-g?.js", "hit", "."],
    ["-g#*.js", "hit", "."],
    ["-g*.js ", "hit", "."],
    ["-g{a,b}.js", "hit", "."],
    ["-gfoo/", "hit", "."],
    ["-gfoo**bar", "hit", "."],
    ["-g../*.js", "hit", "."],
    ["-g./*.js", "hit", "."],
    ["-g\\*.js", "hit", "."],
    ["-g*.js", "-H", "hit", "sub"],
    ["-g*.js", "hit", ".", "sub"],
  ];
  for (const argv of cases)
    expect(planRg(required.concat(argv), {}, { stdoutIsTTY: false }).kind, argv.join(" ")).toBe(
      "fallback",
    );
  for (const flag of ["--no-ignore", "--hidden", "--text"])
    expect(planRg(required.filter((value) => value !== flag).concat(["-c", "hit", "."])).kind).toBe(
      "fallback",
    );
  expect(planRg(required.concat(["hit", "."]), { RIPGREP_CONFIG_PATH: "/config" }).kind).toBe(
    "fallback",
  );
  expect(planRg(required.concat(["hit", "."]), { RIPGREP_CONFIG_PATH: " " }).kind).toBe("fallback");
  expect(
    planRg(["--no-ignore", "--hidden", "-acF", "hit", "."], {}, { stdoutIsTTY: false }).kind,
  ).toBe("supported");
  expect(
    planRg(required.concat(["-c"], Array.from({ length: 65 }, () => ["-e", "a"]).flat(), ["."]))
      .kind,
  ).toBe("fallback");
  expect(
    planRg(
      required.concat(
        Array.from({ length: 129 }, () => "-g*.js"),
        ["-c", "hit", "."],
      ),
    ).kind,
  ).toBe("fallback");
});

test("explicit filenames and file-list avoid automatic filename ambiguity", () => {
  expect(supported(["-Hc", "hit", "file"]).output).toEqual({
    kind: "count",
    withFilename: true,
    zeroCounts: false,
  });
  expect(supported(["-l", "hit", "file"]).output).toEqual({ kind: "files-with-matches" });
  expect(supported(["hit", "first", "second"]).operands).toEqual(["first", "second"]);
});

test("line output requires explicit non-terminal stdout, while count and list are terminal independent", () => {
  const argv = required.concat(["hit", "."]);
  expect(planRg(argv).kind).toBe("fallback");
  expect(planRg(argv, {}, { stdoutIsTTY: true }).kind).toBe("fallback");
  expect(planRg(argv, {}, { stdoutIsTTY: false }).kind).toBe("supported");
  expect(planRg(required.concat(["-c", "hit", "."])).kind).toBe("supported");
  expect(planRg(required.concat(["-l", "hit", "."])).kind).toBe("supported");
  expect(
    planRg(["--no-ignore", "--hidden", "-a", "hit", "."], {}, { stdoutIsTTY: false }).kind,
  ).toBe("supported");
  expect(planRg(["--no-ignore", "--hidden", "-ac", "hit", "."]).kind).toBe("fallback");
});

const encoder = new TextEncoder();
const fixtureFiles = new Map<string, Uint8Array>([
  ["app/page.tsx", encoder.encode("export default\nexport require\n")],
  ["app/layout.tsx", encoder.encode("export layout\n")],
  ["a.js", encoder.encode("hit\r\nrequire require\nnone\nWORKunitAsyncStorage")],
  ["sub/a.js", encoder.encode("createServer\nhit\nſ K ı İ\n")],
  ["sub/plain.txt", encoder.encode("hit\n")],
  ["src/plain.txt", encoder.encode("hit\n")],
  ["thing.js/inner.txt", encoder.encode("hit\n")],
  [".hidden/hit.js", encoder.encode("hit\nrequire\n")],
  ["node_modules/a.js", encoder.encode("workUnitAsyncStorage\nrequire\n")],
  ["other/node_modules/b.js", encoder.encode("hit\ncreateServer\n")],
  ["sub/é.js", encoder.encode("hit\n")],
  ["a.txt", encoder.encode("hit\n--\n-literal\n")],
  ["binary.js", new Uint8Array([255, 104, 105, 116, 0, 10])],
  ["empty.js", new Uint8Array()],
]);

async function plannedOutput(client: FilesystemClient, root: number, plan: SearchPlan) {
  const admitted = compileMatcher(plan.matcher, "rg");
  if (admitted.kind === "fallback") throw new Error(admitted.reason);
  const initial: WalkCursor = await client.asyncCall("walkOpen", [root, plan.walk]);
  let cursor: WalkCursor | null = initial;
  const chunks: Uint8Array[] = [];
  let matched = 0;
  try {
    while (cursor) {
      const page = await readPage(client, cursor);
      const result = pageOutput(page, admitted.matcher, plan.output);
      matched += result.matched;
      chunks.push(result.stdout);
      cursor = page.next;
    }
  } finally {
    await client.asyncCall("walkClose", [initial]);
  }
  return { stdout: Buffer.concat(chunks), exitCode: matched ? 0 : 1 };
}

function pageOutput(page: WalkPage, matcher: CompiledMatcher, output: OutputPlan) {
  const chunks: Uint8Array[] = [];
  let matched = 0;
  for (const entry of page.entries) {
    if (entry.kind === "error") throw new Error(`walk errno ${entry.errno}`);
    const bytes = fixtureFiles.get(entry.path);
    if (!bytes) throw new Error(`unknown fixture ${entry.path}`);
    const result = searchFile(bytes, `./${entry.path}`, matcher, output);
    matched += result.matched;
    if (result.output) chunks.push(result.output);
  }
  return { stdout: Buffer.concat(chunks), matched };
}

async function readPage(client: FilesystemClient, cursor: WalkCursor): Promise<WalkPage> {
  const completion = client.submit(
    "walkPage",
    [cursor, { grant: false, maxEntries: 128 }],
    undefined,
    65536,
  );
  try {
    return await completion.value();
  } finally {
    completion.release();
  }
}

function canonical(bytes: Uint8Array): string {
  const rows = Buffer.from(bytes)
    .toString("latin1")
    .split("\n")
    .map((row) => Buffer.from(row, "latin1").toString("hex"));
  if (rows.at(-1) === "") rows.pop();
  rows.sort();
  return rows.join("0a");
}

async function compareNative(
  client: FilesystemClient,
  root: number,
  directory: string,
  argv: string[],
) {
  const plan = supported(argv);
  const actual = await plannedOutput(client, root, plan);
  const expected = Bun.spawnSync(["rg"].concat(required, argv), {
    cwd: directory,
    env: { RIPGREP_CONFIG_PATH: "" },
  });
  expect(expected.stderr.length, argv.join(" ")).toBe(0);
  expect(canonical(actual.stdout), argv.join(" ")).toBe(canonical(expected.stdout));
  expect(actual.exitCode, argv.join(" ")).toBe(expected.exitCode);
}

test.skipIf(Bun.which("rg") === null)(
  "admitted argv matches native rg through the canonical S1 walk and S3 matcher",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "waffle-rg-plan-"));
    const service = new FilesystemService(new MemoryBackend());
    const pair = createFilesystemConnection();
    service.connect(pair.server);
    const client = new FilesystemClient(pair.client);
    try {
      for (const [path, bytes] of fixtureFiles) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), bytes);
        await client.asyncCall("mkdirp", ["/" + dirname(path)]);
        await client.asyncCall("writeFile", ["/" + path], bytes);
      }
      const root: number = await client.asyncCall("preopen", ["/"]);
      const globCases = [
        "*",
        "*.*",
        "**",
        "**/*",
        "**/**",
        "*/a.js",
        "**/a.js",
        "sub/**",
        "/sub/**",
        "sub/**/a.js",
        "**/".repeat(7) + "a.js",
        "!*.js",
        "!sub",
        "!**/a.js",
      ].map((glob) => ["-g", glob, "hit", "."]);
      const cases = workloads.concat(globCases, [
        ["-n", "hit", "."],
        ["-Nn", "hit", "."],
        ["-nN", "hit", "."],
        ["-cl", "hit", "."],
        ["-lc", "hit", "."],
        ["-aHicF", "HIT", "."],
        ["-F", "--", "-literal", "."],
        ["-e", "--", "."],
        ["-e", "hit", "-ecreateServer", "."],
        ["-Fi", "-ek", "-es", "."],
        ["-g*.js", "-g!a.js", "hit", "."],
        ["-g!sub", "hit", "."],
        ["-gsub/*.js", "hit", "."],
        ["--glob=/a.js", "hit", "."],
        ["-g**/*.js", "-g!node_modules/**", "hit", "."],
        ["-gsrc", "hit", "."],
        ["-g*.js", "-g!**/node_modules/**", "hit", "."],
        ["-g*.js", "-g*.tsx", "-l", "require", "."],
      ]);
      for (const argv of cases) await compareNative(client, root, directory, argv);
      expect(service.resources().walks).toBe(0);
      expect(service.resources().walkGrants).toBe(0);
    } finally {
      client.dispose();
      service.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10000,
);
