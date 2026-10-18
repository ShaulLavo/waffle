import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserContext } from "playwright";
import { installClientWorker } from "./process-recycling-browser.js";
import {
  closeBrowserResources,
  stopBrowserResource,
} from "./process-recycling-browser-runner-control.js";

// Run from the repository with Bun. Defaults to the full Chromium/Firefox/WebKit matrix.
// PROCESS_SCRATCH_ROOT selects the parent of a disposable waffle-slot-recycling-* tree.
// PROCESS_TEST_FILTER selects case labels without changing the browser matrix.
const engines = { chromium, firefox, webkit };
type Engine = keyof typeof engines;
type BrowserOwner = {
  name: Engine;
  creation: Promise<Browser>;
  stopped: boolean;
  stopping?: Promise<void>;
};
type ContextOwner = {
  creation: Promise<BrowserContext>;
  stopped: boolean;
  stopping?: Promise<void>;
};

// Register ownership and teardown before allocations (including unresolved launch promises).
const browsers = new Set<BrowserOwner>();
const contexts = new Set<ContextOwner>();
let scratchCreation: Promise<string> | undefined;
let firefoxScratchCreation: Promise<string> | undefined;
let scratch: string | undefined;
let firefoxScratch: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cleaning: Promise<void> | undefined;
const previousTmp = process.env.TMPDIR;
function active(): void {
  if (cleaning) throw new Error("Process browser runner is shutting down");
}
function stopContext(owner: ContextOwner): Promise<void> {
  return stopBrowserResource(contexts, owner);
}
function stopBrowser(owner: BrowserOwner): Promise<void> {
  return stopBrowserResource(browsers, owner);
}
function cleanup(): Promise<void> {
  return (cleaning ??= (async () => {
    const errors: unknown[] = [];
    try {
      errors.push(...(await closeBrowserResources(contexts, browsers)));
    } finally {
      try {
        server?.stop(true);
      } catch (error) {
        errors.push(error);
      }
      scratch ??= await scratchCreation?.catch(() => undefined);
      firefoxScratch ??= await firefoxScratchCreation?.catch(() => undefined);
      try {
        if (browsers.size === 0) {
          // Closing a browser also closes a context whose own close call failed.
          contexts.clear();
          for (const directory of [scratch, firefoxScratch]) {
            if (!directory) continue;
            try {
              await rm(directory, { recursive: true, force: true });
            } catch (error) {
              errors.push(error);
            }
          }
        } else {
          console.error(
            `Browser shutdown unconfirmed; retaining owned scratch ${scratch} and Firefox profile parent ${firefoxScratch}`,
          );
        }
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
      }
    }
    if (errors.length) throw new AggregateError(errors, "Process browser cleanup failed");
  })());
}
const onSignal = (signal: string) => {
  console.error(`Process browser runner received ${signal}`);
  void cleanup()
    .catch((error) => console.error(error))
    .finally(() => process.exit(1));
};
const interrupt = () => onSignal("SIGINT"),
  terminate = () => onSignal("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
const deadline = setTimeout(() => onSignal("deadline exceeded"), 600_000);

async function inPage<T>(browser: Browser, label?: string): Promise<T> {
  active();
  // Promise ownership is recorded synchronously, before awaiting context creation.
  const owner: ContextOwner = { creation: browser.newContext(), stopped: false };
  contexts.add(owner);
  try {
    const context = await owner.creation;
    active();
    const page = await context.newPage();
    active();
    page.on("pageerror", (error) => console.error(`Process page error: ${error.message}`));
    await page.goto(`http://127.0.0.1:${server!.port}/`);
    active();
    return (await page.evaluate(async (label?: string) => {
      const modulePath = "/tests.js";
      const tests = (await import(modulePath)) as typeof import("./process-recycling-browser.js");
      return label === undefined ? tests.processBrowserCases() : tests.runProcessBrowserCase(label);
    }, label)) as T;
  } finally {
    // Context teardown also terminates Workers if a page crashes before its fixture finally.
    await stopContext(owner);
  }
}

try {
  const names = process.argv.slice(2);
  const selected: Engine[] = [];
  for (const name of names.length ? names : Object.keys(engines)) {
    if (!Object.hasOwn(engines, name)) throw new Error(`Unknown browser: ${name}`);
    selected.push(name as Engine);
  }
  const scratchRoot = resolve(process.env.PROCESS_SCRATCH_ROOT ?? "/work/tmp");
  // Pre-existing directories, services, browser installations and caches are borrowed.
  // Only the named mkdtemp directories, port-0 server and launched browsers are ours.
  console.log(
    JSON.stringify({
      resources: "process-browser",
      borrowed: { scratchRoot, browsers: selected },
      owned: [
        "waffle-slot-recycling-* scratch",
        "optional tmpfs Firefox profile parent",
        "ephemeral loopback port 0",
        "headless browsers, contexts, Workers and RPC timers",
      ],
    }),
  );
  await mkdir(scratchRoot, { recursive: true });
  active();
  scratchCreation = mkdtemp(resolve(scratchRoot, "waffle-slot-recycling-"));
  scratch = await scratchCreation;
  active();
  process.env.TMPDIR = scratch;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "process-recycling-browser.ts")],
    target: "browser",
  });
  active();
  if (!build.success) throw new AggregateError(build.logs, "Process browser fixture bundle failed");
  const script = build.outputs[0]!;
  const worker = `(${installClientWorker.toString()})();`;
  const cellWorkerBuild = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/browser-cell-clone.ts")],
    target: "browser",
  });
  if (!cellWorkerBuild.success)
    throw new AggregateError(cellWorkerBuild.logs, "Cell clone Worker bundle failed");
  const cellFsBuild = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../browser/fs-worker.ts")],
    target: "browser",
  });
  if (!cellFsBuild.success)
    throw new AggregateError(cellFsBuild.logs, "Cell clone filesystem Worker bundle failed");
  const startupWorkerBuild = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/startup-diagnostic-worker.ts")],
    target: "browser",
  });
  if (!startupWorkerBuild.success)
    throw new AggregateError(startupWorkerBuild.logs, "Startup diagnostic Worker bundle failed");
  const quietWorkerBuild = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/start-failure-quiet-worker.ts")],
    target: "browser",
  });
  if (!quietWorkerBuild.success)
    throw new AggregateError(quietWorkerBuild.logs, "Quiet startup failure Worker bundle failed");
  const diagnosticWorkerBuild = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "child-diagnostic-worker.ts")],
    target: "browser",
  });
  if (!diagnosticWorkerBuild.success)
    throw new AggregateError(diagnosticWorkerBuild.logs, "Runtime diagnostic Worker bundle failed");
  const pipeFilestatBuild = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/pipe-filestat-worker.ts")],
    target: "browser",
  });
  if (!pipeFilestatBuild.success)
    throw new AggregateError(pipeFilestatBuild.logs, "Pipe filestat Worker bundle failed");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const headers = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Content-Type": path === "/" ? "text/html" : "text/javascript",
      };
      if (path === "/pipe-filestat-worker.js")
        return new Response(pipeFilestatBuild.outputs[0]!, { headers });
      if (path === "/start-failure-quiet-worker.js")
        return new Response(quietWorkerBuild.outputs[0]!, { headers });
      if (path === "/startup-diagnostic-worker.js")
        return new Response(startupWorkerBuild.outputs[0]!, { headers });
      if (path === "/child-diagnostic-worker.js")
        return new Response(diagnosticWorkerBuild.outputs[0]!, { headers });
      if (path === "/cell-worker.js") return new Response(cellWorkerBuild.outputs[0]!, { headers });
      if (path === "/cell-fs-worker.js") return new Response(cellFsBuild.outputs[0]!, { headers });
      if (path === "/tests.js") return new Response(script, { headers });
      if (path === "/process-client.js") return new Response(worker, { headers });
      if (path === "/")
        return new Response("<!doctype html><title>Process transport tests</title>", { headers });
      return new Response("Not found", { status: 404, headers });
    },
  });
  const failures: string[] = [];
  for (const name of selected) {
    active();
    // Firefox profiles on /work's VDO filesystem fail independently of process transport.
    // Put only Firefox's disposable profile/temp files in task-owned tmpfs, not downloads.
    if (name === "firefox" && process.platform === "linux" && !firefoxScratch) {
      firefoxScratchCreation = mkdtemp("/dev/shm/waffle-slot-recycling-firefox-");
      firefoxScratch = await firefoxScratchCreation;
      active();
    }
    process.env.TMPDIR = name === "firefox" && firefoxScratch ? firefoxScratch : scratch;
    const owner: BrowserOwner = {
      name,
      creation: engines[name].launch({
        headless: true,
        downloadsPath: scratch,
        tracesDir: scratch,
      }),
      stopped: false,
    };
    browsers.add(owner);
    try {
      const browser = await owner.creation;
      active();
      const listed = await inPage<string[]>(browser);
      const labels = listed.filter(
        (label) =>
          !process.env.PROCESS_TEST_FILTER || label.includes(process.env.PROCESS_TEST_FILTER),
      );
      if (!labels.length)
        throw new Error(
          `No process cases match ${JSON.stringify(process.env.PROCESS_TEST_FILTER)}`,
        );
      let passed = 0;
      for (const label of labels) {
        active();
        try {
          await inPage<string>(browser, label);
          passed++;
          console.log(`  PASS ${name}: ${label}`);
        } catch (error) {
          const detail =
            error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
          failures.push(`${name}: ${label}\n${detail}`);
          console.error(`  FAIL ${failures.at(-1)}`);
        }
      }
      console.log(
        `${name} ${browser.version()}: ${passed}/${labels.length} process browser cases passed`,
      );
    } catch (error) {
      failures.push(`${name} setup: ${String(error)}`);
      console.error(`  FAIL ${failures.at(-1)}`);
    } finally {
      await stopBrowser(owner);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures.map((message) => new Error(message)),
      `${failures.length} process browser failure(s)`,
    );
} finally {
  clearTimeout(deadline);
  try {
    await cleanup();
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
