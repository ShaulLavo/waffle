import { spawnSync } from "node:child_process";

export interface EvaluatorCommand {
  readonly name: string;
  readonly executable: string;
  readonly argv0?: string;
  readonly args: readonly string[];
  readonly input?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function runEvaluator(command: EvaluatorCommand, timeoutMs = 15_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000)
    throw new RangeError("Evaluator deadlines must be between 1 and 15000 milliseconds");
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
  if (result.error)
    throw new Error(`${command.name} (${command.executable}): ${result.error.message}`, {
      cause: result.error,
    });
  return result;
}
