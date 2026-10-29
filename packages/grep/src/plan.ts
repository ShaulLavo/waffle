import { compileGlob } from "../../waffle/fs/glob.js";
import { compileMatcher } from "../../waffle/search/matcher.js";
import type { MatcherPlan, OutputPlan, SearchPlan } from "../../waffle/search/types.js";

type Fallback = { readonly kind: "fallback"; readonly reason: string };
type OptionResult = { readonly kind: "parsed"; readonly consumeNext: boolean } | Fallback;
type ParseResult = { readonly kind: "parsed"; readonly invocation: Invocation } | Fallback;
type WalkResult = { readonly kind: "walk"; readonly plan: SearchPlan["walk"] } | Fallback;
type Glob = SearchPlan["walk"]["include"][number];
type FilenameMode = "automatic" | "always" | "never";
type FileFilterKind = "include" | "exclude";

interface ParserState {
  readonly patterns: string[];
  readonly positionals: string[];
  readonly include: Glob[];
  readonly exclude: Glob[];
  readonly excludeDirectories: Glob[];
  readonly fileFilterOrder: FileFilterKind[];
  recursive: boolean;
  text: boolean;
  count: boolean;
  filesWithMatches: boolean;
  lineNumbers: boolean;
  filenameMode: FilenameMode;
  ignoreCase: boolean;
  fixed: boolean;
  extended: boolean;
}

interface Invocation extends ParserState {
  readonly operands: readonly string[];
}

const BRE_METACHARACTERS = new Set(["\\", ".", "[", "*", "^", "$"]);
const UNSUPPORTED_GLOB_CHARACTERS = new Set(["?", "[", "]", "{", "}", "\\", "/"]);
const MAX_WALK_FILTERS = 128;

function fallback(reason: string): Fallback {
  return { kind: "fallback", reason };
}

function basename(glob: string): Glob {
  return { kind: "basename", glob };
}

function initialState(): ParserState {
  return {
    patterns: [],
    positionals: [],
    include: [],
    exclude: [],
    excludeDirectories: [],
    fileFilterOrder: [],
    recursive: false,
    text: false,
    count: false,
    filesWithMatches: false,
    lineNumbers: false,
    filenameMode: "automatic",
    ignoreCase: false,
    fixed: false,
    extended: false,
  };
}

function parseLongOption(argument: string, state: ParserState): OptionResult {
  if (argument.startsWith("--include=")) {
    state.include.push(basename(argument.slice("--include=".length)));
    state.fileFilterOrder.push("include");
    return { kind: "parsed", consumeNext: false };
  }
  if (argument.startsWith("--exclude=")) {
    state.exclude.push(basename(argument.slice("--exclude=".length)));
    state.fileFilterOrder.push("exclude");
    return { kind: "parsed", consumeNext: false };
  }
  if (argument.startsWith("--exclude-dir=")) {
    state.excludeDirectories.push(basename(argument.slice("--exclude-dir=".length)));
    return { kind: "parsed", consumeNext: false };
  }
  return fallback(`unsupported long option ${argument}`);
}

function parsePatternOption(
  argument: string,
  offset: number,
  next: string | undefined,
  state: ParserState,
): OptionResult {
  const attached = argument.slice(offset + 1);
  if (attached.length > 0) {
    state.patterns.push(attached);
    return { kind: "parsed", consumeNext: false };
  }
  if (next === undefined) return fallback("-e requires a pattern");
  state.patterns.push(next);
  return { kind: "parsed", consumeNext: true };
}

function parseShortOptions(
  argument: string,
  next: string | undefined,
  state: ParserState,
): OptionResult {
  for (let offset = 1; offset < argument.length; offset++) {
    const option = argument[offset];
    switch (option) {
      case "r":
        state.recursive = true;
        break;
      case "a":
        state.text = true;
        break;
      case "c":
        state.count = true;
        break;
      case "l":
        state.filesWithMatches = true;
        break;
      case "n":
        state.lineNumbers = true;
        break;
      case "H":
        state.filenameMode = "always";
        break;
      case "h":
        state.filenameMode = "never";
        break;
      case "i":
        state.ignoreCase = true;
        break;
      case "F":
        state.fixed = true;
        break;
      case "E":
        state.extended = true;
        break;
      case "e":
        return parsePatternOption(argument, offset, next, state);
      default:
        return fallback(`unsupported short option -${option ?? ""}`);
    }
  }
  return { kind: "parsed", consumeNext: false };
}

function completeInvocation(
  state: ParserState,
  patterns: readonly string[],
  positionals: readonly string[],
): ParseResult {
  const operands = positionals.length > 0 ? positionals : ["."];
  if (operands.includes("-")) return fallback("standard input operands stay on the real program");
  return {
    kind: "parsed",
    invocation: { ...state, patterns: patterns.slice(), operands },
  };
}

function finishParsing(state: ParserState): ParseResult {
  if (state.patterns.length > 0) {
    return completeInvocation(state, state.patterns, state.positionals);
  }
  const pattern = state.positionals[0];
  if (pattern === undefined) return fallback("missing pattern");
  return completeInvocation(state, [pattern], state.positionals.slice(1));
}

function parseArgv(argv: readonly string[]): ParseResult {
  const state = initialState();
  let endOptions = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (endOptions || argument === "-" || !argument.startsWith("-")) {
      state.positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      endOptions = true;
      continue;
    }
    const result = argument.startsWith("--")
      ? parseLongOption(argument, state)
      : parseShortOptions(argument, argv[index + 1], state);
    if (result.kind === "fallback") return result;
    if (result.consumeNext) index++;
  }
  return finishParsing(state);
}

function selectedLocale(env: Readonly<Record<string, string>>): string {
  return env.LC_ALL || env.LC_CTYPE || env.LANG || "C";
}

function qualifiedLocale(locale: string): boolean {
  return locale === "C" || locale === "POSIX" || locale === "C.UTF-8" || locale === "C.utf8";
}

function isLiteralBre(pattern: string): boolean {
  for (const character of pattern) {
    if (BRE_METACHARACTERS.has(character)) return false;
  }
  return true;
}

function matcherPlan(invocation: Invocation): MatcherPlan {
  if (invocation.extended) {
    return {
      kind: "regex",
      source: invocation.patterns.join("|"),
      ignoreCase: invocation.ignoreCase,
    };
  }
  return { kind: "literal", patterns: invocation.patterns, ignoreCase: invocation.ignoreCase };
}

function hasCanonicalFileFilterOrder(order: readonly FileFilterKind[]): boolean {
  const firstExclude = order.indexOf("exclude");
  const lastInclude = order.lastIndexOf("include");
  return firstExclude === -1 || lastInclude === -1 || lastInclude < firstExclude;
}

function isProvenGlob(pattern: Glob): boolean {
  for (const character of pattern.glob) {
    const value = character.charCodeAt(0);
    if (value < 32 || value > 126 || UNSUPPORTED_GLOB_CHARACTERS.has(character)) return false;
  }
  return true;
}

function walkPlan(invocation: Invocation): WalkResult {
  if (!hasCanonicalFileFilterOrder(invocation.fileFilterOrder)) {
    return fallback("include/exclude ordering exceeds the canonical walk semantics");
  }
  const lists = [invocation.include, invocation.exclude, invocation.excludeDirectories];
  if (lists.some((patterns) => patterns.length > MAX_WALK_FILTERS)) {
    return fallback("walk filter count exceeds the canonical limit");
  }
  const filters = invocation.include.concat(invocation.exclude, invocation.excludeDirectories);
  if (!filters.every(isProvenGlob)) return fallback("glob syntax exceeds the proven GNU/S1 subset");
  try {
    for (const filter of filters) compileGlob(filter);
  } catch {
    return fallback("canonical walk compiler rejected a filter");
  }
  return {
    kind: "walk",
    plan: {
      include: invocation.include,
      exclude: invocation.exclude,
      excludeDirectories: invocation.excludeDirectories,
      hidden: true,
      maxDepth: null,
    },
  };
}

function outputPlan(invocation: Invocation): OutputPlan | Fallback {
  if (invocation.filesWithMatches) return { kind: "files-with-matches" };
  if (
    invocation.filenameMode === "automatic" &&
    invocation.operands.length === 1 &&
    invocation.operands[0] !== "."
  ) {
    return fallback("one ambiguous operand requires explicit -H or -h");
  }
  const withFilename = invocation.filenameMode !== "never";
  if (invocation.count) return { kind: "count", withFilename, zeroCounts: true };
  return { kind: "lines", lineNumbers: invocation.lineNumbers, withFilename };
}

export function planGrep(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): { kind: "fast"; plan: SearchPlan } | Fallback {
  if (env.POSIXLY_CORRECT !== undefined)
    return fallback("POSIX option parsing stays on the real program");
  if (env.GREP_OPTIONS !== undefined) return fallback("GREP_OPTIONS stays on the real program");
  const locale = selectedLocale(env);
  if (!qualifiedLocale(locale)) return fallback(`unqualified grep locale ${locale}`);
  const parsed = parseArgv(argv);
  if (parsed.kind === "fallback") return parsed;
  const invocation = parsed.invocation;
  if (!invocation.recursive) return fallback("non-recursive grep stays on the real program");
  if (!invocation.text) return fallback("binary matching requires the real program without -a");
  if (invocation.fixed && invocation.extended)
    return fallback("combined -E and -F stays on the real program");
  if (!invocation.fixed && !invocation.extended && !invocation.patterns.every(isLiteralBre)) {
    return fallback("BRE metacharacters stay on the real program");
  }
  const matcher = matcherPlan(invocation);
  const admission = compileMatcher(matcher, "grep", locale);
  if (admission.kind === "fallback") return admission;
  const walk = walkPlan(invocation);
  if (walk.kind === "fallback") return walk;
  const output = outputPlan(invocation);
  if (output.kind === "fallback") return output;
  return {
    kind: "fast",
    plan: {
      tool: "grep",
      operands: invocation.operands,
      walk: walk.plan,
      matcher,
      output,
    },
  };
}
