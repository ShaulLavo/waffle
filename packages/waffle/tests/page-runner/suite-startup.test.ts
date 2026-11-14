import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "./fake-driver.js";
import { SafariDriver } from "./safari-driver.js";
import type { Driver } from "./driver.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";

const adapter: SuiteAdapter<object> = {
  suite: "startup-control",
  inventory: () => [{ id: "control", label: "control", request: () => ({}) }],
  policy: { listIds: () => ["control"], check() {} },
  assets: async () => ({ "/page.js": "" }),
  budgets: () => ({ hello: 1000, heartbeat: 1000, case: 1000, group: 2000, run: 5000 }),
};

for (const safari of [true, false]) {
  test(`${safari ? "Safari" : "ordinary driver"} setup uses its own allowance before case dispatch`, async () => {
    const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "startup-"));
    const fake = new FakeDriver("pass", { list: ["control"], result: true });
    const driver: Driver = fake;
    if (safari)
      Object.assign(driver, {
        startupTimeoutMs: new SafariDriver("unused", "no-native-resources").startupTimeoutMs,
      });
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    driver.start = async (signal) => {
      entered.resolve(signal);
      await release.promise;
      signal.throwIfAborted();
    };
    const realTimeout = AbortSignal.timeout;
    const setupDeadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 20_000 ? setupDeadline.signal : realTimeout(ms),
    );
    const pending = runPageSuite(adapter, () => driver, {
      scratchRoot: root,
      resultPath: join(root, "result.json"),
      port: "ephemeral",
    });
    try {
      const signal = await entered.promise;
      setupDeadline.abort(new DOMException("Old startup allowance exhausted", "TimeoutError"));
      expect(signal.aborted).toBe(!safari);
      expect(timeout.mock.calls[0]).toEqual([safari ? 55_000 : 20_000]);
      release.resolve();
      const result = await pending;
      expect(result.exit).toBe(safari ? 0 : 2);
      expect(fake.navigations).toBe(safari ? 3 : 1);
      expect(result.documents.some((document) => document.group === "control")).toBe(safari);
      expect(result.cleanup.scratch.status).toBe("confirmed");
      expect(result.cleanup.server.status).toBe("confirmed");
    } finally {
      release.resolve();
      await pending;
      timeout.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
}
