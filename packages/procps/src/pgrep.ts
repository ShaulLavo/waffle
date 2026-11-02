import {
  CommandError,
  output,
  pidList,
  unsupported,
  type CommandPlan,
  type ProcessRow,
  type SignalPlan,
} from "./model.ts";
import { options } from "./options.ts";
import { compilePattern } from "./pattern.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function planPgrep(
  command: "pgrep" | "pkill",
  argv: readonly string[],
  processes: readonly ProcessRow[],
  selfPid: number,
): CommandPlan {
  const args = command === "pkill" ? signalArguments(argv) : argv;
  const parsed = options(
    args,
    [
      "-f",
      "--full",
      "-x",
      "--exact",
      "-i",
      "--ignore-case",
      "-a",
      "--list-full",
      "-l",
      "--list-name",
      "-c",
      "--count",
    ],
    ["-P", "--parent", "--signal"],
  );
  if (parsed.operands.length > 1) throw new CommandError("only one pattern is allowed");
  const flags = new Set(parsed.options.map((option) => option.name));
  const full = flags.has("-f") || flags.has("--full");
  const exact = flags.has("-x") || flags.has("--exact");
  const ignoreCase = flags.has("-i") || flags.has("--ignore-case");
  const listing = listMode(flags);
  if (command === "pkill" && listing !== "pids")
    unsupported("pkill listing and count options are not supported");
  const parents = parsed.options
    .filter((option) => option.name === "-P" || option.name === "--parent")
    .flatMap((option) => pidList(option.value));
  const signalOptions = parsed.options.filter((option) => option.name === "--signal");
  if (command === "pgrep" && signalOptions.length) unsupported("pgrep does not send signals");
  const requestedSignal = signalOptions.at(-1)?.value ?? "TERM";
  const signal = command === "pkill" ? parseSignal(requestedSignal) : 15;
  const source = parsed.operands[0];
  if (source === undefined && !parents.length)
    throw new CommandError("a pattern or parent selector is required");
  const pattern = source === undefined ? undefined : compilePattern(source, exact, ignoreCase);
  const selected = processes.filter(
    (row) =>
      row.pid !== selfPid &&
      (!parents.length || parents.includes(row.parentPid)) &&
      (!pattern || pattern.test(full ? row.args : shortName(row.comm))),
  );
  selected.sort((left, right) => left.pid - right.pid);
  if (command === "pkill")
    return selected.length
      ? { kind: "signal", signal, pids: selected.map((row) => row.pid) }
      : output("", false);
  const warning =
    !full && source !== undefined && source.length > 15 && !selected.length
      ? "pgrep: pattern that searches for process name longer than 15 characters will result in zero matches\nTry `pgrep -f' option to match against the complete command line.\n"
      : "";
  return output(formatMatches(selected, listing), selected.length > 0, warning);
}

function shortName(name: string): string {
  return decoder.decode(encoder.encode(name).subarray(0, 15));
}

type ListMode = "pids" | "names" | "full" | "count";
function listMode(flags: ReadonlySet<string>): ListMode {
  if (flags.has("-c") || flags.has("--count")) return "count";
  if (flags.has("-a") || flags.has("--list-full")) return "full";
  if (flags.has("-l") || flags.has("--list-name")) return "names";
  return "pids";
}

function formatMatches(rows: readonly ProcessRow[], mode: ListMode): string {
  if (mode === "count") return `${rows.length}\n`;
  return rows
    .map((row) => {
      if (mode === "names") return `${row.pid} ${shortName(row.comm)}\n`;
      if (mode === "full") return `${row.pid} ${row.args}\n`;
      return `${row.pid}\n`;
    })
    .join("");
}

function signalArguments(argv: readonly string[]): string[] {
  const normalized: string[] = [];
  let value = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--") return normalized.concat(argv.slice(index));
    normalized.push(value ? argument : signalArgument(argument));
    value = !value && ["-P", "--parent", "--signal"].includes(argument);
  }
  return normalized;
}

function signalArgument(argument: string): string {
  return /^-(?:[0-9]+|(?:SIG)?[A-Z]+)$/.test(argument) && argument !== "-P"
    ? `--signal=${argument.slice(1)}`
    : argument;
}

function parseSignal(text: string): SignalPlan["signal"] {
  const name = text.replace(/^SIG/, "");
  if (name === "TERM" || name === "15") return 15;
  if (name === "INT" || name === "2") return 2;
  if (name === "KILL" || name === "9") return 9;
  if (name === "PIPE" || name === "13") return 13;
  if (name === "0") unsupported("signal zero has no Waffle process-control operation");
  const otherNames =
    "HUP QUIT ILL TRAP ABRT BUS FPE USR1 SEGV USR2 ALRM STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH IO PWR SYS RTMIN RTMAX";
  if (
    otherNames.split(" ").includes(name) ||
    (/^[0-9]+$/.test(name) && Number(name) >= 1 && Number(name) <= 64)
  )
    unsupported(`signal ${text} is outside this package's supported 2, 9, 13, 15 subset`);
  throw new CommandError(`Unknown signal "${text}"`);
}
