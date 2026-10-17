import { expect, test } from "bun:test";
import { createFilesystemIdentity, revokeFilesystem } from "../../runtime/fs";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage } from "../../runtime/proc/worker-client";
import { DescriptorTable } from "../../runtime/core/descriptors";
import { SubprocessBroker } from "../src/subprocess-broker";
import { WorkerPipeBroker } from "../../runtime/proc/worker-pipes";
import { PipeController, attachPipePublicationRegistry, type PipePublicationRegistryHandle } from "../../runtime/proc/pipes";
import { setSignalDisposition } from "../../runtime/proc/signals";
import { startRun, type RunOptions } from "../src/runner";
import type { RunRequest } from "../src/worker";
import type { SharedFilesystem } from "../src/shared-fs";

function imported(name: string, namespace = "runtime_proc"): WebAssembly.Module {
  const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const imports = [1].concat(text(namespace), text(name), [0, 0]);
  return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, imports.length].concat(imports)));
}
function fixture(module: WebAssembly.Module, options: Partial<RunOptions> = {}) {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const channel = new MessageChannel();
  const identity = createFilesystemIdentity();
  let sent!: RunRequest;
  const requests: RunRequest[] = [];
  let rootWorker: { onmessage?: (event: { data: WorkerProcessMessage }) => void };
  let posted!: () => void;
  const ready = new Promise<void>(resolve => { posted = resolve; });
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  globalThis.Worker = class {
    constructor() { rootWorker ??= this; }
    onmessage?: (event: { data: WorkerProcessMessage }) => void;
    postMessage(request: RunRequest) { sent ??= request; requests.push(request); posted(); }
    terminate() {}
  } as unknown as typeof Worker;
  const filesystem = {
    fork: () => ({ ...identity, port: channel.port1 }),
    connect: (value: object) => { if (!value) throw new TypeError("missing filesystem identity"); return { ...value, port: channel.port1 }; },
    revoke: revokeFilesystem, reap() {},
    async quiesce(value: typeof identity) { revokeFilesystem(value); },
    client: { sweep() {} },
  } as unknown as SharedFilesystem;
  const restore = () => {
    globalThis.Worker = originalWorker;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
    if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
    channel.port1.close(); channel.port2.close();
  };
  let run: ReturnType<typeof startRun>;
  try { run = startRun({ engine: "browser", module, args: [], env: {}, filesystem, moduleScope: false, ...options }, { stdout() {}, stderr() {} }); }
  catch (error) { restore(); throw error; }
  return {
    run, ready, request: () => sent, requests,
    message: (data: WorkerProcessMessage) => rootWorker.onmessage!({ data }),
    async dispose() {
      run.kill(9); await run.done;
      restore();
    },
  };
}

for (const name of ["pipe", "read", "spawn", "poll"]) test(`runner automatically supplies generic ownership for runtime_proc.${name}`, async () => {
  const state = fixture(imported(name));
  try {
    await state.ready;
    expect(state.request().runtimeProcess).toBeDefined();
    expect((state.request().runtimeProcess!.data as { pipeRegistry: unknown }).pipeRegistry).toBeDefined();
  } finally { await state.dispose(); }
});
for (const name of ["signal", "interrupted", "default_signal"]) test(`runner preserves legacy Bun for runtime_proc.${name} alone`, async () => {
  const state = fixture(imported(name));
  try { await state.ready; expect(state.request().runtimeProcess).toBeUndefined(); }
  finally { await state.dispose(); }
});

test("preview1 runner choice passes through without changing ordinary Bun defaults", async () => {
  const state = fixture(imported("signal"), { adapter: "preview1" } as Partial<RunOptions>);
  try { await state.ready; expect(state.request().adapter).toBe("preview1"); }
  finally { await state.dispose(); }
});

test("UI signals freeze canonical root pipe publication only for fatal actions", async () => {
  const transport = createWorkerProcessTransport();
  const state = fixture(imported("pipe"), { runtimeProcess: transport });
  let controller: PipeController | undefined;
  try {
    await state.ready;
    const handle = (transport.data as { pipeRegistry?: PipePublicationRegistryHandle }).pipeRegistry;
    expect(handle).toBeDefined();
    const registry = attachPipePublicationRegistry(handle!);
    controller = new PipeController({ registry, relay: "manual", capacity: 16 });
    const reader = controller.retain(1, "read");
    const writer = controller.retain(1, "write");
    setSignalDisposition(workerProcessState(transport).signals.signalState, 2, 2);
    state.run.kill(2);
    expect(writer.tryWrite([new Uint8Array([1])])).toBe(1);
    state.run.kill(9);
    expect(writer.tryWrite([new Uint8Array([2])])).toBeLessThan(0);
    reader.close(); writer.close();
    expect(await state.run.done).toEqual({ code: 137 });
  } finally { controller?.dispose(); await state.dispose(); }
});

function registryFixture(options?: ConstructorParameters<typeof SubprocessBroker>[2]) {
  const root = createWorkerProcessTransport();
  root.data = { filesystem: createFilesystemIdentity() };
  const filesystem = {
    revoke: revokeFilesystem, client: { sweep() {} },
    async quiesce(identity: Parameters<typeof revokeFilesystem>[0]) { revokeFilesystem(identity); },
  } as unknown as SharedFilesystem;
  const broker = new SubprocessBroker("http://localhost/worker.js", filesystem, options);
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({ transport: root, descriptors,
    codec: { export() { throw new Error("unexpected export"); }, import() { throw new Error("unexpected import"); }, discard() {} },
    postMessage: message => messages.push(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: (root.data as { pipeRegistry: unknown }).pipeRegistry } }),
  });
  return { root, broker, client, messages, dispose() { broker.dispose(); descriptors.dispose(); } };
}

for (const path of ["supervisor", "dispose"] as const) test(`${path} freezes root-created pipe endpoints absent from supervisor descriptors`, async () => {
  const state = registryFixture();
  let controller: PipeController | undefined;
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const registry = attachPipePublicationRegistry((state.root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry);
    controller = new PipeController({ registry, relay: "manual", capacity: 16 });
    const writer = controller.retain(1, "write"), reader = controller.retain(1, "read");
    expect(writer.tryWrite([new Uint8Array([1])])).toBe(1);
    if (path === "supervisor") (await state.broker.ready()).kill(1, 9);
    else state.broker.dispose();
    expect(writer.tryWrite([new Uint8Array([2])])).toBeLessThan(0);
    writer.close(); reader.close();
  } finally { controller?.dispose(); state.dispose(); }
});

test("job kill freezes unknown reserved child endpoints before its spawn message is admitted", async () => {
  const state = registryFixture();
  let controller: PipeController | undefined;
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    expect(state.messages).toHaveLength(1);
    const registry = attachPipePublicationRegistry((state.root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry);
    controller = new PipeController({ registry, relay: "manual", capacity: 16 });
    const writer = controller.retain(pid, "write"), reader = controller.retain(pid, "read");
    expect(writer.tryWrite([new Uint8Array([1])])).toBe(1);
    await state.broker.killJob(1, 9);
    expect(writer.tryWrite([new Uint8Array([2])])).toBeLessThan(0);
    expect(() => controller!.retain(pid, "write")).toThrow();
    writer.close(); reader.close();
  } finally { controller?.dispose(); state.dispose(); }
});

test("ordinary root completion freezes only its own pipe row, not a reserved independent child", async () => {
  const state = registryFixture();
  let controller: PipeController | undefined;
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const registry = attachPipePublicationRegistry((state.root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry);
    controller = new PipeController({ registry, relay: "manual", capacity: 16 });
    const parent = controller.retain(1, "write"), child = controller.retain(pid, "write"), reader = controller.retain(pid, "read");
    state.broker.rootExit(0);
    expect(parent.tryWrite([new Uint8Array([1])])).toBeLessThan(0);
    expect(child.tryWrite([new Uint8Array([2])])).toBe(1);
    expect(registry.isRevoked(pid)).toBe(false);
    parent.close(); child.close(); reader.close();
  } finally { controller?.dispose(); state.dispose(); }
});

test("Preview1 root aliases launch Preview1 children instead of installing Bun slots", async () => {
  const state = fixture(imported("spawn"), { adapter: "preview1" });
  const descriptors = new DescriptorTable();
  try {
    await state.ready;
    const root = state.request().runtimeProcess!;
    const client = new WorkerProcessClient({ transport: root, descriptors,
      codec: { export() { throw new Error("unexpected export"); }, import() { throw new Error("unexpected import"); }, discard() {} },
      postMessage: message => state.message(message),
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: (root.data as { pipeRegistry: unknown }).pipeRegistry } }),
    });
    const pid = client.spawn(1, { executable: "bun", argv: ["child"], env: {}, cwd: "/", job: 1, fds: [] });
    const deadline = performance.now() + 1000;
    while (state.requests.length < 2 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    const child = state.requests.find(request => request.pid === pid);
    expect(child).toBeDefined();
    expect(child!.adapter).toBe("preview1");
  } finally { descriptors.dispose(); await state.dispose(); }
});

test("disposal before lazy pipe activation closes the subsequently created pipe broker", async () => {
  const state = registryFixture();
  const originalDispose = WorkerPipeBroker.prototype.dispose;
  let disposals = 0;
  WorkerPipeBroker.prototype.dispose = function () { disposals++; originalDispose.call(this); };
  try {
    const pending = state.broker.adoptRuntimeRoot(state.root);
    state.broker.dispose();
    await expect(pending).rejects.toThrow("disposed");
    expect(disposals).toBe(1);
  } finally { state.dispose(); WorkerPipeBroker.prototype.dispose = originalDispose; }
});

test("explicit root metadata without a filesystem forks an identity and preserves metadata", async () => {
  const transport = createWorkerProcessTransport();
  transport.data = { marker: "preserved" };
  const state = fixture(imported("pipe"), { runtimeProcess: transport });
  try {
    await state.ready;
    expect(state.request().filesystem.owner).toBeDefined();
    expect((transport.data as { marker: string }).marker).toBe("preserved");
    expect((transport.data as { filesystem: unknown }).filesystem).toBeDefined();
  } finally { await state.dispose(); }
});

test("pipe-only generic work uses the responsive relay without activating the process supervisor", async () => {
  let activations = 0;
  const state = registryFixture({ activate: async () => { activations++; return import("../../runtime/proc"); } });
  let controller: PipeController | undefined;
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    controller = new PipeController({ registry: attachPipePublicationRegistry(
      (state.root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry), relay: "manual", capacity: 16 });
    const reader = controller.retain(1, "read"), writer = controller.retain(1, "write");
    await state.broker.runtimeMessage({ type: "runtime-proc", operation: "pipe", transport: state.root, handle: reader.handle() }, 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(activations).toBe(0);
    writer.close(); reader.close();
  } finally { controller?.dispose(); state.dispose(); }
});
