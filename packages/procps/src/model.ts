import type { ProcessRecord } from "waffle/proc/table";

export type ProcessInput = Pick<
  ProcessRecord,
  "pid" | "parentPid" | "request" | "state" | "result"
>;

export interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly comm: string;
  readonly args: string;
}

export function processRows(records: Iterable<ProcessInput>): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const record of records) {
    if (!record.request || record.result || record.state === "exited") continue;
    const executable = record.request.executable;
    rows.push({
      pid: record.pid,
      parentPid: record.parentPid,
      comm: executable.slice(executable.lastIndexOf("/") + 1),
      args: record.request.argv.join(" "),
    });
  }
  return rows;
}

export type Command = "ps" | "pgrep" | "pkill";
export interface Output {
  readonly kind: "output";
  readonly status: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}
export interface Unsupported {
  readonly kind: "unsupported";
  readonly status: 1 | 2;
  readonly stdout: "";
  readonly stderr: string;
}
export interface SignalPlan {
  readonly kind: "signal";
  readonly signal: 2 | 9 | 13 | 15;
  readonly pids: readonly number[];
}
export type CommandPlan = Output | Unsupported | SignalPlan;

export function output(stdout: string, matched: boolean, stderr = ""): Output {
  return { kind: "output", status: matched ? 0 : 1, stdout, stderr };
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly kind: "syntax" | "unsupported" = "syntax",
  ) {
    super(message);
  }
}

export function unsupported(message: string): never {
  throw new CommandError(message, "unsupported");
}

export function pidList(text: string): number[] {
  const parts = text.split(/[\s,]+/);
  if (parts.some((part) => !/^[0-9]+$/.test(part))) throw new CommandError("invalid PID list");
  const pids = parts.map(Number);
  if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff))
    throw new CommandError("PID must be between 1 and 2147483647");
  return pids;
}
