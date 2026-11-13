import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserObservation } from "./browser-observation.js";
import { loadBootstrap } from "./bootstrap-control.js";
import { bounded, type DriverObservationBinding } from "./driver.js";
import { PeerDriverFixture } from "./peer-driver-fixture.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";

import type { HostCase, HostWorkerCallback } from "./protocol.js";

class ObservedPeerFixture extends PeerDriverFixture {
  private bootstrap: string | undefined;
  readonly ledgers = new Map<string, BrowserObservation>();
  readonly detached: string[] = [];
  auditDispatches = 0;
  closeMode: "complete" | "retire-only" | "never-retire" = "complete";
  override async script(source: string): Promise<unknown> {
    if (source.includes("window.reviewAudit")) this.auditDispatches++;
    return super.script(source);
  }
  override async navigate(url: string): Promise<void> {
    if (new URL(url).pathname === "/_waffle_observation_bootstrap") {
      await loadBootstrap(url);
      this.bootstrap = url;
      const previous = this.ledgers.get(this.selected);
      if (previous?.closing) previous.terminated("worker", "playwright-worker-close");
      return;
    }
    this.bootstrap = undefined;
    await super.navigate(url);
  }
  override async url(): Promise<string> {
    return this.bootstrap ?? super.url();
  }
  async observe(binding: DriverObservationBinding): Promise<BrowserObservation> {
    expect(binding.window).toBe(this.selected);
    expect(await this.url()).toBe(binding.bootstrapURL);
    const ledger = new BrowserObservation(binding.expectedURL, binding.consumers, async () => {
      this.detached.push(binding.expectedURL);
    });
    this.ledgers.set(this.selected, ledger);
    ledger.created("worker", "http://owned.test/worker.js");
    return ledger;
  }
  override async closeWindow(): Promise<void> {
    const ledger = this.ledgers.get(this.selected);
    await super.closeWindow();
    if (this.closeMode === "complete") ledger?.terminated("worker", "playwright-worker-close");
    if (this.closeMode !== "never-retire") ledger?.documentClosed("playwright-page-close");
  }
}

function closeCallback(
  host: HostCase,
  rootCommand: boolean,
  callbacks: Promise<unknown>[],
  released: Promise<void>,
): HostWorkerCallback {
  return (event) => {
    if (event.kind !== "closed") return;
    const task = rootCommand
      ? host.script("window.reviewAudit=true; return true;")
      : Promise.resolve(true);
    callbacks.push(task);
    return Promise.race([task.then(() => {}), released]);
  };
}

async function reloadCallbackControl(
  rootCommand: boolean,
  action: "reload" | "close" = "reload",
  mode: ObservedPeerFixture["closeMode"] = "complete",
): Promise<void> {
  const root = await mkdtemp(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-lifecycle-"),
  );
  const driver = new ObservedPeerFixture();
  driver.closeMode = mode;
  let waiting: Promise<void> | undefined;
  let settled = false;
  const release = Promise.withResolvers<void>();
  const callbacks: Promise<unknown>[] = [];
  const adapter: SuiteAdapter<null> = {
    suite: "lifecycle-queue",
    inventory: () => [
      {
        id: "peer",
        label: "peer",
        request: () => null,
        observation: "workers-and-requests",
        async drive(host) {
          const peer = await host.openPeer();
          peer.onWorker(closeCallback(host, rootCommand, callbacks, release.promise));
          if (mode === "retire-only") {
            waiting = peer.waitForWorkerClose((await peer.workers())[0]!);
            void waiting.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
          }
          const successor = action === "reload" ? await peer.reload() : peer;
          await successor.close();
          if (mode === "retire-only") expect(settled).toBe(false);
          if (action === "close") await Promise.all(callbacks);
          return true;
        },
      },
    ],
    policy: { listIds: () => ["peer"], check() {} },
    assets: async () => ({}),
    budgets: () => ({
      hello: 300,
      heartbeat: 1000,
      case: 1000,
      operation: 250,
      group: 2000,
      run: 4000,
    }),
  };
  try {
    const result = await runPageSuite(adapter, () => driver, {
      scratchRoot: root,
      resultPath: join(root, "result.json"),
      cleanupTimeoutMs: 50,
    });
    if (mode === "never-retire") {
      expect(result.exit).not.toBe(0);
      expect(JSON.stringify(result)).toContain("owned peer document retirement timed out");
    } else {
      expect(result.failures).toEqual([]);
      expect(result.exit).toBe(0);
    }
    expect(callbacks).toHaveLength(mode === "complete" ? 1 : 0);
    if (mode !== "complete") {
      const entry = result.diagnostics.current.lifecycle.completed.find(
        (entry) => entry.stages[0]?.stage === "physical-close-requested",
      );
      expect(entry?.stages.map((item) => item.stage)).toEqual([
        "physical-close-requested",
        "physical-close-confirmed",
        "document-retirement-pending",
        mode === "retire-only" ? "document-retired" : "failed",
      ]);
      if (mode === "retire-only") {
        expect(entry?.facts).toMatchObject({
          retirementSource: "playwright-page-close",
          outstandingWorkers: [1],
          outstandingCount: 1,
        });
        const ledger = Array.from(driver.ledgers.values()).find(
          (ledger) => ledger.diagnosticSnapshot().retirement?.intent === "close",
        );
        expect(ledger?.diagnosticSnapshot().workers.completed[0]?.stages.at(-1)?.stage).toBe(
          "receipt-unconfirmed",
        );
        await expect(waiting).rejects.toThrow();
      }
      expect(result.cleanup.server.status).toBe("confirmed");
      expect(result.cleanup.scratch.status).toBe("confirmed");
    }
    expect(driver.auditDispatches).toBe(rootCommand ? 1 : 0);
  } finally {
    release.resolve();
    await bounded(Promise.allSettled(callbacks), 500, "callback release");
    await waiting?.catch(() => {});
    await driver.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("reload drains callbacks without a coordinator command", () => reloadCallbackControl(false));
test("peer reload cannot join a callback behind its own driver queue", () =>
  reloadCallbackControl(true));

test("peer close permits a callback to query its surviving coordinator", () =>
  reloadCallbackControl(true, "close"));

for (const mode of ["retire-only", "never-retire"] as const)
  test(`peer close joins exact document retirement: ${mode}`, () =>
    reloadCallbackControl(false, "close", mode));
