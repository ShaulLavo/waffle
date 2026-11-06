import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FakeDriver, type FakeMode } from "./fake-driver.js";
import { runStorage, probeDocument } from "./storage-host.js";
import { Collector } from "./collector.js";
import { storageBudgets } from "./protocol.js";
import { withStorageCleanup } from "../storage-allocation.js";
async function control(mode: FakeMode, filtered = true) {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "pr-control-"));
  const driver = new FakeDriver(mode);
  let scratch = "";
  try {
    const result = await runStorage(
      (path) => {
        scratch = path;
        return driver;
      },
      {
        resultPath: join(root, "result.json"),
        assets: {},
        filter: filtered ? "IndexedDB persists format" : undefined,
        scratchRoot: root,
        cleanupTimeoutMs: 30,
        budgets: { ...storageBudgets, heartbeat: 1500, hello: 1000, group: 1500, run: 8000 },
      },
    );
    expect(await Bun.file(join(root, "result.json")).json()).toEqual(result);
    if (result.cleanup.scratch.status === "unconfirmed") expect(await stat(scratch)).toBeDefined();
    else expect(await Bun.file(scratch).exists()).toBe(false);
    expect(driver.stopCalls).toBe(1);
    return { result, driver };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("host keeps filtered full inventory distinct and tolerates unowned service survival", async () => {
  const { result } = await control("pass");
  expect(result.exit).toBe(4);
  expect(result.required).toHaveLength(61);
  expect(result.selected).toHaveLength(1);
  expect(result.omitted).toHaveLength(60);
  expect(result.cleanup.serviceDisposition).toContain("never signalled");
});
for (const mode of [
  "finish-error",
  "reload",
  "close",
  "driver-lost",
  "hang-delete",
  "cleanup-fails",
  "final-ack-loss",
] satisfies FakeMode[]) {
  test(`host cannot return success for ${mode}`, async () => {
    const { result, driver } = await control(mode);
    expect(result.exit).toBe(2);
    if (mode === "driver-lost") expect(driver.navigations).toBe(2);
    if (mode === "hang-delete" || mode === "cleanup-fails")
      expect(result.cleanup.scratch.status).toBe("unconfirmed");
    if (mode === "reload")
      expect(result.failures.some((failure) => failure.category === "page-reloaded")).toBe(true);
    if (mode === "close")
      expect(result.failures.some((failure) => failure.category === "page-closed")).toBe(true);
  }, 12_000);
}
test("fixture cleanup preserves its assertion when cleanup also fails", async () => {
  const assertion = new Error("original assertion"),
    cleanup = new Error("cleanup fault");
  try {
    await withStorageCleanup(
      () => Promise.reject(assertion),
      () => Promise.reject(cleanup),
    );
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    if (error instanceof AggregateError) expect(error.errors).toEqual([assertion, cleanup]);
    return;
  }
  throw new Error("Expected both failures");
});
test("responsive broken reporting and failed script probes remain different signals", async () => {
  const collector = new Collector("r", [], []);
  const state = collector.expect(
    { id: "list", role: "list", caseIds: [] },
    "t",
    "http://test/",
    "root",
  );
  state.doc = "doc";
  const driver = new FakeDriver("pass");
  driver.currentURL = state.expectedURL;
  driver.currentDoc = "doc";
  expect(await probeDocument(state, driver, AbortSignal.timeout(1000))).toBe("responsive");
  driver.uncertain = true;
  expect(await probeDocument(state, driver, AbortSignal.timeout(1000))).toBe("driver-lost");
});

test("unfiltered source assertion failures exit 1 when reporting and cleanup succeed", async () => {
  const { result } = await control("assertion", false);
  expect(result.exit).toBe(1);
  expect(result.runComplete).toBe(true);
  expect(result.failures).toHaveLength(0);
  expect(Object.values(result.outcomes).every((outcome) => outcome.status === "fail")).toBe(true);
}, 12_000);

test("already-aborted cancellation allocates no driver and dispatches no cases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pr-pre-abort-"));
  let allocations = 0;
  try {
    const result = await runStorage(
      () => {
        allocations++;
        return new FakeDriver("pass");
      },
      {
        resultPath: join(root, "result.json"),
        scratchRoot: root,
        assets: {},
        signal: AbortSignal.abort("cancelled before entry"),
      },
    );
    expect(result.exit).toBe(2);
    expect(allocations).toBe(0);
    expect(result.documents).toHaveLength(0);
    expect(result.ledger).toHaveLength(0);
    expect(result.cleanup.session.status).toBe("not-created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
