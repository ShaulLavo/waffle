import { join } from "node:path";
import { runPageSuite, type HostCase, type SuiteAdapter } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { record } from "./protocol.js";

export const hostControlModes = [
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
];
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("HOST_FULL_EQUALITY_FAILED");
}
async function drive(host: HostCase, mode: string): Promise<unknown> {
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
  const adapter: SuiteAdapter<{ mode: string }> = {
    suite: "host-control",
    inventory: () => [
      {
        id: "host",
        label: "selected host",
        request: () => ({ mode }),
        drive: (host) => drive(host, mode),
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
      check() {},
    },
    assets: async () => ({}),
    budgets: () => ({
      hello: 4000,
      heartbeat: 2000,
      case: ["separate-hook", "admission-ack", "late-init"].includes(mode) ? 150 : 4000,
      teardown: ["disposal-hang", "sync-hook"].includes(mode)
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
      scratchRoot: process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp",
      filter: "selected host",
      assets: { "/page.js": built.outputs[0] },
    },
  );
  const infra = ["disposal-hang", "late-error", "late-init", "final-ack"].includes(mode);
  const ordinary = [
    "assertion",
    "setup-fail",
    "expression",
    "disposal-fail",
    "array-mismatch",
    "thenable",
    "sync-hook",
  ].includes(mode);
  if (result.exit !== (infra ? 2 : 4))
    throw new Error(`Host ${mode} wrong exit ${JSON.stringify(result)}`);
  if (!infra && (result.failures.length || !result.runComplete))
    throw new Error(`Host ${mode} infrastructure failure ${JSON.stringify(result)}`);
  if (!infra && result.outcomes.host?.status !== (ordinary ? "fail" : "pass"))
    throw new Error(`Host ${mode} wrong outcome ${JSON.stringify(result)}`);
  if (result.outcomes.unselected?.status !== "pending" || result.omitted.join() !== "unselected")
    throw new Error("Host selection changed inventory");
  if (Object.values(result.cleanup).some((step) => record(step) && step.status === "unconfirmed"))
    throw new Error(`Host ${mode} cleanup unconfirmed ${JSON.stringify(result.cleanup)}`);
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
