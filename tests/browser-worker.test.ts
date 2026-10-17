import { expect, test } from "bun:test";
import { bootstrap, RuntimeWorkerSignal, type RuntimeWorkerMessage, type RuntimeWorkerRequest, type WorkerExecutor } from "../browser/worker";
import { createFilesystemConnection, FilesystemService, MemoryBackend } from "../fs";
import { claimOutcome, outcomeWord, readOutcome } from "../proc/outcome";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client";
import { requestSignal, SIGNAL_PENDING } from "../proc/signals";

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
  const result = await Bun.build({ entrypoints: [new URL("../browser/preview1-worker.ts", import.meta.url).pathname], target: "browser", write: false });
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
  let descriptors: import("../core/descriptors").DescriptorTable;
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
    section(1, [3,96,2,127,127,1,127,96,0,1,127,96,0,0]),
    section(2, [2].concat(imported("signal", 0), imported("interrupted", 1))),
    section(3, [1,2]), section(5, [1,0,1]),
    section(7, [4].concat(exported("signal", 0, 0), exported("interrupted", 0, 1), exported("memory", 2, 0), exported("_start", 0, 2))),
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
      expect(Atomics.load(state.signals.signalState, 15) & SIGNAL_PENDING).toBe(interruptible ? SIGNAL_PENDING : 0);
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
