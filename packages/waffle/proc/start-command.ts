import type { Runtime } from "../runtime.js";
import type { ProcessExit, ProcessSignal } from "./types.js";

export interface CommandOutputOptions {
  readonly limitBytes?: number;
  readonly onChunk?: (bytes: Uint8Array) => undefined;
}

export interface CommandOptions {
  readonly filesystem: "runtime-root";
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array | ReadableStream<Uint8Array> | "closed";
  readonly stdout?: CommandOutputOptions | "closed";
  readonly stderr?: CommandOutputOptions | "closed";
  readonly deadlineMs?: number;
}

export interface CommandOutput {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

type StopRequest = "kill" | "deadline";

export type CommandResult = Readonly<{
  stdout: CommandOutput;
  stderr: CommandOutput;
}> &
  (
    | Readonly<{ exit: ProcessExit; stopRequested?: StopRequest }>
    | Readonly<{ exit: null; stopRequested: StopRequest }>
  );

export interface RunningCommand {
  readonly result: Promise<CommandResult>;
  signal(signal: ProcessSignal): Promise<void>;
  kill(): Promise<CommandResult>;
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
  );
}

function path(value: unknown): value is string {
  return text(value) && value.startsWith("/");
}

function output(value: CommandOutputOptions | "closed" | undefined) {
  if (value === "closed" || value === undefined) return value;
  if (!value || typeof value !== "object") throw new TypeError("Invalid command output");
  const { limitBytes, onChunk } = value;
  if (limitBytes !== undefined && (!Number.isSafeInteger(limitBytes) || limitBytes < 0))
    throw new RangeError("Command output limit must be a nonnegative integer");
  if (onChunk !== undefined && typeof onChunk !== "function")
    throw new TypeError("Command output callback must be a function");
  return { limitBytes, onChunk };
}

function snapshot(executable: string, options: CommandOptions): CommandOptions {
  if (options?.filesystem !== "runtime-root")
    throw new TypeError('Commands require filesystem: "runtime-root"');
  if (!path(executable)) throw new TypeError("Command executable must be an absolute path");
  const { args, cwd = "/", env, stdin, stdout, stderr, deadlineMs } = options;
  if (!path(cwd)) throw new TypeError("Command cwd must be an absolute path");
  if (args !== undefined && !Array.isArray(args)) throw new TypeError("Invalid command args");
  const argv = Array.from(args ?? []);
  if (!argv.every(text)) throw new TypeError("Invalid command argument");
  if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env)))
    throw new TypeError("Invalid command environment");
  const entries = Object.entries(env ?? {});
  if (entries.some(([key, value]) => !text(key) || !text(value) || !key || key.includes("=")))
    throw new TypeError("Invalid command environment entry");
  if (
    stdin !== undefined &&
    stdin !== "closed" &&
    !(stdin instanceof Uint8Array) &&
    !(stdin instanceof ReadableStream)
  )
    throw new TypeError("Invalid command stdin");
  if (stdin instanceof ReadableStream && stdin.locked)
    throw new TypeError("Command stdin is already locked");
  if (
    deadlineMs !== undefined &&
    (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 0x7fffffff)
  )
    throw new RangeError("Command deadline must be between 1 and 2147483647 ms");
  return {
    filesystem: "runtime-root",
    args: argv,
    cwd,
    env: Object.fromEntries(entries),
    stdin: stdin instanceof Uint8Array ? new Uint8Array(stdin) : stdin,
    stdout: output(stdout),
    stderr: output(stderr),
    deadlineMs,
  };
}

/** Run an installed, byte-backed Wasm program in the caller's runtime. */
export function startCommand(
  runtime: Runtime,
  executable: string,
  options: CommandOptions,
): RunningCommand {
  const input = snapshot(executable, options);
  const stopped = new AbortController();
  let stopRequested: StopRequest | undefined;
  let settled = false;
  const stop = (reason: StopRequest) => {
    if (settled || stopRequested) return;
    stopRequested = reason;
    stopped.abort();
  };
  const timer =
    input.deadlineMs === undefined
      ? undefined
      : setTimeout(() => stop("deadline"), input.deadlineMs);
  const running = import("../browser/run-command.js").then(({ runCommand }) =>
    runCommand(runtime, executable, input, stopped.signal),
  );
  const result: Promise<CommandResult> = running
    .then((command) => command.result)
    .then(({ exit, stdout, stderr }) => {
      if (exit) return { exit, stdout, stderr, ...(stopRequested ? { stopRequested } : {}) };
      if (!stopRequested) throw new Error("Command did not reserve its leader");
      return { exit: null, stdout, stderr, stopRequested };
    })
    .finally(() => {
      settled = true;
      clearTimeout(timer);
    });
  return {
    result,
    async signal(signal) {
      if (signal === 9) {
        stop("kill");
        return;
      }
      if (settled) return;
      await (await running).signal(signal);
    },
    kill() {
      stop("kill");
      return result;
    },
  };
}
