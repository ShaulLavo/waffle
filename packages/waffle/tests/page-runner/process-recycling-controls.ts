import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runPageSuite, type SuiteResult } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { processRecyclingAdapter } from "./process-recycling-suite.js";
import { writeProcessDiagnostics } from "./process-recycling-native.js";

const controls = [
  "memory-only",
  "startup-memory",
  "wrong-label",
  "worker-error",
  "missing-worker",
  "page-error",
] as const;
type Control = (typeof controls)[number];

async function bundle(source: string, define?: Record<string, string>): Promise<Blob> {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, source)],
    target: "browser",
    define,
  });
  if (!build.success || !build.outputs[0])
    throw new AggregateError(build.logs, "Process control bundle failed");
  return build.outputs[0];
}
export function checkProcessControl(result: SuiteResult, mode: Control): void {
  const id = result.selected[0];
  if (
    !id ||
    result.selected.length !== 1 ||
    result.required.length !== processRecyclingAdapter.inventory().length
  )
    throw new Error("Process control lost full inventory or selected case");
  if (result.ledger.length || result.cleanup.storage.status !== "not-created")
    throw new Error("Memory-only process control allocated durable storage");
  const cleanup = result.cleanup;
  if (
    [cleanup.session, cleanup.launcher, cleanup.server, cleanup.scratch].some(
      (step) => step.status !== "confirmed",
    )
  )
    throw new Error(`Process control cleanup failed: ${JSON.stringify(cleanup)}`);
  const outcome = result.outcomes[id];
  const evidence = JSON.stringify({
    outcomes: result.outcomes,
    failures: result.failures,
    results: result.results,
  });
  if (mode === "memory-only" || mode === "startup-memory") {
    if (result.exit !== 4 || result.results[id] !== id || outcome?.status !== "pass")
      throw new Error(`Original ${mode} process body failed: ${evidence}`);
    return;
  }
  if (outcome?.status !== "fail" && result.failures.length === 0)
    throw new Error(`Process ${mode} falsely passed`);
  const expected =
    mode === "page-error"
      ? "PROCESS_CONTROL_PAGE_ERROR"
      : mode === "wrong-label"
        ? "PROCESS_CONTROL_WRONG_LABEL"
        : mode === "worker-error"
          ? "PROCESS_CONTROL_WORKER_ERROR"
          : "cell";
  if (!evidence.includes(expected)) throw new Error(`Process ${mode} lost actual failure evidence`);
}
async function control(engine: "chromium" | "webkit", mode: Control, root: string): Promise<void> {
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(60_000);
  const assets = await processRecyclingAdapter.assets({ scratch: root, signal });
  assets["/process-page.js"] = await bundle("process-recycling-controls-page.ts", {
    PROCESS_CONTROL: JSON.stringify(
      mode === "page-error" || mode === "wrong-label" ? mode : "memory-only",
    ),
  });
  assets["/cell-fs-worker.js"] = await bundle("process-recycling-fs-control-worker.ts");
  let filter = mode === "startup-memory" ? "startup pool:" : "cell clone: browser broker";
  if (mode === "worker-error") {
    assets["/process-client.js"] = await bundle("process-recycling-error-control-worker.ts");
    filter = "shared Worker waits consume";
  }
  if (mode === "missing-worker") delete assets["/cell-worker.js"];
  const resultPath = join(root, `${engine}-${mode}.json`);
  const result = await runPageSuite(
    processRecyclingAdapter,
    (path) => new PlaywrightDriver(engine, path),
    {
      resultPath,
      scratchRoot: dirname(root),
      assets,
      filter,
      signal,
      startedAt,
    },
  );
  if (JSON.stringify(await Bun.file(resultPath).json()) !== JSON.stringify(result))
    throw new Error("Persisted process control differs from actual result");
  checkProcessControl(result, mode);
  await writeProcessDiagnostics(resultPath);
  const diagnostics = await Bun.file(`${resultPath}.diagnostics.json`).json();
  if (
    JSON.stringify(diagnostics.outcomes) !== JSON.stringify(result.outcomes) ||
    JSON.stringify(diagnostics.failures) !== JSON.stringify(result.failures)
  )
    throw new Error("Process automatic diagnostics lost the actual failure");
  console.log(
    JSON.stringify({
      processControl: mode,
      engine,
      exit: result.exit,
      selected: result.selected,
      outcomes: result.selected.map((id) => result.outcomes[id]),
      cleanup: result.cleanup,
    }),
  );
}
async function engineControls(engine: string, root: string): Promise<void> {
  if (engine !== "chromium" && engine !== "webkit")
    throw new Error(`Unknown process control engine ${engine}`);
  for (const mode of controls) await control(engine, mode, root);
}
export async function processRecyclingControls(names: string[]): Promise<void> {
  const root = await mkdtemp(join(process.env.PROCESS_SCRATCH_ROOT ?? tmpdir(), "wpc-"));
  let completed = false;
  try {
    for (const engine of names.length ? names : ["chromium"]) await engineControls(engine, root);
    completed = true;
  } finally {
    if (completed) await rm(root, { recursive: true, force: true });
    else console.error(`Retained process control evidence for parent cleanup: ${root}`);
  }
}
