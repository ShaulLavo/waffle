import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { browserBundle, engines } from "../browser-runner-lifecycle.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { record, strings } from "./protocol.js";
import { runPageSuite, type SuiteAdapter, type SuiteResult } from "./suite-host.js";
import { rootContinuityAdapter, rootContinuityIds } from "./root-continuity-suite.js";
import { rootContinuityOpenPaths, type RootContinuityRequest } from "../root-continuity-command.js";

async function rootContinuityGateControl(engine: keyof typeof engines, resultPath: string) {
  const id = "root-continuity-allocation";
  const adapter: SuiteAdapter<{ run: string }> = {
    suite: id,
    inventory: () => [{ id, label: id, request: (run) => ({ run }) }],
    policy: {
      requireResult: true,
      listIds(value) {
        if (!record(value) || !strings(value.ids)) throw new Error("Wrong gate inventory");
        return value.ids;
      },
      check(_id, result) {
        const expected = rootContinuityOpenPaths.flatMap(({ control, target }) => [
          `${control}:${target}:rejected`,
          `${control}:${target}:late`,
        ]);
        if (!strings(result) || JSON.stringify(result) !== JSON.stringify(expected))
          throw new Error("Missing constructor prevention observations");
      },
      allocation(entry, running, run) {
        const names = rootContinuityOpenPaths.flatMap(({ control, target }) => [
          `root-continuity-${control}-${run}-${target}-rejected`,
          `root-continuity-${control}-${run}-${target}-late`,
        ]);
        if (
          running.length !== 1 ||
          running[0] !== id ||
          entry.kind !== "indexeddb" ||
          !names.includes(entry.name)
        )
          throw new Error("Gate allocation is not an exact run-owned database");
      },
    },
    async assets() {
      return {
        "/page.js": await browserBundle(resolve(import.meta.dir, "root-continuity-gate-page.ts")),
      };
    },
    budgets: () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: 150_000,
      group: 150_000,
      run: 150_000,
    }),
  };
  const result = await runPageSuite(adapter, (scratch) => new PlaywrightDriver(engine, scratch), {
    resultPath,
    scratchRoot: tmpdir(),
  });
  checkedCleanup(result);
  if (result.exit !== 0 || result.ledger.length !== 10 || result.storageRemaining?.length !== 0)
    throw new Error(`Root continuity gate control failed: ${JSON.stringify(result)}`);
  return result;
}

function checkedCleanup(result: SuiteResult): void {
  const { session, launcher, server, storage, scratch } = result.cleanup;
  if ([session, launcher, server, storage, scratch].some((step) => step.status !== "confirmed"))
    throw new Error(`Root continuity cleanup incomplete: ${JSON.stringify(result.cleanup)}`);
}
function checkedComplete(result: SuiteResult): void {
  checkedCleanup(result);
  if (
    result.exit !== 0 ||
    result.omitted.length ||
    !result.runComplete ||
    JSON.stringify(result.required) !== JSON.stringify(rootContinuityIds) ||
    JSON.stringify(result.selected) !== JSON.stringify(rootContinuityIds) ||
    result.documents.length !== 5 ||
    result.documents.some((doc) => !doc.doc || doc.cutoff === null) ||
    result.ledger.length !== 3 ||
    result.storageRemaining?.length !== 0
  )
    throw new Error(`Incomplete root continuity command: ${JSON.stringify(result)}`);
  const selected = result.results[rootContinuityIds[0]!];
  if (!record(selected) || !record(selected.ledger) || typeof selected.ledger.changed !== "string")
    throw new Error("Actual bigint evidence was not serialized to a string");
}

class UnrelatedStorageDriver extends PlaywrightDriver {
  private readonly unrelated = `unrelated-root-continuity-${crypto.randomUUID()}`;
  survived = false;
  private seeded = false;
  override async navigate(url: string, signal: AbortSignal): Promise<void> {
    await super.navigate(url, signal);
    if (this.seeded) return;
    this.seeded = true;
    await this.script(
      `return new Promise((resolve, reject) => {
      const request = indexedDB.open(${JSON.stringify(this.unrelated)});
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(true); };
    })`,
      signal,
    );
  }
  override async stop() {
    try {
      if (this.seeded && !this.uncertain) {
        const evidence = await this.script(
          `return indexedDB.databases().then(databases => {
          const names = databases.map(database => database.name);
          return { survived: names.includes(${JSON.stringify(this.unrelated)}),
            owned: names.filter(name => name?.startsWith("root-continuity-")) };
        })`,
          AbortSignal.timeout(3000),
        );
        this.survived =
          record(evidence) &&
          evidence.survived === true &&
          Array.isArray(evidence.owned) &&
          evidence.owned.length === 0;
        await this.script(
          `return new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(${JSON.stringify(this.unrelated)});
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error("Unrelated control database still open"));
          request.onsuccess = () => resolve(true);
        })`,
          AbortSignal.timeout(3000),
        );
      }
    } finally {
      await super.stop();
    }
    return super.stop();
  }
}

async function failureAssets(
  mode: string,
  context: Parameters<typeof rootContinuityAdapter.assets>[0],
) {
  const assets = await rootContinuityAdapter.assets(context);
  if (mode === "import-failure") {
    delete assets["/composition.js"];
    return assets;
  }
  if (mode === "missing-export") {
    assets["/composition.js"] = "export {};";
    return assets;
  }
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "root-continuity-control-fixture.ts")],
    target: "browser",
    define: { ROOT_CONTINUITY_FAILURE: JSON.stringify(mode) },
  });
  if (!built.success || !built.outputs[0])
    throw new AggregateError(built.logs, "Control build failed");
  assets["/composition.js"] = built.outputs[0];
  return assets;
}
async function commandControl(
  engine: keyof typeof engines,
  mode: string,
  root: string,
): Promise<void> {
  const adapter: SuiteAdapter<RootContinuityRequest> =
    mode === "complete"
      ? rootContinuityAdapter
      : {
          ...rootContinuityAdapter,
          assets: (context) => failureAssets(mode, context),
        };
  let driver: UnrelatedStorageDriver | undefined;
  const result = await runPageSuite(
    adapter,
    (scratch) => {
      driver = new UnrelatedStorageDriver(engine, scratch);
      return driver;
    },
    { resultPath: join(root, `${engine}-${mode}.json`), scratchRoot: tmpdir() },
  );
  checkedCleanup(result);
  if (!driver?.survived)
    throw new Error("Exact cleanup deleted unrelated storage or left owned databases");
  console.log(JSON.stringify({ control: mode, unrelatedSurvived: driver.survived }));
  if (mode === "complete") return checkedComplete(result);
  const discovery = mode === "missing-export" || mode === "import-failure";
  if (result.exit !== (discovery ? 2 : 1) || !result.runComplete || result.omitted.length)
    throw new Error(`Wrong command failure disposition: ${JSON.stringify(result)}`);
  if (discovery) {
    if (
      !result.failures.some(
        (failure) => failure.group === "list" && failure.category === "page-error",
      ) ||
      result.documents.some((doc) => rootContinuityIds.includes(doc.group))
    )
      throw new Error("Discovery did not fail before case dispatch");
    return;
  }
  if (
    result.failures.length ||
    rootContinuityIds.some((id) => result.outcomes[id]?.status !== "fail")
  )
    throw new Error("Body failure was not retained for every required control");
  if (
    mode === "throwing-body" &&
    Object.values(result.outcomes).some(
      (outcome) =>
        outcome.status !== "fail" || !outcome.detail.includes("ROOT_CONTINUITY_BODY_FAILURE"),
    )
  )
    throw new Error("Original body error was lost");
  if (mode === "wrong-evidence" && Object.keys(result.results).length !== 3)
    throw new Error("Wrong actual returned evidence was discarded");
}
export async function runRootContinuityControls(engine: string): Promise<void> {
  if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit")
    throw new Error(`Unknown root continuity control engine: ${engine}`);
  const retained = process.env.ROOT_CONTINUITY_RESULT_ROOT;
  const root = retained ?? (await mkdtemp(join(tmpdir(), "rc-results-")));
  try {
    await rootContinuityGateControl(engine, join(root, `${engine}-allocation.json`));
    for (const mode of [
      "complete",
      "throwing-body",
      "wrong-evidence",
      "missing-export",
      "import-failure",
    ])
      await commandControl(engine, mode, root);
  } finally {
    if (!retained) await rm(root, { recursive: true, force: true });
  }
}
