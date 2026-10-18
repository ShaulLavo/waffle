import { expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.js";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI, type ProcessService } from "../proc/abi.js";
import { controlLoad, controlStore } from "../proc/control.js";
import { claimOutcome, markStarted, readOutcome, startStatus } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { ProcessError, type ProcessContext } from "../proc/types.js";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, confirmWorkerProcessJob, type WorkerProcessMessage } from "../proc/worker-client.js";

const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] };
function fixture(options: { quiesce?(): Promise<void>; launch?(context: ProcessContext): void; canConfirmExit?(): boolean; startFailed?(pid: number,error: unknown): void } = {}) {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "preview1" });
  const supervisor = new ProcessSupervisor({ registry, quiesce: options.quiesce, canConfirmExit: options.canConfirmExit, startFailed: options.startFailed, launch(context) { options.launch?.(context); return { terminate() {} }; } });
  const root = supervisor.createRoot(), pid = supervisor.reserveSpawn(root, request);
  const memory = new WebAssembly.Memory({ initial: 1 }), wake = new Int32Array(new SharedArrayBuffer(4));
  function abi(service: ProcessService = supervisor, wait?: (milliseconds: number, word: import("../proc/control.js").ControlCells, expected: number) => void) {
    return new ProcessABI({ memory, wake, descriptors: supervisor.get(root)!.descriptors, fs: new MemFS(), pid: root, signals: supervisor.get(root)!, service, wait });
  }
  return { supervisor, root, pid, memory, wake, abi, dispose: () => supervisor.dispose() };
}

for (const [error, errno] of [["ENOENT",44],["EACCES",2],["ENOTDIR",54],["ENOEXEC",45],["ENOMEM",48],["EAGAIN",6],["EIO",29]] as const) {
  test(`start_status observes ${error} repeatedly before its cleanup fence without collecting`, async () => {
    let release!: () => void;
    const fence = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ quiesce: () => fence }), abi = f.abi();
    try {
      expect(abi.imports.start_status!(f.pid)).toBe(-6);
      f.supervisor.failStart(f.pid, Object.assign(new Error("startup"), { code: error }));
      expect(abi.imports.start_status!(f.pid)).toBe(errno);
      expect(abi.imports.start_status!(f.pid)).toBe(errno);
      expect(f.supervisor.wait(f.root, f.pid)).toBeNull();
      const view = new DataView(f.memory.buffer);
      view.setUint32(0,6,true); view.setUint32(4,f.pid,true);
      expect(abi.imports.poll!(0,1,0,96)).toBe(1);
      expect(abi.imports.start_status!(f.pid)).toBe(errno);
      const finished = f.supervisor.waitForExit(f.root, f.pid);
      release(); await finished;
      expect(abi.imports.start_status!(f.pid)).toBe(errno);
      expect(abi.imports.wait!(f.pid, 64)).toBe(0);
      expect(abi.imports.start_status!(f.pid)).toBe(-12);
    } finally { release(); await fence; f.dispose(); }
  });
}

for (const status of [0,126,127]) test(`entry remains successful after immediate exit ${status}`, async () => {
  const f = fixture({ launch(context) { expect(context.started()).toBe(true); context.exit(status); } }), abi = f.abi();
  try {
    await f.supervisor.start(f.pid);
    expect(abi.imports.start_status!(f.pid)).toBe(0);
    expect(abi.imports.wait!(f.pid, 64)).toBe(0);
    const view = new DataView(f.memory.buffer);
    expect([view.getUint32(64,true),view.getInt32(68,true)]).toEqual([0,status]);
    expect(abi.imports.start_status!(f.pid)).toBe(-12);
  } finally { f.dispose(); }
});

test("launch handle acquisition is not successful entry, and non-child authority matches wait", async () => {
  const f = fixture(), abi = f.abi();
  try {
    await f.supervisor.start(f.pid);
    expect(abi.imports.start_status!(f.pid)).toBe(-6);
    expect(abi.imports.start_status!(f.root)).toBe(-12);
    expect(abi.imports.start_status!(99999)).toBe(-12);
    f.supervisor.kill(f.pid,9);
    expect(f.supervisor.started(f.pid)).toBe(false);
    expect(abi.imports.start_status!(f.pid)).toBe(-11);
    expect(f.supervisor.wait(f.root,f.pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
  } finally { f.dispose(); }
});

test("a host failure racing entry is an ordinary execution failure, not a late spawn error", () => {
  const diagnostics: unknown[] = [];
  const f = fixture({startFailed(_pid,error) { diagnostics.push(error); }}), original = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
    const outcome = f.supervisor.get(f.pid)!.outcome;
    if (!raced && array.buffer === outcome.buffer && (replacement & 3n) === 3n) {
      raced = true;
      expect(f.supervisor.started(f.pid)).toBe(true);
    }
    return original(array,index,expected,replacement);
  }) as typeof Atomics.compareExchange;
  try { f.supervisor.failStart(f.pid,new Error("host failed during handoff")); }
  finally { Atomics.compareExchange = original; }
  try {
    expect(raced).toBe(true);
    expect(diagnostics).toEqual([]);
    expect(f.supervisor.startStatus(f.root,f.pid)).toBe(0);
    expect(f.supervisor.wait(f.root,f.pid)).toEqual({ kind: "exited", code: 126, status: 126 });
  } finally { f.dispose(); }
});

for (const at of ["scan", "wait"] as const) test(`CHILD_START is level-triggered and cannot lose a publication during ${at}`, () => {
  const f = fixture();
  let raced = false, waits = 0;
  const service = Object.create(f.supervisor) as ProcessService;
  service.startStatus = (parent,pid) => {
    const status = f.supervisor.startStatus(parent,pid);
    if (at === "scan" && !raced) { raced = true; f.supervisor.started(pid); }
    return status;
  };
  const abi = f.abi(service, (_milliseconds,word,expected) => {
    waits++;
    if (at === "wait" && !raced) { raced = true; f.supervisor.started(f.pid); }
    // Atomics.wait observes a changed sequence and returns not-equal, never sleeps.
    expect(controlLoad(word,0)).not.toBe(expected);
  });
  const view = new DataView(f.memory.buffer);
  view.setUint32(0,6,true); view.setUint32(4,f.pid,true); view.setBigUint64(8,42n,true);
  try {
    expect(abi.imports.poll!(0,1,-1,64)).toBe(1);
    expect({raced,waits}).toEqual({raced:true,waits:1});
    expect([view.getBigUint64(64,true),view.getUint32(72,true),view.getUint32(76,true)]).toEqual([42n,6,0]);
    expect(abi.imports.poll!(0,1,0,64)).toBe(1);
    f.supervisor.exit(f.pid,23);
    expect(abi.imports.poll!(0,1,0,64)).toBe(1);
    expect(abi.imports.start_status!(f.pid)).toBe(0);
    expect(abi.imports.wait!(f.pid,96)).toBe(0);
    expect(abi.imports.poll!(0,1,0,64)).toBe(-12);
  } finally { f.dispose(); }
});

test("a reused process slot rejects stale startup read, mark and claim without affecting its successor", () => {
  const root = createWorkerProcessTransport({capacity:2}), descriptors = new DescriptorTable(), notices: WorkerProcessMessage[] = [];
  const codec = { export() { throw new Error("unused"); }, import() { throw new Error("unused"); }, discard() {} };
  const parent = new WorkerProcessClient({transport:root,descriptors,codec,postMessage: message => notices.push(message)});
  const childDescriptors = new DescriptorTable();
  try {
    const pid = parent.spawn(parent.pid,request), oldTransport = notices.find(message => message.operation === "spawn")!.transport;
    const state = workerProcessState(oldTransport), child = new WorkerProcessClient({transport:oldTransport,descriptors:childDescriptors,codec,postMessage() {}});
    expect(parent.startStatus(parent.pid,pid)).toBe(-6);
    const before = controlLoad(parent.wake,0);
    expect(child.started()).toBe(true);
    expect(controlLoad(parent.wake,0)).toBeGreaterThan(before);
    expect(parent.startStatus(parent.pid,pid)).toBe(0);
    expect(readOutcome(state.signals.outcome)).toBeNull();
    child.exit(127); controlStore(state.confirmed,0,1); confirmWorkerProcessJob(oldTransport);
    expect(parent.wait(parent.pid,pid)).toEqual({kind:"exited",code:127,status:127});
    parent.waitJob(parent.pid,state.job);
    const next = parent.spawn(parent.pid,request), nextTransport = notices.filter(message => message.operation === "spawn").at(-1)!.transport;
    expect(nextTransport.slot).toBe(oldTransport.slot);
    expect(next).not.toBe(pid);
    expect(parent.startStatus(parent.pid,next)).toBe(-6);
    for (const operation of [() => startStatus(state.signals.outcome), () => markStarted(state.signals.outcome), () => claimOutcome(state.signals.outcome,{kind:"exited",code:42})]) {
      expect(operation).toThrow(ProcessError);
    }
    expect(() => parent.startStatus(parent.pid,pid)).toThrow(ProcessError);
    expect(parent.startStatus(parent.pid,next)).toBe(-6);
  } finally { childDescriptors.dispose(); descriptors.dispose(); }
});

test("Wasi entry callback runs after memory setup, directly before _start", () => {
  const fs = new MemFS(), order: string[] = [];
  const wasi = new Wasi({args:[],env:{},fs,preopens:{},stdout() {},stderr() {}});
  const memory = new WebAssembly.Memory({initial:1});
  try {
    const instance = {exports:{memory,_start() { order.push("entry"); }}} as unknown as WebAssembly.Instance;
    expect(wasi.start(instance,() => { order.push("commit"); })).toBe(0);
    expect(order).toEqual(["commit","entry"]);
    const invalid = {exports:{_start() { throw new Error("must not run"); }}} as unknown as WebAssembly.Instance;
    expect(() => wasi.start(invalid,() => order.push("bad commit"))).toThrow("memory");
    const missingStart = {exports:{memory}} as unknown as WebAssembly.Instance;
    expect(() => wasi.start(missingStart,() => order.push("bad commit"))).toThrow("_start");
    const freshMemory = new WebAssembly.Memory({initial:1});
    const allocation = WeakMap.prototype.set;
    let failed: unknown;
    WeakMap.prototype.set = function(key: object, value: unknown) {
      if (key === freshMemory) throw new RangeError("memory view setup failed");
      return allocation.call(this,key,value);
    };
    try {
      wasi.start({exports:{memory:freshMemory,_start() {}}} as unknown as WebAssembly.Instance,() => order.push("bad commit"));
    } catch (error) { failed = error; }
    finally { WeakMap.prototype.set = allocation; }
    expect(failed).toBeInstanceOf(RangeError);
    expect((failed as Error).message).toBe("memory view setup failed");
    expect(order).toEqual(["commit","entry"]);
  } finally { wasi.descriptors.dispose(); }
});

for (const winner of ["failed-executor", "guest-exit"] as const) test(`post-entry host failure fences ${winner} without discarding the real exit acknowledgement gate`, async () => {
  let fenced = 0, acknowledge = false, raced = false;
  const f = fixture({canConfirmExit:() => acknowledge, quiesce: async () => { fenced++; }, launch(context) { context.started(); throw new Error("launcher rejected after entry"); }});
  const original = Atomics.compareExchange;
  Atomics.compareExchange = ((array: BigInt64Array,index: number,expected: bigint,replacement: bigint) => {
    const outcome = f.supervisor.get(f.pid)!.outcome;
    if (winner === "guest-exit" && !raced && array.buffer === outcome.buffer && (replacement & 3n) === 1n) {
      raced = true; claimOutcome(outcome,{kind:"exited",code:42});
    }
    return original(array,index,expected,replacement);
  }) as typeof Atomics.compareExchange;
  try { await f.supervisor.start(f.pid); }
  finally { Atomics.compareExchange = original; }
  try {
    expect(f.supervisor.startStatus(f.root,f.pid)).toBe(0);
    if (winner === "guest-exit") {
      expect(raced).toBe(true);
      expect(fenced).toBe(0);
      expect(f.supervisor.get(f.pid)!.revoked).toBe(false);
      expect(f.supervisor.wait(f.root,f.pid)).toBeNull();
      acknowledge = true; f.supervisor.exit(f.pid,42);
    }
    const result = await f.supervisor.waitForExit(f.root,f.pid);
    expect(fenced).toBe(1);
    expect(result).toEqual({kind:"exited",code:winner === "guest-exit" ? 42 : 126,status:winner === "guest-exit" ? 42 : 126});
  } finally { f.dispose(); }
});

for (const adapter of ["worker", "supervisor"] as const) for (const operation of ["query", "poll"] as const) test(`${adapter} ${operation} reports ECHILD when another observer collects during its outcome read`, () => {
  const transport = createWorkerProcessTransport(), descriptors = new DescriptorTable(), notices: WorkerProcessMessage[] = [];
  const codec = {export() {throw new Error("unused");},import() {throw new Error("unused");},discard() {}};
  const parent = new WorkerProcessClient({transport,descriptors,codec,postMessage:message => notices.push(message)});
  const pid = parent.spawn(parent.pid,request), childTransport = notices.find(message => message.operation === "spawn")!.transport, state = workerProcessState(childTransport);
  const registry = new ExecutableRegistry(), supervisor = new ProcessSupervisor({registry,launch() {throw new Error("unused");}});
  supervisor.createRoot({pid:parent.pid});
  supervisor.reserveAdmittedSpawn(parent.pid,request,{pid,outcome:state.signals.outcome});
  claimOutcome(state.signals.outcome,{kind:"exited",code:0});
  controlStore(state.confirmed,0,1); confirmWorkerProcessJob(childTransport);
  const service = adapter === "worker" ? parent : supervisor;
  const memory = new WebAssembly.Memory({initial:1});
  const abi = new ProcessABI({memory,descriptors,fs:new MemFS(),pid:parent.pid,signals:parent.signals,service});
  const view = new DataView(memory.buffer); view.setUint32(0,6,true); view.setUint32(4,pid,true);
  const original = Atomics.load;
  let raced = false;
  Atomics.load = ((array: BigInt64Array,index: number) => {
    if (!raced && array.buffer === state.signals.outcome.buffer && array.byteOffset === state.signals.outcome.byteOffset) {
      raced = true; expect(parent.wait(parent.pid,pid)).toEqual({kind:"exited",code:0,status:0});
    }
    return original(array,index);
  }) as typeof Atomics.load;
  try { expect(operation === "query" ? abi.imports.start_status!(pid) : abi.imports.poll!(0,1,0,64)).toBe(-12); }
  finally { Atomics.load = original; }
  try { expect(raced).toBe(true); }
  finally { supervisor.dispose(); descriptors.dispose(); }
});
