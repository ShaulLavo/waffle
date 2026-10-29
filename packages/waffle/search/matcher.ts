import { formatFile } from "./format.js";
import {
  SEARCH_LIMITS,
  type CompiledMatcher,
  type CompiledNeedle,
  type FileSearchResult,
  type MatcherAdmission,
  type MatcherPlan,
  type OutputPlan,
  type SearchPlan,
} from "./types.js";

function failureTable(bytes: Uint8Array): Uint16Array {
  const failure = new Uint16Array(bytes.length);
  let prefix = 0;
  for (let index = 1; index < bytes.length; index++) {
    while (prefix > 0 && bytes[index] !== bytes[prefix]) prefix = failure[prefix - 1]!;
    if (bytes[index] === bytes[prefix]) prefix++;
    failure[index] = prefix;
  }
  return failure;
}

function compileNeedle(pattern: string, ignoreCase: boolean): CompiledNeedle {
  const bytes = new TextEncoder().encode(ignoreCase ? pattern.toLowerCase() : pattern);
  return { bytes, failure: failureTable(bytes) };
}

function acceptedPattern(pattern: string, regex: boolean): boolean {
  if (!pattern.length) return false;
  for (const character of pattern) {
    const value = character.charCodeAt(0);
    if (value < 32 || value > 126) return false;
    if (regex && "\\.^$*+?()[]{}".includes(character)) return false;
  }
  return true;
}

export function compileMatcher(
  plan: MatcherPlan,
  tool: SearchPlan["tool"],
  locale = "C.UTF-8",
): MatcherAdmission {
  if (
    plan.kind === "regex" &&
    plan.source.length > SEARCH_LIMITS.patternBytes + SEARCH_LIMITS.patterns - 1
  )
    return { kind: "fallback", reason: "regex source exceeds the matcher limit" };
  const patterns = plan.kind === "literal" ? plan.patterns : plan.source.split("|");
  if (!patterns.length || patterns.length > SEARCH_LIMITS.patterns)
    return { kind: "fallback", reason: "pattern count exceeds the proven subset" };
  if (patterns.reduce((size, pattern) => size + pattern.length, 0) > SEARCH_LIMITS.patternBytes)
    return { kind: "fallback", reason: "pattern bytes exceed the matcher limit" };
  if (!patterns.every((pattern) => acceptedPattern(pattern, plan.kind === "regex")))
    return {
      kind: "fallback",
      reason: "only nonempty printable ASCII literals and alternation are proven",
    };
  const fold = selectFold(plan.ignoreCase, tool, locale);
  if (fold === null)
    return { kind: "fallback", reason: "grep ignore-case locale is not qualified" };
  return {
    kind: "supported",
    matcher: {
      tool,
      needles: patterns.map((pattern) => compileNeedle(pattern, plan.ignoreCase)),
      fold,
    },
  };
}

function selectFold(
  ignoreCase: boolean,
  tool: SearchPlan["tool"],
  locale: string,
): CompiledMatcher["fold"] | null {
  if (!ignoreCase) return "none";
  if (tool === "rg") return "rg-unicode";
  if (locale === "C" || locale === "POSIX") return "ascii";
  if (locale === "C.UTF-8" || locale === "C.utf8") return "grep-utf8";
  return null;
}

function unicodeFold(
  bytes: Uint8Array,
  offset: number,
  end: number,
  fold: CompiledMatcher["fold"],
): number {
  if (fold === "none" || fold === "ascii" || offset + 1 >= end) return 0;
  if (bytes[offset] === 0xc5 && bytes[offset + 1] === 0xbf) return 0x73;
  if (fold === "grep-utf8" && bytes[offset] === 0xc4 && bytes[offset + 1] === 0xb1) return 0x69;
  if (
    fold === "rg-unicode" &&
    offset + 2 < end &&
    bytes[offset] === 0xe2 &&
    bytes[offset + 1] === 0x84 &&
    bytes[offset + 2] === 0xaa
  )
    return 0x6b;
  return 0;
}

function needleMatches(
  bytes: Uint8Array,
  start: number,
  end: number,
  needle: CompiledNeedle,
  fold: CompiledMatcher["fold"],
): boolean {
  let prefix = 0;
  for (let offset = start; offset < end; offset++) {
    let value = bytes[offset]!;
    const special = unicodeFold(bytes, offset, end, fold);
    if (special) offset += value === 0xe2 ? 2 : 1;
    if (special) value = special;
    if (fold !== "none" && value >= 65 && value <= 90) value += 32;
    while (prefix > 0 && value !== needle.bytes[prefix]) prefix = needle.failure[prefix - 1]!;
    if (value === needle.bytes[prefix]) prefix++;
    if (prefix === needle.bytes.length) return true;
  }
  return false;
}

export function searchFile(
  bytes: Uint8Array,
  path: string,
  matcher: CompiledMatcher,
  output: OutputPlan,
): FileSearchResult {
  return formatFile(bytes, path, output, (start, end) =>
    matcher.needles.some((needle) => needleMatches(bytes, start, end, needle, matcher.fold)),
  );
}
