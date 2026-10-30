import { CommandError, unsupported } from "./model.ts";

export interface Option {
  readonly name: string;
  readonly value: string;
}

export function options(
  argv: readonly string[],
  booleans: readonly string[],
  values: readonly string[],
): { options: Option[]; operands: string[] } {
  const found: Option[] = [];
  const operands: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") return { options: found, operands: operands.concat(argv.slice(index + 1)) };
    if (arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    const expanded = arg.startsWith("--") ? [arg] : expandShort(arg, values);
    for (const token of expanded) {
      const parsed = readOption(token, argv[index + 1], booleans, values);
      found.push(parsed.option);
      index += parsed.consumed;
    }
  }
  return { options: found, operands };
}

function expandShort(arg: string, values: readonly string[]): string[] {
  const expanded: string[] = [];
  for (let index = 1; index < arg.length; index++) {
    const flag = `-${arg[index]}`;
    const rest = arg.slice(index + 1);
    if (values.includes(flag)) return expanded.concat(rest ? [`${flag}=${rest}`] : [flag]);
    expanded.push(flag);
  }
  return expanded;
}

function readOption(
  token: string,
  next: string | undefined,
  booleans: readonly string[],
  values: readonly string[],
): { option: Option; consumed: number } {
  const equal = token.indexOf("=");
  const name = equal < 0 ? token : token.slice(0, equal);
  if (booleans.includes(name) && equal < 0) return { option: { name, value: "" }, consumed: 0 };
  if (!values.includes(name)) unsupported(`option ${name} is not supported`);
  const value = equal < 0 ? next : token.slice(equal + 1);
  if (value === undefined || value === "") throw new CommandError(`${name} requires a value`);
  return { option: { name, value }, consumed: equal < 0 ? 1 : 0 };
}
