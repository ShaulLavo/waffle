import { expect, test } from "bun:test";
import { bootstrap, type RuntimeWorkerMessage, type RuntimeWorkerRequest, type WorkerExecutor } from "../browser/worker.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { DescriptorTable } from "../core/descriptors.js";
import { connectFilesystemIdentity, createFilesystemIdentity } from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage } from "../proc/worker-client.js";
import { readOutcome } from "../proc/outcome.js";
import { failFirstWorkerImport } from "./first-worker-import.js";

const expectedFailure = { kind: "start-failed", code: 5, error: "EIO", status: null };
type Shape = "valid" | "missing-start" | "invalid-start" | "missing-memory" | "invalid-memory";
function guest(shape: Shape): WebAssembly.Module {
  const text = (name: string) => [name.length].concat(Array.from(new TextEncoder().encode(name)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const startExport = shape === "missing-start" ? [] : text("_start").concat([shape === "invalid-start" ? 3 : 0, 0]);
  const memoryExport = shape === "missing-memory" ? [] : text("memory").concat([shape === "invalid-memory" ? 3 : 2, 0]);
  const exports = startExport.concat(memoryExport);
  const globals = shape === "invalid-start" || shape === "invalid-memory" ? section(6, [1, 0x7f, 0, 0x41, 0, 0x0b]) : [];
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [1, 0x60, 0, 0]), section(3, [1, 0]), section(5, [1, 0, 1]), globals,
    section(7, [shape === "missing-start" || shape === "missing-memory" ? 1 : 2].concat(exports)),
    section(10, [1, 2, 0, 0x0b]),
  );
  return new WebAssembly.Module(new Uint8Array(bytes));
}

async function fixture(module: WebAssembly.Module, failure?: { at: "connect" | "construct" | "post"; error: unknown }) {
  const previousWorker = globalThis.Worker;
  const ports: MessagePort[] = [], workers: TestWorker[] = [], failureCalls: string[] = [];
  class TestWorker {
    request!: RuntimeWorkerRequest;
    onmessage?: (event: { data: RuntimeWorkerMessage }) => void;
    onerror?: (event: ErrorEvent) => void;
    constructor() { if (failure?.at === "construct") throw failure.error; workers.push(this); }
    postMessage(request: RuntimeWorkerRequest) { if (failure?.at === "post") throw failure.error; this.request = request; }
    terminate() {}
    emit(message: RuntimeWorkerMessage) { this.onmessage?.({ data: message }); }
  }
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "fixture" });
  const broker = new BrowserProcessBroker({ identities, table, registry,
    filesystem: { connect(identity) { if (failure?.at === "connect") throw failure.error; const pair = connectFilesystemIdentity(identity); ports.push(pair.client.port, pair.server.port); return pair.client; },
      revoke() {}, reap() {}, async quiesce() {} },
    launch(context) {
      return broker.launchWorker({ ...context,
        fail(error) { failureCalls.push("fail"); context.fail(error); },
        startFailed(error) { failureCalls.push("startFailed"); context.startFailed(error); },
      }, { workerUrl: "http://localhost/fixture.js", request: { module, args: [], env: {} } });
    },
  });
  const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const descriptors = new DescriptorTable(), notices: WorkerProcessMessage[] = [];
  const codec = { export() { throw new Error("no inherited descriptors"); }, import() { throw new Error("no inherited descriptors"); }, discard() {} };
  const parent = new WorkerProcessClient({ transport: root, descriptors, codec, postMessage(message) { notices.push(message); },
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }) });
  async function dispose() {
    globalThis.Worker = previousWorker;
    try { descriptors.dispose(); await broker.dispose(); } finally { for (const port of ports) port.close(); }
  }
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    await broker.adoptRuntimeRoot(root);
    const pid = parent.spawn(parent.pid, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    for (const notice of notices) await broker.runtimeMessage(notice, parent.pid);
    const supervisor = await broker.ready();
    await supervisor.start(pid);
    const worker = workers[0]!, transport = notices.find(message => message.operation === "spawn")!.transport, state = workerProcessState(transport);
    const childDescriptors = new DescriptorTable();
    const childNotices: WorkerProcessMessage[] = [];
    const child = new WorkerProcessClient({ transport, descriptors: childDescriptors, codec,
      postMessage(message) { childNotices.push(message); } });
    return { broker, supervisor, parent, child, childNotices, worker, state, pid, failureCalls,
      dispose: async () => { childDescriptors.dispose(); await dispose(); } };
  } catch (error) { await dispose(); throw error; }
}

async function runWorker(request: RuntimeWorkerRequest, executor: Partial<WorkerExecutor> = {}) {
  const messages: RuntimeWorkerMessage[] = [];
  await bootstrap(request, {
    run() { return 0; }, ...executor,
    setup(context) {
      context.fs.preopen = () => 1;
      context.fs.retain = () => {};
      context.fs.release = () => {};
      executor.setup?.(context);
    },
  }, { crossOriginIsolated: true, postMessage(message) { messages.push(message); } });
  return messages;
}

for (const shape of ["missing-start", "invalid-start", "missing-memory", "invalid-memory"] as const) {
  test(`unrunnable ${shape} never advertises instantiation or invokes the ready hook`, async () => {
    const f = await fixture(guest(shape));
    let ready = 0, ran = false;
    try {
      const messages = await runWorker(f.worker.request, { instantiated() { ready++; }, run() { ran = true; return 0; } });
      expect(messages.find(message => message.type === "error")).toMatchObject({
        type: "error", code: 126, message: expect.stringContaining(shape.endsWith("start") ? "_start" : "memory"),
      });
      for (const message of messages) {
        if (message.type === "runtime-proc") await f.broker.runtimeMessage(message, f.pid);
        else f.worker.emit(message);
      }
      const result = await f.supervisor.waitForExit(f.parent.pid, f.pid);
      expect({ result, ready, ran,
        phases: messages.filter(message => message.type === "phase").map(message => message.name),
        failureCalls: f.failureCalls,
      }).toEqual({ result: { kind: "start-failed", code: 8, error: "ENOEXEC", status: null }, ready: 0, ran: false, phases: ["worker-start"], failureCalls: ["startFailed"] });
    } finally { await f.dispose(); }
  });
}

test("a runnable guest still advertises readiness and completes with its ordinary exit", async () => {
  const f = await fixture(guest("valid"));
  let ready = 0, ran = false;
  try {
    const messages = await runWorker(f.worker.request, { instantiated() { ready++; }, run() { ran = true; return 23; } });
    for (const message of messages) {
      if (message.type === "runtime-proc") await f.broker.runtimeMessage(message, f.pid);
      else f.worker.emit(message);
    }
    expect(await f.supervisor.waitForExit(f.parent.pid, f.pid)).toEqual({ kind: "exited", code: 23, status: 23 });
    expect({ ready, ran, phases: messages.filter(message => message.type === "phase").map(message => message.name) })
      .toEqual({ ready: 1, ran: true, phases: ["worker-start", "instantiate"] });
    expect(f.failureCalls).toEqual([]);
  } finally { await f.dispose(); }
});

for (const origin of ["first-import", "after-binding"] as const) for (const order of ["exit-first", "error-first"] as const) {
  test(`${origin} EIO survives ${order} dispatch and a late raw errno exit`, async () => {
    const f = await fixture(guest("valid"));
    try {
      let messages: RuntimeWorkerMessage[] = [];
      if (origin === "first-import") await failFirstWorkerImport(f.worker.request, message => messages.push(message));
      else messages = await runWorker(f.worker.request, { instantiated() { throw new Error("bootstrap hook failed"); } });
      const exits = messages.filter(message => message.type === "runtime-proc" && message.operation === "exit");
      expect(exits).toHaveLength(origin === "first-import" ? 0 : 1);
      expect(readOutcome(f.state.signals.outcome)).toEqual(expectedFailure);
      for (const message of messages) if (message.type === "phase") f.worker.emit(message);
      const terminal = messages.find(message => message.type === "error")!;
      expect(terminal).toMatchObject({ type: "error", code: 126 });
      f.child.exit(126);
      expect(readOutcome(f.state.signals.outcome)).toEqual(expectedFailure);
      expect(f.supervisor.wait(f.parent.pid, f.pid)).toBeNull();
      const exitNotice = exits[0] ?? f.childNotices[0]!;
      if (order === "error-first") {
        f.worker.emit(terminal);
        expect(await f.supervisor.waitForExit(f.parent.pid, f.pid)).toEqual(expectedFailure);
        await f.broker.runtimeMessage(exitNotice as WorkerProcessMessage, f.pid);
      } else {
        await f.broker.runtimeMessage(exitNotice as WorkerProcessMessage, f.pid);
        expect(await f.supervisor.waitForExit(f.parent.pid, f.pid)).toEqual(expectedFailure);
        f.worker.emit(terminal);
      }
      f.supervisor.exit(f.pid, 13);
      expect(await f.supervisor.waitForExit(f.parent.pid, f.pid)).toEqual(expectedFailure);
      const beforeCollection = readOutcome(f.state.signals.outcome);
      expect(f.parent.wait(f.parent.pid, f.pid)).toEqual(expectedFailure);
      expect(f.supervisor.waitJob(f.parent.pid, f.state.job)).toEqual(expectedFailure);
      expect(beforeCollection).toEqual(expectedFailure);
      expect(Object.isFrozen(beforeCollection)).toBe(true);
      expect(() => readOutcome(f.state.signals.outcome)).toThrow("collected");
      expect(() => f.worker.onerror?.({ preventDefault() {}, message: "late collected worker error" } as ErrorEvent)).not.toThrow();
    } finally { await f.dispose(); }
  });
}

for (const at of ["connect", "construct", "post", "event"] as const) {
  for (const [cause, error, name, code] of [
    ["host failure", new Error("injected setup failure"), "EIO", 5],
    ["allocation", new RangeError("injected allocation failure"), "ENOMEM", 12],
    ["capacity", Object.assign(new Error("setup full"), { code: "EAGAIN" }), "EAGAIN", 11],
  ] as const) test(`${at} ${cause} after PID reservation is an honest startup error`, async () => {
    const f = await fixture(guest("valid"), at === "event" ? undefined : { at, error });
    try {
      expect(f.pid).toBeGreaterThan(0);
      if (at === "event") f.worker.onerror!({ preventDefault() {}, message: error.message, error } as ErrorEvent);
      const expected = { kind: "start-failed", error: name, code, status: null };
      expect(await f.supervisor.waitForExit(f.parent.pid, f.pid)).toEqual(expected);
      expect(f.parent.wait(f.parent.pid, f.pid)).toEqual(expected);
      expect(f.parent.waitJob(f.parent.pid, f.state.job)).toEqual(expected);
    } finally { await f.dispose(); }
  });
}

test("allocation failure during Wasm instantiation stays typed ENOMEM", async () => {
  const f = await fixture(guest("valid")), previous = WebAssembly.Instance;
  try {
    WebAssembly.Instance = new Proxy(previous, { construct() { throw new RangeError("Wasm memory allocation failed"); } });
    const messages = await runWorker(f.worker.request);
    expect(messages.find(message => message.type === "error")).toMatchObject({ errno: "ENOMEM" });
    for (const message of messages) {
      if (message.type === "runtime-proc") await f.broker.runtimeMessage(message, f.pid);
      else f.worker.emit(message);
    }
    expect(await f.supervisor.waitForExit(f.parent.pid, f.pid)).toEqual({ kind: "start-failed", error: "ENOMEM", code: 12, status: null });
  } finally { WebAssembly.Instance = previous; await f.dispose(); }
});

test("late worker error collection between message reads cannot escape its handler", async () => {
  const f = await fixture(guest("valid"));
  try {
    f.supervisor.kill(f.pid,9);
    await f.supervisor.waitForExit(f.parent.pid,f.pid);
    const filesystem = (f.broker as unknown as {options:{filesystem:{reap(identity:unknown):void}}}).options.filesystem;
    const reap = filesystem.reap;
    let collected = false;
    filesystem.reap = identity => {
      reap(identity);
      expect(f.parent.wait(f.parent.pid,f.pid)).toMatchObject({kind:"signaled",code:9});
      collected = true;
    };
    try { expect(() => f.worker.emit({type:"error",code:126,message:"late worker error"})).not.toThrow(); }
    finally { filesystem.reap = reap; }
    expect(collected).toBe(true);
  } finally { await f.dispose(); }
});
