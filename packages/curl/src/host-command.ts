import type { HostCommand, HostCommandContext } from "waffle";
import type { createCurlCommand } from "./command.ts";
import type { CurlInvocation, CurlOutput } from "./types.ts";

export interface CurlFileRequest {
  readonly path: string;
  /** The real command cwd. The file owner resolves paths, including symlinks and rights. */
  readonly cwd: string;
  readonly signal: AbortSignal;
}

/** Explicit page-delegated file authority, not an implicit per-process filesystem grant. */
export interface CurlPackageFiles {
  read(request: CurlFileRequest): Promise<ReadableStream<Uint8Array>>;
  write(request: CurlFileRequest): Promise<CurlOutput>;
}

export interface CurlPackageOptions {
  readonly fetch: CurlInvocation["fetch"];
  readonly timeoutMs: number;
  /** Omit to deny @file and -o file. Stdio redirections still use Waffle's admitted fds. */
  readonly files?: CurlPackageFiles;
}

const encoder = new TextEncoder();

export function bindCurlCommand(
  command: ReturnType<typeof createCurlCommand>,
  options: CurlPackageOptions,
): HostCommand {
  return async (context) =>
    command.run({
      argv: context.request.argv.slice(1),
      signal: context.abort,
      timeoutMs: options.timeoutMs,
      fetch: options.fetch,
      stdin: inputStream(context.stdin),
      stdout: {
        write: (bytes, signal) => untilAborted(context.stdout.write(bytes), signal),
        close: borrowedOutput,
        abort: borrowedOutput,
      },
      stderr: (text) => diagnostic(context, text, options.timeoutMs),
      files: {
        read: (path, signal) => {
          if (!options.files) return Promise.reject(new Error("curl file reads were not granted"));
          return options.files.read({ path, cwd: context.request.cwd, signal });
        },
        write: (path, signal) => {
          if (!options.files) return Promise.reject(new Error("curl file writes were not granted"));
          return options.files.write({ path, cwd: context.request.cwd, signal });
        },
      },
    });
}

function inputStream(input: HostCommandContext["stdin"]): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream(
    {
      async pull(controller) {
        const bytes = await input.read();
        if (cancelled) return;
        if (bytes === null) controller.close();
        else controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
}

async function borrowedOutput(): Promise<never> {
  throw new Error("curl must not close or abort borrowed stdout");
}

/** A local deadline ends the callback. Waffle still owns and fences the admitted stdio I/O. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

async function diagnostic(
  context: HostCommandContext,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = AbortSignal.any([context.abort, deadline.signal]);
  try {
    await untilAborted(context.stderr.write(encoder.encode(text)), signal);
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
}
