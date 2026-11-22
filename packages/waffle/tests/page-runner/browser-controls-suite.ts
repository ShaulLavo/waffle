import { keyPressControl } from "./key-press-controls.js";
import { ControlRun } from "./control-run.js";
import { fixtureCapabilityControl, fixtureControlModes } from "./fixture-capability-controls.js";
import {
  webKitWorkerVerificationModes,
  workerCapabilityControl,
  workerControlModes,
} from "./worker-capability-controls.js";
import { retainedWorkerControl, retainedWorkerControlModes } from "./retained-worker-controls.js";
import { peerControl, peerControlModes } from "./peer-controls.js";
import { buildFrameworkBootstrap } from "../../build.js";
import { frameworkDOMControl, frameworkControlModes } from "./framework-dom-controls.js";
import { hostStorageControl, hostStorageControlModes } from "./host-storage-controls.js";
import { hostControl, hostControlModes } from "./host-drive-controls.js";
import { consumerControl, consumerControlModes } from "./consumer-controls.js";
import { storagePolicy } from "./storage-policy.js";
import {
  commandControl,
  commandControlModes,
  storagePageLabelControl,
} from "./command-controls.js";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { Collector } from "./collector.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { runStorage } from "./storage-host.js";
import { serveCollector, retireDocument, writeResult } from "./suite-host.js";
import { storageBudgets } from "./protocol.js";
import { bounded } from "./driver.js";
import { storageWorker } from "./storage-worker.js";
import { withStorageCleanup } from "../storage-allocation.js";
import { browserBundle, engines } from "../browser-runner-lifecycle.js";
import { captureWebKitDiagnostics } from "../webkit-diagnostics.js";
function hangWorker(): void {
  globalThis.onmessage = () => {};
}
async function fixtureBundle(file: string, define: Record<string, string>): Promise<Blob> {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, file)],
    target: "browser",
    define,
  });
  if (!built.success || !built.outputs[0])
    throw new AggregateError(built.logs, "Control bundle failed");
  return built.outputs[0];
}
const modes = [
  "pass",
  "wrong-label",
  "pass-error",
  "duplicate-terminal",
  "end-before-start",
  "cross-group",
  "empty-complete",
  "reload",
  "list-error",
  "finish-error",
  "case-hang",
  "heartbeat-lost",
  "missing-completion",
  "final-ack-loss",
  "page-unresponsive",
  "worker-timeout",
  "aggregate-error",
];
async function reporterControl(
  engine: keyof typeof engines,
  mode: string,
  root: string,
): Promise<void> {
  const page = await fixtureBundle("reporter-control-page.ts", {
    PAGE_RUNNER_CONTROL: JSON.stringify(mode),
  });
  const workerTimeout = mode === "worker-timeout";
  const result = await runStorage((scratch) => new PlaywrightDriver(engine, scratch), {
    resultPath: join(root, `${mode}.json`),
    scratchRoot: process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(),
    filter: "IndexedDB persists format",
    assets: {
      "/page.js": page,
      "/worker.js": `(${(mode === "aggregate-error" ? storageWorker : hangWorker).toString()})();`,
      "/tests.js":
        mode === "aggregate-error"
          ? await browserBundle(join(import.meta.dir, "aggregate-error-fixture.ts"))
          : "",
    },
    budgets: workerTimeout
      ? { ...storageBudgets, run: 120_000 }
      : { hello: 4000, heartbeat: 1800, case: 3000, group: 5000, run: 25_000 },
  });
  const { session, launcher, server, scratch } = result.cleanup;
  if ([session, launcher, server, scratch].some((step) => step.status === "unconfirmed"))
    throw new Error(`Real control cleanup unconfirmed: ${JSON.stringify(result.cleanup)}`);
  const outcome = Object.values(result.outcomes).find((entry) => entry.status !== "pending");
  if (mode === "pass" && result.exit !== 4)
    throw new Error(`Expected filtered control, got ${JSON.stringify(result.failures)}`);
  if (mode === "wrong-label" || workerTimeout) {
    const expected = workerTimeout ? "storage case worker timed out" : "Wrong Worker label";
    if (outcome?.status !== "fail" || !outcome.detail.includes(expected) || result.failures.length)
      throw new Error(`${mode}: wrong Worker failure classification ${JSON.stringify(result)}`);
    return;
  }
  if (mode === "aggregate-error") {
    if (
      outcome?.status !== "fail" ||
      !outcome.detail.includes("PRIMARY_ASSERTION") ||
      !outcome.detail.includes("CLEANUP_FAILURE") ||
      outcome.detail.indexOf("PRIMARY_ASSERTION") > outcome.detail.indexOf("CLEANUP_FAILURE")
    )
      throw new Error(`Aggregate Worker causes were lost: ${JSON.stringify(outcome)}`);
    return;
  }
  if (mode !== "pass" && result.exit !== 2)
    throw new Error(`${mode}: host control did not fail: ${result.exit}`);
  const classifications: Record<string, string> = {
    "case-hang": "case-hang",
    "heartbeat-lost": "report-lost",
    "missing-completion": "report-lost",
    "page-unresponsive": "page-unresponsive",
  };
  const expected = classifications[mode];
  if (expected && !result.failures.some((failure) => failure.category === expected))
    throw new Error(`${mode}: expected ${expected}, got ${JSON.stringify(result.failures)}`);
}
async function storageControl(
  engine: keyof typeof engines,
  failed: boolean,
  root: string,
): Promise<void> {
  const run = crypto.randomUUID(),
    ids = ["indexeddb: control", "opfs: control"];
  const collector = new Collector(run, ids, ids, storagePolicy);
  const page = await fixtureBundle("storage-control-page.ts", {
    PAGE_RUNNER_STORAGE_FAILURE: String(failed),
  });
  const fixture = serveCollector(collector, {
    "/page.js": page,
    "/control-worker.js": await browserBundle(join(import.meta.dir, "storage-control-worker.ts")),
  });
  const scratch = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "prb-"));
  const driver = new PlaywrightDriver(engine, scratch);
  await withStorageCleanup(
    async () => {
      const signal = AbortSignal.timeout(20_000);
      await driver.start(signal);
      const token = crypto.randomUUID(),
        url = `${fixture.origin}/?token=${token}`;
      const state = collector.expect(
        { id: "storage-control", role: "case", caseIds: ids },
        token,
        url,
        await driver.handle(signal),
      );
      fixture.configurations.set(token, { run, token, group: state.group.id });
      await driver.navigate(url, signal);
      await bounded(
        waitFor(() => state.complete, collector),
        10_000,
        "real storage control",
      );
      state.retiring = true;
      await bounded(
        waitFor(() => state.ready, collector),
        3000,
        "storage control retirement",
      );
      await retireDocument(state, collector, driver, signal);
      if (
        collector.failures.length ||
        collector.ledger.length !== 3 ||
        collector.outcomes[ids[0] ?? ""]?.status !== (failed ? "fail" : "pass")
      )
        throw new Error(`Storage control failed ${JSON.stringify(collector.failures)}`);
    },
    async () => {
      const cleanup = await driver.stop();
      await fixture.server.stop(true);
      if (cleanup.session.status === "confirmed" && cleanup.launcher.status === "confirmed")
        await rm(scratch, { recursive: true, force: true });
      else throw new Error(`Storage control retained ${scratch}: ${JSON.stringify(cleanup)}`);
    },
  );
  await Bun.write(
    join(root, `storage-${failed ? "failed" : "passed"}.json`),
    JSON.stringify({
      ledger: collector.ledger,
      outcomes: collector.outcomes,
      foreignPrefixSurvived: true,
    }),
  );
}
async function malformedAllocationControl(
  engine: keyof typeof engines,
  root: string,
): Promise<void> {
  const run = crypto.randomUUID(),
    id = "opfs: ownership";
  const collector = new Collector(run, [id], [id], storagePolicy);
  const fixture = serveCollector(collector, {
    "/page.js": "",
    "/cleanup.js": await browserBundle(join(import.meta.dir, "storage-cleanup.ts")),
  });
  const scratch = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "prb-"));
  const driver = new PlaywrightDriver(engine, scratch);
  const logical = `bun-wasm-opfs-test-${run}-foreign`;
  const name = `foreign!!${btoa(JSON.stringify(logical)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
  await withStorageCleanup(
    async () => {
      const signal = AbortSignal.timeout(20_000),
        token = crypto.randomUUID();
      const url = `${fixture.origin}/?token=${token}`;
      await driver.start(signal);
      collector.expect({ id, role: "case", caseIds: [id] }, token, url, "root");
      fixture.configurations.set(token, {});
      await driver.navigate(url, signal);
      await driver.script(
        `return navigator.storage.getDirectory().then(root => root.getDirectoryHandle(${JSON.stringify(name)}, {create:true})).then(() => null)`,
        signal,
      );
      collector.receive({ run, doc: "doc", seq: 0, kind: "hello", token, group: id });
      collector.receive({ run, doc: "doc", seq: 1, kind: "case-start", caseId: id });
      const response = await fetch(`${fixture.origin}/report`, {
        method: "POST",
        body: JSON.stringify({
          run,
          doc: "doc",
          seq: 2,
          kind: "allocation",
          entry: { kind: "opfs-directory", name },
        }),
      });
      if (response.status !== 409 || collector.ledger.length !== 0)
        throw new Error("Noncanonical OPFS cleanup authority accepted");
      const survived = await driver.script(
        `return (async () => {
      const {cleanupStorage} = await import('/cleanup.js');
      const remaining = await cleanupStorage(${JSON.stringify(collector.ledger)});
      const root = await navigator.storage.getDirectory();
      await root.getDirectoryHandle(${JSON.stringify(name)});
      await root.removeEntry(${JSON.stringify(name)}, {recursive:true});
      return remaining.length === 0;
    })()`,
        signal,
      );
      if (survived !== true)
        throw new Error("Malformed-allocation foreign directory did not survive cleanup");
      await Bun.write(
        join(root, "canonical-ownership.json"),
        JSON.stringify({ foreignSurvived: true, accepted: collector.ledger.length }),
      );
    },
    async () => {
      await withStorageCleanup(
        async () => {
          const cleanup = await driver.stop();
          if (cleanup.session.status !== "confirmed" || cleanup.launcher.status !== "confirmed")
            throw new Error(`Ownership control retained ${scratch}: ${JSON.stringify(cleanup)}`);
          await rm(scratch, { recursive: true, force: true });
        },
        async () => {
          await fixture.server.stop(true);
        },
      );
    },
  );
}
async function waitFor(done: () => boolean, collector: Collector): Promise<void> {
  while (!done()) {
    if (collector.failures.length) throw new Error(JSON.stringify(collector.failures));
    await Bun.sleep(25);
  }
}
type ControlResults = { path: string; run: ControlRun };
type ControlTask = { control: string; serialGroup?: string; run: () => Promise<void> };

const writeQueues = new WeakMap<ControlResults, Promise<void>>();
const slowControlPriority = new Map<string, number>(
  [
    "worker-timeout",
    "peer-storage",
    "retained-worker-no-handler",
    "retained-worker-terminated",
    "retained-worker-replay",
    "peer-inactive-heartbeat",
    "worker-capability-verification-slow-native-close",
    "host-storage-exhausted",
    "host-final-ack",
    "peer-ack-lost",
    "page-unresponsive",
    "fixture-capability-socket-idle",
    "missing-completion",
    "worker-capability-verification-navigation-held",
    "framework-final-ack-loss",
    "consumer-slow-seed",
  ].map((name, index) => [name, index]),
);

function controlConcurrency(engine: string): number {
  const configured = Number(process.env.PAGE_RUNNER_CONTROL_CONCURRENCY);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return engine === "webkit" ? 4 : 6;
}

function scheduleControls(tasks: readonly ControlTask[]): ControlTask[] {
  return tasks
    .map((task, index) => ({
      task,
      index,
      priority: slowControlPriority.get(task.control) ?? slowControlPriority.size,
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((entry) => entry.task);
}

async function runControlPool(
  engine: string,
  tasks: readonly ControlTask[],
  results: ControlResults,
): Promise<void> {
  if (!tasks.length) return;
  const pending = scheduleControls(tasks);
  const activeGroups = new Set<string>();
  const limit = Math.min(controlConcurrency(engine), pending.length);
  let fatal: { error: unknown } | undefined;
  let notify = Promise.withResolvers<void>();

  const claimTask = (): ControlTask | "wait" | undefined => {
    if (!pending.length) return undefined;
    const index = pending.findIndex(
      (task) => !task.serialGroup || !activeGroups.has(task.serialGroup),
    );
    if (index < 0) return "wait";
    const task = pending.splice(index, 1)[0]!;
    if (task.serialGroup) activeGroups.add(task.serialGroup);
    return task;
  };

  const wakeWaiters = (group: string | undefined) => {
    if (group) activeGroups.delete(group);
    notify.resolve();
    notify = Promise.withResolvers<void>();
  };

  const runClaimed = async (task: ControlTask) => {
    try {
      await checkControl(engine, task.control, task.run, results);
    } catch (error) {
      fatal ??= { error };
    } finally {
      wakeWaiters(task.serialGroup);
    }
  };

  const worker = async () => {
    while (!fatal) {
      results.run.throwIfInterrupted();
      const next = claimTask();
      if (next === undefined) return;
      if (next === "wait") {
        await notify.promise;
        continue;
      }
      await runClaimed(next);
    }
  };

  const settled = await Promise.allSettled(Array.from({ length: limit }, () => worker()));
  if (fatal) throw fatal.error;
  const rejected = settled.find((entry) => entry.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}

export async function checkControl(
  engine: string,
  control: string,
  run: () => Promise<void>,
  results: ControlResults,
): Promise<void> {
  await results.run.check(engine, control, run);
  const previous = writeQueues.get(results) ?? Promise.resolve();
  const snapshot = results.run.results.slice();
  const next = previous.catch(() => {}).then(() => writeResult(results.path, snapshot));
  writeQueues.set(results, next);
  await next;
}

function collectEngineControls(engine: string, root: string): ControlTask[] {
  const selected = process.env.PAGE_RUNNER_CONTROL_FILTER;
  if (engine === "firefox") {
    if (selected && selected !== "key-press")
      throw new Error("Firefox controls select key-press only");
    return [{ control: "key-press", run: () => keyPressControl(engine, root) }];
  }
  if (engine !== "chromium" && engine !== "webkit")
    throw new Error(`Unsupported control engine ${engine}`);
  const tasks: ControlTask[] = [];
  const add = (control: string, run: () => Promise<void>, serialGroup?: string) => {
    if (!selected || control.includes(selected)) tasks.push({ control, serialGroup, run });
  };
  if (engine === "chromium") add("key-press", () => keyPressControl(engine, root));
  for (const mode of fixtureControlModes)
    add(`fixture-capability-${mode}`, () => fixtureCapabilityControl(engine, mode, root));
  const workerModes =
    engine === "webkit"
      ? workerControlModes.concat(webKitWorkerVerificationModes)
      : workerControlModes;
  for (const mode of workerModes)
    add(`worker-capability-${mode}`, () => workerCapabilityControl(engine, mode, root));
  for (const mode of frameworkControlModes)
    add(`framework-${mode}`, () => frameworkDOMControl(engine, mode, root), "framework");
  for (const mode of modes) add(mode, () => reporterControl(engine, mode, root));
  for (const mode of commandControlModes)
    add(`command-${mode}`, () => commandControl(engine, mode, root));
  for (const mode of consumerControlModes)
    add(`consumer-${mode}`, () => consumerControl(engine, mode, root));
  for (const mode of retainedWorkerControlModes)
    add(mode, () => retainedWorkerControl(engine, mode, root));
  for (const mode of peerControlModes) add(mode, () => peerControl(engine, mode, root));
  for (const mode of hostControlModes) add(`host-${mode}`, () => hostControl(engine, mode, root));
  for (const mode of hostStorageControlModes)
    add(`host-storage-${mode}`, () => hostStorageControl(engine, mode, root));
  for (const label of ["wrong", "missing"] as const)
    add(`production-storage-${label}-label`, () => storagePageLabelControl(engine, label, root));
  add("canonical-ownership", () => malformedAllocationControl(engine, root));
  for (const failed of selected ? [] : [false, true])
    tasks.push({ control: `storage-${failed}`, run: () => storageControl(engine, failed, root) });
  return tasks;
}

async function engineControls(
  engine: string,
  root: string,
  results: ControlResults,
): Promise<void> {
  const tasks = collectEngineControls(engine, root);
  await runControlPool(engine, tasks, results);
}
async function runEngine(engine: string, root: string, results: ControlResults): Promise<void> {
  const engineRoot = join(root, engine);
  await mkdir(engineRoot, { recursive: true });
  const restore = engine === "webkit" ? captureWebKitDiagnostics() : undefined;
  try {
    await engineControls(engine, engineRoot, results);
  } finally {
    restore?.();
  }
}
async function main(controls: ControlRun): Promise<void> {
  controls.throwIfInterrupted();
  const args = process.argv.slice(2),
    resultIndex = args.indexOf("--result"),
    resultPath = resultIndex < 0 ? undefined : args[resultIndex + 1];
  if (resultIndex >= 0 && (!resultPath || !isAbsolute(resultPath)))
    throw new Error("Use chromium webkit --result /absolute/control-results.json");
  if (!resultPath) throw new Error("The controls supervisor must supply --result");
  const requested = args.slice(0, resultIndex);
  if (requested.length === 1 && requested[0] === "--prepare") {
    await buildFrameworkBootstrap();
    return;
  }
  const preparedIndex = requested.indexOf("--prepared");
  if (preparedIndex >= 0) requested.splice(preparedIndex, 1);
  const selected = process.env.PAGE_RUNNER_CONTROL_FILTER;
  const results: ControlResults = { path: resultPath, run: controls };
  let root: string | undefined;
  await withStorageCleanup(
    async () => {
      if (
        preparedIndex < 0 &&
        (!selected || frameworkControlModes.some((mode) => `framework-${mode}`.includes(selected)))
      )
        await buildFrameworkBootstrap();
      root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "pr-results-"));
      await mkdir(root, { recursive: true });
      for (const engine of requested) await runEngine(engine, root, results);
    },
    async () => {
      if (root) await rm(root, { recursive: true, force: true });
    },
  );
  if (!controls.results.length || controls.results.some((result) => result.status === "fail"))
    process.exitCode = 1;
}
if (import.meta.main) {
  const controls = new ControlRun();
  try {
    await main(controls);
    controls.throwIfInterrupted();
  } finally {
    controls.close();
  }
}
