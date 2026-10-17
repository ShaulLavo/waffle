import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectRunnerCleanup, finishRunnerCleanup, runBrowserGate, type RunnerCleanup } from "./browser-engine-interruption";

function green() {
  const checks = ["quickjs", "jsc"].flatMap(engine => Array.from({ length: 12 }, (_, index) => ({
    engine, route: index < 5 ? "runtimeProcess" : "legacy", name: `proof-${index}`,
  }))).concat(Array.from({ length: 4 }, (_, index) => ({ engine: "browser", route: "legacy", name: `browser-${index}` })));
  return { ok: true, checks, outcomes: [{ ok: true, cleanup: { safe: true } }], pageErrors: [],
    cleanup: { safe: true, activeWorkers: 0 }, benchmarks: [{ engine: "quickjs" }, { engine: "jsc" }] };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const events: string[] = [], written: any[] = [];
  return { events, written, options: {
    names: ["chromium", "firefox", "webkit", "safari"], artifacts: [],
    runBrowser: async (name: string) => { events.push(`run:${name}`); return green(); },
    teardownBrowser: async (name: string) => { events.push(`close:${name}`); return { safe: true }; },
    cleanup: async () => { events.push("cleanup"); return { safe: true }; },
    writeReport: async (report: unknown) => { events.push("write"); written.push(report); },
    ...overrides,
  } };
}

test("WebDriver null for absent unsafeCleanup admits only an otherwise fully green result", async () => {
  const f = fixture({ runBrowser: async () => ({ ...green(), unsafeCleanup: null }) });
  const report = await runBrowserGate(f.options);
  expect(report.ok).toBe(true);
  expect(report.cleanup.safe).toBe(true);
  expect(report.unsafeCleanup).toBeUndefined();
  expect(report.reports).toHaveLength(4);
  expect(report.reports.every(result => result.ok && result.cleanup.safe)).toBe(true);
});
for (const unsafeCleanup of [false, "", 0, "unproved"]) {
  test(`non-null unsafeCleanup remains unsafe even when falsy: ${JSON.stringify(unsafeCleanup)}`, async () => {
    const f = fixture({ runBrowser: async () => ({ ...green(), unsafeCleanup }) });
    const report = await runBrowserGate(f.options);
    expect(report.ok).toBe(false);
    expect(report.cleanup.safe).toBe(false);
    expect(report.reports).toHaveLength(1);
    expect(report.unsafeCleanup).toBeDefined();
  });
}
for (const unsafe of [
  { cleanup: { safe: false, activeWorkers: 0 } },
  { outcomes: [{ ok: true, cleanup: { safe: false } }] },
]) {
  test(`null unsafeCleanup never hides unsafe page or outcome cleanup: ${JSON.stringify(unsafe)}`, async () => {
    const f = fixture({ runBrowser: async () => ({ ...green(), unsafeCleanup: null, ...unsafe }) });
    const report = await runBrowserGate(f.options);
    expect(report.ok).toBe(false);
    expect(report.cleanup.safe).toBe(false);
    expect(report.reports).toHaveLength(1);
  });
}
test("null unsafeCleanup never hides a failed functional outcome", async () => {
  const f = fixture({ runBrowser: async () => ({ ...green(), unsafeCleanup: null,
    outcomes: [{ ok: false, cleanup: { safe: true } }] }) });
  const report = await runBrowserGate(f.options);
  expect(report.ok).toBe(false);
  expect(report.reports.every(result => result.ok === false)).toBe(true);
});

test("safe functional RED retains all page outcomes and continues only after browser close", async () => {
  const f = fixture();
  f.options.runBrowser = async name => {
    f.events.push(`run:${name}`);
    if (name === "chromium") return { ...green(), ok: false,
      outcomes: [{ ok: false, cleanup: { safe: true }, error: "failed page proof", context: { evidence: 42 } }] };
    return green();
  };
  const report = await runBrowserGate(f.options);
  expect(report.ok).toBe(false); expect(report.cleanup.safe).toBe(true);
  expect(report.reports).toHaveLength(4);
  expect(report.reports[0]!.outcomes[0].context).toEqual({ evidence: 42 });
  expect(report.reports[0]!.error).toContain("failed page proof");
  expect(report.reports.map(result => result.cleanup.safe)).toEqual([true, true, true, true]);
  expect(f.events).toEqual(["run:chromium", "close:chromium", "run:firefox", "close:firefox", "run:webkit", "close:webkit", "run:safari", "close:safari", "cleanup", "write"]);
  expect(f.written).toEqual([report]);
});

test("browser execution error is retained and later requested browsers still run after safe close", async () => {
  const f = fixture();
  f.options.runBrowser = async name => { if (name === "chromium") throw new Error("injected page wait failure"); return green(); };
  const report = await runBrowserGate(f.options);
  expect(report.reports).toHaveLength(4);
  expect(report.reports[0]!.error).toContain("injected page wait failure");
  expect(report.reports[1]!.ok).toBe(true); expect(report.cleanup.safe).toBe(true);
});

for (const unsafe of [{ cleanup: { safe: false, activeWorkers: 0 } }, { unsafeCleanup: "guest unwind unproved" }]) {
  test(`unsafe page result stops later browsers even after successful close: ${JSON.stringify(unsafe)}`, async () => {
    const f = fixture({ runBrowser: async () => ({ ...green(), ...unsafe }) });
    const report = await runBrowserGate(f.options);
    expect(report.ok).toBe(false); expect(report.reports).toHaveLength(1);
    expect(report.cleanup.safe).toBe(false); expect(report.unsafeCleanup).toBeTruthy();
    expect(report.reports[0]!.cleanup.safe).toBe(false);
    expect(f.events).toEqual(["close:chromium", "cleanup", "write"]);
  });
}

test("unsafe browser close stops immediately, preserves the actual error and still writes the report", async () => {
  const f = fixture({ teardownBrowser: async () => { throw new Error("injected browser close failure"); } });
  const report = await runBrowserGate(f.options);
  expect(report.reports).toHaveLength(1); expect(report.cleanup.safe).toBe(false);
  expect(report.reports[0]!.cleanup.safe).toBe(false);
  expect(report.unsafeCleanup).toContain("injected browser close failure");
  expect(f.events).toEqual(["run:chromium", "cleanup", "write"]); expect(f.written).toEqual([report]);
});

test("all teardown steps are attempted and output is written even when final cleanup throws", async () => {
  const attempted: string[] = [];
  const cleanup = await collectRunnerCleanup(["browser", "session", "driver", "server", "scratch"].map(name => ({ name,
    run: async () => { attempted.push(name); if (name !== "scratch") throw new Error(`${name} cleanup failure`); },
  })));
  expect(attempted).toEqual(["browser", "session", "driver", "server", "scratch"]);
  expect(cleanup.safe).toBe(false); expect(cleanup.scratch).toBe(true); expect(cleanup.errors).toHaveLength(4);
  const f = fixture({ cleanup: async () => { throw new Error("injected final cleanup failure"); } });
  const report = await runBrowserGate(f.options);
  expect(report.ok).toBe(false); expect(report.cleanup.safe).toBe(false);
  expect(report.unsafeCleanup).toContain("injected final cleanup failure"); expect(f.written).toEqual([report]);
});

test("Safari session DELETE failure is unsafe even when driver shutdown succeeds", async () => {
  const events: string[] = [];
  const f = fixture({ teardownBrowser: async () => collectRunnerCleanup([
    { name: "sessionClosed", run: async () => { events.push("DELETE"); throw new Error("Safari DELETE refused"); } },
    { name: "driverStopped", run: async () => { events.push("kill driver"); } },
  ]) });
  const report = await runBrowserGate(f.options);
  expect(events).toEqual(["DELETE", "kill driver"]); expect(report.reports).toHaveLength(1);
  expect(report.cleanup.safe).toBe(false); expect(report.unsafeCleanup).toContain("Safari DELETE refused");
  expect(f.written).toEqual([report]);
});

test("a hanging cleanup step is bounded without skipping later resources or the final report", async () => {
  const attempted: string[] = [];
  const f = fixture({ cleanup: () => collectRunnerCleanup(["browser", "session", "driver", "server", "scratch"].map(name => ({ name,
    run: async () => { attempted.push(name); if (name === "browser") await new Promise(() => {}); },
  })), 10) });
  const report = await runBrowserGate(f.options);
  expect(attempted).toEqual(["browser", "session", "driver", "server", "scratch"]);
  expect(report.cleanup.safe).toBe(false); expect(report.cleanup.browser).toBe(false); expect(report.cleanup.scratch).toBe(true);
  expect(report.unsafeCleanup).toContain("timed out"); expect(f.written).toEqual([report]);
});

test("a Safari driver-specific cleanup budget does not change the default bound for other resources", async () => {
  const cleanup = await collectRunnerCleanup([
    { name: "driverStopped", timeoutMs: 100, run: async () => { await Bun.sleep(20); } },
    { name: "otherResource", run: async () => { await Bun.sleep(20); } },
  ], 5);
  expect(cleanup.driverStopped).toBe(true);
  expect(cleanup.otherResource).toBe(false);
  expect(cleanup.safe).toBe(false);
});
test("a hanging browser teardown is unsafe and cannot start another requested browser", async () => {
  const f = fixture({ cleanupTimeoutMs: 10, teardownBrowser: () => new Promise(() => {}) });
  const report = await runBrowserGate(f.options);
  expect(report.reports).toHaveLength(1); expect(report.cleanup.safe).toBe(false);
  expect(report.unsafeCleanup).toContain("timed out"); expect(f.written).toEqual([report]);
  expect(f.events).toEqual(["run:chromium", "cleanup", "write"]);
});

test("a hanging final cleanup still produces an unsafe output report", async () => {
  const f = fixture({ cleanupTimeoutMs: 10, cleanup: () => new Promise(() => {}) });
  const report = await runBrowserGate(f.options);
  expect(report.ok).toBe(false); expect(report.cleanup.safe).toBe(false);
  expect(report.unsafeCleanup).toContain("timed out"); expect(f.written).toEqual([report]);
});

test("failed admission marks nominally green result RED and still closes before continuing", async () => {
  const f = fixture();
  f.options.runBrowser = async name => { const result = green(); if (name === "chromium") result.checks.pop(); f.events.push(`run:${name}`); return result; };
  const report = await runBrowserGate(f.options);
  expect(report.ok).toBe(false); expect(report.reports).toHaveLength(4); expect(report.cleanup.safe).toBe(true);
  expect(report.reports[0]!.ok).toBe(false); expect(report.reports[0]!.error).toContain("28"); expect(report.reports[1]!.ok).toBe(true);
  expect(f.events.indexOf("close:chromium")).toBeLessThan(f.events.indexOf("run:firefox"));
});

test("the retained output is written after cleanup failure with explicit unsafe top-level state", async () => {
  const f = fixture({ cleanup: async () => { throw new Error("listener close failed"); } });
  let observed: any;
  f.options.writeReport = async report => { observed = structuredClone(report); f.events.push("write"); f.written.push(report); };
  const report = await runBrowserGate(f.options);
  expect(observed).toEqual(report);
  expect(observed.ok).toBe(false); expect(observed.cleanup.safe).toBe(false);
  expect(observed.unsafeCleanup).toContain("listener close failed");
  expect(observed.reports).toHaveLength(4); expect(f.events.at(-1)).toBe("write");
});

for (const failed of ["browsersClosed", "sessionClosed", "driverStopped", "listenerClosed"]) {
  test(`production cleanup retains scratch after ${failed} fails while attempting independent teardown`, async () => {
    const attempted: string[] = [];
    const scratch = `/owned/bun-wasm-runner-test-${failed}`;
    let removed = false;
    let closed: RunnerCleanup = { safe: false };
    const f = fixture({ names: ["chromium"],
      teardownBrowser: async () => closed = await collectRunnerCleanup(["browsersClosed", "sessionClosed", "driverStopped"].map(name => ({ name,
        run: async () => { attempted.push(name); if (name === failed) throw new Error(`${name} rejected`); },
      }))),
      cleanup: () => finishRunnerCleanup({ prepared: { safe: true, preparationStopped: true }, closed, scratch,
        stopListener: async () => { attempted.push("listenerClosed"); if (failed === "listenerClosed") throw new Error("listenerClosed rejected"); },
        removeScratch: async () => { removed = true; attempted.push("scratchRemoved"); },
        restoreEnvironment: () => { attempted.push("temporaryEnvironmentRestored"); },
      }),
    });
    const report = await runBrowserGate(f.options);
    expect(attempted).toEqual(["browsersClosed", "sessionClosed", "driverStopped", "listenerClosed", "temporaryEnvironmentRestored"]);
    expect(removed).toBe(false); expect(report.cleanup.scratchRemoved).toBe(false);
    expect(report.cleanup.temporaryEnvironmentRestored).toBe(true);
    expect(report.ok).toBe(false); expect(report.cleanup.safe).toBe(false);
    expect(report.unsafeCleanup).toContain(`${failed} rejected`);
    expect(report.unsafeCleanup).toContain(`scratch retained while consumer shutdown is unproved: ${scratch}`);
    expect(f.written).toEqual([report]);
  });
}

test("production cleanup removes scratch only after every consumer is safely stopped", async () => {
  const attempted: string[] = [];
  const scratch = "/owned/bun-wasm-runner-test-safe";
  let removed: string | undefined;
  const cleanup = await finishRunnerCleanup({ prepared: { safe: true, preparationStopped: true },
    closed: { safe: true, browsersClosed: true, sessionClosed: true, driverStopped: true }, scratch,
    stopListener: async () => { attempted.push("listenerClosed"); },
    removeScratch: async directory => { removed = directory; attempted.push("scratchRemoved"); },
    restoreEnvironment: () => { attempted.push("temporaryEnvironmentRestored"); },
  });
  expect(attempted).toEqual(["listenerClosed", "scratchRemoved", "temporaryEnvironmentRestored"]);
  expect(removed).toBe(scratch); expect(cleanup.safe).toBe(true); expect(cleanup.scratchRemoved).toBe(true);
});

test("production cleanup retains scratch for unproved setup without skipping listener or environment teardown", async () => {
  const attempted: string[] = [];
  const scratch = "/owned/bun-wasm-runner-test-pending-setup";
  const cleanup = await finishRunnerCleanup({ prepared: { safe: false, preparationStopped: false, errors: ["setup still writing"] },
    closed: { safe: true }, scratch,
    stopListener: async () => { attempted.push("listenerClosed"); },
    removeScratch: async () => { attempted.push("scratchRemoved"); },
    restoreEnvironment: () => { attempted.push("temporaryEnvironmentRestored"); },
  });
  expect(attempted).toEqual(["listenerClosed", "temporaryEnvironmentRestored"]);
  expect(cleanup.safe).toBe(false); expect(cleanup.scratchRemoved).toBe(false);
  expect(cleanup.errors?.join("; ")).toContain(scratch);
});

test("setup failures still reach cleanup and report output", async () => {
  const f = fixture({ prepare: async () => { throw new Error("missing artifact"); } });
  const report = await runBrowserGate(f.options);
  expect(report.ok).toBe(false); expect(report.error).toContain("missing artifact");
  expect(report.reports).toEqual([]); expect(f.events).toEqual(["cleanup", "write"]);
});

test("CLI validation failure writes ENGINE_INTERRUPTION_OUTPUT without launching or building", async () => {
  // This test owns only one child and one scratch directory; teardown is in place
  // before either exists. Invalid arguments fail before artifact/browser setup.
  let directory: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    directory = await mkdtemp(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-runner-test-"));
    const output = join(directory, "report.json");
    child = Bun.spawn([process.execPath, join(import.meta.dir, "browser-engine-interruption.ts"), "invalid-browser-for-test"], {
      stdout: "ignore", stderr: "ignore", env: { ...process.env, ENGINE_INTERRUPTION_OUTPUT: output },
    });
    deadline = setTimeout(() => child?.kill("SIGKILL"), 2_000);
    expect(await child.exited).toBe(1);
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report.ok).toBe(false); expect(report.error).toContain("unknown browser invalid-browser-for-test");
    expect(report.cleanup.safe).toBe(true); expect(report.reports).toEqual([]);
    expect(report.resources.scratch).toBeUndefined(); expect(report.resources.safariDriverPid).toBeUndefined();
  } finally {
    clearTimeout(deadline);
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await child.exited; }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test("all strict green admissions and benchmark measurements are preserved", async () => {
  const f = fixture({ benchmark: true });
  const report = await runBrowserGate(f.options);
  expect(report.ok).toBe(true); expect(report.cleanup.safe).toBe(true); expect(report.reports).toHaveLength(4);
});

for (const [label, mutate, benchmark] of [
  ["28 checks", (r: any) => r.checks.pop(), false],
  ["12 per engine", (r: any) => { r.checks[0].engine = "browser"; }, false],
  ["10 generic", (r: any) => { r.checks[0].route = "legacy"; }, false],
  ["distinct proofs", (r: any) => { r.checks[1].name = r.checks[0].name; }, false],
  ["page errors", (r: any) => { r.pageErrors.push("uncaught"); }, false],
  ["no workers", (r: any) => { r.cleanup.activeWorkers = 1; }, false],
  ["benchmark pair", (r: any) => r.benchmarks.pop(), true],
] as const) {
  test(`nominally green page still rejects invalid ${label}`, async () => {
    const f = fixture({ names: ["chromium"], benchmark, runBrowser: async () => { const result = green(); mutate(result); return result; } });
    const report = await runBrowserGate(f.options);
    expect(report.ok).toBe(false); expect(report.reports[0]!.error).toBeTruthy(); expect(f.written).toEqual([report]);
  });
}
