import { expect, test } from "bun:test";
import { planGrep } from "../../grep/src/plan.js";
import type { SearchPlan } from "../search/types.js";

const utf8 = { LC_ALL: "C.UTF-8" };

function fast(argv: readonly string[], env: Readonly<Record<string, string>> = utf8): SearchPlan {
  const result = planGrep(argv, env);
  if (result.kind === "fallback") throw new Error(result.reason);
  return result.plan;
}

function fallback(argv: readonly string[], env: Readonly<Record<string, string>> = utf8): string {
  const result = planGrep(argv, env);
  if (result.kind === "fast") throw new Error(`unexpected fast plan for ${JSON.stringify(argv)}`);
  expect(result.reason.length).toBeGreaterThan(0);
  return result.reason;
}

function walk(include: string[] = [], exclude: string[] = [], excludeDirectories: string[] = []) {
  return {
    include: include.map((glob) => ({ kind: "basename", glob }) as const),
    exclude: exclude.map((glob) => ({ kind: "basename", glob }) as const),
    excludeDirectories: excludeDirectories.map((glob) => ({ kind: "basename", glob }) as const),
    hidden: true,
    maxDepth: null,
  } satisfies SearchPlan["walk"];
}

const frozenWorkloads = [
  {
    name: "source-literal",
    argv: [
      "-r",
      "-a",
      "-c",
      "-F",
      "--include=*.tsx",
      "--exclude-dir=node_modules",
      "--",
      "export",
      ".",
    ],
    plan: {
      tool: "grep",
      operands: ["."],
      walk: walk(["*.tsx"], [], ["node_modules"]),
      matcher: { kind: "literal", patterns: ["export"], ignoreCase: false },
      output: { kind: "count", withFilename: true, zeroCounts: true },
    },
  },
  {
    name: "deps-regex",
    argv: [
      "-r",
      "-a",
      "-c",
      "-i",
      "-E",
      "--include=*.js",
      "--",
      "workUnitAsyncStorage|createServer",
      ".",
    ],
    plan: {
      tool: "grep",
      operands: ["."],
      walk: walk(["*.js"]),
      matcher: { kind: "regex", source: "workUnitAsyncStorage|createServer", ignoreCase: true },
      output: { kind: "count", withFilename: true, zeroCounts: true },
    },
  },
  {
    name: "deps-negative",
    argv: ["-r", "-a", "-c", "-F", "--include=*.js", "--", "search_lane_absent_729f3d", "."],
    plan: {
      tool: "grep",
      operands: ["."],
      walk: walk(["*.js"]),
      matcher: { kind: "literal", patterns: ["search_lane_absent_729f3d"], ignoreCase: false },
      output: { kind: "count", withFilename: true, zeroCounts: true },
    },
  },
  {
    name: "deps-common",
    argv: ["-r", "-a", "-c", "-F", "--include=*.js", "--", "require", "."],
    plan: {
      tool: "grep",
      operands: ["."],
      walk: walk(["*.js"]),
      matcher: { kind: "literal", patterns: ["require"], ignoreCase: false },
      output: { kind: "count", withFilename: true, zeroCounts: true },
    },
  },
  {
    name: "deps-file-list",
    argv: ["-r", "-a", "-l", "-F", "--include=*.js", "--", "workUnitAsyncStorage", "."],
    plan: {
      tool: "grep",
      operands: ["."],
      walk: walk(["*.js"]),
      matcher: { kind: "literal", patterns: ["workUnitAsyncStorage"], ignoreCase: false },
      output: { kind: "files-with-matches" },
    },
  },
] satisfies readonly { name: string; argv: readonly string[]; plan: SearchPlan }[];

for (const workload of frozenWorkloads) {
  test(`frozen ${workload.name} argv produces its exact grep plan`, () => {
    expect(fast(workload.argv)).toEqual(workload.plan);
  });
}

test("recursive grep defaults its operand to dot with and without -e", () => {
  expect(fast(["-raF", "needle"]).operands).toEqual(["."]);
  expect(fast(["-raF", "-e", "needle"]).operands).toEqual(["."]);
});

test("separate, attached and repeated -e patterns retain their order", () => {
  const plan = fast(["-raF", "-efirst", "-e", "second", "src", "docs"]);
  expect(plan.matcher).toEqual({
    kind: "literal",
    patterns: ["first", "second"],
    ignoreCase: false,
  });
  expect(plan.operands).toEqual(["src", "docs"]);
});

test("options after operands and -- follow GNU argv boundaries", () => {
  expect(fast(["-ra", "needle", "src", "-n"]).output).toEqual({
    kind: "lines",
    lineNumbers: true,
    withFilename: true,
  });
  const plan = fast(["-raF", "--", "-needle", "-path"]);
  expect(plan.matcher).toEqual({ kind: "literal", patterns: ["-needle"], ignoreCase: false });
  expect(plan.operands).toEqual(["-path"]);
});

test("all include and exclude filters are basename globs and hidden files stay included", () => {
  const plan = fast([
    "-raF",
    "--include=*.js",
    "--include=*.mjs",
    "--exclude=*.min.js",
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "needle",
    ".",
  ]);
  expect(plan.walk).toEqual(walk(["*.js", "*.mjs"], ["*.min.js"], ["node_modules", ".git"]));
});

test("line, count and file-list output preserve grep precedence", () => {
  expect(fast(["-ran", "needle", "."]).output).toEqual({
    kind: "lines",
    lineNumbers: true,
    withFilename: true,
  });
  expect(fast(["-rach", "needle", "."]).output).toEqual({
    kind: "count",
    withFilename: false,
    zeroCounts: true,
  });
  for (const flags of ["-racl", "-ralc"]) {
    expect(fast([flags, "needle", "."]).output).toEqual({ kind: "files-with-matches" });
  }
});

test("-H wins over -h in either order and recursive output names files by default", () => {
  for (const flags of ["-rahH", "-raHh"]) {
    expect(fast([flags, "needle", "."]).output).toEqual({
      kind: "lines",
      lineNumbers: false,
      withFilename: true,
    });
  }
  expect(fast(["-rah", "needle", "."]).output).toEqual({
    kind: "lines",
    lineNumbers: false,
    withFilename: false,
  });
});

test("plain BRE punctuation is literal and BRE operators fall back", () => {
  expect(fast(["-ra", "a|b+(c){2}", "."]).matcher).toEqual({
    kind: "literal",
    patterns: ["a|b+(c){2}"],
    ignoreCase: false,
  });
  for (const pattern of ["a.b", "[ab]", "a*", "^a", "a$", "a\\|b"]) {
    fallback(["-ra", pattern, "."]);
  }
});

test("ERE accepts only S3-approved plain alternation", () => {
  expect(fast(["-raE", "first|second|third", "."]).matcher).toEqual({
    kind: "regex",
    source: "first|second|third",
    ignoreCase: false,
  });
  for (const pattern of ["", "|a", "a|", "a||b", "a.b", "a*", "(a)", "[a-z]", "a\\|b"]) {
    fallback(["-raE", pattern, "."]);
  }
});

test("fixed-string punctuation stays literal while empty and non-ASCII patterns fall back", () => {
  expect(fast(["-raF", ".*+$^[]{}()|\\", "."]).matcher).toEqual({
    kind: "literal",
    patterns: [".*+$^[]{}()|\\"],
    ignoreCase: false,
  });
  fallback(["-raF", "", "."]);
  fallback(["-raF", "é", "."]);
  fallback(["-raE", "é|e", "."]);
});

test("matcher size admission is delegated to S3", () => {
  fallback(["-raF", "a".repeat(4097), "."]);
  const patterns = Array.from({ length: 65 }, () => ["-e", "x"]).flat();
  fallback(["-raF"].concat(patterns, ["."]));
});

test("only qualified grep locales enter the fast path", () => {
  for (const locale of ["C", "POSIX", "C.UTF-8", "C.utf8"]) {
    expect(fast(["-raiF", "needle", "."], { LC_ALL: locale }).matcher).toEqual({
      kind: "literal",
      patterns: ["needle"],
      ignoreCase: true,
    });
  }
  for (const locale of ["en_US.UTF-8", "tr_TR.UTF-8", "C.UTF8"]) {
    fallback(["-raF", "needle", "."], { LC_ALL: locale });
  }
});

test("locale precedence uses LC_ALL, LC_CTYPE then LANG", () => {
  fallback(["-raF", "needle", "."], { LC_ALL: "en_US.UTF-8", LC_CTYPE: "C", LANG: "C" });
  expect(
    fast(["-raF", "needle", "."], { LC_ALL: "", LC_CTYPE: "C", LANG: "en_US.UTF-8" }).tool,
  ).toBe("grep");
  expect(fast(["-raF", "needle", "."], { LANG: "C.UTF-8" }).tool).toBe("grep");
  expect(fast(["-raF", "needle", "."], {}).tool).toBe("grep");
});

test("stdin, non-recursive, binary and option-environment behavior falls back", () => {
  expect(fast(["-raF", "--", "-"]).operands).toEqual(["."]);
  fallback(["-raF", "needle", "-"]);
  fallback(["-aF", "needle", "."]);
  fallback(["-rF", "needle", "."]);
  fallback(["-raF", "needle", "."], { POSIXLY_CORRECT: "" });
  fallback(["-raF", "needle", "."], { GREP_OPTIONS: "" });
});

test("unsupported options and malformed invocations fall back before planning", () => {
  const cases = [
    ["-raR", "needle", "."],
    ["-raq", "needle", "."],
    ["-raZ", "needle", "."],
    ["-ra", "--recursive", "needle", "."],
    ["-ra", "--text", "needle", "."],
    ["-ra", "--include", "*.js", "needle", "."],
    ["-ra", "--color=never", "needle", "."],
    ["-ra"],
    ["-ra", "-e"],
    ["-raEF", "needle", "."],
    ["-raFE", "needle", "."],
  ];
  for (const argv of cases) fallback(argv);
});
