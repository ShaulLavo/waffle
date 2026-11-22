import { resolve } from "node:path";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";

// docs/webkit-blocking-waits.md in real browsers. Starts beside Workers that sleep through the
// runtime's wait must all finish. The same starts beside Workers that sleep through the
// engine's own wait are the control: on an affected WebKit they stall, and the count is
// reported so a fixed engine shows up as a control that no longer stalls.

await runIsolatedPages({
  label: "sleeping-collector-browser",
  scratchRoot: resolve(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp"),
  scratchPrefix: "wsleeping-collector-",
  port: 0,
  sources: {
    "/tests.js": "sleeping-collector-browser.ts",
    "/worker.js": "fixtures/sleeping-collector-worker.ts",
  },
  names: process.argv.length > 2 ? process.argv.slice(2) : Object.keys(engines),
  async evaluate(page) {
    const report = await page.evaluate(async () => {
      const path = "/tests.js";
      const fixture: typeof import("./sleeping-collector-browser.js") = await import(path);
      return fixture.sleepingCollector();
    });
    const engine = page.context().browser()?.browserType().name();
    console.log(JSON.stringify({ engine, ...report }));
    if (report.waffle.stalled)
      throw new Error(
        `${engine}: ${report.waffle.stalled} start(s) stalled beside sleeping Workers`,
      );
    return { engine };
  },
});
