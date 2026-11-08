import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { withStorageCleanup } from "../storage-allocation.js";
import { writeResult } from "./result-file.js";

function spawnControls(command: string[], controlsPath: string) {
  return Bun.spawn(command.concat(["--result", controlsPath]), {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "pipe",
  });
}

async function forwardErrors(
  stream: ReadableStream<Uint8Array>,
  file: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  for await (const chunk of stream) {
    process.stderr.write(chunk);
    await file.writeFile(chunk);
  }
}

/** Observe the OS exit, not Bun's exit event, which can report 0 for an unhandled rejection. */
export async function runControlProcess(command: string[], resultPath: string): Promise<number> {
  const controlsPath = `${resultPath}.controls.json`;
  const stderrPath = `${resultPath}.stderr.log`;
  await writeResult(controlsPath, []);
  const stderr = await open(stderrPath, "w");
  let child: ReturnType<typeof spawnControls> | undefined;
  let forwarding: Promise<void> | undefined;
  let supervisorError: { error: unknown } | undefined;
  let exitCode = 1;
  const signals: NodeJS.Signals[] = [];
  const interrupt = (signal: NodeJS.Signals) => {
    signals.push(signal);
    if (child?.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  await withStorageCleanup(
    async () => {
      try {
        child = spawnControls(command, controlsPath);
        forwarding = forwardErrors(child.stderr, stderr);
        await Promise.all([child.exited, forwarding]);
      } catch (error) {
        supervisorError = { error };
        throw error;
      }
    },
    async () => {
      try {
        if (child?.exitCode === null && child.signalCode === null) child.kill();
        if (child) exitCode = await child.exited;
        await forwarding?.catch(() => {});
        await stderr.close();
        const controls: unknown = await Bun.file(controlsPath).json();
        const outcome = child
          ? { kind: "exited", exitCode, signalCode: child.signalCode }
          : { kind: "not-started" };
        const summary = {
          controls,
          exitCode: signals.length || supervisorError ? 1 : exitCode,
          process: outcome,
          signals,
          supervisorError: supervisorError
            ? Bun.inspect(supervisorError.error, { colors: false })
            : null,
          stderrPath,
        };
        console.log(JSON.stringify({ browserControls: summary, resultPath }));
        await writeResult(resultPath, summary);
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    },
  );
  return signals.length ? 1 : exitCode;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const resultIndex = args.indexOf("--result");
  const resultPath =
    resultIndex < 0
      ? (process.env.BROWSER_CONTROLS_RESULT ??
        resolve(".browser-controls", `results-${crypto.randomUUID()}.json`))
      : args[resultIndex + 1];
  if (!resultPath || !isAbsolute(resultPath))
    throw new Error("Use chromium webkit --result /absolute/control-results.json");
  const engines = resultIndex < 0 ? args : args.slice(0, resultIndex);
  process.exitCode = await runControlProcess(
    [process.execPath, join(import.meta.dir, "browser-controls-suite.ts")].concat(engines),
    resultPath,
  );
}
