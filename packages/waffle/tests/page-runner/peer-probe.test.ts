import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded } from "./driver.js";
import { PeerDriverFixture } from "./peer-driver-fixture.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";

const marker = "HELD_PROBE_PREDECESSOR";
type Hold = "probe" | "predecessor";

class ProbeDriver extends PeerDriverFixture {
  readonly entered = Promise.withResolvers<AbortSignal>();
  readonly response = Promise.withResolvers<void>();
  readonly responded = Promise.withResolvers<void>();
  armed = false;
  responseReturned = false;
  dispatches = 0;
  private waiting = false;
  constructor(readonly hold: Hold) {
    super();
  }
  private async waitForResponse(signal: AbortSignal | undefined): Promise<void> {
    if (this.waiting) return;
    if (!signal) throw new Error("Held transport has no abort signal");
    this.waiting = true;
    this.entered.resolve(signal);
    await this.response.promise;
    this.responseReturned = true;
    this.responded.resolve();
  }
  override async handles(signal?: AbortSignal): Promise<string[]> {
    this.dispatches++;
    if (this.armed && this.hold === "probe") await this.waitForResponse(signal);
    return super.handles();
  }
  override async selectWindow(handle: string): Promise<void> {
    this.dispatches++;
    await super.selectWindow(handle);
  }
  override async handle(): Promise<string> {
    this.dispatches++;
    return super.handle();
  }
  override async url(): Promise<string> {
    this.dispatches++;
    return super.url();
  }
  override async script(source: string, signal?: AbortSignal): Promise<unknown> {
    this.dispatches++;
    const answer = await super.script(source);
    if (this.armed && this.hold === "predecessor" && source.includes(marker))
      await this.waitForResponse(signal);
    return answer;
  }
}

async function heldProbe(hold: Hold): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "peer-probe-"));
  const driver = new ProbeDriver(hold);
  const adapter: SuiteAdapter<null> = {
    suite: "probe-deadline",
    inventory: () => [
      {
        id: "peer",
        label: "peer",
        request: () => null,
        async drive(host) {
          await host.openPeer();
          const document = driver.windows.get(driver.selected);
          if (!document) throw new Error("Coordinator document missing");
          expect(document.config.role).toBe("case");
          document.reporter.stop();
          driver.armed = true;
          if (hold === "predecessor") return host.script(`return '${marker}';`);
          await host.sleep(10_000);
          return true;
        },
      },
    ],
    assets: async () => ({}),
    policy: { listIds: () => ["peer"], check() {} },
    budgets: () => ({
      hello: 500,
      heartbeat: 40,
      case: 10_000,
      operation: 150,
      group: 10_000,
      run: 800,
    }),
  };
  let running: ReturnType<typeof runPageSuite> | undefined;
  let completedDispatches: number | undefined;
  let entered = false;
  try {
    running = runPageSuite(adapter, () => driver, {
      resultPath: join(root, "result.json"),
      scratchRoot: root,
      cleanupTimeoutMs: 40,
    });
    const signal = await bounded(driver.entered.promise, 1500, "held transport entry");
    entered = true;
    const result = await bounded(running, 2500, "bounded probe result");
    expect(signal.aborted).toBe(true);
    expect(driver.responseReturned).toBe(false);
    expect(result.exit).toBe(2);
    expect(result.runComplete).toBe(false);
    expect(result.cleanup.scratch.status).toBe("unconfirmed");
    expect(
      result.failures.some((failure) => failure.detail.includes("settlement unconfirmed")),
    ).toBe(true);
    expect(driver.stopCalls).toBe(1);
    expect(driver.navigations).toBe(3);
    const retained = result.cleanup.scratch.detail.match(/Retained (.+), consumers/)?.[1];
    expect(retained).toBeDefined();
    if (!retained) throw new Error("Missing retained scratch identity");
    expect((await stat(retained)).isDirectory()).toBe(true);
    completedDispatches = driver.dispatches;
  } finally {
    driver.response.resolve();
    await bounded(running?.catch(() => {}) ?? Promise.resolve(), 1500, "released test run");
    if (entered) await driver.responded.promise;
    await Bun.sleep(0);
    await driver.stop();
    await rm(root, { recursive: true, force: true });
  }
  expect(driver.dispatches).toBe(completedDispatches);
}
for (const hold of ["probe", "predecessor"] as const)
  test(`probe timeout reaches teardown while ${hold} transport remains owned`, () =>
    heldProbe(hold));
