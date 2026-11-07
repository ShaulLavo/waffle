import assert from "node:assert/strict";
import { join } from "node:path";
import { storageLockAdapter, storageLockAssets } from "../storage-lock-host.js";
import { invoke, object, query, ready, waiting, lockName } from "../storage-lock-peer.js";
import { runPageSuite } from "./suite-host.js";
import { PlaywrightDriver } from "./playwright-driver.js";

export async function peerStorageControl(
  engine: "chromium" | "webkit",
  root: string,
): Promise<void> {
  await storageControl(engine, root, false);
  await storageControl(engine, root, true);
}
async function storageControl(
  engine: "chromium" | "webkit",
  root: string,
  interrupted: boolean,
): Promise<void> {
  const controller = new AbortController();
  const assets = await storageLockAssets();
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "peer-storage-control-page.ts")],
    target: "browser",
    define: { PEER_STORAGE_INTERRUPTED: String(interrupted) },
  });
  if (!built.success || !built.outputs[0])
    throw new AggregateError(built.logs, "Peer storage control page");
  assets["/page.js"] = built.outputs[0];
  const inventory = storageLockAdapter
    .inventory()
    .filter((_item, index) => index === 0 || (!interrupted && index === 6));
  const adapter = {
    ...storageLockAdapter,
    inventory: () =>
      inventory.map((item) => ({
        ...item,
        drive: async (host: Parameters<NonNullable<typeof item.drive>>[0]) => {
          await host.task(`const name='peer-foreign-'+window.__suiteConfiguration.run;
await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1); request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject(request.error);});
await (await navigator.storage.getDirectory()).getDirectoryHandle(name,{create:true});`);
          const request = await host.script("return window.__suiteConfiguration.request;");
          assert.ok(
            typeof request === "object" &&
              request !== null &&
              "name" in request &&
              typeof request.name === "string" &&
              "backend" in request &&
              (request.backend === "opfs" || request.backend === "indexeddb"),
          );
          const { name, backend } = request;
          const owner = await host.openPeer();
          if (interrupted) {
            const starting = invoke(owner, "start", [backend, name, "wait"]);
            void starting.catch(() => {});
            while (await owner.script("return window.__allocationAccepted !== true;"))
              await host.sleep(10);
            controller.abort("Storage consumer interrupted with accepted allocation debt");
            await starting;
            throw new Error("Interrupted consumer unexpectedly continued");
          }
          await invoke(owner, "start", [backend, name, "wait"]);
          await ready(host, owner, "storage control owner");
          assert.equal(await invoke(owner, "constructions", []), 1);
          // Asynchronous storage inspection uses the actual task path.
          await owner.task(
            `window.__exists = ${backend === "indexeddb" ? `await indexedDB.databases().then(rows=>rows.some(row=>row.name===${JSON.stringify(name)}))` : `!!(await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(`bun-wasm-${btoa(JSON.stringify(name)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`)}))`};`,
          );
          assert.equal(await owner.script("return window.__exists;"), true);
          const waiter = await host.openPeer();
          await invoke(waiter, "start", [backend, name, "wait"]);
          await waiting(host, waiter, "storage control waiter");
          assert.equal((await object(waiter, "resources", [])).terminations, 0);
          assert.ok(
            (await query(waiter)).pending.some((entry) => entry.name === lockName(backend, name)),
          );
          await owner.close();
          await ready(host, waiter, "storage control handoff");
          await waiter.close();
          return { zeroConstructionsBeforeAck: true, actualStorage: true, contention: true };
        },
      })),
    policy: {
      ...storageLockAdapter.policy,
      listIds: (value: unknown) => {
        assert.deepEqual(
          value,
          inventory.map((item) => item.id),
        );
        return inventory.map((item) => item.id);
      },
    },
  };
  const result = await runPageSuite(adapter, (scratch) => new PlaywrightDriver(engine, scratch), {
    resultPath: join(root, interrupted ? "peer-storage-interrupted.json" : "peer-storage.json"),
    signal: controller.signal,
    assets,
  });
  if (interrupted) {
    assert.equal(result.exit, 2, JSON.stringify(result));
    assert.equal(result.runComplete, false);
    assert.equal(result.ledger.length, 1);
    assert.equal(result.cleanup.storage.status, "unconfirmed");
    assert.equal(result.cleanup.session.status, "confirmed");
    assert.ok(
      !result.documents.some((state) => state.group.includes("finish")),
      "Interrupted consumer ran deletion",
    );
    return;
  }
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.ledger.length, 2);
  assert.deepEqual(result.storageRemaining, []);
  assert.equal(result.cleanup.storage.status, "confirmed");
}
