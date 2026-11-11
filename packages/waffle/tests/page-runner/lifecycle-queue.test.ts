import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserObservation } from "./browser-observation.js";
import { bounded, type DriverObservationBinding } from "./driver.js";
import { PeerDriverFixture } from "./peer-driver-fixture.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";

import type { HostCase, HostWorkerCallback } from "./protocol.js";

class ObservedPeerFixture extends PeerDriverFixture {
  private bootstrap: string | undefined;
  readonly ledgers = new Map<string, BrowserObservation>();
  readonly detached: string[] = [];
  auditDispatches = 0;
  override async script(source: string): Promise<unknown> {
    if (source.includes("window.reviewAudit")) this.auditDispatches++;
    return super.script(source);
  }
  override async navigate(url: string): Promise<void> {
    if (new URL(url).pathname === "/_waffle_observation_bootstrap") {
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
    ledger?.terminated("worker", "playwright-worker-close");
    ledger?.documentClosed();
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
): Promise<void> {
  const root = await mkdtemp(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-lifecycle-"),
  );
  const driver = new ObservedPeerFixture();
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
          const successor = action === "reload" ? await peer.reload() : peer;
          await successor.close();
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
    expect(result.failures).toEqual([]);
    expect(result.exit).toBe(0);
    expect(callbacks).toHaveLength(1);
    expect(driver.auditDispatches).toBe(rootCommand ? 1 : 0);
  } finally {
    release.resolve();
    await bounded(Promise.allSettled(callbacks), 500, "callback release");
    await driver.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("reload drains callbacks without a coordinator command", () => reloadCallbackControl(false));
test("peer reload cannot join a callback behind its own driver queue", () =>
  reloadCallbackControl(true));

test("peer close permits a callback to query its surviving coordinator", () =>
  reloadCallbackControl(true, "close"));
