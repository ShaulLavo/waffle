import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { Collector } from "./collector.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { runStorage, serveCollector, retireDocument, writeResult } from "./storage-host.js";
import { storageBudgets } from "./protocol.js";
import { bounded } from "./driver.js";
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
    filter: "IndexedDB persists format",
    assets: { "/page.js": page, "/worker.js": `(${hangWorker.toString()})();` },
    budgets: workerTimeout
      ? { ...storageBudgets, run: 120_000 }
      : { hello: 4000, heartbeat: 1800, case: 3000, group: 5000, run: 25_000 },
  });
  const outcome = Object.values(result.outcomes).find((entry) => entry.status !== "pending");
  if (mode === "pass" && result.exit !== 4)
    throw new Error(`Expected filtered control, got ${JSON.stringify(result.failures)}`);
  if (mode === "wrong-label" || workerTimeout) {
    const expected = workerTimeout ? "storage case worker timed out" : "Wrong Worker label";
    if (outcome?.status !== "fail" || !outcome.detail.includes(expected) || result.failures.length)
      throw new Error(`${mode}: wrong Worker failure classification ${JSON.stringify(result)}`);
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
  const collector = new Collector(run, ids, ids);
  const page = await fixtureBundle("storage-control-page.ts", {
    PAGE_RUNNER_STORAGE_FAILURE: String(failed),
  });
  const fixture = serveCollector(collector, {
    "/page.js": page,
    "/control-worker.js": await browserBundle(join(import.meta.dir, "storage-control-worker.ts")),
  });
  const scratch = await mkdtemp("/work/tmp/prb-");
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
async function waitFor(done: () => boolean, collector: Collector): Promise<void> {
  while (!done()) {
    if (collector.failures.length) throw new Error(JSON.stringify(collector.failures));
    await Bun.sleep(25);
  }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2),
    resultIndex = args.indexOf("--result"),
    resultPath = args[resultIndex + 1];
  if (resultIndex < 0 || !resultPath || !isAbsolute(resultPath))
    throw new Error("Use chromium webkit --result /absolute/control-results.json");
  const results: { engine: string; control: string; status: string; error?: string }[] = [];
  const root = await mkdtemp("/work/tmp/pr-results-");
  await mkdir(root, { recursive: true });
  try {
    for (const engine of args.slice(0, resultIndex)) {
      if (engine !== "chromium" && engine !== "webkit")
        throw new Error(`Unsupported control engine ${engine}`);
      for (const mode of modes)
        await check(engine, mode, () => reporterControl(engine, mode, root));
      for (const failed of [false, true])
        await check(engine, `storage-${failed}`, () => storageControl(engine, failed, root));
    }
    async function check(engine: string, control: string, run: () => Promise<void>): Promise<void> {
      try {
        await run();
        results.push({ engine, control, status: "pass" });
      } catch (error) {
        results.push({ engine, control, status: "fail", error: String(error) });
      }
      console.log(JSON.stringify(results[results.length - 1]));
    }
  } finally {
    await writeResult(resultPath, results);
    await rm(root, { recursive: true, force: true });
  }
  if (results.some((result) => result.status === "fail")) process.exitCode = 1;
}
if (import.meta.main) await main();
