import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  storageLockCases,
  type StorageLockBackend,
  type StorageLockCase,
  type StorageLockScenario,
} from "./storage-lock-cases.js";
import { storageLockSchedule } from "./storage-lock-schedules.js";
import { withStorageCleanup } from "./storage-allocation.js";
import { record, strings, type HostCase } from "./page-runner/protocol.js";
import type { SuiteAdapter } from "./page-runner/suite-host.js";
import { CasePeers } from "./storage-lock-peer.js";

export type StorageLockRequest = { name: string; backend: StorageLockBackend; ordinal: number };
export function storageLockName(
  run: string,
  item: Pick<StorageLockCase, "backend" | "ordinal">,
): string {
  return `storage-lock-${run}-${item.backend}-${item.ordinal}`;
}
async function browserBundle(path: string): Promise<Blob> {
  const result = await Bun.build({ entrypoints: [path], target: "browser" });
  if (!result.success || !result.outputs[0])
    throw new AggregateError(result.logs, "Storage-lock fixture bundle failed");
  return result.outputs[0];
}
export async function storageLockAssets(): Promise<Record<string, Blob | string>> {
  return {
    "/page.js": await browserBundle(join(import.meta.dir, "storage-lock-page.ts")),
    "/fixture.js": await browserBundle(join(import.meta.dir, "storage-lock-browser.ts")),
    "/fs-worker.js": await browserBundle(resolve(import.meta.dir, "../browser/fs-worker.ts")),
    "/recovery-fs-worker.js": await browserBundle(
      join(import.meta.dir, "storage-lock-recovery-worker.ts"),
    ),
  };
}
async function runStorageLock(
  host: HostCase,
  scenario: StorageLockScenario,
  item: StorageLockCase,
): Promise<unknown> {
  const config = await host.script("return window.__suiteConfiguration.request;");
  assert.ok(record(config) && typeof config.name === "string");
  assert.equal(config.ordinal, item.ordinal);
  assert.equal(config.backend, item.backend);
  const peers = new CasePeers(host, item.backend, config.name);
  await withStorageCleanup(
    () => storageLockSchedule(peers, scenario),
    () => peers.closeAll(),
  );
  return { ordinal: item.ordinal, backend: item.backend, scenario };
}
export const storageLockAdapter: SuiteAdapter<StorageLockRequest> = {
  suite: "storage-lock",
  inventory: () =>
    storageLockCases.map((item) => ({
      id: item.id,
      label: item.id,
      request: (run) => ({
        name: storageLockName(run, item),
        backend: item.backend,
        ordinal: item.ordinal,
      }),
      drive: (host) => runStorageLock(host, item.scenario, item),
    })),
  policy: {
    listIds(value) {
      assert.ok(strings(value));
      assert.deepEqual(
        value,
        storageLockCases.map((item) => item.id),
      );
      return value;
    },
    allocation(entry, running, run) {
      assert.equal(running.length, 1);
      const item = storageLockCases.find((item) => item.id === running[0]);
      assert.ok(item, "Foreign storage-lock case");
      const name = storageLockName(run, item);
      const expected =
        item.backend === "indexeddb"
          ? { kind: "indexeddb", name }
          : {
              kind: "opfs-directory",
              name: `bun-wasm-${btoa(JSON.stringify(name)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`,
            };
      assert.deepEqual(entry, expected, "Allocation is not the exact case-owned storage entry");
    },
    requireResult: true,
    check() {},
  },
  assets: storageLockAssets,
  budgets: () => ({
    hello: 20_000,
    heartbeat: 10_000,
    case: 600_000,
    operation: 15_000,
    caseDocument: 600_000,
    group: 600_000,
    run: 600_000,
  }),
};
