import { SharedMemoryLedger } from "../memory/reservations.js";
import { createSharedControlAllocator } from "../memory/control.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { createFilesystemIdentity } from "../fs/protocol.js";
import { createWorkerProcessTransport, workerProcessPipeRegistry } from "../proc/worker-client.js";
import { PipePublicationRegistry } from "../proc/pipes.js";
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

function boundedRootFixture() {
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
  return { broker, reservations, identities };
}

test("an external root's logical exit keeps its charge until its physical-stop receipt", async () => {
  const { broker, reservations } = boundedRootFixture();
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

test("root adoption refuses an uncharged registry before publishing root authority", async () => {
  const { broker, reservations, identities } = boundedRootFixture();
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  const registry = new PipePublicationRegistry({
    processCapacity: 2,
    cellsPerProcess: 1,
    maxCells: 2,
  });
  root.data = { filesystem: createFilesystemIdentity(), pipeRegistry: registry.handle() };
  const before = reservations.snapshot().reservedBytes;
  try {
    await expect(broker.adoptRuntimeRoot(root, { memory: [] })).rejects.toThrow(/charged registry/);
    expect(reservations.snapshot().reservedBytes).toBe(before);
    expect(broker.transportFor(root.pid)).toBeUndefined();
  } finally {
    await broker.dispose();
  }
});

test("root adoption publishes a ledger-charged registry before bootstrap can read it", async () => {
  const { broker, reservations, identities } = boundedRootFixture();
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  const oldData = { filesystem: createFilesystemIdentity() };
  root.data = oldData;
  try {
    expect(() => workerProcessPipeRegistry(root)).toThrow(/admitted root pipe registry/);
    await broker.adoptRuntimeRoot(root, { memory: [] });
    const data = root.data;
    if (!data || typeof data !== "object" || !("pipeRegistry" in data))
      throw new Error("missing adopted registry");
    expect(data.pipeRegistry).toEqual(workerProcessPipeRegistry(root));
    expect(data).not.toBe(oldData);
    expect(
      reservations.snapshot().holders.filter((holder) => holder.label === "pipe-registry"),
    ).toMatchObject([{ declaredBytes: 16_785_424, state: "live" }]);
  } finally {
    await broker.dispose();
  }
});

test("root adoption accepts a registry constructed by its own reservation authority", async () => {
  const { broker, reservations, identities } = boundedRootFixture();
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  const registry = new PipePublicationRegistry({
    processCapacity: 2,
    cellsPerProcess: 1,
    maxCells: 2,
    allocate: (initial, maximum) =>
      reservations.buffer("pipe-registry", {
        kind: "growable-buffer",
        initial,
        maximum: bytes(maximum),
      }),
  });
  const handle = registry.handle();
  root.data = { filesystem: createFilesystemIdentity(), pipeRegistry: handle };
  try {
    await broker.adoptRuntimeRoot(root, { memory: [] });
    expect(workerProcessPipeRegistry(root).buffer).toBe(handle.buffer);
    expect(
      reservations.snapshot().holders.filter((holder) => holder.label === "pipe-registry"),
    ).toHaveLength(1);
  } finally {
    await broker.dispose();
  }
});

test("a missing worker control grant fails before bootstrap allocation or guest entry", async () => {
  const { bootstrap } = await import("../browser/worker.js");
  let messages = 0;
  await expect(
    Reflect.apply(bootstrap, undefined, [
      {},
      {
        run() {
          throw new Error("guest must not run");
        },
      },
      {
        crossOriginIsolated: true,
        postMessage() {
          messages++;
        },
      },
    ]),
  ).rejects.toThrow(/requires a shared control grant/);
  expect(messages).toBe(0);
});
