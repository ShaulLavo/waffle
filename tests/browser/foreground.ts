interface ForegroundShell {
  readonly running: boolean;
  readonly lastExit: number;
  input(data: string): void;
  submit(command: string): Promise<void>;
}

type PlaygroundGlobal = typeof globalThis & { playground: { shell: ForegroundShell } };

export interface ForegroundPage {
  evaluate<Result, Argument>(callback: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result>;
  waitForFunction(callback: () => boolean, argument: undefined, options: { timeout: number }): Promise<unknown>;
}

/** Tests explicitly choose SIGINT then SIGKILL through the two-Ctrl-C contract, and wait for completion. */
export async function stopForeground(page: ForegroundPage, timeout = 15000): Promise<void> {
  await page.evaluate(() => {
    const { shell } = (globalThis as PlaygroundGlobal).playground;
    if (shell.running) shell.input("\x03");
    if (shell.running) shell.input("\x03");
  }, undefined);
  await page.waitForFunction(() => !(globalThis as PlaygroundGlobal).playground.shell.running, undefined, { timeout });
}

/** Run one command, explicitly cleaning up its foreground process on timeout. */
export async function runForeground(page: ForegroundPage, command: string, timeout: number): Promise<{ code: number | null; ms: number }> {
  const result = await page.evaluate(async ([command, timeout]: [string, number]) => {
    const { shell } = (globalThis as PlaygroundGlobal).playground;
    const started = performance.now();
    const done = shell.submit(command).then(() => shell.lastExit);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([done, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeout); })]);
      return { code, ms: performance.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }, [command, timeout]);
  if (result.code === null) await stopForeground(page);
  return result;
}
