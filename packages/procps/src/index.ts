import { CommandError, type Command, type CommandPlan, type ProcessRow } from "./model.ts";
import { planPgrep } from "./pgrep.ts";
import { planPs } from "./ps.ts";

export {
  processRows,
  type ProcessInput,
  type ProcessRow,
  type CommandPlan,
  type Output,
  type SignalPlan,
  type Unsupported,
} from "./model.ts";

export function planProcps(input: {
  readonly command: Command;
  readonly argv: readonly string[];
  readonly processes: readonly ProcessRow[];
  readonly selfPid: number;
}): CommandPlan {
  try {
    return input.command === "ps"
      ? planPs(input.argv, input.processes)
      : planPgrep(input.command, input.argv, input.processes, input.selfPid);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    const status = input.command === "ps" ? 1 : 2;
    const stderr = `${input.command}: ${error.kind === "unsupported" ? "unsupported: " : ""}${error.message}\n`;
    return error.kind === "unsupported"
      ? { kind: "unsupported", status, stdout: "", stderr }
      : { kind: "output", status, stdout: "", stderr };
  }
}
