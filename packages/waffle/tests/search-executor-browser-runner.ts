import { resolve } from "node:path";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";

// Real process, shard and filesystem workers in Chromium, Firefox and WebKit.
// SEARCH_SCRATCH_ROOT selects the parent of the disposable wsearch-* browser TMPDIR.
await runIsolatedPages({
  label: "search-executor-browser",
  scratchRoot: resolve(
    process.env.SEARCH_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp",
  ),
  scratchPrefix: "wsearch-",
  port: 0,
  sources: {
    "/tests.js": "search-executor-browser.ts",
    "/search-worker.js": "fixtures/search-count-worker.ts",
    "/shard-worker.js": "../search/shard-worker.ts",
    "/fault-shard.js": "fixtures/search-fault-shard.ts",
    "/fs-worker.js": "../browser/fs-worker.ts",
  },
  names: process.argv.length > 2 ? process.argv.slice(2) : Object.keys(engines),
  evaluate: (page) => {
    page.on("console", (message) => console.error(`search console: ${message.text()}`));
    return page.evaluate(async () => {
      const path = "/tests.js";
      const fixture: typeof import("./search-executor-browser.js") = await import(path);
      return fixture.searchExecutorBrowserCases();
    });
  },
});
