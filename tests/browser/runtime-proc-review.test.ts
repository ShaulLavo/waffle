import { expect, test } from "bun:test";
import { DescriptorTable } from "../../runtime/core/descriptors";
import { createFilesystemIdentity, revokeFilesystem } from "../../runtime/fs";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage, type WorkerProcessTransport } from "../../runtime/proc/worker-client";
import type { SharedFilesystem } from "../src/shared-fs";
import { SubprocessBroker } from "../src/subprocess-broker";
import { claimOutcome } from "../../runtime/proc/outcome";
import { setSignalDisposition } from "../../runtime/proc/signals";
import type { RunRequest, WorkerMessage } from "../src/worker";

const pause = (ms = 1) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, label: string, milliseconds = 500) {
  const end = performance.now() + milliseconds;
  while (!condition()) { if (performance.now() >= end) throw new Error(`${label} timed out`); await pause(); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options?: ConstructorParameters<typeof SubprocessBroker>[2], failPostMessage = false) {
  const NativeWorker = globalThis.Worker;
  const workers: FakeWorker[] = [];
  class FakeWorker {
    request?: RunRequest;
    onmessage?: (event: { data: WorkerMessage }) => void;
    onerror?: (event: unknown) => void;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(request: RunRequest) {
      this.request = request;
      if (failPostMessage) throw new Error("initial worker message rejected");
      request.filesystem.port.close();
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const root = createWorkerProcessTransport(); root.data = { filesystem: createFilesystemIdentity() };
  const filesystem = {
    connect(identity: object) { const channel = new MessageChannel(); channel.port2.close(); return { ...identity, port: channel.port1 }; },
    revoke: revokeFilesystem, reap() {}, client: { sweep() {} },
    async quiesce(identity: Parameters<typeof revokeFilesystem>[0]) { revokeFilesystem(identity); },
  } as unknown as SharedFilesystem;
  const broker = new SubprocessBroker("http://localhost/worker.js", filesystem, options);
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  const codec = { export() { throw new Error("unexpected descriptor export"); }, import() { throw new Error("unexpected descriptor import"); }, discard() {} };
  function client(transport: WorkerProcessTransport, send: (message: WorkerProcessMessage) => void) {
    return new WorkerProcessClient({ transport, descriptors, codec, postMessage: send,
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: (root.data as { pipeRegistry: unknown }).pipeRegistry } }) });
  }
  const parent = client(root, message => messages.push(message));
  return { root, broker, workers, parent, client, messages,
    async dispose() {
      broker.dispose(); descriptors.dispose();
      try { await until(() => workers.every(worker => worker.terminated), "fixture workers stopped"); }
      finally { for (const worker of workers) worker.terminate(); globalThis.Worker = NativeWorker; }
    },
  };
}
const emptyModule = () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

for (const trigger of ["watcher", "late-kill", "handled-signal-before-exit", "pump-signal-race"] as const) test(`ordinary child completion drains queued terminal output before confirmation (${trigger})`, async () => {
  const output: { fd: number; text: string }[] = [];
  const state = fixture({ output(fd, data) { output.push({ fd, text: new TextDecoder().decode(data) }); } });
  try {
    state.broker.register("child", { adapter: "preview1", cooperative: true, module: emptyModule() });
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.parent.spawn(1, { executable: "child", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    await state.broker.runtimeMessage(state.messages[0]!, 1);
    await until(() => state.workers.length === 1, "child launch");
    const worker = state.workers[0]!, transport = worker.request!.runtimeProcess!;
    const shared = workerProcessState(transport);
    // The worker selected ordinary completion, but its previously posted terminal messages
    // and final exit acknowledgement have not yet been dispatched on the page.
    let signalDelivery: Promise<void> | undefined;
    if (trigger === "handled-signal-before-exit") {
      setSignalDisposition(shared.signals.signalState, 15, 2);
      signalDelivery = state.broker.kill(pid, 15);
    }
    if (trigger === "pump-signal-race") {
      setSignalDisposition(shared.signals.signalState, 15, 2);
      Atomics.store(shared.signals.requestedSignal, 0, 15);
      const originalLoad = Atomics.load;
      let raced = false, reads = 0;
      Atomics.load = ((array: Int32Array | BigInt64Array, index: number) => {
        const previous = Reflect.apply(originalLoad, Atomics, [array, index]);
        if (array instanceof BigInt64Array && array.buffer === shared.signals.outcome.buffer &&
          array.byteOffset === shared.signals.outcome.byteOffset && index === 0 && ++reads === 2) {
          // First read is the page sender guard; second is the generic broker's pump.
          raced = true;
          claimOutcome(shared.signals.outcome, { kind: "exited", code: 23 });
        }
        return previous;
      }) as typeof Atomics.load;
      try { await state.broker.runtimeMessage({ type: "runtime-proc", operation: "exit", transport, targets: [pid] }, pid); }
      finally { Atomics.load = originalLoad; }
      expect(raced).toBe(true);
    } else {
      claimOutcome(shared.signals.outcome, { kind: "exited", code: 23 });
      if (signalDelivery) await signalDelivery;
      else if (trigger === "late-kill") await state.broker.kill(pid, 9);
      else await pause(25);
    }
    expect(Atomics.load(shared.confirmed, 0)).toBe(0);
    expect(worker.terminated).toBe(false);
    expect(state.parent.wait(1, pid)).toBeNull();
    expect(output).toEqual([]);
    worker.onmessage!({ data: { type: "stdout", data: new TextEncoder().encode("queued stdout\n") } });
    worker.onmessage!({ data: { type: "stderr", data: new TextEncoder().encode("queued stderr\n") } });
    expect(output).toEqual([{ fd: 1, text: "queued stdout\n" }, { fd: 2, text: "queued stderr\n" }]);
    // The earlier runtime-proc notification is not the worker's final host acknowledgement.
    await state.broker.runtimeMessage({ type: "runtime-proc", operation: "exit", transport, targets: [pid] }, pid);
    expect(Atomics.load(shared.confirmed, 0)).toBe(0);
    expect(worker.terminated).toBe(false);
    expect(state.parent.wait(1, pid)).toBeNull();
    worker.onmessage!({ data: { type: "exit", code: 23, sleep: "atomics" } });
    await until(() => Atomics.load(shared.confirmed, 0) === 1, "ordered child acknowledgement");
    expect(state.parent.wait(1, pid)).toEqual({ kind: "exited", code: 23, status: 23 });
    await until(() => worker.terminated, "acknowledged child stops");
  } finally { await state.dispose(); }
});

for (const failure of ["error-event", "initial-post-message"] as const) test(`generic child startup failure confirms without a final guest acknowledgement (${failure})`, async () => {
  const state = fixture(undefined, failure === "initial-post-message");
  try {
    state.broker.register("child", { adapter: "preview1", cooperative: true, module: emptyModule() });
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.parent.spawn(1, { executable: "child", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    await state.broker.runtimeMessage(state.messages[0]!, 1);
    await until(() => state.workers.length === 1, "failed child launch");
    const worker = state.workers[0]!, shared = workerProcessState(worker.request!.runtimeProcess!);
    if (failure === "error-event") worker.onerror!({ preventDefault() {}, message: "worker module import failed" });
    await until(() => worker.terminated, "failed child physically stopped");
    // Let every watcher/microtask observe failure; a missing acknowledgement must not strand wait.
    await pause(25);
    expect(Atomics.load(shared.confirmed, 0)).toBe(1);
    expect(state.parent.wait(1, pid)).toEqual({ kind: "exited", code: 126, status: 126 });
  } finally { await state.dispose(); }
});

test("explicit disposal releases a selected ordinary child exit without a final acknowledgement", async () => {
  const state = fixture();
  try {
    state.broker.register("child", { adapter: "preview1", cooperative: true, module: emptyModule() });
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.parent.spawn(1, { executable: "child", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    await state.broker.runtimeMessage(state.messages[0]!, 1);
    await until(() => state.workers.length === 1, "child launch");
    const worker = state.workers[0]!, shared = workerProcessState(worker.request!.runtimeProcess!);
    claimOutcome(shared.signals.outcome, { kind: "exited", code: 23 });
    state.broker.dispose();
    await until(() => worker.terminated, "unacknowledged child stopped during disposal");
    expect(Atomics.load(shared.confirmed, 0)).toBe(1);
    expect(state.parent.wait(1, pid)).toEqual({ kind: "exited", code: 23, status: 23 });
  } finally { await state.dispose(); }
});

test("generic worker loaded after first watcher tick still confirms a caught default-signal outcome", async () => {
  const loading = deferred();
  const state = fixture();
  try {
    state.broker.register("slow", { adapter: "preview1", cooperative: true, module: async () => { await loading.promise; return emptyModule(); } });
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.parent.spawn(1, { executable: "slow", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    await state.broker.runtimeMessage(state.messages[0]!, 1);
    // Let the initial four-millisecond watcher fire while module loading has no worker yet.
    await pause(25);
    expect(state.workers).toHaveLength(0);
    loading.resolve();
    await until(() => state.workers.length === 1, "delayed worker launch");
    const worker = state.workers[0]!;
    const transport = worker.request!.runtimeProcess!;
    const child = state.client(transport, message => worker.onmessage!({ data: message }));
    // Equivalent to guest JS catching its typed terminal unwind and spinning without returning.
    child.defaultSignal(pid, 15);
    await until(() => Atomics.load(workerProcessState(transport).confirmed, 0) === 1, "caught default action confirmation");
    expect(state.parent.wait(1, pid)).toEqual({ kind: "signaled", code: 15, status: 143 });
    await until(() => worker.terminated, "caught default action worker termination");
  } finally { loading.resolve(); await state.dispose(); }
});

test("already-published background spawn survives root exit during lazy supervisor activation", async () => {
  const activation = deferred(); let activating = false;
  const state = fixture({ activate: async () => { activating = true; await activation.promise; return import("../../runtime/proc"); } });
  try {
    state.broker.register("child", { adapter: "preview1", cooperative: true, module: emptyModule() });
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.parent.spawn(1, { executable: "child", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const admitted = state.broker.runtimeMessage(state.messages[0]!, 1);
    // Attach rejection immediately: the assertion below, not an unhandled rejection, owns it.
    const outcome = admitted.then(() => null, error => error);
    await until(() => activating, "lazy activation begins");
    state.parent.exit(0); state.broker.rootExit(0);
    activation.resolve();
    expect(await outcome).toBeNull();
    await until(() => state.workers.some(worker => worker.request?.pid === pid), "independent background launch");
    expect((await state.broker.ready()).get(pid)?.result).toBeNull();
  } finally { activation.resolve(); await state.dispose(); }
});
