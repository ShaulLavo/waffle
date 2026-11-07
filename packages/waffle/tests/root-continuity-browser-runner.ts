if (import.meta.main && process.argv[2] === "ios-safari") {
  const startedAt = performance.now();
  const { tmpdir } = await import("node:os");
  const { nativeMain } = await import("./page-runner/native.js");
  const { rootContinuityAdapter } = await import("./page-runner/root-continuity-suite.js");
  process.env.STORAGE_SCRATCH_ROOT ??= tmpdir();
  process.exit(await nativeMain(rootContinuityAdapter, process.argv.slice(3), { startedAt }));
}
if (import.meta.main && process.argv[2] === "--page-controls") {
  const { runRootContinuityControls } = await import("./page-runner/root-continuity-controls.js");
  await runRootContinuityControls(process.argv[3] ?? "chromium");
  process.exit(0);
}
import { navigateTestPage } from "./browser-navigation.js";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";

async function runControl(
  lifecycle: BrowserRunnerLifecycle,
  origin: string,
  control: "selected" | "cancel" | "failure",
): Promise<void> {
  const browser = await lifecycle.launch("chromium");
  try {
    const page = await browser.newPage();
    await navigateTestPage(page, origin);
    const evidence = await page.evaluate(async (name) => {
      const path = "/composition.js";
      const suite: typeof import("./root-continuity-browser") = await import(path);
      return name === "selected"
        ? suite.selectedRootComposition()
        : suite.startupFenceComposition(name);
    }, control);
    console.log(
      JSON.stringify({ control, evidence }, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  } finally {
    await lifecycle.closeBrowser(browser);
  }
}

/** @browserEntry */
async function run() {
  const lifecycle = new BrowserRunnerLifecycle(150000);
  try {
    await lifecycle.init();
    const origin = lifecycle.serve(
      {
        "/": "<!doctype html><title>Root continuity composition</title>",
        "/composition.js": await browserBundle("tests/root-continuity-browser.ts"),
      },
      0,
    );
    for (const control of ["selected", "cancel", "failure"] as const) {
      await runControl(lifecycle, origin, control);
    }
  } finally {
    await lifecycle.close();
  }
}
if (import.meta.main) await run();
