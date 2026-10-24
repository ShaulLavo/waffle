import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";

async function runControl(
  lifecycle: BrowserRunnerLifecycle,
  origin: string,
  control: "selected" | "cancel" | "failure",
): Promise<void> {
  const browser = await lifecycle.launch("chromium");
  try {
    const page = await browser.newPage();
    await page.goto(origin);
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
