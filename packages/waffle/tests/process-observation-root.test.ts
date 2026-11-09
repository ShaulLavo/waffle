import { expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.ts";
import { ProcessIdentityAllocator } from "../proc/identity.ts";
import { ProcessTable } from "../proc/table.ts";
import { ExecutableRegistry } from "../proc/registry.ts";
import { createWorkerProcessTransport } from "../proc/worker-client.ts";
import { captureProcessObserver } from "../proc/observation.ts";
import { createFilesystemIdentity } from "../fs/protocol.ts";
import { testReservations } from "./fixtures/shared-memory-platform.ts";

async function rootFixture() {
  const identities = new ProcessIdentityAllocator();
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table: new ProcessTable(identities),
    registry: new ExecutableRegistry(),
    filesystem: {
      connect() {
        throw new Error("No connection is needed by a metadata root");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("No child is launched by a metadata root");
    },
    onError() {},
  });
  const transport = createWorkerProcessTransport({ identity: identities.buffer });
  transport.data = { filesystem: createFilesystemIdentity() };
  try {
    await broker.adoptRuntimeRoot(transport, { memory: [] });
    return { broker, transport, observer: captureProcessObserver(transport) };
  } catch (error) {
    await broker.dispose();
    throw error;
  }
}

test("a captured external root stop survives map retirement and is idempotent", async () => {
  const { broker, transport, observer } = await rootFixture();
  let calls = 0;
  const stop = broker.captureRootStop(transport.pid, () => {
    calls++;
  });
  try {
    await broker.rootExit(transport.pid, 137);
    expect(broker.transportFor(transport.pid)).toBeUndefined();
    expect(observer.read()).toEqual({
      kind: "selected",
      result: { kind: "exited", code: 137, status: 137 },
    });
    expect(stop()).toBeUndefined();
    expect(observer.read()).toEqual({ kind: "terminated" });
    await stop();
    expect(calls).toBe(1);
  } finally {
    await broker.dispose();
  }
});

test("root disposal joins captured native returns after logical retirement", async () => {
  const { broker, transport, observer } = await rootFixture();
  const native = Promise.withResolvers<void>();
  let calls = 0;
  broker.captureRootStop(transport.pid, () => {
    calls++;
    return native.promise;
  });
  try {
    await broker.rootExit(transport.pid, 0);
    const disposing = broker.dispose();
    await Promise.resolve();
    expect(observer.read().kind).toBe("selected");
    native.resolve();
    await disposing;
    expect(observer.read()).toEqual({ kind: "terminated" });
    expect(calls).toBe(1);
  } finally {
    native.resolve();
    await broker.dispose();
  }
});

test("failed root native return retains selected observation and disposal failure", async () => {
  const { broker, transport, observer } = await rootFixture();
  const failure = new Error("native stop rejected");
  let calls = 0;
  const stop = broker.captureRootStop(transport.pid, () => {
    calls++;
    return Promise.reject(failure);
  });
  try {
    await broker.rootExit(transport.pid, 0);
    expect(
      await Promise.resolve()
        .then(stop)
        .catch((error) => error),
    ).toBe(failure);
    expect(observer.read().kind).toBe("selected");
    await expect(broker.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(observer.read().kind).toBe("selected");
    expect(calls).toBe(1);
  } finally {
    await broker.dispose().catch(() => {});
  }
});

test("a metadata-only root keeps its selected result without inventing a native event", async () => {
  const { broker, transport, observer } = await rootFixture();
  try {
    await broker.rootExit(transport.pid, 0);
    expect(observer.read()).toEqual({
      kind: "selected",
      result: { kind: "exited", code: 0, status: 0 },
    });
  } finally {
    await broker.dispose();
  }
});

test("a native stop hook reentering its captured owner never invokes the consumer twice", async () => {
  const { broker, transport, observer } = await rootFixture();
  let calls = 0;
  let reentrant: void | Promise<void> = undefined;
  const stop = broker.captureRootStop(transport.pid, () => {
    calls++;
    if (calls === 1) reentrant = stop();
  });
  try {
    await broker.rootExit(transport.pid, 0);
    expect(stop()).toBeUndefined();
    await reentrant;
    expect(calls).toBe(1);
    expect(observer.read()).toEqual({ kind: "terminated" });
  } finally {
    await broker.dispose();
  }
});
