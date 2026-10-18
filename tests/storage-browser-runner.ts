import { resolve } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { BrowserRunnerLifecycle, browserBundle, engines } from "./browser-runner-lifecycle.js";

type Backend = "indexeddb" | "opfs";
type WorkerRequest = { kind: "list" } | { kind: "run"; backend: Backend; label: string };
type TestList = Record<Backend, string[]>;

// Bun strips the types before toString(): the worker has TypeScript source, not handwritten JS.
function storageWorker(): void {
  globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    try {
      const modulePath = "/tests.js";
      const tests = await import(modulePath) as typeof import("./storage-browser");
      // The runner owns this route; imported backend suites do not assume one exists.
      const suites = { indexeddb: tests.storageTests("/fs-worker.js", "/open-fs-worker.js"), opfs: tests.opfsStorageTests("/fs-worker.js") };
      if (event.data.kind === "list") {
        globalThis.postMessage({ result: {
          indexeddb: suites.indexeddb.map(test => test.label), opfs: suites.opfs.map(test => test.label),
        } });
      } else {
        const { backend, label } = event.data;
        const test = suites[backend].find(test => test.label === label);
        if (!test) throw new Error(`Unknown ${backend} storage test: ${label}`);
        await test.run();
        globalThis.postMessage({ result: label });
      }
    } catch (error) {
      // WebKit's stack contains locations only: never let it replace the actual error message.
      const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
      const environment = {
        secureContext: globalThis.isSecureContext, crossOriginIsolated: globalThis.crossOriginIsolated,
        getDirectory: typeof navigator.storage?.getDirectory,
        syncAccess: typeof FileSystemFileHandle === "undefined" ? "undefined"
          : typeof (FileSystemFileHandle.prototype as FileSystemFileHandle & { createSyncAccessHandle?: unknown }).createSyncAccessHandle,
      };
      globalThis.postMessage({ error: `${detail}\nWorker environment: ${JSON.stringify(environment)}` });
    }
  };
}

const lifecycle = new BrowserRunnerLifecycle();
let origin = "", persistentShutdownFailed = false;
async function inWorker<T>(browser: Browser, request: WorkerRequest, persistent = false): Promise<T> {
  let context: BrowserContext | undefined, profile: string | undefined;
  try {
    if (persistent) {
      profile = await lifecycle.directory(lifecycle.scratch, "webkit-opfs-profile-");
      context = await lifecycle.persistent("webkit", profile);
    } else context = await browser.newContext();
    const page = await context.newPage(); await page.goto(origin);
    return await page.evaluate((request: WorkerRequest) => new Promise<T>((resolve, reject) => {
      const worker = new Worker("/worker.js", { type: "module" });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error("storage case worker timed out")); }, 45_000);
      const finish = () => { clearTimeout(timeout); worker.terminate(); };
      worker.onmessage = event => { finish(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result); };
      worker.onerror = event => { finish(); reject(new Error(event.message)); };
      worker.onmessageerror = () => { finish(); reject(new Error("Could not decode storage worker response")); };
      worker.postMessage(request);
    }), request);
  } finally {
    if (context) {
      try { if (persistent) await lifecycle.closeContext(context); else await context.close(); }
      catch (error) { if (persistent) persistentShutdownFailed = true; throw error; }
    }
    if (profile) await lifecycle.removeDirectory(profile);
  }
}
try {
  await lifecycle.init();
  origin = lifecycle.serve({
    "/": "<!doctype html><title>Storage tests</title>",
    "/tests.js": await browserBundle(resolve(import.meta.dir, "storage-browser.ts")),
    "/fs-worker.js": await browserBundle(resolve(import.meta.dir, "../browser/fs-worker.ts")),
    "/open-fs-worker.js": await browserBundle(resolve(import.meta.dir, "storage-open-worker.ts")),
    "/worker.js": `(${storageWorker.toString()})();`,
  }, Number(process.env.STORAGE_TEST_PORT ?? 0));
  const failures: string[] = [];
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"]) {
    if (!(name in engines)) throw new Error(`Unknown browser: ${name}`);
    const engine = name as keyof typeof engines;
    // Firefox profiles cannot use the PC's VDO filesystem. Preserve the existing tmpfs policy.
    const previousTmp = process.env.TMPDIR;
    if (name === "firefox" && process.platform === "linux") process.env.TMPDIR = await lifecycle.directory("/dev/shm", "waffle-ff-");
    const browser = await lifecycle.launch(engine);
    try {
      const listed = await inWorker<TestList>(browser, { kind: "list" });
      const passed: TestList = { indexeddb: [], opfs: [] }; let selected = 0;
      for (const backend of ["indexeddb", "opfs"] as const) for (const label of listed[backend]) {
        if (process.env.STORAGE_TEST_FILTER && !label.includes(process.env.STORAGE_TEST_FILTER)) continue;
        selected++;
        const persistent = name === "webkit" && backend === "opfs";
        try {
          await inWorker<string>(browser, { kind: "run", backend, label }, persistent);
          passed[backend].push(label); console.log(`  PASS ${name} ${backend}: ${label}`);
        } catch (error) {
          const failure = `${name} ${backend}: ${label}\n${String(error)}`;
          failures.push(failure); console.error(`  FAIL ${failure}`);
          if (persistentShutdownFailed) throw error;
        }
      }
      if (!selected) throw new Error(`No storage cases match ${JSON.stringify(process.env.STORAGE_TEST_FILTER)}`);
      console.log(`${name} ${browser.version()}: ${passed.indexeddb.length} IndexedDB and ${passed.opfs.length} OPFS storage tests passed`);
    } finally {
      await lifecycle.closeBrowser(browser);
      if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    }
  }
  if (failures.length) throw new AggregateError(failures.map(message => new Error(message)), `${failures.length} storage browser test(s) failed`);
} finally { await lifecycle.close(); }
