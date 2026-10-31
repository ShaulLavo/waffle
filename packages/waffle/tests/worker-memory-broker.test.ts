import { pieCore } from "./fixtures/memory-group-pie.js";
import { prepareLinkPlan } from "../link/index.js";
import {
  SharedMemoryLedger,
  SharedMemoryAdmissionError,
  declareSharedMemoryPlatform,
  bytes,
  pages,
  type RuntimeReservations,
} from "../memory/reservations.js";
import { FilesystemRequestPool } from "../fs/request-memory.js";
import { testReservations } from "./fixtures/shared-memory-platform.js";
import { nodeWorkerTransfers } from "./fixtures/node-worker-transfers.js";
import { expect, test } from "bun:test";
import { Worker as NodeWorker } from "node:worker_threads";
import { BrowserProcessBroker, type WorkerLaunchOptions } from "../browser/process-broker.js";
import type { RuntimeWorkerRequest, RuntimeWorkerMessage } from "../browser/worker.js";
import { DescriptorTable } from "../core/descriptors.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemService } from "../fs/service.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
} from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessDirectoryId,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { memoryObservationGuest } from "./fixtures/memory-observation-guest.js";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("memory observation timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function terminateNativeWorkers(workers: readonly { native?: NodeWorker }[]): Promise<void> {
  await Promise.all(workers.map((worker) => worker.native?.terminate()));
}

async function fixture(
  real: boolean,
  stopping: Promise<void> = Promise.resolve(),
  rootRetired?: () => void,
  reservations: RuntimeReservations = testReservations(),
  launchOptions: Pick<WorkerLaunchOptions, "memoryGroup" | "memories"> & {
    module?: WebAssembly.Module;
  } = {},
) {
  const previousWorker = globalThis.Worker;
  const workers: EmbeddingWorker[] = [];
  const filesystem = new FilesystemService(new MemoryBackend());
  const ports: MessagePort[] = [];
  const pools = new WeakMap<SharedArrayBuffer, FilesystemRequestPool>();
  const errors: unknown[] = [];
  class EmbeddingWorker {
    onmessage: ((event: { data: RuntimeWorkerMessage }) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    request?: RuntimeWorkerRequest;
    native?: NodeWorker;
    stopped?: Promise<void>;
    constructor() {
      workers.push(this);
    }
    postMessage(request: RuntimeWorkerRequest, transfer: Transferable[]) {
      this.request = request;
      if (!real) return;
      const defaultEntry = new URL("./fixtures/generic-memory-node-worker.ts", import.meta.url);
      const entry = process.env.WAFFLE_MEMORY_WORKER_ENTRY;
      this.native = new NodeWorker(entry ? new URL(entry) : defaultEntry);
      this.native.on("message", (data) => this.onmessage?.({ data }));
      this.native.on("error", (error) => errors.push(error));
      this.native.postMessage(request, nodeWorkerTransfers(transfer));
    }
    terminate() {
      if (!this.request) return Promise.resolve();
      return (this.stopped ??= stopping.then(async () => {
        await this.native?.terminate();
      }));
    }
  }
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  const module = launchOptions.module ?? memoryObservationGuest();
  registry.register("fixture", { module, adapter: "preview1" });
  const broker = new BrowserProcessBroker({
    reservations,
    memoryGroups: { maximumPages: 64, stackBytes: 65_536 },
    identities,
    table,
    registry,
    onError: (error) => errors.push(error),
    filesystem: {
      connect(identity, headroom) {
        const pool =
          pools.get(identity.requestBudget) ??
          new FilesystemRequestPool(identity.requestBudget, undefined, reservations.arenas);
        pools.set(identity.requestBudget, pool);
        const pair = connectFilesystemIdentity(identity, pool, undefined, headroom);
        ports.push(pair.server.port, pair.client.port);
        filesystem.connect(pair.server);
        return pair.client;
      },
      revoke: revokeFilesystem,
      reap: reapFilesystem,
      quiesce: waitForFilesystemQuiescence,
    },
    launch: (context) =>
      broker.launchWorker(context, {
        ...launchOptions,
        workerUrl: "generic",
        request: { module, args: [], env: {} },
      }),
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
    capacity: 3,
  });
  const rootFilesystem = createFilesystemIdentity();
  root.data = { filesystem: rootFilesystem };
  const descriptors = new DescriptorTable(),
    notices: WorkerProcessMessage[] = [];
  const parent = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: {
      export() {
        throw Error("no bindings");
      },
      import() {
        throw Error("no bindings");
      },
      discard() {},
    },
    postMessage: (message) => {
      notices.push(message);
    },
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(rootFilesystem) } }),
  });
  const dispose = async () => {
    try {
      await broker.dispose().catch((error) => errors.push(error));
    } finally {
      await terminateNativeWorkers(workers);
      filesystem.dispose();
      descriptors.dispose();
      for (const port of ports) port.close();
      globalThis.Worker = previousWorker;
    }
  };
  globalThis.Worker = EmbeddingWorker as unknown as typeof Worker;
  try {
    await broker.adoptRuntimeRoot(root, { memory: [], retired: rootRetired });
    const supervisor = await broker.ready();
    let handled = 0;
    const spawn = async () => {
      const pid = parent.spawn(parent.pid, {
        executable: "fixture",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      for (; handled < notices.length; handled++)
        await broker.runtimeMessage(notices[handled]!, parent.pid);
      await supervisor.start(pid);
      return pid;
    };
    const pid = await spawn();
    return { broker, supervisor, workers, errors, root, pid, dispose, parent, spawn };
  } catch (error) {
    await dispose();
    throw error;
  }
}

test("child bootstrap receives its root's charged registry even without inherited metadata", async () => {
  const f = await fixture(false);
  try {
    const child = f.workers.find((worker) => worker.request)?.request?.runtimeProcess;
    const rootData = f.root.data;
    const childData = child?.data;
    if (!rootData || typeof rootData !== "object" || !("pipeRegistry" in rootData))
      throw new Error("missing charged root registry");
    if (!childData || typeof childData !== "object" || !("pipeRegistry" in childData))
      throw new Error("missing charged child registry");
    expect(childData.pipeRegistry).toEqual(rootData.pipeRegistry);
  } finally {
    await f.dispose();
  }
});

test("shipped generic Worker samples allocation/growth while blocked and retains it until physical stop", async () => {
  const stop = Promise.withResolvers<void>();
  const f = await fixture(true, stop.promise);
  try {
    await until(() => f.broker.workerMemory()[0]?.bytes === 65536);
    expect(f.broker.workerMemory()[0]).toMatchObject({
      pid: f.pid,
      parentPid: f.root.pid,
      rootPid: f.root.pid,
      directory: workerProcessDirectoryId(f.root),
    });
    await until(() => f.broker.workerMemory()[0]?.bytes === 196608);
    await f.broker.kill(f.pid, 9);
    await f.supervisor.waitForExit(f.root.pid, f.pid);
    expect(f.broker.workerMemory()[0]?.bytes).toBe(196608);
    stop.resolve();
    await until(() => f.broker.workerMemory().length === 0);
    expect(f.errors).toEqual([]);
  } finally {
    stop.resolve();
    await f.dispose();
  }
});

test("unknown samples and failed physical stops retain the captured observation", async () => {
  const stop = Promise.withResolvers<void>();
  const f = await fixture(false, stop.promise);
  try {
    const before = f.broker.workerMemory()[0]!;
    expect(before.bytes).toBeNull();
    const worker = f.workers.find((worker) => worker.request)!;
    Atomics.store(new BigInt64Array(worker.request!.memoryObservation!), 0, 131072n);
    worker.onmessage?.({ data: { type: "exit", code: 0 } });
    await f.supervisor.waitForExit(f.root.pid, f.pid);
    expect(f.broker.workerMemory()[0]?.bytes).toBe(131072);
    stop.reject(Error("physical stop failed"));
    await until(() => f.errors.length > 0);
    await expect(f.broker.dispose()).rejects.toThrow();
    expect(f.broker.workerMemory()[0]).toEqual({ ...before, bytes: 131072 });
  } finally {
    stop.resolve();
    await f.dispose();
  }
});

test("a collected directory slot cannot attribute a late old sample to its replacement", async () => {
  const stop = Promise.withResolvers<void>();
  const f = await fixture(false, stop.promise);
  try {
    const old = f.workers.find((worker) => worker.request)!;
    const request = old.request!;
    old.onmessage?.({ data: { type: "exit", code: 0 } });
    await f.supervisor.waitForExit(f.root.pid, f.pid);
    const job = f.parent.jobOf(f.pid);
    expect(f.parent.waitJob(f.root.pid, job)?.status).toBe(0);
    const nextPid = await f.spawn();
    const next = f.workers.find(
      (worker) => worker.request?.runtimeProcess?.pid === nextPid,
    )!.request!;
    expect(next.runtimeProcess!.slot).toBe(request.runtimeProcess!.slot);
    expect(next.memoryObservation).not.toBe(request.memoryObservation);
    Atomics.store(new BigInt64Array(request.memoryObservation!), 0, 262144n);
    expect(f.broker.workerMemory().find((sample) => sample.pid === f.pid)?.bytes).toBe(262144);
    expect(f.broker.workerMemory().find((sample) => sample.pid === nextPid)?.bytes).toBeNull();
  } finally {
    stop.resolve();
    await f.dispose();
  }
});

test("r703 failed physical stop must not retire retained controller ancestry", async () => {
  const stop = Promise.withResolvers<void>();
  let rootRetired = 0;
  const f = await fixture(false, stop.promise, () => {
    rootRetired++;
  });
  let retired = 0,
    independentRetired = 0,
    independentStopped = 0;
  f.broker.reserveRoot(
    {},
    {
      stop() {
        independentStopped++;
      },
      retired() {
        independentRetired++;
      },
    },
  );
  f.broker.registerController(f.pid, {
    retired() {
      retired++;
    },
  });
  try {
    const worker = f.workers.find((worker) => worker.request)!;
    worker.onmessage?.({ data: { type: "exit", code: 0 } });
    await f.supervisor.waitForExit(f.root.pid, f.pid);
    stop.reject(Error("r703 physical stop failure"));
    await until(() => f.errors.length > 0);
    expect(retired).toBe(0);
    await expect(f.broker.dispose()).rejects.toThrow();
    console.log(JSON.stringify({ retainedRows: f.broker.workerMemory().length, retired }));
    expect(f.broker.workerMemory()).toHaveLength(1);
    expect(retired).toBe(0);
    expect(rootRetired).toBe(0);
    expect(independentStopped).toBe(1);
    expect(independentRetired).toBe(1);
  } finally {
    stop.resolve();
    await f.dispose();
  }
});

test("disposal retires successful independent controllers but retains a failed controller", async () => {
  const f = await fixture(false);
  let failedRetired = 0,
    successfulRetired = 0,
    successfulStopped = 0;
  f.broker.reserveRoot(
    {},
    {
      stop() {
        throw Error("independent controller stop failed");
      },
      retired() {
        failedRetired++;
      },
    },
  );
  f.broker.reserveRoot(
    {},
    {
      stop() {
        successfulStopped++;
      },
      retired() {
        successfulRetired++;
      },
    },
  );
  try {
    await expect(f.broker.dispose()).rejects.toThrow();
    expect(failedRetired).toBe(0);
    expect(successfulStopped).toBe(1);
    expect(successfulRetired).toBe(1);
  } finally {
    await f.dispose();
  }
});

test("bounded declarations run the real guest and keep its reservation until physical stop", async () => {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(6 * 1024 ** 3),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  const stopped = Promise.withResolvers<void>();
  const f = await fixture(true, stopped.promise, undefined, reservations);
  try {
    await until(() => f.broker.workerMemory()[0]?.bytes === 196608);
    const before = reservations.snapshot().reservedBytes;
    expect(before).toBeGreaterThanOrEqual(67_108_864 + 8 * 65_536);
    await f.broker.kill(f.pid, 9);
    await f.supervisor.waitForExit(f.root.pid, f.pid);
    expect(reservations.snapshot().reservedBytes).toBe(before);
    stopped.resolve();
    await until(() => f.broker.workerMemory().length === 0);
    expect(reservations.snapshot().reservedBytes).toBe(
      before - 8 * 65_536 - 64 * 1024 * 1024 + reservations.snapshot().debtBytes,
    );
    expect(f.errors).toEqual([]);
  } finally {
    stopped.resolve();
    await f.dispose();
  }
});

test("actual supervisor returns ENOMEM before allocating a child arena, group, or Worker", async () => {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(96 * 1024 ** 2),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  const f = await fixture(false, Promise.resolve(), undefined, reservations);
  try {
    const result = await f.supervisor.waitForExit(f.root.pid, f.pid);
    expect(result).toMatchObject({ kind: "start-failed", error: "ENOMEM", code: 12 });
    expect(f.workers).toHaveLength(0);
    expect(f.broker.workerMemory()).toHaveLength(0);
    expect(f.broker.memoryGroups()).toHaveLength(0);
    expect(
      f.errors.some((error) => error instanceof SharedMemoryAdmissionError && error.errno === 48),
    ).toBe(true);
    expect(
      reservations.snapshot().holders.filter((holder) => holder.label === "request-arena"),
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test("group adapter memory is refused before group, arena or Worker allocation", async () => {
  const linked = await prepareLinkPlan({
    core: {
      id: "core",
      source: pieCore([0x10, 0]),
      cooperative: true,
      checkpoint: { module: "env", name: "check" },
      initializeMemory: [],
      initialize: [],
    },
    libraries: [],
    reserve: "reserve",
  });
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(256 * 1024 ** 2),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  const f = await fixture(false, Promise.resolve(), undefined, reservations, {
    module: linked.entryModule,
    memoryGroup: "new",
    memories: [{ kind: "private", maximumPages: pages(65_536), origin: "defined" }],
  });
  try {
    expect(f.workers).toHaveLength(0);
    expect(await f.supervisor.waitForExit(f.root.pid, f.pid)).toMatchObject({
      kind: "start-failed",
      error: "ENOMEM",
    });
    expect(f.broker.memoryGroups()).toHaveLength(0);
    expect(
      reservations.snapshot().holders.filter((holder) => holder.label === "request-arena"),
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test("a small group adapter memory is charged without charging the shared import twice", async () => {
  const linked = await prepareLinkPlan({
    core: {
      id: "core",
      source: pieCore([0x10, 0]),
      cooperative: true,
      checkpoint: { module: "env", name: "check" },
      initializeMemory: [],
      initialize: [],
    },
    libraries: [],
    reserve: "reserve",
  });
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(256 * 1024 ** 2),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  const f = await fixture(false, Promise.resolve(), undefined, reservations, {
    module: linked.entryModule,
    memoryGroup: "new",
    memories: [{ kind: "private", maximumPages: pages(8), origin: "defined" }],
  });
  try {
    expect(f.workers.filter((worker) => worker.request)).toHaveLength(1);
    expect(
      reservations.snapshot().holders.filter((holder) => holder.label === "guest-memory"),
    ).toMatchObject([{ declaredBytes: 0 }, { declaredBytes: 8 * 65_536 }]);
    expect(
      reservations.snapshot().holders.filter((holder) => holder.label === "memory-group"),
    ).toMatchObject([{ declaredBytes: 64 * 65_536 }]);
    await f.broker.kill(f.pid, 9);
    await until(() => f.broker.workerMemory().length === 0);
    expect(
      reservations.snapshot().holders.filter((holder) => holder.label === "guest-memory"),
    ).toMatchObject([{ declaredBytes: 0 }]);
  } finally {
    await f.dispose();
  }
});
