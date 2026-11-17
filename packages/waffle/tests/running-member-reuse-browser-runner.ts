import { resolve } from "node:path";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";
import type { RunningMemberOptions } from "./running-member-reuse-browser.js";

// Plan group-futex-retirement, gap 1: a member terminated while running guest code must not
// write into pages the owner already handed to a live sibling, and a member terminated while
// parked in futex_wait is reused at once. RUNNING_MEMBER_REPETITIONS sets runs per engine and
// chunk size. WebKit never stops a terminated busy guest, so each WebKit busy run leaves a
// spinning thread until page close: it runs fewer repetitions with a short proof wait.
const repetitions = Number(process.env.RUNNING_MEMBER_REPETITIONS ?? 6);
const pageSizes = [1, 4];

interface Report {
  readonly runs: number;
  readonly hits: number;
  readonly reusedBeforeProof?: number;
  readonly notQuarantined?: number;
  readonly proven?: number;
  readonly reusedAfterProof?: number;
  readonly reusedAtOnce?: number;
}

/** Chromium and Firefox must prove every busy exit; WebKit only must not reuse early. */
function failures(name: string, report: Report, proofRequired: boolean) {
  const found: string[] = [];
  const proven = report.proven ?? 0;
  if (report.reusedBeforeProof) found.push(`${report.reusedBeforeProof} reused before proof`);
  if (report.notQuarantined) found.push(`${report.notQuarantined} not quarantined`);
  if (report.hits) found.push(`${report.hits} terminated-member writes reached a reused chunk`);
  if (proofRequired && proven !== report.runs)
    found.push(`${report.runs - proven} exits never proven`);
  if (proven !== (report.reusedAfterProof ?? 0))
    found.push(`${proven - (report.reusedAfterProof ?? 0)} proven chunks not reused`);
  if (report.reusedAtOnce !== undefined && report.reusedAtOnce !== report.runs)
    found.push(`${report.runs - report.reusedAtOnce} parked chunks not reused at once`);
  return found.map((failure) => `${name}: ${failure}`);
}

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
    const engine = page.context().browser()?.browserType().name();
    const webkit = engine === "webkit";
    let found: string[] = [];
    const reports = [];
    for (const pages of pageSizes) {
      const options: RunningMemberOptions = {
        repetitions: webkit ? Math.min(repetitions, 2) : repetitions,
        pages,
        scanMs: 5,
        quietMs: 50,
        // Chromium proves a busy member's exit about 2 s after terminate(); this is a hang cap.
        proofCapMs: webkit ? 1_000 : 10_000,
      };
      const busy = await page.evaluate(async (options) => {
        const path = "/tests.js";
        const fixture: typeof import("./running-member-reuse-browser.js") = await import(path);
        return fixture.runningMemberReuse(options);
      }, options);
      console.log(JSON.stringify({ engine, runningMemberReuse: busy }));
      const parked = await page.evaluate(async (options) => {
        const path = "/tests.js";
        const fixture: typeof import("./running-member-reuse-browser.js") = await import(path);
        return fixture.parkedMemberReuse(options);
      }, options);
      console.log(JSON.stringify({ engine, parkedMemberReuse: parked }));
      // A guest that polls its checkpoint unwinds and frees its lock on every engine, WebKit too.
      const polling = await page.evaluate(
        async (options) => {
          const path = "/tests.js";
          const fixture: typeof import("./running-member-reuse-browser.js") = await import(path);
          return fixture.runningMemberReuse(options);
        },
        { ...options, repetitions, proofCapMs: 10_000, polling: true },
      );
      console.log(JSON.stringify({ engine, runningMemberReuse: polling }));
      for (const report of [busy, parked])
        if (report.runs !== options.repetitions)
          found.push(`ran ${report.runs} of ${options.repetitions}`);
      if (polling.runs !== repetitions) found.push(`ran ${polling.runs} of ${repetitions}`);
      found = found.concat(
        failures(`busy ${pages}`, busy, !webkit),
        failures(`parked ${pages}`, parked, false),
        failures(`polling ${pages}`, polling, true),
      );
      reports.push({ pages, busy: busy.runs, parked: parked.runs, polling: polling.runs });
    }
    if (found.length) throw new Error(found.join("; "));
    return reports;
  },
});
