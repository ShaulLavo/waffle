import type { BunPlugin } from "bun";
import { join } from "node:path";
import { browserBundle, type engines } from "../browser-runner-lifecycle.js";
import { commandAdapter, commandPageBundle, type CommandRequest } from "./command-suites.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { runPageSuite, type SuiteAdapter, type SuiteResult } from "./suite-host.js";
import { record } from "./protocol.js";
import { runStorage } from "./storage-host.js";

const notificationControlModes = [
  "complete",
  "snapshot",
  "invalid-result",
  "mixed",
  "terminated",
  "revoked",
  "startupCancel",
  "releaseFailure",
  "sendFailure",
  "relayStopFailure",
  "relayArmFailure",
  "startupReject",
] as const;
type NotificationControl = (typeof notificationControlModes)[number];

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
].concat(notificationControlModes.map((mode) => `notification-${mode}`));
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
  const notificationMode = notificationControlModes.find(
    (entry) => mode === `notification-${entry}`,
  );
  if (notificationMode) return notificationControl(engine, notificationMode, root);
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

function notificationFailure(mode: NotificationControl) {
  if (mode === "mixed")
    return {
      path: "fixtures/notification-mixed-worker.ts",
      old: 'check(set.covered, "common pipe must be covered");',
      replacement: 'check(false, "common pipe must be covered");',
      message: "common pipe must be covered",
    };
  if (["terminated", "revoked", "relayStopFailure"].includes(mode))
    return {
      path: "notification-lifetime-cases.ts",
      old: 'check(hostCleanups === 1, "host cleanup did not run exactly once after physical stop");',
      replacement: `check(hostCleanups === (${mode === "revoked" ? "revoke" : mode === "relayStopFailure" ? "relayFailure" : "!revoke && !relayFailure"} ? 2 : 1), "host cleanup did not run exactly once after physical stop");`,
      message: "host cleanup did not run exactly once after physical stop",
    };
  if (["startupCancel", "relayArmFailure", "startupReject"].includes(mode))
    return {
      path: "notification-lifetime-cases.ts",
      old: 'check(Atomics.load(marker, 0) === 0, "cancelled/rejected startup entered guest");',
      replacement: `check(Atomics.load(marker, 0) === (mode === "${mode === "startupCancel" ? "arm" : mode === "relayArmFailure" ? "relay" : "reject"}" ? 1 : 0), "cancelled/rejected startup entered guest");`,
      message: "cancelled/rejected startup entered guest",
    };
  if (mode === "releaseFailure" || mode === "sendFailure")
    return {
      path: "notification-lifetime-cases.ts",
      old: 'check(network.releases === 1, "scope release was repeated");',
      replacement: `check(network.releases === (${mode === "sendFailure" ? "detachPort" : "!detachPort"} ? 2 : 1), "scope release was repeated");`,
      message: "scope release was repeated",
    };
  return null;
}
function notificationAssertionPlugin(
  source: string,
  content: string,
  failure: { old: string; replacement: string },
): BunPlugin {
  return {
    name: "notification-original-assertion",
    setup(build) {
      build.onLoad({ filter: /notification-(?:mixed-worker|lifetime-cases)\.ts$/ }, (args) =>
        args.path === source
          ? { contents: content.replace(failure.old, failure.replacement), loader: "ts" }
          : undefined,
      );
    },
  };
}
async function notificationAssets(mode: NotificationControl, scratch: string) {
  const assets = await commandAdapter("notification").assets({
    scratch,
    signal: AbortSignal.timeout(60_000),
  });
  const failure = notificationFailure(mode);
  if (failure) {
    const source = join(import.meta.dir, "..", failure.path);
    const content = await Bun.file(source).text();
    if (content.split(failure.old).length !== 2)
      throw new Error(`Notification assertion moved: ${mode}`);
    const built = await Bun.build({
      entrypoints: [source],
      target: "browser",
      plugins: [notificationAssertionPlugin(source, content, failure)],
    });
    if (!built.success || !built.outputs[0])
      throw new AggregateError(built.logs, `Notification control ${mode}`);
    assets[mode === "mixed" ? "/guest.js" : "/lifetime.js"] = built.outputs[0];
  }
  if (mode !== "snapshot" && mode !== "invalid-result") return assets;
  const original = assets["/notification.js"];
  if (!original) throw new Error("Missing original notification command asset");
  assets["/original-notification.js"] = original;
  assets["/notification.js"] =
    `import { notificationCommand as original } from "/original-notification.js";
export async function notificationCommand() {
  const actual = await original();
  ${
    mode === "invalid-result"
      ? "actual.startupReject.entries = 1;"
      : `let calls = 0;
  Object.defineProperty(actual, "toJSON", { value() {
    if (++calls !== 1) throw new Error("Notification result serialized twice");
    const copy = Object.fromEntries(Object.entries(actual));
    queueMicrotask(() => {
      for (const key of Object.keys(actual)) actual[key] = null;
      window.__notificationSnapshot = { calls, cleared: Object.values(actual).every(value => value === null) };
    });
    return copy;
  } });`
  }
  return actual;
}`;
  return assets;
}
async function notificationControl(
  engine: keyof typeof engines,
  mode: NotificationControl,
  root: string,
): Promise<void> {
  const adapter = commandAdapter("notification");
  let copiedBeforeRetirement = false;
  const resultPath = join(root, `notification-${engine}-${mode}.json`);
  const result = await runPageSuite(
    adapter,
    (scratch) => {
      const driver = new PlaywrightDriver(engine, scratch);
      if (mode === "snapshot")
        observeNotificationSnapshot(driver, () => {
          copiedBeforeRetirement = true;
        });
      return driver;
    },
    {
      resultPath,
      scratchRoot: process.env.STORAGE_SCRATCH_ROOT,
      assets: await notificationAssets(mode, root),
    },
  );
  const passed = mode === "complete" || mode === "snapshot";
  checkedResult(result, passed ? 0 : 1);
  checkedSuccess(result, mode);
  if (JSON.stringify(await Bun.file(resultPath).json()) !== JSON.stringify(result))
    throw new Error("Actual notification result was not retained in the result file");
  const id = "notification: notificationCommand";
  const actual = result.results[id];
  const outcome = result.outcomes[id];
  if (
    result.suite !== "notification" ||
    JSON.stringify(result.required) !== JSON.stringify([id]) ||
    JSON.stringify(result.selected) !== JSON.stringify([id])
  )
    throw new Error("Notification control did not select the whole original command");
  if (result.failures.length || outcome?.status !== (passed ? "pass" : "fail"))
    throw new Error(`Notification ${mode} did not reach its original command outcome`);
  if (passed) adapter.policy.check?.(id, actual);
  if (mode === "snapshot" && !copiedBeforeRetirement)
    throw new Error("Notification result was not copied before document teardown");
  const failure = notificationFailure(mode);
  if (failure && (outcome?.status !== "fail" || !outcome.detail.includes(failure.message)))
    throw new Error(`Original notification assertion was lost for ${mode}`);
  if (
    mode === "invalid-result" &&
    (!record(actual) || !record(actual.startupReject) || actual.startupReject.entries !== 1)
  )
    throw new Error("The failed actual notification result was discarded");
  console.log(
    JSON.stringify({
      engine,
      control: `notification-${mode}`,
      exit: result.exit,
      copiedBeforeRetirement: mode === "snapshot" ? copiedBeforeRetirement : null,
      retainedScenarios: record(actual) ? Object.keys(actual) : [],
      cleanup: result.cleanup,
    }),
  );
}

function observeNotificationSnapshot(driver: PlaywrightDriver, copied: () => void): void {
  const script = driver.script.bind(driver);
  driver.script = async (source, signal) => {
    if (!source.includes("r.retired = true")) return script(source, signal);
    const observed = await script("return window.__notificationSnapshot || null", signal);
    if (record(observed) && observed.calls === 1 && observed.cleared === true) copied();
    return script(source, signal);
  };
}
