import { resolve } from "node:path";
import type { Browser, BrowserContext, Page, Worker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle, engines } from "./browser-runner-lifecycle.js";
import {
  before,
  evidenceJson,
  failureReasons,
  observe,
  pending,
  requireValue,
  shutdownArms,
  type FailureReason,
  type Outcome,
  type PageSettlement,
  type ReopenResults,
  type ShutdownSpec,
  type Stage,
  type WorkerSnapshot,
} from "./filesystem-shutdown-browser.js";

type Engine = keyof typeof engines;
type OriginalTarget = {
  worker: Worker;
  creationIndex: number;
  rawUrl: Stage<string>;
  evaluatedLocation: Stage<string>;
  closed: Promise<void>;
  closeEvent: Stage<void>;
};
type TargetLedger = {
  owners: OriginalTarget[];
  created: Promise<OriginalTarget>;
  observerErrors: unknown[];
};
type ArmReport = {
  spec: ShutdownSpec;
  engine: Engine;
  deadline: number;
  primary: Stage<void>;
  ready: Stage<void>;
  originalRequest: Stage<unknown>;
  serviceAck: Stage<void>;
  originalStorage: Stage<WorkerSnapshot>;
  pendingLock: Stage<boolean>;
  releasedLock: Stage<boolean>;
  reopened: Stage<ReopenResults>;
  cleanupRelease: Stage<void>;
  cleanupRequest: Stage<Outcome<unknown>>;
  cleanupStorage: Stage<Outcome<unknown>>;
  cleanupReopenedBackend: Stage<void>;
  cleanupReopenedStorage: Stage<void>;
  cleanupClient: Stage<Outcome<void>[]>;
  cleanupIntervention: Stage<void>;
  originalTargetJoin: Stage<void>;
  cleanupLock: Stage<boolean>;
  deleteDatabase: Stage<void>;
  context: Stage<void>;
};
const lifecycle = new BrowserRunnerLifecycle();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function captureTargets(page: Page): TargetLedger {
  const first = Promise.withResolvers<OriginalTarget>();
  const ledger: TargetLedger = { owners: [], created: first.promise, observerErrors: [] };
  page.on("pageerror", (error) => ledger.observerErrors.push(error));
  page.on("worker", (worker) => {
    const closed = Promise.withResolvers<void>();
    const owner: OriginalTarget = {
      worker,
      creationIndex: ledger.owners.length,
      rawUrl: pending(),
      evaluatedLocation: pending(),
      closed: closed.promise,
      closeEvent: pending(),
    };
    ledger.owners.push(owner);
    // The original join is installed synchronously BEFORE even reading worker.url().
    worker.once("close", () => {
      owner.closeEvent = { kind: "fulfilled", value: undefined };
      closed.resolve();
    });
    readRawUrl(owner);
    first.resolve(owner);
  });
  return ledger;
}
function readRawUrl(owner: OriginalTarget): void {
  try {
    owner.rawUrl = { kind: "fulfilled", value: owner.worker.url() };
  } catch (reason) {
    owner.rawUrl = { kind: "rejected", reason };
  }
}
function value<T>(result: Stage<T>, phase: string): T {
  if (result.kind === "pending") throw new Error(`${phase}: missing original outcome`);
  return requireValue(result, phase);
}
async function liveLocation(
  owner: OriginalTarget,
  report: ArmReport,
  ledger: TargetLedger,
  deadline: number,
): Promise<void> {
  owner.evaluatedLocation = await before(deadline, "original live location", () =>
    owner.worker.evaluate(() => globalThis.location.href),
  );
  const live = value(owner.evaluatedLocation, "original evaluated location");
  const raw = value(owner.rawUrl, "original raw URL");
  assert(new URL(live).searchParams.get("nonce") === report.spec.nonce, "Wrong original live nonce");
  assert(live === raw, "Raw and evaluated original worker URLs differ");
  assert(owner.closeEvent.kind === "pending", "Original Worker already closed before observations");
  assert(ledger.owners.length === 1, "Expected exactly one original dedicated Worker");
  assert(ledger.observerErrors.length === 0, "Original worker/page observer failed");
}
function verifyPending(snapshot: WorkerSnapshot, spec: ShutdownSpec): void {
  assert(snapshot.nonce === spec.nonce, "Wrong ready/gate rendezvous nonce");
  assert(snapshot.backendCloseCalls === 0, "Backend close entered before original preparation joined");
  assert(snapshot.rawCloseCalls === 0, "Raw storage close entered while original gate held");
  assert(snapshot.preparation.kind === "pending", "Original preparation gate was not pending");
}
function verifySettlement(settled: PageSettlement, spec: ShutdownSpec): void {
  const worker = settled.worker;
  assert(worker.nonce === spec.nonce, "Original ACK has wrong worker rendezvous");
  assert(settled.request.kind === "rejected", "Original revoked request outcome was not preserved");
  if (spec.arm === "success") {
    assert(settled.serviceAck.kind === "fulfilled", "Original successful service ACK missing");
    assert(worker.backendClose.kind === "fulfilled", "Original backend close did not fulfill");
    assert(worker.nativeClose.kind === "fulfilled", "Original real storage close did not fulfill");
    assert(worker.rawCloseCalls === 1 && worker.nativeCloseCalls === 1, "Original raw close count");
    assert(worker.backendCloseCalls === 1, "Original backend close count");
    return;
  }
  assert(settled.serviceAck.kind === "rejected", "Original failed service ACK missing");
  assert(
    typeof settled.serviceAck.reason === "string" && settled.serviceAck.reason.length > 0,
    "Failed production ACK must preserve a nonempty diagnostic",
  );
  assert(value(worker.originalReasonMatched, "in-realm original reason") === true, "Original rejection identity changed");
  if (spec.arm === "drain-failure") {
    assert(worker.preparation.kind === "rejected", "Original preparation rejection lost");
    assert(worker.backendCloseCalls === 0, "Backend closed after failed original drain");
    assert(worker.nativeCloseCalls === 0 && worker.rawCloseCalls === 0, "Storage closed after failed drain");
    return;
  }
  assert(worker.backendCloseCalls === 1, "Missing original terminal backend close");
  assert(worker.backendClose.kind === "rejected", "Original backend failure lost");
  const released = spec.arm === "raw-close-failure";
  assert(worker.rawCloseCalls === Number(released), "Unexpected raw close after final-save failure");
  assert(worker.nativeCloseCalls === Number(released), "Unexpected native close after final-save failure");
  if (released) assert(worker.nativeClose.kind === "fulfilled", "Real close before injected failure missing");
}
function initialReport(spec: ShutdownSpec, engine: Engine): ArmReport {
  return {
    spec,
    engine,
    deadline: Date.now() + 45_000,
    primary: pending(),
    ready: pending(),
    originalRequest: pending(),
    serviceAck: pending(),
    originalStorage: pending(),
    pendingLock: pending(),
    releasedLock: pending(),
    reopened: pending(),
    cleanupRelease: pending(),
    cleanupRequest: pending(),
    cleanupStorage: pending(),
    cleanupReopenedBackend: pending(),
    cleanupReopenedStorage: pending(),
    cleanupClient: pending(),
    cleanupIntervention: pending(),
    originalTargetJoin: pending(),
    cleanupLock: pending(),
    deleteDatabase: pending(),
    context: pending(),
  };
}
async function storageObservations(page: Page, report: ArmReport, deadline: number): Promise<void> {
  report.releasedLock = await before(deadline, "post-ACK exact lock", () =>
    page.evaluate(() => window.filesystemShutdownFixture.lockAvailable()),
  );
  const released = report.spec.arm === "success" || report.spec.arm === "raw-close-failure";
  assert(value(report.releasedLock, "post-ACK exact lock") === released, "Wrong post-ACK lock state");
  if (!released) {
    report.reopened = { kind: "invalid", cause: "Not attempted: failed original owner retains lock" };
    return;
  }
  report.reopened = await before(deadline, "real reopen/read/close", () =>
    page.evaluate((cutoff) => window.filesystemShutdownFixture.reopen(cutoff), deadline),
  );
  const reopened = value(report.reopened, "real reopen");
  value(reopened.open, "native reopen");
  assert(value(reopened.readMarker, "native marker read") === report.spec.marker, "Dirty marker lost");
  value(reopened.close, "native reopened owner close");
  value(reopened.rawCleanup, "native reopened raw cleanup");
}
async function proveArm(page: Page, ledger: TargetLedger, report: ArmReport): Promise<void> {
  // Reserve cleanup time WITHIN the unchanged whole-arm 45-second deadline.
  const proofDeadline = report.deadline - 20_000;
  report.ready = await before(proofDeadline, "original ready/gate rendezvous", () =>
    page.evaluate(({ spec, deadline }) => window.filesystemShutdownFixture.start(spec, deadline), { spec: report.spec, deadline: proofDeadline }),
  );
  value(report.ready, "original ready/gate rendezvous");
  const owner = value(await before(proofDeadline, "original Worker observer", () => ledger.created), "original target");
  await liveLocation(owner, report, ledger, proofDeadline);
  const snapshot = await before(proofDeadline, "pending original storage", () =>
    page.evaluate(() => window.filesystemShutdownFixture.snapshot()),
  );
  verifyPending(value(snapshot, "pending original storage"), report.spec);
  const pendingAck = value(await before(proofDeadline, "pending ACK observation", () =>
    page.evaluate(() => window.filesystemShutdownFixture.ackState()),
  ), "pending ACK observation");
  assert(pendingAck.kind === "pending", "Service ACK settled while original gate held");
  report.pendingLock = await before(proofDeadline, "pending exact native lock", () =>
    page.evaluate(() => window.filesystemShutdownFixture.lockAvailable()),
  );
  assert(value(report.pendingLock, "pending exact native lock") === false, "Original native lock released early");
  value(await before(proofDeadline, "release same original gate", () =>
    page.evaluate(() => window.filesystemShutdownFixture.release()),
  ), "original gate release");
  const [request, ack] = await Promise.all([
    before(proofDeadline, "original request", () => page.evaluate(() => window.filesystemShutdownFixture.originalRequest())),
    before(proofDeadline, "original service ACK", () => page.evaluate(() => window.filesystemShutdownFixture.serviceAck())),
  ]);
  report.originalRequest = flatten(request);
  report.serviceAck = flatten(ack);
  report.originalStorage = await before(proofDeadline, "original storage outcome", () => page.evaluate(() => window.filesystemShutdownFixture.snapshot()));
  const settled: PageSettlement = {
    request: flatten(request),
    serviceAck: flatten(ack),
    worker: value(report.originalStorage, "original storage"),
  };
  verifySettlement(settled, report.spec);
  await liveLocation(owner, report, ledger, proofDeadline);
  await storageObservations(page, report, proofDeadline);
  await liveLocation(owner, report, ledger, proofDeadline);
}
function flatten<T>(result: Outcome<Outcome<T>>): Outcome<T> {
  return result.kind === "fulfilled" ? result.value : result;
}
function requirePage(page: Page | undefined): Page {
  if (!page) throw new Error("Original page allocation missing");
  return page;
}
async function cleanupArm(
  page: Page | undefined,
  context: Promise<BrowserContext>,
  ledger: TargetLedger,
  report: ArmReport,
): Promise<void> {
  report.cleanupRelease = await before(report.deadline, "cleanup original gate release", () =>
    requirePage(page).evaluate(() => window.filesystemShutdownFixture.release()), 1000);
  report.cleanupRequest = await before(report.deadline, "cleanup original request join", () =>
    requirePage(page).evaluate(() => window.filesystemShutdownFixture.originalRequest()), 2000);
  report.cleanupStorage = await before(report.deadline, "explicit original storage cleanup", () =>
    requirePage(page).evaluate(() => window.filesystemShutdownFixture.cleanupOriginalStorage()), 2000);
  report.cleanupReopenedBackend = await before(report.deadline, "reopened backend cleanup", () =>
    requirePage(page).evaluate(() => window.filesystemShutdownFixture.cleanupReopenedBackend()), 2000);
  report.cleanupReopenedStorage = await before(report.deadline, "reopened raw storage cleanup", () =>
    requirePage(page).evaluate(() => window.filesystemShutdownFixture.cleanupReopenedStorage()), 2000);
  report.cleanupClient = await before(report.deadline, "client/port cleanup", () =>
    requirePage(page).evaluate(() => window.filesystemShutdownFixture.closeClient()), 1000);
  report.cleanupIntervention = await before(report.deadline, "explicit original termination", () =>
    requirePage(page).evaluate(() => window.filesystemShutdownFixture.terminate()), 1000);
  const original = ledger.owners[0];
  report.originalTargetJoin = original
    ? await before(report.deadline - 3000, "original Worker close event", () => original.closed, 10_000)
    : { kind: "invalid", cause: "Original Worker target/close observer absent" };
  report.cleanupLock = await before(report.deadline, "cleanup exact lock observation", () =>
    requirePage(page).evaluate(() => window.filesystemShutdownFixture.lockAvailable()), 1000);
  report.deleteDatabase = await before(report.deadline, "native owned database deletion", () =>
    requirePage(page).evaluate(() => window.filesystemShutdownFixture.deleteDatabase()), 1000);
  report.context = await before(report.deadline, "owned context close", async () => (await context).close(), 1000);
}
function cleanupPassed(report: ArmReport): boolean {
  return report.cleanupRelease.kind === "fulfilled" &&
    report.cleanupRequest.kind === "fulfilled" && report.cleanupRequest.value.kind !== "invalid" &&
    report.cleanupStorage.kind === "fulfilled" && report.cleanupStorage.value.kind === "fulfilled" &&
    report.cleanupReopenedBackend.kind === "fulfilled" && report.cleanupReopenedStorage.kind === "fulfilled" &&
    report.cleanupClient.kind === "fulfilled" && report.cleanupClient.value.every((item) => item.kind === "fulfilled") &&
    report.cleanupIntervention.kind === "fulfilled" && report.originalTargetJoin.kind === "fulfilled" &&
    report.cleanupLock.kind === "fulfilled" && report.cleanupLock.value &&
    report.deleteDatabase.kind === "fulfilled" && report.context.kind === "fulfilled";
}
function emptyLedger(): TargetLedger {
  return { owners: [], created: new Promise(() => {}), observerErrors: [] };
}
function targetEvidence(owner: OriginalTarget) {
  return { creationIndex: owner.creationIndex, rawUrl: owner.rawUrl, evaluatedLocation: owner.evaluatedLocation, closeEvent: owner.closeEvent };
}
async function runArm(browser: Browser, engine: Engine, origin: string, spec: ShutdownSpec): Promise<void> {
  const report = initialReport(spec, engine);
  // The enclosing lifecycle already owns the browser. Keep this allocation promise
  // before awaiting it, so setup failure still reaches independent context cleanup.
  const context = browser.newContext();
  void observe(context);
  let page: Page | undefined;
  let ledger = emptyLedger();
  const primary = await observe((async () => {
    const allocated = value(await before(report.deadline - 20_000, "context allocation", () => context), "context allocation");
    page = value(await before(report.deadline - 20_000, "page allocation", () => allocated.newPage()), "page allocation");
    ledger = captureTargets(page);
    value(await before(report.deadline - 20_000, "fixture navigation", () => requirePage(page).goto(origin)), "fixture navigation");
    await proveArm(page, ledger, report);
  })());
  report.primary = primary;
  await cleanupArm(page, context, ledger, report);
  console.log(evidenceJson({ report, targets: ledger.owners.map(targetEvidence), observerErrors: ledger.observerErrors, seamLimits: "raw-close rejection follows real close/unlock; no native failed-close retention claim", retirement: "explicit cleanup intervention only" }));
  value(primary, "arm primary");
  assert(cleanupPassed(report), "Independent cleanup or original target join failed");
}
function isEngine(input: string): input is Engine {
  return Object.hasOwn(engines, input);
}
function options() {
  const args = process.argv.slice(2);
  const selected: Engine[] = [];
  let backend = "indexeddb";
  let reason: FailureReason | "all" = "all";
  for (let i = 0; i < args.length; i++) {
    const item = args[i]!;
    if (item === "--backend") { backend = args[++i] ?? ""; continue; }
    if (item === "--reason") { reason = selectedReason(args[++i]); continue; }
    if (!isEngine(item)) throw new Error(`Unknown shutdown engine/option: ${item}`);
    if (selected.includes(item)) throw new Error(`Duplicate engine: ${item}`);
    selected.push(item);
  }
  assert(backend === "indexeddb", "Only IndexedDB ordinary shutdown is allocated");
  assert(selected.length > 0, "Select at least one engine explicitly");
  return { selected, reasons: reason === "all" ? failureReasons : [reason] };
}
function selectedReason(input: string | undefined): FailureReason | "all" {
  if (input === "all") return "all";
  const found = failureReasons.find((reason) => reason === input);
  if (!found) throw new Error(`Unknown failure reason: ${input}`);
  return found;
}
function specifications(reasons: readonly FailureReason[]): ShutdownSpec[] {
  return shutdownArms.flatMap((arm) => (arm === "success" ? ["error" as const] : reasons).map((reason) => ({
    arm,
    reason,
    database: `waffle-shutdown-${crypto.randomUUID()}`,
    nonce: crypto.randomUUID(),
    marker: `dirty-original-${crypto.randomUUID()}`,
  })));
}
async function run(): Promise<void> {
  const selected = options();
  await lifecycle.init();
  const page = await browserBundle(resolve(import.meta.dir, "fixtures/filesystem-shutdown-page.ts"));
  const worker = await browserBundle(resolve(import.meta.dir, "fixtures/filesystem-shutdown-worker.ts"));
  const origin = lifecycle.serve({
    "/": '<!doctype html><script type="module" src="/filesystem-shutdown-page.js"></script>',
    "/filesystem-shutdown-page.js": page,
    "/filesystem-shutdown-worker.js": worker,
  });
  for (const engine of selected.selected) await runEngine(engine, origin, selected.reasons);
}
async function runEngine(engine: Engine, origin: string, reasons: readonly FailureReason[]): Promise<void> {
  const browser = await lifecycle.launch(engine);
  for (const spec of specifications(reasons)) await runArm(browser, engine, origin, spec);
  await lifecycle.closeBrowser(browser);
}
const main = await observe(run());
const cleanup = await observe(lifecycle.close());
console.log(evidenceJson({ main, cleanup, browserExecution: "requires separate root release" }));
if (main.kind !== "fulfilled" || cleanup.kind !== "fulfilled") process.exitCode = 1;
