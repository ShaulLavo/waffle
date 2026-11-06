import { join } from "node:path";
import { browserBundle, type engines } from "../browser-runner-lifecycle.js";
import { commandAdapter, commandPageBundle, type CommandRequest } from "./command-suites.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { runPageSuite, type SuiteAdapter, type SuiteResult } from "./suite-host.js";
import { record } from "./protocol.js";
import { runStorage } from "./storage-host.js";

export const commandControlModes = [
  "objectResult",
  "arrayResult",
  "throwingBody",
  "cyclicResult",
  "bigintResult",
  "missingResult",
  "sizeResult",
  "multibyteResult",
  "snapshotResult",
  "wrongResult",
  "missing-export",
  "import-failure",
];
const fixtureArgs = ["/guest.js?mode=sample", "/helper.js", "/writer.js"];
function fixtureAdapter(mode: string): SuiteAdapter<CommandRequest> {
  const adapter = commandAdapter(mode === "arrayResult" ? "fs-socket-attachment" : "guest-watch");
  const original = adapter.inventory()[0];
  if (!original) throw new Error("Missing command control inventory");
  const request: CommandRequest = {
    entry: mode === "import-failure" ? "/absent.js" : "/fixture.js",
    exportName: mode === "missing-export" ? "absent" : mode,
    args: fixtureArgs,
  };
  return {
    ...adapter,
    inventory: () => [{ ...original, request: () => request }],
    assets: async () => ({
      "/page.js": await commandPageBundle({ ...request, id: original.id }),
      "/fixture.js": await browserBundle(join(import.meta.dir, "command-fixtures.ts")),
    }),
  };
}
function checkedResult(result: SuiteResult, expectedExit: number): void {
  const { storage, session, launcher, server, scratch } = result.cleanup;
  if (
    result.exit !== expectedExit ||
    [session, launcher, server, scratch].some((step) => step.status !== "confirmed") ||
    storage.status !== "not-created" ||
    result.ledger.length
  )
    throw new Error(`Command control failed: ${JSON.stringify(result)}`);
}
function checkedSuccess(result: SuiteResult, mode: string): void {
  const actual = Object.values(result.results)[0];
  if (
    result.required.length !== 1 ||
    result.selected.length !== 1 ||
    result.omitted.length ||
    !result.runComplete ||
    result.documents.length !== 3 ||
    !result.documents.every((doc) => doc.doc && doc.cutoff !== null)
  )
    throw new Error(`Incomplete command control: ${JSON.stringify(result)}`);
  if (mode === "arrayResult" && (!Array.isArray(actual) || actual.length !== 3))
    throw new Error("Actual command array was not retained");
  if (
    mode === "objectResult" &&
    (!record(actual) ||
      !Array.isArray(actual.args) ||
      !actual.args.every(
        (arg, index) =>
          typeof arg === "string" &&
          new URL(arg).pathname + new URL(arg).search === fixtureArgs[index],
      ))
  )
    throw new Error(`URL arguments were not resolved: ${JSON.stringify(actual)}`);
  if (mode === "snapshotResult" && (!record(actual) || actual.calls !== 1 || actual.early !== 1))
    throw new Error(`Command result was serialized more than once: ${JSON.stringify(actual)}`);
}
export async function commandControl(
  engine: keyof typeof engines,
  mode: string,
  root: string,
): Promise<void> {
  const adapter = fixtureAdapter(mode);
  const result = await runPageSuite(adapter, (scratch) => new PlaywrightDriver(engine, scratch), {
    resultPath: join(root, `command-${mode}.json`),
    scratchRoot: process.env.STORAGE_SCRATCH_ROOT,
    budgets: { hello: 8000, heartbeat: 3000, case: 5000, group: 10_000, run: 45_000 },
  });
  const success = ["objectResult", "arrayResult", "snapshotResult"].includes(mode);
  const listFailure = mode === "missing-export" || mode === "import-failure";
  checkedResult(result, success ? 0 : listFailure ? 2 : 1);
  if (success) {
    checkedSuccess(result, mode);
    return;
  }
  if (listFailure) {
    if (
      !result.failures.some(
        (failure) => failure.group === "list" && failure.category === "page-error",
      )
    )
      throw new Error(
        `Export discovery failed outside the list document: ${JSON.stringify(result)}`,
      );
    return;
  }
  const outcome = Object.values(result.outcomes)[0];
  if (outcome?.status !== "fail" || !result.runComplete || result.failures.length)
    throw new Error(`Body failure was not acknowledged and finished: ${JSON.stringify(result)}`);
  if (mode === "throwingBody" && !outcome.detail.includes("ACTUAL_COMMAND_BODY_FAILURE"))
    throw new Error("Original command assertion was lost");
  if (mode === "wrongResult" && !record(Object.values(result.results)[0]))
    throw new Error("Host assertion discarded actual result");
}
export async function storagePageLabelControl(
  engine: keyof typeof engines,
  label: "wrong" | "missing",
  root: string,
): Promise<void> {
  const worker = await Bun.build({
    entrypoints: [join(import.meta.dir, "storage-page-control-worker.ts")],
    target: "browser",
    define: { STORAGE_PAGE_LABEL: JSON.stringify(label) },
  });
  if (!worker.success || !worker.outputs[0])
    throw new AggregateError(worker.logs, "Worker bundle failed");
  const result = await runStorage((scratch) => new PlaywrightDriver(engine, scratch), {
    resultPath: join(root, `production-storage-${label}-label.json`),
    scratchRoot: process.env.STORAGE_SCRATCH_ROOT,
    filter: "IndexedDB persists format",
    assets: {
      "/page.js": await browserBundle(join(import.meta.dir, "storage-page.ts")),
      "/worker.js": worker.outputs[0],
    },
  });
  const outcome = result.outcomes[result.selected[0] ?? ""];
  if (
    result.exit !== 4 ||
    !result.runComplete ||
    result.failures.length ||
    outcome?.status !== "fail" ||
    !outcome.detail.includes("Wrong Worker label") ||
    Object.values(result.cleanup).some((step) => record(step) && step.status === "unconfirmed")
  )
    throw new Error(`Production storage page lost ${label} label check: ${JSON.stringify(result)}`);
}
