import { FilesystemError } from "waffle/core/filesystem";
import { compileGlob } from "waffle/search";
import type { GlobPattern, WalkPlan } from "waffle/search";
import { compileMatcher } from "waffle/search";
import type { MatcherPlan, OutputPlan, SearchPlan } from "waffle/search";

export type RgPlanAdmission =
  | { readonly kind: "supported"; readonly plan: SearchPlan }
  | { readonly kind: "fallback"; readonly reason: string };

type WalkAdmission =
  | { readonly kind: "supported"; readonly walk: WalkPlan }
  | { readonly kind: "fallback"; readonly reason: string };

class RgArguments {
  private index = 0;
  readonly patterns: string[] = [];
  operands: string[] = [];
  readonly globs: string[] = [];
  mode: OutputPlan["kind"] = "lines";
  lineNumbers = false;
  withFilename = false;
  ignoreCase = false;
  fixed = false;
  noIgnore = false;
  hidden = false;
  text = false;
  colorNever = false;

  constructor(private readonly argv: readonly string[]) {}

  parse(): string | null {
    while (this.index < this.argv.length) {
      const arg = this.argv[this.index++]!;
      if (arg === "--") {
        this.operands = this.operands.concat(this.argv.slice(this.index));
        return null;
      }
      const error = this.argument(arg);
      if (error) return error;
    }
    return null;
  }

  private argument(arg: string): string | null {
    if (!arg.startsWith("-") || arg === "-") {
      this.operands.push(arg);
      return null;
    }
    if (arg.startsWith("--")) return this.longOption(arg);
    for (let offset = 1; offset < arg.length; offset++) {
      const option = arg[offset]!;
      if (option === "e" || option === "g")
        return this.valueOption(option, this.value(arg.slice(offset + 1) || undefined));
      const error = this.flag(option);
      if (error) return error;
    }
    return null;
  }

  private longOption(arg: string): string | null {
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
    if (name === "color" || name === "glob")
      return this.valueOption(name, this.value(equals < 0 ? undefined : arg.slice(equals + 1)));
    if (equals >= 0) return `unsupported option ${arg}`;
    if (name === "no-ignore") this.noIgnore = true;
    else if (name === "hidden") this.hidden = true;
    else if (name === "text") this.text = true;
    else return `unsupported option ${arg}`;
    return null;
  }

  private value(attached: string | undefined): string | undefined {
    if (attached !== undefined) return attached;
    return this.argv[this.index++];
  }

  private valueOption(name: string, value: string | undefined): string | null {
    if (value === undefined) return `missing value for ${name}`;
    if (name === "e") this.patterns.push(value);
    else if (name === "g" || name === "glob") this.globs.push(value);
    else if (value === "never") this.colorNever = true;
    else return "only --color=never is supported";
    return null;
  }

  private flag(name: string): string | null {
    switch (name) {
      case "a":
        this.text = true;
        break;
      case "c":
        this.mode = "count";
        break;
      case "l":
        this.mode = "files-with-matches";
        break;
      case "n":
        this.lineNumbers = true;
        break;
      case "N":
        this.lineNumbers = false;
        break;
      case "H":
        this.withFilename = true;
        break;
      case "i":
        this.ignoreCase = true;
        break;
      case "F":
        this.fixed = true;
        break;
      default:
        return `unsupported option -${name}`;
    }
    return null;
  }
}

function globPattern(source: string): GlobPattern | null {
  if (
    !source ||
    source.length > 1024 ||
    source.startsWith("#") ||
    source.endsWith(" ") ||
    source.endsWith("/")
  )
    return null;
  for (const character of source) {
    const code = character.charCodeAt(0);
    if (code < 32 || code > 126 || "?[]{}\\".includes(character)) return null;
  }
  const anchored = source.startsWith("/");
  const glob = anchored ? source.slice(1) : source;
  for (const part of glob.split("/")) {
    if (!part || part === "." || part === "..") return null;
    if (part.includes("**") && part !== "**") return null;
  }
  return { kind: anchored || glob.includes("/") ? "path" : "basename", glob };
}

function walkPlan(globs: readonly string[]): WalkAdmission {
  const include: GlobPattern[] = [];
  const exclude: GlobPattern[] = [];
  const excludeDirectories: GlobPattern[] = [];
  for (const source of globs) {
    const negative = source.startsWith("!");
    const pattern = globPattern(negative ? source.slice(1) : source);
    if (!pattern) return { kind: "fallback", reason: "glob is outside the proven subset" };
    if (!negative && exclude.length)
      return { kind: "fallback", reason: "ordered glob re-inclusion requires rg" };
    if (!negative) include.push(pattern);
    else addExclusion(pattern, exclude, excludeDirectories);
  }
  if (include.length > 128 || exclude.length > 128 || excludeDirectories.length > 128)
    return { kind: "fallback", reason: "glob count exceeds the walk limit" };
  try {
    for (const pattern of include.concat(exclude, excludeDirectories)) compileGlob(pattern);
  } catch (error) {
    if (!(error instanceof FilesystemError)) throw error;
    return { kind: "fallback", reason: `walk glob admission failed: ${error.message}` };
  }
  return {
    kind: "supported",
    walk: { include, exclude, excludeDirectories, hidden: true, maxDepth: null },
  };
}

function addExclusion(
  pattern: GlobPattern,
  exclude: GlobPattern[],
  directories: GlobPattern[],
): void {
  exclude.push(pattern);
  directories.push(pattern);
  if (pattern.kind === "path" && pattern.glob.endsWith("/**"))
    directories.push({ kind: "path", glob: pattern.glob.slice(0, -3) });
}

function outputPlan(parsed: RgArguments): OutputPlan {
  if (parsed.mode === "files-with-matches") return { kind: "files-with-matches" };
  if (parsed.mode === "count") return { kind: "count", withFilename: true, zeroCounts: false };
  return { kind: "lines", lineNumbers: parsed.lineNumbers, withFilename: true };
}

export function planRg(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  options: { readonly stdoutIsTTY?: boolean } = {},
): RgPlanAdmission {
  if (env.RIPGREP_CONFIG_PATH)
    return { kind: "fallback", reason: "RIPGREP_CONFIG_PATH requires rg config parsing" };
  const parsed = new RgArguments(argv);
  const error = parsed.parse();
  if (error) return { kind: "fallback", reason: error };
  if (!parsed.noIgnore || !parsed.hidden || !parsed.text)
    return { kind: "fallback", reason: "--no-ignore, --hidden and --text are required" };
  if (!parsed.patterns.length) {
    const pattern = parsed.operands.shift();
    if (pattern === undefined) return { kind: "fallback", reason: "missing pattern" };
    parsed.patterns.push(pattern);
  }
  const operands = parsed.operands;
  if (!operands.length || operands.some((path) => !path || path === "-"))
    return { kind: "fallback", reason: "stdin or an implicit search root requires rg" };
  const rootIsCwd = operands.length === 1 && operands[0] === ".";
  if (parsed.globs.length && !rootIsCwd)
    return { kind: "fallback", reason: "glob roots other than explicit cwd require rg" };
  if (
    !rootIsCwd &&
    operands.length === 1 &&
    !parsed.withFilename &&
    parsed.mode !== "files-with-matches"
  )
    return { kind: "fallback", reason: "automatic filename output requires operand metadata" };
  if (parsed.mode === "lines" && options.stdoutIsTTY !== false)
    return { kind: "fallback", reason: "line output requires known non-terminal stdout" };
  if (!parsed.colorNever && options.stdoutIsTTY !== false)
    return { kind: "fallback", reason: "automatic terminal colors require rg" };
  const matcher: MatcherPlan = parsed.fixed
    ? { kind: "literal", patterns: parsed.patterns, ignoreCase: parsed.ignoreCase }
    : { kind: "regex", source: parsed.patterns.join("|"), ignoreCase: parsed.ignoreCase };
  const admitted = compileMatcher(matcher, "rg");
  if (admitted.kind === "fallback") return admitted;
  const walk = walkPlan(parsed.globs);
  if (walk.kind === "fallback") return walk;
  return {
    kind: "supported",
    plan: { tool: "rg", operands, walk: walk.walk, matcher, output: outputPlan(parsed) },
  };
}
