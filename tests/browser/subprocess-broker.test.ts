import { processRuntimeFixture } from "./process-runtime-fixture";
import { expect, test } from "bun:test";
import { SubprocessBroker, type ExecutableRegistration } from "../src/subprocess-broker";
import { SubprocessHost, childTransport, type ChildTransport } from "../src/subprocess.ts";
import { createFilesystemIdentity, revokeFilesystem, type FilesystemIdentity } from "../../runtime/fs";
import { FilesystemSection, waitForFilesystemQuiescence } from "../../runtime/fs/protocol";
import type { SharedFilesystem } from "../src/shared-fs";
import type { SpawnRequest } from "../src/worker";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome";
import { createSignalState, setSignalDisposition, takeSignal } from "../../runtime/proc/signals";

function fixture(activate?: () => Promise<typeof import("../../runtime/proc")>) {
  const revoked: number[] = [];
  const filesystem = { revoke(identity: { owner: number }) { revoked.push(identity.owner); }, reap() {}, async quiesce() {} } as unknown as SharedFilesystem;
  const runtime = processRuntimeFixture(filesystem, { activate });
  const broker = new SubprocessBroker("http://localhost/worker.js", runtime);
  let transport!: ChildTransport;
  const host = new SubprocessHost({ identity: runtime.identities.buffer, output() {}, launch(_meta, value) {
    transport = value;
    const request: SpawnRequest = { executable: "missing", argv: ["missing"], cwd: "/", env: {}, pid: value.pid, parentPid: value.parentPid, jobId: value.jobId, filesystem: createFilesystemIdentity(), child: value, trace: false, spawnBroker: true };
    broker.spawn(request);
    return { terminate() {} };
  } });
  const pid = host.spawn(JSON.stringify({ argv: ["missing"] }));
  return { broker, host, pid, transport, revoked, async dispose() { host.dispose(); broker.dispose(); await runtime.dispose(); } };
}

test("first activation returns a pid immediately and does not block an unrelated task", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const state = fixture(async () => { await barrier; return import("../../runtime/proc"); });
  try {
    expect(state.pid).toBeGreaterThan(1);
    expect(state.host.wait(state.pid)).toBe(-2);
    let ran = false;
    await new Promise<void>(resolve => setTimeout(() => { ran = true; resolve(); }, 0));
    expect(ran).toBe(true);
    expect(state.host.wait(state.pid)).toBe(-2);
    release();
    expect((await state.broker.wait(state.pid)).status).toBe(127);
    expect(state.host.wait(state.pid)).toBe(127);
  } finally { release(); await state.dispose(); }
});

test("missing executable is an asynchronous child exit, not a thrown spawn error", async () => {
  const state = fixture();
  try {
    expect((await state.broker.wait(state.pid)).status).toBe(127);
    expect(state.revoked).toHaveLength(1);
    expect(state.host.wait(state.pid)).toBe(127);
  } finally { await state.dispose(); }
});

test("disposing during delayed activation revokes pending children without starting them", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const state = fixture(async () => { await barrier; return import("../../runtime/proc"); });
  try {
    state.broker.dispose();
    expect(state.revoked).toHaveLength(1);
    expect(state.host.wait(state.pid)).toBe(137);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Atomics.load(new Int32Array(state.transport.interrupt), 0)).toBe(9);
  } finally { release(); await state.dispose(); }
});

const fixtureModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
function liveFixture(options: { executable?: ExecutableRegistration; quiesce?: (identity: FilesystemIdentity) => Promise<void>; slowModule?: () => Promise<WebAssembly.Module>; postFailure?: boolean; activate?: () => Promise<typeof import("../../runtime/proc")>; root?: import("../../runtime/proc").RootProcessOptions } = {}) {
  const originalWorker = globalThis.Worker;
  const workers = new Map<number, FakeWorker>();
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = 0;
    request!: import("../src/worker").RunRequest;
    postMessage(request: import("../src/worker").RunRequest) {
      this.request = request;
      workers.set(request.pid!, this);
      if (options.postFailure) throw new Error("worker post failed");
    }
    terminate() { this.terminated++; }
    exit(code = 0) { this.onmessage?.({ data: { type: "exit", code, sleep: "atomics" } } as MessageEvent); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  let quiescences = 0;
  const filesystem = {
    connect(identity: object) { return { ...identity, port: { close() {} } }; },
    revoke(identity: FilesystemIdentity) { revokeFilesystem(identity); }, reap() {},
    async quiesce(identity: FilesystemIdentity) { quiescences++; revokeFilesystem(identity); await options.quiesce?.(identity); },
  } as unknown as SharedFilesystem;
  const runtime = processRuntimeFixture(filesystem, { activate: options.activate });
  const broker = new SubprocessBroker("http://localhost/worker.js", runtime, { root: options.root });
  broker.register("fixture", options.executable ?? { module: fixtureModule, adapter: "preview1", cooperative: true });
  if (options.slowModule) broker.register("slow", { module: options.slowModule, adapter: "preview1", cooperative: true });
  const transports = new Map<number, ChildTransport>();
  const hosts: SubprocessHost[] = [];
  function hostFor(parent?: ChildTransport, capture?: (request: SpawnRequest) => void) {
    const host = new SubprocessHost({
      budget: parent?.budget, identity: parent?.identity ?? runtime.identities.buffer, pid: parent?.pid, jobId: parent?.jobId,
      slot: parent?.slot, token: parent?.token, output() {},
      onChildClose: (pid: number) => broker.close(parent?.pid ?? 1, pid),
      launch(meta, value) {
        transports.set(value.pid, value);
        const request: SpawnRequest = {
          executable: "fixture", argv: meta.argv, cwd: "/", env: meta.env ?? {},
          pid: value.pid, parentPid: value.parentPid, jobId: value.jobId, job: meta.job,
          filesystem: createFilesystemIdentity(), child: value, trace: false, spawnBroker: true,
        };
        if (capture) capture(request); else broker.spawn(request);
        return { terminate() {} };
      },
    });
    hosts.push(host);
    return host;
  }
  const host = hostFor();
  const pid = host.spawn(JSON.stringify({ argv: ["fixture"] }));
  return {
    broker, host, pid, transports, workers, hostFor, quiescences: () => quiescences,
    async started(pid: number) { const supervisor = await broker.ready(); await supervisor.start(pid); return supervisor; },
    async dispose() {
      let failure: unknown;
      try {
        for (const host of hosts) {
          host.detach();
          try { host.dispose(); } catch (error) { failure ??= error; }
        }
      } finally { broker.dispose(); await runtime.dispose(); globalThis.Worker = originalWorker; }
      if (failure) throw failure;
    },
  };
}
const timerTurn = () => new Promise<void>(resolve => setTimeout(resolve, 12));
function exitConfirmation(broker: SubprocessBroker, pid: number) {
  let confirmed = false;
  const result = broker.wait(pid).then(value => { confirmed = true; return value; });
  return { result, confirmed: () => confirmed };
}

test("broker observes each guest signal without replaying an interrupt consumed before its watch", async () => {
  const state = liveFixture();
  try {
    await state.started(state.pid);
    const transport = state.transports.get(state.pid)!;
    const signalState = createSignalState(transport.signalState);
    setSignalDisposition(signalState, 2, 2);
    const interrupt = new Int32Array(transport.interrupt);
    for (let request = 0; request < 2; request++) {
      expect(state.host.kill(state.pid, 2)).toBe(0);
      expect(Atomics.exchange(interrupt, 0, 0)).toBe(2);
      expect(takeSignal(signalState)).toBe(2);
      await timerTurn();
      expect(Atomics.exchange(interrupt, 0, 0)).toBe(0);
      expect(takeSignal(signalState)).toBe(0);
      expect(state.host.wait(state.pid)).toBe(-2);
    }
    state.workers.get(state.pid)!.exit(0);
    expect((await state.broker.wait(state.pid)).status).toBe(0);
  } finally { await state.dispose(); }
});

test("direct broker kill and job kill publish once without a later watcher replay", async () => {
  const state = liveFixture();
  try {
    await state.started(state.pid);
    const transport = state.transports.get(state.pid)!;
    const signalState = createSignalState(transport.signalState);
    setSignalDisposition(signalState, 2, 2);
    setSignalDisposition(signalState, 15, 2);
    const interrupt = new Int32Array(transport.interrupt);
    await state.broker.kill(state.pid, 2);
    expect(Atomics.exchange(interrupt, 0, 0)).toBe(2);
    await timerTurn();
    expect(Atomics.exchange(interrupt, 0, 0)).toBe(0);
    await state.broker.killJob(transport.jobId, 15);
    expect(Atomics.exchange(interrupt, 0, 0)).toBe(15);
    await timerTurn();
    expect(Atomics.exchange(interrupt, 0, 0)).toBe(0);
  } finally { await state.dispose(); }
});

test("guest handle close reaps completed metadata but preserves waits and one child notification until close", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    let exits = 0;
    supervisor.onChildExit(event => { if (event.pid === state.pid) exits++; });
    const waiting = state.broker.wait(state.pid);
    state.workers.get(state.pid)!.exit(7);
    expect((await waiting).status).toBe(7);
    expect((await state.broker.wait(state.pid)).status).toBe(7);
    expect(supervisor.get(state.pid)!.request!.argv).toEqual(["fixture"]);
    expect(exits).toBe(1);
    expect(state.host.close(state.pid)).toBe(0);
    state.broker.close(1, state.pid);
    await Promise.resolve();
    expect(supervisor.get(state.pid)).toBeUndefined();
    expect(exits).toBe(1);
    await expect(state.broker.wait(state.pid)).rejects.toThrow();
  } finally { await state.dispose(); }
});

test("closing a running handle resolves an existing waiter before reaping", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    const waiting = state.broker.wait(state.pid);
    state.host.close(state.pid);
    state.broker.close(1, state.pid);
    expect((await waiting).status).toBe(137);
    await Promise.resolve();
    expect(supervisor.get(state.pid)).toBeUndefined();
  } finally { await state.dispose(); }
});

test("completed metadata stays bounded across repeated spawn wait close cycles", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    let pid = state.pid;
    for (let run = 0; run < 12; run++) {
      await state.started(pid);
      state.workers.get(pid)!.exit(0);
      expect((await state.broker.wait(pid)).status).toBe(0);
      state.host.close(pid);
      state.broker.close(1, pid);
      await Promise.resolve();
      expect(Array.from(supervisor.table.values())).toHaveLength(1);
      if (run !== 11) pid = state.host.spawn(JSON.stringify({ argv: ["fixture"], env: { PAYLOAD: "x".repeat(4096) } }));
    }
  } finally { await state.dispose(); }
});

test("parent exit reaps unowned completed children without killing running background jobs", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    const nested = state.hostFor(state.transports.get(state.pid));
    const completed = nested.spawn(JSON.stringify({ argv: ["fixture"] }));
    await state.started(completed);
    state.workers.get(completed)!.exit(0);
    expect(supervisor.get(completed)).toBeDefined();
    const background = nested.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    await state.started(background);
    state.workers.get(state.pid)!.exit(0);
    expect(supervisor.get(completed)).toBeUndefined();
    expect(supervisor.get(background)!.result).toBeNull();
    state.host.close(state.pid);
    state.broker.close(1, state.pid);
    await Promise.resolve();
    state.workers.get(background)!.exit(0);
    expect(supervisor.get(background)).toBeUndefined();
  } finally { await state.dispose(); }
});

function quiescenceBarrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("SIGKILL selects its immutable outcome immediately but confirms exit only after filesystem quiescence", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise });
  try {
    await state.started(state.pid);
    const worker = state.workers.get(state.pid)!;
    await state.broker.kill(state.pid, 9);
    const waiting = exitConfirmation(state.broker, state.pid);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    expect(readOutcome(outcomeWord(state.transports.get(state.pid)!.outcome))?.status).toBe(137);
    expect(worker.terminated).toBe(0);
    expect(state.quiescences()).toBe(1);
    barrier.release();
    expect((await waiting.result).status).toBe(137);
    await timerTurn();
    expect(worker.terminated).toBe(1);
  } finally { barrier.release(); await state.dispose(); }
});

test("disposal cannot physically stop a worker inside an unfinished filesystem section", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise });
  try {
    await state.started(state.pid);
    const worker = state.workers.get(state.pid)!;
    state.broker.dispose();
    expect(state.host.wait(state.pid)).toBe(137);
    expect(worker.terminated).toBe(0);
    expect(state.quiescences()).toBe(1);
    barrier.release();
    await timerTurn();
    expect(worker.terminated).toBe(1);
  } finally { barrier.release(); await state.dispose(); }
});

test("postMessage failure also waits for quiescence before terminating its worker", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise, postFailure: true });
  try {
    await state.started(state.pid);
    const worker = state.workers.get(state.pid)!;
    const waiting = exitConfirmation(state.broker, state.pid);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    expect(worker.terminated).toBe(0);
    barrier.release();
    expect((await waiting.result).status).toBe(126);
    await timerTurn();
    expect(worker.terminated).toBe(1);
  } finally { barrier.release(); await state.dispose(); }
});

test("an acknowledged ordinary exit may stop immediately without a quiescence wait", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise });
  try {
    await state.started(state.pid);
    const worker = state.workers.get(state.pid)!;
    worker.exit(0);
    expect((await state.broker.wait(state.pid)).status).toBe(0);
    expect(worker.terminated).toBe(1);
    expect(state.quiescences()).toBe(0);
  } finally { barrier.release(); await state.dispose(); }
});

test("closing a handle before activation completes cannot retain a reserved process", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const state = fixture(async () => { await barrier; return import("../../runtime/proc"); });
  try {
    state.host.close(state.pid);
    state.broker.close(1, state.pid);
    release();
    const supervisor = await state.broker.ready();
    await timerTurn();
    expect(supervisor.get(state.pid)).toBeUndefined();
    expect(Array.from(supervisor.table.values())).toHaveLength(1);
  } finally { release(); await state.dispose(); }
});

test("a revoked parent cannot close an independent background child's handle while awaiting quiescence", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise });
  try {
    const supervisor = await state.started(state.pid);
    const nested = state.hostFor(state.transports.get(state.pid));
    const background = nested.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    await state.started(background);
    const parentWorker = state.workers.get(state.pid)!;
    await state.broker.kill(state.pid, 9);
    expect(parentWorker.terminated).toBe(0);
    parentWorker.onmessage?.({ data: { type: "child-close", parentPid: state.pid, pid: background } } as MessageEvent);
    await Promise.resolve();
    expect(supervisor.get(background)!.result).toBeNull();
    expect(Atomics.load(new Int32Array(state.transports.get(background)!.requestedSignal), 0)).toBe(0);
  } finally { barrier.release(); await state.dispose(); }
});

test("close after guest completion waits for the worker acknowledgement without replacing its exit", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    const waiting = state.broker.wait(state.pid);
    const transport = state.transports.get(state.pid)!;
    childTransport(transport).finish(23);
    expect(state.host.wait(state.pid)).toBe(23);
    state.host.close(state.pid);
    await Promise.resolve();
    expect(supervisor.get(state.pid)!.result).toBeNull();
    expect(Atomics.load(new Int32Array(transport.requestedSignal), 0)).toBe(0);
    state.workers.get(state.pid)!.exit(23);
    expect(await waiting).toEqual({ kind: "exited", code: 23, status: 23 });
    expect(supervisor.get(state.pid)).toBeUndefined();
    expect(Atomics.load(new Int32Array(transport.control), 1)).toBe(23);
  } finally { await state.dispose(); }
});

test("a parent SIGKILL racing page failure finalization has one shared terminal outcome", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    const record = supervisor.get(state.pid)!;
    const original = Atomics.load;
    let raced = false;
    Atomics.load = ((array: Int32Array, index: number) => {
      const previous = original(array, index);
      if (!raced && array === record.requestedSignal) {
        raced = true;
        state.host.kill(state.pid, 9);
      }
      return previous;
    }) as typeof Atomics.load;
    try { supervisor.failStart(state.pid, new Error("worker failed")); }
    finally { Atomics.load = original; }
    expect(raced).toBe(true);
    expect(await state.broker.wait(state.pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(supervisor.wait(1, state.pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(state.host.wait(state.pid)).toBe(137);
  } finally { await state.dispose(); }
});

for (const kind of ["exited", "signaled"] as const) {
  test(`watch completes a partially published ${kind} outcome without assuming worker quiescence`, async () => {
    const barrier = quiescenceBarrier();
    const state = liveFixture({ quiesce: () => barrier.promise });
    try {
      const supervisor = await state.started(state.pid);
      const transport = state.transports.get(state.pid)!;
      const code = kind === "signaled" ? 9 : 23;
      claimOutcome(outcomeWord(transport.outcome), { kind, code });
      expect(Atomics.load(new Int32Array(transport.requestedSignal), 0)).toBe(0);
      expect(Atomics.load(new Int32Array(transport.control), 0)).toBe(0);
      await timerTurn();
      const status = kind === "signaled" ? 137 : 23;
      expect(supervisor.wait(1, state.pid)).toBeNull();
      const waiting = exitConfirmation(state.broker, state.pid);
      await Promise.resolve();
      expect(waiting.confirmed()).toBe(false);
      expect(Atomics.load(new Int32Array(transport.requestedSignal), 0)).toBe(kind === "signaled" ? 9 : 0);
      expect(Atomics.load(new Int32Array(transport.interrupt), 0)).toBe(kind === "signaled" ? 9 : 0);
      expect(state.host.wait(state.pid)).toBe(-2);
      expect(state.quiescences()).toBe(1);
      expect(state.workers.get(state.pid)!.terminated).toBe(0);
      barrier.release();
      expect(await waiting.result).toEqual({ kind, code, status });
      expect(state.host.wait(state.pid)).toBe(status);
      await timerTurn();
      expect(state.workers.get(state.pid)!.terminated).toBe(1);
    } finally { barrier.release(); await state.dispose(); }
  });
}

for (const kind of ["exited", "signaled"] as const) {
  test(`broker wait retains ${kind} kind when the shared status is 143`, async () => {
    const state = liveFixture();
    try {
      await state.started(state.pid);
      const signal = kind === "signaled" ? 15 : undefined;
      childTransport(state.transports.get(state.pid)!).finish(143, signal);
      state.workers.get(state.pid)!.onmessage?.({ data: { type: "exit", code: 143, signal, sleep: "atomics" } } as MessageEvent);
      expect(await state.broker.wait(state.pid)).toEqual({ kind, code: signal ?? 143, status: 143 });
      expect(state.host.wait(state.pid)).toBe(143);
    } finally { await state.dispose(); }
  });
}

function rootWords() {
  return { pid: 1, job: 1, signalState: createSignalState().buffer as SharedArrayBuffer,
    interrupt: new SharedArrayBuffer(4), requestedSignal: new SharedArrayBuffer(4), outcome: new SharedArrayBuffer(8) };
}

test("root job signaling is synchronous without activating the lazy process service", async () => {
  const root = rootWords();
  let activated = 0;
  const runtime = processRuntimeFixture({} as SharedFilesystem, { activate: async () => { activated++; return import("../../runtime/proc"); } });
  const broker = new SubprocessBroker("http://localhost/worker.js", runtime, { root });
  try {
    const delivered = broker.killJob(1, 2);
    expect(readOutcome(outcomeWord(root.outcome))).toEqual({ kind: "signaled", code: 2, status: 130 });
    expect(activated).toBe(0);
    await delivered;
    expect(activated).toBe(0);
  } finally { broker.dispose(); await runtime.dispose(); }
});

test("lazy activation adopts the root words without resetting or replaying consumed HANDLE", async () => {
  const root = rootWords();
  const signalState = createSignalState(root.signalState);
  setSignalDisposition(signalState, 2, 2);
  const runtime = processRuntimeFixture({} as SharedFilesystem);
  const broker = new SubprocessBroker("http://localhost/worker.js", runtime, { root });
  try {
    await broker.killJob(1, 2);
    expect(takeSignal(signalState)).toBe(2);
    const supervisor = await broker.ready();
    const record = supervisor.get(1)!;
    expect(record.signalState.buffer).toBe(root.signalState);
    expect(record.interrupt.buffer).toBe(root.interrupt);
    expect(record.requestedSignal.buffer).toBe(root.requestedSignal);
    expect(record.outcome.buffer).toBe(root.outcome);
    expect(takeSignal(record.signalState)).toBe(0);
    expect(readOutcome(record.outcome)).toBeNull();
  } finally { broker.dispose(); await runtime.dispose(); }
});

test("job signaling preclaims every default member before revocation and leaves HANDLE/IGNORE alive", async () => {
  let state!: ReturnType<typeof liveFixture>;
  let secondDefault = 0;
  let reentered = false;
  state = liveFixture({ quiesce: async () => {
    if (reentered || !secondDefault) return;
    reentered = true;
    expect(readOutcome(outcomeWord(state.transports.get(secondDefault)!.outcome))).toEqual({ kind: "signaled", code: 2, status: 130 });
    state.workers.get(secondDefault)!.exit(0);
  } });
  try {
    const supervisor = await state.started(state.pid);
    const job = state.transports.get(state.pid)!.jobId;
    const handled = state.host.spawn(JSON.stringify({ argv: ["fixture"], job }));
    const ignored = state.host.spawn(JSON.stringify({ argv: ["fixture"], job }));
    secondDefault = state.host.spawn(JSON.stringify({ argv: ["fixture"], job }));
    for (const pid of [handled, ignored, secondDefault]) await state.started(pid);
    const handledState = createSignalState(state.transports.get(handled)!.signalState);
    const ignoredState = createSignalState(state.transports.get(ignored)!.signalState);
    setSignalDisposition(handledState, 2, 2);
    setSignalDisposition(ignoredState, 2, 1);
    const delivered = state.broker.killJob(job, 2);
    expect(state.host.wait(state.pid)).toBe(130);
    expect(state.host.wait(secondDefault)).toBe(130);
    expect(state.host.wait(handled)).toBe(-2);
    expect(state.host.wait(ignored)).toBe(-2);
    expect(takeSignal(handledState)).toBe(2);
    expect(takeSignal(ignoredState)).toBe(0);
    await delivered;
    expect(reentered).toBe(true);
    await timerTurn();
    expect(takeSignal(handledState)).toBe(0);
    expect(supervisor.get(handled)!.result).toBeNull();
    expect(supervisor.get(ignored)!.result).toBeNull();
    state.workers.get(handled)!.exit(23);
    state.workers.get(ignored)!.exit(0);
    // Root DEFAULT has already made these children orphans; shared guest handles still own
    // their immutable results even though the page controller reaps unowned metadata.
    expect(state.host.wait(handled)).toBe(23);
    expect(state.host.wait(ignored)).toBe(0);
  } finally { await state.dispose(); }
});

test("previously admitted children survive lazy activation after root default according to their jobs", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const root = rootWords();
  const state = liveFixture({ root, activate: async () => { await barrier; return import("../../runtime/proc"); } });
  try {
    const background = state.host.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    const delivered = state.broker.killJob(1, 2);
    expect(readOutcome(outcomeWord(root.outcome))?.status).toBe(130);
    expect(state.host.wait(state.pid)).toBe(130);
    expect(state.host.wait(background)).toBe(-2);
    state.broker.rootExit(130);
    release();
    await delivered;
    const supervisor = await state.started(background);
    expect(state.workers.has(state.pid)).toBe(false);
    expect(state.workers.has(background)).toBe(true);
    expect(supervisor.get(background)!.result).toBeNull();
    state.workers.get(background)!.exit(42);
    expect(state.host.wait(background)).toBe(42);
  } finally { release(); await state.dispose(); }
});

for (const signal of [2, 9, 13, 15]) {
  test(`child dispatch rejects queued spawn after fatal ${signal} selection before revocation`, async () => {
    const state = liveFixture();
    try {
      const supervisor = await state.started(state.pid);
      let request!: SpawnRequest;
      const transport = state.transports.get(state.pid)!;
      const nested = state.hostFor(transport, value => { request = value; });
      const pid = nested.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
      expect(pid).toBeGreaterThan(state.pid);
      claimOutcome(outcomeWord(transport.outcome), { kind: "signaled", code: signal });
      state.workers.get(state.pid)!.onmessage?.({ data: { type: "spawn", request } } as MessageEvent);
      expect(nested.wait(pid)).toBe(137);
      expect(readOutcome(outcomeWord(request.child.outcome))).toEqual({ kind: "signaled", code: 9, status: 137 });
      await Promise.resolve();
      await Promise.resolve();
      expect(supervisor.get(pid)).toBeUndefined();
      expect(state.workers.has(pid)).toBe(false);
    } finally { await state.dispose(); }
  });
}

test("child dispatch admits a live parent's queued independent spawn", async () => {
  const state = liveFixture();
  try {
    await state.started(state.pid);
    let request!: SpawnRequest;
    const nested = state.hostFor(state.transports.get(state.pid)!, value => { request = value; });
    const pid = nested.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    state.workers.get(state.pid)!.onmessage?.({ data: { type: "spawn", request } } as MessageEvent);
    const supervisor = await state.started(pid);
    expect(supervisor.get(pid)!.state).toBe("running");
    state.workers.get(pid)!.exit(23);
    expect((await state.broker.wait(pid)).status).toBe(23);
  } finally { await state.dispose(); }
});

test("child dispatch rejects queued close after fatal selection before revocation", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    const transport = state.transports.get(state.pid)!;
    const nested = state.hostFor(transport);
    const background = nested.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    await state.started(background);
    claimOutcome(outcomeWord(transport.outcome), { kind: "signaled", code: 15 });
    state.workers.get(state.pid)!.onmessage?.({ data: { type: "child-close", parentPid: state.pid, pid: background } } as MessageEvent);
    await Promise.resolve();
    expect(supervisor.get(background)!.result).toBeNull();
    expect(readOutcome(outcomeWord(state.transports.get(background)!.outcome))).toBeNull();
    state.workers.get(background)!.exit(23);
  } finally { await state.dispose(); }
});

test("third-party preview1 registrations are rewritten before the worker starts", async () => {
  let loads = 0;
  const state = liveFixture({ executable: { adapter: "preview1", bytes: async () => {
    loads++;
    return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  } } });
  try {
    await state.started(state.pid);
    const request = state.workers.get(state.pid)!.request!;
    expect(request.interruptible).toBe(true);
    expect(WebAssembly.Module.imports(request.module)).toContainEqual({ module: "runtime_proc", name: "interrupted", kind: "function" });
    const second = state.host.spawn(JSON.stringify({ argv: ["fixture"] }));
    await state.started(second);
    expect(state.workers.get(second)!.request!.module).toBe(request.module);
    expect(loads).toBe(1);
  } finally { await state.dispose(); }
});

test("cooperative own preview1 modules and Bun modules bypass rewriting", async () => {
  for (const executable of [
    { module: fixtureModule, adapter: "preview1", cooperative: true },
    { module: fixtureModule, adapter: "bun", engine: "browser" },
    { module: fixtureModule, adapter: "bun", engine: "quickjs" },
    { module: fixtureModule, adapter: "bun", engine: "jsc" },
  ] as const) {
    const state = liveFixture({ executable });
    try {
      await state.started(state.pid);
      const request = state.workers.get(state.pid)!.request!;
      expect(request.module).toBe(fixtureModule);
      expect(request.interruptible).not.toBe(true);
    } finally { await state.dispose(); }
  }
});

test("compiled-only third-party registrations fail closed without a cooperative assertion", async () => {
  const runtime = processRuntimeFixture({} as SharedFilesystem);
  const broker = new SubprocessBroker("http://localhost/worker.js", runtime);
  try {
    expect(() => broker.register("untrusted", { module: fixtureModule, adapter: "preview1" } as ExecutableRegistration)).toThrow(/source bytes/);
  } finally { broker.dispose(); await runtime.dispose(); }
});

test("unsupported but natively valid modules fail with the instrumentation refusal on stderr", async () => {
  const body = [0, 0xfd, 0x0c].concat(new Array<number>(16).fill(0), [0x1a, 0x0b]); // v128.const; drop
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0,
    10, body.length + 2, 1, body.length].concat(body));
  expect(WebAssembly.validate(bytes)).toBe(true);
  const state = liveFixture({ executable: { adapter: "preview1", bytes } });
  try {
    expect((await state.broker.wait(state.pid)).status).toBe(126);
    const data = childTransport(state.transports.get(state.pid)!).stderr.read();
    expect(data).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(data as Uint8Array)).toMatch(/Cannot instrument WebAssembly:.*SIMD/);
    expect(state.workers.size).toBe(0);
  } finally { await state.dispose(); }
});

for (const completion of ["kill", "default-signal", "ordinary-word", "worker-error"] as const) {
  test(`${completion} confirms neither process nor job exit until its admitted filesystem work drains`, async () => {
    const barrier = quiescenceBarrier();
    const state = liveFixture({ quiesce: () => barrier.promise });
    try {
      const supervisor = await state.started(state.pid);
      const pid = state.host.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
      await state.started(pid);
      const transport = state.transports.get(pid)!;
      const wake = new Int32Array(new SharedArrayBuffer(4));
      const unlisten = supervisor.registerJobWake(1, transport.jobId, wake);
      try {
        if (completion === "kill") await state.broker.kill(pid, 9);
        else if (completion === "default-signal") await state.broker.kill(pid, 15);
        else if (completion === "ordinary-word") {
          claimOutcome(outcomeWord(transport.outcome), { kind: "exited", code: 23 });
          supervisor.exit(pid, 23);
        } else state.workers.get(pid)!.onerror?.({ preventDefault() {}, message: "worker failed" } as ErrorEvent);
        const waiting = exitConfirmation(state.broker, pid);
        await Promise.resolve();
        expect(waiting.confirmed()).toBe(false);
        expect(supervisor.wait(1, pid)).toBeNull();
        expect(supervisor.jobEmpty(1, transport.jobId)).toBe(false);
        expect(supervisor.waitJob(1, transport.jobId)).toBeNull();
        expect(Atomics.load(wake, 0)).toBe(0);
        expect(state.workers.get(pid)!.terminated).toBe(0);
        expect(state.quiescences()).toBe(1);
        barrier.release();
        expect((await waiting.result).status).toBe(completion === "kill" ? 137 : completion === "default-signal" ? 143 : completion === "ordinary-word" ? 23 : 126);
        await timerTurn();
        expect(supervisor.jobEmpty(1, transport.jobId)).toBe(true);
        expect(Atomics.load(wake, 0)).toBe(1);
        expect(state.workers.get(pid)!.terminated).toBe(1);
      } finally { unlisten(); }
    } finally { barrier.release(); await state.dispose(); }
  });
}

test("an unlaunched legacy job is fenced before becoming empty", async () => {
  const barrier = quiescenceBarrier();
  const loading = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise, slowModule: async () => { await loading.promise; return fixtureModule; } });
  try {
    const supervisor = await state.started(state.pid);
    const pid = state.host.spawn(JSON.stringify({ argv: ["slow"], job: -1 }));
    // reserveAdmittedSpawn runs before the asynchronous executable resolution completes.
    await Promise.resolve();
    const job = state.transports.get(pid)!.jobId;
    await state.broker.kill(pid, 9);
    const waiting = exitConfirmation(state.broker, pid);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    expect(supervisor.wait(1, pid)).toBeNull();
    expect(state.workers.has(pid)).toBe(false);
    expect(supervisor.jobEmpty(1, job)).toBe(false);
    expect(state.quiescences()).toBe(1);
    barrier.release();
    expect((await waiting.result).status).toBe(137);
    await timerTurn();
    expect(supervisor.jobEmpty(1, job)).toBe(true);
  } finally { barrier.release(); loading.release(); await state.dispose(); }
});

test("an acknowledged legacy job is empty without an extra filesystem fence", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    const pid = state.host.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    await state.started(pid);
    state.workers.get(pid)!.exit(23);
    expect(supervisor.jobEmpty(1, state.transports.get(pid)!.jobId)).toBe(true);
    expect(state.quiescences()).toBe(0);
  } finally { await state.dispose(); }
});

test("job readiness follows the real filesystem admitted-operation fence, not just worker termination", async () => {
  const state = liveFixture({ quiesce: waitForFilesystemQuiescence });
  let section: FilesystemSection | undefined;
  let admitted = false;
  try {
    const supervisor = await state.started(state.pid);
    const pid = state.host.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    await state.started(pid);
    const worker = state.workers.get(pid)!;
    const job = state.transports.get(pid)!.jobId;
    section = new FilesystemSection(worker.request.filesystem);
    section.enter();
    admitted = true;
    await state.broker.kill(pid, 9);
    const waiting = exitConfirmation(state.broker, pid);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    expect(supervisor.wait(1, pid)).toBeNull();
    expect(supervisor.jobEmpty(1, job)).toBe(false);
    expect(worker.terminated).toBe(0);
    expect(() => new FilesystemSection(worker.request.filesystem).enter()).toThrow();
    // An operation admitted before revocation is allowed its final mutation and lock release.
    const mutation = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(mutation, 0, 7);
    section.exit();
    admitted = false;
    expect((await waiting.result).status).toBe(137);
    await timerTurn();
    expect(supervisor.jobEmpty(1, job)).toBe(true);
    expect(Atomics.load(mutation, 0)).toBe(7);
    expect(worker.terminated).toBe(1);
    expect(() => new FilesystemSection(worker.request.filesystem).enter()).toThrow();
  } finally { if (admitted) section!.exit(); await state.dispose(); }
});

for (const completion of ["acknowledged", "physical-first", "confirmation-first"] as const) test(`legacy closed background jobs release completion metadata (${completion})`, async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise });
  try {
    const supervisor = await state.started(state.pid);
    const pid = state.host.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    await state.started(pid);
    const job = state.transports.get(pid)!.jobId;
    const events: string[] = [];
    const worker = state.workers.get(pid)!;
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { events.push("physical"); terminate(); };
    const unlisten = supervisor.onChildExit(event => { if (event.pid === pid) events.push("confirmed"); });
    // Subscribe before close can reap the result, without tying confirmation to physical stop.
    const confirmed = supervisor.waitForExit(1, pid);
    try {
      if (completion === "acknowledged") worker.exit(23);
      else if (completion === "physical-first") await state.broker.kill(pid, 9);
      else supervisor.kill(pid, 9);
      state.host.close(pid);
      state.broker.close(1, pid);
      await Promise.resolve();
      if (completion !== "acknowledged") {
        expect(supervisor.get(pid)!.result).toBeNull();
        expect(supervisor.job(job)).toBeDefined();
        expect(events).toEqual([]);
        barrier.release();
      }
      expect((await confirmed).status).toBe(completion === "acknowledged" ? 23 : 137);
      await Promise.resolve();
      expect(events).toEqual(completion === "physical-first" ? ["physical", "confirmed"] : ["confirmed", "physical"]);
      expect(supervisor.get(pid)).toBeUndefined();
      expect(supervisor.job(job)).toBeUndefined();
    } finally { unlisten(); }
  } finally { barrier.release(); await state.dispose(); }
});
