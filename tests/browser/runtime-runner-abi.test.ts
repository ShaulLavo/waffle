import { processRuntimeFixture } from "./process-runtime-fixture";
import type { Runtime } from "@bun-wasm/runtime";
import { expect, test } from "bun:test";
import { createFilesystemIdentity, revokeFilesystem } from "../../runtime/fs";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage } from "../../runtime/proc/worker-client";
import { DescriptorTable } from "../../runtime/core/descriptors";
import { SubprocessBroker, type ExecutableRegistration } from "../src/subprocess-broker";
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
function fixture(module: WebAssembly.Module, options: Partial<RunOptions> | ((runtime: Runtime) => Partial<RunOptions>) = {}) {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const channel = new MessageChannel();
  const identity = createFilesystemIdentity();
  let sent!: RunRequest;
  const requests: RunRequest[] = [];
  const workerUrls = new Map<RunRequest, string>();
  let rootWorker: { onmessage?: (event: { data: WorkerProcessMessage }) => void };
  let posted!: () => void;
  const ready = new Promise<void>(resolve => { posted = resolve; });
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  globalThis.Worker = class {
    constructor(readonly url: string) { rootWorker ??= this; }
    onmessage?: (event: { data: WorkerProcessMessage }) => void;
    postMessage(request: RunRequest) { sent ??= request; requests.push(request); workerUrls.set(request, this.url); posted(); }
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
  const runtime = processRuntimeFixture(filesystem);
  let run: ReturnType<typeof startRun>;
  try { run = startRun({ engine: "browser", module, args: [], env: {}, runtime, moduleScope: false, ...(typeof options === "function" ? options(runtime) : options) }, { stdout() {}, stderr() {} }); }
  catch (error) { restore(); throw error; }
  return {
    run, runtime, ready, request: () => sent, requests, urlFor: (request: RunRequest) => workerUrls.get(request),
    message: (data: WorkerProcessMessage) => rootWorker.onmessage!({ data }),
    async dispose() {
      run.kill(9); await run.done;
      try { await runtime.dispose(); } finally { restore(); }
    },
  };
}

for (const name of ["pipe", "read", "spawn", "poll"]) test(`runner automatically supplies generic ownership for runtime_proc.${name}`, async () => {
  const state = fixture(imported(name));
  try {
    await state.ready;
    expect(state.request().runtimeProcess).toBeDefined();
    expect((state.request().runtimeProcess!.data as { pipeRegistry: unknown }).pipeRegistry).toBeDefined();
  } finally { await await state.dispose(); }
});
for (const name of ["signal", "interrupted", "default_signal"]) test(`runner preserves legacy Bun for runtime_proc.${name} alone`, async () => {
  const state = fixture(imported(name));
  try { await state.ready; expect(state.request().runtimeProcess).toBeUndefined(); }
  finally { await await state.dispose(); }
});

test("preview1 runner choice explicitly trusts its own aliases without changing Bun defaults", async () => {
  const registrations = new Map<string, Parameters<SubprocessBroker["register"]>[1]>();
  const register = SubprocessBroker.prototype.register;
  SubprocessBroker.prototype.register = function(name, entry) {
    registrations.set(name, entry);
    return register.call(this, name, entry);
  };
  let state: ReturnType<typeof fixture> | undefined;
  try {
    state = fixture(imported("spawn"), { adapter: "preview1" });
    await state.ready;
    expect(state.request().adapter).toBe("preview1");
    const descriptors = new DescriptorTable();
    try {
      const root = state.request().runtimeProcess!;
      const client = new WorkerProcessClient({ transport: root, descriptors,
        codec: { export() { throw new Error("unexpected export"); }, import() { throw new Error("unexpected import"); }, discard() {} },
        postMessage: message => state!.message(message),
        prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: (root.data as { pipeRegistry: unknown }).pipeRegistry } }),
      });
      for (const alias of ["bun", "/usr/local/bin/node"]) {
        const pid = client.spawn(1, { executable: alias, argv: [alias], env: {}, cwd: "/", job: 1, fds: [] });
        const deadline = performance.now() + 1000;
        while (!state.requests.some(request => request.runtimeProcess && workerProcessState(request.runtimeProcess).pid === pid) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
        const child = state.requests.find(request => request.runtimeProcess && workerProcessState(request.runtimeProcess).pid === pid);
        expect(child).toBeDefined();
        expect(state.urlFor(child!)).toBe("http://localhost/preview1-worker.js");
        const record = (await state.runtime.processes().then(service => service.ready())).get(pid)!;
        expect(registrations.get(record.request!.executable)).toMatchObject({ adapter: "preview1", cooperative: true });
      }
    } finally { descriptors.dispose(); }
    for (const engine of ["quickjs", "jsc", "browser"]) {
      expect(registrations.get(`bun-${engine}`)).toMatchObject({ adapter: "bun", engine });
    }
  } finally {
    SubprocessBroker.prototype.register = register;
    await state?.dispose();
  }
});

test("UI signals freeze canonical root pipe publication only for fatal actions", async () => {
  let transport!: ReturnType<typeof createWorkerProcessTransport>;
  const state = fixture(imported("pipe"), runtime => ({ runtimeProcess: transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer }) }));
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
  } finally { controller?.dispose(); await await state.dispose(); }
});

function registryFixture(options?: ConstructorParameters<typeof SubprocessBroker>[2] & { activate?: () => Promise<typeof import("../../runtime/proc")> }) {
  const ports: MessagePort[] = [];
  const filesystem = {
    connect(identity: object) {
      const channel = new MessageChannel();
      channel.port2.close();
      ports.push(channel.port1);
      return { ...identity, port: channel.port1 };
    },
    revoke: revokeFilesystem, client: { sweep() {} },
    async quiesce(identity: Parameters<typeof revokeFilesystem>[0]) { revokeFilesystem(identity); },
  } as unknown as SharedFilesystem;
  const runtime = processRuntimeFixture(filesystem, { activate: options?.activate });
  const root = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const broker = new SubprocessBroker("http://localhost/worker.js", runtime, options);
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({ transport: root, descriptors,
    codec: { export(descriptor) {
      if (descriptor.resource.kind === "terminal") return { kind: "web-terminal", target: 2 };
      throw new Error("unexpected export");
    }, import() { throw new Error("unexpected import"); }, discard() {} },
    postMessage: message => messages.push(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: (root.data as { pipeRegistry: unknown }).pipeRegistry } }),
  });
  return { root, runtime, broker, client, messages, descriptors, async dispose() { broker.dispose(); descriptors.dispose(); try { await runtime.dispose(); } finally { for (const port of ports) port.close(); } } };
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
    else void state.runtime.dispose();
    expect(writer.tryWrite([new Uint8Array([2])])).toBeLessThan(0);
    writer.close(); reader.close();
  } finally { controller?.dispose(); await state.dispose(); }
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
  } finally { controller?.dispose(); await state.dispose(); }
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
  } finally { controller?.dispose(); await state.dispose(); }
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
    const child = state.requests.find(request => request.runtimeProcess && workerProcessState(request.runtimeProcess).pid === pid);
    expect(child).toBeDefined();
    expect(state.urlFor(child!)).toBe("http://localhost/preview1-worker.js");
  } finally { descriptors.dispose(); await await state.dispose(); }
});

test("disposal before lazy pipe activation closes the subsequently created pipe broker", async () => {
  const state = registryFixture();
  const originalDispose = WorkerPipeBroker.prototype.dispose;
  let disposals = 0;
  WorkerPipeBroker.prototype.dispose = function () { disposals++; originalDispose.call(this); };
  try {
    const creating = state.runtime.processes();
    const pending = state.broker.adoptRuntimeRoot(state.root);
    const disposal = state.runtime.dispose();
    await expect(pending).rejects.toThrow("disposed");
    await creating;
    await disposal;
    expect(disposals).toBe(1);
  } finally { await state.dispose(); WorkerPipeBroker.prototype.dispose = originalDispose; }
});

test("explicit root metadata without a filesystem forks an identity and preserves metadata", async () => {
  let transport!: ReturnType<typeof createWorkerProcessTransport>;
  const state = fixture(imported("pipe"), runtime => {
    transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
    transport.data = { marker: "preserved" };
    return { runtimeProcess: transport };
  });
  try {
    await state.ready;
    expect(state.request().filesystem.owner).toBeDefined();
    expect((transport.data as { marker: string }).marker).toBe("preserved");
    expect((transport.data as { filesystem: unknown }).filesystem).toBeDefined();
  } finally { await await state.dispose(); }
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
  } finally { controller?.dispose(); await state.dispose(); }
});

test("generic runtime byte registrations retain injected-check metadata at worker launch", async () => {
  const NativeWorker = globalThis.Worker;
  const requests: RunRequest[] = [];
  let terminated = false;
  globalThis.Worker = class {
    postMessage(request: RunRequest) { requests.push(request); request.filesystem.port.close(); }
    terminate() { terminated = true; }
  } as unknown as typeof Worker;
  const state = registryFixture();
  try {
    state.broker.register("injected", { adapter: "preview1", bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) });
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "injected", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    await state.broker.runtimeMessage(state.messages[0]!, 1);
    const deadline = performance.now() + 1000;
    while (!requests.length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    expect(workerProcessState(requests[0]!.runtimeProcess!).pid).toBe(pid);
    expect(requests[0]!.interruptible).toBe(true);
  } finally {
    await state.dispose();
    const deadline = performance.now() + 1000;
    while (requests.length && !terminated && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    globalThis.Worker = NativeWorker;
  }
});

for (const refusal of ["compiled", "SIMD"] as const) test(refusal === "compiled"
  ? "untrusted compiled-only registration is rejected before child admission"
  : "generic runtime SIMD refusal writes actionable inherited stderr before closing descriptors", async () => {
  const output: { fd: number; text: string }[] = [];
  const state = registryFixture({ output(fd, data) { output.push({ fd, text: new TextDecoder().decode(data) }); } });
  try {
    const body = [0, 0xfd, 0x0c].concat(new Array<number>(16).fill(0), [0x1a, 0x0b]);
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0,
      10, body.length + 2, 1, body.length].concat(body));
    expect(WebAssembly.validate(bytes)).toBe(true);
    const entry = refusal === "SIMD" ? { adapter: "preview1", bytes } : {
      adapter: "preview1", module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    };
    if (refusal === "compiled") {
      expect(() => state.broker.register("refused", entry as ExecutableRegistration)).toThrow(/require source bytes/);
      expect(output).toHaveLength(0);
      expect(state.messages).toHaveLength(0);
      return;
    }
    state.broker.register("refused", entry as ExecutableRegistration);
    await state.broker.adoptRuntimeRoot(state.root);
    const fd = state.descriptors.open({ kind: "terminal", read: () => 0, write: () => 0,
      readiness: () => ({ readable: false, writable: true, hangup: false }) }, 0xffffn, 0n);
    const pid = state.client.spawn(1, { executable: "refused", argv: [], env: {}, cwd: "/", job: 1,
      fds: [{ child: 2, parent: fd }] });
    await state.broker.runtimeMessage(state.messages[0]!, 1);
    expect((await state.broker.wait(pid)).status).toBe(126);
    expect(output).toHaveLength(1);
    expect(output[0]!.fd).toBe(2);
    expect(output[0]!.text).toMatch(refusal === "SIMD" ? /Cannot instrument WebAssembly:.*SIMD/ : /require source bytes/);
  } finally { await state.dispose(); }
});
