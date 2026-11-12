import {
  storageWorker,
  storageCase,
  type Backend,
  type WorkerRequest,
  type TestList,
} from "./page-runner/storage-worker.js";
import { resolve } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { BrowserRunnerLifecycle, browserBundle, engines } from "./browser-runner-lifecycle.js";
import {
  formatNavigationServerEvent,
  NavigationDiagnostics,
  storageNavigate,
} from "./storage-navigation-diagnostics.js";

function storageCases(listed: TestList) {
  return (["indexeddb", "opfs"] as const).flatMap((backend) =>
    listed[backend].map((label) => ({ backend, label })),
  );
}
if (process.argv[2] === "ios-safari") {
  const { nativeMain } = await import("./page-runner/native.js");
  const { storageAdapter } = await import("./page-runner/storage-host.js");
  process.exit(
    await nativeMain(storageAdapter, process.argv.slice(3), {
      filter: process.env.STORAGE_TEST_FILTER,
    }),
  );
}
const lifecycle = new BrowserRunnerLifecycle();
let origin = "",
  activeDiagnostics: NavigationDiagnostics | undefined,
  persistentShutdownFailed = false;
async function inWorker<T>(
  browser: Browser,
  request: WorkerRequest,
  persistent = false,
): Promise<T> {
  const diagnostics = new NavigationDiagnostics();
  activeDiagnostics = diagnostics;
  let context: BrowserContext | undefined, profile: string | undefined;
  try {
    if (persistent) {
      profile = await lifecycle.directory(lifecycle.scratch, "webkit-storage-profile-");
      context = await lifecycle.persistent("webkit", profile);
    } else context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.text().startsWith("Storage usage measurement ")) console.log(message.text());
    });
    const caseName =
      request.kind === "list"
        ? `${browser.browserType().name()} list storage cases`
        : `${browser.browserType().name()} ${request.backend}: ${request.label}`;
    await storageNavigate({
      diagnostics,
      page,
      context,
      browser: context.browser() ?? browser,
      target: origin,
      caseName,
      report: console.error,
    });
    const cdp =
      browser.browserType().name() === "chromium" ? await context.newCDPSession(page) : undefined;
    await page.exposeFunction("storageQuota", async (action: "cap" | "reset") => {
      if (!cdp) return false;
      const usage = await page.evaluate(
        async () => (await navigator.storage.estimate()).usage ?? 0,
      );
      await cdp.send("Storage.overrideQuotaForOrigin", {
        origin,
        ...(action === "cap" ? { quotaSize: Math.max(1, usage - 1) } : {}),
      });
      return true;
    });
    // Bound Chromium's cached initial quota grant before the first IndexedDB connection.
    if (
      cdp &&
      request.kind === "run" &&
      request.label === "idle workspace full origin open and read"
    )
      await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 8 * 1024 * 1024 });
    return await page.evaluate(storageCase<T>, request);
  } finally {
    if (activeDiagnostics === diagnostics) activeDiagnostics = undefined;
    if (context) await closeStorageContext(context, persistent);
    if (profile) await lifecycle.removeDirectory(profile);
  }
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
    const returned = await inWorker<string>(browser, { kind: "run", backend, label }, persistent);
    if (returned !== label)
      throw new Error(`Wrong Worker label: ${JSON.stringify(returned)}, expected ${label}`);
    passed[backend].push(label);
    console.log(`  PASS ${name} ${backend}: ${label}`);
  } catch (error) {
    const failure = `${name} ${backend}: ${label}\n${String(error)}`;
    failures.push(failure);
    console.error(`  FAIL ${failure}`);
    if (persistentShutdownFailed) throw error;
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
    },
    Number(process.env.STORAGE_TEST_PORT ?? 0),
    () => {
      const diagnostics = activeDiagnostics;
      return (event) => diagnostics?.record(formatNavigationServerEvent(event));
    },
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
