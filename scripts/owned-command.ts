export class CommandCleanupError extends Error {}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

/** Each build/test command owns a process group, including any grandchildren it starts. */
export async function runOwned(command: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number;
}): Promise<void> {
  options.signal?.throwIfAborted();
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env, detached: true, stdout: "inherit", stderr: "inherit" });
  let stopped = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signalGroup(child.pid, "SIGTERM");
    // Let the build shell retire its own command group, then bound an ignoring child.
    escalation = setTimeout(() => { signalGroup(child.pid, "SIGKILL"); }, 2000);
  };
  const timeout = setTimeout(stop, options.timeoutMs ?? 600_000);
  options.signal?.addEventListener("abort", stop, { once: true });
  // Cover an abort racing spawn/listener registration.
  if (options.signal?.aborted) stop();
  try {
    const code = await child.exited;
    if (code !== 0 || stopped) throw new Error(`${command[0]} failed (${code}${stopped ? ", interrupted or timed out" : ""})`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", stop);
    if (escalation) clearTimeout(escalation);
    // A successful leader can still have left a background consumer behind.
    if (signalGroup(child.pid, 0)) signalGroup(child.pid, "SIGKILL");
    await child.exited;
    const deadline = Date.now() + 5000;
    while (signalGroup(child.pid, 0)) {
      if (Date.now() >= deadline) throw new CommandCleanupError(`process group ${child.pid} did not disappear; retain its scratch`);
      await Bun.sleep(10);
    }
  }
}
