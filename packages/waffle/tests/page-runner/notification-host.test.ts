import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkNotificationResult, notificationSources } from "../notification-command.js";
import { mixedNotificationCases } from "../notification-mixed-cases.js";
import { commandControlModes } from "./command-controls.js";
import { commandAdapter } from "./command-suites.js";
import { FakeDriver } from "./fake-driver.js";
import { nativeMain } from "./native.js";
import { runPageSuite } from "./suite-host.js";

function originalResult() {
  const terminationOrder = [
    { id: 0, worker: "helper", requests: 1, fenced: true },
    { id: 1, worker: "guest", requests: 1, fenced: true },
  ];
  const broker = (revoke: boolean, relayFailure = false) => ({
    revoke,
    externalClosed: 1,
    guestCleanups: 0,
    hostCleanups: 1,
    joined: true,
    relayFailure,
    terminationOrder,
  });
  const disposal = (detachPort: boolean) => ({
    detachPort,
    releases: 1,
    closed: true,
    pendingArmRejected: true,
  });
  const stages = [
    "fs-service",
    "fs-service-parked",
    "fs-direct",
    "fs-direct-parked",
    "network",
    "network-parked",
    "process",
    "process-parked",
  ];
  const idleReports: unknown[] = [];
  return {
    mixed: {
      done: true,
      idle: { done: true, reports: idleReports, turns: 0 },
      sources: {
        done: true,
        turns: 2,
        reports: stages.map((stage) => ({
          stage,
          turns: 2,
          before: { sequence: 0, filesystem: 0, network: 0, process: 0 },
          after: {
            sequence: 1,
            filesystem: stage.startsWith("fs-") ? 1 : 0,
            network: 1,
            process: 1,
          },
        })),
      },
    },
    terminated: broker(false),
    revoked: broker(true),
    startupCancel: { mode: "arm", entries: 0, cleanups: 1, relayReply: 0 },
    releaseFailure: disposal(false),
    sendFailure: disposal(true),
    relayStopFailure: broker(false, true),
    relayArmFailure: { mode: "relay", entries: 0, cleanups: 1, relayReply: 1 },
    startupReject: { mode: "reject", entries: 0, cleanups: 1, relayReply: 0 },
  };
}
test("host accepts the actual isolated idle and source notification Worker result", async () => {
  const mixed = await mixedNotificationCases(
    new URL("../fixtures/notification-mixed-worker.ts", import.meta.url).href,
    new URL("../../browser/notification-worker.ts", import.meta.url).href,
  );
  expect(() => checkNotificationResult({ ...originalResult(), mixed })).not.toThrow();
}, 15000);

const adapter = commandAdapter("notification");
const id = "notification: notificationCommand";
async function control(actual: unknown) {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "n-host-"));
  const driver = new FakeDriver("pass", { list: { ids: [id] }, result: actual });
  try {
    const result = await runPageSuite(adapter, () => driver, {
      assets: {},
      resultPath: join(root, "result.json"),
      scratchRoot: root,
      budgets: { hello: 500, heartbeat: 500, case: 600, group: 800, run: 6000 },
    });
    expect(await Bun.file(join(root, "result.json")).json()).toEqual(result);
    expect(driver.stopCalls).toBe(1);
    expect(result.results[id]).toEqual(actual);
    expect(result.runComplete).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.documents.map((doc) => doc.group)).toEqual(["list", id, "finish"]);
    expect(result.documents.every((doc) => doc.doc && doc.cutoff !== null)).toBe(true);
    expect(result.cleanup.scratch.status).toBe("confirmed");
    expect(result.cleanup.storage.status).toBe("not-created");
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("the complete notification host keeps the actual nine-scenario result", async () => {
  const result = await control(originalResult());
  expect(result.required).toEqual([id]);
  expect(result.selected).toEqual([id]);
  expect(result.omitted).toEqual([]);
  expect(result.exit).toBe(0);
  expect(result.outcomes[id]).toEqual({ status: "pass", provisional: false });
  expect(adapter.inventory()[0]?.request("run")).toEqual({
    entry: "/notification.js",
    exportName: "notificationCommand",
    args: [],
  });
  expect(adapter.budgets(1).case).toBe(60_000);
});
for (const key of Object.keys(originalResult())) {
  test(`an omitted notification scenario ${key} cannot pass and retains actual result`, async () => {
    const actual = Object.fromEntries(
      Object.entries(originalResult()).filter(([name]) => name !== key),
    );
    const result = await control(actual);
    expect(result.exit).toBe(1);
    expect(result.outcomes[id]).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("all nine original scenarios"),
    });
  });
  test(`an invalid notification scenario ${key} cannot pass`, () => {
    const actual = { ...originalResult(), [key]: {} };
    expect(() => checkNotificationResult(actual)).toThrow();
  });
}
test("reordered notification results fail and are not normalized before retention", async () => {
  const actual = Object.fromEntries(Object.entries(originalResult()).reverse());
  const result = await control(actual);
  expect(result.exit).toBe(1);
  expect(Object.keys(Object(result.results[id]))).toEqual(Object.keys(actual));
});
test("the host does not accept the retired flat notification result shape", () => {
  const actual = originalResult();
  expect(() => checkNotificationResult({ ...actual, mixed: actual.mixed.sources })).toThrow();
});

for (const mutate of [
  (value: ReturnType<typeof originalResult>) => {
    value.mixed.done = false;
  },
  (value: ReturnType<typeof originalResult>) => {
    value.mixed.idle.done = false;
  },
  (value: ReturnType<typeof originalResult>) => {
    value.mixed.idle.reports.push({ stage: "late-source" });
  },
  (value: ReturnType<typeof originalResult>) => {
    value.mixed.idle.turns = 1;
  },
  (value: ReturnType<typeof originalResult>) => {
    value.mixed.sources.done = false;
  },
  (value: ReturnType<typeof originalResult>) => {
    value.mixed.sources.reports.pop();
  },
  (value: ReturnType<typeof originalResult>) => {
    value.mixed.sources.reports.reverse();
  },
  (value: ReturnType<typeof originalResult>) => {
    for (const report of value.mixed.sources.reports) report.after.filesystem = 0;
  },
  (value: ReturnType<typeof originalResult>) => {
    value.mixed.sources.turns = 8;
  },
  (value: ReturnType<typeof originalResult>) => {
    value.terminated.terminationOrder.reverse();
  },
  (value: ReturnType<typeof originalResult>) => {
    value.revoked.terminationOrder.pop();
  },
  (value: ReturnType<typeof originalResult>) => {
    value.relayStopFailure.relayFailure = false;
  },
  (value: ReturnType<typeof originalResult>) => {
    value.relayArmFailure.relayReply = 0;
  },
  (value: ReturnType<typeof originalResult>) => {
    value.startupCancel.cleanups = 2;
  },
  (value: ReturnType<typeof originalResult>) => {
    value.sendFailure.releases = 2;
  },
]) {
  test("original scenario result invariants remain blocking", () => {
    const actual = originalResult();
    mutate(actual);
    expect(() => checkNotificationResult(actual)).toThrow();
  });
}
test("native notification entry rejects this non-Darwin host without resources", async () => {
  if (process.platform === "darwin") return;
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "n-native-"));
  try {
    const path = join(root, "result.json");
    expect(await nativeMain(adapter, ["--result", path])).toBe(3);
    expect(await Bun.file(path).json()).toEqual({
      suite: "notification",
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normal command controls discover the complete notification command and its failure controls", () => {
  expect(commandControlModes.filter((mode) => mode.startsWith("notification-"))).toEqual([
    "notification-complete",
    "notification-snapshot",
    "notification-invalid-result",
    "notification-mixed",
    "notification-terminated",
    "notification-revoked",
    "notification-startupCancel",
    "notification-releaseFailure",
    "notification-sendFailure",
    "notification-relayStopFailure",
    "notification-relayArmFailure",
    "notification-startupReject",
  ]);
});
test("ordinary command asset preparation includes all seven original sources", async () => {
  const assets = await adapter.assets({ scratch: "/unused", signal: AbortSignal.timeout(5000) });
  expect(Object.keys(assets)).toEqual(["/page.js"].concat(Object.keys(notificationSources)));
  for (const asset of Object.values(assets)) {
    if (typeof asset === "string") throw new Error("Notification bundle is not a build artifact");
    expect(asset.size).toBeGreaterThan(0);
    expect((await asset.arrayBuffer()).byteLength).toBe(asset.size);
  }
});

test("host checks do not strengthen the original deadline and parked-source assertions", () => {
  const actual = originalResult();
  actual.mixed.sources.turns = 0;
  for (const report of actual.mixed.sources.reports) {
    if (!report.stage.endsWith("-parked")) continue;
    report.after.filesystem++;
  }
  expect(() => checkNotificationResult(actual)).not.toThrow();
});

test("notification broker results reject an unrequested idle Worker", () => {
  const actual = originalResult();
  actual.terminated.terminationOrder.push({
    id: 2,
    worker: "unused",
    requests: 0,
    fenced: false,
  });
  expect(() => checkNotificationResult(actual)).toThrow();
});
