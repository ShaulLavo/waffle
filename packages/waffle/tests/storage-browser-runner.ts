import { resolve } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { BrowserRunnerLifecycle, browserBundle, engines } from "./browser-runner-lifecycle.js";
import {
  formatNavigationServerEvent,
  NavigationDiagnostics,
  storageNavigate,
} from "./storage-navigation-diagnostics.js";

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
      profile = await lifecycle.directory(lifecycle.scratch, "webkit-opfs-profile-");
      context = await lifecycle.persistent("webkit", profile);
    } else context = await browser.newContext();
    const page = await context.newPage();
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
    return await page.evaluate(storageCase<T>, request);
  } finally {
    if (activeDiagnostics === diagnostics) activeDiagnostics = undefined;
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
