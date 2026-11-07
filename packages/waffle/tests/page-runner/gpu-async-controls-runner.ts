const startedAt = performance.now();

export async function runGpuAsyncControls(
  root: string,
  scratch: string,
  engines: readonly string[],
) {
  const { isAbsolute, join } = await import("node:path");
  const { mkdir, readdir, rmdir } = await import("node:fs/promises");
  const { gpuAsyncAdapter } = await import("./gpu-async-suite.js");
  const { PlaywrightDriver } = await import("./playwright-driver.js");
  const { runPageSuite } = await import("waffle/testing/page-runner");
  const { qualificationEngine, swiftShaderArgs } = await import("../gpu-browser-qualification.js");
  if (!isAbsolute(root) || !isAbsolute(scratch)) throw new Error("Control paths must be absolute");
  await mkdir(root, { recursive: true });
  await mkdir(scratch);
  try {
    for (const name of engines) {
      const engine = qualificationEngine(name);
      const result = await runPageSuite(
        gpuAsyncAdapter(engine),
        (path) =>
          engine === "chromium"
            ? new PlaywrightDriver(engine, path, swiftShaderArgs)
            : new PlaywrightDriver(engine, path),
        {
          resultPath: join(root, `hosted-${engine}.json`),
          scratchRoot: scratch,
          startedAt,
        },
      );
      if (
        result.exit !== 0 ||
        !result.runComplete ||
        result.required.length !== 1 ||
        result.selected.length !== 1 ||
        result.omitted.length ||
        result.failures.length ||
        result.documents.length !== 3 ||
        result.documents.some((doc) => !doc.doc || doc.cutoff === null) ||
        result.ledger.length ||
        result.storageRemaining?.length !== 0
      )
        throw new Error(`GPU async ${engine} command failed: ${JSON.stringify(result)}`);
      if (
        [
          result.cleanup.session,
          result.cleanup.launcher,
          result.cleanup.server,
          result.cleanup.scratch,
        ].some((step) => step.status !== "confirmed") ||
        result.cleanup.storage.status !== "not-created"
      )
        throw new Error(
          `GPU async ${engine} cleanup unconfirmed: ${JSON.stringify(result.cleanup)}`,
        );
      if (
        JSON.stringify(await Bun.file(join(root, `hosted-${engine}.json`)).json()) !==
        JSON.stringify(result)
      )
        throw new Error("Persisted GPU async result differs");
      if ((await readdir(scratch)).length) throw new Error("GPU async retained owned scratch");
      console.log(
        JSON.stringify({
          engine,
          exit: result.exit,
          results: result.results,
          cleanup: result.cleanup,
        }),
      );
    }
  } finally {
    if ((await readdir(scratch)).length === 0) await rmdir(scratch);
  }
}
if (import.meta.main) {
  const [root, scratch, ...engines] = process.argv.slice(2);
  if (!root || !scratch || !engines.length)
    throw new Error("Pass absolute report root, new scratch path and engines");
  if (engines.length === 1 && engines[0] === "--failures") {
    const { runGpuAsyncFailureControls } = await import("./gpu-async-failure-controls.js");
    await runGpuAsyncFailureControls(root, scratch, startedAt);
  } else await runGpuAsyncControls(root, scratch, engines);
}
