import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { nativeMain } from "./native.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { runPageSuite, type SuiteAdapter, type SuiteResult } from "./suite-host.js";

const consoleControlModes = [
  "page-clean",
  "page-error",
  "worker-only",
  "worker-first-line",
  "worker-error-page-terminate",
  "worker-error-self-close",
  "clean-prompt-cancel",
  "clean-self-close",
  "clean-completion-terminate",
] as const;
type ConsoleControlMode = (typeof consoleControlModes)[number];
function consoleControlAdapter(
  mode: ConsoleControlMode,
  marker: string,
): SuiteAdapter<{ mode: string; marker: string }> {
  return {
    suite: `console-${mode}`,
    inventory: () => [
      { id: "console", label: mode, console: "fail-on-error", request: () => ({ mode, marker }) },
    ],
    policy: {
      listIds: () => ["console"],
      requireResult: true,
      check(value, result) {
        assert.equal(value, "console");
        assert.deepEqual(result, { body: "pass", mode, marker });
      },
    },
    assets: async () => ({
      "/page.js": await browserBundle(join(import.meta.dir, "console-control-page.ts")),
      "/console-first-line.js": await browserBundle(
        join(import.meta.dir, "console-first-line-worker.ts"),
      ),
      "/console-worker.js": await browserBundle(join(import.meta.dir, "console-control-worker.ts")),
    }),
    budgets: () => ({ hello: 10_000, heartbeat: 10_000, case: 15_000, group: 20_000, run: 60_000 }),
  };
}
function checkConsoleControl(result: SuiteResult, mode: ConsoleControlMode, marker: string): void {
  const error = mode === "page-error" || mode.startsWith("worker-");
  assert.equal(result.exit, error ? 1 : 0, `Qualification failed: ${JSON.stringify(result)}`);
  assert.deepEqual(result.failures, [], "Infrastructure failure is not console detection");
  assert.equal(result.runComplete, true);
  assert.deepEqual(result.results.console, { body: "pass", mode, marker });
  for (const value of Object.values(result.cleanup)) {
    if (typeof value === "object") assert.notEqual(value.status, "unconfirmed");
  }
  for (const key of ["session", "server", "scratch"] as const)
    assert.equal(result.cleanup[key].status, "confirmed", `${key} cleanup not confirmed`);
  const summary = result.documents.find((document) => document.group === "console")?.console;
  assert.ok(summary, "Missing declared console observation");
  assert.equal(summary.loss, null);
  if (!error) {
    assert.equal(result.outcomes.console?.status, "pass");
    assert.equal(summary.first, null);
    return;
  }
  const outcome = result.outcomes.console;
  assert.equal(outcome?.status, "fail");
  assert.ok(
    outcome?.status === "fail" &&
      outcome.detail.includes("Browser console error in ") &&
      outcome.detail.includes(marker),
  );
  assert.equal(summary.first?.text, marker, "Actual unique console marker missing");
  if (mode === "page-error") assert.equal(summary.first?.context, "page");
  else {
    const context = summary.first?.context;
    assert.ok(
      context && context !== "page" && context.kind === "dedicated-worker",
      "Actual worker origin missing",
    );
    const url = new URL(context.url);
    assert.equal(
      url.pathname,
      mode === "worker-first-line" ? "/console-first-line.js" : "/console-worker.js",
    );
    assert.equal(url.searchParams.get("marker"), marker);
  }
}
async function runConsoleControls(
  engine: "chromium" | "webkit" | "ios-safari",
  root: string,
  modes: readonly ConsoleControlMode[] = consoleControlModes,
): Promise<void> {
  assert.ok(isAbsolute(root), "Absolute result directory required");
  const scratchRoot = process.env.STORAGE_SCRATCH_ROOT;
  assert.ok(
    scratchRoot && isAbsolute(scratchRoot),
    "Explicit absolute STORAGE_SCRATCH_ROOT required",
  );
  await mkdir(root, { recursive: true });
  for (const mode of modes) {
    const marker = `waffle-console-${mode}-${crypto.randomUUID()}`;
    const adapter = consoleControlAdapter(mode, marker);
    const resultPath = join(root, `${mode}.json`);
    if (engine === "ios-safari")
      await nativeMain(adapter, ["--result", resultPath], { scratchRoot, port: "ephemeral" });
    else
      await runPageSuite(adapter, (scratch) => new PlaywrightDriver(engine, scratch), {
        resultPath,
        scratchRoot,
        port: "ephemeral",
      });
    const result: SuiteResult = await Bun.file(resultPath).json();
    checkConsoleControl(result, mode, marker);
    console.log(`${engine} ${mode} qualified at ${resultPath}`);
  }
}
if (import.meta.main) {
  const [engine, root, mode] = process.argv.slice(2);
  assert.ok(
    engine === "chromium" || engine === "webkit" || engine === "ios-safari",
    "Expected chromium, webkit or ios-safari",
  );
  assert.ok(root, "Absolute result directory required");
  const selected = consoleControlModes.filter((value) => value === mode);
  assert.ok(mode === undefined || selected.length === 1, "Unknown console control");
  await runConsoleControls(engine, root, mode === undefined ? consoleControlModes : selected);
}
