import { join } from "node:path";
import {
  runPageSuite,
  ownedDatabase,
  type HostCase,
  type SuiteAdapter,
} from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { record } from "./protocol.js";

export const hostStorageControlModes = [
  "pass",
  "ordinary",
  "delayed",
  "recovered",
  "exhausted",
  "late",
  "policy",
  "live",
  "blocked",
  "slot",
];
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function noConstruction(host: HostCase): Promise<void> {
  const actual = await host.script(
    "const s=window.__storageControl; return {constructors:s.constructors,workers:s.workers,opens:s.opens};",
  );
  check(
    record(actual) &&
      actual.constructors === 0 &&
      actual.workers === 0 &&
      Array.isArray(actual.opens) &&
      actual.opens.length === 0,
    "Constructor or worker-side open before allocation returned",
  );
}
async function rejectedReceiver(host: HostCase, source: string): Promise<void> {
  const result = await host.script(
    `try { ${source}; return false; } catch (error) { return String(error).includes('Duplicate or out-of-phase task'); }`,
  );
  check(result === true, "Receiver admitted overlapping or duplicate operation");
}
async function waitingAllocation(host: HostCase, mode: string): Promise<string> {
  // Capture the real registered operation, not a fabricated completion or report.
  await host.script(`const receiver=window.__hostCase, allocate=receiver.allocateDatabase.bind(receiver), task=receiver.task.bind(receiver);
receiver.allocateDatabase=(operation,name)=>{allocate(operation,name); window.__storageControl.operation=operation;};
receiver.task=(operation,source)=>{task(operation,source); window.__storageControl.operation=operation;};`);
  const allocation = host.allocateDatabase("host-storage");
  let settled = false;
  void allocation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    while (!(await host.script("return window.__storageControl.allocationSeen;")))
      await host.sleep(10);
    await noConstruction(host);
    check(!settled, "Host returned before actual allocation ACK");
    if (mode === "slot") {
      await rejectedReceiver(
        host,
        "window.__hostCase.task('overlap-task', 'throw new Error(\"MUST_NOT_RUN\")')",
      );
      await rejectedReceiver(
        host,
        "window.__hostCase.allocateDatabase('overlap-allocation', 'waffle-workspace')",
      );
    }
    await host.script("window.__storageControl.release();");
    const name = await allocation;
    await rejectedReceiver(
      host,
      "window.__hostCase.allocateDatabase(window.__storageControl.operation, 'waffle-workspace')",
    );
    await rejectedReceiver(
      host,
      "window.__hostCase.task(window.__storageControl.operation, 'throw new Error(\"MUST_NOT_RUN\")')",
    );
    return name;
  } finally {
    // The registered promise remains owned even if an observer assertion fails.
    void allocation.catch(() => {});
  }
}
async function ordinarySlot(host: HostCase): Promise<void> {
  const task = host.task(
    "await new Promise(resolve => { window.__storageControl.release = resolve; });",
  );
  try {
    await host.sleep(30);
    await rejectedReceiver(
      host,
      "window.__hostCase.allocateDatabase('ordinary-overlap', 'waffle-workspace')",
    );
    await host.script("window.__storageControl.release();");
    await task;
    await rejectedReceiver(
      host,
      "window.__hostCase.allocateDatabase(window.__storageControl.operation, 'waffle-workspace')",
    );
  } finally {
    void task.catch(() => {});
  }
}
async function drive(host: HostCase, mode: string): Promise<unknown> {
  const name = ["delayed", "slot"].includes(mode)
    ? await waitingAllocation(host, mode)
    : await host.allocateDatabase("host-storage");
  await host.script(
    "window.__storageControl.returned = true; window.__storageControl.returnedAt=performance.timeOrigin+performance.now();",
  );
  if (mode === "slot") await ordinarySlot(host);
  if (mode === "live") await host.task("await new Promise(() => {});");
  await host.task(`await window.__storageControl.exercise(${JSON.stringify(name)});`);
  const reused = await host.allocateDatabase("host-storage");
  check(reused === name, "Allocation changed exact name");
  await host.task(`await window.__storageControl.exercise(${JSON.stringify(reused)});`);
  const actual = await host.script(
    "const s=window.__storageControl; return {constructors:s.constructors,workers:s.workers,opens:s.opens,attempts:s.attempts};",
  );
  check(
    record(actual) && actual.constructors === 2 && actual.workers === 2,
    "FAST constructors missing",
  );
  check(
    record(actual) &&
      Array.isArray(actual.opens) &&
      actual.opens.length >= 2 &&
      actual.opens.every((entry) => entry === name),
    "Actual worker open not observed",
  );
  if (mode === "recovered")
    check(actual.attempts === 3, "Lost allocation ACK did not retry identically");
  if (mode === "ordinary") throw new Error("ORIGINAL_STORAGE_ASSERTION");
  return actual;
}
class StorageDriver extends PlaywrightDriver {
  observation: unknown;
  admissionRejected = false;
  terminalRejected = false;
  override async script(source: string, signal: AbortSignal): Promise<unknown> {
    if (!this.admissionRejected && source.includes("Host receiver admission repeated")) {
      const rejected = await super.script(
        "try { window.__hostCase.allocateDatabase('before-admission', 'waffle-workspace'); return false; } catch(error) { return String(error).includes('Duplicate or out-of-phase task'); }",
        signal,
      );
      check(rejected === true, "Receiver allocated before host admission");
      this.admissionRejected = true;
    }
    if (source.includes("r.retired = true")) {
      const rejected = await super.script(
        "if (window.__suiteConfiguration.role !== 'case') return null; try { window.__hostCase.allocateDatabase('after-case', 'waffle-workspace'); return false; } catch(error) { return String(error).includes('Duplicate or out-of-phase task'); }",
        signal,
      );
      if (rejected !== null) {
        check(rejected === true, "Receiver allocated after case revocation");
        this.terminalRejected = true;
      }
    }
    return super.script(source, signal);
  }
  private stoppingStorage: ReturnType<PlaywrightDriver["stop"]> | undefined;
  override stop(): ReturnType<PlaywrightDriver["stop"]> {
    return (this.stoppingStorage ??= this.observeAndStop());
  }
  private async observeAndStop(): ReturnType<PlaywrightDriver["stop"]> {
    try {
      this.observation = await this.script(
        "return window.__storageControl.snapshot();",
        AbortSignal.timeout(3000),
      );
    } catch (error) {
      this.observation = { error: String(error) };
    }
    return super.stop();
  }
}
export async function hostStorageControl(
  engine: "chromium" | "webkit",
  mode: string,
  root: string,
): Promise<void> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "host-storage-control-page.ts"),
      join(import.meta.dir, "host-storage-control-worker.ts"),
    ],
    target: "browser",
    define: { HOST_STORAGE_CONTROL: JSON.stringify(mode) },
  });
  if (!built.success) throw new AggregateError(built.logs, "Storage host control bundle");
  const page = built.outputs.find((output) => output.path.endsWith("host-storage-control-page.js"));
  const worker = built.outputs.find((output) =>
    output.path.endsWith("host-storage-control-worker.js"),
  );
  if (!page || !worker) throw new Error("Missing storage host bundles");
  const infra = ["exhausted", "late", "policy", "live", "blocked"].includes(mode);
  const adapter: SuiteAdapter<{ mode: string }> = {
    suite: "host-storage-control",
    inventory: () => [
      {
        id: "storage",
        label: "storage",
        request: () => ({ mode }),
        drive: (host) => drive(host, mode),
      },
    ],
    policy: {
      listIds: () => ["storage"],
      requireResult: true,
      allocation: ownedDatabase(mode === "policy" ? "not-host-storage" : "host-storage"),
      check() {},
    },
    assets: async () => ({ "/page.js": page, "/storage-worker.js": worker }),
    budgets: () => ({
      hello: 4000,
      heartbeat: 2000,
      case: ["late", "live"].includes(mode) ? 200 : 15_000,
      teardown: 2000,
      caseDocument: 25_000,
      group: 5000,
      run: 45_000,
    }),
  };
  let driver: StorageDriver | undefined;
  const result = await runPageSuite(
    adapter,
    (scratch) => (driver = new StorageDriver(engine, scratch)),
    {
      resultPath: join(root, `host-storage-${mode}.json`),
      scratchRoot: process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp",
    },
  );
  checkStorageResult(result, driver, mode, infra);
}
function checkStorageResult(
  result: Awaited<ReturnType<typeof runPageSuite>>,
  driver: StorageDriver | undefined,
  mode: string,
  infra: boolean,
): void {
  check(
    result.exit === (infra ? 2 : mode === "ordinary" ? 1 : 0),
    `Storage ${mode} wrong exit: ${JSON.stringify(result)}`,
  );
  check(result.ledger.length === (mode === "policy" ? 0 : 1), "Incorrect accepted ledger");
  check(driver?.admissionRejected, "Actual pre-admission receiver guard was not exercised");
  if (!infra) check(driver.terminalRejected, "Actual terminal receiver guard was not exercised");
  const observed = driver.observation;
  check(
    record(observed) && observed.sentinelsChecked === 2,
    `Sentinel contents were not verified: ${JSON.stringify(observed)}`,
  );
  if (["exhausted", "late", "policy", "live"].includes(mode)) {
    check(
      observed.constructors === 0 &&
        observed.workers === 0 &&
        Array.isArray(observed.opens) &&
        observed.opens.length === 0,
      "Failed allocation or live task permitted construction/open",
    );
    if (mode !== "late") check(!result.runComplete, "Still-live operation reached finish");
  }
  if (mode === "exhausted" || mode === "policy") {
    check(
      observed.taskEnds === 0 &&
        record(observed.reporter) &&
        (!!observed.reporter.failure ||
          (mode === "policy" &&
            typeof observed.reporter.pending === "number" &&
            observed.reporter.pending > 0)),
      "Poisoned reporter was fabricated as settled",
    );
  }
  if (["late", "live", "exhausted", "policy"].includes(mode))
    check(
      result.failures.some((failure) => failure.category === "page-task-unconfirmed"),
      "Lost sticky pending-task failure",
    );
  if (!infra) {
    check(result.runComplete && result.failures.length === 0, "Exact cleanup failed");
    check(
      result.storageRemaining?.length === 0 && result.cleanup.storage.status === "confirmed",
      "Exact owned database deletion was not verified",
    );
  }
  if (mode === "ordinary")
    check(
      JSON.stringify(result.results).includes("ORIGINAL_STORAGE_ASSERTION"),
      "Primary failure erased",
    );
  if (mode === "blocked") {
    check(
      JSON.stringify(result.storageRemaining) === JSON.stringify(result.ledger),
      "Blocked deletion lost the exact remaining entry",
    );
    check(
      result.failures.some((failure) => failure.category === "storage-cleanup"),
      "Blocked deletion did not fail",
    );
  }
  for (const key of ["session", "launcher", "server", "scratch"] as const)
    check(
      result.cleanup[key].status === "confirmed",
      `Control cleanup unconfirmed: ${JSON.stringify(result.cleanup)}`,
    );
}
