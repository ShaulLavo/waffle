import { afterEach, expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker";
import { ProcessIdentityAllocator } from "../proc/identity";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessTable } from "../proc/table";
import type { RootProcessOptions } from "../proc/supervisor";
import type { WorkerProcessBroker } from "../proc/worker-broker";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage } from "../proc/worker-client";
import { DescriptorTable } from "../core/descriptors";
import { connectFilesystemIdentity, createFilesystemIdentity, revokeFilesystem } from "../fs/protocol";
import { createSignalState, type SignalTransport } from "../proc/signals";
import { claimOutcome, outcomeWord, readOutcome } from "../proc/outcome";
import { PipeEndpoint, PipeErrno, PipePublicationRegistry } from "../proc/pipes";
import { WorkerPipeHost, type WorkerPipeBroker } from "../proc/worker-pipes";

test("one browser process owner admits multiple roots with shared monotonically allocated identities", async () => {
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unknown adapter"); },
  });
  try {
    const first = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    const second = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
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
  } finally { await broker.dispose(); }
});

test("root admission cannot create a live process behind concurrent disposal", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  const admission = broker.adoptRoot({ pid: identities.pid(), job: identities.job() });
  const disposal = broker.dispose();
  await expect(admission).rejects.toThrow(/disposed/);
  await disposal;
  expect(Array.from(table.values())).toHaveLength(0);
});

test("revocation never allocates a process in an unrelated root pipe registry", async () => {
  const { PipePublicationRegistry } = await import("../proc/pipes");
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  const roots = [0, 1].map(() => {
    const transport = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    transport.data = { filesystem: createFilesystemIdentity(), pipeRegistry: new PipePublicationRegistry({ processCapacity: 1, cellsPerProcess: 1, maxCells: 1 }).handle() };
    return transport;
  });
  try {
    for (const root of roots) await broker.adoptRuntimeRoot(root);
    await broker.ready();
    for (const root of roots) await broker.rootExit(workerProcessState(root).pid, 0);
    expect(roots.map(root => readOutcome(workerProcessState(root).signals.outcome)?.status)).toEqual([0, 0]);
    expect(Array.from(table.values())).toHaveLength(0);
  } finally { await broker.dispose(); }
});

test("failed direct root activation retains its consumer fence and stop capability", async () => {
  const proc = await import("../proc");
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const failure = new Error("partial root initialization failed");
  let release!: () => void;
  const fence = new Promise<void>(resolve => { release = resolve; });
  let revoked = 0, stopped = 0, descriptorsReleased = 0;
  class PartialSupervisor extends proc.ProcessSupervisor {
    override createRoot(options: RootProcessOptions): never {
      const pid = super.createRoot(options);
      this.get(pid)!.descriptors.open({ kind: "terminal", read: () => 0, write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }) }, 0n, 0n,
      () => { descriptorsReleased++; });
      throw failure;
    }
  }
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    activate: async () => ({ ...proc, ProcessSupervisor: PartialSupervisor }), onError() {},
    filesystem: { connect() { throw new Error("unused"); }, revoke() { revoked++; }, reap() {}, quiesce: () => fence },
    launch() { throw new Error("unused"); },
  });
  try {
    await expect(broker.adoptRoot({ pid: identities.pid(), job: identities.job() }, {
      filesystem: createFilesystemIdentity(), stop() { stopped++; },
    })).rejects.toBe(failure);
    const disposal = broker.dispose();
    expect(revoked).toBe(1);
    expect(stopped).toBe(0);
    expect(descriptorsReleased).toBe(1);
    release();
    await disposal;
    expect(stopped).toBe(1);
    expect(Array.from(table.values())).toHaveLength(0);
  } finally { release(); await broker.dispose(); }
});

test("adopting and closing a pipe-only root never activates a supervisor", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  let activations = 0;
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    activate: async () => { activations++; return import("../proc"); },
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  try {
    const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    root.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(root);
    await broker.rootExit(workerProcessState(root).pid, 0);
    expect(activations).toBe(0);
    expect(Array.from(table.values())).toHaveLength(0);
  } finally { await broker.dispose(); }
});

test("explicit lazy root identities advance the shared allocator before activation", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  let activations = 0;
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    activate: async () => { activations++; return import("../proc"); },
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
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
  } finally { await broker.dispose(); }
});

test("job kill publishes every lazy direct and runtime root before callbacks and activation", async () => {
  const proc = await import("../proc");
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  let releaseActivation!: (value: typeof proc) => void;
  const activation = new Promise<typeof proc>(resolve => { releaseActivation = resolve; });
  const signals = (): SignalTransport => ({ signalState: createSignalState(), outcome: outcomeWord(),
    interrupt: new Int32Array(new SharedArrayBuffer(4)), requestedSignal: new Int32Array(new SharedArrayBuffer(4)) });
  const first = signals(), second = signals(), unrelated = signals();
  const job = identities.job(), otherJob = identities.job();
  const generic = createWorkerProcessTransport({ pid: identities.pid(), job, identity: identities.buffer });
  generic.data = { filesystem: createFilesystemIdentity() };
  const genericState = workerProcessState(generic);
  const snapshots: (number | null)[][] = [];
  const snapshot = () => snapshots.push([first, second, genericState.signals, unrelated].map(state => readOutcome(state.outcome)?.status ?? null));
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(), activate: () => activation,
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  let killing: Promise<void> | undefined;
  try {
    const firstPid = broker.reserveRoot({ pid: identities.pid(), job, ...first }, { wake: snapshot });
    const secondPid = broker.reserveRoot({ pid: identities.pid(), job, ...second }, { wake: snapshot });
    const otherPid = broker.reserveRoot({ pid: identities.pid(), job: otherJob, ...unrelated }, { wake: snapshot });
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
    expect(supervisor.get(genericState.pid)?.result?.status).toBe(137);
    expect(supervisor.get(otherPid)?.result).toBeNull();
  } finally {
    releaseActivation(proc);
    try { await killing; } finally { await broker.dispose(); }
  }
});

test("disposal settles every consumer stop before disposing fenced relays and reports every failure", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const stopFailure = new Error("first consumer stop failed"), pipeFailure = new Error("relay cleanup failed");
  let releaseFence!: () => void, releaseStop!: () => void, startedStop!: () => void;
  const fence = new Promise<void>(resolve => { releaseFence = resolve; });
  const stop = new Promise<void>(resolve => { releaseStop = resolve; });
  const stopping = new Promise<void>(resolve => { startedStop = resolve; });
  const events: string[] = [];
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, quiesce: () => fence },
    launch() { throw new Error("unused"); },
  });
  const roots = [0, 1].map(() => {
    const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    const registry = new PipePublicationRegistry();
    root.data = { filesystem: createFilesystemIdentity(), pipeRegistry: registry.handle() };
    return { root, registry };
  });
  const publications: Promise<void>[] = [];
  const host = new WorkerPipeHost({ transport: roots[0]!.root, registry: roots[0]!.registry,
    postMessage: message => { publications.push(broker.runtimeMessage(message, workerProcessState(roots[0]!.root).pid)); } });
  const pipes = Reflect.get(broker, "pipes") as WorkerPipeBroker;
  const disposePipes = pipes.dispose.bind(pipes);
  pipes.dispose = () => { events.push("pipes"); disposePipes(); throw pipeFailure; };
  let endpoints: ReturnType<WorkerPipeHost["createPipe"]> | undefined;
  let disposal: Promise<unknown> | undefined;
  try {
    await broker.adoptRuntimeRoot(roots[0]!.root, { stop() { events.push("first-stop"); throw stopFailure; } });
    await broker.adoptRuntimeRoot(roots[1]!.root, { async stop() { events.push("second-stop"); startedStop(); await stop; events.push("second-stopped"); } });
    endpoints = host.createPipe();
    await Promise.all(publications);
    expect(pipes.size).toBe(1);
    disposal = broker.dispose().then(() => undefined, error => error);
    for (const { root, registry } of roots) expect(registry.isRevoked(workerProcessState(root).pid)).toBe(true);
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
    releaseFence(); releaseStop();
    if (disposal) await disposal;
    else await broker.dispose().catch(() => {});
    endpoints?.[0].close(); endpoints?.[1].close();
    disposePipes();
  }
});

test("a rejected filesystem fence does not stop consumers or force relay disposal", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const failure = new Error("filesystem still owns admitted work");
  let rejectFence!: (reason: unknown) => void;
  const fence = new Promise<void>((_resolve, reject) => { rejectFence = reject; });
  let stops = 0, relayDisposals = 0;
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(), onError() {},
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, quiesce: () => fence },
    launch() { throw new Error("unused"); },
  });
  const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
  const registry = new PipePublicationRegistry();
  root.data = { filesystem: createFilesystemIdentity(), pipeRegistry: registry.handle() };
  const publications: Promise<void>[] = [];
  const host = new WorkerPipeHost({ transport: root, registry,
    postMessage: message => { publications.push(broker.runtimeMessage(message, workerProcessState(root).pid)); } });
  const pipes = Reflect.get(broker, "pipes") as WorkerPipeBroker, disposePipes = pipes.dispose.bind(pipes);
  pipes.dispose = () => { relayDisposals++; disposePipes(); };
  let endpoints: ReturnType<WorkerPipeHost["createPipe"]> | undefined;
  let disposal: Promise<unknown> | undefined;
  try {
    await broker.adoptRuntimeRoot(root, { stop() { stops++; } });
    endpoints = host.createPipe();
    await Promise.all(publications);
    disposal = broker.dispose().then(() => undefined, error => error);
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
    endpoints?.[0].close(); endpoints?.[1].close();
    disposePipes();
  }
});

for (const operation of ["process", "job"] as const) test(`a ${operation} kill tolerates disposal while awaiting activation`, async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  let killing: Promise<void> | undefined, disposal: Promise<void> | undefined;
  try {
    const pid = await broker.adoptRoot({}), supervisor = await broker.ready();
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

for (const kind of ["direct", "runtime"] as const) test(`one hundred completed ${kind} roots release reservations and historical callbacks without activation`, async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  let activations = 0, stops = 0, retired = 0;
  const filesystem = createFilesystemIdentity();
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    activate: async () => { activations++; return import("../proc"); },
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  try {
    for (let run = 0; run < 100; run++) {
      const controller = { stop() { stops++; }, retired() { retired++; } };
      let pid: number;
      if (kind === "direct") pid = broker.reserveRoot({}, controller);
      else {
        const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
        root.data = { filesystem, pipeRegistry: new PipePublicationRegistry({ processCapacity: 1, cellsPerProcess: 1, maxCells: 4 }).handle() };
        pid = workerProcessState(root).pid;
        await broker.adoptRuntimeRoot(root, controller);
      }
      await broker.rootExit(pid, 0);
      expect(broker.transportFor(pid)).toBeUndefined();
    }
    expect(activations).toBe(0);
    expect(retired).toBe(100);
    for (const name of ["reservedRoots", "controllers", "roots", "outputs", "registries", "fences"])
      expect((Reflect.get(broker, name) as Map<unknown, unknown>).size).toBe(0);
    expect(Array.from(table.values())).toHaveLength(0);
    await broker.dispose();
    expect(stops).toBe(0);
    expect(retired).toBe(100);
  } finally { await broker.dispose(); }
});

test("root retirement waits for the filesystem fence", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  let release!: () => void;
  const fence = new Promise<void>(resolve => { release = resolve; });
  let retired = 0;
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  let completion: Promise<void> | undefined;
  try {
    const controller = { quiesce: () => fence, retired() { retired++; } };
    const pid = broker.reserveRoot({}, controller);
    completion = broker.rootExit(pid, 0);
    expect(retired).toBe(0);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(true);
    release();
    await completion;
    expect(retired).toBe(1);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
  } finally { release(); await completion; await broker.dispose(); }
});

test("a pending admission lease retains a completed root until released exactly once", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  let retired = 0;
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  let release: (() => void) | undefined;
  try {
    const controller = { retired() { retired++; } };
    const pid = broker.reserveRoot({}, controller);
    release = broker.retainRoot(pid);
    await broker.rootExit(pid, 0);
    expect(retired).toBe(0);
    expect((Reflect.get(broker, "reservedRoots") as Map<number, unknown>).has(pid)).toBe(true);
    release(); release();
    expect(retired).toBe(1);
    expect((Reflect.get(broker, "reservedRoots") as Map<number, unknown>).has(pid)).toBe(false);
  } finally { release?.(); await broker.dispose(); }
});

test("a completed runtime root retains queued background descendants until their job is reaped", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("fixture", { adapter: "fixture", module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), interruptible: true });
  let retired = 0, launches = 0;
  const broker = new BrowserProcessBroker({ identities, table, registry,
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { launches++; return { terminate() {} }; },
  });
  const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const messages: WorkerProcessMessage[] = [], descriptors = new DescriptorTable();
  const host = new WorkerPipeHost({ transport: root, postMessage: message => messages.push(message) });
  const client = new WorkerProcessClient({ transport: root, descriptors, codec: host.codec(),
    postMessage: message => messages.push(message), prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: host.registry.handle() } }) });
  try {
    const controller = { retired() { retired++; } };
    await broker.adoptRuntimeRoot(root, controller);
    const owner = Reflect.get(broker, "transport") as WorkerProcessBroker;
    expect(() => owner.releaseRoot(client.pid)).toThrow(/unconfirmed or unreaped/);
    const childPid = client.spawn(client.pid, { executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job: -1, fds: [] });
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
  } finally { descriptors.dispose(); await broker.dispose(); }
});

test("reentrant disposal shares one promise and stops each consumer once", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  let stops = 0, nested: Promise<void> | undefined;
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  broker.reserveRoot({}, { revoke() { nested = broker.dispose(); }, stop() { stops++; } });
  const outer = broker.dispose();
  try {
    expect(nested).toBe(outer);
    await outer;
    expect(stops).toBe(1);
  } finally { await Promise.allSettled([outer, nested]); }
});

for (const terminal of ["cleanup-error", "exit", "error"] as const) test(`generic child ${terminal} reports cleanup diagnostics without inventing an acknowledgement`, async () => {
  const previousWorker = globalThis.Worker;
  const workers: FakeWorker[] = [], channels: MessagePort[] = [], diagnostics: unknown[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminations = 0;
    constructor() { workers.push(this); }
    postMessage() {}
    terminate() { this.terminations++; }
    emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("fixture", { adapter: "fixture", module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), interruptible: true });
  let releaseFence!: () => void, reaped = 0;
  const fence = new Promise<void>(resolve => { releaseFence = resolve; });
  const broker = new BrowserProcessBroker({ identities, table, registry, onError: error => diagnostics.push(error),
    filesystem: { connect(identity) { const { client, server } = connectFilesystemIdentity(identity); channels.push(client.port, server.port); return client; },
      revoke() {}, reap() { reaped++; }, quiesce: () => fence },
    launch: context => broker.launchWorker(context, { workerUrl: "http://localhost/fixture-worker.js",
      request: { module: context.module, args: context.request.argv, env: context.request.env } }),
  });
  const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const messages: WorkerProcessMessage[] = [], descriptors = new DescriptorTable();
  const host = new WorkerPipeHost({ transport: root, postMessage: message => messages.push(message) });
  const client = new WorkerProcessClient({ transport: root, descriptors, codec: host.codec(),
    postMessage: message => messages.push(message), prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }) });
  try {
    await broker.adoptRuntimeRoot(root);
    const pid = client.spawn(client.pid, { executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job: -1, fds: [] });
    for (const message of messages) await broker.runtimeMessage(message, client.pid);
    const supervisor = await broker.ready();
    await supervisor.start(pid);
    const transport = broker.transportFor(pid)!;
    claimOutcome(workerProcessState(transport).signals.outcome, { kind: "exited", code: 7 });
    workers[0]!.emit({ type: terminal, code: 7, message: "guest cleanup failed", cleanupErrors: ["descriptor release failed"] });
    expect(diagnostics).toHaveLength(1);
    expect(String(diagnostics[0])).toContain("descriptor release failed");
    expect(reaped).toBe(terminal === "cleanup-error" ? 0 : 1);
    if (terminal === "cleanup-error") {
      expect(supervisor.get(pid)?.result).toBeNull();
      expect(Atomics.load(workerProcessState(transport).confirmed, 0)).toBe(0);
      expect(workers[0]!.terminations).toBe(0);
    }
    releaseFence();
    expect((await supervisor.waitForExit(client.pid, pid)).status).toBe(7);
    expect(workers[0]!.terminations).toBe(1);
  } finally {
    releaseFence();
    try { descriptors.dispose(); await broker.dispose(); }
    finally { for (const port of channels) port.close(); globalThis.Worker = previousWorker; }
  }
});

for (const diagnostic of ["inherited", "controller"] as const) test(`startup failures write ${diagnostic} diagnostics before closing inherited stderr`, async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  const failure = new Error("fixture compiler refused this source");
  registry.register("fixture", { adapter: "fixture", module() { throw failure; } });
  const events: string[] = [], output: string[] = [], source = new DescriptorTable();
  const broker = new BrowserProcessBroker({ identities, table, registry,
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("must not launch failed source"); },
  });
  try {
    const rootPid = await broker.adoptRoot({}), supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(rootPid, { executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job: -1, fds: [] });
    const fd = source.open({ kind: "terminal", read: () => 0,
      write(chunks) { events.push("diagnostic"); output.push(new TextDecoder().decode(chunks[0]!)); return chunks.reduce((sum, chunk) => sum + chunk.length, 0); },
      readiness: () => ({ readable: false, writable: true, hangup: false }), close() { events.push("closed"); } }, 0n, 0n);
    supervisor.get(pid)!.descriptors.inherit(2, source.get(fd)!);
    source.close(fd);
    if (diagnostic === "controller") {
      const controller = { startFailed(error: unknown) { events.push("controller-diagnostic"); output.push(String(error)); } };
      broker.registerController(pid, controller);
    }
    await supervisor.start(pid);
    expect(supervisor.get(pid)?.result).toMatchObject({ kind: "start-failed", code: 13, error: "EACCES", status: null });
    expect(output).toHaveLength(1);
    expect(output[0]).toContain(failure.message);
    expect(events).toEqual([diagnostic === "controller" ? "controller-diagnostic" : "diagnostic", "closed"]);
  } finally { source.dispose(); await broker.dispose(); }
});

for (const failure of ["first-import", "error-event", "running-error"] as const) test(`generic child ${failure} preserves startup versus execution failure`, async () => {
  const { failFirstWorkerImport } = await import("./first-worker-import");
  const previousWorker = globalThis.Worker;
  const workers: FakeWorker[] = [], ports: MessagePort[] = [];
  class FakeWorker {
    request?: import("../browser/worker").RuntimeWorkerRequest;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(request: import("../browser/worker").RuntimeWorkerRequest) { this.request = request; }
    terminate() {}
    emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("fixture", { adapter: "fixture", module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])) });
  const broker = new BrowserProcessBroker({ identities, table, registry,
    filesystem: { connect(identity) { const pair = connectFilesystemIdentity(identity); ports.push(pair.client.port, pair.server.port); return pair.client; },
      revoke() {}, reap() {}, async quiesce() {} },
    launch: context => broker.launchWorker(context, { workerUrl: "http://localhost/worker.js",
      request: { module: context.module, args: [], env: {} } }),
  });
  const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const messages: WorkerProcessMessage[] = [], descriptors = new DescriptorTable();
  const host = new WorkerPipeHost({ transport: root, postMessage: message => messages.push(message) });
  const client = new WorkerProcessClient({ transport: root, descriptors, codec: host.codec(),
    postMessage: message => messages.push(message), prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }) });
  try {
    await broker.adoptRuntimeRoot(root);
    const pid = client.spawn(client.pid, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    for (const message of messages) await broker.runtimeMessage(message, client.pid);
    const supervisor = await broker.ready();
    await supervisor.start(pid);
    const worker = workers[0]!;
    if (failure === "first-import") await failFirstWorkerImport(worker.request!, data => worker.emit(data));
    else {
      if (failure === "running-error") worker.emit({ type: "phase", name: "instantiate", duration: 0 });
      worker.onerror!({ preventDefault() {}, message: "worker rejected" } as ErrorEvent);
    }
    const result = await supervisor.waitForExit(client.pid, pid);
    expect(result).toEqual(failure === "running-error" ? { kind: "exited", code: 126, status: 126 }
      : { kind: "start-failed", code: 13, error: "EACCES", status: null });
    expect(client.wait(client.pid, pid)).toEqual(result);
  } finally {
    descriptors.dispose();
    try { await broker.dispose(); } finally { for (const port of ports) port.close(); globalThis.Worker = previousWorker; }
  }
});
const regressionCleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (regressionCleanups.length) await regressionCleanups.pop()!(); });
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("accepted-writer regression gate timed out")), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const activation of ["lazy", "eager"] as const) for (const exitAt of ["before-admission", "before-launch"] as const) {
  test(`accepted inherited writers survive parent exit ${exitAt} with ${activation} root activation`, async () => {
    const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    let releaseModule!: () => void, resolvingModule!: () => void;
    const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
    const moduleRequested = new Promise<void>(resolve => { resolvingModule = resolve; });
    registry.register("leader", { adapter: "fixture", module, interruptible: true });
    registry.register("descendant", { adapter: "fixture", async module() { resolvingModule(); await moduleGate; return module; }, interruptible: true });
    const contexts = new Map<number, import("../proc/types").ProcessContext>();
    const diagnostics: unknown[] = [], ports: MessagePort[] = [];
    const previousWorker = globalThis.Worker, workers = new Map<number, FakeWorker>();
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminations = 0;
      postMessage(request: import("../browser/worker").RuntimeWorkerRequest) {
        workers.set(workerProcessState(request.runtimeProcess!).pid, this);
      }
      terminate() { this.terminations++; }
      emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
    }
    const tables: DescriptorTable[] = [];
    let broker: BrowserProcessBroker | undefined, reader: PipeEndpoint | undefined, cleaned = false;
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
      } finally { for (const port of ports) port.close(); }
    };
    regressionCleanups.push(cleanup);
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    broker = new BrowserProcessBroker({ identities, table, registry,
      filesystem: {
        connect(identity) { const { client, server } = connectFilesystemIdentity(identity); ports.push(client.port, server.port); return client; },
        revoke: revokeFilesystem, reap: revokeFilesystem, async quiesce() {},
      },
      launch(context) {
        contexts.set(context.pid, context);
        return broker!.launchWorker(context, { workerUrl: "https://example.test/fixture-worker.js",
          request: { module: context.module, args: context.request.argv, env: context.request.env } });
      },
      onError(error) { diagnostics.push(error); },
    });
    const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    root.data = { filesystem: createFilesystemIdentity() };
    const messages: WorkerProcessMessage[] = [];
    const makeClient = (transport: typeof root) => {
      const descriptors = new DescriptorTable(); tables.push(descriptors);
      const host = new WorkerPipeHost({ transport,
        registry: (transport.data as { pipeRegistry: ConstructorParameters<typeof WorkerPipeHost>[0]["registry"] }).pipeRegistry,
        postMessage(message) { messages.push(structuredClone(message)); }, pipe: { capacity: 8, maxWriters: 8, maxReaders: 8 },
      });
      const client = new WorkerProcessClient({ transport, descriptors, codec: host.codec(),
        postMessage(message) { messages.push(structuredClone(message)); },
        prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: host.registry.handle() } }),
      });
      client.installBindings();
      return { client, descriptors, host };
    };
    const spawn = (executable: string, job: number, parent: number) => ({ executable, argv: [executable], env: {}, cwd: "/", job, fds: [{ child: 1, parent }] });
    try {
      await bounded(broker.adoptRuntimeRoot(root));
      if (activation === "eager") await bounded(broker.ready());
      const owner = makeClient(root), pair = owner.host.createPipe(); reader = pair[0];
      const writerFd = owner.descriptors.open(pair[1], 127n, 63n);
      const parentPid = owner.client.spawn(owner.client.pid, spawn("leader", -1, writerFd));
      owner.descriptors.close(writerFd);
      while (messages.length) await bounded(broker.runtimeMessage(messages.shift()!, owner.client.pid));
      const supervisor = await bounded(broker.ready());
      await bounded(supervisor.start(parentPid));
      const parent = makeClient(broker.transportFor(parentPid)!);
      const childPid = parent.client.spawn(parentPid, spawn("descendant", parent.client.job, 1));
      const notice = messages.shift()!;
      expect(notice.operation).toBe("spawn");
      const inherited = notice.transport.resources[0] as { endpoint: import("../proc/pipes").PipeEndpointHandle };
      const control = new Int32Array(inherited.endpoint.buffer, 0, 6), generation = Atomics.load(control, 5);
      const lifetime = new Int32Array(inherited.endpoint.lifetime);
      const parentWorker = workers.get(parentPid)!;
      if (exitAt === "before-launch") {
        parentWorker.emit(notice);
        await bounded(moduleRequested);
      }
      // The guest can complete before the page dispatches its already-posted spawn event.
      // Acknowledgement then closes the parent's proxy before queued admission executes.
      parent.descriptors.dispose();
      parent.client.exit(0);
      revokeFilesystem((broker.transportFor(parentPid)!.data as { filesystem: import("../fs/protocol").FilesystemIdentity }).filesystem);
      if (exitAt === "before-admission") {
        parentWorker.emit(notice);
        expect(supervisor.get(childPid)).toBeUndefined();
      }
      parentWorker.emit({ type: "exit", code: 0 });
      expect((await bounded(supervisor.waitForExit(owner.client.pid, parentPid))).status).toBe(0);
      expect(parentWorker.terminations).toBe(1);
      expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
      expect(reader.readiness().hangup).toBe(false);
      expect(Atomics.load(control, 5)).toBe(generation);
      expect(Atomics.load(lifetime, 0)).toBe(0);
      expect(contexts.has(childPid)).toBe(false);
      await bounded(moduleRequested);
      releaseModule();
      await bounded(supervisor.start(childPid));
      expect(contexts.has(childPid)).toBe(true);
      const child = makeClient(broker.transportFor(childPid)!);
      const writer = child.descriptors.get(1)!.resource as PipeEndpoint;
      expect(writer.tryWrite([new Uint8Array([68])])).toBe(1);
      child.descriptors.dispose(); child.client.exit(0);
      workers.get(childPid)!.emit({ type: "exit", code: 0 });
      await bounded(supervisor.waitForExit(parentPid, childPid));
      const bytes = new Uint8Array(1);
      expect(reader.tryRead([bytes])).toBe(1);
      expect(bytes[0]).toBe(68);
      expect(reader.tryRead([bytes])).toBe(0);
      expect(Atomics.load(lifetime, 0)).toBe(1);
      expect(Atomics.load(control, 5)).toBe(generation);
      expect(diagnostics).toEqual([]);
    } finally { await cleanup(); }
  });
}

for (const completion of ["exit", "error", "cleanup-error", "worker-error", "post-failure", "constructor-failure", "connect-failure", "kill", "dispose"] as const) {
  test(`generic child ${completion} waits for adapter quiescence before confirmation and physical termination`, async () => {
    const previousWorker = globalThis.Worker;
    const workers: FakeWorker[] = [], channels: MessagePort[] = [];
    const events: string[] = [];
    const controllerFilesystem = createFilesystemIdentity();
    let releaseControllerFilesystem!: () => void;
    const controllerFilesystemFence = new Promise<void>(resolve => { releaseControllerFilesystem = resolve; });
    let releaseAdapter!: () => void, releaseFilesystem!: () => void;
    const adapterFence = new Promise<void>(resolve => { releaseAdapter = resolve; });
    const filesystemFence = new Promise<void>(resolve => { releaseFilesystem = resolve; });
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() { if (completion === "constructor-failure") throw new Error("worker constructor failed"); workers.push(this); }
      postMessage() { if (completion === "post-failure") throw new Error("post failed"); }
      terminate() { events.push("terminate"); }
      emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
    registry.register("fixture", { adapter: "fixture", module: new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), interruptible: true });
    const broker = new BrowserProcessBroker({ identities, table, registry, onError() {},
      filesystem: {
        connect(identity) { if (completion === "connect-failure") throw new Error("connection failed"); const { client, server } = connectFilesystemIdentity(identity); channels.push(client.port, server.port); return client; },
        revoke() {}, reap() {}, quiesce: identity => identity === controllerFilesystem ? controllerFilesystemFence : filesystemFence,
      },
      launch(context) {
        broker.registerController(context.pid, {
          filesystem: controllerFilesystem,
          revoke() { events.push("revoke"); }, quiesce() { expect(events).toContain("revoke"); events.push("quiesce"); return adapterFence; },
          retired() { events.push("retired"); },
        });
        return broker.launchWorker(context, { workerUrl: "http://localhost/fixture-worker.js", cleanup() { events.push("cleanup"); },
          request: { module: context.module, args: context.request.argv, env: context.request.env } });
      },
    });
    const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    root.data = { filesystem: createFilesystemIdentity() };
    const messages: WorkerProcessMessage[] = [], descriptors = new DescriptorTable();
    const host = new WorkerPipeHost({ transport: root, postMessage: message => messages.push(message) });
    const client = new WorkerProcessClient({ transport: root, descriptors, codec: host.codec(),
      postMessage: message => messages.push(message), prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }) });
    let disposing: Promise<void> | undefined;
    try {
      await broker.adoptRuntimeRoot(root);
      const pid = client.spawn(client.pid, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
      for (const message of messages) await broker.runtimeMessage(message, client.pid);
      const supervisor = await broker.ready();
      await supervisor.start(pid);
      const transport = broker.transportFor(pid)!;
      const record = supervisor.get(pid)!;
      if (completion === "worker-error") workers[0]!.onerror?.({ preventDefault() {}, message: "worker failed" } as ErrorEvent);
      else if (completion === "kill") await broker.kill(pid, 9);
      else if (completion === "dispose") disposing = broker.dispose();
      else if (completion !== "post-failure" && completion !== "constructor-failure" && completion !== "connect-failure") workers[0]!.emit({ type: completion, code: 7, message: "guest failed", cleanupErrors: [] });
      expect(events).toContain("revoke");
      expect(events).toContain("quiesce");
      releaseFilesystem();
      // Draining just the filesystem (or receiving an exit acknowledgement) does not
      // certify the adapter's critical section. Terminate-first would hang this fence.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(events).not.toContain("terminate");
      expect(record.result).toBeNull();
      expect(Atomics.load(workerProcessState(transport).confirmed, 0)).toBe(0);
      releaseAdapter();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      // Controller identity B is independent of transport identity A and adapter quiescence.
      expect(record.result).toBeNull();
      expect(events).not.toContain("terminate");
      expect(events).not.toContain("cleanup");
      releaseControllerFilesystem();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(events.filter(event => event === "terminate")).toHaveLength(completion === "constructor-failure" || completion === "connect-failure" ? 0 : 1);
      expect(events.filter(event => event === "cleanup")).toHaveLength(1);
      if (completion !== "dispose") {
        expect(record.result).not.toBeNull();
        expect(Atomics.load(workerProcessState(transport).confirmed, 0)).toBe(1);
        expect(events).toContain("retired");
        expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
      }
    } finally {
      releaseAdapter(); releaseFilesystem(); releaseControllerFilesystem();
      try { descriptors.dispose(); await (disposing ?? broker.dispose()); }
      finally { for (const port of channels) port.close(); globalThis.Worker = previousWorker; }
    }
  });
}

for (const controllerStop of [false, true]) test(`an external asynchronous handle keeps cleanup authority until physical settlement (controller stop=${controllerStop})`, async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("external", { adapter: "external", module: new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), interruptible: true });
  const events: string[] = [];
  let release!: () => void, context!: import("../proc/types").ProcessContext;
  const physical = new Promise<void>(resolve => { release = resolve; });
  const broker = new BrowserProcessBroker({ identities, table, registry,
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch(value) {
      context = value;
      broker.registerController(value.pid, { revoke() { events.push("revoke"); },
        stop: controllerStop ? () => { events.push("controller stop"); return physical; } : undefined, retired() { events.push("retired"); } });
      return { terminate() { events.push("terminate"); return physical; } };
    },
  });
  let disposal: Promise<void> | undefined;
  try {
    const root = await broker.adoptRoot({}), supervisor = await broker.ready();
    const pid = supervisor.spawn(root, { executable: "external", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    await supervisor.start(pid);
    context.exit(0);
    expect(events).toContain("terminate");
    expect(events).not.toContain("retired");
    let disposed = false;
    disposal = broker.dispose().then(() => { disposed = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(events.includes("controller stop")).toBe(controllerStop);
    expect(events).not.toContain("retired");
    expect(disposed).toBe(false);
    release(); await disposal;
    expect(events.filter(event => event === "retired")).toHaveLength(1);
  } finally { release(); await (disposal ?? broker.dispose()); }
});

test("a controller registered before module rejection fences and settles physical cleanup before retirement", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("rejected", { adapter: "external", async module() { throw new Error("module rejected"); }, interruptible: true });
  const events: string[] = [];
  let release!: () => void;
  const fence = new Promise<void>(resolve => { release = resolve; });
  let releaseStop!: () => void;
  const physical = new Promise<void>(resolve => { releaseStop = resolve; });
  const broker = new BrowserProcessBroker({ identities, table, registry, onError() {},
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} }, launch() { throw new Error("must not launch"); } });
  try {
    const root = await broker.adoptRoot({}), supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, { executable: "rejected", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    broker.registerController(pid, { revoke() { events.push("revoke"); }, quiesce() { events.push("fence"); return fence; },
      stop() { events.push("stop"); return physical; }, retired() { events.push("retired"); } });
    await supervisor.start(pid);
    expect(events).toEqual(["revoke", "fence"]);
    expect(supervisor.get(pid)!.result).toBeNull();
    release(); await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(supervisor.get(pid)!.result?.kind).toBe("start-failed");
    expect(events).toEqual(["revoke", "fence", "stop"]);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(true);
    releaseStop(); await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(["revoke", "fence", "stop", "retired"]);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
    expect((Reflect.get(broker, "fences") as Map<number, unknown>).has(pid)).toBe(false);
  } finally { release(); releaseStop(); await broker.dispose(); }
});

test("lazy external roots revoke before fencing without activating a supervisor", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const events: string[] = [];
  let release!: () => void, activations = 0;
  const fence = new Promise<void>(resolve => { release = resolve; });
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    activate: async () => { activations++; return import("../proc"); },
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} }, launch() { throw new Error("unused"); } });
  let completion: Promise<void> | undefined;
  try {
    const pid = broker.reserveRoot({}, { revoke() { events.push("revoke"); },
      quiesce() { events.push("fence"); return fence; }, retired() { events.push("retired"); } });
    completion = broker.rootExit(pid, 0);
    expect(events).toEqual(["revoke", "fence"]);
    expect(activations).toBe(0);
    release(); await completion;
    expect(events).toEqual(["revoke", "fence", "retired"]);
  } finally { release(); await completion; await broker.dispose(); }
});

test("a pending external launcher retains authority until its late rejection then releases the failed controller", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("pending", { adapter: "external", module: new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), interruptible: true });
  const events: string[] = [];
  let rejectLaunch!: (error: unknown) => void, entered!: () => void, context!: import("../proc/types").ProcessContext;
  const launching = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<import("../proc/types").ProcessHandle>((_resolve, reject) => { rejectLaunch = reject; });
  const broker = new BrowserProcessBroker({ identities, table, registry, onError() {},
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch(value) { context = value; entered(); return pending; } });
  let starting: Promise<void> | undefined;
  try {
    const root = await broker.adoptRoot({}), supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, { executable: "pending", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    broker.registerController(pid, { revoke() { events.push("revoke"); },
      stop() { events.push("stop"); }, retired() { events.push("retired"); } });
    starting = supervisor.start(pid); await launching;
    context.startFailed(new Error("external startup rejected"));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(["revoke"]);
    rejectLaunch(new Error("launcher finally rejected")); await starting;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(["revoke", "stop", "retired"]);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
  } finally { rejectLaunch(new Error("test cleanup")); await starting; await broker.dispose(); }
});

test("a throwing exited notification still settles failed-start cleanup before reporting its error", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("rejected", { adapter: "external", async module() { throw new Error("module rejected"); }, interruptible: true });
  const failure = new Error("exited notification failed"), errors: unknown[] = [], events: string[] = [];
  let release!: () => void, releaseStop!: () => void;
  const fence = new Promise<void>(resolve => { release = resolve; });
  const physical = new Promise<void>(resolve => { releaseStop = resolve; });
  const broker = new BrowserProcessBroker({ identities, table, registry,
    onError(error) { errors.push(error); events.push("error"); },
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("must not launch"); } });
  try {
    const root = await broker.adoptRoot({}), supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, { executable: "rejected", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    broker.registerController(pid, { revoke() { events.push("revoke"); }, quiesce() { events.push("fence"); return fence; },
      exited() { events.push("exited"); throw failure; }, stop() { events.push("stop"); return physical; },
      retired() { events.push("retired"); } });
    await supervisor.start(pid);
    expect(events).toEqual(["revoke", "fence"]);
    release(); await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(supervisor.get(pid)!.result?.kind).toBe("start-failed");
    expect(events).toEqual(["revoke", "fence", "exited", "stop"]);
    expect(errors).toEqual([]);
    releaseStop(); await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(["revoke", "fence", "exited", "stop", "retired", "error"]);
    expect(errors).toEqual([failure]);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(false);
  } finally { release(); releaseStop(); await broker.dispose(); }
});

for (const settlement of ["resolve", "reject"] as const) test(`disposal retains a pending external launcher through late ${settlement} and physical cleanup`, async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("pending", { adapter: "external", module: new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), interruptible: true });
  const events: string[] = [];
  let resolveLaunch!: (handle: import("../proc/types").ProcessHandle) => void, rejectLaunch!: (error: unknown) => void;
  let entered!: () => void, releaseStop!: () => void;
  const launching = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<import("../proc/types").ProcessHandle>((resolve, reject) => { resolveLaunch = resolve; rejectLaunch = reject; });
  const physical = new Promise<void>(resolve => { releaseStop = resolve; });
  const handle = { terminate() { events.push("terminate"); return physical; } };
  const broker = new BrowserProcessBroker({ identities, table, registry, onError() {},
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { entered(); return pending; } });
  let starting: Promise<void> | undefined, disposal: Promise<void> | undefined;
  try {
    const root = await broker.adoptRoot({}), supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, { executable: "pending", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    broker.registerController(pid, { revoke() { events.push("revoke"); },
      stop() { events.push("stop"); }, retired() { events.push("retired"); } });
    starting = supervisor.start(pid); await launching;
    let disposed = false;
    disposal = broker.dispose().then(() => { disposed = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    // No controller stop or retirement may consume authority a late launcher still needs.
    expect(events).not.toContain("retired");
    expect(disposed).toBe(false);
    expect(events).toEqual(["revoke"]);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(true);
    if (settlement === "resolve") resolveLaunch(handle); else rejectLaunch(new Error("late launcher rejection"));
    await starting; await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (settlement === "resolve") {
      expect(events[0]).toBe("revoke");
      expect(events.slice(1).sort()).toEqual(["stop", "terminate"]);
      expect(disposed).toBe(false);
      expect((Reflect.get(broker, "controllers") as Map<number, unknown>).has(pid)).toBe(true);
    }
    releaseStop(); await disposal;
    expect(events.at(-1)).toBe("retired");
    expect(events.filter(event => event === "stop")).toHaveLength(1);
    expect(events.filter(event => event === "retired")).toHaveLength(1);
    expect(events.filter(event => event === "terminate")).toHaveLength(settlement === "resolve" ? 1 : 0);
    expect((Reflect.get(broker, "controllers") as Map<number, unknown>).size).toBe(0);
  } finally { resolveLaunch(handle); releaseStop(); await starting; await (disposal ?? broker.dispose()); }
});

test("a throwing exited notification waits for an acquired external handle's physical cleanup", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("external", { adapter: "external", module: new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), interruptible: true });
  const failure = new Error("exited notification failed"), errors: unknown[] = [], events: string[] = [];
  let release!: () => void, context!: import("../proc/types").ProcessContext;
  const physical = new Promise<void>(resolve => { release = resolve; });
  const broker = new BrowserProcessBroker({ identities, table, registry,
    onError(error) { errors.push(error); events.push("error"); },
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch(value) { context = value; return { terminate() { events.push("terminate"); return physical; } }; } });
  try {
    const root = await broker.adoptRoot({}), supervisor = await broker.ready();
    const pid = supervisor.reserveSpawn(root, { executable: "external", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    broker.registerController(pid, { exited() { events.push("exited"); throw failure; }, retired() { events.push("retired"); } });
    await supervisor.start(pid); context.exit(0);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(["exited", "terminate"]);
    expect(errors).toEqual([]);
    release(); await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(["exited", "terminate", "retired", "error"]);
    expect(errors).toEqual([failure]);
  } finally { release(); await broker.dispose(); }
});
