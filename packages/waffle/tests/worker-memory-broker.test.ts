import { nodeWorkerTransfers } from "./fixtures/node-worker-transfers.js";
import { expect, test } from "bun:test";
import { Worker as NodeWorker } from "node:worker_threads";
import { BrowserProcessBroker } from "../browser/process-broker.js";
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

async function fixture(real: boolean, stopping: Promise<void> = Promise.resolve()) {
  const previousWorker = globalThis.Worker;
  const workers: EmbeddingWorker[] = [];
  const filesystem = new FilesystemService(new MemoryBackend());
  const ports: MessagePort[] = [];
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
  const module = memoryObservationGuest();
  registry.register("fixture", { module, adapter: "preview1" });
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError: (error) => errors.push(error),
    filesystem: {
      connect(identity) {
        const pair = connectFilesystemIdentity(identity);
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
    await broker.adoptRuntimeRoot(root);
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
  const f = await fixture(false, stop.promise);
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
