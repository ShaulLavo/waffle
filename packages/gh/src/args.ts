import { GhError } from "./errors.ts";

export interface OptionSpec {
  readonly values?: Readonly<Record<string, string>>;
  readonly flags?: Readonly<Record<string, string>>;
  readonly repeated?: readonly string[];
}

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlyMap<string, boolean>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
}

export function parseArgs(args: readonly string[], spec: OptionSpec): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Map<string, boolean>();
  const repeated = new Map<string, string[]>();
  let literal = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (literal || arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    const option = findOption(arg, spec);
    const name = option.name;
    if (spec.flags?.[name]) {
      flags.set(spec.flags[name], booleanFlag(option.inline, name));
      continue;
    }
    const canonical = spec.values?.[name];
    if (!canonical) throw unknownOption(arg);
    const value = option.inline ?? args[++index];
    if (value === undefined) throw new GhError(`flag needs an argument: ${name}`);
    if (spec.repeated?.includes(canonical)) {
      const list = repeated.get(canonical) ?? [];
      repeated.set(canonical, list.concat([value]));
    } else values.set(canonical, value);
  }
  return { positionals, values, flags, repeated };
}

export function arity(args: ParsedArgs, minimum: number, maximum = minimum): void {
  if (args.positionals.length < minimum || args.positionals.length > maximum)
    throw new GhError("unexpected arguments");
}

export function positiveInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new GhError(`invalid value for ${flag}: ${value}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new GhError(`invalid value for ${flag}: ${value}`);
  return result;
}

export function choice<T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
  flag: string,
): T {
  const selected = value ?? fallback;
  if (!allowed.includes(selected as T)) throw new GhError(`invalid value for ${flag}: ${selected}`);
  return selected as T;
}

function findOption(arg: string, spec: OptionSpec) {
  const equal = arg.startsWith("--") ? arg.indexOf("=") : -1;
  const name = equal < 0 ? arg : arg.slice(0, equal);
  if (spec.flags?.[name] || spec.values?.[name])
    return { name, inline: equal < 0 ? undefined : arg.slice(equal + 1) };
  const short = arg.startsWith("-") && !arg.startsWith("--") ? arg.slice(0, 2) : arg;
  if (short !== arg && spec.values?.[short]) return { name: short, inline: arg.slice(2) };
  throw unknownOption(arg);
}

function booleanFlag(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new GhError(`invalid value for ${name}: ${value}`);
}

function unknownOption(arg: string): GhError {
  if (arg.startsWith("--")) return new GhError(`unknown flag: ${arg.split("=")[0]}`);
  return new GhError(`unknown shorthand flag: '${arg[1] ?? "-"}' in ${arg}`);
}
