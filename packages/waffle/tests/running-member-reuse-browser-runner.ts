import { resolve } from "node:path";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";
import type { RunningMemberOptions } from "./running-member-reuse-browser.js";

// Plan group-futex-retirement, gap 1: a member terminated while running guest code must not
// write into pages the owner already handed to a live sibling. Measurement knobs:
// RUNNING_MEMBER_REPETITIONS (per engine and chunk size), RUNNING_MEMBER_HOLD_MS (delay
// between stopRequested() and stopped()), RUNNING_MEMBER_LOCK=1 (worker holds a Web Lock),
// RUNNING_MEMBER_STOP_CAP_MS (how long one terminated thread is watched), and
// RUNNING_MEMBER_SLEEPER_CAP_MS (measure how long a parked sleeper keeps its lock instead).
const sleeperCapMs = Number(process.env.RUNNING_MEMBER_SLEEPER_CAP_MS ?? 0);
const repetitions = Number(process.env.RUNNING_MEMBER_REPETITIONS ?? 12);
const holdMs = Number(process.env.RUNNING_MEMBER_HOLD_MS ?? 0);
const stopCapMs = Number(process.env.RUNNING_MEMBER_STOP_CAP_MS ?? 5_000);
const lock = process.env.RUNNING_MEMBER_LOCK === "1";
const pageSizes = [1, 4];
await runIsolatedPages({
  label: "running-member-reuse-browser",
  scratchRoot: resolve(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp"),
  scratchPrefix: "wrunning-member-",
  port: 0,
  sources: {
    "/tests.js": "running-member-reuse-browser.ts",
    "/worker.js": "fixtures/running-member-worker.ts",
  },
  names: process.argv.length > 2 ? process.argv.slice(2) : Object.keys(engines),
  async evaluate(page) {
    if (sleeperCapMs) {
      const report = await page.evaluate(
        async ({ repetitions, sleeperCapMs }) => {
          const path = "/tests.js";
          const fixture: typeof import("./running-member-reuse-browser.js") = await import(path);
          return fixture.sleeperLockHold(repetitions, sleeperCapMs);
        },
        { repetitions, sleeperCapMs },
      );
      console.log(JSON.stringify({ sleeperLockHold: report }));
      return report;
    }
    const reports = [];
    for (const pages of pageSizes) {
      const options: RunningMemberOptions = {
        repetitions,
        pages,
        scanMs: 5,
        quietMs: 50,
        stopCapMs,
        holdMs,
        lock,
      };
      const report = await page.evaluate(async (options) => {
        const path = "/tests.js";
        const fixture: typeof import("./running-member-reuse-browser.js") = await import(path);
        return fixture.runningMemberReuse(options);
      }, options);
      console.log(JSON.stringify({ runningMemberReuse: report }));
      if (report.runs !== repetitions) throw new Error(`ran ${report.runs} of ${repetitions}`);
      reports.push(report);
    }
    const hits = reports.reduce((sum, report) => sum + report.hits, 0);
    if (hits) throw new Error(`${hits} terminated-member writes reached a reused chunk`);
    return reports.map(({ pages, runs, hits }) => ({ pages, runs, hits }));
  },
});
