import { join } from "node:path";
import {
  runPageSuite,
  ownedDatabase,
  type HostCase,
  type SuiteAdapter,
} from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { record } from "./protocol.js";

export const hostControlModes = [
  "deadline-teardown",
  "query-deadline",
  "query-deadline-no-observer",
  "pass",
  "assertion",
  "setup-fail",
  "expression",
  "disposal-fail",
  "disposal-hang",
  "separate-hook",
  "array",
  "array-mismatch",
  "retry",
  "late-error",
  "thenable",
  "admission-ack",
  "verdict-delivery",
  "teardown-report",
  "late-init",
  "disposal-twice",
  "final-ack",
  "sync-hook",
  "large-errors",
  "interruption",
];
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("HOST_FULL_EQUALITY_FAILED");
}
async function queryDeadline(host: HostCase, mode: string): Promise<unknown> {
  const workspace = await host.allocateDatabase("host-query");
  const query = await host.script(`const q=new URLSearchParams(window.__queryInitial);
return {workspace:q.get('workspace'),test:q.get('test'),renderer:q.get('renderer'),opens:window.__queryOpens};`);
  equal(query, { workspace, test: "1", renderer: "canvas", opens: 0 });
  await host.script(`window.__queryDeadline={count:0,started:false,finished:false,events:[]};
const timer=window.setTimeout.bind(window);
${mode === "query-deadline-no-observer" ? "" : "window.setTimeout=function(fn,ms,...args){if(ms===8)window.__queryDeadline.count++;return timer(fn,ms,...args);};"}
window.setTimeout(()=>{},8);`);
  equal(await host.script("return window.__queryDeadline.count;"), 1);
  const pending = host.task(`const s=window.__queryDeadline;
s.started=true;s.events.push('start');
await new Promise(resolve=>{s.release=resolve;});
s.finished=true;s.events.push('end');`);
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while ((await host.script("return window.__queryDeadline.started;")) !== true)
    await host.sleep(10);
  await host.script("window.__queryDeadline.events.push('readiness');");
  host.setTimeout(3000);
  await host.sleep(1100);
  equal(settled, false);
  equal(await host.script("return window.__queryDeadline.finished;"), false);
  host.setTimeout(2200);
  await host.script("const s=window.__queryDeadline;s.events.push('release');s.release();");
  await pending;
  equal(await host.script("return window.__queryDeadline.events;"), [
    "start",
    "readiness",
    "release",
    "end",
  ]);
  equal(await host.script("return window.__queryDeadline.count;"), 1);
  return { ok: true };
}
async function drive(host: HostCase, mode: string): Promise<unknown> {
  if (mode.startsWith("query-deadline")) return queryDeadline(host, mode);
  if (mode === "deadline-teardown") host.setTimeout(100_000);
  if (host.signal.aborted || host.remainingMs() <= 0) throw new Error("Host clock unavailable");
  if (mode === "setup-fail") await host.task("throw new Error('SETUP_FAILURE');");
  if (mode === "late-init")
    await host.task(
      "await new Promise(resolve => setTimeout(resolve, 300)); window.__hostFixture = {value:7,disposed:0}; window.__lateWorker = new Worker(URL.createObjectURL(new Blob(['onmessage=()=>{}'])));",
    );
  else
    await host.task("window.__hostFixture = { value: 7, disposed: 0 }; await Promise.resolve();");
  if (mode === "admission-ack") {
    if (host.remainingMs() < 120) throw new Error("Admission consumed original setup allowance");
    await host.sleep(70);
  }
  if (mode === "disposal-twice") await host.task("window.__hostFixture.disposed++;");
  equal(await host.script("return window.__hostFixture.value;"), 7);
  if (mode === "assertion" || mode === "disposal-fail") throw new Error("PRIMARY_ASSERTION");
  if (mode === "large-errors") throw new Error('😀\u0000"\\'.repeat(16_384));
  if (mode === "expression") await host.script("throw new Error('KNOWN_EXPRESSION_FAILURE');");
  if (mode === "thenable") await host.script("return Promise.resolve(1);");
  if (mode === "separate-hook") await host.sleep(90);
  if (mode === "array" || mode === "array-mismatch") {
    const expected = Array.from({ length: 196608 }, (_, index) => index % 251);
    const actual = await host.script(
      `const a = Array.from({length:196608},(_,i)=>i%251); ${mode === "array-mismatch" ? "a[123456] = -1;" : ""} return a;`,
    );
    equal(actual, expected);
  }
  if (mode === "retry") {
    await host.script(`window.__delays = []; window.__waits = [];
const timer = window.setTimeout.bind(window), wait = Atomics.waitAsync.bind(Atomics);
window.setTimeout = function(fn, ms, ...args) { window.__delays.push(ms); return timer(fn,ms,...args); };
Atomics.waitAsync = function(...args) { const value = wait(...args); window.__waits.push(value.async); return value; };
const word = new Int32Array(new SharedArrayBuffer(4)); Atomics.waitAsync(word,0,0); Atomics.notify(word,0);
window.setTimeout(()=>{},8);`);
    await host.task("await Promise.resolve();");
    equal(await host.script("return window.__delays;"), [8]);
    equal(await host.script("return window.__waits;"), [true]);
  }
  return { ok: true };
}
const sharedDeadlineModes = ["verdict-delivery", "teardown-report", "sync-hook"];
type DeadlineResult = Pick<
  Awaited<ReturnType<typeof runPageSuite>>,
  "results" | "failures" | "runComplete"
>;
export function checkTeardownDeadline(result: DeadlineResult): void {
  if (JSON.stringify(result.results).includes('"status":"timeout"')) return;
  const host = result.results.host;
  const failure = result.failures[0];
  // Host waiting and the page hook share one cutoff. The host can stop before
  // the page's timeout report arrives, leaving the initial teardown snapshot.
  if (
    record(host) &&
    record(host.body) &&
    host.body.status === "pass" &&
    record(host.teardown) &&
    host.teardown.status === "not-entered" &&
    !result.runComplete &&
    result.failures.length === 1 &&
    failure?.group === "host" &&
    failure.category === "host" &&
    failure.detail.includes("timed out")
  )
    return;
  throw new Error("Body timeout extension changed the independent teardown clock");
}
function sharedDeadlineControl(
  mode: string,
  result: Awaited<ReturnType<typeof runPageSuite>>,
): void {
  if (!sharedDeadlineModes.includes(mode)) return;
  const timedOut = result.failures.some(
    (failure) => failure.category === "host" && failure.detail.includes("timed out"),
  );
  if (result.runComplete || !timedOut)
    throw new Error(`Host ${mode} did not enforce its shared teardown deadline`);
}
export async function hostControl(
  engine: "chromium" | "webkit",
  mode: string,
  root: string,
): Promise<void> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "host-drive-control-page.ts")],
    target: "browser",
    define: { HOST_CONTROL: JSON.stringify(mode) },
  });
  if (!built.success || !built.outputs[0])
    throw new AggregateError(built.logs, "Host control bundle");
  const interrupted = new AbortController();
  const adapter: SuiteAdapter<{ mode: string }> = {
    suite: "host-control",
    inventory: () => [
      {
        id: "host",
        label: "selected host",
        request: () => ({ mode }),
        query: mode.startsWith("query-deadline")
          ? (run) => ({ test: "1", renderer: "canvas", workspace: `host-query-${run}` })
          : undefined,
        drive: async (host) => {
          if (mode !== "interruption") return drive(host, mode);
          await host.task("window.__hostFixture = {value:7,disposed:0};");
          interrupted.abort("CONTROL_INTERRUPTION");
          return true;
        },
      },
      {
        id: "unselected",
        label: "do not execute",
        request: () => ({ mode }),
        drive: async () => {
          throw new Error("UNSELECTED_CALLBACK");
        },
      },
    ],
    policy: {
      listIds(value) {
        if (!record(value) || !Array.isArray(value.ids)) throw new Error("Bad inventory");
        return value.ids;
      },
      requireResult: true,
      allocation: mode.startsWith("query-deadline") ? ownedDatabase("host-query") : undefined,
      check() {},
    },
    assets: async () => ({}),
    budgets: () => ({
      hello: 4000,
      heartbeat: 2000,
      case: mode.startsWith("query-deadline")
        ? 1000
        : ["separate-hook", "admission-ack", "late-init"].includes(mode)
          ? 150
          : 4000,
      teardown: ["disposal-hang", "sync-hook", "deadline-teardown"].includes(mode)
        ? 60
        : ["verdict-delivery", "teardown-report"].includes(mode)
          ? 120
          : 2000,
      caseDocument: 15_000,
      group: 5000,
      run: 30_000,
    }),
  };
  const result = await runPageSuite(
    adapter,
    (scratch) => new HostControlDriver(engine, scratch, mode),
    {
      resultPath: join(root, `host-${mode}.json`),
      signal: interrupted.signal,
      scratchRoot: process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp",
      filter: "selected host",
      assets: { "/page.js": built.outputs[0] },
    },
  );
  const infra = [
    "disposal-hang",
    "late-error",
    "late-init",
    "final-ack",
    "interruption",
    "deadline-teardown",
    "verdict-delivery",
    "teardown-report",
    "sync-hook",
  ].includes(mode);
  const ordinary = [
    "query-deadline-no-observer",
    "assertion",
    "setup-fail",
    "expression",
    "disposal-fail",
    "array-mismatch",
    "thenable",
    "large-errors",
  ].includes(mode);
  if (result.exit !== (infra ? 2 : 4))
    throw new Error(`Host ${mode} wrong exit ${JSON.stringify(result)}`);
  sharedDeadlineControl(mode, result);
  if (!infra && (result.failures.length || !result.runComplete))
    throw new Error(`Host ${mode} infrastructure failure ${JSON.stringify(result)}`);
  if (!infra && result.outcomes.host?.status !== (ordinary ? "fail" : "pass"))
    throw new Error(`Host ${mode} wrong outcome ${JSON.stringify(result)}`);
  if (result.outcomes.unselected?.status !== "pending" || result.omitted.join() !== "unselected")
    throw new Error("Host selection changed inventory");
  if (Object.values(result.cleanup).some((step) => record(step) && step.status === "unconfirmed"))
    throw new Error(`Host ${mode} cleanup unconfirmed ${JSON.stringify(result.cleanup)}`);
  if (mode === "deadline-teardown") checkTeardownDeadline(result);
  if (mode === "interruption" && !JSON.stringify(result.results).includes('"disposed":1'))
    throw new Error("Interrupted command skipped settled original teardown");
  if (mode === "disposal-twice" && !JSON.stringify(result.results).includes('"disposed":2'))
    throw new Error("Repeated disposal was memoized");
  if (mode === "late-init" && result.runComplete)
    throw new Error("Late module initialization resumed case work");
  if (mode === "disposal-fail" && !JSON.stringify(result.results).includes("PRIMARY_ASSERTION"))
    throw new Error("Primary body failure lost");
  if (mode === "setup-fail" && !JSON.stringify(result.results).includes('"disposed":0'))
    throw new Error("Partial setup skipped original teardown");
}

class HostControlDriver extends PlaywrightDriver {
  constructor(
    engine: "chromium" | "webkit",
    scratch: string,
    readonly mode: string,
  ) {
    super(engine, scratch);
  }
  override async script(source: string, signal: AbortSignal): Promise<unknown> {
    if (this.mode === "verdict-delivery" && source.includes("h.verdict(")) await Bun.sleep(200);
    return super.script(source, signal);
  }
}
