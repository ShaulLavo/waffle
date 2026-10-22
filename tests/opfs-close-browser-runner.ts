import { resolve } from "node:path";
import type { BrowserContext, Page, Worker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle, engines } from "./browser-runner-lifecycle.js";
import {
  OpfsCloseSetupInvalid,
  reasonReceipt,
  requireProof,
  type OpfsCloseArm,
  type OpfsCloseCommand,
  type OpfsCloseReply,
} from "./opfs-close-browser.js";

export const opfsCloseControllerGap =
  "HELD: no qualified controller enforces the 45s whole-arm fence and joins late allocations. " +
  "Promise races and BrowserRunnerLifecycle's 60s emergency fence do not supply that controller.";

type Operation = {
  phase: string;
  state: "pending" | "fulfilled" | "rejected";
  failure?: { reason: unknown };
};
type WorkerOwner = {
  original: Worker;
  closed: Promise<void>;
  receipt: Record<string, unknown>;
};
export interface OpfsCloseArmResult {
  arm: OpfsCloseArm;
  storageName: string;
  status: "observations-complete" | "setup-invalid" | "behavioral-red";
  controllerQualification: "required-external-controller-not-included";
  startedAt: string;
  deadlineAt: string;
  profile: string;
  origin: string;
  originalContextClosed: boolean;
  finalContextClosed: boolean;
  receipts: Record<string, unknown>[];
  workers: Record<string, unknown>[];
  operations: Operation[];
  primaryErrors: unknown[];
  cleanupErrors: unknown[];
}
class ArmBudget {
  readonly start = performance.now();
  readonly startedAt = new Date();
  readonly deadlineAt = new Date(this.startedAt.getTime() + 45_000);
  readonly operations: Operation[] = [];
  remaining(proof: boolean): number {
    return (proof ? 25_000 : 45_000) - (performance.now() - this.start);
  }
  async run<T>(phase: string, action: () => Promise<T>, proof = false): Promise<T> {
    const remaining = this.remaining(proof);
    if (remaining <= 0) throw new OpfsCloseSetupInvalid(`No arm budget for ${phase}`);
    const record: Operation = { phase, state: "pending" };
    this.operations.push(record);
    const operation = Promise.resolve().then(action);
    void operation.then(
      () => {
        record.state = "fulfilled";
      },
      (reason) => {
        record.state = "rejected";
        record.failure = { reason };
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new OpfsCloseSetupInvalid(`Unjoined or timed out: ${phase}`)),
        Math.min(10_000, remaining),
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } catch (reason) {
      if (reason instanceof OpfsCloseSetupInvalid) throw reason;
      throw new OpfsCloseSetupInvalid(`Driver/allocation/join failure: ${phase}`, {
        cause: reason,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
class WorkerObservers {
  readonly owners = new Map<Worker, WorkerOwner>();
  private announced = Promise.withResolvers<WorkerOwner>();
  capture = (original: Worker): void => {
    const joined = Promise.withResolvers<void>();
    const receipt: Record<string, unknown> = { closeObserved: false };
    original.on("close", () => {
      receipt.closeObserved = true;
      receipt.closedAt = new Date().toISOString();
      joined.resolve();
    });
    const owner = { original, closed: joined.promise, receipt };
    this.owners.set(original, owner);
    // The exact object's close observer and map entry precede every URL access.
    try {
      receipt.rawUrl = original.url();
    } catch (reason) {
      receipt.rawUrlError = reasonReceipt(reason);
    }
    this.announced.resolve(owner);
  };
  async start(page: Page, token: string, budget: ArmBudget, proof: boolean): Promise<WorkerOwner> {
    const announced = this.announced.promise;
    await budget.run(
      `create Worker ${token}`,
      () => page.evaluate((value) => window.opfsClose.start(value), token),
      proof,
    );
    const owner = await budget.run(`observe original ${token}`, () => announced, proof);
    this.announced = Promise.withResolvers<WorkerOwner>();
    owner.receipt.token = token;
    const live = await budget.run(
      `same-object location ${token}`,
      () => owner.original.evaluate(() => globalThis.location.href),
      proof,
    );
    const raw = owner.receipt.rawUrl;
    if (typeof raw !== "string" || !raw)
      throw new OpfsCloseSetupInvalid("Original Worker raw URL unavailable");
    let resolved: string;
    try {
      resolved = new URL(raw, page.url()).href;
    } catch {
      throw new OpfsCloseSetupInvalid("Original Worker raw URL is invalid");
    }
    if (resolved !== live)
      throw new OpfsCloseSetupInvalid("Same-object live location differs from raw URL resolution");
    owner.receipt.liveLocation = live;
    owner.receipt.rawRepresentationPreserved = true;
    return owner;
  }
  async join(budget: ArmBudget): Promise<void> {
    for (const owner of this.owners.values())
      await budget.run(`exact original join ${String(owner.receipt.token)}`, () => owner.closed);
  }
}
async function command(
  page: Page,
  token: string,
  value: OpfsCloseCommand,
  budget: ArmBudget,
  result: OpfsCloseArmResult,
  proof: boolean,
): Promise<void> {
  const reply: OpfsCloseReply = await budget.run(
    `${token}:${value.kind}`,
    () =>
      page.evaluate(({ token, value }) => window.opfsClose.request(token, value), { token, value }),
    proof,
  );
  result.receipts.push({ token, command: value, ...reply });
  if (reply.status === "setup-invalid")
    throw new OpfsCloseSetupInvalid(`Worker setup invalid: ${token}:${value.kind}`);
  requireProof(reply.status === "ok", `Worker behavioral red: ${token}:${value.kind}`);
}
async function openPage(
  context: BrowserContext,
  origin: string,
  observers: WorkerObservers,
  budget: ArmBudget,
  proof: boolean,
): Promise<Page> {
  const page = await budget.run("allocate page", () => context.newPage(), proof);
  page.on("worker", observers.capture);
  await budget.run("navigate stable origin", () => page.goto(origin).then(() => undefined), proof);
  return page;
}
async function terminate(
  page: Page,
  observers: WorkerObservers,
  budget: ArmBudget,
  result: OpfsCloseArmResult,
): Promise<void> {
  const interventions = await budget.run("explicit Worker termination intervention", () =>
    page.evaluate(() => window.opfsClose.terminateAll()),
  );
  result.receipts.push({ intervention: interventions, naturalRetirementClaim: false });
  await observers.join(budget);
}
async function originalObservations(
  page: Page,
  observers: WorkerObservers,
  budget: ArmBudget,
  result: OpfsCloseArmResult,
): Promise<void> {
  await observers.start(page, "owner", budget, true);
  await command(
    page,
    "owner",
    { kind: "prepare", storageName: result.storageName, arm: result.arm },
    budget,
    result,
    true,
  );
  await observers.start(page, "probe", budget, true);
  await command(
    page,
    "probe",
    { kind: "probe", storageName: result.storageName, held: "both" },
    budget,
    result,
    true,
  );
  await command(page, "owner", { kind: "close" }, budget, result, true);
  const retained = result.arm !== "native-success";
  await command(page, "owner", { kind: "inspect", retained }, budget, result, true);
  await command(
    page,
    "probe",
    { kind: "probe", storageName: result.storageName, held: retained ? "first" : "none" },
    budget,
    result,
    true,
  );
  requireProof(
    Array.from(observers.owners.values()).every((owner) => owner.receipt.closeObserved === false),
    "Original Worker closed before intervention",
  );
  result.receipts.push({
    checkpoint: "pre-intervention-complete",
    retained,
    boundary: "direct-adapter-only",
    spontaneousNativeFailureProved: false,
  });
}
async function finalObservations(
  page: Page,
  observers: WorkerObservers,
  budget: ArmBudget,
  result: OpfsCloseArmResult,
): Promise<void> {
  await observers.start(page, "final-probe", budget, false);
  await command(
    page,
    "final-probe",
    { kind: "probe", storageName: result.storageName, held: "none" },
    budget,
    result,
    false,
  );
  await observers.start(page, "final-reopen", budget, false);
  await command(
    page,
    "final-reopen",
    { kind: "reopen", storageName: result.storageName },
    budget,
    result,
    false,
  );
  await command(
    page,
    "final-probe",
    { kind: "delete", storageName: result.storageName },
    budget,
    result,
    false,
  );
  result.receipts.push({ checkpoint: "independent-final-context", postInterventionOnly: true });
}
async function cleanupStep(
  phase: string,
  action: () => Promise<void>,
  result: OpfsCloseArmResult,
): Promise<void> {
  try {
    await action();
  } catch (reason) {
    result.cleanupErrors.push({ phase, reason });
  }
}
/** Source entry for a later root-approved single-arm controller, not an execution allocation.
 * Races stop observation admission but cannot kill/join an unresponsive browser child. */
export async function runOpfsCloseArm(
  engine: keyof typeof engines,
  arm: OpfsCloseArm,
): Promise<OpfsCloseArmResult> {
  const budget = new ArmBudget();
  const lifecycle = new BrowserRunnerLifecycle(45_000);
  const original = new WorkerObservers();
  const final = new WorkerObservers();
  const result: OpfsCloseArmResult = {
    arm,
    storageName: `waffle-u2g-r2-${crypto.randomUUID()}`,
    status: "setup-invalid",
    controllerQualification: "required-external-controller-not-included",
    startedAt: budget.startedAt.toISOString(),
    deadlineAt: budget.deadlineAt.toISOString(),
    profile: "",
    origin: "",
    originalContextClosed: false,
    finalContextClosed: false,
    receipts: [],
    workers: [],
    operations: budget.operations,
    primaryErrors: [],
    cleanupErrors: [],
  };
  let firstPage: Page | undefined;
  let finalPage: Page | undefined;
  try {
    await budget.run("initialize owned scratch", () => lifecycle.init(), true);
    result.profile = await budget.run(
      "allocate task profile",
      () => lifecycle.directory(lifecycle.scratch, "opfs-close-"),
      true,
    );
    const pageBundle = await budget.run(
      "bundle page",
      () => browserBundle(resolve(import.meta.dir, "fixtures/opfs-close-page.ts")),
      true,
    );
    const workerBundle = await budget.run(
      "bundle Worker",
      () => browserBundle(resolve(import.meta.dir, "fixtures/opfs-close-worker.ts")),
      true,
    );
    result.origin = lifecycle.serve({
      "/": '<!doctype html><script type="module" src="/opfs-close-page.js"></script>',
      "/opfs-close-page.js": pageBundle,
      "/opfs-close-worker.js": workerBundle,
    });
    const first = await budget.run(
      "allocate original persistent context",
      () => lifecycle.persistent(engine, result.profile),
      true,
    );
    firstPage = await openPage(first, result.origin, original, budget, true);
    await originalObservations(firstPage, original, budget, result);
    await terminate(firstPage, original, budget, result);
    await budget.run("confirmed original context closure", () => lifecycle.closeContext(first));
    result.originalContextClosed = true;
    const recovery = await budget.run("allocate same-profile final context", () =>
      lifecycle.persistent(engine, result.profile),
    );
    finalPage = await openPage(recovery, result.origin, final, budget, false);
    await finalObservations(finalPage, final, budget, result);
    await terminate(finalPage, final, budget, result);
    await budget.run("confirmed final context closure", () => lifecycle.closeContext(recovery));
    result.finalContextClosed = true;
    result.status = "observations-complete";
  } catch (reason) {
    result.primaryErrors.push(reason);
    result.status = reason instanceof OpfsCloseSetupInvalid ? "setup-invalid" : "behavioral-red";
  } finally {
    const ownedFirstPage = firstPage,
      ownedFinalPage = finalPage;
    if (ownedFirstPage && !result.originalContextClosed)
      await cleanupStep(
        "original Worker intervention/join",
        () => terminate(ownedFirstPage, original, budget, result),
        result,
      );
    if (ownedFinalPage && !result.finalContextClosed)
      await cleanupStep(
        "final Worker intervention/join",
        () => terminate(ownedFinalPage, final, budget, result),
        result,
      );
    await cleanupStep(
      "lifecycle cleanup, not a 45s controller",
      () => budget.run("lifecycle cleanup", () => lifecycle.close()),
      result,
    );
    result.workers = Array.from(original.owners.values(), (owner) => owner.receipt).concat(
      Array.from(final.owners.values(), (owner) => owner.receipt),
    );
    if (
      result.cleanupErrors.length ||
      result.operations.some((operation) => operation.state === "pending") ||
      budget.remaining(false) <= 0
    )
      result.status = result.status === "behavioral-red" ? "behavioral-red" : "setup-invalid";
  }
  return result;
}
if (import.meta.main) {
  console.error(opfsCloseControllerGap);
  process.exitCode = 1;
}
