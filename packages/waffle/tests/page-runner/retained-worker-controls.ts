import assert from "node:assert/strict";
import { join } from "node:path";
import { storageLockAdapter, storageLockAssets } from "../storage-lock-host.js";
import { CasePeers, invoke, object } from "../storage-lock-peer.js";
import { recovery } from "../storage-lock-schedules.js";
import { withStorageCleanup } from "../storage-allocation.js";
import { record } from "./protocol.js";
import { runPageSuite } from "./suite-host.js";
import { PlaywrightDriver } from "./playwright-driver.js";

export const retainedWorkerControlModes = [
  "retained-worker-pass",
  "retained-worker-terminated",
  "retained-worker-no-handler",
  "retained-worker-wrong-path",
  "retained-worker-replay",
  "retained-worker-replacement",
];
async function bundle(path: string, mode: string): Promise<Blob> {
  const result = await Bun.build({
    entrypoints: [path],
    target: "browser",
    define: {
      RETAINED_CONTROL: JSON.stringify(mode),
      RETAINED_WORKER_CONTROL: JSON.stringify(mode),
    },
  });
  if (!result.success || !result.outputs[0])
    throw new AggregateError(result.logs, "Retained Worker control build");
  return result.outputs[0];
}
export async function retainedWorkerControl(
  engine: "chromium" | "webkit",
  mode: string,
  root: string,
): Promise<void> {
  const assets = await storageLockAssets();
  assets["/page.js"] = await bundle(join(import.meta.dir, "retained-worker-control-page.ts"), mode);
  const worker = await bundle(join(import.meta.dir, "../storage-lock-recovery-worker.ts"), mode);
  assets["/recovery-fs-worker.js"] = worker;
  assets["/wrong-recovery-fs-worker.js"] = worker;
  const item = storageLockAdapter.inventory()[17];
  assert.ok(item);
  let baseline = false,
    observationEntered = false;
  const adapter = {
    ...storageLockAdapter,
    inventory: () => [
      {
        ...item,
        console: undefined,
        drive: async (host: Parameters<NonNullable<typeof item.drive>>[0]) => {
          const request = await host.script("return window.__suiteConfiguration.request;");
          assert.ok(record(request) && typeof request.name === "string");
          const peers = new CasePeers(host, "indexeddb", request.name);
          await withStorageCleanup(
            () =>
              recovery(peers, "ready", async (owner) => {
                baseline = true;
                await invoke(owner, "observationFault", [mode]);
                observationEntered = true;
                const nonce = crypto.randomUUID();
                const result = await object(owner, "observeRetainedWorker", [nonce, true]);
                assert.equal(result.nonce, nonce);
                assert.equal(result.pathname, "/recovery-fs-worker.js");
                assert.equal(result.matches, true);
              }),
            () => peers.closeAll(),
          );
          return { baseline, observationEntered };
        },
      },
    ],
    policy: {
      ...storageLockAdapter.policy,
      listIds(value: unknown) {
        assert.deepEqual(value, [item.id]);
        return [item.id];
      },
    },
  };
  const result = await runPageSuite(adapter, (scratch) => new PlaywrightDriver(engine, scratch), {
    resultPath: join(root, `${mode}.json`),
    assets,
  });
  assert.equal(
    baseline,
    true,
    "Control did not establish actual ready/loss/rejected-disposal baseline",
  );
  assert.equal(observationEntered, true);
  assert.equal(result.exit, mode === "retained-worker-pass" ? 0 : 1, JSON.stringify(result));
  assert.equal(result.runComplete, true);
  assert.equal(
    result.failures.length,
    0,
    "Expected observation assertion, not infrastructure failure",
  );
  const outcome = result.outcomes[item.id];
  if (mode !== "retained-worker-pass") {
    assert.ok(outcome?.status === "fail");
    assert.match(outcome.detail, /retained Worker|original filesystem Worker/);
  }
  assert.equal(result.cleanup.session.status, "confirmed");
  assert.equal(result.cleanup.scratch.status, "confirmed");
  assert.deepEqual(result.storageRemaining, []);
}
