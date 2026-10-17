import { processRuntimeFixture } from "./process-runtime-fixture";
import { expect, test } from "bun:test";
import { claimOutcome } from "../../runtime/proc/outcome";
import { DescriptorTable } from "../../runtime/core/descriptors";
import { createFilesystemIdentity, revokeFilesystem, type FilesystemIdentity } from "../../runtime/fs";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage, type WorkerProcessTransport } from "../../runtime/proc/worker-client";
import { SubprocessBroker } from "../src/subprocess-broker";
import { startRun } from "../src/runner";
import type { SharedFilesystem } from "../src/shared-fs";
import type { RunRequest, WorkerMessage } from "../src/worker";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
function fixture() {
  const originalWorker = globalThis.Worker;
  const workers = new Map<number, FakeWorker>();
  let release!: () => void;
  const fence = new Promise<void>(resolve => { release = resolve; });
  let quiescences = 0;
  class FakeWorker {
    constructor(readonly url: string) {}
    request!: RunRequest;
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    private terminatedCallback!: () => void;
    readonly terminationStarted = new Promise<void>(resolve => { this.terminatedCallback = resolve; });
    postMessage(request: RunRequest) { this.request = request; workers.set(workerProcessState(request.runtimeProcess!).pid, this); }
    terminate() { this.terminated = true; this.terminatedCallback(); }
    message(data: WorkerMessage) { this.onmessage?.({ data } as MessageEvent<WorkerMessage>); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const filesystem = {
    client: {},
    connect(identity: FilesystemIdentity) { return { ...identity, port: { close() {} } }; },
    revoke(identity: FilesystemIdentity) { revokeFilesystem(identity); },
    reap() {},
    async quiesce(identity: FilesystemIdentity) { quiescences++; revokeFilesystem(identity); await fence; },
  } as unknown as SharedFilesystem;
  const runtime = processRuntimeFixture(filesystem);
  const root = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const broker = new SubprocessBroker("http://localhost/worker.js", runtime);
  broker.register("fixture", { module, adapter: "preview1", cooperative: true });
  const messages: WorkerProcessMessage[] = [];
  const descriptors = new DescriptorTable();
  const client = new WorkerProcessClient({ transport: root, descriptors, codec: {
    export() { throw new Error("unexpected descriptor"); }, import() { throw new Error("unexpected descriptor"); }, discard() {},
  }, postMessage(message) { messages.push(message); }, prepareSpawn() { return { data: { filesystem: createFilesystemIdentity() } }; } });
  return {
    broker, root, client, messages, workers, release, fence,
    quiescences: () => quiescences,
    async dispatch() { for (const message of messages.splice(0)) await broker.runtimeMessage(message, 1); },
    async dispose() {
      broker.dispose(); descriptors.dispose(); release();
      try { await runtime.dispose(); }
      finally { for (const worker of workers.values()) worker.terminate(); globalThis.Worker = originalWorker; }
    },
  };
}

test("generic worker root and child use the same lazy supervisor and exact shared signal views", async () => {
  const state = fixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job: 1, fds: [] });
    await state.dispatch();
    const supervisor = await state.broker.ready();
    await supervisor.start(pid);
    const root = supervisor.get(1)!;
    const signals = workerProcessState(state.root).signals;
    expect(root.interrupt.buffer).toBe(signals.interrupt.buffer);
    expect(root.interrupt.byteOffset).toBe(signals.interrupt.byteOffset);
    expect(root.outcome.byteOffset).toBe(signals.outcome.byteOffset);
    expect(root.signalState.byteOffset).toBe(signals.signalState.byteOffset);
    const request = state.workers.get(pid)!.request;
    expect(request.runtimeProcess).toBeDefined();
    expect(request.child).toBeUndefined();
    expect(state.workers.get(pid)!.url).toBe("http://localhost/preview1-worker.js");
    expect(request.filesystem.owner).toBe((request.runtimeProcess!.data as { filesystem: FilesystemIdentity }).filesystem.owner);
    state.workers.get(pid)!.message({ type: "exit", code: 7, sleep: "atomics" });
    expect((await state.broker.wait(pid)).status).toBe(7);
  } finally { await state.dispose(); }
});

test("generic worker kills quiesce the filesystem before physical termination", async () => {
  const state = fixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    await state.dispatch();
    await (await state.broker.ready()).start(pid);
    const worker = state.workers.get(pid)!;
    await state.broker.kill(pid, 9);
    expect(state.quiescences()).toBe(1);
    expect(worker.terminated).toBe(false);
    state.release();
    await state.fence;
    await worker.terminationStarted;
    expect(worker.terminated).toBe(true);
  } finally { await state.dispose(); }
});

test("generic host failure confirms after its filesystem fence before physical termination", async () => {
  const state = fixture();
  let releasePhysical!: () => void;
  const physicalTermination = new Promise<void>(resolve => { releasePhysical = resolve; });
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const transport = state.messages[0]!.transport;
    await state.dispatch();
    const supervisor = await state.broker.ready();
    await supervisor.start(pid);
    const worker = state.workers.get(pid)!;
    let confirmedAtTermination = -1;
    worker.terminate = () => {
      confirmedAtTermination = Atomics.load(workerProcessState(transport).confirmed, 0);
      return physicalTermination;
    };
    worker.onerror?.({ preventDefault() {}, message: "worker startup failed" } as ErrorEvent);
    const waiting = state.broker.wait(pid);
    expect(supervisor.wait(1, pid)).toBeNull();
    expect(Atomics.load(workerProcessState(transport).confirmed, 0)).toBe(0);
    expect(state.quiescences()).toBe(1);
    expect(confirmedAtTermination).toBe(-1);
    state.release();
    expect((await waiting).status).toBe(126);
    await Promise.resolve();
    expect(Atomics.load(workerProcessState(transport).confirmed, 0)).toBe(1);
    expect(confirmedAtTermination).toBe(1);
    expect(supervisor.jobEmpty(1, workerProcessState(transport).job)).toBe(true);
    // Physical termination is deliberately unresolved; it cannot be the safe point.
  } finally { releasePhysical(); await state.dispose(); }
});

test("generic process and job confirmation both wait for the filesystem fence", async () => {
  const state = fixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const transport = state.messages[0]!.transport;
    await state.dispatch();
    const supervisor = await state.broker.ready();
    await supervisor.start(pid);
    const job = workerProcessState(transport).job;
    const wake = new Int32Array(new SharedArrayBuffer(4));
    const unlisten = supervisor.registerJobWake(1, job, wake);
    try {
      await state.broker.kill(pid, 9);
      const waiting = state.broker.wait(pid);
      expect(supervisor.wait(1, pid)).toBeNull();
      expect(Atomics.load(workerProcessState(transport).confirmed, 0)).toBe(0);
      expect(supervisor.jobEmpty(1, job)).toBe(false);
      expect(supervisor.waitJob(1, job)).toBeNull();
      expect(Atomics.load(wake, 0)).toBe(0);
      expect(state.quiescences()).toBe(1);
      state.release();
      expect((await waiting).status).toBe(137);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(supervisor.jobEmpty(1, job)).toBe(true);
      expect(Atomics.load(wake, 0)).toBe(1);
      expect(state.workers.get(pid)!.terminated).toBe(true);
    } finally { unlisten(); }
  } finally { await state.dispose(); }
});

test("an unlaunched generic job is fenced before becoming empty", async () => {
  const state = fixture();
  let release!: () => void;
  const loading = new Promise<void>(resolve => { release = resolve; });
  state.broker.register("slow", { module: async () => { await loading; return module; }, adapter: "preview1", cooperative: true });
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "slow", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const transport = state.messages[0]!.transport;
    await state.dispatch();
    const supervisor = await state.broker.ready();
    const job = workerProcessState(transport).job;
    await state.broker.kill(pid, 9);
    const waiting = state.broker.wait(pid);
    expect(supervisor.wait(1, pid)).toBeNull();
    expect(Atomics.load(workerProcessState(transport).confirmed, 0)).toBe(0);
    expect(state.workers.has(pid)).toBe(false);
    expect(supervisor.jobEmpty(1, job)).toBe(false);
    expect(state.quiescences()).toBe(1);
    state.release();
    expect((await waiting).status).toBe(137);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(supervisor.jobEmpty(1, job)).toBe(true);
  } finally { release(); await state.dispose(); }
});

test("rejecting a repeated spawn cannot revoke or safe-confirm an already admitted independent child", async () => {
  const state = fixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const repeated = structuredClone(state.messages[0]!);
    await state.dispatch();
    const supervisor = await state.broker.ready();
    await supervisor.start(pid);
    state.broker.rejectRuntimeMessage(repeated);
    const child = workerProcessState(repeated.transport);
    expect(Atomics.load(child.signals.outcome, 0)).toBe(0n);
    expect(Atomics.load(child.confirmed, 0)).toBe(0);
    expect(Atomics.load(child.jobConfirmed, 0)).toBe(0);
    expect(state.quiescences()).toBe(0);
    expect(supervisor.jobEmpty(1, child.job)).toBe(false);
    state.workers.get(pid)!.message({ type: "exit", code: 23, sleep: "atomics" });
    expect((await state.broker.wait(pid)).status).toBe(23);
    expect(supervisor.jobEmpty(1, child.job)).toBe(true);
  } finally { await state.dispose(); }
});

for (const dispatch of ["runtime", "rejected"] as const) test(`a committed job reap reaches host cleanup after sender fatal selection (${dispatch})`, async () => {
  const state = fixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const transport = state.messages[0]!.transport;
    await state.dispatch();
    const supervisor = await state.broker.ready();
    await supervisor.start(pid);
    state.workers.get(pid)!.message({ type: "exit", code: 23, sleep: "atomics" });
    const job = workerProcessState(transport).job;
    expect(state.client.waitJob(1, job)?.status).toBe(23);
    const reap = state.messages.pop()!;
    expect(reap.operation).toBe("reap-job");
    await state.broker.kill(1, 9);
    if (dispatch === "runtime") await state.broker.runtimeMessage(reap, 1);
    else {
      state.broker.rejectRuntimeMessage(reap);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(supervisor.get(pid)).toBeUndefined();
    expect(supervisor.job(job)).toBeUndefined();
  } finally { await state.dispose(); }
});

test("a killed generic child cannot queue a new spawn capability", async () => {
  const state = fixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    const spawn = state.messages[0]!;
    await state.dispatch();
    await (await state.broker.ready()).start(pid);
    const transport = spawn.transport;
    const child = new WorkerProcessClient({ ...state.client.options, transport });
    const descendant = child.spawn(pid, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    const queued = state.messages.pop()!;
    await state.broker.kill(pid, 9);
    state.workers.get(pid)!.message(queued);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.workers.has(descendant)).toBe(false);
    const rejected = workerProcessState(queued.transport);
    expect(rejected.signals.outcome[0]).not.toBe(0n);
    expect(Atomics.load(rejected.confirmed, 0)).toBe(0);
    expect(Atomics.load(rejected.jobConfirmed, 0)).toBe(0);
    state.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Atomics.load(rejected.confirmed, 0)).toBe(1);
    expect(Atomics.load(rejected.jobConfirmed, 0)).toBe(1);
  } finally { await state.dispose(); }
});

for (const early of [false, true]) test(`explicit generic runner roots preserve their identity and signal views (early kill ${early})`, async () => {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const channel = new MessageChannel();
  const identity = createFilesystemIdentity();
  let sent!: RunRequest;
  let posted!: () => void;
  const ready = new Promise<void>(resolve => { posted = resolve; });
  let terminated = 0;
  let connections = 0;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  globalThis.Worker = class {
    postMessage(request: RunRequest) { sent = request; posted(); }
    terminate() { terminated++; }
  } as unknown as typeof Worker;
  const filesystem = {
    connect(value: FilesystemIdentity) { expect(value.owner).toBe(identity.owner); connections++; return { ...value, port: channel.port1 }; },
    fork() { throw new Error("explicit root identity must not be replaced"); },
    revoke: revokeFilesystem, reap() {},
    async quiesce(value: FilesystemIdentity) { revokeFilesystem(value); },
    client: { sweep() {} },
  } as unknown as SharedFilesystem;
  const runtime = processRuntimeFixture(filesystem);
  const transport = createWorkerProcessTransport({ pid: 11, job: 7, identity: runtime.identities.buffer });
  transport.data = { filesystem: identity };
  let run: ReturnType<typeof startRun> | undefined;
  try {
    run = startRun({ engine: "browser", module, args: [], env: {}, runtime, moduleScope: false, runtimeProcess: transport }, { stdout() {}, stderr() {} });
    if (early) run.kill(9);
    await ready;
    expect(sent.runtimeProcess).toBe(transport);
    expect(sent.pid).toBe(11);
    expect(sent.jobId).toBe(7);
    expect(connections).toBe(1);
    if (!early) run.kill(9);
    expect(await run.done).toEqual({ code: 137 });
    expect(workerProcessState(transport).signals.requestedSignal[0]).toBe(9);
    await Promise.resolve();
    expect(terminated).toBe(1);
  } finally {
    try { run?.kill(9); await run?.done; await runtime.dispose(); }
    finally {
      globalThis.Worker = originalWorker;
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
      if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
      channel.port1.close(); channel.port2.close();
    }
  }
});

for (const beforeAdmission of [false, true]) test(`job kill reaches reserved generic children before worker launch (before admission ${beforeAdmission})`, async () => {
  const state = fixture();
  let release!: () => void;
  const loading = new Promise<void>(resolve => { release = resolve; });
  state.broker.register("slow", { module: async () => { await loading; return module; }, adapter: "preview1", cooperative: true });
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "slow", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    const pending = state.messages[0]!.transport;
    if (!beforeAdmission) await state.dispatch();
    await state.broker.killJob(1, 9);
    expect(workerProcessState(pending).signals.requestedSignal[0]).toBe(9);
    release();
    if (beforeAdmission) await state.dispatch();
    else await (await state.broker.ready()).start(pid);
    expect(state.workers.has(pid)).toBe(false);
  } finally { release(); await state.dispose(); }
});

test("generic child workers route cloned descendant messages back through the shared supervisor", async () => {
  const state = fixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    const transport = state.messages[0]!.transport;
    await state.dispatch();
    const supervisor = await state.broker.ready();
    await supervisor.start(pid);
    const child = new WorkerProcessClient({ ...state.client.options, transport });
    const descendant = child.spawn(pid, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    const message = state.messages.pop()!;
    state.workers.get(pid)!.message(structuredClone(message));
    await new Promise(resolve => setTimeout(resolve, 0));
    await supervisor.start(descendant);
    expect(state.workers.get(descendant)!.request.runtimeProcess).toBeDefined();
    expect(supervisor.get(descendant)!.parentPid).toBe(pid);
    state.workers.get(descendant)!.message({ type: "exit", code: 4, sleep: "atomics" });
    expect((await state.broker.wait(descendant)).status).toBe(4);
  } finally { await state.dispose(); }
});

test("an admitted generic job survives ordinary parent teardown before its queued spawn is handled", async () => {
  const state = fixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    claimOutcome(workerProcessState(state.root).signals.outcome, { kind: "exited", code: 0 });
    revokeFilesystem((state.root.data as { filesystem: FilesystemIdentity }).filesystem);
    await state.dispatch();
    const supervisor = await state.broker.ready();
    await supervisor.start(pid);
    expect(state.workers.has(pid)).toBe(true);
    expect(supervisor.get(pid)!.result).toBeNull();
    state.workers.get(pid)!.message({ type: "exit", code: 0, sleep: "atomics" });
  } finally { await state.dispose(); }
});
