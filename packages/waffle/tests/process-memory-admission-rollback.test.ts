import { expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { createFilesystemIdentity } from "../fs/protocol.js";
import {
  bytes,
  declareSharedMemoryPlatform,
  pages,
  SharedMemoryAdmissionError,
  SharedMemoryLedger,
} from "../memory/reservations.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import { PipePublicationRegistry } from "../proc/pipes.js";
import { createWorkerProcessTransport } from "../proc/worker-client.js";

const controlQuota = 64 * 1024 ** 2;
const registryBytes = 16_785_424;

function fixture(budgetBytes: number) {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(budgetBytes),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const errors: unknown[] = [];
  const broker = new BrowserProcessBroker({
    reservations,
    identities,
    table,
    registry: new ExecutableRegistry(),
    memoryGroups: { maximumPages: 2 },
    filesystem: {
      connect() {
        throw new Error("No filesystem connection is used before launch");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("No process is launched by admission");
    },
    onError: (error) => errors.push(error),
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  return {
    reservations,
    broker,
    root,
    errors,
    async dispose() {
      try {
        await broker.dispose();
      } finally {
        reservations.dispose();
      }
    },
  };
}

test("registry budget refusal leaves an external root unpublished and its bootstrap untouched", async () => {
  const f = fixture(controlQuota + 2 * 65_536);
  const originalData = f.root.data;
  let stops = 0;
  try {
    await expect(
      f.broker.adoptRuntimeRoot(f.root, {
        memory: [{ kind: "private", maximumPages: pages(1), origin: "defined" }],
        stop() {
          stops++;
        },
      }),
    ).rejects.toBeInstanceOf(SharedMemoryAdmissionError);
    expect(f.broker.transportFor(f.root.pid) === undefined).toBe(true);
    expect(f.root.data === originalData).toBe(true);
    expect(
      f.reservations.snapshot().holders.filter((holder) =>
        ["guest-memory", "guest-control"].includes(holder.label),
      ),
    ).toEqual([]);
    const supervisor = await f.broker.ready();
    expect(supervisor.get(f.root.pid)).toBeUndefined();
    await expect(f.broker.dispose()).resolves.toBeUndefined();
    expect(stops).toBe(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("a rejected duplicate adoption preserves the admitted root's bootstrap and stop owner", async () => {
  const f = fixture(256 * 1024 ** 2);
  let originalStops = 0;
  let refusedStops = 0;
  try {
    await f.broker.adoptRuntimeRoot(f.root, {
      memory: [],
      stop() {
        originalStops++;
      },
    });
    const originalData = f.root.data;
    await expect(
      f.broker.adoptRuntimeRoot(f.root, {
        memory: [],
        stop() {
          refusedStops++;
        },
      }),
    ).rejects.toThrow("already has a controller");
    expect(f.root.data === originalData).toBe(true);
    expect(f.broker.transportFor(f.root.pid)).toBe(f.root);
    const supervisor = await f.broker.ready();
    expect(supervisor.get(f.root.pid)).toBeDefined();
    await f.broker.dispose();
    expect(originalStops).toBe(1);
    expect(refusedStops).toBe(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("group reply refusal aborts the unlaunched member while retaining its pooled backing charge", async () => {
  const budget = controlQuota + 8 + registryBytes + 2 * 65_536 + 16_400;
  const f = fixture(budget);
  try {
    await f.broker.adoptRuntimeRoot(f.root, { memory: [], stop() {} });
    expect(() => f.broker.admitRootMemoryGroup(f.root.pid)).toThrow(
      SharedMemoryAdmissionError,
    );
    expect(f.broker.memoryGroups()).toEqual([]);
    const snapshot = f.reservations.snapshot();
    expect(snapshot.reservedBytes).toBe(budget);
    expect(snapshot.availableBytes).toBe(0);
    expect(snapshot.awaitingReleaseBytes).toBe(2 * 65_536);
    expect(snapshot.debtBytes).toBe(0);
    expect(snapshot.holders.find((holder) => holder.label === "memory-group")).toMatchObject({
      declaredBytes: 2 * 65_536,
      scope: "pooled",
      state: "awaiting-collection",
    });
    await expect(f.broker.dispose()).resolves.toBeUndefined();
    expect(f.errors).toEqual([]);
  } finally {
    await f.dispose().catch(() => {});
  }
});


test("a full attached registry is preserved when a new root cannot register", async () => {
  const f = fixture(256 * 1024 ** 2);
  const registry = new PipePublicationRegistry({
    processCapacity: 1,
    cellsPerProcess: 1,
    maxCells: 1,
    allocate: (initial, maximum) =>
      f.reservations.buffer("pipe-registry", {
        kind: "growable-buffer",
        initial: bytes(initial),
        maximum: bytes(maximum),
      }),
  });
  registry.registerProcess(2);
  const originalData = { filesystem: createFilesystemIdentity(), pipeRegistry: registry.handle() };
  f.root.data = originalData;
  try {
    await expect(f.broker.adoptRuntimeRoot(f.root, { memory: [] })).rejects.toThrow(
      "pipe process registry is full",
    );
    expect(f.broker.transportFor(f.root.pid) === undefined).toBe(true);
    expect(f.root.data === originalData).toBe(true);
    expect(registry.processCount).toBe(1);
    expect(registry.isRevoked(2)).toBe(false);
    const supervisor = await f.broker.ready();
    expect(supervisor.get(f.root.pid)).toBeUndefined();
    expect(f.errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});
