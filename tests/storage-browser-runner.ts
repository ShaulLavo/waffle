import { resolve } from "node:path";
import type { Browser, BrowserContext, Page, Worker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle, engines } from "./browser-runner-lifecycle.js";

type Backend = "indexeddb" | "opfs";
type WorkerRequest = { kind: "list" } | { kind: "run"; backend: Backend; label: string };
type TestList = Record<Backend, string[]>;

// Bun strips the types before toString(): the worker has TypeScript source, not handwritten JS.
function storageWorker(): void {
  function labels(suites: Record<Backend, { label: string }[]>): TestList {
    return {
      indexeddb: suites.indexeddb.map((test) => test.label),
      opfs: suites.opfs.map((test) => test.label),
    };
  }
  async function runStorageRequest(request: WorkerRequest): Promise<void> {
    const modulePath = "/tests.js";
    const tests = (await import(modulePath)) as typeof import("./storage-browser");
    // The runner owns this route; imported backend suites do not assume one exists.
    const suites = {
      indexeddb: tests.storageTests("/fs-worker.js", "/open-fs-worker.js"),
      opfs: tests.opfsStorageTests("/fs-worker.js"),
    };
    if (request.kind === "list") {
      globalThis.postMessage({ result: labels(suites) });
      return;
    }
    const { backend, label } = request;
    const test = suites[backend].find((test) => test.label === label);
    if (!test) throw new Error(`Unknown ${backend} storage test: ${label}`);
    await test.run();
    globalThis.postMessage({ result: label });
  }
  globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    try {
      await runStorageRequest(event.data);
    } catch (error) {
      // WebKit's stack contains locations only: never let it replace the actual error message.
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
          : String(error);
      const environment = {
        secureContext: globalThis.isSecureContext,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        getDirectory: typeof navigator.storage?.getDirectory,
        syncAccess:
          typeof FileSystemFileHandle === "undefined"
            ? "undefined"
            : typeof (
                FileSystemFileHandle.prototype as FileSystemFileHandle & {
                  createSyncAccessHandle?: unknown;
                }
              ).createSyncAccessHandle,
      };
      globalThis.postMessage({
        error: `${detail}\nWorker environment: ${JSON.stringify(environment)}`,
      });
    }
  };
}

function storageCases(listed: TestList) {
  return (["indexeddb", "opfs"] as const).flatMap((backend) =>
    listed[backend].map((label) => ({ backend, label })),
  );
}
const lifecycle = new BrowserRunnerLifecycle();
let origin = "",
  persistentShutdownFailed = false;
async function inWorker<T>(
  browser: Browser,
  request: WorkerRequest,
  persistent = false,
): Promise<T> {
  let context: BrowserContext | undefined, profile: string | undefined;
  try {
    if (persistent) {
      profile = await lifecycle.directory(lifecycle.scratch, "webkit-opfs-profile-");
      context = await lifecycle.persistent("webkit", profile);
    } else context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    return await page.evaluate(storageCase<T>, request);
  } finally {
    if (context) await closeStorageContext(context, persistent);
    if (profile) await lifecycle.removeDirectory(profile);
  }
}
function storageCase<T>(request: WorkerRequest): Promise<T> {
  function settle(
    data: { error?: string; result: T },
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void,
  ): void {
    if (data.error) reject(new Error(data.error));
    else resolve(data.result);
  }
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker("/worker.js", { type: "module" });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("storage case worker timed out"));
    }, 45_000);
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event) => {
      finish();
      settle(event.data, resolve, reject);
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error("Could not decode storage worker response"));
    };
    worker.postMessage(request);
  });
}
async function closeStorageContext(context: BrowserContext, persistent: boolean): Promise<void> {
  try {
    if (persistent) await lifecycle.closeContext(context);
    else await context.close();
  } catch (error) {
    if (persistent) persistentShutdownFailed = true;
    throw error;
  }
}
async function runCase(
  browser: Browser,
  name: string,
  backend: Backend,
  label: string,
  passed: TestList,
  failures: string[],
): Promise<void> {
  const persistent = name === "webkit" && backend === "opfs";
  try {
    await inWorker<string>(browser, { kind: "run", backend, label }, persistent);
    passed[backend].push(label);
    console.log(`  PASS ${name} ${backend}: ${label}`);
  } catch (error) {
    const failure = `${name} ${backend}: ${label}\n${String(error)}`;
    failures.push(failure);
    console.error(`  FAIL ${failure}`);
    if (persistentShutdownFailed) throw error;
  }
}
const retirementLabel = "Runtime retirement retains failed consumer debt";
type RetirementOutcome<T = unknown> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };
type RetirementPhase = { phase: string; outcome: RetirementOutcome };
type RetirementTarget = {
  worker: Worker;
  index: number;
  initialURL: string;
  observed?: { url: string; role: string };
  closed: boolean;
  close: Promise<void>;
};
function retirementTarget(worker: Worker, index: number): RetirementTarget {
  let finish!: () => void;
  const close = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const target: RetirementTarget = { worker, index, initialURL: "", closed: false, close };
  worker.once("close", () => {
    target.closed = true;
    finish();
  });
  return target;
}
function retirementTargets(page: Page) {
  const targets: RetirementTarget[] = [];
  let created!: () => void;
  const ready = new Promise<void>((resolve) => {
    created = resolve;
  });
  page.on("worker", (worker) => {
    const target = retirementTarget(worker, targets.length);
    targets.push(target);
    target.initialURL = worker.url();
    if (targets.length === 2) created();
  });
  return { targets, ready };
}
async function retirementBounded<T>(
  pending: Promise<T>,
  phase: string,
  milliseconds = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Runtime retirement ${phase} timed out`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
async function retirementAttempt<T>(
  operation: () => T | Promise<T>,
): Promise<RetirementOutcome<T>> {
  try {
    return { status: "fulfilled", value: await operation() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}
async function retirementStep<T>(
  outcomes: RetirementPhase[],
  phase: string,
  operation: () => T | Promise<T>,
) {
  const outcome = await retirementAttempt(operation);
  outcomes.push({ phase, outcome });
  return outcome;
}
function retirementPhaseReceipt({ phase, outcome }: RetirementPhase) {
  if (outcome.status === "fulfilled")
    return { phase, status: outcome.status, value: outcome.value };
  const reason = outcome.reason;
  return {
    phase,
    status: outcome.status,
    reason: {
      type: typeof reason,
      detail: String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    },
  };
}
function retirementFinish(outcomes: RetirementPhase[]) {
  console.log(
    `Runtime retirement outcome receipt: ${JSON.stringify(outcomes.map(retirementPhaseReceipt))}`,
  );
  const failures = outcomes.flatMap(({ outcome }) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Runtime retirement primary and cleanup failures");
}
function retirementTargetReceipt(target: RetirementTarget) {
  return {
    index: target.index,
    initialURL: target.initialURL,
    observed: target.observed,
    closed: target.closed,
  };
}
async function retirementObserveTarget(target: RetirementTarget, attempt: string) {
  const url = await target.worker.evaluate(() => location.href);
  const parsed = new URL(url);
  const role = parsed.searchParams.get("role");
  if (
    parsed.origin !== origin ||
    parsed.searchParams.get("attempt") !== attempt ||
    (role !== "filesystem" && role !== "consumer")
  )
    throw new Error(`Unowned original worker ${target.index}: ${url}`);
  const path = role === "filesystem" ? "/fs-worker.js" : "/retirement-consumer.js";
  if (parsed.pathname !== path || target.closed)
    throw new Error(`Original worker not live before disposal: ${url}`);
  target.observed = { url, role };
}
async function retirementObserveOriginals(
  observation: ReturnType<typeof retirementTargets>,
  attempt: string,
) {
  await retirementBounded(observation.ready, "original workers before disposal");
  await Promise.all(observation.targets.map((target) => retirementObserveTarget(target, attempt)));
  if (
    observation.targets.length !== 2 ||
    new Set(observation.targets.map((target) => target.observed?.role)).size !== 2
  )
    throw new Error(
      "Runtime retirement observation did not establish both distinct original workers",
    );
  console.log(
    `Runtime retirement original observation receipt: ${JSON.stringify({ attempt, targets: observation.targets.map(retirementTargetReceipt) })}`,
  );
}
async function inspectRetirementTarget(target: RetirementTarget) {
  if (!target.observed)
    throw new Error(`Original worker ${target.index} was not observed before disposal`);
  return {
    ...retirementTargetReceipt(target),
    url: target.observed.url,
    live: target.closed ? false : await target.worker.evaluate(() => true),
  };
}
async function retirementAcquireLock(database: string) {
  const lock = `bun-wasm:filesystem:indexeddb:${database}`;
  await navigator.locks.request(lock, { signal: AbortSignal.timeout(5000) }, () => {});
  return { database, lockReleased: true };
}
async function retirementDeleteDatabase(database: string) {
  await new Promise<void>((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(database);
    deleting.onsuccess = () => resolve();
    deleting.onerror = () => reject(deleting.error);
    deleting.onblocked = () => reject(new Error("Owned retirement database deletion blocked"));
  });
  return { database, deleted: true };
}
async function retirementStorageCleanup(context: BrowserContext, attempt: string) {
  const cleanup = await context.newPage();
  const outcomes: RetirementPhase[] = [];
  await retirementStep(outcomes, "database cleanup navigation", () =>
    retirementBounded(cleanup.goto(origin), "database cleanup navigation"),
  );
  await retirementStep(outcomes, "owned native lock cleanup", () =>
    retirementBounded(
      cleanup.evaluate(retirementAcquireLock, attempt),
      "owned native lock cleanup",
    ),
  );
  await retirementStep(outcomes, "owned native database deletion", () =>
    retirementBounded(
      cleanup.evaluate(retirementDeleteDatabase, attempt),
      "owned native database deletion",
    ),
  );
  await retirementStep(outcomes, "database cleanup page destruction", () =>
    retirementBounded(cleanup.close(), "database cleanup page destruction"),
  );
  retirementFinish(outcomes);
  return { database: attempt, lockReleased: true, deleted: true };
}
async function retirementLockAvailable(context: BrowserContext, attempt: string) {
  const observer = await context.newPage();
  const outcomes: RetirementPhase[] = [];
  const result = await retirementStep(outcomes, "native lock observation", async () => {
    await observer.goto(origin);
    return observer.evaluate(
      (database) =>
        navigator.locks.request(
          `bun-wasm:filesystem:indexeddb:${database}`,
          { ifAvailable: true },
          (lock) => lock !== null,
        ),
      attempt,
    );
  });
  await retirementStep(outcomes, "lock observer page destruction", () =>
    retirementBounded(observer.close(), "lock observer page destruction"),
  );
  retirementFinish(outcomes);
  if (result.status === "fulfilled") return result.value;
  throw result.reason;
}
async function retirementCloseOriginal(target: RetirementTarget): Promise<RetirementPhase[]> {
  const label = `original target ${target.index} ${target.observed?.role ?? "unobserved"}`;
  const request = target.closed
    ? undefined
    : retirementAttempt(() =>
        retirementBounded(
          target.worker.evaluate(() => close()),
          `${label} close request`,
        ),
      );
  const joining = retirementAttempt(() => retirementBounded(target.close, `${label} close join`));
  const requested = request ? await request : undefined;
  const joined = await joining;
  const outcomes: RetirementPhase[] = requested
    ? [{ phase: `${label} close request`, outcome: requested }]
    : [];
  return outcomes.concat([{ phase: `${label} close join`, outcome: joined }]);
}
async function retirementCleanup(
  context: BrowserContext,
  page: Page,
  targets: RetirementTarget[],
  attempt: string,
  outcomes: RetirementPhase[],
) {
  const closed = await Promise.all(targets.map(retirementCloseOriginal));
  outcomes.push(...closed.flat());
  await retirementStep(outcomes, "original page destruction", () =>
    retirementBounded(page.close(), "original page destruction"),
  );
  const cleanup = await retirementStep(outcomes, "cleanup page and native database", () =>
    retirementBounded(
      retirementStorageCleanup(context, attempt),
      "cleanup page and native database",
    ),
  );
  console.log(
    `Runtime retirement cleanup receipt: ${JSON.stringify({ attempt, targets: targets.map(retirementTargetReceipt), cleanup: retirementPhaseReceipt({ phase: "storage", outcome: cleanup }) })}`,
  );
}
async function inspectRetirementArm(
  context: BrowserContext,
  page: Page,
  targets: RetirementTarget[],
  attempt: string,
  fail: boolean,
): Promise<void> {
  await page.goto(origin);
  const result = await page.evaluate(
    async (options) => {
      const source = "/runtime-retirement.js";
      const control: typeof import("./runtime-retirement-browser") = await import(source);
      const observe = Reflect.get(globalThis, "retirementObserveOriginals");
      if (typeof observe !== "function") throw new Error("Missing original-worker observer");
      return control.runtimeRetirementControl(options, async () => {
        await observe();
      });
    },
    { attempt, fail },
  );
  if (!fail)
    await retirementBounded(
      Promise.all(targets.map((target) => target.close)),
      "successful original targets close",
    );
  const native = await Promise.all(targets.map(inspectRetirementTarget));
  const lockAvailable = await retirementLockAvailable(context, attempt);
  console.log(
    `Runtime retirement native receipt: ${JSON.stringify({ attempt, result, native, lockAvailable })}`,
  );
  if (targets.length !== 2 || result.seeded?.toString() !== "17,83,0,211")
    throw new Error(
      "Runtime retirement native setup did not establish both original workers and seeded data",
    );
  if (
    !result.sameDisposal ||
    !result.originalFailure ||
    result.stops !== 1 ||
    !result.synchronousDisposed ||
    !result.methodsClosed ||
    result.stopsBeforeFence !== 0 ||
    result.stoppedInsideSection ||
    !result.revoked
  )
    throw new Error(
      "Runtime retirement original promise, failure or logical fence assertion failed",
    );
  if (
    fail &&
    (!result.guardHeld ||
      result.filesystemStatus === "disposed" ||
      lockAvailable ||
      result.ping !== "alive" ||
      native.some((target) => !target.live))
  )
    throw new Error(
      "Runtime retirement retention assertion failed: original filesystem/root/page ownership released after rejected stop",
    );
  if (
    !fail &&
    (result.guardHeld ||
      result.filesystemStatus !== "disposed" ||
      !lockAvailable ||
      native.some((target) => !target.closed))
  )
    throw new Error("Runtime retirement success cleanup assertion failed");
}
async function runRetirementArm(browser: Browser, name: string, fail: boolean): Promise<void> {
  const attempt = `waffle-retirement-${name}-${fail ? "failed" : "success"}-${crypto.randomUUID()}`;
  const context = await browser.newContext();
  let page: Page | undefined;
  let observation: ReturnType<typeof retirementTargets> | undefined;
  const primary = await retirementAttempt(async () => {
    page = await context.newPage();
    observation = retirementTargets(page);
    const originalObservation = observation;
    await page.exposeFunction("retirementObserveOriginals", () =>
      retirementObserveOriginals(originalObservation, attempt),
    );
    await retirementBounded(
      inspectRetirementArm(context, page, observation.targets, attempt, fail),
      "native case",
      45_000,
    );
  });
  const outcomes: RetirementPhase[] = [{ phase: "primary", outcome: primary }];
  if (page && observation) {
    const originalPage = page;
    const targets = observation.targets;
    await retirementStep(outcomes, "cleanup schedule", () =>
      retirementCleanup(context, originalPage, targets, attempt, outcomes),
    );
  }
  await retirementStep(outcomes, "test context destruction", () =>
    retirementBounded(context.close(), "test context destruction"),
  );
  retirementFinish(outcomes);
}
async function runRetirementCase(
  browser: Browser,
  name: string,
  passed: TestList,
  failures: string[],
) {
  try {
    await runRetirementArm(browser, name, false);
    await runRetirementArm(browser, name, true);
    passed.indexeddb.push(retirementLabel);
    console.log(`  PASS ${name} indexeddb: ${retirementLabel}`);
  } catch (error) {
    const failure = `${name} indexeddb: ${retirementLabel}\n${String(error)}`;
    failures.push(failure);
    console.error(`  FAIL ${failure}`);
  }
}
async function runBrowser(name: string, failures: string[]): Promise<void> {
  if (!(name in engines)) throw new Error(`Unknown browser: ${name}`);
  const engine = name as keyof typeof engines;
  // Firefox profiles cannot use the PC's VDO filesystem. Preserve the existing tmpfs policy.
  const previousTmp = process.env.TMPDIR;
  if (name === "firefox" && process.platform === "linux")
    process.env.TMPDIR = await lifecycle.directory(
      process.env.WAFFLE_BROWSER_SHM_ROOT ?? "/dev/shm",
      "waffle-ff-",
    );
  const browser = await lifecycle.launch(engine);
  try {
    const listed = await inWorker<TestList>(browser, { kind: "list" });
    const passed: TestList = { indexeddb: [], opfs: [] };
    let selected = 0;
    const cases = storageCases(listed).filter(
      ({ label }) =>
        !process.env.STORAGE_TEST_FILTER || label.includes(process.env.STORAGE_TEST_FILTER),
    );
    for (const { backend, label } of cases) {
      selected++;
      await runCase(browser, name, backend, label, passed, failures);
    }
    if (
      !process.env.STORAGE_TEST_FILTER ||
      retirementLabel.includes(process.env.STORAGE_TEST_FILTER)
    ) {
      selected++;
      await runRetirementCase(browser, name, passed, failures);
    }
    if (!selected)
      throw new Error(`No storage cases match ${JSON.stringify(process.env.STORAGE_TEST_FILTER)}`);
    console.log(
      `${name} ${browser.version()}: ${passed.indexeddb.length} IndexedDB and ${passed.opfs.length} OPFS storage tests passed`,
    );
  } finally {
    await lifecycle.closeBrowser(browser);
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
}
try {
  await lifecycle.init();
  origin = lifecycle.serve(
    {
      "/": "<!doctype html><title>Storage tests</title>",
      "/tests.js": await browserBundle(resolve(import.meta.dir, "storage-browser.ts")),
      "/fs-worker.js": await browserBundle(resolve(import.meta.dir, "../browser/fs-worker.ts")),
      "/open-fs-worker.js": await browserBundle(resolve(import.meta.dir, "storage-open-worker.ts")),
      "/worker.js": `(${storageWorker.toString()})();`,
      "/runtime-retirement.js": await browserBundle(
        resolve(import.meta.dir, "runtime-retirement-browser.ts"),
      ),
      "/retirement-consumer.js": await browserBundle(
        resolve(import.meta.dir, "fixtures/runtime-retirement-consumer.ts"),
      ),
    },
    Number(process.env.STORAGE_TEST_PORT ?? 0),
  );
  const failures: string[] = [];
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"])
    await runBrowser(name, failures);
  if (failures.length)
    throw new AggregateError(
      failures.map((message) => new Error(message)),
      `${failures.length} storage browser test(s) failed`,
    );
} finally {
  await lifecycle.close();
}
