import { expect, test } from "bun:test";
import { compileMatcher, searchFile } from "../search/matcher.js";
import { SEARCH_LIMITS, type MatcherPlan, type OutputPlan } from "../search/types.js";

const encoder = new TextEncoder();
const lines: OutputPlan = { kind: "lines", withFilename: true, lineNumbers: true };

function matcher(plan: MatcherPlan, tool: "rg" | "grep" = "rg", locale?: string) {
  const result = compileMatcher(plan, tool, locale);
  if (result.kind === "fallback") throw new Error(result.reason);
  return result.matcher;
}

function literal(pattern: string, ignoreCase = false): MatcherPlan {
  return { kind: "literal", patterns: [pattern], ignoreCase };
}

for (const source of [
  "export",
  "workUnitAsyncStorage|createServer",
  "a|b|c",
  " ",
  "a-b_09",
  "a/b:c",
]) {
  test(`admits proven regex ${JSON.stringify(source)}`, () => {
    expect(compileMatcher({ kind: "regex", source, ignoreCase: false }, "rg").kind).toBe(
      "supported",
    );
  });
}

for (const source of [
  "",
  "|a",
  "a|",
  "a||b",
  ".",
  "a*",
  "a+",
  "a?",
  "a{2}",
  "(ab)",
  "(?:ab)",
  "(?=a)",
  "(?<=a)",
  "(a+)+$",
  "[a-z]",
  "\\w",
  "\\d",
  "\\1",
  "^a",
  "a$",
  "a\nb",
  "a\rb",
  "é",
  "K",
  "a\0b",
  "a\tb",
]) {
  test(`rejects unproved regex ${JSON.stringify(source)}`, () => {
    expect(compileMatcher({ kind: "regex", source, ignoreCase: true }, "rg").kind).toBe("fallback");
  });
}

test("literal punctuation stays literal and pattern admission is bounded", () => {
  expect(compileMatcher(literal(".*+$^[]{}()|\\"), "rg").kind).toBe("supported");
  expect(compileMatcher(literal("a".repeat(SEARCH_LIMITS.patternBytes)), "rg").kind).toBe(
    "supported",
  );
  expect(compileMatcher(literal("a".repeat(SEARCH_LIMITS.patternBytes + 1)), "rg").kind).toBe(
    "fallback",
  );
  expect(compileMatcher({ kind: "literal", patterns: [], ignoreCase: false }, "rg").kind).toBe(
    "fallback",
  );
  expect(
    compileMatcher(
      { kind: "literal", patterns: Array.from({ length: 65 }, () => "a"), ignoreCase: false },
      "rg",
    ).kind,
  ).toBe("fallback");
});

test("line output preserves CR, invalid UTF-8 and the unterminated final record", () => {
  const bytes = new Uint8Array([104, 105, 116, 13, 10, 255, 104, 105, 116, 10, 10, 104, 105, 116]);
  const result = searchFile(bytes, "./file", matcher(literal("hit")), lines);
  expect(result.matched).toBe(3);
  expect(result.output).toEqual(
    new Uint8Array([
      46, 47, 102, 105, 108, 101, 58, 49, 58, 104, 105, 116, 13, 10, 46, 47, 102, 105, 108, 101, 58,
      50, 58, 255, 104, 105, 116, 10, 46, 47, 102, 105, 108, 101, 58, 52, 58, 104, 105, 116, 10,
    ]),
  );
});

test("one record is counted once across overlapping matches and alternatives", () => {
  const compiled = matcher({ kind: "regex", source: "aba|ba|a", ignoreCase: false });
  const result = searchFile(encoder.encode("ababa\nmiss\na"), "file", compiled, {
    kind: "count",
    withFilename: true,
    zeroCounts: false,
  });
  expect(result).toEqual({ matched: 2, output: encoder.encode("file:2\n") });
});

test("empty files, terminal LF and zero counts follow frontend policy", () => {
  const compiled = matcher(literal("hit"));
  for (const text of ["", "\n", "miss\n"]) {
    const bytes = encoder.encode(text);
    expect(
      searchFile(bytes, "f", compiled, { kind: "count", withFilename: true, zeroCounts: false }),
    ).toEqual({ matched: 0, output: null });
    expect(
      searchFile(bytes, "f", compiled, { kind: "count", withFilename: true, zeroCounts: true }),
    ).toEqual({ matched: 0, output: encoder.encode("f:0\n") });
  }
  expect(
    searchFile(encoder.encode("hit\n"), "f", compiled, { kind: "files-with-matches" }),
  ).toEqual({ matched: 1, output: encoder.encode("f\n") });
});

test("qualified ignore case differs between rg and grep locales", () => {
  const text = encoder.encode("K\nſ\nı\nİ\nk\ns\ni\n");
  const plan = { kind: "regex", source: "k|s|i", ignoreCase: true } satisfies MatcherPlan;
  expect(searchFile(text, "f", matcher(plan), lines).matched).toBe(5);
  expect(searchFile(text, "f", matcher(plan, "grep"), lines).matched).toBe(5);
  expect(searchFile(text, "f", matcher(plan, "grep", "C"), lines).matched).toBe(3);
  expect(compileMatcher(plan, "grep", "tr_TR.UTF-8").kind).toBe("fallback");
});

test("input, path and output allocations have hard bounds", () => {
  const compiled = matcher(literal("a"));
  expect(() =>
    searchFile(new Uint8Array(SEARCH_LIMITS.fileBytes + 1), "f", compiled, lines),
  ).toThrow("input limit");
  expect(() =>
    searchFile(new Uint8Array(), "é".repeat(SEARCH_LIMITS.pathBytes), compiled, lines),
  ).toThrow("path exceeds");
  const text = encoder.encode("a\n".repeat(9000));
  expect(() => searchFile(text, "x".repeat(4096), compiled, lines)).toThrow("output exceeds");
});

test("bounded alternation admits the limit and rejects excess before compilation", () => {
  const source = Array.from({ length: SEARCH_LIMITS.patterns }, () => "a").join("|");
  expect(compileMatcher({ kind: "regex", source, ignoreCase: false }, "rg").kind).toBe("supported");
  expect(
    compileMatcher({ kind: "regex", source: source + "|a", ignoreCase: false }, "rg").kind,
  ).toBe("fallback");
  expect(
    compileMatcher(
      {
        kind: "regex",
        source: "a".repeat(SEARCH_LIMITS.patternBytes + SEARCH_LIMITS.patterns),
        ignoreCase: false,
      },
      "rg",
    ).kind,
  ).toBe("fallback");
});

test("repeated prefixes and near misses do not lose later literal matches", () => {
  const text = encoder.encode("ababababacab\nababababaca\nababababacab");
  const result = searchFile(text, "f", matcher(literal("ababacab")), {
    kind: "lines",
    lineNumbers: true,
    withFilename: false,
  });
  expect(result).toEqual({
    matched: 2,
    output: encoder.encode("1:ababababacab\n3:ababababacab\n"),
  });
});
