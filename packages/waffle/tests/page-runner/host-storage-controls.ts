import { join } from "node:path";
import {
  runPageSuite,
  ownedDatabase,
  type HostCase,
  type SuiteAdapter,
} from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { record } from "./protocol.js";

export const hostStorageControlModes = ["pass"];
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function drive(host: HostCase): Promise<unknown> {
  const name = await host.allocateDatabase("host-storage");
  await host.script("window.__storageControl.returned = true;");
  await host.task(`await window.__storageControl.exercise(${JSON.stringify(name)});`);
  const reused = await host.allocateDatabase("host-storage");
  check(reused === name, "Allocation changed exact name");
  await host.task(`await window.__storageControl.exercise(${JSON.stringify(reused)});`);
  const actual = await host.script(
    "const s=window.__storageControl; return {constructors:s.constructors,opens:s.opens};",
  );
  check(record(actual) && actual.constructors === 2, "FAST constructors missing");
  check(
    record(actual) &&
      Array.isArray(actual.opens) &&
      actual.opens.length >= 2 &&
      actual.opens.every((entry) => entry === name),
    "Actual worker open not observed",
  );
  return actual;
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
  const adapter: SuiteAdapter<{ mode: string }> = {
    suite: "host-storage-control",
    inventory: () => [{ id: "storage", label: "storage", request: () => ({ mode }), drive }],
    policy: {
      listIds: () => ["storage"],
      requireResult: true,
      allocation: ownedDatabase("host-storage"),
      check() {},
    },
    assets: async () => ({ "/page.js": page, "/storage-worker.js": worker }),
    budgets: () => ({
      hello: 4000,
      heartbeat: 2000,
      case: 15_000,
      teardown: 2000,
      caseDocument: 20_000,
      group: 5000,
      run: 35_000,
    }),
  };
  const result = await runPageSuite(adapter, (scratch) => new PlaywrightDriver(engine, scratch), {
    resultPath: join(root, `host-storage-${mode}.json`),
    scratchRoot: process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp",
  });
  check(result.exit === 0, `Storage ${mode} failed: ${JSON.stringify(result)}`);
  check(result.ledger.length === 1 && result.runComplete, "Exact cleanup failed");
  check(
    Object.values(result.cleanup).every((step) => !record(step) || step.status !== "unconfirmed"),
    "Control cleanup unconfirmed",
  );
}
