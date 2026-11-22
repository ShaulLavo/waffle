import { resolve } from "node:path";
import type { ProcessStartStep } from "../browser/process-start.js";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";
import type { ProcessStartReport } from "./process-start-browser.js";

// docs/process-observation.md, "Start states", in real browsers. A normal start passes every
// step in order; a start whose worker script never answers stays at start-posted and can still be
// killed; a worker script that fails to load fails its start instead of hanging.
// Steps the page stamps itself. Worker bootstrap steps carry the worker's time and need only
// follow start-posted.
const order: readonly ProcessStartStep[] = [
  "launching",
  "worker-constructed",
  "start-posted",
  "worker-started",
  "memory-bound",
  "instantiated",
  "running",
];

/** Worker script requests held open until the page asks for their release. */
const held: Array<() => void> = [];
const release = () => {
  for (const answer of held.splice(0)) answer();
};

function failures(report: ProcessStartReport): string[] {
  const found: string[] = [];
  const normal = report.normal;
  if (normal?.step !== "running") found.push(`normal start reached ${normal?.step}`);
  const times = order.map((step) => normal?.at[step]);
  const missing = order.filter((_, index) => typeof times[index] !== "number");
  if (missing.length) found.push(`normal start missed ${missing.join(", ")}`);
  else if (times.some((time, index) => index > 0 && time! < times[index - 1]!))
    found.push(`normal start steps out of order: ${JSON.stringify(normal?.at)}`);
  const posted = normal?.at["start-posted"] ?? Infinity;
  for (const [index, snapshot] of report.stages.entries()) {
    const time = snapshot.at[snapshot.step] ?? -Infinity;
    const previous = report.stages[index - 1];
    if (
      time < (previous?.at[previous.step] ?? posted) ||
      time > (normal?.at["memory-bound"] ?? -Infinity)
    )
      found.push(`worker step ${snapshot.step} out of order: ${JSON.stringify(snapshot.at)}`);
    if (snapshot.at["memory-bound"] !== undefined)
      found.push(`memory came before ${snapshot.step}: ${JSON.stringify(snapshot.at)}`);
  }
  if (report.held?.step !== "start-posted") found.push(`held start reached ${report.held?.step}`);
  if (report.heldLater?.step !== "start-posted")
    found.push(`held start later reached ${report.heldLater?.step}`);
  if (report.heldKilled !== 9) found.push(`held start exited ${report.heldKilled}, not SIGKILL`);
  if (report.missing === 0) found.push("a worker script that failed to load exited 0");
  return found;
}

/** A process Worker's guest JavaScript sleeps through the runtime's wait, wrapped only on WebKit. */
function realmWaitFailures(report: ProcessStartReport, engine: string | undefined): string[] {
  const wait = report.realmWait;
  if (!wait?.installed) return ["the process Worker's Atomics.wait is not the runtime's wait"];
  if (wait.cooperative !== (engine === "webkit"))
    return [`the runtime's wait is ${wait.cooperative ? "" : "not "}cooperative on ${engine}`];
  return [];
}

await runIsolatedPages({
  label: "process-start-browser",
  scratchRoot: resolve(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp"),
  scratchPrefix: "wprocess-start-",
  port: 0,
  sources: {
    "/tests.js": "process-start-browser.ts",
    "/worker.js": "fixtures/process-start-worker.ts",
    "/fs-worker.js": "../browser/fs-worker.ts",
  },
  route(path, headers) {
    if (path === "/release-held") {
      release();
      return new Response("released", { headers });
    }
    if (path !== "/held-worker.js") return undefined;
    return new Promise<Response>((answer) => {
      held.push(() => answer(new Response("Not found", { status: 404, headers })));
    });
  },
  dispose: async () => release(),
  names: process.argv.length > 2 ? process.argv.slice(2) : Object.keys(engines),
  async evaluate(page) {
    const report = await page.evaluate(async () => {
      const path = "/tests.js";
      const fixture: typeof import("./process-start-browser.js") = await import(path);
      return fixture.processStarts();
    });
    const engine = page.context().browser()?.browserType().name();
    console.log(JSON.stringify({ engine, ...report }));
    const found = failures(report).concat(realmWaitFailures(report, engine));
    if (found.length) throw new Error(`${engine}: ${found.join("; ")}`);
    return { engine };
  },
});
