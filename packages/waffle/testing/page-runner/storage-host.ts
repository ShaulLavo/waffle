import { join, resolve } from "node:path";
import { storageTests, opfsStorageTests } from "../storage-browser.js";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { storageWorker, type WorkerRequest } from "./storage-worker.js";
import { storagePolicy } from "./storage-policy.js";
import { storageBudgets } from "./protocol.js";
import type { Driver } from "./driver.js";
import { runPageSuite, type RunOptions, type SuiteAdapter } from "./suite-host.js";
export function storageInventory(): { backend: "indexeddb" | "opfs"; label: string; id: string }[] {
  return storageTests("/fs-worker.js", "/open-fs-worker.js")
    .map<{ backend: "indexeddb" | "opfs"; label: string; id: string }>(({ label }) => ({
      backend: "indexeddb" as const,
      label,
      id: `indexeddb: ${label}`,
    }))
    .concat(
      opfsStorageTests("/fs-worker.js").map(({ label }) => ({
        backend: "opfs" as const,
        label,
        id: `opfs: ${label}`,
      })),
    );
}
async function storageAssets(): Promise<Record<string, Blob | string>> {
  const root = resolve(import.meta.dir, "..");
  return {
    "/page.js": await browserBundle(join(import.meta.dir, "storage-page.ts")),
    "/tests.js": await browserBundle(join(root, "storage-browser.ts")),
    "/fs-worker.js": await browserBundle(resolve(root, "../browser/fs-worker.ts")),
    "/open-fs-worker.js": await browserBundle(join(root, "storage-open-worker.ts")),
    "/worker.js": `(${storageWorker.toString()})();`,
  };
}
export const storageAdapter: SuiteAdapter<Extract<WorkerRequest, { kind: "run" }>> = {
  suite: "storage",
  inventory: () =>
    storageInventory().map((item) => ({
      ...item,
      request: (run) => ({
        kind: "run",
        backend: item.backend,
        label: item.label,
        allocationPrefix: `bun-wasm-${item.backend === "indexeddb" ? "storage" : "opfs"}-test-${run}`,
      }),
    })),
  policy: storagePolicy,
  assets: storageAssets,
  budgets: (selected) => ({ ...storageBudgets, run: (selected + 2) * 90_000 + 120_000 }),
};
export const runStorage = (factory: (scratch: string) => Driver, options: RunOptions) =>
  runPageSuite(storageAdapter, factory, options);
