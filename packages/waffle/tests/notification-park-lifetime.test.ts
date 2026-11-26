import { expect, test } from "bun:test";
import { createNotificationBridge } from "../browser/notification-relay.js";
import { NotificationWaitScope } from "../browser/notification-wait.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";
import { controlledNotificationRelay } from "./fixtures/notification-controlled-relay.js";
import {
  notificationRetiredParkCase,
  notificationRevokeParkCase,
} from "./notification-race-cases.js";

const relayUrl = new URL("../browser/notification-worker.ts", import.meta.url).href;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a revoke or reap between readiness and registration still wakes the parked guest", async () => {
  expect(await notificationRevokeParkCase(relayUrl)).toEqual({ outcomes: ["revoke", "reap"] });
});

test("a retired park never publishes, and a fresh park after it is woken", async () => {
  expect(await notificationRetiredParkCase(relayUrl, 20)).toEqual({ rounds: 20 });
});

test("a timed-out guest wait leaves nothing forwarding through quiet and later traffic", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const fs = new FilesystemClient(pair.client);
  const bridge = createNotificationBridge(relayUrl);
  const scope = new NotificationWaitScope(bridge.connection, fs);
  try {
    const set = await scope.arm();
    const observed = set.sample();
    expect(set.wait(observed, performance.now() + 30)).toBe("timed-out");
    expect(Atomics.load(bridge.connection.state, 2)).toBe(0);
    await pause(100);
    const cells = fs.shared.watch.cells;
    for (let commit = 0; commit < 20; commit++) {
      Atomics.add(cells, 3, 1);
      Atomics.notify(cells, 3);
    }
    await pause(200);
    expect(Atomics.load(bridge.connection.state, 0)).toBe(observed.sequence);
  } finally {
    scope.dispose();
    await bridge.dispose();
    fs.dispose();
    await service.shutdown();
  }
});

test("a retired park keeps watching through a wake without change and serves its reactivation", async () => {
  const relay = await controlledNotificationRelay();
  try {
    relay.park();
    expect(relay.waits).toHaveLength(3);
    relay.retire();
    // A notify without a change while the guest runs: no publication, the relay rewaits.
    relay.waits[0]!.resolve("ok");
    await settle();
    expect(Atomics.load(relay.state, 0)).toBe(0);
    expect(relay.waits).toHaveLength(4);
    // The guest reactivates the unchanged park by id alone; the next wake publishes.
    Atomics.store(relay.state, 2, 1);
    relay.waits[3]!.resolve("ok");
    await settle();
    expect(Atomics.load(relay.state, 0)).toBe(1);
    expect(Atomics.load(relay.state, 2)).toBe(0);
  } finally {
    await relay.close();
  }
});

test("a retired park whose word moved stops waiting until the guest parks again", async () => {
  const relay = await controlledNotificationRelay();
  try {
    relay.park();
    relay.retire();
    Atomics.add(relay.words[1]!, 0, 1);
    relay.waits[1]!.resolve("ok");
    await settle();
    expect(Atomics.load(relay.state, 0)).toBe(0);
    expect(relay.inspect("relay.parked")).toBeUndefined();
    expect(relay.waits).toHaveLength(3);
  } finally {
    await relay.close();
  }
});
