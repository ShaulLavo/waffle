import type { Browser, Page, Worker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle, engines } from "./browser-runner-lifecycle.js";
import { before, evidenceJson, isRecord, requireValue, observe } from "./filesystem-shutdown-browser.js";
import { ContextCloseObservation } from "./filesystem-shutdown-close-observation.js";
import { shutdownDebtPagePath, type DebtCase } from "./fixtures/filesystem-shutdown-debt-page.js";
import { shutdownDebtWorkerPath } from "./fixtures/filesystem-shutdown-debt-worker.js";

type OriginalWorker = { worker: Worker; url: string; closed: Promise<void>; closeObserved: boolean };
const cases: DebtCase[] = ["filesystem-close-error", "filesystem-close-undefined", "runtime-close-error", "runtime-close-undefined", "runtime-stop-error", "runtime-late-stop"];

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function captureWorker(owners: OriginalWorker[], worker: Worker): void {
  const close = Promise.withResolvers<void>();
  const owner = { worker, url: worker.url(), closed: close.promise, closeObserved: false };
  owners.push(owner);
  worker.once("close", () => { owner.closeObserved = true; close.resolve(); });
}
function consumer(owners: OriginalWorker[], index: number): OriginalWorker {
  const owner = owners.find((item) => new URL(item.url).searchParams.get("index") === String(index));
  assert(owner, "Missing independently observed original consumer");
  return owner;
}
async function consumersStopped(page: Page, owners: OriginalWorker[], mode: DebtCase, deadline: number) {
  await page.evaluate(() => window.shutdownDebt.stopped());
  const sibling = consumer(owners, 1);
  requireValue(await before(deadline, "sibling physical Worker close", () => sibling.closed), "sibling close");
  await page.evaluate(() => window.shutdownDebt.join(1));
  if (mode !== "runtime-late-stop") return;
  const pending = await page.evaluate(() => window.shutdownDebt.state());
  assert(pending.result.kind === "pending" && pending.guardHeld && pending.ackCount === 0, "Runtime released storage/guard before native consumer joined");
  await consumer(owners, 0).worker.evaluate(() => location.href);
  await page.evaluate(() => window.shutdownDebt.terminateConsumer(0));
  requireValue(await before(deadline, "late physical Worker close", () => consumer(owners, 0).closed), "late close");
  await page.evaluate(() => window.shutdownDebt.join(0));
}
async function proveDebt(page: Page, owners: OriginalWorker[], mode: DebtCase, deadline: number, observations: unknown[]) {
  if (mode === "runtime-stop-error" || mode === "runtime-late-stop")
    await consumersStopped(page, owners, mode, deadline);
  await page.waitForFunction(() => window.shutdownDebt.state().result.kind !== "pending", undefined, { timeout: Math.max(1, deadline - Date.now()) });
  const state = await page.evaluate(() => window.shutdownDebt.state());
  observations.push({ phase: "settled", state });
  assert(state.samePromise, "Duplicate disposal replaced its original promise");
  if (mode === "runtime-late-stop") {
    assert(state.result.kind === "fulfilled" && !state.guardHeld, "Joined Runtime did not release its guard");
    return;
  }
  assert(state.result.kind === "rejected", "Original failed disposal did not reject");
  const original = owners.find((item) => new URL(item.url).searchParams.get("role") === "storage");
  assert(original && !original.closeObserved, "Failed disposal terminated original filesystem Worker");
  observations.push({ originalLocation: await original.worker.evaluate(() => location.href) });
  assert(!await page.evaluate(() => window.shutdownDebt.lockAvailable()), "Failed disposal released original native WebLock");
  if (mode === "runtime-stop-error") {
    assert(state.originalStopReason && state.stopCalls.every((calls) => calls === 1), "Stop failure identity or sibling stop count changed");
    assert(!consumer(owners, 0).closeObserved, "Failed original consumer was silently terminated");
    await consumer(owners, 0).worker.evaluate(() => location.href);
  } else {
    const snapshot = await page.evaluate(() => window.shutdownDebt.probe("snapshot"));
    observations.push({ phase: "native-close-debt", snapshot });
    assert(isRecord(snapshot) && snapshot.retained && snapshot.originalReadable && snapshot.sameStoragePromise && snapshot.reasonMatched && snapshot.selectedCalls === 1, "Original native failed-close handle or reason lost");
    const late = await page.evaluate(() => window.shutdownDebt.probe("late"));
    observations.push({ phase: "late-duplicate-close", snapshot: late });
    assert(isRecord(late) && late.retained && late.originalReadable && late.sameStoragePromise && late.selectedCalls === 1 && late.lateCallbacks === 1, "Late duplicate retried native failed close");
  }
  await page.evaluate(() => window.shutdownDebt.late());
  const after = await page.evaluate(() => window.shutdownDebt.state());
  observations.push({ phase: "late-callback", state: after });
  assert(after.result.kind === "rejected" && after.samePromise && after.terminationRoles.length === 0, "Late callback released failed original owner");
  if (mode.startsWith("runtime")) assert(after.guardHeld, "Runtime released page guard while native close/stop debt remains");
}
async function runCell(browser: Browser, origin: string, mode: DebtCase, engine: string): Promise<boolean> {
  const deadline = Date.now() + 45_000;
  const allocation = browser.newContext();
  const context = new ContextCloseObservation(mode, allocation);
  const owners: OriginalWorker[] = [];
  const errors: unknown[] = [];
  const observations: unknown[] = [];
  let page: Page | undefined;
  const primary = await observe((async () => {
    const allocated = requireValue(await before(deadline - 20_000, "context", () => allocation), "context");
    page = await allocated.newPage();
    page.on("worker", (worker) => captureWorker(owners, worker));
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(origin);
    const current = page;
    requireValue(await before(deadline - 20_000, "native debt proof", async () => {
      await current.evaluate(({ mode, name }) => window.shutdownDebt.start(mode, name), { mode, name: `debt-${crypto.randomUUID()}` });
      await proveDebt(current, owners, mode, deadline - 20_000, observations);
    }), "native debt proof");
    assert(errors.length === 0, "Unexpected native fixture page error");
  })());
  const cleanup: unknown[] = [];
  if (page) {
    const current = page;
    cleanup.push(await before(deadline, "explicit original termination", () => current.evaluate(() => window.shutdownDebt.terminate()), 1000));
    for (const owner of owners) cleanup.push(await before(deadline - 3000, "exact original Worker close", () => owner.closed, 10_000));
    cleanup.push(await before(deadline, "owned storage deletion", () => current.evaluate(() => window.shutdownDebt.deleteStorage()), 1000));
  }
  cleanup.push(await context.observeBefore(deadline));
  console.log(evidenceJson({ nativeDebt: { engine, mode, primary, observations, errors, cleanup, context: context.snapshot(), workers: owners.map(({ url, closeObserved }) => ({ url, closeObserved })) }, limitation: "Injected before native close; targeted observation, not spontaneous failure or held OPFS campaign qualification" }));
  return primary.kind === "fulfilled" && cleanup.every((item) => isRecord(item) && item.kind === "fulfilled");
}
export async function runNativeDebt(lifecycle: BrowserRunnerLifecycle, args: readonly string[]): Promise<void> {
  const selected = args.filter((arg) => arg !== "--native-debt");
  assert(selected.length > 0 && selected.every((engine) => engine in engines), "Select native debt engines explicitly");
  await lifecycle.init();
  const page = await browserBundle(shutdownDebtPagePath);
  const worker = await browserBundle(shutdownDebtWorkerPath);
  const origin = lifecycle.serve({ "/": '<!doctype html><script type="module" src="/debt-page.js"></script>', "/debt-page.js": page, "/debt-worker.js": worker });
  let passed = true;
  for (const engine of selected) {
    if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit") throw new Error("Unknown engine");
    const browser = await lifecycle.launch(engine);
    for (const mode of cases) passed = await runCell(browser, origin, mode, engine) && passed;
    await lifecycle.closeBrowser(browser);
  }
  assert(passed, "Native debt proof failed; inspect per-cell primary and cleanup receipts");
}
