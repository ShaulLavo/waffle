import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";
import type { HostWorker } from "./protocol.js";

for (const engine of ["chromium"] as const) {
  test.skipIf(process.env.PUBLICATION_BROWSER_CONTROLS !== "1")(
    `real ${engine} peer generations keep independent lifecycle owners and close bridge`,
    async () => {
      const root = await mkdtemp("/work/tmp/wpl-");
      const adapter: SuiteAdapter<null> = {
        suite: "worker-lifecycle-control",
        inventory: () => [
          {
            id: "lifecycle",
            label: "lifecycle",
            request: () => null,
            observation: "workers-and-requests",
            async drive(host) {
              const peer = await host.openPeer();
              const claimant = await host.openPeer();
              const events: { kind: string; worker: HostWorker }[] = [];
              const remove = peer.onWorker((event) => {
                events.push(event);
              });
              try {
                for (const owner of [host, peer, claimant])
                  await owner.task(
                    "await new Promise((resolve,reject)=>{const worker=new Worker('/worker.js');window.__lifecycleWorker=worker;worker.onmessage=resolve;worker.onerror=reject;});",
                  );
                const ownerWorkers = await peer.workers();
                const first = ownerWorkers[0]!;
                const rootWorker = (await host.workers())[0]!;
                const claimantWorker = (await claimant.workers())[0]!;
                assert.equal(first.url, rootWorker.url);
                assert.notEqual(first, rootWorker);
                await assert.rejects(host.waitForWorkerClose(first), /another document/);
                const successor = await peer.reload();
                await peer.waitForWorkerClose(first);
                assert.equal(events.at(-1)?.kind, "closed");
                await assert.rejects(async () => peer.script("return true"), /revoked|superseded/);
                await successor.task(
                  "await new Promise((resolve,reject)=>{const worker=new Worker('/worker.js');window.__lifecycleWorker=worker;worker.onmessage=resolve;worker.onerror=reject;});",
                );
                const second = (await successor.workers())[0]!;
                assert.equal(second.url, first.url);
                assert.notEqual(second, first);
                assert.equal((await claimant.workers())[0], claimantWorker);
                await successor.close();
                await successor.waitForWorkerClose(second);
                assert.equal((await claimant.workers())[0], claimantWorker);
                await claimant.close();
                await claimant.waitForWorkerClose(claimantWorker);
                await host.task(
                  "const worker=window.__lifecycleWorker; const closed=globalThis.__publicationWaitForClose(new URL('/worker.js',location.href).href); worker.terminate(); await closed;",
                );
                await host.waitForWorkerClose(rootWorker);
                return { isolated: true, bridge: true, replaced: true };
              } finally {
                await remove();
              }
            },
          },
        ],
        policy: { listIds: () => ["lifecycle"], check() {} },
        assets: async () => ({
          "/page.js": await browserBundle(
            join(import.meta.dir, "worker-lifecycle-control-page.ts"),
          ),
          "/worker.js": "postMessage('ready');self.onmessage=()=>{};",
        }),
        budgets: () => ({
          hello: 4000,
          heartbeat: 2000,
          case: 30000,
          group: 40000,
          operation: 12000,
          run: 60000,
        }),
      };
      try {
        const result = await runPageSuite(
          adapter,
          (scratch) => new PlaywrightDriver(engine, scratch),
          { resultPath: join(root, "result.json"), scratchRoot: "/work/tmp", port: "ephemeral" },
        );
        expect(result.failures).toEqual([]);
        assert.equal(result.exit, 0, JSON.stringify(result));
        expect(result.cleanup.session.status).toBe("confirmed");
        expect(result.cleanup.server.status).toBe("confirmed");
      } finally {
        await rm(root, { recursive: true });
      }
    },
    120000,
  );
}
