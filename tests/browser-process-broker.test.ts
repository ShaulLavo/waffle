import { ProcessErrno } from "../proc/types.js";
import { TaggedCells, controlLoad } from "../proc/control.js";
import {
  collectDirectoryJob,
  collectDirectoryProcess,
  confirmDirectoryProcess,
  directoryProcesses,
  findDirectoryJob,
} from "../proc/directory.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import type { RootProcessOptions } from "../proc/supervisor.js";
import type { WorkerProcessBroker } from "../proc/worker-broker.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  workerProcessDirectoryId,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  revokeFilesystem,
} from "../fs/protocol.js";
import { createSignalState, type SignalTransport } from "../proc/signals.js";
import {
  OutcomeCell,
  claimOutcome,
  markStarted,
  outcomeWord,
  readOutcome,
} from "../proc/outcome.js";
import {
  attachPipeEndpoint,
  PipeEndpoint,
  PipeErrno,
  PipePublicationRegistry,
} from "../proc/pipes.js";
import { WorkerPipeHost, type WorkerPipeBroker } from "../proc/worker-pipes.js";

test("one browser process owner admits multiple roots with shared monotonically allocated identities", async () => {
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({
    identities,
    table,
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
      throw new Error("unknown adapter");
    },
  });
  try {
    const first = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    const second = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    first.data = { filesystem: createFilesystemIdentity() };
    second.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(first);
    const supervisor = await broker.ready();
    await broker.adoptRuntimeRoot(second);
    expect(supervisor.table).toBe(table);
    expect(supervisor.get(workerProcessState(first).pid)?.parentPid).toBe(0);
    expect(supervisor.get(workerProcessState(second).pid)?.parentPid).toBe(0);
    expect(workerProcessState(second).pid).toBeGreaterThan(workerProcessState(first).pid);
    await broker.rootExit(workerProcessState(first).pid, 0);
    expect(supervisor.get(workerProcessState(second).pid)?.result).toBeNull();
  } finally {
    await broker.dispose();
  }
});

test("root admission cannot create a live process behind concurrent disposal", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({
    identities,
    table,
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
  const admission = broker.adoptRoot({ pid: identities.pid(), job: identities.job() });
  const disposal = broker.dispose();
  await expect(admission).rejects.toThrow(/disposed/);
  await disposal;
  expect(Array.from(table.values())).toHaveLength(0);
});

test("revocation never allocates a process in an unrelated root pipe registry", async () => {
  const { PipePublicationRegistry } = await import("../proc/pipes.js");
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({
    identities,
    table,
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
  const roots = [0, 1].map(() => {
    const transport = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    transport.data = {
      filesystem: createFilesystemIdentity(),
      pipeRegistry: new PipePublicationRegistry({
        processCapacity: 1,
        cellsPerProcess: 1,
        maxCells: 1,
      }).handle(),
    };
    return transport;
  });
  try {
    for (const root of roots) await broker.adoptRuntimeRoot(root);
    await broker.ready();
    for (const root of roots) await broker.rootExit(workerProcessState(root).pid, 0);
    expect(
      roots.map((root) => {
        try {
          workerProcessState(root);
          return false;
        } catch {
          return true;
        }
      }),
    ).toEqual([true, true]);
    expect(Array.from(table.values())).toHaveLength(0);
  } finally {
    await broker.dispose();
  }
});

test("failed direct root activation retains its consumer fence and stop capability", async () => {
  const proc = await import("../proc/index.js");
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  const failure = new Error("partial root initialization failed");
  let release!: () => void;
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  let revoked = 0,
    stopped = 0,
    descriptorsReleased = 0;
  class PartialSupervisor extends proc.ProcessSupervisor {
    override createRoot(options: RootProcessOptions): never {
      const pid = super.createRoot(options);
      this.get(pid)!.descriptors.open(
        {
          kind: "terminal",
          read: () => 0,
          write: () => 0,
          readiness: () => ({ readable: false, writable: true, hangup: false }),
        },
        0n,
        0n,
        () => {
          descriptorsReleased++;
        },
      );
      throw failure;
    }
  }
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry: new ExecutableRegistry(),
    activate: async () => ({ ...proc, ProcessSupervisor: PartialSupervisor }),
    onError() {},
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {
        revoked++;
      },
      reap() {},
      quiesce: () => fence,
    },
    launch() {
      throw new Error("unused");
    },
  });
  try {
    await expect(
      broker.adoptRoot(
        { pid: identities.pid(), job: identities.job() },
        {
          filesystem: createFilesystemIdentity(),
          stop() {
            stopped++;
          },
        },
      ),
    ).rejects.toBe(failure);
    const disposal = broker.dispose();
    expect(revoked).toBe(1);
    expect(stopped).toBe(0);
    expect(descriptorsReleased).toBe(1);
    release();
    await disposal;
    expect(stopped).toBe(1);
    expect(Array.from(table.values())).toHaveLength(0);
  } finally {
    release();
    await broker.dispose();
  }
});

test("adopting and closing a pipe-only root never activates a supervisor", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  let activations = 0;
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry: new ExecutableRegistry(),
    activate: async () => {
      activations++;
      return import("../proc/index.js");
    },
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
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(root);
    await broker.rootExit(workerProcessState(root).pid, 0);
    expect(activations).toBe(0);
    expect(Array.from(table.values())).toHaveLength(0);
  } finally {
    await broker.dispose();
  }
});

test("explicit lazy root identities advance the shared allocator before activation", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  let activations = 0;
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry: new ExecutableRegistry(),
    activate: async () => {
      activations++;
      return import("../proc/index.js");
    },
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
    broker.reserveRoot({ pid: 1, job: 1 });
    expect(broker.reserveRoot({})).toBe(2);
    broker.reserveRoot({ pid: 40, job: 70 });
    expect(identities.pid()).toBe(41);
    expect(identities.job()).toBe(71);
    expect(activations).toBe(0);
    expect(Array.from(table.values())).toHaveLength(0);
    const supervisor = await broker.ready();
    expect(supervisor.get(1)?.job).toBe(1);
    expect(supervisor.get(2)?.job).toBe(2);
    expect(supervisor.get(40)?.job).toBe(70);
  } finally {
    await broker.dispose();
  }
});

test("job kill publishes every lazy direct and runtime root before callbacks and activation", async () => {
  const proc = await import("../proc/index.js");
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  let releaseActivation!: (value: typeof proc) => void;
  const activation = new Promise<typeof proc>((resolve) => {
    releaseActivation = resolve;
  });
  const signals = (): SignalTransport => ({
    signalState: createSignalState(),
    outcome: outcomeWord(),
    interrupt: new Int32Array(new SharedArrayBuffer(4)),
    requestedSignal: new Int32Array(new SharedArrayBuffer(4)),
  });
  const first = signals(),
    second = signals(),
    unrelated = signals();
  const job = identities.job(),
    otherJob = identities.job();
  const generic = createWorkerProcessTransport({
    pid: identities.pid(),
    job,
    identity: identities.buffer,
  });
  generic.data = { filesystem: createFilesystemIdentity() };
  const genericState = workerProcessState(generic);
  const snapshots: (number | null)[][] = [];
  const snapshot = () =>
    snapshots.push(
      [first, second, genericState.signals, unrelated].map(
        (state) => readOutcome(state.outcome)?.status ?? null,
      ),
    );
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry: new ExecutableRegistry(),
    activate: () => activation,
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
  let killing: Promise<void> | undefined;
  try {
    const firstPid = broker.reserveRoot(
      { pid: identities.pid(), job, ...first },
      { wake: snapshot },
    );
    const secondPid = broker.reserveRoot(
      { pid: identities.pid(), job, ...second },
      { wake: snapshot },
    );
    const otherPid = broker.reserveRoot(
      { pid: identities.pid(), job: otherJob, ...unrelated },
      { wake: snapshot },
    );
    await broker.adoptRuntimeRoot(generic, { wake: snapshot });
    killing = broker.killJob(job, 9);
    expect(readOutcome(first.outcome)?.status).toBe(137);
    expect(readOutcome(second.outcome)?.status).toBe(137);
    expect(readOutcome(genericState.signals.outcome)?.status).toBe(137);
    expect(readOutcome(unrelated.outcome)).toBeNull();
    expect(snapshots).toHaveLength(4);
    for (const observed of snapshots) expect(observed).toEqual([137, 137, 137, null]);
    expect(Array.from(table.values())).toHaveLength(0);
    releaseActivation(proc);
    await killing;
    const supervisor = await broker.ready();
    expect(supervisor.get(firstPid)?.result?.status).toBe(137);
    expect(supervisor.get(secondPid)?.result?.status).toBe(137);
    // Runtime roots also wait for the asynchronous shared-resource cleanup fence.
    expect(await supervisor.waitForExit(0, genericState.pid)).toMatchObject({ status: 137 });
    expect(supervisor.get(otherPid)?.result).toBeNull();
  } finally {
    releaseActivation(proc);
    try {
      await killing;
    } finally {
      await broker.dispose();
    }
  }
});

test("disposal settles every consumer stop before disposing fenced relays and reports every failure", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  const stopFailure = new Error("first consumer stop failed"),
    pipeFailure = new Error("relay cleanup failed");
  let releaseFence!: () => void, releaseStop!: () => void, startedStop!: () => void;
  const fence = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  const stop = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const stopping = new Promise<void>((resolve) => {
    startedStop = resolve;
  });
  const events: string[] = [];
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry: new ExecutableRegistry(),
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      quiesce: () => fence,
    },
    launch() {
      throw new Error("unused");
    },
  });
  const roots = [0, 1].map(() => {
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    const registry = new PipePublicationRegistry();
    registry.registerProcess(root.pid);
    root.data = { filesystem: createFilesystemIdentity(), pipeRegistry: registry.handle() };
    return { root, registry };
  });
  const publications: Promise<void>[] = [];
  const host = new WorkerPipeHost({
    transport: roots[0]!.root,
    registry: roots[0]!.registry,
    postMessage: (message) => {
      publications.push(broker.runtimeMessage(message, workerProcessState(roots[0]!.root).pid));
    },
  });
  const pipes = Reflect.get(broker, "pipes") as WorkerPipeBroker;
  const disposePipes = pipes.dispose.bind(pipes);
  pipes.dispose = () => {
    events.push("pipes");
    disposePipes();
    throw pipeFailure;
  };
  let endpoints: ReturnType<WorkerPipeHost["createPipe"]> | undefined;
  let disposal: Promise<unknown> | undefined;
  try {
    await broker.adoptRuntimeRoot(roots[0]!.root, {
      stop() {
        events.push("first-stop");
        throw stopFailure;
      },
    });
    await broker.adoptRuntimeRoot(roots[1]!.root, {
      async stop() {
        events.push("second-stop");
        startedStop();
        await stop;
        events.push("second-stopped");
      },
    });
    endpoints = host.createPipe();
    await Promise.all(publications);
    expect(pipes.size).toBe(1);
    disposal = broker.dispose().then(
      () => undefined,
      (error) => error,
    );
    for (const { root, registry } of roots)
      expect(registry.isRevoked(workerProcessState(root).pid)).toBe(true);
    expect(events).toEqual([]);
    releaseFence();
    await stopping;
    expect(events).toEqual(["first-stop", "second-stop"]);
    releaseStop();
    const failure = await disposal;
    expect(events).toEqual(["first-stop", "second-stop", "second-stopped", "pipes"]);
    expect(pipes.size).toBe(0);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([stopFailure, pipeFailure]);
  } finally {
    releaseFence();
    releaseStop();
    if (disposal) await disposal;
    else await broker.dispose().catch(() => {});
    endpoints?.[0].close();
    endpoints?.[1].close();
    disposePipes();
  }
});

test("a rejected filesystem fence does not stop consumers or force relay disposal", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  const failure = new Error("filesystem still owns admitted work");
  let rejectFence!: (reason: unknown) => void;
  const fence = new Promise<void>((_resolve, reject) => {
    rejectFence = reject;
  });
  let stops = 0,
    relayDisposals = 0;
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry: new ExecutableRegistry(),
    onError() {},
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      quiesce: () => fence,
    },
    launch() {
      throw new Error("unused");
    },
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  const registry = new PipePublicationRegistry();
  registry.registerProcess(root.pid);
  root.data = { filesystem: createFilesystemIdentity(), pipeRegistry: registry.handle() };
  const publications: Promise<void>[] = [];
  const host = new WorkerPipeHost({
    transport: root,
    registry,
    postMessage: (message) => {
      publications.push(broker.runtimeMessage(message, workerProcessState(root).pid));
    },
  });
  const pipes = Reflect.get(broker, "pipes") as WorkerPipeBroker,
    disposePipes = pipes.dispose.bind(pipes);
  pipes.dispose = () => {
    relayDisposals++;
    disposePipes();
  };
  let endpoints: ReturnType<WorkerPipeHost["createPipe"]> | undefined;
  let disposal: Promise<unknown> | undefined;
  try {
    await broker.adoptRuntimeRoot(root, {
      stop() {
        stops++;
      },
    });
    endpoints = host.createPipe();
    await Promise.all(publications);
    disposal = broker.dispose().then(
      () => undefined,
      (error) => error,
    );
    rejectFence(failure);
    expect(await disposal).toBe(failure);
    expect(stops).toBe(0);
    expect(relayDisposals).toBe(0);
  } finally {
    rejectFence(failure);
    if (disposal) await disposal;
    else await broker.dispose().catch(() => {});
    // These local endpoints are the test's only physical consumers; close both before
    // manually cleaning the deliberately retained relay after the simulated fence failure.
    endpoints?.[0].close();
    endpoints?.[1].close();
    disposePipes();
  }
});

for (const operation of ["process", "job"] as const)
  test(`a ${operation} kill tolerates disposal while awaiting activation`, async () => {
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities);
    const broker = new BrowserProcessBroker({
      identities,
      table,
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
    let killing: Promise<void> | undefined, disposal: Promise<void> | undefined;
    try {
      const pid = await broker.adoptRoot({}),
        supervisor = await broker.ready();
      const root = supervisor.get(pid)!;
      killing = operation === "process" ? broker.kill(pid, 9) : broker.killJob(root.job, 9);
      expect(readOutcome(root.outcome)?.status).toBe(137);
      disposal = broker.dispose();
      await killing;
      await disposal;
    } finally {
      await Promise.allSettled([killing, disposal]);
      await broker.dispose();
    }
  });

for (const kind of ["direct", "runtime"] as const)
  test(`one hundred completed ${kind} roots release reservations and historical callbacks without activation`, async () => {
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities);
    let activations = 0,
      stops = 0,
      retired = 0;
    const filesystem = createFilesystemIdentity();
    const broker = new BrowserProcessBroker({
      identities,
      table,
      registry: new ExecutableRegistry(),
      activate: async () => {
        activations++;
        return import("../proc/index.js");
      },
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
      for (let run = 0; run < 100; run++) {
        const controller = {
          stop() {
            stops++;
          },
          retired() {
            retired++;
          },
        };
        let pid: number;
        if (kind === "direct") pid = broker.reserveRoot({}, controller);
        else {
          const root = createWorkerProcessTransport({
            pid: identities.pid(),
            job: identities.job(),
            identity: identities.buffer,
          });
          root.data = {
            filesystem,
            pipeRegistry: new PipePublicationRegistry({
              processCapacity: 1,
              cellsPerProcess: 1,
              maxCells: 4,
            }).handle(),
          };
          pid = workerProcessState(root).pid;
          await broker.adoptRuntimeRoot(root, controller);
        }
        await broker.rootExit(pid, 0);
        expect(broker.transportFor(pid)).toBeUndefined();
      }
      expect(activations).toBe(0);
      expect(retired).toBe(100);
      for (const name of [
        "reservedRoots",
        "controllers",
        "roots",
        "outputs",
        "registries",
        "fences",
      ])
        expect((Reflect.get(broker, name) as Map<unknown, unknown>).size).toBe(0);
      expect(Array.from(table.values())).toHaveLength(0);
      await broker.dispose();
      expect(stops).toBe(0);
      expect(retired).toBe(100);
    } finally {
      await broker.dispose();
    }
  });

test("root retirement waits for the filesystem fence", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  let release!: () => void;
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  let retired = 0;
  const broker = new BrowserProcessBroker({
    identities,
    table,
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
  let completion: Promise<void> | undefined;
  try {
    const controller = {
      quiesce: () => fence,
      retired() {
        retired++;
      },
    };
    const pid = broker.reserveRoot({}, controller);
    completion = broker.rootExit(pid, 0);
    expect(retired).toBe(0);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(true);
    release();
    await completion;
    expect(retired).toBe(1);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
  } finally {
    release();
    await completion;
    await broker.dispose();
  }
});

test("a pending admission lease retains a completed root until released exactly once", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  let retired = 0;
  const broker = new BrowserProcessBroker({
    identities,
    table,
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
  let release: (() => void) | undefined;
  try {
    const controller = {
      retired() {
        retired++;
      },
    };
    const pid = broker.reserveRoot({}, controller);
    release = broker.retainRoot(pid);
    await broker.rootExit(pid, 0);
    expect(retired).toBe(0);
    expect((Reflect.get(broker, "reservedRoots") as Map<number, unknown>).has(pid)).toBe(true);
    release();
    release();
    expect(retired).toBe(1);
    expect((Reflect.get(broker, "reservedRoots") as Map<number, unknown>).has(pid)).toBe(false);
  } finally {
    release?.();
    await broker.dispose();
  }
});

test("a direct root retains its controller while immutable-root descendants outlive compressed ancestry", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  let retired = 0;
  const broker = new BrowserProcessBroker({
    identities,
    table,
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
    const root = await broker.adoptRoot(
      {},
      {
        retired() {
          retired++;
        },
      },
    );
    const supervisor = await broker.ready();
    const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] };
    const child = supervisor.reserveSpawn(root, request),
      grandchild = supervisor.reserveSpawn(child, request);
    await broker.rootExit(root, 0);
    expect(table.parentOf(child)).toBe(0);
    expect(table.get(child)?.rootPid).toBe(root);
    expect(table.get(grandchild)?.rootPid).toBe(root);
    expect(retired).toBe(0);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(root)).toBe(true);
    const childExit = supervisor.waitForExit(root, child);
    supervisor.exit(child, 1);
    await childExit;
    expect(table.parentOf(grandchild)).toBe(0);
    expect(retired).toBe(0);
    const grandchildExit = supervisor.waitForExit(child, grandchild);
    supervisor.exit(grandchild, 2);
    await grandchildExit;
    expect(retired).toBe(1);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(root)).toBe(false);
  } finally {
    await broker.dispose();
  }
});

test("a long-running direct root does not retain settled child filesystem fences", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({
    identities,
    table,
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
  const fences = Reflect.get(broker, "fences") as Map<number, Promise<void>>;
  let fence: Promise<void>;
  const controller = { quiesce: () => fence };
  let release: (() => void) | undefined;
  try {
    const root = await broker.adoptRoot({}),
      supervisor = await broker.ready();
    for (let iteration = 0; iteration < 64; iteration++) {
      const child = supervisor.reserveSpawn(root, {
        executable: "fixture",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      const job = table.get(child)!.job;
      fence = new Promise<void>((resolve) => {
        release = resolve;
      });
      broker.registerController(child, controller);
      const completion = supervisor.waitForExit(root, child);
      supervisor.exit(child, 0);
      expect(fences.has(child)).toBe(true);
      expect(table.get(child)?.result).toBeNull();
      release!();
      await completion;
      supervisor.reap(root, child);
      broker.releaseLegacyJob(job);
      expect(fences.size).toBe(0);
    }
    expect(table.get(root)?.result).toBeNull();
  } finally {
    release?.();
    await broker.dispose();
  }
});

for (const operation of ["states", "revoke"] as const)
  test(`browser ${operation} enumeration skips a concurrently collected unrelated process`, async () => {
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities);
    const broker = new BrowserProcessBroker({
      identities,
      table,
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
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
      capacity: 2,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    const descriptors = new DescriptorTable(),
      messages: WorkerProcessMessage[] = [];
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: {
        export() {
          throw new Error("unused");
        },
        import() {
          throw new Error("unused");
        },
        discard() {},
      },
      postMessage(message) {
        messages.push(message);
      },
    });
    let load: ReturnType<typeof spyOn> | undefined;
    try {
      await broker.adoptRuntimeRoot(root);
      client.spawn(client.pid, {
        executable: "fixture",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      const notice = messages[0]!;
      if (notice.operation !== "spawn") throw new Error("missing spawn fixture");
      const child = workerProcessState(notice.transport);
      claimOutcome(child.signals.outcome, { kind: "exited", code: 0 });
      confirmDirectoryProcess(notice.transport);
      const originalLoad = TaggedCells.prototype.load;
      let collected = false;
      load = spyOn(TaggedCells.prototype, "load").mockImplementation(function (
        this: TaggedCells,
        index = 0,
      ) {
        // Collect the next row while decoding the root. Bare-slot snapshots have already
        // included that child and subsequently throw; captured enumeration safely skips it.
        if (!collected && this.buffer === root.directory && this.id === client.pid && index === 2) {
          collected = true;
          collectDirectoryJob(root.directory, child.jobSlot, child.job);
        }
        return originalLoad.call(this, index);
      });
      if (operation === "states") {
        const states = (Reflect.get(broker, "states") as () => { pid: number }[]).call(broker);
        expect(states.map((state) => state.pid)).toEqual([client.pid]);
      } else expect(() => broker.revokeRuntimeProcess(-1)).not.toThrow();
      expect(collected).toBe(true);
    } finally {
      load?.mockRestore();
      descriptors.dispose();
      await broker.dispose();
    }
  });

test("suspension still fences and stops every consumer when a Worker collects a captured process", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  let stops = 0,
    retired = 0,
    fenced = 0;
  const diagnostics: unknown[] = [];
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry: new ExecutableRegistry(),
    onError: (error) => diagnostics.push(error),
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {
        fenced++;
      },
    },
    launch() {
      throw new Error("unused");
    },
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
    capacity: 2,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  const descriptors = new DescriptorTable(),
    notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: {
      export() {
        throw new Error("unused");
      },
      import() {
        throw new Error("unused");
      },
      discard() {},
    },
    postMessage(message) {
      notices.push(message);
    },
  });
  let load: ReturnType<typeof spyOn> | undefined;
  try {
    await broker.adoptRuntimeRoot(root, {
      stop() {
        stops++;
      },
      retired() {
        retired++;
      },
    });
    client.spawn(client.pid, {
      executable: "fixture",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    const notice = notices[0]!;
    if (notice.operation !== "spawn") throw new Error("missing spawn fixture");
    const child = workerProcessState(notice.transport),
      rootState = workerProcessState(root);
    claimOutcome(child.signals.outcome, { kind: "exited", code: 0 });
    confirmDirectoryProcess(notice.transport);
    const originalLoad = TaggedCells.prototype.load;
    let collected = false;
    load = spyOn(TaggedCells.prototype, "load").mockImplementation(function (
      this: TaggedCells,
      index = 0,
    ) {
      // All shared states have been decoded by now. Collection during the preceding
      // root's signal publication invalidates a later member of that captured array.
      if (
        !collected &&
        this.buffer === root.directory &&
        this.id === root.pid &&
        this.byteOffset === rootState.signals.requestedSignal.byteOffset
      ) {
        collected = true;
        collectDirectoryJob(root.directory, child.jobSlot, child.job);
      }
      return originalLoad.call(this, index);
    });
    const disposal = broker.dispose();
    await expect(disposal).resolves.toBeUndefined();
    expect(broker.dispose()).toBe(disposal);
    expect(collected).toBe(true);
    expect(fenced).toBeGreaterThan(0);
    expect(stops).toBe(1);
    expect(retired).toBe(1);
    expect(diagnostics).toEqual([]);
    for (const name of ["reservedRoots", "controllers", "roots", "outputs", "registries", "fences"])
      expect((Reflect.get(broker, name) as Map<unknown, unknown>).size).toBe(0);
  } finally {
    load?.mockRestore();
    descriptors.dispose();
    await broker.dispose().catch(() => {});
  }
});

test("suspension skips consumed shared outcomes still retained in completed host records", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("fixture", {
    adapter: "fixture",
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    interruptible: true,
  });
  let stopped = 0,
    retired = 0;
  const diagnostics: unknown[] = [];
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError: (error) => diagnostics.push(error),
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      return { terminate() {} };
    },
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
    capacity: 2,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  const descriptors = new DescriptorTable(),
    notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: {
      export() {
        throw new Error("unused");
      },
      import() {
        throw new Error("unused");
      },
      discard() {},
    },
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
    postMessage(message) {
      notices.push(message);
    },
  });
  try {
    await broker.adoptRuntimeRoot(root, {
      stop() {
        stopped++;
      },
      retired() {
        retired++;
      },
    });
    const pid = client.spawn(client.pid, {
      executable: "fixture",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    await broker.runtimeMessage(notices.shift()!, client.pid);
    const supervisor = await broker.ready();
    await supervisor.start(pid);
    const child = workerProcessState(broker.transportFor(pid)!);
    const completion = supervisor.waitForExit(client.pid, pid);
    supervisor.exit(pid, 23);
    await completion;
    expect(client.waitJob(client.pid, child.job)?.code).toBe(23);
    // The shared consuming receipt is still queued, so the host retains this completed row.
    expect(notices.at(-1)?.operation).toBe("reap-job");
    expect(table.get(pid)?.result?.code).toBe(23);
    expect(() => readOutcome(child.signals.outcome)).toThrow("collected");
    await expect(broker.dispose()).resolves.toBeUndefined();
    expect(stopped).toBe(1);
    expect(retired).toBe(1);
    expect(diagnostics).toEqual([]);
    expect(Array.from(table.values())).toHaveLength(0);
  } finally {
    descriptors.dispose();
    await broker.dispose().catch(() => {});
  }
});

for (const phase of ["publication", "outcome snapshot"] as const)
  test(`whole-job signalling continues after collection during ${phase}`, async () => {
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities);
    const broker = new BrowserProcessBroker({
      identities,
      table,
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
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
      capacity: 3,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    const descriptors = new DescriptorTable(),
      notices: WorkerProcessMessage[] = [];
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: {
        export() {
          throw new Error("unused");
        },
        import() {
          throw new Error("unused");
        },
        discard() {},
      },
      postMessage(message) {
        notices.push(message);
      },
    });
    let guard: ReturnType<typeof spyOn> | undefined;
    try {
      await broker.adoptRuntimeRoot(root);
      const request = {
        executable: "fixture",
        argv: [],
        env: {},
        cwd: "/",
        job: client.job,
        fds: [],
      };
      client.spawn(client.pid, request);
      client.spawn(client.pid, request);
      const dead = notices[0]!,
        live = notices[1]!;
      if (dead.operation !== "spawn" || live.operation !== "spawn")
        throw new Error("missing spawn fixture");
      const child = workerProcessState(dead.transport),
        sibling = workerProcessState(live.transport),
        rootState = workerProcessState(root);
      claimOutcome(child.signals.outcome, { kind: "exited", code: 0 });
      confirmDirectoryProcess(dead.transport);
      let collected = false;
      if (phase === "publication") {
        const originalLoad = TaggedCells.prototype.load;
        guard = spyOn(TaggedCells.prototype, "load").mockImplementation(function (
          this: TaggedCells,
          index = 0,
        ) {
          if (
            !collected &&
            this.buffer === root.directory &&
            this.id === root.pid &&
            this.byteOffset === rootState.signals.requestedSignal.byteOffset
          ) {
            collected = true;
            collectDirectoryProcess(dead.transport);
          }
          return originalLoad.call(this, index);
        });
      } else {
        const originalCheck = OutcomeCell.prototype.check;
        guard = spyOn(OutcomeCell.prototype, "check").mockImplementation(function (
          this: OutcomeCell,
        ) {
          if (
            !collected &&
            this.buffer === root.directory &&
            this.pid === child.pid &&
            controlLoad(rootState.signals.requestedSignal) === 9 &&
            controlLoad(sibling.signals.requestedSignal) === 9
          ) {
            collected = true;
            collectDirectoryProcess(dead.transport);
          }
          originalCheck.call(this);
        });
      }
      await expect(broker.killJob(client.job, 9)).resolves.toBeUndefined();
      expect(collected).toBe(true);
      expect(readOutcome(sibling.signals.outcome)).toMatchObject({ kind: "signaled", code: 9 });
      expect(controlLoad(sibling.signals.requestedSignal)).toBe(9);
    } finally {
      guard?.mockRestore();
      descriptors.dispose();
      await broker.dispose();
    }
  });

test("a completed runtime root retains queued background descendants until their job is reaped", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("fixture", {
    adapter: "fixture",
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    interruptible: true,
  });
  let retired = 0,
    launches = 0;
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      launches++;
      return { terminate() {} };
    },
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  const messages: WorkerProcessMessage[] = [],
    descriptors = new DescriptorTable();
  const host = new WorkerPipeHost({
    transport: root,
    postMessage: (message) => messages.push(message),
  });
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: host.codec(),
    postMessage: (message) => messages.push(message),
    prepareSpawn: (pid) => {
      host.registry.registerProcess(pid);
      return {
        data: { filesystem: createFilesystemIdentity(), pipeRegistry: host.registry.handle() },
        cancel: () => host.registry.collectProcess(pid),
      };
    },
  });
  try {
    const controller = {
      retired() {
        retired++;
      },
    };
    await broker.adoptRuntimeRoot(root, controller);
    const owner = Reflect.get(broker, "transport") as WorkerProcessBroker;
    expect(() => owner.releaseRoot(client.pid)).toThrow(/unconfirmed or unreaped/);
    const childPid = client.spawn(client.pid, {
      executable: "fixture",
      argv: ["fixture"],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    await broker.rootExit(client.pid, 0);
    expect(() => owner.releaseRoot(client.pid)).toThrow(/unconfirmed or unreaped/);
    expect(retired).toBe(0);
    expect(broker.transportFor(client.pid)).toBe(root);
    for (const message of messages) await broker.runtimeMessage(message, client.pid);
    const supervisor = await broker.ready();
    await supervisor.start(childPid);
    expect(launches).toBe(1);
    const childJob = supervisor.get(childPid)!.job;
    expect(supervisor.canWaitJob(client.pid, childJob)).toBe(true);
    expect(retired).toBe(0);
    supervisor.exit(childPid, 0);
    await supervisor.waitForExit(client.pid, childPid);
    expect(retired).toBe(0);
    expect(() => owner.releaseRoot(client.pid)).toThrow(/unconfirmed or unreaped/);
    expect(supervisor.waitJob(client.pid, childJob)?.status).toBe(0);
    expect(retired).toBe(1);
    expect(broker.transportFor(client.pid)).toBeUndefined();
    expect(broker.transportFor(childPid)).toBeUndefined();
    expect(Array.from(table.values())).toHaveLength(0);
  } finally {
    descriptors.dispose();
    await broker.dispose();
  }
});

test("reentrant disposal shares one promise and stops each consumer once", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  let stops = 0,
    nested: Promise<void> | undefined;
  const broker = new BrowserProcessBroker({
    identities,
    table,
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
  broker.reserveRoot(
    {},
    {
      revoke() {
        nested = broker.dispose();
      },
      stop() {
        stops++;
      },
    },
  );
  const outer = broker.dispose();
  try {
    expect(nested).toBe(outer);
    await outer;
    expect(stops).toBe(1);
  } finally {
    await Promise.allSettled([outer, nested]);
  }
});

for (const terminal of ["cleanup-error", "exit", "error"] as const)
  test(`generic child ${terminal} reports cleanup diagnostics without inventing an acknowledgement`, async () => {
    const previousWorker = globalThis.Worker;
    const workers: FakeWorker[] = [],
      channels: MessagePort[] = [],
      diagnostics: unknown[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminations = 0;
      constructor() {
        workers.push(this);
      }
      postMessage() {}
      terminate() {
        this.terminations++;
      }
      emit(data: unknown) {
        this.onmessage?.({ data } as MessageEvent);
      }
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities),
      registry = new ExecutableRegistry();
    registry.register("fixture", {
      adapter: "fixture",
      module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      interruptible: true,
    });
    let releaseFence!: () => void,
      reaped = 0;
    const fence = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const broker = new BrowserProcessBroker({
      identities,
      table,
      registry,
      onError: (error) => diagnostics.push(error),
      filesystem: {
        connect(identity) {
          const { client, server } = connectFilesystemIdentity(identity);
          channels.push(client.port, server.port);
          return client;
        },
        revoke() {},
        reap() {
          reaped++;
        },
        quiesce: () => fence,
      },
      launch: (context) =>
        broker.launchWorker(context, {
          workerUrl: "http://localhost/fixture-worker.js",
          request: { module: context.module, args: context.request.argv, env: context.request.env },
        }),
    });
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    const messages: WorkerProcessMessage[] = [],
      descriptors = new DescriptorTable();
    const host = new WorkerPipeHost({
      transport: root,
      postMessage: (message) => messages.push(message),
    });
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: host.codec(),
      postMessage: (message) => messages.push(message),
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
    });
    try {
      await broker.adoptRuntimeRoot(root);
      const pid = client.spawn(client.pid, {
        executable: "fixture",
        argv: ["fixture"],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      for (const message of messages) await broker.runtimeMessage(message, client.pid);
      const supervisor = await broker.ready();
      await supervisor.start(pid);
      const transport = broker.transportFor(pid)!;
      claimOutcome(workerProcessState(transport).signals.outcome, { kind: "exited", code: 7 });
      workers[0]!.emit({
        type: terminal,
        code: 7,
        message: "guest cleanup failed",
        cleanupErrors: ["descriptor release failed"],
      });
      expect(diagnostics).toHaveLength(1);
      expect(String(diagnostics[0])).toContain("descriptor release failed");
      expect(reaped).toBe(terminal === "cleanup-error" ? 0 : 1);
      if (terminal === "cleanup-error") {
        expect(supervisor.get(pid)?.result).toBeNull();
        expect(controlLoad(workerProcessState(transport).confirmed, 0)).toBe(0);
        expect(workers[0]!.terminations).toBe(0);
      }
      releaseFence();
      expect((await supervisor.waitForExit(client.pid, pid)).status).toBe(7);
      expect(workers[0]!.terminations).toBe(1);
    } finally {
      releaseFence();
      try {
        descriptors.dispose();
        await broker.dispose();
      } finally {
        for (const port of channels) port.close();
        globalThis.Worker = previousWorker;
      }
    }
  });

for (const diagnostic of ["inherited", "controller"] as const)
  test(`startup failures write ${diagnostic} diagnostics before closing inherited stderr`, async () => {
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities),
      registry = new ExecutableRegistry();
    const failure = new Error("fixture compiler refused this source");
    registry.register("fixture", {
      adapter: "fixture",
      module() {
        throw failure;
      },
    });
    const events: string[] = [],
      output: string[] = [],
      source = new DescriptorTable();
    const broker = new BrowserProcessBroker({
      identities,
      table,
      registry,
      filesystem: {
        connect() {
          throw new Error("unused");
        },
        revoke() {},
        reap() {},
        async quiesce() {},
      },
      launch() {
        throw new Error("must not launch failed source");
      },
    });
    try {
      const rootPid = await broker.adoptRoot({}),
        supervisor = await broker.ready();
      const pid = supervisor.reserveSpawn(rootPid, {
        executable: "fixture",
        argv: ["fixture"],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      const fd = source.open(
        {
          kind: "terminal",
          read: () => 0,
          write() {
            throw new Error("startup diagnostics must not use blocking writes");
          },
          tryWrite(chunks) {
            events.push("diagnostic");
            output.push(new TextDecoder().decode(chunks[0]!));
            return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          },
          readiness: () => ({ readable: false, writable: true, hangup: false }),
          close() {
            events.push("closed");
          },
        },
        0n,
        0n,
      );
      supervisor.get(pid)!.descriptors.inherit(2, source.get(fd)!);
      source.close(fd);
      if (diagnostic === "controller") {
        const controller = {
          startFailed(error: unknown) {
            events.push("controller-diagnostic");
            output.push(String(error));
          },
        };
        broker.registerController(pid, controller);
      }
      await supervisor.start(pid);
      expect(supervisor.get(pid)?.result).toMatchObject({
        kind: "start-failed",
        code: 5,
        error: "EIO",
        status: null,
      });
      expect(output).toHaveLength(1);
      expect(output[0]).toContain(failure.message);
      expect(events).toEqual([
        diagnostic === "controller" ? "controller-diagnostic" : "diagnostic",
        "closed",
      ]);
    } finally {
      source.dispose();
      await broker.dispose();
    }
  });

test("broker disposal does not await a controller startup diagnostic that never settles", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("fixture", {
    adapter: "fixture",
    module() {
      throw new Error("fixture compiler failed");
    },
  });
  let active!: () => boolean,
    closed = 0,
    stopped = 0;
  const errors: unknown[] = [];
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError: (error) => errors.push(error),
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("must not launch failed source");
    },
  });
  try {
    const root = await broker.adoptRoot({}),
      supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, {
      executable: "fixture",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    supervisor.get(pid)!.descriptors.open(
      {
        kind: "terminal",
        read: () => 0,
        write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }),
        close() {
          closed++;
        },
      },
      0n,
      0n,
    );
    broker.registerController(pid, {
      startFailed(_error, current) {
        active = current;
        return new Promise<void>(() => {});
      },
      stop() {
        stopped++;
      },
    });
    await supervisor.start(pid);
    expect(active()).toBe(true);
    await broker.dispose();
    expect(active()).toBe(false);
    expect(closed).toBe(1);
    expect(stopped).toBe(1);
    expect(Array.from(table.values())).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ errno: ProcessErrno.CANCELED });
  } finally {
    await broker.dispose();
  }
});

for (const failure of ["first-import", "error-event", "running-error"] as const)
  test(`generic child ${failure} preserves startup versus execution failure`, async () => {
    const { failFirstWorkerImport } = await import("./first-worker-import.js");
    const previousWorker = globalThis.Worker;
    const workers: FakeWorker[] = [],
      ports: MessagePort[] = [];
    class FakeWorker {
      request?: import("../browser/worker.js").RuntimeWorkerRequest;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() {
        workers.push(this);
      }
      postMessage(request: import("../browser/worker.js").RuntimeWorkerRequest) {
        this.request = request;
      }
      terminate() {}
      emit(data: unknown) {
        this.onmessage?.({ data } as MessageEvent);
      }
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities),
      registry = new ExecutableRegistry();
    registry.register("fixture", {
      adapter: "fixture",
      module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    });
    const broker = new BrowserProcessBroker({
      identities,
      table,
      registry,
      filesystem: {
        connect(identity) {
          const pair = connectFilesystemIdentity(identity);
          ports.push(pair.client.port, pair.server.port);
          return pair.client;
        },
        revoke() {},
        reap() {},
        async quiesce() {},
      },
      launch: (context) =>
        broker.launchWorker(context, {
          workerUrl: "http://localhost/worker.js",
          request: { module: context.module, args: [], env: {} },
        }),
    });
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    const messages: WorkerProcessMessage[] = [],
      descriptors = new DescriptorTable();
    const host = new WorkerPipeHost({
      transport: root,
      postMessage: (message) => messages.push(message),
    });
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: host.codec(),
      postMessage: (message) => messages.push(message),
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
    });
    try {
      await broker.adoptRuntimeRoot(root);
      const pid = client.spawn(client.pid, {
        executable: "fixture",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      for (const message of messages) await broker.runtimeMessage(message, client.pid);
      const supervisor = await broker.ready();
      await supervisor.start(pid);
      const worker = workers[0]!;
      if (failure === "first-import")
        await failFirstWorkerImport(worker.request!, (data) => worker.emit(data));
      else {
        if (failure === "running-error") {
          // An instantiate message is not the entry boundary; the executing host commits it.
          expect(
            markStarted(workerProcessState(worker.request!.runtimeProcess!).signals.outcome),
          ).toBe(true);
          worker.emit({ type: "phase", name: "instantiate", duration: 0 });
        }
        worker.onerror!({ preventDefault() {}, message: "worker rejected" } as ErrorEvent);
      }
      const result = await supervisor.waitForExit(client.pid, pid);
      expect(result).toEqual(
        failure === "running-error"
          ? { kind: "exited", code: 126, status: 126 }
          : { kind: "start-failed", code: 5, error: "EIO", status: null },
      );
      expect(client.wait(client.pid, pid)).toEqual(result);
    } finally {
      descriptors.dispose();
      try {
        await broker.dispose();
      } finally {
        for (const port of ports) port.close();
        globalThis.Worker = previousWorker;
      }
    }
  });
const regressionCleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  while (regressionCleanups.length) {
    try {
      await regressionCleanups.pop()!();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "regression cleanup failed");
});
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("accepted-writer regression gate timed out")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const activation of ["lazy", "eager"] as const)
  for (const exitAt of ["before-admission", "before-launch"] as const) {
    test(`accepted inherited writers survive parent exit ${exitAt} with ${activation} root activation`, async () => {
      const identities = new ProcessIdentityAllocator(),
        table = new ProcessTable(identities),
        registry = new ExecutableRegistry();
      const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      let releaseModule!: () => void, resolvingModule!: () => void;
      const moduleGate = new Promise<void>((resolve) => {
        releaseModule = resolve;
      });
      const moduleRequested = new Promise<void>((resolve) => {
        resolvingModule = resolve;
      });
      registry.register("leader", { adapter: "fixture", module, interruptible: true });
      registry.register("descendant", {
        adapter: "fixture",
        async module() {
          resolvingModule();
          await moduleGate;
          return module;
        },
        interruptible: true,
      });
      const contexts = new Map<number, import("../proc/types.js").ProcessContext>();
      const diagnostics: unknown[] = [],
        ports: MessagePort[] = [];
      const previousWorker = globalThis.Worker,
        workers = new Map<number, FakeWorker>();
      class FakeWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        terminations = 0;
        postMessage(request: import("../browser/worker.js").RuntimeWorkerRequest) {
          workers.set(workerProcessState(request.runtimeProcess!).pid, this);
        }
        terminate() {
          this.terminations++;
        }
        emit(data: unknown) {
          this.onmessage?.({ data } as MessageEvent);
        }
      }
      const tables: DescriptorTable[] = [];
      let reader: PipeEndpoint | undefined,
        cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        releaseModule();
        // Restore global state before any asynchronous fence, including after a test timeout.
        globalThis.Worker = previousWorker;
        try {
          for (const descriptors of tables) descriptors.dispose();
          reader?.close();
          if (broker) await bounded(broker.dispose());
        } finally {
          for (const port of ports) port.close();
        }
      };
      regressionCleanups.push(cleanup);
      globalThis.Worker = FakeWorker as unknown as typeof Worker;
      const broker = new BrowserProcessBroker({
        identities,
        table,
        registry,
        filesystem: {
          connect(identity) {
            const { client, server } = connectFilesystemIdentity(identity);
            ports.push(client.port, server.port);
            return client;
          },
          revoke: revokeFilesystem,
          reap: revokeFilesystem,
          async quiesce() {},
        },
        launch(context) {
          contexts.set(context.pid, context);
          return broker!.launchWorker(context, {
            workerUrl: "https://example.test/fixture-worker.js",
            request: {
              module: context.module,
              args: context.request.argv,
              env: context.request.env,
            },
          });
        },
        onError(error) {
          diagnostics.push(error);
        },
      });
      const root = createWorkerProcessTransport({
        pid: identities.pid(),
        job: identities.job(),
        identity: identities.buffer,
      });
      root.data = { filesystem: createFilesystemIdentity() };
      const messages: WorkerProcessMessage[] = [];
      const makeClient = (transport: typeof root) => {
        const descriptors = new DescriptorTable();
        tables.push(descriptors);
        const host = new WorkerPipeHost({
          transport,
          registry: (
            transport.data as {
              pipeRegistry: ConstructorParameters<typeof WorkerPipeHost>[0]["registry"];
            }
          ).pipeRegistry,
          postMessage(message) {
            messages.push(structuredClone(message));
          },
          pipe: { capacity: 8, maxWriters: 8, maxReaders: 8 },
        });
        const client = new WorkerProcessClient({
          transport,
          descriptors,
          codec: host.codec(),
          postMessage(message) {
            messages.push(structuredClone(message));
          },
          prepareSpawn: (pid) => {
            host.registry.registerProcess(pid);
            return {
              data: {
                filesystem: createFilesystemIdentity(),
                pipeRegistry: host.registry.handle(),
              },
              cancel: () => host.registry.collectProcess(pid),
            };
          },
        });
        client.installBindings();
        return { client, descriptors, host };
      };
      const spawn = (executable: string, job: number, parent: number) => ({
        executable,
        argv: [executable],
        env: {},
        cwd: "/",
        job,
        fds: [{ child: 1, parent }],
      });
      try {
        await bounded(broker.adoptRuntimeRoot(root));
        if (activation === "eager") await bounded(broker.ready());
        const owner = makeClient(root),
          pair = owner.host.createPipe();
        reader = pair[0];
        const writerFd = owner.descriptors.open(pair[1], 127n, 63n);
        const parentPid = owner.client.spawn(owner.client.pid, spawn("leader", -1, writerFd));
        owner.descriptors.close(writerFd);
        while (messages.length)
          await bounded(broker.runtimeMessage(messages.shift()!, owner.client.pid));
        const supervisor = await bounded(broker.ready());
        await bounded(supervisor.start(parentPid));
        const parent = makeClient(broker.transportFor(parentPid)!);
        const childPid = parent.client.spawn(parentPid, spawn("descendant", parent.client.job, 1));
        const notice = messages.shift()!;
        expect(notice.operation).toBe("spawn");
        const inherited = notice.transport.resources[0] as {
          endpoint: import("../proc/pipes.js").PipeEndpointHandle;
        };
        const inheritedEndpoint = attachPipeEndpoint(inherited.endpoint);
        const parentWorker = workers.get(parentPid)!;
        if (exitAt === "before-launch") {
          parentWorker.emit(notice);
          await bounded(moduleRequested);
        }
        // The guest can complete before the page dispatches its already-posted spawn event.
        // Acknowledgement then closes the parent's proxy before queued admission executes.
        parent.descriptors.dispose();
        parent.client.exit(0);
        revokeFilesystem(
          (
            broker.transportFor(parentPid)!.data as {
              filesystem: import("../fs/protocol.js").FilesystemIdentity;
            }
          ).filesystem,
        );
        if (exitAt === "before-admission") {
          parentWorker.emit(notice);
          expect(supervisor.get(childPid)).toBeUndefined();
        }
        parentWorker.emit({ type: "exit", code: 0 });
        expect((await bounded(supervisor.waitForExit(owner.client.pid, parentPid))).status).toBe(0);
        expect(parentWorker.terminations).toBe(1);
        expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
        expect(reader.readiness().hangup).toBe(false);
        expect(inheritedEndpoint.tryWrite([])).toBe(0);
        expect(contexts.has(childPid)).toBe(false);
        await bounded(moduleRequested);
        releaseModule();
        await bounded(supervisor.start(childPid));
        expect(contexts.has(childPid)).toBe(true);
        const child = makeClient(broker.transportFor(childPid)!);
        const writer = child.descriptors.get(1)!.resource as PipeEndpoint;
        expect(writer.tryWrite([new Uint8Array([68])])).toBe(1);
        const childExited = supervisor.waitForExit(parentPid, childPid);
        child.descriptors.dispose();
        child.client.exit(0);
        workers.get(childPid)!.emit({ type: "exit", code: 0 });
        await bounded(childExited);
        const bytes = new Uint8Array(1);
        expect(reader.tryRead([bytes])).toBe(1);
        expect(bytes[0]).toBe(68);
        expect(reader.tryRead([bytes])).toBe(0);
        expect(inheritedEndpoint.tryWrite([])).toBe(-PipeErrno.BADF);
        expect(diagnostics).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  }

for (const completion of [
  "exit",
  "error",
  "cleanup-error",
  "worker-error",
  "post-failure",
  "constructor-failure",
  "connect-failure",
  "kill",
  "dispose",
] as const) {
  test(`generic child ${completion} waits for adapter quiescence before confirmation and physical termination`, async () => {
    const previousWorker = globalThis.Worker;
    const workers: FakeWorker[] = [],
      channels: MessagePort[] = [];
    const events: string[] = [];
    const controllerFilesystem = createFilesystemIdentity();
    let releaseControllerFilesystem!: () => void;
    const controllerFilesystemFence = new Promise<void>((resolve) => {
      releaseControllerFilesystem = resolve;
    });
    let releaseAdapter!: () => void, releaseFilesystem!: () => void;
    const adapterFence = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    const filesystemFence = new Promise<void>((resolve) => {
      releaseFilesystem = resolve;
    });
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() {
        if (completion === "constructor-failure") throw new Error("worker constructor failed");
        workers.push(this);
      }
      postMessage() {
        if (completion === "post-failure") throw new Error("post failed");
      }
      terminate() {
        events.push("terminate");
      }
      emit(data: unknown) {
        this.onmessage?.({ data } as MessageEvent);
      }
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities),
      registry = new ExecutableRegistry();
    registry.register("fixture", {
      adapter: "fixture",
      module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      interruptible: true,
    });
    const broker = new BrowserProcessBroker({
      identities,
      table,
      registry,
      onError() {},
      filesystem: {
        connect(identity) {
          if (completion === "connect-failure") throw new Error("connection failed");
          const { client, server } = connectFilesystemIdentity(identity);
          channels.push(client.port, server.port);
          return client;
        },
        revoke() {},
        reap() {},
        quiesce: (identity) =>
          identity === controllerFilesystem ? controllerFilesystemFence : filesystemFence,
      },
      launch(context) {
        broker.registerController(context.pid, {
          filesystem: controllerFilesystem,
          revoke() {
            events.push("revoke");
          },
          quiesce() {
            expect(events).toContain("revoke");
            events.push("quiesce");
            return adapterFence;
          },
          retired() {
            events.push("retired");
          },
        });
        return broker.launchWorker(context, {
          workerUrl: "http://localhost/fixture-worker.js",
          cleanup() {
            events.push("cleanup");
          },
          request: { module: context.module, args: context.request.argv, env: context.request.env },
        });
      },
    });
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    const messages: WorkerProcessMessage[] = [],
      descriptors = new DescriptorTable();
    const host = new WorkerPipeHost({
      transport: root,
      postMessage: (message) => messages.push(message),
    });
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: host.codec(),
      postMessage: (message) => messages.push(message),
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
    });
    let disposing: Promise<void> | undefined;
    try {
      await broker.adoptRuntimeRoot(root);
      const pid = client.spawn(client.pid, {
        executable: "fixture",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      for (const message of messages) await broker.runtimeMessage(message, client.pid);
      const supervisor = await broker.ready();
      await supervisor.start(pid);
      const transport = broker.transportFor(pid)!;
      const record = supervisor.get(pid)!;
      if (completion === "worker-error")
        workers[0]!.onerror?.({ preventDefault() {}, message: "worker failed" } as ErrorEvent);
      else if (completion === "kill") await broker.kill(pid, 9);
      else if (completion === "dispose") disposing = broker.dispose();
      else if (
        completion !== "post-failure" &&
        completion !== "constructor-failure" &&
        completion !== "connect-failure"
      )
        workers[0]!.emit({ type: completion, code: 7, message: "guest failed", cleanupErrors: [] });
      expect(events).toContain("revoke");
      expect(events).toContain("quiesce");
      releaseFilesystem();
      // Draining just the filesystem (or receiving an exit acknowledgement) does not
      // certify the adapter's critical section. Terminate-first would hang this fence.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(events).not.toContain("terminate");
      expect(record.result).toBeNull();
      expect(controlLoad(workerProcessState(transport).confirmed, 0)).toBe(0);
      releaseAdapter();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // Controller identity B is independent of transport identity A and adapter quiescence.
      expect(record.result).toBeNull();
      expect(events).not.toContain("terminate");
      expect(events).not.toContain("cleanup");
      releaseControllerFilesystem();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(events.filter((event) => event === "terminate")).toHaveLength(
        completion === "constructor-failure" || completion === "connect-failure" ? 0 : 1,
      );
      expect(events.filter((event) => event === "cleanup")).toHaveLength(1);
      if (completion !== "dispose") {
        expect(record.result).not.toBeNull();
        expect(controlLoad(workerProcessState(transport).confirmed, 0)).toBe(1);
        expect(events).toContain("retired");
        expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
      }
    } finally {
      releaseAdapter();
      releaseFilesystem();
      releaseControllerFilesystem();
      try {
        descriptors.dispose();
        await (disposing ?? broker.dispose());
      } finally {
        for (const port of channels) port.close();
        globalThis.Worker = previousWorker;
      }
    }
  });
}

for (const controllerStop of [false, true])
  test(`an external asynchronous handle keeps cleanup authority until physical settlement (controller stop=${controllerStop})`, async () => {
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities),
      registry = new ExecutableRegistry();
    registry.register("external", {
      adapter: "external",
      module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      interruptible: true,
    });
    const events: string[] = [];
    let release!: () => void, context!: import("../proc/types.js").ProcessContext;
    const physical = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = new BrowserProcessBroker({
      identities,
      table,
      registry,
      filesystem: {
        connect() {
          throw new Error("unused");
        },
        revoke() {},
        reap() {},
        async quiesce() {},
      },
      launch(value) {
        context = value;
        broker.registerController(value.pid, {
          revoke() {
            events.push("revoke");
          },
          stop: controllerStop
            ? () => {
                events.push("controller stop");
                return physical;
              }
            : undefined,
          retired() {
            events.push("retired");
          },
        });
        return {
          terminate() {
            events.push("terminate");
            return physical;
          },
        };
      },
    });
    let disposal: Promise<void> | undefined;
    try {
      const root = await broker.adoptRoot({}),
        supervisor = await broker.ready();
      const pid = supervisor.spawn(root, {
        executable: "external",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      await supervisor.start(pid);
      context.exit(0);
      expect(events).toContain("terminate");
      expect(events).not.toContain("retired");
      let disposed = false;
      disposal = broker.dispose().then(() => {
        disposed = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(events.includes("controller stop")).toBe(controllerStop);
      expect(events).not.toContain("retired");
      expect(disposed).toBe(false);
      release();
      await disposal;
      expect(events.filter((event) => event === "retired")).toHaveLength(1);
    } finally {
      release();
      await (disposal ?? broker.dispose());
    }
  });

test("a controller registered before module rejection fences and settles physical cleanup before retirement", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("rejected", {
    adapter: "external",
    async module() {
      throw new Error("module rejected");
    },
    interruptible: true,
  });
  const events: string[] = [];
  let release!: () => void;
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseStop!: () => void;
  const physical = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError() {},
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("must not launch");
    },
  });
  try {
    const root = await broker.adoptRoot({}),
      supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, {
      executable: "rejected",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    broker.registerController(pid, {
      revoke() {
        events.push("revoke");
      },
      quiesce() {
        events.push("fence");
        return fence;
      },
      stop() {
        events.push("stop");
        return physical;
      },
      retired() {
        events.push("retired");
      },
    });
    await supervisor.start(pid);
    expect(events).toEqual(["revoke", "fence"]);
    expect(supervisor.get(pid)!.result).toBeNull();
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(supervisor.get(pid)!.result?.kind).toBe("start-failed");
    expect(events).toEqual(["revoke", "fence", "stop"]);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(true);
    releaseStop();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["revoke", "fence", "stop", "retired"]);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
    expect((Reflect.get(broker, "fences") as Map<number, unknown>).has(pid)).toBe(false);
  } finally {
    release();
    releaseStop();
    await broker.dispose();
  }
});

test("lazy external roots revoke before fencing without activating a supervisor", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  const events: string[] = [];
  let release!: () => void,
    activations = 0;
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry: new ExecutableRegistry(),
    activate: async () => {
      activations++;
      return import("../proc/index.js");
    },
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
  let completion: Promise<void> | undefined;
  try {
    const pid = broker.reserveRoot(
      {},
      {
        revoke() {
          events.push("revoke");
        },
        quiesce() {
          events.push("fence");
          return fence;
        },
        retired() {
          events.push("retired");
        },
      },
    );
    completion = broker.rootExit(pid, 0);
    expect(events).toEqual(["revoke", "fence"]);
    expect(activations).toBe(0);
    release();
    await completion;
    expect(events).toEqual(["revoke", "fence", "retired"]);
  } finally {
    release();
    await completion;
    await broker.dispose();
  }
});

test("a pending external launcher retains authority until its late rejection then releases the failed controller", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("pending", {
    adapter: "external",
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    interruptible: true,
  });
  const events: string[] = [];
  let rejectLaunch!: (error: unknown) => void,
    entered!: () => void,
    context!: import("../proc/types.js").ProcessContext;
  const launching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<import("../proc/types.js").ProcessHandle>((_resolve, reject) => {
    rejectLaunch = reject;
  });
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError() {},
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch(value) {
      context = value;
      entered();
      return pending;
    },
  });
  let starting: Promise<void> | undefined;
  try {
    const root = await broker.adoptRoot({}),
      supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, {
      executable: "pending",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    broker.registerController(pid, {
      revoke() {
        events.push("revoke");
      },
      stop() {
        events.push("stop");
      },
      retired() {
        events.push("retired");
      },
    });
    starting = supervisor.start(pid);
    await launching;
    context.startFailed(new Error("external startup rejected"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["revoke"]);
    rejectLaunch(new Error("launcher finally rejected"));
    await starting;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["revoke", "stop", "retired"]);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
  } finally {
    rejectLaunch(new Error("test cleanup"));
    await starting;
    await broker.dispose();
  }
});

test("a throwing exited notification still settles failed-start cleanup before reporting its error", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("rejected", {
    adapter: "external",
    async module() {
      throw new Error("module rejected");
    },
    interruptible: true,
  });
  const failure = new Error("exited notification failed"),
    errors: unknown[] = [],
    events: string[] = [];
  let release!: () => void, releaseStop!: () => void;
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  const physical = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError(error) {
      errors.push(error);
      events.push("error");
    },
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("must not launch");
    },
  });
  try {
    const root = await broker.adoptRoot({}),
      supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, {
      executable: "rejected",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    broker.registerController(pid, {
      revoke() {
        events.push("revoke");
      },
      quiesce() {
        events.push("fence");
        return fence;
      },
      exited() {
        events.push("exited");
        throw failure;
      },
      stop() {
        events.push("stop");
        return physical;
      },
      retired() {
        events.push("retired");
      },
    });
    await supervisor.start(pid);
    expect(events).toEqual(["revoke", "fence"]);
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(supervisor.get(pid)!.result?.kind).toBe("start-failed");
    expect(events).toEqual(["revoke", "fence", "exited", "stop"]);
    expect(errors).toEqual([]);
    releaseStop();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["revoke", "fence", "exited", "stop", "retired", "error"]);
    expect(errors).toEqual([failure]);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
  } finally {
    release();
    releaseStop();
    await broker.dispose();
  }
});

for (const settlement of ["resolve", "reject"] as const)
  test(`disposal retains a pending external launcher through late ${settlement} and physical cleanup`, async () => {
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities),
      registry = new ExecutableRegistry();
    registry.register("pending", {
      adapter: "external",
      module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      interruptible: true,
    });
    const events: string[] = [];
    let resolveLaunch!: (handle: import("../proc/types.js").ProcessHandle) => void,
      rejectLaunch!: (error: unknown) => void;
    let entered!: () => void, releaseStop!: () => void;
    const launching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<import("../proc/types.js").ProcessHandle>((resolve, reject) => {
      resolveLaunch = resolve;
      rejectLaunch = reject;
    });
    const physical = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const handle = {
      terminate() {
        events.push("terminate");
        return physical;
      },
    };
    const broker = new BrowserProcessBroker({
      identities,
      table,
      registry,
      onError() {},
      filesystem: {
        connect() {
          throw new Error("unused");
        },
        revoke() {},
        reap() {},
        async quiesce() {},
      },
      launch() {
        entered();
        return pending;
      },
    });
    let starting: Promise<void> | undefined, disposal: Promise<void> | undefined;
    try {
      const root = await broker.adoptRoot({}),
        supervisor = await broker.ready();
      const pid = supervisor.reserveSpawn(root, {
        executable: "pending",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      broker.registerController(pid, {
        revoke() {
          events.push("revoke");
        },
        stop() {
          events.push("stop");
        },
        retired() {
          events.push("retired");
        },
      });
      starting = supervisor.start(pid);
      await launching;
      let disposed = false;
      disposal = broker.dispose().then(() => {
        disposed = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // No controller stop or retirement may consume authority a late launcher still needs.
      expect(events).not.toContain("retired");
      expect(disposed).toBe(false);
      expect(events).toEqual(["revoke"]);
      expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(true);
      if (settlement === "resolve") resolveLaunch(handle);
      else rejectLaunch(new Error("late launcher rejection"));
      await starting;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (settlement === "resolve") {
        expect(events[0]).toBe("revoke");
        expect(events.slice(1).sort()).toEqual(["stop", "terminate"]);
        expect(disposed).toBe(false);
        expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(true);
      }
      releaseStop();
      await disposal;
      expect(events.at(-1)).toBe("retired");
      expect(events.filter((event) => event === "stop")).toHaveLength(1);
      expect(events.filter((event) => event === "retired")).toHaveLength(1);
      expect(events.filter((event) => event === "terminate")).toHaveLength(
        settlement === "resolve" ? 1 : 0,
      );
      expect((Reflect.get(broker, "controllers") as Map<number, unknown>).size).toBe(0);
    } finally {
      resolveLaunch(handle);
      releaseStop();
      await starting;
      await (disposal ?? broker.dispose());
    }
  });

for (const exitAt of ["after launch", "during launch", "launch throws"] as const)
  test(`a throwing exited notification waits for external cleanup (${exitAt})`, async () => {
    const identities = new ProcessIdentityAllocator(),
      table = new ProcessTable(identities),
      registry = new ExecutableRegistry();
    registry.register("external", {
      adapter: "external",
      module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      interruptible: true,
    });
    const failure = new Error("exited notification failed"),
      errors: unknown[] = [],
      events: string[] = [];
    let release!: () => void, context!: import("../proc/types.js").ProcessContext;
    const physical = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = new BrowserProcessBroker({
      identities,
      table,
      registry,
      onError(error) {
        errors.push(error);
        events.push("error");
      },
      filesystem: {
        connect() {
          throw new Error("unused");
        },
        revoke() {},
        reap() {},
        async quiesce() {},
      },
      launch(value) {
        context = value;
        if (exitAt !== "after launch") value.startFailed(new Error("reentrant startup failure"));
        if (exitAt === "launch throws") throw new Error("launcher threw after selecting failure");
        return {
          terminate() {
            events.push("terminate");
            return physical;
          },
        };
      },
    });
    try {
      const root = await broker.adoptRoot({}),
        supervisor = await broker.ready();
      const pid = supervisor.reserveSpawn(root, {
        executable: "external",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      broker.registerController(pid, {
        exited() {
          events.push("exited");
          throw failure;
        },
        stop:
          exitAt === "launch throws"
            ? () => {
                events.push("stop");
                return physical;
              }
            : undefined,
        retired() {
          events.push("retired");
        },
      });
      await supervisor.start(pid);
      if (exitAt === "after launch") context.exit(0);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(["exited", exitAt === "launch throws" ? "stop" : "terminate"]);
      expect(errors).toEqual([]);
      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual([
        "exited",
        exitAt === "launch throws" ? "stop" : "terminate",
        "retired",
        "error",
      ]);
      expect(errors).toEqual([failure]);
    } finally {
      release();
      await broker.dispose();
    }
  });

for (const activation of ["lazy", "eager"] as const)
  for (const signalAt of ["reserved", "admitted"] as const)
    test(`Bun inherited job reservations survive ${activation} activation and ${signalAt} kill/reap`, async () => {
      const { ProcessABI } = await import("../proc/abi");
      const { MemFS } = await import("../fs/memory");
      const identities = new ProcessIdentityAllocator(),
        table = new ProcessTable(identities),
        registry = new ExecutableRegistry();
      const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      registry.register("bun-like", { module, adapter: "fixture", interruptible: true });
      const broker = new BrowserProcessBroker({
        identities,
        table,
        registry,
        filesystem: {
          connect() {
            throw new Error("unused");
          },
          revoke() {},
          reap() {},
          async quiesce() {},
        },
        launch() {
          return { terminate() {} };
        },
      });
      const root = createWorkerProcessTransport({
        pid: identities.pid(),
        job: identities.job(),
        identity: identities.buffer,
      });
      root.data = { filesystem: createFilesystemIdentity() };
      const messages: WorkerProcessMessage[] = [],
        tables: DescriptorTable[] = [];
      const makeClient = (transport: typeof root) => {
        const descriptors = new DescriptorTable();
        tables.push(descriptors);
        const host = new WorkerPipeHost({
          transport,
          postMessage: (message) => messages.push(message),
        });
        const client = new WorkerProcessClient({
          transport,
          descriptors,
          codec: host.codec(),
          postMessage: (message) => messages.push(message),
          prepareSpawn: () => ({
            data: { filesystem: createFilesystemIdentity(), pipeRegistry: host.registry.handle() },
          }),
        });
        const abi = new ProcessABI({
          memory: new WebAssembly.Memory({ initial: 1 }),
          descriptors,
          fs: new MemFS(),
          pid: client.pid,
          service: client,
          signals: client.signals,
        });
        return { client, abi };
      };
      const request = (job: number) => ({
        executable: "bun-like",
        argv: [],
        env: {},
        cwd: "/",
        job,
        fds: [],
      });
      try {
        await broker.adoptRuntimeRoot(root);
        if (activation === "eager") await broker.ready();
        const shell = makeClient(root);
        const bunPid = shell.client.spawn(shell.client.pid, request(0));
        const bunNotice = messages.shift()!;
        const bun = makeClient(bunNotice.transport),
          job = bun.abi.imports.job_of!(0);
        const childPid = bun.client.spawn(bunPid, request(job)),
          childNotice = messages.shift()!;
        const child = makeClient(childNotice.transport);
        expect(child.abi.imports.job_of!(0)).toBe(job);
        expect(controlLoad(workerProcessState(bunNotice.transport).jobPending, 0)).toBe(2);
        expect(child.client.job).toBe(job);
        expect(table.get(childPid)).toBeUndefined();
        if (signalAt === "admitted") {
          await broker.runtimeMessage(bunNotice, shell.client.pid);
          await broker.runtimeMessage(childNotice, bunPid);
        }
        const childExit =
          signalAt === "admitted"
            ? (await broker.ready()).waitForExit(bunPid, childPid)
            : undefined;
        // Reserved descendants are targeted synchronously even before the page admits them.
        expect(shell.abi.imports.kill_job!(job, 9)).toBe(0);
        expect(readOutcome(child.client.signals.outcome)?.status).toBe(137);
        if (signalAt === "reserved") {
          await broker.runtimeMessage(bunNotice, shell.client.pid);
          await broker.runtimeMessage(childNotice, bunPid);
        }
        while (messages.length) await broker.runtimeMessage(messages.shift()!, shell.client.pid);
        const supervisor = await broker.ready();
        await supervisor.waitForExit(shell.client.pid, bunPid);
        if (signalAt === "admitted") {
          expect(await childExit).toMatchObject({ kind: "signaled", code: 9, status: 137 });
          expect(supervisor.get(childPid)).toBeUndefined();
        } else {
          // Admission rejects a killed sender's queued child, but confirms that shared
          // reservation after cleanup instead of leaking its pending membership.
          expect(supervisor.get(childPid)).toBeUndefined();
          // Its dead parent's orphan reservation is collected at the safety fence.
          expect(() => workerProcessState(childNotice.transport)).toThrow(
            "process incarnation was collected",
          );
        }
        expect(supervisor.jobOf(bunPid)).toBe(job);
        expect(supervisor.jobEmpty(shell.client.pid, job)).toBe(true);
        expect(controlLoad(workerProcessState(bunNotice.transport).jobPending, 0)).toBe(0);
        expect(shell.abi.imports.wait_job!(job, 1, 64)).toBe(0);
        while (messages.length) await broker.runtimeMessage(messages.shift()!, shell.client.pid);
        expect(table.get(bunPid)).toBeUndefined();
        expect(table.get(childPid)).toBeUndefined();
        expect(table.job(job)).toBeUndefined();
      } finally {
        for (const descriptors of tables) descriptors.dispose();
        await broker.dispose();
      }
    });

test("ignored broker notifications preserve the last actually delivered signal for argument-free defaults", async () => {
  const { setSignalDisposition, takeSignal } = await import("../proc/signals");
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({
    identities,
    table,
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
    const pid = await broker.adoptRoot({}),
      supervisor = await broker.ready(),
      record = supervisor.get(pid)!;
    setSignalDisposition(record.signalState, 2, 2);
    await broker.kill(pid, 2);
    expect(takeSignal(record.signalState, record.interrupt)).toBe(2);
    await broker.kill(pid, 17);
    expect(record.signal).toBe(2);
    supervisor.defaultSignal(pid);
    expect(readOutcome(record.outcome)).toMatchObject({ kind: "signaled", code: 2 });
  } finally {
    await broker.dispose();
  }
});

test("startup diagnostics reject write-only stderr without calling its blocking method", async () => {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("fixture", {
    adapter: "fixture",
    module() {
      throw new Error("setup failed");
    },
  });
  const errors: unknown[] = [];
  let writes = 0,
    closes = 0;
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError: (error) => errors.push(error),
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("unreachable launch");
    },
  });
  try {
    const root = await broker.adoptRoot({}),
      supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, {
      executable: "fixture",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    supervisor.get(pid)!.descriptors.openAt(
      2,
      {
        kind: "terminal",
        read: () => 0,
        write() {
          writes++;
          throw new Error("blocking method called");
        },
        close() {
          closes++;
        },
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      },
      0n,
      0n,
    );
    await supervisor.start(pid);
    expect(writes).toBe(0);
    expect(closes).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ errno: ProcessErrno.NOTSUP });
    expect(await supervisor.waitForExit(root, pid)).toMatchObject({
      kind: "start-failed",
      error: "EIO",
    });
  } finally {
    await broker.dispose();
  }
});

async function admissionFixture(
  options: {
    quiesce?(identity: import("../fs/protocol.js").FilesystemIdentity): Promise<void>;
    activate?: ConstructorParameters<typeof BrowserProcessBroker>[0]["activate"];
    allowDisposalFailure?: boolean;
    prepareSpawn?(pid: number, broker: BrowserProcessBroker): void;
  } = {},
) {
  const owned: {
    broker?: BrowserProcessBroker;
    descriptors?: DescriptorTable;
    reader?: PipeEndpoint;
  } = {};
  let releaseTokens = () => {};
  let restoreTransport = () => {};
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    releaseTokens();
    restoreTransport();
    owned.descriptors?.dispose();
    owned.reader?.close();
    if (owned.broker)
      await bounded(owned.broker.dispose()).catch((error: unknown) => {
        if (!options.allowDisposalFailure) throw error;
      });
  };
  regressionCleanups.push(cleanup);
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const registry = new ExecutableRegistry();
  registry.register("admission", {
    adapter: "fixture",
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
  });
  const contexts: import("../proc/types.js").ProcessContext[] = [];
  const errors: unknown[] = [];
  const broker = (owned.broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    activate: options.activate,
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke: revokeFilesystem,
      reap: revokeFilesystem,
      quiesce: options.quiesce ?? (async () => {}),
    },
    launch(context) {
      contexts.push(context);
      return { terminate() {} };
    },
    onError(error) {
      errors.push(error);
    },
  }));
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  await bounded(broker.adoptRuntimeRoot(root));
  const messages: WorkerProcessMessage[] = [];
  const descriptors = (owned.descriptors = new DescriptorTable());
  const host = new WorkerPipeHost({
    transport: root,
    postMessage: (message) => messages.push(message),
  });
  const codec = host.codec();
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec,
    postMessage: (message) => messages.push(structuredClone(message)),
    prepareSpawn(pid) {
      options.prepareSpawn?.(pid, broker);
      host.registry.registerProcess(pid);
      return {
        data: { filesystem: createFilesystemIdentity(), pipeRegistry: host.registry.handle() },
      };
    },
  });
  const pair = host.createPipe();
  const reader = (owned.reader = pair[0]);
  const writerFd = descriptors.open(pair[1], 127n, 63n);
  const pid = client.spawn(client.pid, {
    executable: "admission",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [{ child: 1, parent: writerFd }],
  });
  const message = messages.find((message) => message.operation === "spawn");
  if (!message || message.operation !== "spawn") throw new Error("spawn was not posted");
  const originalData = message.transport.data;
  restoreTransport = () => {
    message.transport.data = originalData;
  };
  releaseTokens = () => {
    for (const token of message.transport.resources) codec.discard(token);
  };
  descriptors.close(writerFd);
  const token = message.transport
    .resources[0] as import("../proc/worker-pipes.js").WorkerPipeDescriptorToken;
  const lifetime = attachPipeEndpoint(token.endpoint);
  const state = workerProcessState(message.transport);
  const group = findDirectoryJob(message.transport.directory, state.job)!;
  return {
    broker,
    root,
    pid,
    client,
    message,
    reader,
    lifetime,
    state,
    group,
    contexts,
    errors,
    cleanup,
    table,
    codec,
    host,
  };
}

function rejectAdmissionFixture(
  fixture: Awaited<ReturnType<typeof admissionFixture>>,
  path: "external" | "codec",
): Promise<unknown> | undefined {
  if (path === "external") {
    fixture.broker.rejectRuntimeMessage(fixture.message, fixture.client.pid);
    return;
  }
  const codec = spyOn(
    fixture.broker as unknown as { descriptorCodec(): never },
    "descriptorCodec",
  ).mockImplementation(() => {
    throw new Error("codec factory failed");
  });
  regressionCleanups.push(async () => {
    codec.mockRestore();
  });
  return bounded(
    fixture.broker
      .runtimeMessage(fixture.message, fixture.client.pid)
      .catch((error: unknown) => error),
  );
}

function admissionObservation(fixture: Awaited<ReturnType<typeof admissionFixture>>) {
  return {
    confirmed: controlLoad(fixture.state.confirmed, 0),
    pending: controlLoad(fixture.group.pending),
    closed: Number(fixture.lifetime.tryWrite([]) === -PipeErrno.BADF),
    readiness: fixture.reader.readiness(),
    outcome: readOutcome(fixture.state.signals.outcome),
    launches: fixture.contexts.length,
  };
}

test("codec construction failure releases the accepted writer and confirms its failed child", async () => {
  const fixture = await admissionFixture();
  fixture.message.transport.data = undefined;
  const result = await bounded(
    fixture.broker
      .runtimeMessage(fixture.message, fixture.client.pid)
      .catch((error: unknown) => error),
  );
  expect(result).toBeInstanceOf(TypeError);
  const observed = admissionObservation(fixture);
  console.info("codec construction observation", observed);
  expect(observed).toMatchObject({ confirmed: 1, pending: 0, closed: 1, launches: 0 });
  expect(observed.outcome?.kind).toBe("start-failed");
  expect(observed.readiness.hangup).toBe(true);
  expect(fixture.reader.tryRead([new Uint8Array(1)])).toBe(0);
});

test("queued duplicate external rejection preserves the accepted writer and launches once", async () => {
  const fixture = await admissionFixture();
  const accepted = fixture.broker.runtimeMessage(fixture.message, fixture.client.pid);
  fixture.broker.rejectRuntimeMessage(fixture.message, fixture.client.pid);
  await bounded(accepted);
  const supervisor = await bounded(fixture.broker.ready());
  await bounded(supervisor.start(fixture.pid));
  const observed = admissionObservation(fixture);
  console.info("queued duplicate observation", observed);
  expect(observed).toMatchObject({
    confirmed: 0,
    pending: 1,
    closed: 0,
    launches: 1,
    outcome: null,
  });
  expect(observed.readiness.hangup).toBe(false);
  expect(fixture.reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  supervisor.exit(fixture.pid, 0);
  await bounded(supervisor.waitForExit(fixture.client.pid, fixture.pid));
  expect(fixture.reader.tryRead([new Uint8Array(1)])).toBe(0);
});

for (const metadata of [undefined, null, "invalid", { sections: new SharedArrayBuffer(4) }])
  test(`codec construction external rejection cleans an unstarted transfer with ${JSON.stringify(metadata)} metadata`, async () => {
    const fixture = await admissionFixture();
    fixture.message.transport.data = { filesystem: metadata };
    fixture.broker.rejectRuntimeMessage(fixture.message, fixture.client.pid);
    await bounded(fixture.broker.quiesce());
    expect(admissionObservation(fixture)).toMatchObject({
      confirmed: 1,
      pending: 0,
      closed: 1,
      launches: 0,
    });
    expect(fixture.reader.tryRead([new Uint8Array(1)])).toBe(0);
  });

test("codec construction failure waits for a valid identity's actual filesystem fence", async () => {
  let release = () => {},
    entered = () => {};
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  regressionCleanups.push(async () => {
    release();
  });
  const fixture = await admissionFixture({
    quiesce: () => {
      entered();
      return fence;
    },
  });
  const codec = spyOn(
    fixture.broker as unknown as { descriptorCodec(): never },
    "descriptorCodec",
  ).mockImplementation(() => {
    throw new Error("codec factory failed");
  });
  regressionCleanups.push(async () => {
    codec.mockRestore();
    release();
  });
  const accepted = fixture.broker
    .runtimeMessage(fixture.message, fixture.client.pid)
    .catch((error: unknown) => error);
  await bounded(started);
  expect(admissionObservation(fixture)).toMatchObject({
    confirmed: 0,
    pending: 1,
    closed: 1,
    launches: 0,
  });
  release();
  expect(await bounded(accepted)).toMatchObject({ message: "codec factory failed" });
  expect(admissionObservation(fixture)).toMatchObject({
    confirmed: 1,
    pending: 0,
    closed: 1,
    launches: 0,
  });
});

for (const path of ["external", "codec"] as const)
  test(`codec construction ${path} rejection stays unconfirmed when a valid identity's fence rejects`, async () => {
    const failure = new Error("actual filesystem fence rejected");
    const fixture = await admissionFixture({
      quiesce: async () => {
        throw failure;
      },
      allowDisposalFailure: true,
    });
    const rejection = rejectAdmissionFixture(fixture, path);
    if (rejection) expect(await rejection).toBe(failure);
    await expect(bounded(fixture.broker.dispose())).rejects.toBe(failure);
    expect(admissionObservation(fixture)).toMatchObject({
      confirmed: 0,
      pending: 1,
      closed: 1,
      launches: 0,
    });
  });

for (const metadata of ["valid", "missing"] as const)
  test(`queued duplicate disposal drains ${metadata} unstarted ownership without launching`, async () => {
    const fixture = await admissionFixture();
    if (metadata === "missing") fixture.message.transport.data = undefined;
    const accepted = fixture.broker
      .runtimeMessage(fixture.message, fixture.client.pid)
      .catch((error: unknown) => error);
    fixture.broker.rejectRuntimeMessage(fixture.message, fixture.client.pid);
    await bounded(fixture.broker.dispose());
    await bounded(accepted);
    expect(Number(fixture.lifetime.tryWrite([]) === -PipeErrno.BADF)).toBe(1);
    expect(controlLoad(fixture.group.pending)).toBe(0);
    expect(fixture.contexts).toHaveLength(0);
    expect(fixture.reader.tryRead([new Uint8Array(1)])).toBe(0);
    expect(Array.from(fixture.table.values())).toHaveLength(0);
  });

test("queued duplicate foreign directory rejection cannot consume the accepted PID's writer", async () => {
  const accepted = await admissionFixture();
  const foreign = await admissionFixture();
  expect(accepted.pid).toBe(foreign.pid);
  const pending = accepted.broker.runtimeMessage(accepted.message, accepted.client.pid);
  accepted.broker.rejectRuntimeMessage(foreign.message, foreign.client.pid);
  await bounded(pending);
  const supervisor = await bounded(accepted.broker.ready());
  await bounded(supervisor.start(accepted.pid));
  expect(admissionObservation(accepted)).toMatchObject({
    confirmed: 0,
    pending: 1,
    closed: 0,
    launches: 1,
    outcome: null,
  });
  expect(admissionObservation(foreign)).toMatchObject({
    confirmed: 1,
    pending: 0,
    closed: 1,
    launches: 0,
  });
  expect(accepted.reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  expect(foreign.reader.tryRead([new Uint8Array(1)])).toBe(0);
});

test("codec construction missing metadata cannot bypass an acquired consumer's fence", async () => {
  const fixture = await admissionFixture({ allowDisposalFailure: true });
  let stopped = 0;
  fixture.broker.registerController(fixture.pid, {
    stop() {
      stopped++;
    },
  });
  fixture.message.transport.data = undefined;
  fixture.broker.rejectRuntimeMessage(fixture.message, fixture.client.pid);
  await expect(bounded(fixture.broker.dispose())).rejects.toThrow(/filesystem identity/);
  expect(admissionObservation(fixture)).toMatchObject({
    confirmed: 0,
    pending: 1,
    closed: 1,
    launches: 0,
  });
  expect(stopped).toBe(0);
});

for (const path of ["queued", "external"] as const)
  test(`queued duplicate disposal waits for ${path} filesystem quiescence`, async () => {
    let release = () => {},
      entered = () => {};
    const fence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fixture = await admissionFixture({
      quiesce: () => {
        entered();
        return fence;
      },
    });
    regressionCleanups.push(async () => {
      release();
    });
    let accepted: Promise<unknown> = Promise.resolve();
    if (path === "queued")
      accepted = fixture.broker
        .runtimeMessage(fixture.message, fixture.client.pid)
        .catch((error: unknown) => error);
    fixture.broker.rejectRuntimeMessage(fixture.message, fixture.client.pid);
    let disposed = false;
    const disposal = fixture.broker.dispose().then(() => {
      disposed = true;
    });
    await bounded(started);
    expect(Number(fixture.lifetime.tryWrite([]) === -PipeErrno.BADF)).toBe(1);
    expect(controlLoad(fixture.group.pending)).toBe(1);
    expect(disposed).toBe(false);
    expect(fixture.contexts).toHaveLength(0);
    release();
    await bounded(disposal);
    await bounded(accepted);
    expect(controlLoad(fixture.group.pending)).toBe(0);
    expect(fixture.reader.tryRead([new Uint8Array(1)])).toBe(0);
  });

test("queued duplicate delivery owns no second lifetime before supervisor admission", async () => {
  const fixture = await admissionFixture();
  const accepted = fixture.broker.runtimeMessage(fixture.message, fixture.client.pid);
  const repeated = fixture.broker.runtimeMessage(
    structuredClone(fixture.message),
    fixture.client.pid,
  );
  await expect(bounded(repeated)).rejects.toThrow("already registered");
  expect(Number(fixture.lifetime.tryWrite([]) === -PipeErrno.BADF)).toBe(0);
  await bounded(accepted);
  const supervisor = await bounded(fixture.broker.ready());
  await bounded(supervisor.start(fixture.pid));
  expect(admissionObservation(fixture)).toMatchObject({
    confirmed: 0,
    pending: 1,
    closed: 0,
    launches: 1,
    outcome: null,
  });
});

async function nestedAdmissionFixture(
  fixture: Awaited<ReturnType<typeof admissionFixture>>,
  transport = fixture.message.transport,
) {
  const owned: {
    descriptors?: DescriptorTable;
    reader?: PipeEndpoint;
    message?: Extract<WorkerProcessMessage, { operation: "spawn" }>;
  } = {};
  regressionCleanups.push(async () => {
    for (const token of owned.message?.transport.resources ?? []) fixture.codec.discard(token);
    owned.descriptors?.dispose();
    owned.reader?.close();
  });
  const descriptors = (owned.descriptors = new DescriptorTable());
  const [reader, writer] = fixture.host.createPipe();
  owned.reader = reader;
  const fd = descriptors.open(writer, 127n, 63n);
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: fixture.codec,
    postMessage(message) {
      if (message.operation === "spawn") owned.message = structuredClone(message);
    },
    prepareSpawn(pid) {
      fixture.host.registry.registerProcess(pid);
      return {
        data: {
          filesystem: createFilesystemIdentity(),
          pipeRegistry: fixture.host.registry.handle(),
        },
      };
    },
  });
  client.spawn(client.pid, {
    executable: "admission",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [{ child: 1, parent: fd }],
  });
  const message = owned.message;
  if (!message) throw new Error("no nested transfer");
  const token = message.transport
    .resources[0] as import("../proc/worker-pipes.js").WorkerPipeDescriptorToken;
  const state = workerProcessState(message.transport);
  const group = findDirectoryJob(message.transport.directory, state.job)!;
  descriptors.close(fd);
  return {
    message,
    reader,
    client,
    state,
    group,
    lifetime: attachPipeEndpoint(token.endpoint),
  };
}

test("admission review r1: malformed queued sender cannot strand a second accepted transfer", async () => {
  const parent = await admissionFixture();
  const local = await nestedAdmissionFixture(parent, parent.root);
  await bounded(parent.broker.runtimeMessage(local.message, parent.client.pid));
  const supervisor = await bounded(parent.broker.ready());
  await bounded(supervisor.start(local.message.transport.pid));
  const child = await nestedAdmissionFixture(parent);
  // Capture tagged words before reclamation. No allocations reuse these rows during observation.
  const confirmed = new TaggedCells(child.state.confirmed.cells, child.state.confirmed.id);
  const jobConfirmed = new TaggedCells(child.state.jobConfirmed.cells, child.state.jobConfirmed.id);
  parent.message.transport.data = undefined;
  const parentAdmission = parent.broker
    .runtimeMessage(parent.message, parent.client.pid)
    .catch((error: unknown) => error);
  const childAdmission = parent.broker
    .runtimeMessage(child.message, child.client.pid)
    .catch((error: unknown) => error);
  await bounded(Promise.all([parentAdmission, childAdmission]));
  await bounded(parent.broker.quiesce());
  const group = findDirectoryJob(child.message.transport.directory, child.state.job);
  const observed = {
    confirmed: controlLoad(confirmed),
    pending: group ? controlLoad(group.pending) : "collected",
    jobConfirmed: controlLoad(jobConfirmed),
    closed: Number(child.lifetime.tryWrite([]) === -PipeErrno.BADF),
    readiness: child.reader.readiness(),
    launches: parent.contexts.filter((context) => context.pid === child.message.transport.pid)
      .length,
  };
  console.info("repair r1 nested transfer", observed);
  expect(observed).toMatchObject({ confirmed: 1, jobConfirmed: 1, closed: 1, launches: 0 });
  if (group) expect(controlLoad(group.pending)).toBe(0);
  expect(
    Array.from(directoryProcesses(child.message.transport.directory), (state) => state.pid),
  ).not.toContain(child.message.transport.pid);
  expect(observed.readiness.hangup).toBe(true);
  expect(child.reader.tryRead([new Uint8Array(1)])).toBe(0);
  expect(Number(local.lifetime.tryWrite([]) === -PipeErrno.BADF)).toBe(0);
  expect(controlLoad(local.state.confirmed)).toBe(0);
  expect(controlLoad(local.group.pending)).toBe(1);
  expect(readOutcome(local.state.signals.outcome)).toBeNull();
  expect(local.reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  expect(parent.contexts.map((context) => context.pid)).toEqual([local.message.transport.pid]);
});

test("admission review r1: foreign malformed transfer cannot borrow another directory's consumer ownership", async () => {
  const accepted = await admissionFixture();
  const foreign = await admissionFixture();
  await bounded(accepted.broker.runtimeMessage(accepted.message, accepted.client.pid));
  const supervisor = await bounded(accepted.broker.ready());
  await bounded(supervisor.start(accepted.pid));
  foreign.message.transport.data = undefined;
  accepted.broker.rejectRuntimeMessage(foreign.message, foreign.client.pid);
  const cleanup = await bounded(accepted.broker.quiesce().catch((error: unknown) => error));
  console.info("repair r1 foreign transfer", {
    cleanup,
    accepted: admissionObservation(accepted),
    foreign: admissionObservation(foreign),
  });
  expect(cleanup).toBeUndefined();
  expect(admissionObservation(foreign)).toMatchObject({
    confirmed: 1,
    pending: 0,
    closed: 1,
    launches: 0,
  });
  expect(admissionObservation(accepted)).toMatchObject({
    confirmed: 0,
    pending: 1,
    closed: 0,
    launches: 1,
    outcome: null,
  });
  expect(foreign.reader.tryRead([new Uint8Array(1)])).toBe(0);
  expect(accepted.reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  await bounded(accepted.broker.dispose());
});

test("admission review r1: valid metadata waits for an acquired controller and its separate filesystem fence", async () => {
  let releaseAdapter = () => {},
    releaseFilesystem = () => {},
    releasePayload = () => {};
  const adapter = new Promise<void>((resolve) => {
    releaseAdapter = resolve;
  });
  const filesystem = new Promise<void>((resolve) => {
    releaseFilesystem = resolve;
  });
  const payload = new Promise<void>((resolve) => {
    releasePayload = resolve;
  });
  regressionCleanups.push(async () => {
    releaseAdapter();
    releaseFilesystem();
    releasePayload();
  });
  const separateIdentity = createFilesystemIdentity();
  const fixture = await admissionFixture({
    quiesce: (identity) => (identity === separateIdentity ? filesystem : payload),
  });
  regressionCleanups.push(async () => {
    releaseAdapter();
    releaseFilesystem();
    releasePayload();
  });
  let entered = 0;
  fixture.broker.registerController(fixture.pid, {
    filesystem: separateIdentity,
    quiesce() {
      entered++;
      return adapter;
    },
  });
  fixture.broker.rejectRuntimeMessage(fixture.message, fixture.client.pid);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const observed = {
    entered,
    revoked: Atomics.load(new Int32Array(separateIdentity.revocations[0]!), 0),
    ...admissionObservation(fixture),
  };
  console.info("repair r1 controller fence", observed);
  expect(observed).toMatchObject({
    entered: 1,
    revoked: 1,
    confirmed: 0,
    pending: 1,
    closed: 1,
    launches: 0,
  });
  releaseAdapter();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(admissionObservation(fixture)).toMatchObject({ confirmed: 0, pending: 1 });
  releaseFilesystem();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(admissionObservation(fixture)).toMatchObject({ confirmed: 0, pending: 1 });
  releasePayload();
  await bounded(fixture.broker.quiesce());
  expect(admissionObservation(fixture)).toMatchObject({ confirmed: 1, pending: 0 });
});

for (const [path, fence] of [
  ["external", "adapter"],
  ["external", "filesystem"],
  ["codec", "adapter"],
  ["codec", "filesystem"],
] as const)
  test(`admission review r1: ${path} rejection fails closed when acquired ${fence} quiescence rejects`, async () => {
    const failure = new Error(`acquired ${fence} fence failed`);
    const separateIdentity = createFilesystemIdentity();
    const fixture = await admissionFixture({
      quiesce: async (identity) => {
        if (fence === "filesystem" && identity === separateIdentity) throw failure;
      },
      allowDisposalFailure: true,
    });
    fixture.broker.registerController(fixture.pid, {
      filesystem: separateIdentity,
      async quiesce() {
        if (fence === "adapter") throw failure;
      },
    });
    const rejection = rejectAdmissionFixture(fixture, path);
    if (rejection) expect(await rejection).toBe(failure);
    await expect(bounded(fixture.broker.dispose())).rejects.toBe(failure);
    expect(admissionObservation(fixture)).toMatchObject({
      confirmed: 0,
      pending: 1,
      closed: 1,
      launches: 0,
    });
    expect(Atomics.load(new Int32Array(separateIdentity.revocations[0]!), 0)).toBe(1);
  });

for (const metadata of ["valid", "missing"] as const)
  test(`admission review r1: a controller registered before publication owns its ${metadata} transfer`, async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const fixture = await admissionFixture({
      allowDisposalFailure: metadata === "missing",
      prepareSpawn(pid, broker) {
        broker.registerController(pid, {
          quiesce() {
            entered++;
            return held;
          },
        });
      },
    });
    regressionCleanups.push(async () => {
      release();
    });
    if (metadata === "missing") fixture.message.transport.data = undefined;
    fixture.broker.rejectRuntimeMessage(fixture.message, fixture.client.pid);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(admissionObservation(fixture)).toMatchObject({ confirmed: 0, pending: 1, closed: 1 });
    if (metadata === "missing") {
      expect(entered).toBe(0);
      await expect(bounded(fixture.broker.dispose())).rejects.toThrow(/filesystem identity/);
      return;
    }
    expect(entered).toBe(1);
    release();
    await bounded(fixture.broker.quiesce());
    expect(admissionObservation(fixture)).toMatchObject({ confirmed: 1, pending: 0 });
  });

async function prepublicationAdmissionFixture() {
  const calls = { revoke: 0, quiesce: 0 };
  const controller = {
    filesystem: createFilesystemIdentity(),
    revoke() {
      calls.revoke++;
    },
    quiesce() {
      calls.quiesce++;
    },
  };
  const fixture = await admissionFixture({
    allowDisposalFailure: true,
    prepareSpawn(pid, broker) {
      broker.registerController(pid, controller);
    },
  });
  return { fixture, calls };
}

for (const path of ["external", "incoming"] as const)
  test(`admission review r2: ${path} foreign rejection cannot acquire a local prepublication controller`, async () => {
    const { fixture: local, calls } = await prepublicationAdmissionFixture();
    const foreign = await admissionFixture();
    expect(foreign.pid).toBe(local.pid);
    expect(foreign.message.transport.slot).toBe(local.message.transport.slot);
    const directory = workerProcessDirectoryId(local.message.transport);
    expect(workerProcessDirectoryId(foreign.message.transport)).not.toBe(directory);
    foreign.message.transport.data = undefined;
    if (path === "external") local.broker.rejectRuntimeMessage(foreign.message, foreign.client.pid);
    else
      await bounded(
        local.broker
          .runtimeMessage(foreign.message, foreign.client.pid)
          .catch((error: unknown) => error),
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const beforeGlobalFence = { ...calls };
    const registry: unknown = Reflect.get(local.broker, "acquiredProcesses");
    if (!(registry instanceof Map)) throw new Error("missing acquired lifetime registry");
    const actualLifetime: unknown = registry.get(local.pid);
    const expectedLifetime = `${directory}:${local.message.transport.slot}:${local.pid}`;
    const quiescence = await bounded(local.broker.quiesce().catch((error: unknown) => error));
    console.info("repair r2 prepublication ownership", {
      path,
      beforeGlobalFence,
      expectedLifetime,
      actualLifetime,
      quiescence,
      local: admissionObservation(local),
      foreign: admissionObservation(foreign),
    });
    expect(actualLifetime).toBe(expectedLifetime);
    expect(beforeGlobalFence).toEqual({ revoke: 0, quiesce: 0 });
    expect(quiescence).toBeUndefined();
    expect(admissionObservation(foreign)).toMatchObject({
      confirmed: 1,
      pending: 0,
      closed: 1,
      launches: 0,
    });
    expect(admissionObservation(local)).toMatchObject({
      confirmed: 0,
      pending: 1,
      closed: 0,
      launches: 0,
      outcome: null,
    });
    expect(foreign.reader.readiness().hangup).toBe(true);
    expect(foreign.reader.tryRead([new Uint8Array(1)])).toBe(0);
    expect(local.reader.readiness().hangup).toBe(false);
    expect(local.reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
    expect(calls).toEqual({ revoke: 1, quiesce: 1 });
    await bounded(local.broker.dispose());
  });
