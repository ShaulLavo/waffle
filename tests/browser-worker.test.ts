import { controlLoad, controlStore, controlCas, controlExchange, controlAdd } from "../proc/control.js";
import { expect, spyOn, test } from "bun:test";
import { bootstrap, RuntimeWorkerSignal, type RuntimeWorkerMessage, type RuntimeWorkerRequest, type WorkerExecutor } from "../browser/worker.js";
import { createFilesystemConnection, FilesystemClient, FilesystemService, MemoryBackend } from "../fs/index.js";
import { collectDirectoryJob, confirmDirectoryProcess } from "../proc/directory.js";
import { DescriptorTable } from "../core/descriptors.js";
import { claimOutcome, outcomeWord, readOutcome } from "../proc/outcome.js";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage } from "../proc/worker-client.js";
import { createSignalState, requestSignal, setSignalDisposition, signalPending, SIGNAL_PENDING, takeSignal } from "../proc/signals.js";

// Original tiny guest: one memory and an empty preview1 command entry point.
const module = new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,0,1,
  7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,
  10,4,1,2,0,11,
]));

test("injected worker executor observes live descriptors, then acknowledgement follows filesystem release", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const messages: RuntimeWorkerMessage[] = [];
  let released = false;
  try {
    await bootstrap({ module, args: ["fixture"], env: {}, filesystem: connection.client }, {
      setup({ fs }) {
        // The fixture has no filesystem calls. Keep its preopen local so this unit test
        // never blocks waiting for a service on the same JavaScript thread.
        fs.preopen = () => 1;
        fs.retain = () => {};
        fs.release = () => {};
      },
      run(context, exited) {
        expect(exited).toBeNull();
        expect(context.wasi.descriptors.get(1)).toBeDefined();
        const dispose = context.fs.dispose.bind(context.fs);
        context.fs.dispose = () => { dispose(); released = true; };
        context.post("stdout", new Uint8Array([65]));
        context.finish({ code: 23 });
        return 0;
      },
    }, {
      crossOriginIsolated: true,
      postMessage(message) {
        if (message.type === "exit") expect(released).toBe(true);
        messages.push(message);
      },
    });
    expect(messages.filter(message => message.type === "exit")).toEqual([
      { type: "exit", code: 23, signal: undefined, sleep: "atomics" },
    ]);
    expect(messages.filter(message => message.type === "stdout")).toEqual([
      { type: "stdout", data: new Uint8Array([65]) },
    ]);
  } finally { connection.client.port.close(); service.dispose(); }
});

test("preview1 worker bundle has no Bun engine, native slot or legacy subprocess graph", async () => {
  const result = await Bun.build({ entrypoints: [new URL("../browser/preview1-worker.js", import.meta.url).pathname], target: "browser" });
  expect(result.success).toBe(true);
  const source = await result.outputs[0]!.text();
  for (const marker of ["startEngineHost", "SubprocessHost", "installHostSlots", "bunwasm_ready", "moduleCache", "engine-host.js"]) {
    expect(source).not.toContain(marker);
  }
});

async function fixture(executor: WorkerExecutor, options: { isolated?: boolean; runtimeProcess?: RuntimeWorkerRequest["runtimeProcess"]; module?: WebAssembly.Module; interruptible?: boolean } = {}) {
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [];
  const order: string[] = [];
  try {
    await bootstrap({ module: options.module ?? module, args: ["fixture"], env: {}, filesystem: connection.client, runtimeProcess: options.runtimeProcess, interruptible: options.interruptible }, {
      ...executor,
      setup(context) {
        const { fs } = context;
        fs.preopen = () => 1;
        fs.retain = () => {};
        fs.release = () => { order.push("descriptor release"); };
        const dispose = fs.dispose.bind(fs);
        fs.dispose = () => { order.push("filesystem release"); dispose(); };
        executor.setup?.(context);
      },
    }, {
      crossOriginIsolated: options.isolated ?? true,
      postMessage(message) { messages.push(message); if (message.type === "exit" || message.type === "error") order.push("acknowledgement"); },
    });
    return { messages, order };
  } finally { connection.client.port.close(); connection.server.port.close(); }
}

for (const isolated of [true, false]) test(`generic signal winner guards stdio and survives caught unwinds (isolated=${isolated})`, async () => {
  const result = await fixture({
    run(context) {
      try { context.defaultSignal(15); } catch (error) { expect(error).toBeInstanceOf(RuntimeWorkerSignal); }
      expect(() => context.post("stdout", new Uint8Array([65]))).toThrow("signal 15");
      expect(() => context.post("stderr", new Uint8Array([66]))).toThrow("signal 15");
      return 0;
    },
  }, { isolated });
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toEqual([
    { type: "exit", code: 143, signal: 15, sleep: isolated ? "atomics" : "busy-wait" },
  ]);
  expect(result.messages.some(message => message.type === "stdout" || message.type === "stderr")).toBe(false);
  expect(result.messages.filter(message => message.type === "default-signal").length).toBe(isolated ? 0 : 3);
  expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
});

test("a delayed stale Worker releases its filesystem and reports startup failure without touching its replacement", async () => {
  const root = createWorkerProcessTransport({ capacity: 2 });
  const descriptors = new DescriptorTable(), notices: WorkerProcessMessage[] = [];
  const owner = new WorkerProcessClient({ transport: root, descriptors,
    codec: { export() { throw new Error("unused"); }, import() { throw new Error("unused"); }, discard() {} },
    postMessage(message) { notices.push(message); },
  });
  const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] };
  const first = owner.spawn(owner.pid, request);
  const old = notices.find(message => message.operation === "spawn")!;
  if (old.operation !== "spawn") throw new Error("missing spawn fixture");
  const state = workerProcessState(old.transport);
  claimOutcome(state.signals.outcome, { kind: "exited", code: 23 });
  confirmDirectoryProcess(old.transport);
  collectDirectoryJob(root.directory, state.jobSlot, state.job);
  const replacement = owner.spawn(owner.pid, request);
  const latest = notices.at(-1)!;
  if (latest.operation !== "spawn") throw new Error("missing replacement fixture");
  const current = workerProcessState(latest.transport);
  expect(replacement).not.toBe(first);
  expect(current.slot).toBe(state.slot);
  const connection = createFilesystemConnection(), messages: RuntimeWorkerMessage[] = [], order: string[] = [];
  const dispose = spyOn(FilesystemClient.prototype, "dispose");
  let entered = false;
  try {
    await expect(bootstrap({ module, args: [], env: {}, filesystem: connection.client, runtimeProcess: old.transport }, {
      setup() { entered = true; }, run() { entered = true; return 0; }, beforeFinish() { order.push("executor cleanup"); },
    }, { crossOriginIsolated: true, postMessage(message) {
      if (message.type === "error") { expect(dispose).toHaveBeenCalledTimes(1); order.push("acknowledgement"); }
      messages.push(message);
    } })).resolves.toBeUndefined();
    expect(entered).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["executor cleanup", "acknowledgement"]);
    expect(messages.filter(message => message.type === "error")).toMatchObject([
      { type: "error", code: 126, message: expect.stringContaining("process incarnation was collected") },
    ]);
    expect(messages.some(message => message.type === "runtime-proc")).toBe(false);
    expect(readOutcome(current.signals.outcome)).toBeNull();
    expect(controlLoad(current.confirmed)).toBe(0);
    expect(controlLoad(current.jobPending)).toBe(1);
  } finally { dispose.mockRestore(); descriptors.dispose(); connection.client.port.close(); connection.server.port.close(); }
});

test("collection during Worker setup cannot bypass filesystem cleanup through a stale outcome", async () => {
  const root = createWorkerProcessTransport({ capacity: 2 }), descriptors = new DescriptorTable();
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({ transport: root, descriptors,
    codec: { export() { throw new Error("unused"); }, import() { throw new Error("unused"); }, discard() {} },
    postMessage(message) { notices.push(message); },
  });
  const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] };
  client.spawn(client.pid, request);
  const notice = notices[0]!;
  if (notice.operation !== "spawn") throw new Error("missing spawn fixture");
  const state = workerProcessState(notice.transport);
  let replacement: ReturnType<typeof workerProcessState> | undefined, ran = false;
  try {
    const result = await fixture({
      setup() {
        claimOutcome(state.signals.outcome, { kind: "exited", code: 23 }); confirmDirectoryProcess(notice.transport);
        collectDirectoryJob(root.directory, state.jobSlot, state.job);
        client.spawn(client.pid, request);
        replacement = workerProcessState(notices.at(-1)!.transport);
      },
      run() { ran = true; return 0; },
    }, { runtimeProcess: notice.transport });
    expect(ran).toBe(false);
    expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
    expect(result.messages.filter(message => message.type === "error")).toMatchObject([
      { type: "error", code: 126, message: expect.stringContaining("process incarnation was collected") },
    ]);
    expect(replacement?.slot).toBe(state.slot);
    expect(readOutcome(replacement!.signals.outcome)).toBeNull();
    expect(controlLoad(replacement!.confirmed)).toBe(0);
  } finally { descriptors.dispose(); }
});

test("generic runtime process adopts the shared signal winner and releases descriptors before exit acknowledgement", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  const state = workerProcessState(runtimeProcess);
  const result = await fixture({
    run(context) {
      claimOutcome(state.signals.outcome, { kind: "signaled", code: 9 });
      expect(() => context.checkActive()).toThrow();
      return 23;
    },
  }, { runtimeProcess });
  expect(readOutcome(state.signals.outcome)).toMatchObject({ kind: "signaled", code: 9 });
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toEqual([
    { type: "exit", code: 137, signal: 9, sleep: "atomics" },
  ]);
  expect(result.order.at(-1)).toBe("acknowledgement");
});

test("generic executor crash keeps host diagnostics and the first terminal result", async () => {
  const outcome = new SharedArrayBuffer(8);
  const result = await fixture({ outcome, run() { throw new Error("executor diagnostic"); } });
  expect(readOutcome(outcomeWord(outcome))).toMatchObject({ kind: "exited", code: 1 });
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject([
    { type: "error", code: 1, message: expect.stringContaining("executor diagnostic") },
  ]);
  expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
});

test("generic startup failure reports 126 and never enters its injected executor", async () => {
  const missingStart = new WebAssembly.Module(new Uint8Array([
    0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0,
  ]));
  let ran = false;
  const result = await fixture({ run() { ran = true; return 0; } }, { module: missingStart });
  expect(ran).toBe(false);
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject([
    { type: "error", code: 126, message: expect.stringContaining("_start") },
  ]);
  expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
});

test("throwing finish hook still releases owned resources and acknowledges the selected exit once", async () => {
  const outcome = new SharedArrayBuffer(8);
  const result = await fixture({
    outcome,
    beforeFinish() { throw new Error("finish hook failed"); },
    run() { return 23; },
  });
  expect(readOutcome(outcomeWord(outcome))).toMatchObject({ kind: "exited", code: 23 });
  expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject([
    { type: "exit", code: 23, cleanupErrors: [expect.stringContaining("finish hook failed")] },
  ]);
});

test("descriptor release failures drain the table and filesystem but require the page fence instead of acknowledging quiescence", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  const outcome = workerProcessState(runtimeProcess).signals.outcome;
  const released: string[] = [];
  let descriptors: import("../core/descriptors.js").DescriptorTable;
  const result = await fixture({
    instantiated({ wasi }) {
      descriptors = wasi.descriptors;
      wasi.descriptors.open({ kind: "file", handle: 2, offset: 0, append: false }, 0n, 0n,
        () => { released.push("first"); throw new Error("first descriptor failed"); });
      wasi.descriptors.open({ kind: "file", handle: 3, offset: 0, append: false }, 0n, 0n,
        () => { released.push("second"); throw new Error("second descriptor failed"); });
      wasi.descriptors.open({ kind: "file", handle: 4, offset: 0, append: false }, 0n, 0n,
        () => { released.push("last"); });
    },
    run() { claimOutcome(outcome, { kind: "signaled", code: 9 }); return 0; },
  }, { runtimeProcess });
  expect(released).toEqual(["first", "second", "last"]);
  expect(readOutcome(outcome)).toMatchObject({ kind: "signaled", code: 9 });
  expect(() => descriptors!.dispose()).not.toThrow();
  expect(released).toEqual(["first", "second", "last"]);
  expect(result.order).toEqual(["descriptor release", "filesystem release"]);
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toEqual([]);
  expect(result.messages.filter(message => message.type === "cleanup-error")).toMatchObject([
    { type: "cleanup-error", code: 137, signal: 9, cleanupErrors: [expect.stringContaining("first descriptor failed"), expect.stringContaining("second descriptor failed")] },
  ]);
  expect(result.messages.some(message => message.type === "runtime-proc" && message.operation === "exit")).toBe(false);
});

test("filesystem release failure preserves the exit winner without publishing quiescence", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  let restored: (() => void) | undefined;
  try {
    const result = await fixture({
      setup({ fs }) {
        restored = fs.dispose.bind(fs);
        fs.dispose = () => { throw new Error("filesystem release failed"); };
      },
      run() { return 23; },
    }, { runtimeProcess });
    expect(readOutcome(workerProcessState(runtimeProcess).signals.outcome)).toMatchObject({ kind: "exited", code: 23 });
    expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toEqual([]);
    expect(result.messages.filter(message => message.type === "cleanup-error")).toMatchObject([
      { type: "cleanup-error", code: 23, cleanupErrors: [expect.stringContaining("filesystem release failed")] },
    ]);
    expect(result.messages.some(message => message.type === "runtime-proc" && message.operation === "exit")).toBe(false);
    expect(result.order).toEqual(["descriptor release"]);
  } finally { restored?.(); }
});

test("legacy lifecycle failures still attempt diagnostics, release and completion without overwriting its signal winner", async () => {
  const outcome = new SharedArrayBuffer(8);
  const hooks: string[] = [];
  const result = await fixture({
    outcome,
    beforeFinish() { hooks.push("before"); throw new Error("before failed"); },
    diagnostic() { hooks.push("diagnostic"); throw new Error("diagnostic failed"); },
    complete() {
      hooks.push("complete");
      claimOutcome(outcomeWord(outcome), { kind: "signaled", code: 9 });
      throw new Error("complete failed");
    },
    run() { throw new Error("guest failed"); },
  });
  expect(hooks).toEqual(["before", "diagnostic", "complete"]);
  expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject([
    { type: "exit", code: 137, signal: 9, cleanupErrors: [expect.stringContaining("before failed"), expect.stringContaining("diagnostic failed"), expect.stringContaining("complete failed")] },
  ]);
});

// Original wasm fixture exports its imported ABI functions so the test observes the real
// bootstrap-selected imports without an unbounded guest loop or a second signal model.
function signalModule(): WebAssembly.Module {
  const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const imported = (name: string, type: number) => text("runtime_proc").concat(text(name), [0, type]);
  const exported = (name: string, kind: number, index: number) => text(name).concat([kind, index]);
  return new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0].concat(
    section(1, [4,96,2,127,127,1,127,96,0,1,127,96,0,0,96,1,127,1,127]),
    section(2, [3].concat(imported("signal", 0), imported("interrupted", 1), imported("default_signal", 3))),
    section(3, [1,2]), section(5, [1,0,1]),
    section(7, [5].concat(exported("signal", 0, 0), exported("interrupted", 0, 1), exported("default_signal", 0, 2), exported("memory", 2, 0), exported("_start", 0, 3))),
    section(10, [1,2,0,11]),
  )));
}

for (const interruptible of [false, true]) test(`handled TERM dequeues only through cooperative ABI (fatal instrumentation=${interruptible})`, async () => {
  const runtimeProcess = createWorkerProcessTransport();
  const state = workerProcessState(runtimeProcess);
  const deliveries: number[] = [];
  const result = await fixture({
    run({ instance }) {
      const signal = instance.exports.signal as (signal: number, mode: number) => number;
      const interrupted = instance.exports.interrupted as () => number;
      expect(signal(15, 2)).toBe(0);
      expect(requestSignal(state.signals, 15).action).toBe("handled");
      for (let i = 0; i < 3; i++) deliveries.push(interrupted());
      expect(controlLoad(state.signals.signalState, 15) & SIGNAL_PENDING).toBe(interruptible ? SIGNAL_PENDING : 0);
      return 0;
    },
  }, { runtimeProcess, module: signalModule(), interruptible });
  expect(deliveries).toEqual(interruptible ? [0,0,0] : [15,0,0]);
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject([{ type: "exit", code: 0 }]);
});

test("synchronous executor completion selects its outcome before queued guest microtasks", async () => {
  const outcome = new SharedArrayBuffer(8);
  let observed: ReturnType<typeof readOutcome>;
  await fixture({ outcome, run() {
    queueMicrotask(() => { observed = readOutcome(outcomeWord(outcome)); });
    return 23;
  } });
  expect(observed!).toMatchObject({ kind: "exited", code: 23 });
});

for (const complete of [false, true]) test(`startup failure selects typed EACCES before completion (legacy=${complete})`, async () => {
  const outcome = new SharedArrayBuffer(8);
  const missingStart = new WebAssembly.Module(new Uint8Array([
    0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0,
  ]));
  const result = await fixture({ outcome,
    complete: complete ? (code, signal) => claimOutcome(outcomeWord(outcome), signal === undefined ? { kind: "exited", code } : { kind: "signaled", code: signal }) : undefined,
    run() { throw new Error("must not run"); },
  }, { module: missingStart });
  expect(readOutcome(outcomeWord(outcome))).toEqual({ kind: "start-failed", code: 13, error: "EACCES", status: null });
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject([{ code: 126 }]);
});

// Original tiny module: expose one adapter import and runtime_proc.spawn to the executor.
function extensionModule(): WebAssembly.Module {
  const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const imported = (namespace: string, name: string, type: number) => text(namespace).concat(text(name), [0, type]);
  const exported = (name: string, kind: number, index: number) => text(name).concat([kind, index]);
  return new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0].concat(
    section(1, [3,96,0,1,127,96,2,127,127,1,127,96,0,0]),
    section(2, [2].concat(imported("guest_extension", "value", 0), imported("runtime_proc", "spawn", 1))),
    section(3, [1,2]), section(5, [1,0,1]),
    section(7, [4].concat(exported("value", 0, 0), exported("spawn", 0, 1), exported("memory", 2, 0), exported("_start", 0, 2))),
    section(10, [1,2,0,11]),
  )));
}

test("executor hooks link extra namespaces after setup and before instantiation, preserving reserved spawn authority", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  const order: string[] = [];
  const metadata = new SharedArrayBuffer(8);
  const result = await fixture({
    setup() { order.push("setup"); },
    namespaces({ request }) {
      expect(request.runtimeProcess).toBe(runtimeProcess);
      order.push("namespaces");
      return { guest_extension: { value: () => 7 }, runtime_proc: { spawn: () => -99 } };
    },
    beforeBindings({ wasi }) {
      order.push("beforeBindings");
      expect(wasi.descriptors.get(3)?.preopen).toBe("/");
    },
    imports(imports, { wasi }) {
      order.push("imports");
      expect(wasi.descriptors.get(3)?.preopen).toBe("/");
      expect((imports.guest_extension!.value as () => number)()).toBe(7);
      return { ...imports, guest_extension: { value: () => 23 } };
    },
    spawnData() {
      order.push("spawnData");
      return { metadata, filesystem: "forbidden", pipeRegistry: "forbidden" };
    },
    instantiated({ wasi, instance }) {
      order.push("instantiated");
      expect(wasi.descriptors.get(3)?.preopen).toBe("/");
      expect((instance.exports.value as () => number)()).toBe(23);
    },
    run({ instance }) {
      order.push("run");
      const request = new TextEncoder().encode(JSON.stringify({ executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] }));
      new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer).set(request);
      expect((instance.exports.spawn as (ptr: number, size: number) => number)(0, request.length)).toBeGreaterThan(0);
      return 0;
    },
  }, { runtimeProcess, module: extensionModule() });
  expect(order).toEqual(["setup", "namespaces", "beforeBindings", "imports", "instantiated", "run", "spawnData"]);
  const spawn = result.messages.find(message => message.type === "runtime-proc" && message.operation === "spawn");
  expect(spawn).toBeDefined();
  if (spawn?.type !== "runtime-proc" || spawn.operation !== "spawn") throw new Error("no spawn");
  expect(spawn.transport.data).toMatchObject({ metadata });
  expect((spawn.transport.data as Record<string, unknown>).filesystem).toBeObject();
  expect((spawn.transport.data as Record<string, unknown>).pipeRegistry).toBeObject();
});

test("beforeBindings can release default stdio and preserve a preopen before fd3 inheritance", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  runtimeProcess.resources.push({ kind: "web-terminal", target: 0 });
  runtimeProcess.bindings.push({ fd: 3, reference: 0, rightsBase: 0n, rightsInheriting: 0n });
  let closed = 0;
  const result = await fixture({
    stdio: { 0: { kind: "terminal", read: () => 0, write: () => 0,
      readiness: () => ({ readable: true, writable: true, hangup: true }), close() { closed++; } } },
    beforeBindings({ wasi }) {
      for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
      // A real adapter also adjusts preview1 discovery in its imports hook: wasi-libc scans
      // from fd3 upward and stops at the first non-preopen. This test checks lifetime only.
      const root = wasi.descriptors.get(3)!;
      wasi.descriptors.add(root.description, { rightsBase: root.rightsBase, rightsInheriting: root.rightsInheriting, preopen: "/" });
    },
    resolveTerminal(target) {
      expect(target).toBe(0);
      return { kind: "terminal", read: chunks => { chunks[0]![0] = 65; return 1; }, write: () => 0,
        readiness: () => ({ readable: true, writable: false, hangup: false }), close() { closed++; } };
    },
    instantiated({ wasi }) {
      expect(closed).toBe(1);
      expect(wasi.descriptors.get(4)?.preopen).toBe("/");
      const terminal = wasi.descriptors.get(3)!.resource;
      if (terminal.kind !== "terminal") throw new Error("not terminal");
      const data = new Uint8Array(1);
      expect(terminal.read([data])).toBe(1);
      expect(data[0]).toBe(65);
    },
    run: () => 0,
  }, { runtimeProcess });
  expect(closed).toBe(2);
  expect(result.messages.filter(message => message.type === "exit")).toMatchObject([{ code: 0 }]);
});

for (const append of [false, true]) test(`executor post follows live files and shared offsets (append=${append})`, async () => {
  const { shareFileResource } = await import("../core/open-file.js");
  const writes: [number, string][] = [];
  const result = await fixture({
    instantiated({ wasi, fs, post }) {
      const resource = { kind: "file" as const, handle: 17, offset: 4, append };
      const alias = wasi.descriptors.open(resource, 1n << 6n, 0n);
      shareFileResource(resource, fs.connection);
      fs.write = (_handle, chunks, offset) => { writes.push([offset, new TextDecoder().decode(chunks[0])]); return chunks[0]!.length; };
      fs.append = (_handle, chunks) => { writes.push([99, new TextDecoder().decode(chunks[0])]); return { written: chunks[0]!.length, offset: 100 }; };
      wasi.descriptors.inherit(1, wasi.descriptors.get(alias)!);
      wasi.descriptors.inherit(2, wasi.descriptors.get(alias)!);
      expect(post("stdout", new Uint8Array())).toBe(true);
      expect(resource.offset).toBe(4);
      expect(writes).toEqual([]);
      expect(post("stdout", new Uint8Array([65]))).toBe(true);
      expect(resource.offset).toBe(append ? 100 : 5);
      expect(post("stderr", new Uint8Array([66]))).toBe(true);
      expect(resource.offset).toBe(append ? 100 : 6);
      wasi.descriptors.close(1);
      expect(post("stdout", new Uint8Array([67]))).toBe(false);
    },
    run: () => 0,
  });
  expect(writes).toEqual(append ? [[99, "A"], [99, "B"]] : [[4, "A"], [5, "B"]]);
  expect(result.messages.some(message => message.type === "stdout" || message.type === "stderr")).toBe(false);
});

test("executor post uses blocking live pipe writes and reports partial-write backpressure", async () => {
  let staleWrites = 0, writes = 0;
  const result = await fixture({
    stdio: { 1: { kind: "terminal", read: () => 0, write: () => { staleWrites++; return 1; },
      readiness: () => ({ readable: false, writable: true, hangup: false }) } },
    instantiated({ wasi, post }) {
      const fd = wasi.descriptors.open({ kind: "pipe", read: () => 0,
        write(chunks) { writes++; return chunks[0]!.length - 1; },
        tryWrite() { throw new Error("post must use blocking stream I/O"); },
        readiness: () => ({ readable: false, writable: true, hangup: false }) }, 1n << 6n, 0n);
      wasi.descriptors.inherit(1, wasi.descriptors.get(fd)!);
      expect(post("stdout", new Uint8Array([65, 66]))).toBe(false);
    },
    run: () => 0,
  });
  expect(writes).toBe(1);
  expect(staleWrites).toBe(0);
  expect(result.messages.some(message => message.type === "stdout")).toBe(false);
});

test("an inherited terminal alias keeps its destination when that target fd is redirected", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  runtimeProcess.resources.push({ kind: "web-terminal", target: 1 });
  runtimeProcess.bindings.push({ fd: 2, reference: 0, rightsBase: 1n << 6n, rightsInheriting: 0n });
  const result = await fixture({
    instantiated({ wasi, fs, post }) {
      fs.write = () => { throw new Error("terminal provenance must not follow fd1's file redirect"); };
      const file = wasi.descriptors.open({ kind: "file", handle: 17, offset: 0, append: false }, 0n, 0n);
      wasi.descriptors.inherit(1, wasi.descriptors.get(file)!);
      expect(post("stderr", new Uint8Array([65]))).toBe(true);
    },
    run: () => 0,
  }, { runtimeProcess });
  expect(result.messages.filter(message => message.type === "stdout" || message.type === "stderr")).toEqual([
    { type: "stdout", data: new Uint8Array([65]) },
  ]);
});

// Original fixture builder, not copied from an upstream implementation.
function guestModule(options: { namespace: string; name: string; params: number[]; body: number[]; importedMemory?: boolean; startSection?: boolean }): WebAssembly.Module {
  const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const exported = (name: string, kind: number, index: number) => text(name).concat([kind, index]);
  const imported = text(options.namespace).concat(text(options.name), [0, 0]);
  const memory = text("env").concat(text("memory"), [2, 0, 1]);
  const body = [0].concat(options.body, [11]);
  return new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0].concat(
    section(1, [2,96,options.params.length].concat(options.params, [1,127,96,0,0])),
    section(2, options.importedMemory ? [2].concat(memory, imported) : [1].concat(imported)),
    section(3, options.startSection ? [2,1,1] : [1,1]),
    options.importedMemory ? [] : section(5, [1,0,1]),
    section(7, [2].concat(exported("memory",2,0), exported("_start",0,options.startSection ? 2 : 1))),
    options.startSection ? section(8, [1]) : [],
    section(10, options.startSection ? [2,body.length].concat(body, [2,0,11]) : [1,body.length].concat(body)),
  )));
}

for (const hook of ["setup", "namespaces", "beforeBindings", "imports", "instantiated"] as const) {
  for (const action of ["finish", "throw"] as const) test(`${hook} ${action} stops bootstrap and releases owned stdio exactly once`, async () => {
    let starts = 0, runs = 0, closed = 0;
    const seen: string[] = [];
    const stop = (name: string, context: import("../browser/worker.js").WorkerSetupContext) => {
      seen.push(name);
      if (name !== hook) return;
      if (action === "throw") throw new Error(`failed ${hook}`);
      context.finish({ code: 126 });
    };
    const guest = guestModule({ namespace: "extension", name: "start", params: [], body: [16,0,26] });
    const result = await fixture({
      stdio: { 1: { kind: "terminal", read: () => 0, write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }), close() { closed++; } } },
      setup(context) { stop("setup", context); },
      namespaces(context) { stop("namespaces", context); return { extension: { start() { starts++; return 0; } } }; },
      beforeBindings(context) { stop("beforeBindings", context); },
      imports(_imports, context) { stop("imports", context); },
      instantiated(context) { stop("instantiated", context); },
      run() { runs++; return 0; },
    }, { module: guest, runtimeProcess: createWorkerProcessTransport() });
    expect(seen.at(-1)).toBe(hook);
    expect(starts).toBe(0);
    expect(runs).toBe(0);
    expect(closed).toBe(1);
    expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toHaveLength(1);
    expect(result.order.at(-1)).toBe("acknowledgement");
  });
}

for (const inherited of [false, true]) test(`post honors fd write rights (inherited=${inherited})`, async () => {
  const runtimeProcess = inherited ? createWorkerProcessTransport() : undefined;
  if (runtimeProcess) {
    runtimeProcess.resources.push({ kind: "web-terminal", target: 1 });
    runtimeProcess.bindings.push({ fd: 1, reference: 0, rightsBase: 0n, rightsInheriting: 0n });
  }
  let writes = 0;
  const result = await fixture({
    resolveTerminal() { return { kind: "terminal", read: () => 0, write() { writes++; return 1; },
      readiness: () => ({ readable: false, writable: true, hangup: false }) }; },
    run({ wasi, post }) {
      if (!inherited) wasi.descriptors.get(1)!.rightsBase = 0n;
      expect(post("stdout", new Uint8Array([65]))).toBe(false);
      expect(post("stdout", new Uint8Array())).toBe(false);
      return 0;
    },
  }, { runtimeProcess });
  expect(writes).toBe(0);
  expect(result.messages.some(message => message.type === "stdout")).toBe(false);
});

function spawnWithFds(instance: WebAssembly.Instance, fds: { parent: number; child: number }[]): number {
  const bytes = new TextEncoder().encode(JSON.stringify({ executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds }));
  new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer).set(bytes);
  return (instance.exports.spawn as (ptr: number, count: number) => number)(0, bytes.length);
}

for (const moved of [false, true]) test(`default terminal provenance survives beforeBindings relocation (stdio-slot=${moved})`, async () => {
  const result = await fixture({
    namespaces: () => ({ guest_extension: { value: () => 0 } }),
    beforeBindings({ wasi }) {
      if (moved) wasi.descriptors.inherit(0, wasi.descriptors.get(1)!);
      else expect(wasi.descriptors.dup(1)).toBe(4);
      wasi.descriptors.close(1);
    },
    run({ instance }) { expect(spawnWithFds(instance, [{ parent: moved ? 0 : 4, child: 7 }])).toBeGreaterThan(0); return 0; },
  }, { module: extensionModule(), runtimeProcess: createWorkerProcessTransport() });
  const spawn = result.messages.find(message => message.type === "runtime-proc" && message.operation === "spawn");
  if (spawn?.type !== "runtime-proc" || spawn.operation !== "spawn") throw new Error("missing spawn");
  expect(spawn.transport.resources).toEqual([{ kind: "web-terminal", target: 1 }]);
});

test("terminal provenance outranks a real resolved PipeEndpoint when spawning the next generation", async () => {
  const { PipeController } = await import("../proc/pipes.js");
  const runtimeProcess = createWorkerProcessTransport(), pipe = new PipeController({ relay: "manual" });
  const pid = workerProcessState(runtimeProcess).pid, reader = pipe.retain(pid, "read"), writer = pipe.retain(pid, "write");
  runtimeProcess.resources.push({ kind: "web-terminal", target: 1 });
  runtimeProcess.bindings.push({ fd: 1, reference: 0, rightsBase: 1n << 6n, rightsInheriting: 0n });
  try {
    const result = await fixture({
      namespaces: () => ({ guest_extension: { value: () => 0 } }), resolveTerminal: () => writer,
      run({ instance }) { expect(spawnWithFds(instance, [{ parent: 1, child: 1 }])).toBeGreaterThan(0); return 0; },
    }, { module: extensionModule(), runtimeProcess });
    const spawn = result.messages.find(message => message.type === "runtime-proc" && message.operation === "spawn");
    if (spawn?.type !== "runtime-proc" || spawn.operation !== "spawn") throw new Error("missing spawn");
    expect(spawn.transport.resources).toEqual([{ kind: "web-terminal", target: 1 }]);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
  } finally { writer.close(); reader.close(); pipe.dispose(); }
});

test("supplied class streams keep immediate I/O, process capabilities and prototype cleanup", async () => {
  const { PipeController, PipeEndpoint } = await import("../proc/pipes.js");
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read"), writer = pipe.retain(1, "write");
  try {
    const result = await fixture({ stdio: { 1: writer },
      run({ wasi }) {
        const stream = wasi.descriptors.get(1)!.resource as import("../core/descriptors.js").Stream;
        expect(stream).toBeInstanceOf(PipeEndpoint);
        expect(stream.notification).toBeDefined();
        expect(stream.tryWrite?.([new Uint8Array([65])])).toBe(1);
        const child = stream.forProcess!(2);
        expect(child).toBeInstanceOf(PipeEndpoint);
        expect(child.tryWrite?.([new Uint8Array([66])])).toBe(1);
        child.close!();
        return 0;
      },
    });
    expect(result.messages.filter(message => message.type === "exit")).toMatchObject([{ code: 0 }]);
    expect(reader.tryRead([new Uint8Array(2)])).toBe(1);
    expect(reader.tryRead([new Uint8Array(2)])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
  } finally { writer.close(); reader.close(); pipe.dispose(); }
});

for (const mode of ["unchanged", "mutated", "replaced"] as const) test(`imports hook cannot retarget memory used by a real Wasm start section (${mode})`, async () => {
  const a = new WebAssembly.Memory({ initial: 1 }), b = new WebAssembly.Memory({ initial: 1 });
  const guest = guestModule({ namespace: "wasi_snapshot_preview1", name: "environ_sizes_get", params: [127,127],
    importedMemory: true, startSection: true, body: [65,0,65,4,16,0,26] });
  const result = await fixture({
    env: () => ({ A: "b" }), namespaces: () => ({ env: { memory: a } }),
    imports(imports) {
      if (mode === "mutated") imports.env!.memory = b;
      if (mode === "replaced") return { ...imports, env: { memory: b } };
    }, run: () => 0,
  }, { module: guest });
  expect(Array.from(new Uint32Array(a.buffer,0,2))).toEqual(mode === "unchanged" ? [1,4] : [0,0]);
  expect(Array.from(new Uint32Array(b.buffer,0,2))).toEqual([0,0]);
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject(mode === "unchanged"
    ? [{ type: "exit", code: 0 }] : [{ type: "error", code: 126, message: expect.stringContaining("cannot replace imported memory") }]);
});

test("WASI diagnostics follow configured live stderr without recursing through a default terminal", async () => {
  const captured: string[] = [];
  const guest = guestModule({ namespace: "wasi_snapshot_preview1", name: "fd_fdstat_get", params: [127,127], body: [65,1,65,255,255,3,16,0,26] });
  const result = await fixture({ stdio: { 2: { kind: "terminal", read: () => 0,
    write(chunks) { captured.push(new TextDecoder().decode(chunks[0])); return chunks[0]!.length; },
    readiness: () => ({ readable: false, writable: true, hangup: false }) } }, run: () => 0 }, { module: guest });
  expect(captured).toHaveLength(1);
  expect(captured[0]).toContain("[wasi] fd_fdstat_get failed: RangeError");
  expect(result.messages.some(message => message.type === "stderr")).toBe(false);
});

for (const signal of [17, 18, 23, 28]) test(`generic bootstrap default signal ${signal} ignores without revoking the worker`, async () => {
  const result = await fixture({ run(context) {
    context.defaultSignal(signal);
    context.checkActive();
    return 23;
  } });
  expect(result.messages.find(message => message.type === "exit")).toMatchObject({ type: "exit", code: 23 });
  expect(result.messages.some(message => message.type === "default-signal" || message.type === "error")).toBe(false);
});

for (const signal of [19, 20, 21, 22, 32, 33]) test(`generic bootstrap rejects unsupported default signal ${signal} without selecting death`, async () => {
  const result = await fixture({ run(context) {
    expect(() => context.defaultSignal(signal)).toThrow(/signal/);
    context.checkActive();
    return 0;
  } });
  expect(result.messages.find(message => message.type === "exit")).toMatchObject({ type: "exit", code: 0 });
});


test("generic runtime_proc default_signal validates with WASI errno and returns zero for ignored defaults", async () => {
  const result = await fixture({ run({ instance }) {
    const applyDefault = instance.exports.default_signal as (signal: number) => number;
    for (const signal of [17, 18, 23, 28]) expect(applyDefault(signal)).toBe(0);
    for (const signal of [19, 20, 21, 22]) expect(applyDefault(signal)).toBe(-58);
    for (const signal of [0, 32, 33, 65]) expect(applyDefault(signal)).toBe(-28);
    const signal = instance.exports.signal as (signal: number, mode: number) => number;
    expect(signal(15, 2)).toBe(-52); // No signal adapter installed: WASI ENOSYS.
    return 23;
  } }, { module: signalModule() });
  expect(result.messages.find(message => message.type === "exit")).toMatchObject({ code: 23 });
});

test("generic default-ignore action cannot discard an already selected KILL", async () => {
  const outcome = outcomeWord();
  const result = await fixture({ outcome, run(context) {
    claimOutcome(outcome, { kind: "signaled", code: 9 });
    let thrown: unknown;
    try { context.defaultSignal(18); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(RuntimeWorkerSignal);
    expect((thrown as RuntimeWorkerSignal).signal).toBe(9);
    return 0;
  } });
  expect(result.messages.find(message => message.type === "exit")).toMatchObject({ code: 137, signal: 9 });
});

for (const winner of [{ kind: "exited", code: 0 }, { kind: "exited", code: 23 }, { kind: "start-failed", code: 13 }] as const) {
  test(`generic default action preserves existing ${winner.kind} ${winner.code} without signal unwind`, async () => {
    const { WasiExit } = await import("../core/index.js");
    const { waitStatus } = await import("../proc/wait-status.js");
    const runtimeProcess = createWorkerProcessTransport(), state = workerProcessState(runtimeProcess);
    let signalCalls = 0;
    const result = await fixture({ signalError() { signalCalls++; throw new Error("must not signal a non-signaled winner"); },
      run(context) {
        const selected = claimOutcome(state.signals.outcome, winner);
        let thrown: unknown;
        try { context.defaultSignal(18); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(WasiExit);
        expect((thrown as InstanceType<typeof WasiExit>).code).toBe(waitStatus(selected));
        return 0;
      },
    }, { runtimeProcess });
    expect(signalCalls).toBe(0);
    expect(result.messages.find(message => message.type === "exit")).toMatchObject({ code: winner.kind === "start-failed" ? 126 : winner.code, signal: undefined });
  });
}

test("generic bootstrap preview1 polling treats stale process wake hints as advisory", async () => {
  const runtimeProcess = createWorkerProcessTransport(), state = workerProcessState(runtimeProcess);
  Atomics.store(state.signals.interrupt, 0, 17);
  let polled = false;
  const result = await fixture({ run({ wasi, instance }) {
    const view = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
    view.setUint8(8, 0); // An expired clock is ready even though the discarded wake remains.
    view.setUint32(16, 1, true);
    view.setBigUint64(24, 0n, true);
    const poll = (wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }).functions().poll_oneoff!;
    expect(poll(0, 1024, 1, 2048)).toBe(0);
    expect(view.getUint32(2048, true)).toBe(1);
    polled = true;
    return 0;
  } }, { runtimeProcess });
  expect(polled).toBe(true);
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject([{ type: "exit", code: 0 }]);
});


test("executor-only bootstrap polls authoritative signal readiness without consuming delivery", async () => {
  const interrupt = new SharedArrayBuffer(4), requestedSignal = new SharedArrayBuffer(4), outcome = outcomeWord();
  const signals = { interrupt: new Int32Array(interrupt), requestedSignal: new Int32Array(requestedSignal),
    outcome, signalState: createSignalState() };
  let checks = 0;
  const result = await fixture({ interrupt, requestedSignal, outcome,
    interruptPending: () => signalPending(signals),
    run({ wasi, instance, runtimeState }) {
      expect(runtimeState).toBeNull();
      const view = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
      view.setUint8(8, 0);
      view.setUint32(16, 1, true);
      view.setBigUint64(24, 0n, true); // Expired clock.
      const poll = (wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }).functions().poll_oneoff!;
      const clockReady = () => {
        expect(poll(0, 1024, 1, 2048)).toBe(0);
        expect(view.getUint32(2048, true)).toBe(1);
        checks++;
      };
      // A delayed publisher can leave a hint after registration discards delivery.
      Atomics.store(signals.interrupt, 0, 17);
      clockReady(); clockReady();
      setSignalDisposition(signals.signalState, 17, 2, signals.interrupt);
      requestSignal(signals, 17);
      expect(poll(0, 1024, 1, 2048)).toBe(27);
      expect(poll(0, 1024, 1, 2048)).toBe(27); // Readiness must not dequeue it.
      expect(takeSignal(signals.signalState, signals.interrupt)).toBe(17);
      clockReady();
      requestSignal(signals, 17);
      setSignalDisposition(signals.signalState, 17, 0, signals.interrupt);
      Atomics.store(signals.interrupt, 0, 17); // A late advisory rearm is not readiness.
      clockReady();
      return 0;
    },
  });
  expect(checks).toBe(4);
  expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject([{ type: "exit", code: 0 }]);
});

for (const transport of ["interrupt", "requestedSignal", "signal"] as const) {
  test(`executor-owned ${transport} without authoritative readiness fails before setup or guest execution`, async () => {
    let setup = false, ran = false, closed = 0;
    const result = await fixture({
      [transport]: transport === "signal" ? () => 0 : new SharedArrayBuffer(4),
      stdio: { 1: { kind: "terminal", read: () => 0, write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }), close() { closed++; } } },
      setup() { setup = true; },
      run() { ran = true; return 0; },
    });
    expect(setup).toBe(false);
    expect(ran).toBe(false);
    expect(closed).toBe(1);
    expect(result.messages.filter(message => message.type === "exit" || message.type === "error")).toMatchObject([
      { type: "error", code: 126, message: expect.stringContaining("WorkerExecutor.interruptPending is required for executor-owned signal transports") },
    ]);
  });
}
