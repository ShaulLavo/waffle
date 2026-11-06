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
type ControlResult = { engine: string; control: string; status: string; error?: string };
async function checkControl(
  engine: string,
  control: string,
  run: () => Promise<void>,
  results: ControlResult[],
): Promise<void> {
  try {
    await run();
    results.push({ engine, control, status: "pass" });
  } catch (error) {
    results.push({ engine, control, status: "fail", error: String(error) });
  }
  console.log(JSON.stringify(results[results.length - 1]));
}
async function engineControls(
  engine: string,
  root: string,
  results: ControlResult[],
): Promise<void> {
  if (engine !== "chromium" && engine !== "webkit")
    throw new Error(`Unsupported control engine ${engine}`);
  const selected = process.env.PAGE_RUNNER_CONTROL_FILTER;
  for (const mode of modes.filter((mode) => !selected || mode.includes(selected)))
    await checkControl(engine, mode, () => reporterControl(engine, mode, root), results);
  for (const mode of commandControlModes.filter(
    (mode) => !selected || `command-${mode}`.includes(selected),
  ))
    await checkControl(
      engine,
      `command-${mode}`,
      () => commandControl(engine, mode, root),
      results,
    );
  for (const mode of consumerControlModes.filter(
    (mode) => !selected || `consumer-${mode}`.includes(selected),
  ))
    await checkControl(
      engine,
      `consumer-${mode}`,
      () => consumerControl(engine, mode, root),
      results,
    );
  for (const mode of hostControlModes.filter(
    (mode) => !selected || `host-${mode}`.includes(selected),
  ))
    await checkControl(engine, `host-${mode}`, () => hostControl(engine, mode, root), results);
  for (const label of ["wrong", "missing"] as const) {
    const name = `production-storage-${label}-label`;
    if (!selected || name.includes(selected))
      await checkControl(engine, name, () => storagePageLabelControl(engine, label, root), results);
  }

  if (!selected || "canonical-ownership".includes(selected))
    await checkControl(
      engine,
      "canonical-ownership",
      () => malformedAllocationControl(engine, root),
      results,
    );
  for (const failed of selected ? [] : [false, true])
    await checkControl(
      engine,
      `storage-${failed}`,
      () => storageControl(engine, failed, root),
      results,
    );
}
async function main(): Promise<void> {
  const args = process.argv.slice(2),
    resultIndex = args.indexOf("--result"),
    resultPath = resultIndex < 0 ? undefined : args[resultIndex + 1];
  if (resultIndex >= 0 && (!resultPath || !isAbsolute(resultPath)))
    throw new Error("Use chromium webkit --result /absolute/control-results.json");
  const results: ControlResult[] = [];
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "pr-results-"));
  await mkdir(root, { recursive: true });
  try {
    for (const engine of resultIndex < 0 ? args : args.slice(0, resultIndex))
      await engineControls(engine, root, results);
  } finally {
    await writeResult(resultPath ?? join(root, "results.json"), results);
    await rm(root, { recursive: true, force: true });
  }
  if (!results.length || results.some((result) => result.status === "fail")) process.exitCode = 1;
}
if (import.meta.main) await main();
