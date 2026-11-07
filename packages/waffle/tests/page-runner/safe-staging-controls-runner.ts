import { resolve } from "node:path";
import { browserBundle, engines } from "../browser-runner-lifecycle.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import {
  safeStagingAdapter,
  safeStagingId,
  type SafeStagingRequest,
} from "./safe-staging-suite.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";
import { record, strings } from "./protocol.js";
import { safeStagingLabels } from "../safe-staging-browser.js";

function allocationControls(): SuiteAdapter<SafeStagingRequest> {
  const id = "staging-allocation-controls";
  return {
    suite: "safe-staging-allocation-controls",
    inventory: () => [{ id, label: id, request: (run) => ({ run }) }],
    policy: {
      requireResult: true,
      listIds(value) {
        if (!record(value) || !strings(value.ids)) throw new Error("Invalid control inventory");
        return value.ids;
      },
      check(_id, value) {
        if (!strings(value) || value.length !== 4 || new Set(value).size !== 4)
          throw new Error("Missing allocation gate observations");
      },
    },
    async assets({ signal }) {
      const page = await browserBundle(resolve(import.meta.dir, "safe-staging-control-page.ts"));
      signal.throwIfAborted();
      return { "/page.js": page };
    },
    budgets: () => ({ hello: 20_000, heartbeat: 10_000, case: 10_000, group: 30_000, run: 90_000 }),
  };
}
export async function runSafeStagingControls(engine: string): Promise<void> {
  if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit")
    throw new Error(`Unknown control engine ${engine}; supported: ${Object.keys(engines)}`);
  const directory = process.env.SAFE_STAGING_RESULT_ROOT;
  if (!directory) throw new Error("SAFE_STAGING_RESULT_ROOT required outside disposable scratch");
  for (const adapter of [allocationControls(), safeStagingAdapter()]) {
    const result = await runPageSuite(adapter, (scratch) => new PlaywrightDriver(engine, scratch), {
      resultPath: resolve(directory, `${engine}-${adapter.suite}.json`),
    });
    if (result.exit !== 0) throw new Error(`${adapter.suite} controls exit ${result.exit}`);
    if (
      adapter.suite === "safe-staging" &&
      JSON.stringify(result.results[safeStagingId]) !== JSON.stringify(safeStagingLabels())
    )
      throw new Error("Complete original staging labels were not observed");
  }
}
