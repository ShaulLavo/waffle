import { atomicsWaitAsync, atomicsWaitAsyncBigInt } from "./intrinsics.js";
import type { FilesystemConnection } from "../fs/protocol.js";
import { CommandStdioError, type HostCommandContext, type ProcessQuery } from "./command.js";
import { CommandStdio } from "./command-stdio.js";
import { TaggedCells, controlLoad, controlNotify } from "./control.js";
import { readOutcome } from "./outcome.js";
import type { CommandProcessContext, ProcessHandle } from "./types.js";

export interface CommandCapabilities {
  readonly processes: ProcessQuery;
  readonly filesystem?: FilesystemConnection;
}

export function runCommand(
  context: CommandProcessContext,
  capabilities: CommandCapabilities,
): ProcessHandle {
  const abort = new AbortController();
  const revoke = () => {
    abort.abort();
    controlNotify(context.interrupt, 0);
  };
  const unregister = context.registerRevocation(revoke);
  const admission = context.command.definition.admission;
  const stdio = new CommandStdio(context.descriptors, abort.signal, capabilities.filesystem);
  const leave = context.command.definition.retain?.();
  let stopping: Promise<void> | undefined;
  const task = execute(context, capabilities, stdio, abort.signal);
  const watching = watchSignals(context, abort.signal);
  void watching.catch((error) => {
    if (!abort.signal.aborted) context.fail(error);
  });
  void task.catch(() => {});
  return {
    terminate() {
      stopping ??= finish();
      return stopping;
    },
  };

  async function finish(): Promise<void> {
    revoke();
    await task;
    await watching;
    await stdio.settle();
    unregister();
    leave?.();
  }

  async function execute(
    process: CommandProcessContext,
    borrowed: CommandCapabilities,
    io: CommandStdio,
    signal: AbortSignal,
  ): Promise<void> {
    await Promise.resolve();
    if (signal.aborted || admission?.aborted) {
      if (!signal.aborted) process.startFailed(new Error("Program was uninstalled"));
      return;
    }
    if (!process.started()) return;
    const request = Object.freeze({
      executable: process.request.executable,
      argv: Object.freeze(process.request.argv.slice()),
      env: Object.freeze({ ...process.request.env }),
      cwd: process.request.cwd,
    });
    const command: HostCommandContext = Object.freeze({
      pid: process.pid,
      parentPid: process.parentPid,
      request,
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      processes: borrowed.processes,
      abort: signal,
    });
    try {
      const code = await process.command.run(command);
      if (signal.aborted) return;
      if (!Number.isInteger(code) || code < 0 || code > 255)
        throw new TypeError("Command exit code must be an integer from 0 to 255");
      process.exit(code);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof CommandStdioError && error.code === "EPIPE") process.defaultSignal(13);
      else process.fail(error);
    }
  }
}

async function watchSignals(context: CommandProcessContext, abort: AbortSignal): Promise<void> {
  const word =
    context.interrupt instanceof TaggedCells ? context.interrupt.cells : context.interrupt;
  while (!abort.aborted) {
    const waiting =
      word instanceof BigInt64Array
        ? atomicsWaitAsyncBigInt(word, 0, Atomics.load(word, 0))
        : atomicsWaitAsync(word, 0, Atomics.load(word, 0));
    const outcome = readOutcome(context.outcome);
    const signal = controlLoad(context.interrupt, 0);
    if (outcome?.kind === "signaled" || signal)
      context.defaultSignal(outcome?.kind === "signaled" ? outcome.code : signal);
    if (abort.aborted) return;
    await waiting.value;
  }
}
