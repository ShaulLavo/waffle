import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";

/** @browserEntry */
async function run() {
  const lifecycle = new BrowserRunnerLifecycle(150000);
  try {
    await lifecycle.init();
    const origin = lifecycle.serve({
      "/": "<!doctype html><title>Root continuity composition</title>",
      "/composition.js": await browserBundle("tests/root-continuity-browser.ts"),
    }, 0);
    for (const control of ["selected", "cancel", "failure"] as const) {
      const browser = await lifecycle.launch("chromium");
      try {
        const page = await browser.newPage();
        await page.goto(origin);
        const evidence = await page.evaluate(async (name) => {
          const path = "/composition.js";
          const suite: typeof import("./root-continuity-browser") = await import(path);
          return name === "selected" ? suite.selectedRootComposition() : suite.startupFenceComposition(name);
        }, control);
        console.log(JSON.stringify({ control, evidence }));
      } finally {
        await lifecycle.closeBrowser(browser);
      }
    }
  } finally {
    await lifecycle.close();
  }
}
if (import.meta.main) await run();
