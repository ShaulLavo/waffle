import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserObservation } from "./browser-observation.js";
import { loadBootstrap } from "./bootstrap-control.js";
import { Collector } from "./collector.js";
import { bounded, type DriverObservationBinding } from "./driver.js";
import { PeerDriverFixture } from "./peer-driver-fixture.js";
import { runPageSuite, serveCollector, type SuiteAdapter } from "./suite-host.js";

function collectorFixture() {
  const collector = new Collector("run", ["case"], ["case"], {
    listIds: () => ["case"],
    check() {},
  });
  const state = collector.expect(
    { id: "case", role: "case", caseIds: ["case"], execution: "host" },
    "token",
    "http://owned.test/?token=token",
    "window",
  );
  const fixture = serveCollector(collector, {}, undefined, 0);
  fixture.configurations.set(state.token, {});
  const bootstrapURL = `${fixture.origin}/_waffle_observation_bootstrap?token=${state.token}`;
  return { collector, state, fixture, bootstrapURL };
}

for (const early of [false, true]) {
  test(`actual parser bootstrap records one exact arrival, already arrived=${early}`, async () => {
    const f = collectorFixture();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    try {
      if (early) await loadBootstrap(f.bootstrapURL);
      const waiting = f.collector.waitForBootstrap(f.state, controller.signal);
      if (!early) await loadBootstrap(f.bootstrapURL);
      await waiting;
      expect(remove.mock.calls.length).toBe(early ? 0 : 1);
      const duplicate = await fetch(`${f.fixture.origin}/_waffle_observation_arrival?token=token`);
      expect(duplicate.status).toBe(410);
      expect(f.state.doc).toBeNull();
      expect(f.state.messages).toEqual([]);
      expect(f.collector.failures).toEqual([]);
    } finally {
      remove.mockRestore();
      f.collector.cancel();
      await f.fixture.server.stop(true);
    }
  });
}

for (const end of ["abort", "cancel"] as const) {
  test(`missing arrival ${end} releases the waiter and refuses late ownership`, async () => {
    const f = collectorFixture();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const waiting = f.collector.waitForBootstrap(f.state, controller.signal);
    void waiting.catch(() => {});
    try {
      if (end === "abort") controller.abort(new Error("stopped"));
      else f.collector.cancel();
      await expect(waiting).rejects.toThrow(end === "abort" ? "stopped" : "cancelled");
      expect(remove).toHaveBeenCalledTimes(1);
      const late = await fetch(`${f.fixture.origin}/_waffle_observation_arrival?token=token`);
      expect(late.status).toBe(410);
      expect(f.state.doc).toBeNull();
      expect(f.state.messages).toEqual([]);
      expect(f.collector.failures).toEqual([]);
    } finally {
      remove.mockRestore();
      f.collector.cancel();
      await f.fixture.server.stop(true);
    }
  });
}

test("other, stale and duplicate identities cannot resolve or mutate an unrelated waiter", async () => {
  const f = collectorFixture();
  const controller = new AbortController();
  let resolved = false;
  const waiting = f.collector.waitForBootstrap(f.state, controller.signal).then(() => {
    resolved = true;
  });
  try {
    f.fixture.configurations.set("other", {});
    for (const token of ["", "unknown", "other"])
      expect(
        (await fetch(`${f.fixture.origin}/_waffle_observation_arrival?token=${token}`)).status,
      ).toBe(410);
    await expect(f.collector.waitForBootstrap({ ...f.state }, controller.signal)).rejects.toThrow(
      "Unrelated",
    );
    await expect(f.collector.waitForBootstrap(f.state, controller.signal)).rejects.toThrow(
      "already owned",
    );
    expect(resolved).toBe(false);
    expect(f.state.messages).toEqual([]);
    expect(f.collector.active).toBe(f.state);
    await loadBootstrap(f.bootstrapURL);
    await waiting;
    expect(resolved).toBe(true);
    f.state.cutoff = -1;
    expect(
      (await fetch(`${f.fixture.origin}/_waffle_observation_arrival?token=token`)).status,
    ).toBe(410);
    expect(f.collector.failures).toEqual([]);
  } finally {
    controller.abort();
    await waiting.catch(() => {});
    f.collector.cancel();
    await f.fixture.server.stop(true);
  }
});

for (const arrived of [false, true]) {
  test(`a pre-aborted owner releases its arrival record without installing a waiter, arrived=${arrived}`, async () => {
    const f = collectorFixture();
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    try {
      if (arrived) await loadBootstrap(f.bootstrapURL);
      controller.abort(new Error("owner stopped"));
      await expect(f.collector.waitForBootstrap(f.state, controller.signal)).rejects.toThrow(
        "owner stopped",
      );
      expect(add).not.toHaveBeenCalled();
      await expect(
        f.collector.waitForBootstrap(f.state, new AbortController().signal),
      ).rejects.toThrow("not the exact live document");
      expect(
        (await fetch(`${f.fixture.origin}/_waffle_observation_arrival?token=token`)).status,
      ).toBe(410);
    } finally {
      add.mockRestore();
      f.collector.cancel();
      await f.fixture.server.stop(true);
    }
  });
}

test("an older registered document cannot discharge the current document's arrival", async () => {
  const f = collectorFixture();
  const current = f.collector.expect(
    f.state.group,
    "current",
    "http://owned.test/?token=current",
    "window",
  );
  f.fixture.configurations.set(current.token, {});
  const controller = new AbortController();
  let resolved = false;
  const waiting = f.collector.waitForBootstrap(current, controller.signal).then(() => {
    resolved = true;
  });
  try {
    expect(
      (await fetch(`${f.fixture.origin}/_waffle_observation_arrival?token=token`)).status,
    ).toBe(410);
    expect(resolved).toBe(false);
    expect(f.collector.active).toBe(current);
    expect(f.state.messages).toEqual([]);
    expect(current.messages).toEqual([]);
    await loadBootstrap(`${f.fixture.origin}/_waffle_observation_bootstrap?token=current`);
    await waiting;
    expect(resolved).toBe(true);
    expect(f.collector.failures).toEqual([]);
  } finally {
    controller.abort();
    await waiting.catch(() => {});
    f.collector.cancel();
    await f.fixture.server.stop(true);
  }
});

test("collector cancellation between arrival and waiter continuation revokes admission", async () => {
  const f = collectorFixture();
  const signal = new AbortController().signal;
  const remove = spyOn(signal, "removeEventListener");
  const waiting = f.collector.waitForBootstrap(f.state, signal);
  void waiting.catch(() => {});
  try {
    f.collector.bootstrapArrived(f.state.token);
    f.collector.cancel();
    await expect(waiting).rejects.toThrow("not the exact live document");
    expect(remove).toHaveBeenCalledTimes(1);
    await expect(f.collector.waitForBootstrap(f.state, signal)).rejects.toThrow(
      "not the exact live document",
    );
    expect(
      (await fetch(`${f.fixture.origin}/_waffle_observation_arrival?token=token`)).status,
    ).toBe(410);
    expect(f.state.messages).toEqual([]);
  } finally {
    remove.mockRestore();
    f.collector.cancel();
    await f.fixture.server.stop(true);
  }
});

class ArrivalDriver extends PeerDriverFixture {
  readonly bootstraps = new Map<string, string>();
  readonly arrived = new Set<string>();
  readonly observations: string[] = [];
  readonly ledgers = new Map<string, BrowserObservation>();
  navigated = Promise.withResolvers<string>();
  late = true;
  pauseAfter = 0;
  bootstrapCount = 0;
  override async navigate(url: string): Promise<void> {
    if (new URL(url).pathname !== "/_waffle_observation_bootstrap") {
      this.bootstraps.delete(this.selected);
      return super.navigate(url);
    }
    await this.windows.get(this.selected)?.stop();
    this.bootstraps.set(this.selected, url);
    if (!this.late || this.bootstrapCount++ < this.pauseAfter) await this.arrive(url);
    this.navigated.resolve(url);
  }
  override async closeWindow(): Promise<void> {
    const ledger = this.ledgers.get(this.selected);
    await super.closeWindow();
    ledger?.documentClosed("playwright-page-close");
  }
  async arrive(url: string): Promise<void> {
    this.arrived.add(url);
    await loadBootstrap(url);
  }
  override async url(): Promise<string> {
    return this.bootstraps.get(this.selected) ?? super.url();
  }
  async observe(binding: DriverObservationBinding) {
    this.observations.push(binding.window);
    expect(this.arrived.has(binding.bootstrapURL)).toBe(true);
    expect(await this.url()).toBe(binding.bootstrapURL);
    expect(await this.handle()).toBe(binding.window);
    const ledger = new BrowserObservation(binding.bootstrapURL, binding.consumers, async () => {});
    this.ledgers.set(binding.window, ledger);
    return ledger;
  }
}

async function suiteFixture(
  driver: ArrivalDriver,
  control: (running: Promise<Awaited<ReturnType<typeof runPageSuite>>>) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "arrival-"));
  const adapter: SuiteAdapter<null> = {
    suite: "arrival-unit",
    inventory: () => [
      {
        id: "peer",
        label: "peer",
        request: () => null,
        observation: "workers-and-requests",
        drive: async (host) => {
          const peer = await host.openPeer();
          const successor = await peer.reload();
          await successor.close();
          return true;
        },
      },
    ],
    policy: { listIds: () => ["peer"], check() {} },
    assets: async () => ({}),
    budgets: () => ({
      hello: 300,
      heartbeat: 1000,
      case: 2000,
      operation: 250,
      group: 3000,
      run: 5000,
    }),
  };
  const running = runPageSuite(adapter, () => driver, {
    signal,
    scratchRoot: root,
    resultPath: join(root, "result.json"),
    cleanupTimeoutMs: 100,
  });
  try {
    await control(running);
  } finally {
    await running;
    await driver.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("navigate acknowledgement before each main/create/reload request cannot start observation", async () => {
  const driver = new ArrivalDriver();
  await suiteFixture(driver, async (running) => {
    for (let index = 0; index < 3; index++) {
      const url = await bounded(driver.navigated.promise, 1000, "bootstrap navigation");
      driver.navigated = Promise.withResolvers<string>();
      await Bun.sleep(0);
      expect(driver.observations).toHaveLength(index);
      expect(driver.arrived.has(url)).toBe(false);
      await driver.arrive(url);
    }
    const result = await running;
    expect(result.exit).toBe(0);
    expect(driver.observations).toHaveLength(3);
    expect(result.cleanup.server.status).toBe("confirmed");
    expect(result.cleanup.scratch.status).toBe("confirmed");
  });
});

test("already arrived main/create/reload bootstraps need no additional navigation", async () => {
  const driver = new ArrivalDriver();
  driver.late = false;
  await suiteFixture(driver, async (running) => {
    expect((await running).exit).toBe(0);
    expect(driver.observations).toHaveLength(3);
    expect(driver.arrived.size).toBe(3);
  });
});

for (const pauseAfter of [0, 1, 2]) {
  for (const aborted of [false, true])
    test(`missing bootstrap ${pauseAfter} fails inside its original budget, abort=${aborted}`, async () => {
      const driver = new ArrivalDriver();
      driver.pauseAfter = pauseAfter;
      const controller = new AbortController();
      await suiteFixture(
        driver,
        async (running) => {
          for (let index = 0; index <= pauseAfter; index++) {
            await bounded(driver.navigated.promise, 1000, "bootstrap navigation");
            driver.navigated = Promise.withResolvers<string>();
          }
          if (aborted) controller.abort(new Error("control abort"));
          const result = await running;
          expect(result.exit).toBe(2);
          expect(driver.observations).toHaveLength(pauseAfter);
          expect(result.failures.length).toBeGreaterThan(0);
          expect(result.cleanup.server.status).toBe("confirmed");
          expect(result.cleanup.scratch.status).toBe("confirmed");
        },
        controller.signal,
      );
    });
}
