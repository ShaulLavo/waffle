import { runOwned } from "./owned-command.ts";

/** Linux browser suites need a subreaper: Playwright starts detached process groups. */
export async function runBrowserSuite(
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  if (process.platform !== "linux") return runOwned(command, options);
  options.signal?.throwIfAborted();
  const child = Bun.spawn(
    [process.execPath, import.meta.dir + "/browser-supervisor.ts"].concat(command),
    {
      cwd: options.cwd,
      env: {
        ...options.env,
        WAFFLE_BROWSER_PARENT: String(process.pid),
        WAFFLE_BROWSER_TIMEOUT: String(options.timeoutMs ?? 600_000),
      },
      detached: true,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const stop = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    const code = await child.exited;
    if (code !== 0 || options.signal?.aborted)
      throw Error(`Browser suite failed (${code}): ${command.join(" ")}`);
  } finally {
    options.signal?.removeEventListener("abort", stop);
  }
}
