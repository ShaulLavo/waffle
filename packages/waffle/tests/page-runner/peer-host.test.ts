import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bounded } from "./driver.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";
import type { HostCase } from "./protocol.js";
import { PeerDriverFixture, type PeerFault } from "./peer-driver-fixture.js";

async function fixture(
  driver: PeerDriverFixture,
  callback: (host: HostCase) => Promise<unknown>,
  inspect?: (result: Awaited<ReturnType<typeof runPageSuite>>) => void,
): Promise<void> {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "peer-unit-"));
  const adapter: SuiteAdapter<null> = {
    suite: "peer-unit",
    inventory: () => [{ id: "peer", label: "peer", request: () => null, drive: callback }],
    assets: async () => ({}),
    policy: { listIds: () => ["peer"], check() {} },
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
      cleanupTimeoutMs: 40,
    });
    inspect?.(result);
  } finally {
    driver.release.resolve();
    await driver.stop();
    await rm(root, { recursive: true, force: true });
  }
}
for (const action of ["create", "close", "reload"] as const) {
  test(`actual transition acknowledgement precedes fake ${action} dispatch`, async () => {
    const driver = new PeerDriverFixture();
    let waiting: Promise<unknown> | undefined;
    await fixture(
      driver,
      async (host) => {
        if (action === "create") {
          driver.holdAcknowledgement = true;
          waiting = host.openPeer();
        } else {
          const peer = await host.openPeer();
          driver.prepared = Promise.withResolvers<void>();
          driver.holdAcknowledgement = true;
          waiting = action === "close" ? peer.close() : peer.reload();
        }
        await bounded(driver.prepared.promise, 300, "prepared source");
        await Bun.sleep(15);
        expect(driver.actions.filter((item) => item === action)).toHaveLength(0);
        driver.release.resolve();
        await waiting;
        return true;
      },
      (result) => expect(result.exit).toBe(0),
    );
  });
}
for (const fault of [
  "close-present",
  "close-wrong",
  "reload-old",
  "reload-handle",
  "create-existing",
] satisfies PeerFault[]) {
  test(`unconfirmed physical transition ${fault} cannot finish or delete storage`, async () => {
    const driver = new PeerDriverFixture(fault);
    await fixture(
      driver,
      async (host) => {
        const peer = await host.openPeer();
        if (fault.startsWith("reload")) await peer.reload();
        else await peer.close();
        return true;
      },
      (result) => {
        expect(result.exit).toBe(2);
        expect(result.runComplete).toBe(false);
        expect(driver.navigations).toBeLessThanOrEqual(
          fault.startsWith("reload") && fault !== "reload-old" ? 4 : 3,
        );
      },
    );
  });
}
test("close completion is memoized and old reload capability cannot repeat the action", async () => {
  const driver = new PeerDriverFixture();
  await fixture(
    driver,
    async (host) => {
      const old = await host.openPeer();
      const next = await old.reload();
      expect(() => old.reload()).toThrow("superseded");
      const closing = next.close();
      expect(next.close()).toBe(closing);
      await closing;
      await next.close();
      return true;
    },
    (result) => {
      expect(result.exit).toBe(0);
      expect(driver.actions).toEqual(["create", "reload", "close"]);
    },
  );
});
test("concurrent root and peer script calls remain bound through one writer", async () => {
  const driver = new PeerDriverFixture();
  await fixture(
    driver,
    async (host) => {
      const first = await host.openPeer(),
        second = await host.openPeer();
      await Promise.all([
        host.script("window.label='root';"),
        first.script("window.label='first';"),
        second.script("window.label='second';"),
      ]);
      expect(
        await Promise.all([
          second.script("return window.label;"),
          host.script("return window.label;"),
          first.script("return window.label;"),
        ]),
      ).toEqual(["second", "root", "first"]);
      return true;
    },
    (result) => expect(result.exit).toBe(0),
  );
});

test("an ACK held beyond the operation deadline dispatches no action or successor", async () => {
  const driver = new PeerDriverFixture();
  driver.holdAcknowledgement = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  void driver.prepared.promise.then(() => {
    timer = setTimeout(driver.release.resolve, 350);
  });
  await fixture(
    driver,
    async (host) => {
      await host.openPeer();
      return true;
    },
    (result) => {
      expect(result.exit).toBe(2);
      expect(driver.actions).toEqual([]);
      expect(result.documents.some((state) => state.peer !== null)).toBe(false);
      expect(result.runComplete).toBe(false);
    },
  );
  clearTimeout(timer);
});
test("uncertain create remains owned after its waiter aborts and cannot navigate a late answer", async () => {
  const driver = new PeerDriverFixture("create-hang");
  await fixture(
    driver,
    async (host) => {
      await host.openPeer();
      return true;
    },
    (result) => {
      expect(result.exit).toBe(2);
      expect(result.runComplete).toBe(false);
      expect(result.cleanup.scratch.status).toBe("unconfirmed");
      expect(result.failures.some((item) => item.detail.includes("settlement unconfirmed"))).toBe(
        true,
      );
      expect(driver.navigations).toBe(2);
    },
  );
  await Bun.sleep(0);
  expect(driver.navigations).toBe(2);
});
