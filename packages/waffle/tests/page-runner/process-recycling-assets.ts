import { resolve } from "node:path";
import { installClientWorker } from "../process-recycling-browser.js";
import type { PreparationContext } from "waffle/testing/page-runner";

const sources = {
  "/tests.js": "process-recycling-browser.ts",
  "/cell-worker.js": "fixtures/browser-cell-clone.ts",
  "/cell-fs-worker.js": "../browser/fs-worker.ts",
  "/startup-diagnostic-worker.js": "fixtures/startup-diagnostic-worker.ts",
  "/start-failure-quiet-worker.js": "fixtures/start-failure-quiet-worker.ts",
  "/child-diagnostic-worker.js": "child-diagnostic-worker.ts",
  "/startup-pool-worker.js": "fixtures/startup-pool-worker.ts",
  "/pipe-filestat-worker.js": "fixtures/pipe-filestat-worker.ts",
  "/exec-worker.js": "fixtures/exec-browser-worker.ts",
  "/process-page.js": "page-runner/process-recycling-page.ts",
};

export async function processRecyclingAssets({ signal }: PreparationContext) {
  const assets: Record<string, Blob | string> = {
    "/process-client.js": `(${installClientWorker.toString()})();`,
  };
  for (const [route, source] of Object.entries(sources)) {
    signal.throwIfAborted();
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "..", source)],
      target: "browser",
    });
    if (!build.success || !build.outputs[0])
      throw new AggregateError(build.logs, `Process browser fixture bundle failed: ${source}`);
    assets[route] = build.outputs[0];
  }
  signal.throwIfAborted();
  return assets;
}
