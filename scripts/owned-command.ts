export class CommandCleanupError extends Error {}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Retire descendants even when their command leader has already exited. */
export async function retireCommandGroup(pid: number): Promise<void> {
  if (signalGroup(pid, 0)) signalGroup(pid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline)
      throw new CommandCleanupError(`process group ${pid} did not disappear; retain its scratch`);
    await Bun.sleep(10);
  }
}

/** Each build/test command owns a process group, including any grandchildren it starts. */
export async function runOwned(
  command: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Start a command's deadline after its readiness handshake, rather than spawn. */
    timeoutStartsAfter?: Promise<void>;
  },
): Promise<void> {
  options.signal?.throwIfAborted();
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdout: "inherit",
    stderr: "inherit",
  });
  let stopped = false;
  let finished = false;
  let readinessFailed = false;
  let readinessError: unknown;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped || finished) return;
    stopped = true;
    signalGroup(child.pid, "SIGTERM");
    // Let the build shell retire its own command group, then bound an ignoring child.
    escalation = setTimeout(() => {
      signalGroup(child.pid, "SIGKILL");
    }, 2000);
  };
  const armTimeout = () => {
    if (!finished && !stopped) timeout = setTimeout(stop, options.timeoutMs ?? 600_000);
  };
  if (options.timeoutStartsAfter) {
    void options.timeoutStartsAfter.then(armTimeout, (error) => {
      if (finished) return;
      readinessFailed = true;
      readinessError = error;
      stop();
    });
  } else armTimeout();
  options.signal?.addEventListener("abort", stop, { once: true });
  // Cover an abort racing spawn/listener registration.
  if (options.signal?.aborted) stop();
  try {
    const code = await child.exited;
    if (readinessFailed) throw readinessError;
    if (code !== 0 || stopped)
      throw new Error(
        `${command[0]} failed (${code}${stopped ? ", interrupted or timed out" : ""})`,
      );
  } finally {
    finished = true;
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", stop);
    if (escalation) clearTimeout(escalation);
    // A successful leader can still have left a background consumer behind.
    await retireCommandGroup(child.pid);
    await child.exited;
  }
}
