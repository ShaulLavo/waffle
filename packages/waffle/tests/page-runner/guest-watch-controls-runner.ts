import { mkdir, readdir, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { browserBundle, type engines } from "../browser-runner-lifecycle.js";
import { commandAdapter, type CommandRequest } from "./command-suites.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { record } from "./protocol.js";
import { runPageSuite, type SuiteResult } from "./suite-host.js";

const modes = ["complete", "ordered", "missing-relay", "failed-relay", "incomplete-relay"] as const;
type Mode = (typeof modes)[number];

async function assets(mode: Mode, scratch: string, signal: AbortSignal) {
  const built = await commandAdapter("guest-watch").assets({ scratch, signal });
  if (mode === "complete") return built;
  built["/phases.js"] = await browserBundle(join(import.meta.dir, "guest-watch-control-phases.ts"));
  built["/cases.js"] = 'export { guestWatchCase } from "/phases.js";';
  built["/race.js"] = 'export { notificationRelayRaceCase } from "/phases.js";';
  if (mode === "missing-relay") delete built["/race.js"];
  if (mode === "failed-relay") {
    built["/stalled-helper.js"] = await browserBundle(
      join(import.meta.dir, "guest-watch-stalled-helper.ts"),
    );
    built["/race.js"] = `import { notificationRelayRaceCase as relay } from "/phases.js";
export function notificationRelayRaceCase() {
  return relay(new URL("/stalled-helper.js", import.meta.url).href);
}`;
  }
  if (mode === "incomplete-relay")
    built["/race.js"] = "export function notificationRelayRaceCase() { return {iterations: 0}; }";
  return built;
}

function checkedCleanup(result: SuiteResult): void {
  const { session, launcher, server, scratch, storage } = result.cleanup;
  if (
    [session, launcher, server, scratch].some((step) => step.status !== "confirmed") ||
    storage.status !== "not-created" ||
    result.ledger.length
  )
    throw new Error(`Guest watch control cleanup failed: ${JSON.stringify(result.cleanup)}`);
}

export function checkedGuestWatchControl(result: SuiteResult, mode: Mode): void {
  checkedCleanup(result);
  const passed = mode === "complete" || mode === "ordered";
  if (
    result.exit !== (passed ? 0 : 1) ||
    result.required.length !== 1 ||
    JSON.stringify(result.selected) !== JSON.stringify(result.required) ||
    result.omitted.length ||
    !result.runComplete ||
    result.failures.length ||
    result.documents.length !== 3 ||
    !result.documents.every((doc) => doc.doc && doc.cutoff !== null)
  )
    throw new Error(`Guest watch ${mode} control failed: ${JSON.stringify(result)}`);
  const id = result.required[0];
  if (!id) throw new Error("Guest watch command was not selected");
  const outcome = result.outcomes[id];
  if (passed) {
    checkPhases(result.results[id]);
    if (outcome?.status !== "pass") throw new Error("Guest watch command did not pass");
    return;
  }
  if (outcome?.status !== "fail") throw new Error(`Relay failure passed: ${mode}`);
  if (mode === "failed-relay" && !outcome.detail.includes("Relay stalled at 0"))
    throw new Error(`Original relay assertion was lost: ${outcome.detail}`);
  if (mode === "incomplete-relay") {
    const actual = result.results[id];
    if (!record(actual) || !record(actual.relay) || actual.relay.iterations !== 0)
      throw new Error("Failed relay result was not retained");
    if (!outcome.detail.includes("notification relay proof did not finish"))
      throw new Error("Incomplete relay did not reach the host result check");
  }
}

function checkPhases(actual: unknown): void {
  if (!record(actual)) throw new Error("Guest watch result was not retained");
  if (
    typeof actual.early !== "number" ||
    typeof actual.late !== "number" ||
    actual.early + actual.late !== 200 ||
    actual.directWrites !== 100 ||
    actual.pageWrites !== 100 ||
    !Array.isArray(actual.quietWakes) ||
    actual.quietWakes.length !== 20 ||
    !record(actual.relay) ||
    actual.relay.iterations !== 200_000
  )
    throw new Error(`Original phase results were lost: ${JSON.stringify(actual)}`);
}

async function control(engine: keyof typeof engines, mode: Mode, root: string, scratch: string) {
  const adapter = commandAdapter("guest-watch");
  const resultPath = join(root, `${engine}-${mode}.json`);
  const request: CommandRequest | undefined = adapter.inventory()[0]?.request("control");
  const signal = AbortSignal.timeout(180_000);
  if (request?.entry !== "/guest-watch.js" || adapter.budgets(1).case !== 120_000)
    throw new Error("Guest watch lost its composition entry or 120-second body budget");
  const result = await runPageSuite(adapter, (path) => new PlaywrightDriver(engine, path), {
    resultPath,
    scratchRoot: scratch,
    assets: await assets(mode, scratch, signal),
    signal,
  });
  if (JSON.stringify(await Bun.file(resultPath).json()) !== JSON.stringify(result))
    throw new Error("Persisted guest watch result differs from actual result");
  checkedGuestWatchControl(result, mode);
  if ((await readdir(scratch)).length)
    throw new Error(`Guest watch retained scratch in ${scratch}`);
  console.log(JSON.stringify({ engine, mode, exit: result.exit, cleanup: result.cleanup }));
}

async function engineControls(name: string, root: string, scratch: string): Promise<void> {
  if (name !== "chromium" && name !== "webkit") throw new Error(`Unsupported engine ${name}`);
  for (const mode of modes) await control(name, mode, root, scratch);
}

async function main(): Promise<void> {
  const [root, ...names] = process.argv.slice(2);
  const scratch = process.env.STORAGE_SCRATCH_ROOT;
  if (!root || !isAbsolute(root) || !scratch || !isAbsolute(scratch) || !names.length)
    throw new Error(
      "Use STORAGE_SCRATCH_ROOT=/short/owned/path bun guest-watch-controls-runner.ts /absolute/results chromium webkit",
    );
  await mkdir(root, { recursive: true });
  await mkdir(scratch);
  try {
    for (const name of names) await engineControls(name, root, scratch);
  } finally {
    if ((await readdir(scratch)).length === 0) await rmdir(scratch);
  }
}
if (import.meta.main) await main();
