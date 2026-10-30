import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export interface Command {
  readonly name: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly argv0?: string;
  readonly cwd?: string;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function isCompletedInputPipeClose(
  result: SpawnSyncReturns<string>,
  command: Command,
): boolean {
  const error = result.error;
  if (error === undefined || command.input === undefined) return false;
  if (result.status === null || result.signal !== null) return false;
  return "code" in error && error.code === "EPIPE";
}

export function runCommand(command: Command, timeoutMs = 15_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    throw new RangeError("Command deadlines must be between 1 and 15000 milliseconds");
  }
  const result = spawnSync(command.executable, command.args, {
    cwd: command.cwd,
    argv0: command.argv0,
    input: command.input,
    env: command.env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error && !isCompletedInputPipeClose(result, command)) {
    throw new Error(`${command.name} (${command.executable}): ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result;
}
