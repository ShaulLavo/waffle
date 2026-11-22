import { resolve } from "node:path";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";

// Timed Atomics.waitAsync under racing notifies in Chromium, Firefox and WebKit.
await runIsolatedPages({
  label: "wait-async-browser",
  scratchRoot: resolve(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp"),
  scratchPrefix: "wwait-",
  port: 0,
  sources: {
    "/tests.js": "wait-async-browser.ts",
    "/waiter.js": "fixtures/wait-async-waiter.ts",
    "/notifier.js": "fixtures/wait-async-notifier.ts",
  },
  names: process.argv.length > 2 ? process.argv.slice(2) : Object.keys(engines),
  evaluate: (page) =>
    page.evaluate(async () => {
      const path = "/tests.js";
      const fixture: typeof import("./wait-async-browser.js") = await import(path);
      return fixture.waitAsyncBrowserCases();
    }),
});
