import { resolve } from "node:path";
import type { Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";
import type { StopOrderOptions, StopOrderReport } from "./stop-order-browser.js";

// docs/host-abi.md, "Stop polling", through the real runtime and broker. Polling cases: a guest
// that calls runtime_proc.signal(0, 4) on each pass over 4 pages is stopped STOP_ORDER_REPETITIONS
// times (default 60, the load at which WebKit's page crashed in every run of the direct-worker
// case when terminate() came first), by a physical stop and by kill; every terminate() must come
// after the worker posted its exit, and the page must not crash. Busy case: a guest
// that never polls is still terminated, after the broker's bounded wait. WebKit keeps such a
// thread spinning after terminate() and after its page closes, so the busy case runs last, in
// its own browser.
const repetitions = Number(process.env.STOP_ORDER_REPETITIONS ?? 60);
const busyRepetitions = 2;
// The broker waits 1 s (STOP_UNWIND_MS); a lower bound only fails if it did not wait.
const busyWaitFloorMs = 500;

function engineOf(page: Page): string | undefined {
  return page.context().browser()?.browserType().name();
}

async function call(page: Page, options: StopOrderOptions): Promise<StopOrderReport> {
  const report = await page.evaluate(async (options) => {
    const path = "/tests.js";
    const fixture: typeof import("./stop-order-browser.js") = await import(path);
    return fixture.stopOrder(options);
  }, options);
  const sorted = report.killToTerminateMs.toSorted((a, b) => a - b);
  console.log(
    JSON.stringify({
      engine: engineOf(page),
      polling: options.polling,
      stop: options.stop,
      pages: options.pages,
      runs: report.runs,
      codes: report.codes,
      terminated: report.terminated,
      terminatedAfterExit: report.terminatedAfterExit,
      killToTerminateMs: { median: sorted[sorted.length >> 1], max: sorted.at(-1) },
    }),
  );
  return report;
}

function failures(
  name: string,
  report: StopOrderReport,
  expected: number,
  stop: StopOrderOptions["stop"],
): string[] {
  const found: string[] = [];
  if (report.runs !== expected) found.push(`ran ${report.runs} of ${expected}`);
  // A physical stop can revoke or cancel the process before it selects SIGKILL, so exit 1 can
  // win there (about 1 in 60, also before the stop order changed).
  if (stop === "kill" && report.killed !== report.runs)
    found.push(`${report.runs - report.killed} not SIGKILLed`);
  if (report.terminated !== report.runs)
    found.push(`${report.runs - report.terminated} workers never terminated`);
  return found.map((failure) => `${name}: ${failure}`);
}

async function polling(page: Page, stop: StopOrderOptions["stop"]): Promise<string[]> {
  const name = `polling ${stop}`;
  try {
    const report = await call(page, { repetitions, pages: 4, polling: true, stop });
    const found = failures(name, report, repetitions, stop);
    const early = report.terminated - report.terminatedAfterExit;
    if (early) found.push(`${name}: ${early} terminated before the guest reported exit`);
    return found;
  } catch (error) {
    return [`${name}: ${String(error)}`];
  }
}

/** WebKit never stops the terminated busy thread; closing its browser ends it. */
async function busy(page: Page): Promise<string[]> {
  const type = page.context().browser()?.browserType();
  if (!type) throw new Error("page has no browser");
  const browser = await type.launch({ headless: true });
  try {
    const fresh = await (await browser.newContext()).newPage();
    watchCrash(fresh);
    await navigateTestPage(fresh, page.url());
    const report = await call(fresh, {
      repetitions: busyRepetitions,
      pages: 4,
      polling: false,
      stop: "physical",
    });
    const found = failures("busy", report, busyRepetitions, "physical");
    const hurried = report.killToTerminateMs.filter((ms) => ms < busyWaitFloorMs).length;
    if (hurried) found.push(`busy: ${hurried} terminated without the bounded wait`);
    return found;
  } finally {
    await browser.close();
  }
}

const crashes: string[] = [];
function watchCrash(page: Page): void {
  page.on("crash", () => {
    crashes.push(`${engineOf(page)} page crashed`);
    console.error(JSON.stringify({ engine: engineOf(page), crash: true }));
  });
}

await runIsolatedPages({
  label: "stop-order-browser",
  scratchRoot: resolve(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp"),
  scratchPrefix: "wstop-order-",
  port: 0,
  sources: {
    "/tests.js": "stop-order-browser.ts",
    "/worker.js": "fixtures/stop-order-worker.ts",
    "/fs-worker.js": "../browser/fs-worker.ts",
  },
  names: process.argv.length > 2 ? process.argv.slice(2) : Object.keys(engines),
  async evaluate(page) {
    watchCrash(page);
    let found = await polling(page, "physical");
    found = found.concat(await polling(page, "kill"), await busy(page));
    found = crashes.splice(0).concat(found);
    if (found.length) throw new Error(found.join("; "));
    return { repetitions, busyRepetitions };
  },
});
