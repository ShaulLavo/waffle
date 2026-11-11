import { mkdir, readdir, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { memoryGroupAdapter } from "./memory-group-command.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { record } from "./protocol.js";
import { runPageSuite, type SuiteResult, type PreparationContext } from "./suite-host.js";

const modes = ["missing-member", "wrong-disposal", "complete"] as const;
type Mode = (typeof modes)[number];

function originalResults(actual: unknown): void {
  if (!record(actual)) throw new Error("Memory group result was not retained");
  const phases = [
    "images",
    "sharing",
    "watches",
    "filesystem",
    "outputs",
    "killedBlocked",
    "reuse",
    "churn",
    "admission",
    "failedStop",
    "final",
  ];
  if (!phases.every((phase) => record(actual[phase])))
    throw new Error("Memory group original phase results are missing");
  if (
    !record(actual.churn) ||
    !Array.isArray(actual.churn.rounds) ||
    actual.churn.rounds.length !== 6
  )
    throw new Error("Memory group did not retain all six original churn rounds");
  if (!record(actual.final) || actual.final.members !== 0 || actual.final.retained !== 1)
    throw new Error("Memory group final member or retained debt observation is missing");
}

export function checkedMemoryGroupControl(result: SuiteResult, mode: Mode): void {
  if (
    result.suite !== "memory-group" ||
    result.required.length !== 1 ||
    JSON.stringify(result.selected) !== JSON.stringify(result.required) ||
    result.omitted.length ||
    !result.runComplete ||
    result.failures.length ||
    result.documents.length !== 3 ||
    !result.documents.every((doc) => doc.doc && doc.cutoff !== null) ||
    result.ledger.length ||
    !result.storageRemaining ||
    result.storageRemaining.length ||
    result.cleanup.storage.status !== "not-created"
  )
    throw new Error(`Memory group ${mode} accounting failed: ${JSON.stringify(result)}`);
  const cleanup = result.cleanup;
  if (
    [cleanup.session, cleanup.launcher, cleanup.server, cleanup.scratch].some(
      (step) => step.status !== "confirmed",
    )
  )
    throw new Error(`Memory group cleanup unconfirmed: ${JSON.stringify(cleanup)}`);
  const id = result.required[0];
  if (!id) throw new Error("Memory group command was not selected");
  const outcome = result.outcomes[id];
  if (mode === "complete") {
    originalResults(result.results[id]);
    if (result.exit !== 0 || outcome?.status !== "pass" || outcome.provisional)
      throw new Error("Complete memory group command did not pass");
    return;
  }
  if (result.exit !== 1 || outcome?.status !== "fail")
    throw new Error(`Memory group ${mode} failure passed`);
  if (mode === "wrong-disposal") {
    originalResults(result.results[id]);
    if (!outcome.detail.includes("disposal released the page with unsettled group debt"))
      throw new Error("Wrong disposal did not reach the original host assertion");
    return;
  }
  if (
    Object.hasOwn(result.results, id) ||
    !outcome.detail.includes("link member: invalid wasm header")
  )
    throw new Error(`Missing member did not fail the actual loader: ${outcome.detail}`);
}

async function control(mode: Mode, root: string, scratch: string): Promise<void> {
  const resultPath = join(root, `${mode}.json`);
  const result = await runPageSuite(
    { ...memoryGroupAdapter, assets: (context) => controlAssets(mode, context) },
    (path) => new PlaywrightDriver("chromium", path),
    {
      scratchRoot: scratch,
      resultPath,
      port: 19462,
      signal: AbortSignal.timeout(600_000),
    },
  );
  if (JSON.stringify(await Bun.file(resultPath).json()) !== JSON.stringify(result))
    throw new Error("Persisted memory group result differs from the actual result");
  checkedMemoryGroupControl(result, mode);
  if ((await readdir(scratch)).length)
    throw new Error(`Memory group retained scratch in ${scratch}`);
  console.log(JSON.stringify({ mode, exit: result.exit, cleanup: result.cleanup }));
}

async function controlAssets(mode: Mode, context: PreparationContext) {
  const assets = await memoryGroupAdapter.assets(context);
  if (mode === "complete") return assets;
  if (mode === "missing-member") delete assets["/memory-group-member.wasm"];
  else
    assets["/memory-group-browser.js"] = await browserBundle(
      join(import.meta.dir, "memory-group-control-page.ts"),
    );
  return assets;
}

export async function runMemoryGroupControls(root: string, scratch: string): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(scratch)) throw new Error("Control paths must be absolute");
  await mkdir(root, { recursive: true });
  await mkdir(scratch);
  try {
    for (const mode of modes) await control(mode, root, scratch);
  } finally {
    if ((await readdir(scratch)).length === 0) await rmdir(scratch);
  }
}
