import { expect, test } from "bun:test";
import { bootstrap, type RuntimeWorkerMessage, type RuntimeWorkerRequest, type WorkerExecutor } from "../browser/worker";
import { BrowserProcessBroker } from "../browser/process-broker";
import { DescriptorTable } from "../core/descriptors";
import { connectFilesystemIdentity, createFilesystemIdentity } from "../fs/protocol";
import { ProcessIdentityAllocator } from "../proc/identity";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessTable } from "../proc/table";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage } from "../proc/worker-client";
import { readOutcome } from "../proc/outcome";
import { failFirstWorkerImport } from "./first-worker-import";

const expectedFailure = { kind: "start-failed", code: 13, error: "EACCES", status: null };
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

async function fixture(module: WebAssembly.Module) {
  const previousWorker = globalThis.Worker;
  const ports: MessagePort[] = [], workers: TestWorker[] = [], failureCalls: string[] = [];
  class TestWorker {
    request!: RuntimeWorkerRequest;
    onmessage?: (event: { data: RuntimeWorkerMessage }) => void;
    onerror?: (event: ErrorEvent) => void;
    constructor() { workers.push(this); }
    postMessage(request: RuntimeWorkerRequest) { this.request = request; }
    terminate() {}
    emit(message: RuntimeWorkerMessage) { this.onmessage?.({ data: message }); }
  }
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "fixture" });
  const broker = new BrowserProcessBroker({ identities, table, registry,
    filesystem: { connect(identity) { const pair = connectFilesystemIdentity(identity); ports.push(pair.client.port, pair.server.port); return pair.client; },
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
    const worker = workers[0]!, transport = worker.request.runtimeProcess!, state = workerProcessState(transport);
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
      }).toEqual({ result: expectedFailure, ready: 0, ran: false, phases: ["worker-start"], failureCalls: ["startFailed"] });
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
  test(`${origin} EACCES survives ${order} dispatch and a late raw errno exit`, async () => {
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
      const rawExits: number[] = [];
      const exit = f.supervisor.exit.bind(f.supervisor);
      f.supervisor.exit = (pid, code) => { if (pid === f.pid) rawExits.push(code); exit(pid, code); };
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
      const expectedExits = (order === "exit-first" ? [13] : []).concat(origin === "after-binding" ? [126] : []);
      expect(rawExits).toEqual(expectedExits);
      f.supervisor.exit(f.pid, 13);
      expect(await f.supervisor.waitForExit(f.parent.pid, f.pid)).toEqual(expectedFailure);
      expect(f.parent.wait(f.parent.pid, f.pid)).toEqual(expectedFailure);
      expect(f.supervisor.waitJob(f.parent.pid, f.state.job)).toEqual(expectedFailure);
      expect(readOutcome(f.state.signals.outcome)).toEqual(expectedFailure);
    } finally { await f.dispose(); }
  });
}
