import { SharedMemoryLedger } from "../memory/reservations.js";
import { createSharedControlAllocator } from "../memory/control.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ProcessTable } from "../proc/table.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { expect, test } from "bun:test";
import {
  createRuntime,
  bytes,
  pages,
  declareSharedMemoryPlatform,
  SharedMemoryAdmissionError,
} from "../index.js";

test("runtime rejects an absent platform before filesystem/worker construction", () => {
  const previous = globalThis.Worker;
  let workers = 0;
  class ObservedWorker {
    constructor() {
      workers++;
      throw new Error("unexpected worker");
    }
  }
  globalThis.Worker = ObservedWorker as unknown as typeof Worker;
  try {
    // Deliberate external-boundary misuse, never an old-shape compatibility overload.
    expect(() => Reflect.apply(createRuntime, undefined, [{}])).toThrow(/Measure|declare/);
    expect(workers).toBe(0);
  } finally {
    globalThis.Worker = previous;
  }
});

test("budget is checked on actual runtime filesystem root before creating its worker", () => {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(1),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  expect(() => createRuntime({ sharedMemory: platform })).toThrow(SharedMemoryAdmissionError);
  expect(Number(pages(2))).toBe(2);
});

test("an external root's logical exit keeps its charge until its physical-stop receipt", async () => {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(128 * 1024 ** 2),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  const identities = new ProcessIdentityAllocator();
  const broker = new BrowserProcessBroker({
    reservations,
    identities,
    table: new ProcessTable(identities),
    registry: new ExecutableRegistry(),
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("unused");
    },
  });
  try {
    const pid = await broker.adoptRoot({
      memory: [{ kind: "private", maximumPages: pages(2), origin: "defined" }],
    });
    const allocate = createSharedControlAllocator(broker.rootControlGrant(pid), (buffer) =>
      broker.rootControlAllocated(pid, buffer),
    );
    const escaped = structuredClone(allocate(32));
    const charged = reservations.snapshot().reservedBytes;
    await broker.rootExit(pid, 0);
    expect(reservations.snapshot().reservedBytes).toBe(charged);
    broker.rootStopped(pid);
    expect(reservations.snapshot().reservedBytes).toBe(40);
    expect(reservations.snapshot().debtBytes).toBe(32);
    expect(escaped.byteLength).toBe(32);
    broker.rootStopped(pid);
    expect(reservations.snapshot().reservedBytes).toBe(40);
  } finally {
    await broker.dispose();
  }
});
