import { resolve } from "node:path";
import type { Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";
import type { RunningMemberOptions } from "./running-member-reuse-browser.js";

// Plan group-futex-retirement, gap 1: a member terminated while running guest code must not
// write into pages the owner already handed to a live sibling, and a member terminated while
// parked in futex_wait is reused at once. RUNNING_MEMBER_REPETITIONS sets runs per engine and
// chunk size. WebKit never stops a terminated busy guest that does not poll, so its threads
// spin until their page goes away: every busy case runs last for its chunk size, in a fresh
// browser context that is closed right after, and WebKit runs fewer of them with a short cap.
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
type Entry = "runningMemberReuse" | "parkedMemberReuse";

/** Chromium and Firefox must prove every busy exit; WebKit only must not reuse early. */
function failures(name: string, report: Report, expected: number, proofRequired: boolean) {
  const found: string[] = [];
  const proven = report.proven ?? 0;
  if (report.runs !== expected) found.push(`ran ${report.runs} of ${expected}`);
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

async function call(page: Page, entry: Entry, options: RunningMemberOptions): Promise<Report> {
  const report = await page.evaluate(
    async ({ entry, options }) => {
      const path = "/tests.js";
      const fixture: typeof import("./running-member-reuse-browser.js") = await import(path);
      return fixture[entry](options);
    },
    { entry, options },
  );
  console.log(JSON.stringify({ engine: engineOf(page), [entry]: report }));
  return report;
}

function engineOf(page: Page): string | undefined {
  return page.context().browser()?.browserType().name();
}

/** Spinning threads of a terminated busy guest go away with this context's page. */
async function inFreshContext(page: Page, run: (fresh: Page) => Promise<Report>) {
  const browser = page.context().browser();
  if (!browser) throw new Error("page has no browser");
  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    await navigateTestPage(fresh, page.url());
    return await run(fresh);
  } finally {
    await context.close();
  }
}

async function chunkSize(page: Page, pages: number): Promise<string[]> {
  const webkit = engineOf(page) === "webkit";
  const options: RunningMemberOptions = {
    repetitions,
    pages,
    scanMs: 5,
    quietMs: 50,
    // Chromium proves a busy member's exit about 2 s after terminate(); this is a hang cap.
    proofCapMs: 10_000,
  };
  const parked = await call(page, "parkedMemberReuse", options);
  // A guest that polls its checkpoint unwinds and frees its lock on every engine, WebKit too.
  const polling = await call(page, "runningMemberReuse", { ...options, polling: true });
  const busyOptions = webkit ? { ...options, repetitions: 2, proofCapMs: 1_000 } : options;
  const busy = await inFreshContext(page, (fresh) =>
    call(fresh, "runningMemberReuse", busyOptions),
  );
  return failures(`parked ${pages}`, parked, repetitions, false).concat(
    failures(`polling ${pages}`, polling, repetitions, true),
    failures(`busy ${pages}`, busy, busyOptions.repetitions, !webkit),
  );
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
    let found: string[] = [];
    for (const pages of pageSizes) found = found.concat(await chunkSize(page, pages));
    if (found.length) throw new Error(found.join("; "));
    return pageSizes.map((pages) => ({ pages, repetitions }));
  },
});
