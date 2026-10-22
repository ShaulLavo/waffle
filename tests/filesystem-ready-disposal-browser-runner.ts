import { resolve } from "node:path";
import type { Browser, BrowserContext, Page, Worker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";
import {
  before,
  evidenceJson,
  observe,
  requireValue,
  verifyOriginalWorkerLocation,
  type Outcome,
  type ShutdownSpec,
} from "./filesystem-shutdown-browser.js";
import { ContextCloseObservation } from "./filesystem-shutdown-close-observation.js";

type Receipt = { phase: string; outcome: Outcome<unknown> };
type Target = { worker: Worker; closed: Promise<void>; isClosed: boolean };
const receipts: Receipt[] = [];
const targets: Target[] = [];
const lifecycle = new BrowserRunnerLifecycle();
let page: Page | undefined;
let browser: Browser | undefined;
let context: ContextCloseObservation<BrowserContext> | undefined;
const deadline = Date.now() + 45_000;
const spec: ShutdownSpec = {
  arm: "success",
  reason: "error",
  database: `waffle-ready-shutdown-${crypto.randomUUID()}`,
  nonce: crypto.randomUUID(),
  marker: `dirty-ready-${crypto.randomUUID()}`,
};

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function ownTarget(worker: Worker): void {
  const closed = Promise.withResolvers<void>();
  const target = { worker, closed: closed.promise, isClosed: false };
  targets.push(target);
  worker.once("close", () => {
    target.isClosed = true;
    closed.resolve();
  });
}
async function phase<T>(name: string, run: () => Promise<T>): Promise<T> {
  const outcome = await before(deadline - 20_000, name, run);
  receipts.push({ phase: name, outcome });
  return requireValue(outcome, name);
}
function originalPage(): Page {
  if (!page) throw new Error("Original page was not allocated");
  return page;
}
async function proof(): Promise<void> {
  const engine = process.argv[2];
  assert(engine === "chromium" || engine === "firefox" || engine === "webkit", "Select one engine");
  assert(process.argv.length === 3, "Ready caller proof accepts exactly one engine");
  await lifecycle.init();
  const pageBundle = await browserBundle(
    resolve(import.meta.dir, "fixtures/filesystem-shutdown-page.ts"),
  );
  const workerBundle = await browserBundle(
    resolve(import.meta.dir, "fixtures/filesystem-shutdown-worker.ts"),
  );
  const origin = lifecycle.serve({
    "/": '<!doctype html><script type="module" src="/filesystem-shutdown-page.js"></script>',
    "/filesystem-shutdown-page.js": pageBundle,
    "/filesystem-shutdown-worker.js": workerBundle,
  });
  browser = await lifecycle.launch(engine);
  const allocation = browser.newContext();
  context = new ContextCloseObservation(spec.nonce, allocation);
  const allocated = await phase("context allocation", () => allocation);
  page = await phase("page allocation", () => allocated.newPage());
  page.on("worker", ownTarget);
  await phase("fixture navigation", () => originalPage().goto(origin));
  await phase("ready caller gate", () =>
    originalPage().evaluate(
      ({ spec, cutoff }) => window.filesystemShutdownFixture.startReady(spec, cutoff),
      {
        spec,
        cutoff: deadline - 20_000,
      },
    ),
  );
  const target = targets[0];
  assert(target && targets.length === 1, "Expected one original native Worker");
  const location = await phase("original live location", () =>
    target.worker.evaluate(() => globalThis.location.href),
  );
  verifyOriginalWorkerLocation(
    { kind: "fulfilled", value: target.worker.url() },
    { kind: "fulfilled", value: location },
    spec.nonce,
  );
  const held = await phase("held original backend", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.snapshot()),
  );
  assert(
    held.backendCloseCalls === 0 && held.rawCloseCalls === 0,
    "Backend closed before the original gate joined",
  );
  assert(held.preparation.kind === "pending", "Original preparation is not held");
  const pending = await phase("pending ready caller", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.readyState()),
  );
  assert(
    pending.status === "ready" && pending.samePromise && pending.terminations === 0,
    "Ready caller released its original owner before ACK",
  );
  assert(!target.isClosed, "Original target died before the gate released");
  const locked = await phase("held native lock", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.lockAvailable()),
  );
  assert(!locked, "Original IndexedDB lock released before the gate joined");
  await phase("release original gate", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.release()),
  );
  const disposal = await phase("original ready disposal", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.readyDisposal()),
  );
  requireValue(disposal, "original ready disposal");
  await phase("original target death before cleanup", () => target.closed);
  const settled = await phase("disposed ready caller", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.readyState()),
  );
  assert(
    settled.status === "disposed" && settled.samePromise && settled.terminations === 1,
    "Ready caller did not finish its original disposal exactly once",
  );
  const storage = await phase("original pre-ACK storage receipt", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.snapshot()),
  );
  assert(storage.nonce === spec.nonce, "Wrong original storage owner");
  assert(
    storage.backendCloseCalls === 1 &&
      storage.rawCloseCalls === 1 &&
      storage.nativeCloseCalls === 1,
    "Original backend/storage close was not exactly once",
  );
  requireValue(
    storage.backendClose.kind === "pending"
      ? { kind: "invalid", cause: "Backend close pending" }
      : storage.backendClose,
    "original backend close",
  );
  requireValue(
    storage.nativeClose.kind === "pending"
      ? { kind: "invalid", cause: "Native close pending" }
      : storage.nativeClose,
    "original native close",
  );
  const ack = await phase("real service ACK", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.serviceAck()),
  );
  requireValue(ack, "real service ACK");
  const request = await phase("original cancelled request", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.originalRequest()),
  );
  assert(request.kind === "rejected", "Original revoked request was not rejected");
  const unlocked = await phase("released native lock", () =>
    originalPage().evaluate(() => window.filesystemShutdownFixture.lockAvailable()),
  );
  assert(unlocked, "Original IndexedDB lock remains held after disposal");
  const reopened = await phase("real native reopen", () =>
    originalPage().evaluate(
      (cutoff) => window.filesystemShutdownFixture.reopen(cutoff),
      deadline - 20_000,
    ),
  );
  requireValue(reopened.open, "native reopen");
  assert(
    requireValue(reopened.readMarker, "native marker read") === spec.marker,
    "Dirty ready marker was lost",
  );
  requireValue(reopened.close, "reopened backend close");
  requireValue(reopened.rawCleanup, "reopened raw cleanup");
}
async function cleanupPhase(name: string, run: () => Promise<unknown>): Promise<void> {
  receipts.push({ phase: name, outcome: await before(deadline, name, run, 1000) });
}
async function cleanup(): Promise<void> {
  if (!targets[0]?.isClosed && page) {
    await cleanupPhase("cleanup gate release", () =>
      originalPage().evaluate(() => window.filesystemShutdownFixture.release()),
    );
    await cleanupPhase("cleanup raw storage", () =>
      originalPage()
        .evaluate(() => window.filesystemShutdownFixture.cleanupOriginalStorage())
        .then((outcome) => requireValue(outcome, "cleanup original raw storage")),
    );
    await cleanupPhase("cleanup target termination", () =>
      originalPage().evaluate(() => window.filesystemShutdownFixture.terminate()),
    );
    await cleanupPhase("cleanup original target join", () => targets[0]!.closed);
  }
  if (page) {
    await cleanupPhase("cleanup reopened backend", () =>
      originalPage().evaluate(() => window.filesystemShutdownFixture.cleanupReopenedBackend()),
    );
    await cleanupPhase("cleanup reopened storage", () =>
      originalPage().evaluate(() => window.filesystemShutdownFixture.cleanupReopenedStorage()),
    );
    await cleanupPhase("cleanup client", () =>
      originalPage()
        .evaluate(() => window.filesystemShutdownFixture.closeClient())
        .then((outcomes) => {
          for (const outcome of outcomes) requireValue(outcome, "cleanup client endpoint");
        }),
    );
    await cleanupPhase("delete owned database", () =>
      originalPage().evaluate(() => window.filesystemShutdownFixture.deleteDatabase()),
    );
  }
  if (context)
    receipts.push({
      phase: "original context close",
      outcome: await context.observeBefore(deadline),
    });
}
const primary = await observe(proof());
const cleanupResult = await observe(cleanup());
const enclosing = await observe(lifecycle.close());
console.log(
  evidenceJson({
    spec,
    primary,
    cleanupResult,
    enclosing,
    receipts,
    targets: targets.map((target) => ({ url: target.worker.url(), isClosed: target.isClosed })),
    context: context?.snapshot(),
    limits:
      "One ready IndexedDB success caller. Native Worker death joined before cleanup; no Runtime, OPFS, native failed-close or complete matrix claim.",
  }),
);
if (
  primary.kind !== "fulfilled" ||
  cleanupResult.kind !== "fulfilled" ||
  enclosing.kind !== "fulfilled" ||
  receipts.some((receipt) => receipt.outcome.kind !== "fulfilled")
)
  process.exitCode = 1;
