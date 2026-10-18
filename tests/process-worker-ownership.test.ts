import { ProcessABI } from "../proc/abi.js";
import { MemFS } from "../fs/memory.js";
import { collectDirectoryProcess, collectDirectoryJob, directorySlots, directoryJobs, directoryJob, directoryProcesses, directoryGroups, findDirectoryJob, helpDirectoryJobs, reserveDirectoryProcess } from "../proc/directory.js";
import { packedControl, controlLoad, controlStore, controlCas, controlExchange, controlAdd } from "../proc/control.js";
import { afterEach, expect, test } from "bun:test";
import { DescriptorTable, OpenDescription, type Descriptor, type Resource, type Stream } from "../core/descriptors.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { SignalDisposition, setSignalDisposition } from "../proc/signals.js";
import { claimOutcome, readOutcome } from "../proc/outcome.js";
import { WorkerProcessBroker } from "../proc/worker-broker.js";
import { createWorkerProcessTransport, confirmWorkerProcessJob, installWorkerBindings, WorkerProcessClient, workerProcessState, type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport } from "../proc/worker-client.js";
import { WorkerPipeHost, createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { ProcessErrno, ProcessError, type ProcessContext, type ProcessHandle, type SpawnRequest } from "../proc/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({ executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job: 0, fds: [], ...overrides });
function expectErrno(operation: () => unknown, errno: number): void {
  let error: unknown;
  try { operation(); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ name: "ProcessError", errno });
}
interface Token { state: SharedArrayBuffer; lifetime: SharedArrayBuffer; pid: number; kind: "pipe" | "directory" }
function fakeCodec() {
  const states = new WeakMap<Resource, SharedArrayBuffer>();
  const release = (token: Token) => {
    if (controlCas(new Int32Array(token.lifetime), 0, 0, 1) !== 0) return;
    const state = new Int32Array(token.state);
    Atomics.sub(state, 0, 1); Atomics.add(state, 1, 1);
  };
  const resource = (token: Token): Resource => {
    const value: Resource = token.kind === "directory" ? { kind: "directory", handle: 42 } : {
      kind: "pipe", read: () => 0, write: chunks => chunks.reduce((n, chunk) => n + chunk.length, 0),
      readiness: () => ({ readable: true, writable: true, hangup: false }),
      forProcess: () => value as Stream,
      revoke: () => { Atomics.add(new Int32Array(token.state), 2, 1); },
      close: () => release(token),
    };
    states.set(value, token.state);
    return value;
  };
  const codec: WorkerDescriptorCodec = {
    export(source: Descriptor, pid: number) {
      const state = states.get(source.resource);
      if (!state) throw new Error("unknown resource");
      Atomics.add(new Int32Array(state), 0, 1);
      return { state, pid, lifetime: new SharedArrayBuffer(4), kind: source.resource.kind } satisfies Token;
    },
    import(value) {
      const token = value as Token;
      return new OpenDescription(resource(token), () => release(token));
    },
    discard(value) { release(value as Token); },
  };
  return { codec, source(descriptors: DescriptorTable, kind: Token["kind"] = "pipe") {
    const state = new SharedArrayBuffer(12);
    controlStore(new Int32Array(state), 0, 1);
    const token = { state, lifetime: new SharedArrayBuffer(4), pid: 1, kind };
    const fd = descriptors.open(resource(token), 127n, 63n, () => release(token));
    return { fd, counts: new Int32Array(state) };
  } };
}
function fixture(options: { capacity?: number; launch?(context: ProcessContext): ProcessHandle | Promise<ProcessHandle>; activate?: (supervisor: ProcessSupervisor) => Promise<ProcessSupervisor>; beforeActivation?(supervisor: ProcessSupervisor): void; terminate?(): void | Promise<void>; quiesce?(pid: number): void | Promise<void>; rejectedQuiesce?(pid: number): void | Promise<void> } = {}) {
  const transport = createWorkerProcessTransport({ capacity: options.capacity });
  const state = workerProcessState(transport);
  const registry = new ExecutableRegistry(); registry.register("fixture", { module: emptyModule, adapter: "preview1" });
  const contexts = new Map<number, ProcessContext>();
  const supervisor = new ProcessSupervisor({ registry, quiesce: options.quiesce, launch(context) { contexts.set(context.pid, context); return options.launch?.(context) ?? { terminate() { return options.terminate?.(); } }; } });
  supervisor.createRoot({ pid: state.pid, job: state.job, ...state.signals });
  options.beforeActivation?.(supervisor);
  const { codec, source } = fakeCodec();
  const messages: WorkerProcessMessage[] = [];
  const revoked: number[] = [];
  const broker = new WorkerProcessBroker({ supervisor: () => options.activate?.(supervisor) ?? Promise.resolve(supervisor), codec, quiesce: options.rejectedQuiesce });
  broker.adoptRoot(transport);
  cleanups.push(() => { broker.dispose(); supervisor.dispose(); });
  const client = (value: WorkerProcessTransport) => {
    const descriptors = new DescriptorTable(); cleanups.push(() => descriptors.dispose());
    return new WorkerProcessClient({ transport: value, descriptors, codec,
      postMessage(message) { messages.push(structuredClone(message)); },
      revokeProcess(pid) { revoked.push(pid); },
    });
  };
  const root = client(transport);
  return { transport, root, broker, supervisor, contexts, messages, source, client, codec, revoked,
    async flush() { while (messages.length) await broker.handle(messages.shift()!); },
  };
}

test("worker spawn synchronously retains arbitrary bindings across lazy activation and immediate parent close", async () => {
  let activate!: (supervisor: ProcessSupervisor) => void;
  const loading = new Promise<ProcessSupervisor>(resolve => { activate = resolve; });
  const f = fixture({ activate: () => loading });
  const { fd, counts } = f.source(f.root.options.descriptors, "directory");
  const pid = f.root.spawn(1, request({ fds: [{ child: 19, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  expect(counts[0]).toBe(1);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(f.contexts.size).toBe(0);
  const admitted = f.flush();
  activate(f.supervisor);
  await admitted; await f.supervisor.start(pid);
  expect(f.contexts.get(pid)!.descriptors.get(19)!.resource.kind).toBe("directory");
  const child = f.client(structuredClone(f.broker.get(pid)!)); child.installBindings();
  expect(child.options.descriptors.get(19)!.rightsBase).toBe(127n);
  expect(child.options.descriptors.get(19)!.description.references).toBe(1);
  child.exit(7);
  expect(f.root.wait(1, pid)).toBeNull();
  await f.flush();
  expect(f.root.wait(1, pid)).toEqual({ kind: "exited", code: 7, status: 7 });
  expect(counts[0]).toBe(0);
  expect(counts[1]).toBe(2);
});

test("spawned pipe writers survive parent exit before the child worker starts", () => {
  const transport = createWorkerProcessTransport({ capacity: 16 });
  const spawnMessages: WorkerProcessMessage[] = [];
  const pipes = new WorkerPipeHost({ transport, postMessage() {} });
  const [reader, writer] = pipes.createPipe();
  const rootDescriptors = new DescriptorTable();
  const readFd = rootDescriptors.open(reader, 1n, 1n), writeFd = rootDescriptors.open(writer, 1n, 1n);
  const codec = createWorkerPipeCodec();
  const root = new WorkerProcessClient({ transport, descriptors: rootDescriptors, codec, postMessage(message) { spawnMessages.push(message); }, prepareSpawn(pid) { pipes.registry.registerProcess(pid); return { cancel: () => pipes.registry.collectProcess(pid) }; } });
  try {
    // The root launches a leader, which is the parent whose worker will exit before its child
    // starts. The root reader remains alive as an observer of the leader's inherited writer.
    const leaderPid = root.spawn(1, request({ job: -1, fds: [{ child: 1, parent: writeFd }] }));
    const leaderTransport = spawnMessages[0]!.transport;
    const leaderDescriptors = new DescriptorTable();
    try {
      const leader = new WorkerProcessClient({ transport: leaderTransport, descriptors: leaderDescriptors, codec, postMessage(message) { spawnMessages.push(message); }, prepareSpawn(pid) { pipes.registry.registerProcess(pid); return { cancel: () => pipes.registry.collectProcess(pid) }; } });
      leader.installBindings();
      rootDescriptors.close(writeFd);
      const childPid = leader.spawn(leaderPid, request({ job: workerProcessState(leaderTransport).job, fds: [{ child: 1, parent: 1 }] }));
      expect(childPid).toBeGreaterThan(leaderPid);
      // Parent exit closes its descriptor only after spawn returned; the child reservation already
      // owns a distinct writer ring, so the observer must see AGAIN rather than premature EOF.
      leaderDescriptors.dispose();
      const pending = new Uint8Array(1);
      expect(reader.tryRead([pending])).toBe(-6);
      const childTransport = spawnMessages[1]!.transport;
      const childDescriptors = new DescriptorTable();
      try {
        expect(workerProcessState(childTransport).pid).toBe(childPid);
        installWorkerBindings(childTransport, childDescriptors, codec);
        childDescriptors.close(1);
      } finally { childDescriptors.dispose(); }
      expect(reader.tryRead([pending])).toBe(0);
    } finally { leaderDescriptors.dispose(); }
  } finally {
    rootDescriptors.close(readFd);
    rootDescriptors.dispose();
  }
});

test("worker spawn validates both fd bindings within the signed WASM success range before exporting", async () => {
  const f = fixture();
  const table = f.root.options.descriptors;
  const { fd, counts } = f.source(table);
  for (const invalid of [0x80000000, 0xffffffff, -1, 1.5, NaN]) {
    for (const binding of [{ child: invalid, parent: fd }, { child: 3, parent: invalid }]) {
      let error: unknown;
      try { f.root.spawn(1, request({ fds: [binding] })); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ name: "ProcessError", errno: 28 });
      expect(counts[0]).toBe(1);
      expect(f.messages.length).toBe(0);
    }
  }
  table.inherit(0x7fffffff, table.get(fd)!);
  const pid = f.root.spawn(1, request({ fds: [{ child: 0x7fffffff, parent: 0x7fffffff }] }));
  await f.flush();
  const child = f.client(f.broker.get(pid)!); child.installBindings();
  const duplicate = child.options.descriptors.dup(0x7fffffff);
  expect(duplicate).toBeGreaterThanOrEqual(0);
  expect(duplicate).toBeLessThanOrEqual(0x7fffffff);
  expect(child.options.descriptors.get(duplicate)!.description).toBe(child.options.descriptors.get(0x7fffffff)!.description);
});

test("duplicate inherited bindings share one exported lifetime and one child description", async () => {
  const f = fixture();
  const { fd, counts } = f.source(f.root.options.descriptors);
  const alias = f.root.options.descriptors.dup(fd);
  const pid = f.root.spawn(1, request({ fds: [{ child: 4, parent: fd }, { child: 77, parent: alias }] }));
  expect(f.messages[0]!.transport.resources.length).toBe(1);
  f.root.options.descriptors.close(fd); f.root.options.descriptors.close(alias);
  expect(counts[0]).toBe(1);
  await f.flush(); await f.supervisor.start(pid);
  const child = f.client(structuredClone(f.broker.get(pid)!)); child.installBindings();
  const table = child.options.descriptors;
  expect(table.get(4)!.description).toBe(table.get(77)!.description);
  table.close(4); expect(counts[0]).toBe(1);
  table.close(77); expect(counts[0]).toBe(0);
  child.exit(0); await f.flush();
  expect(counts[1]).toBe(2);
});

test("fatal selection freezes resources synchronously but wait stays pending until broker revocation completes", async () => {
  const f = fixture();
  const { fd } = f.source(f.root.options.descriptors);
  const pid = f.root.spawn(1, request({ fds: [{ child: 1, parent: fd }] }));
  await f.flush(); await f.supervisor.start(pid);
  const state = workerProcessState(f.broker.get(pid)!);
  const before = controlLoad(f.root.wake, 0);
  f.root.kill(pid, 9);
  expect(f.revoked).toEqual([pid]);
  expect(readOutcome(state.signals.outcome)?.status).toBe(137);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(controlLoad(f.root.wake, 0)).toBeGreaterThan(before);
  await f.flush();
  expect(f.root.wait(1, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
  expect(controlLoad(state.confirmed, 0)).toBe(1);
});

test("handled and ignored signals preserve resource authority and share the disposition state", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(pid);
  const child = f.client(f.broker.get(pid)!);
  setSignalDisposition(child.signals.signalState, 15, SignalDisposition.HANDLE);
  f.root.kill(pid, 15); expect(f.revoked).toEqual([]);
  expect(controlLoad(child.signals.signalState, 15)).toBe(SignalDisposition.HANDLE | 4);
  setSignalDisposition(child.signals.signalState, 2, SignalDisposition.IGNORE);
  f.root.kill(pid, 2); expect(f.revoked).toEqual([]);
  await f.flush(); expect(f.root.wait(1, pid)).toBeNull();
  child.exit(23); await f.flush();
  expect(f.root.wait(1, pid)?.code).toBe(23);
});

test("a kill before lazy activation prevents launch and releases all inherited endpoint refs", async () => {
  const f = fixture();
  const { fd, counts } = f.source(f.root.options.descriptors);
  const pid = f.root.spawn(1, request({ fds: [{ child: 8, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  f.root.kill(pid, 9);
  expect(f.root.wait(1, pid)).toBeNull();
  await f.flush(); await f.supervisor.start(pid);
  expect(f.contexts.has(pid)).toBe(false);
  expect(f.root.wait(1, pid)?.status).toBe(137);
  expect(counts[0]).toBe(0);
});

test("worker authority permits self and descendants but not sibling processes or unowned jobs", async () => {
  const f = fixture();
  const a = f.root.spawn(1, request()), b = f.root.spawn(1, request());
  await f.flush();
  const child = f.client(f.broker.get(a)!);
  expect(() => child.kill(b, 9)).toThrow("ancestry");
  expect(() => child.killJob(f.root.jobOf(b), 9)).toThrow("not owned");
  const grandchild = child.spawn(a, request({ job: child.job }));
  await f.flush();
  expect(child.canSignal(a, grandchild)).toBe(true);
  expect(f.root.canSignal(1, grandchild)).toBe(true);
  f.root.killJob(child.job, 9);
  expect(f.revoked).toEqual([a, grandchild]);
  await f.flush();
  expect(f.root.wait(1, a)?.status).toBe(137);
  expect(f.root.wait(1, b)).toBeNull();
});

test("uncollected zombies retain bounded capacity and keep unique process identities", async () => {
  const f = fixture({ capacity: 2 });
  const pid = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(pid);
  f.contexts.get(pid)!.exit(0);
  expect(f.root.childExited(1, pid)).toBe(true);
  expect(() => f.root.spawn(1, request())).toThrow("directory is full");
  expect(f.messages.length).toBe(0);
});

test("failed transfer unwinds retained lifetimes and the source admission transaction", () => {
  const f = fixture();
  const one = f.source(f.root.options.descriptors), two = f.source(f.root.options.descriptors);
  let exports = 0, cancelled = 0;
  const codec: WorkerDescriptorCodec = { ...f.codec, export(source, pid) { if (++exports === 2) throw new Error("reservation failed"); return f.codec.export(source, pid); } };
  const client = new WorkerProcessClient({ ...f.root.options, prepareSpawn: () => ({ codec, cancel() { cancelled++; } }) });
  expect(() => client.spawn(1, request({ fds: [{ child: 1, parent: one.fd }, { child: 2, parent: two.fd }] }))).toThrow("reservation failed");
  expect(cancelled).toBe(1); expect(one.counts[0]).toBe(1); expect(two.counts[0]).toBe(1);
  expect(f.messages.length).toBe(0);
});

test("transfer transaction commits only after publishing its independently-owned context", () => {
  const f = fixture();
  const order: string[] = [];
  const client = new WorkerProcessClient({ ...f.root.options,
    prepareSpawn: () => ({ data: { filesystem: "child" }, commit() { order.push("commit"); }, cancel() { order.push("cancel"); } }),
    postMessage(message) { order.push("publish"); f.messages.push(structuredClone(message)); },
  });
  client.spawn(1, request());
  expect(order).toEqual(["publish", "commit"]);
  expect(f.messages[0]!.transport.data).toEqual({ filesystem: "child" });
});

test("lazy activation failure releases transferred lifetimes before confirming EACCES", async () => {
  const f = fixture({ activate: async () => { throw new Error("chunk failed"); } });
  const { fd, counts } = f.source(f.root.options.descriptors);
  const pid = f.root.spawn(1, request({ fds: [{ child: 17, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  await expect(f.flush()).rejects.toThrow("chunk failed");
  expect(counts[0]).toBe(0);
  expect(f.root.wait(1, pid)).toEqual({ kind: "start-failed", code: 13, error: "EACCES", status: null });
});

test("an admitted independent child survives its parent's exit before lazy activation", async () => {
  const f = fixture();
  const { fd, counts } = f.source(f.root.options.descriptors, "directory");
  const pid = f.root.spawn(1, request({ job: -1, fds: [{ child: 11, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  f.supervisor.exit(1, 0);
  await f.flush(); await f.supervisor.start(pid);
  expect(f.contexts.has(pid)).toBe(true);
  expect(counts[0]).toBe(1);
  f.contexts.get(pid)!.exit(0);
  expect(counts[0]).toBe(0);
});

test("repeated spawn messages cannot close or replace the first accepted process", async () => {
  const f = fixture();
  const { fd, counts } = f.source(f.root.options.descriptors);
  const pid = f.root.spawn(1, request({ fds: [{ child: 1, parent: fd }] }));
  const duplicate = structuredClone(f.messages[0]!);
  f.root.options.descriptors.close(fd);
  await f.flush(); await f.supervisor.start(pid);
  await expect(f.broker.handle(duplicate)).rejects.toThrow("already registered");
  expect(f.broker.get(pid)).toBeDefined();
  expect(counts[0]).toBe(1);
});

test("an ordinary exit with a signal-shaped code remains ordinary after a late kill", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(pid);
  const child = f.client(f.broker.get(pid)!);
  child.exit(143); await f.flush();
  f.root.kill(pid, 9); await f.flush();
  expect(f.revoked).toEqual([]);
  expect(f.root.wait(1, pid)).toEqual({ kind: "exited", code: 143, status: 143 });
});

test("worker job wait requires confirmed descendants and retains the directly-reaped leader outcome", async () => {
  const f = fixture();
  const leaderPid = f.root.spawn(1, request()); await f.flush();
  const leader = f.client(f.broker.get(leaderPid)!);
  const descendantPid = leader.spawn(leaderPid, request({ job: leader.job })); await f.flush();
  const descendant = f.client(f.broker.get(descendantPid)!);
  leader.exit(23);
  expect(f.root.jobEmpty(1, leader.job)).toBe(false);
  expect(f.root.waitJob(1, leader.job)).toBeNull();
  await f.flush();
  expect(f.supervisor.reap(1, leaderPid)?.code).toBe(23);
  expect(f.root.jobEmpty(1, leader.job)).toBe(false);
  descendant.exit(7);
  expect(f.root.waitJob(1, leader.job)).toBeNull();
  await f.flush();
  expect(f.root.jobEmpty(1, leader.job)).toBe(true);
  expect(f.root.jobEmpty(1, leader.job)).toBe(true);
  expect(f.root.waitJob(1, leader.job)).toEqual({ kind: "exited", code: 23, status: 23 });
  expectErrno(() => f.root.waitJob(1, leader.job), 12);
  expectErrno(() => f.root.jobEmpty(1, leader.job), 12);
  expectErrno(() => f.root.wait(1, leaderPid), 12);
  expectErrno(() => f.root.jobOf(descendantPid), 71);
  expectErrno(() => f.root.kill(leaderPid, 9), 71);
  await f.flush();
  expect(f.supervisor.get(descendantPid)).toBeUndefined();
  expect(f.broker.get(leaderPid)).toBeUndefined();
  expect(f.broker.get(descendantPid)).toBeUndefined();
});

test("worker process and job completion both await the host-work fence", async () => {
  let finish!: () => void;
  const fence = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture({ quiesce: () => fence });
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(0); await f.flush();
  const state = workerProcessState(f.broker.get(pid)!);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(controlLoad(state.confirmed, 0)).toBe(0);
  expect(controlLoad(state.jobConfirmed, 0)).toBe(0);
  expect(f.root.waitJob(1, child.job)).toBeNull();
  const before = controlLoad(f.root.wake, 0);
  finish(); await fence; await Promise.resolve();
  expect(controlLoad(f.root.wake, 0)).toBeGreaterThan(before);
  expect(f.root.wait(1, pid)?.status).toBe(0);
  expect(controlLoad(state.confirmed, 0)).toBe(1);
  expect(f.root.jobEmpty(1, child.job)).toBe(true);
  expect(f.root.waitJob(1, child.job)?.status).toBe(0);
  await f.flush();
});

test("rejected worker admissions fence host work before publishing safe job completion", async () => {
  let finish!: () => void, began!: () => void;
  const fence = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const f = fixture({ activate: async () => { throw new Error("chunk failed"); }, rejectedQuiesce: () => { began(); return fence; } });
  const pid = f.root.spawn(1, request());
  const pending = f.flush();
  await started;
  expect(f.root.wait(1, pid)).toBeNull();
  const job = f.root.jobOf(pid);
  expect(f.root.jobEmpty(1, job)).toBe(false);
  finish(); await expect(pending).rejects.toThrow("chunk failed");
  expect(f.root.wait(1, pid)).toMatchObject({ kind: "start-failed", error: "EACCES", status: null });
  expect(f.root.jobEmpty(1, job)).toBe(true);
});

test("worker job wait has retained owner ancestry and rejects siblings and unknown jobs", async () => {
  const f = fixture();
  const ownerPid = f.root.spawn(1, request()), siblingPid = f.root.spawn(1, request()); await f.flush();
  const owner = f.client(f.broker.get(ownerPid)!), sibling = f.client(f.broker.get(siblingPid)!);
  const memberPid = owner.spawn(ownerPid, request()); await f.flush();
  const member = f.client(f.broker.get(memberPid)!);
  owner.exit(0); await f.flush();
  expect(f.root.waitJob(1, owner.job)?.status).toBe(0); await f.flush();
  expectErrno(() => f.root.jobOf(ownerPid), 71);
  expect(f.root.canSignal(1, memberPid)).toBe(true);
  expect(f.root.jobEmpty(1, member.job)).toBe(false);
  expectErrno(() => sibling.waitJob(siblingPid, member.job), 63);
  expectErrno(() => f.root.waitJob(siblingPid, member.job), 63);
  expectErrno(() => f.root.waitJob(1, 999999), 71);
  member.exit(0); await f.flush();
  expect(f.root.waitJob(1, member.job)?.status).toBe(0);
  await f.flush();
  expect(f.supervisor.get(memberPid)).toBeUndefined();
});

test("queued worker reap notices retain authority after their caller is itself reaped", async () => {
  const f = fixture();
  const ownerPid = f.root.spawn(1, request()); await f.flush();
  const owner = f.client(f.broker.get(ownerPid)!);
  const childPid = owner.spawn(ownerPid, request()); await f.flush();
  const child = f.client(f.broker.get(childPid)!);
  child.exit(8); await f.flush();
  expect(owner.waitJob(ownerPid, child.job)?.status).toBe(8);
  const delayed = f.messages.shift()!;
  owner.exit(0); await f.flush();
  expect(f.root.waitJob(1, owner.job)?.status).toBe(0); await f.flush();
  expect(f.supervisor.get(ownerPid)).toBeUndefined();
  expect(f.supervisor.get(childPid)).toBeUndefined();
  await f.broker.handle(delayed, ownerPid);
  expect(f.supervisor.get(childPid)).toBeUndefined();
  expect(f.broker.get(childPid)).toBeUndefined();
});

test("accepted separate-job spawns keep their descriptors after the parent job is reaped", async () => {
  const f = fixture();
  const ownerPid = f.root.spawn(1, request()); await f.flush();
  const owner = f.client(f.broker.get(ownerPid)!);
  const { fd, counts } = f.source(owner.options.descriptors, "directory");
  const childPid = owner.spawn(ownerPid, request({ job: -1, fds: [{ child: 19, parent: fd }] }));
  owner.options.descriptors.close(fd);
  const delayed = f.messages.shift()!;
  owner.exit(0); await f.flush();
  expect(f.root.waitJob(1, owner.job)?.status).toBe(0); await f.flush();
  expect(f.broker.get(ownerPid)).toBeUndefined();
  expect(f.broker.getIdentity(ownerPid)).toBeUndefined();
  await f.broker.handle(delayed, ownerPid); await f.supervisor.start(childPid);
  expect(f.contexts.get(childPid)!.descriptors.get(19)!.resource.kind).toBe("directory");
  expect(counts[0]).toBe(1);
  const child = f.client(f.broker.get(childPid)!);
  child.exit(0); await f.flush();
  expect(f.root.waitJob(1, child.job)?.status).toBe(0); await f.flush();
  expect(counts[0]).toBe(0);
});

test("worker job membership cannot reopen safely completed or reaped jobs", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(0);
  // Selected outcomes alone do not seal a job: cleanup is still pending.
  const joined = f.root.spawn(1, request({ job: child.job }));
  await f.broker.handle(f.messages.shift()!);
  // The host has not received the accepted join yet; its shared-directory guard
  // must prevent a direct host waiter from reaping the incomplete job.
  expect(f.supervisor.waitJob(1, child.job)).toBeNull();
  await f.flush();
  const member = f.client(f.broker.get(joined)!);
  expect(f.root.jobEmpty(1, child.job)).toBe(false);
  member.exit(0); await f.flush();
  expectErrno(() => f.root.spawn(1, request({ job: child.job })), 12);
  expect(f.root.waitJob(1, child.job)?.status).toBe(0);
  expectErrno(() => f.root.spawn(1, request({ job: child.job })), 12);
  await f.flush();
});

test("worker transfer fences precede membership reservation and cancel on directory exhaustion", () => {
  const f = fixture({ capacity: 1 });
  let prepared = 0, cancelled = 0;
  const client = new WorkerProcessClient({ ...f.root.options, prepareSpawn() {
    expect(directorySlots(f.transport.directory)).toHaveLength(1);
    prepared++;
    return { cancel() { cancelled++; } };
  } });
  expectErrno(() => client.spawn(1, request({ job: f.root.job })), 6);
  expect(prepared).toBe(1); expect(cancelled).toBe(1);
  expect(controlLoad(workerProcessState(f.transport).jobPending, 0)).toBe(1);
});

test("failed leader imports retain host leader identity and outcome for queued job members", async () => {
  const f = fixture();
  const { fd } = f.source(f.root.options.descriptors, "directory");
  const leaderPid = f.root.spawn(1, request({ fds: [{ child: 19, parent: fd }] }));
  const job = f.root.jobOf(leaderPid);
  const joinedPid = f.root.spawn(1, request({ job }));
  const original = f.codec.import;
  let imports = 0;
  f.codec.import = (token, pid) => { if (++imports === 1) throw new Error("import failed"); return original(token, pid); };
  await expect(f.flush()).rejects.toThrow("import failed");
  expect(f.supervisor.get(leaderPid)?.result).toMatchObject({ kind: "start-failed", error: "EACCES", status: null });
  expect(f.root.jobEmpty(1, job)).toBe(false);
  await f.flush();
  const joined = f.client(f.broker.get(joinedPid)!);
  joined.exit(7); await f.flush();
  expect(f.root.waitJob(1, job)).toMatchObject({ kind: "start-failed", error: "EACCES", status: null }); await f.flush();
  expect(f.supervisor.get(joinedPid)).toBeUndefined();
});

test("guest job claims exclude host consumers until the broker acknowledges them", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(8); await f.flush();
  expect(f.root.waitJob(1, child.job)?.status).toBe(8);
  expectErrno(() => f.supervisor.waitJob(1, child.job), 12);
  expectErrno(() => f.supervisor.jobEmpty(1, child.job), 12);
  expect(f.supervisor.get(pid)).toBeDefined();
  await f.flush();
  expect(f.supervisor.get(pid)).toBeUndefined();
  expectErrno(() => f.supervisor.waitJob(1, child.job), 12);
});

test("guest claims racing after host readiness win before host metadata is consumed", async () => {
  let race: (() => void) | undefined;
  const f = fixture({ beforeActivation(supervisor) {
    supervisor.registerJobReapClaim(() => {
      const claim = race; race = undefined;
      claim?.();
      return true;
    });
  } });
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(8); await f.flush();
  let status: number | undefined;
  race = () => { status = f.root.waitJob(1, child.job)?.status; };
  expectErrno(() => f.supervisor.waitJob(1, child.job), 12);
  expect(status).toBe(8);
  expect(f.supervisor.get(pid)).toBeDefined();
  await f.flush();
  expect(f.supervisor.get(pid)).toBeUndefined();
});

test("host job reap tombstones worker-visible processes synchronously", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(0); await f.flush();
  f.supervisor.registerJobReapClaim(() => {
    // This hook runs after the broker claim but before host metadata deletion.
    expectErrno(() => f.root.waitJob(1, child.job), 12);
    return true;
  });
  expect(f.supervisor.waitJob(1, child.job)?.status).toBe(0);
  expectErrno(() => f.root.waitJob(1, child.job), 12);
  expectErrno(() => f.root.jobOf(pid), 71);
  expect(f.broker.get(pid)).toBeUndefined();
  expect(f.broker.getIdentity(pid)).toBeUndefined();
});

test("failed synchronous worker transfers release inaccessible process and job reservations", async () => {
  const f = fixture();
  const { fd } = f.source(f.root.options.descriptors);
  const client = new WorkerProcessClient({ ...f.root.options, codec: { ...f.codec, export() { throw new Error("transfer failed"); } } });
  for (let cycle = 0; cycle < 12; cycle++) {
    expect(() => client.spawn(1, request({ fds: [{ child: 1, parent: fd }] }))).toThrow("transfer failed");
    expect(directorySlots(f.transport.directory)).toEqual([0]);
    expect(directoryJobs(f.transport.directory).length).toBe(1);
    expectErrno(() => f.root.wait(1, cycle + 2), 12);
  }
  expect(f.messages.length).toBe(0);
  await f.flush();
});

test("broker rejects a foreign sender without accepting its process reservation", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request());
  await expect(f.broker.handle(f.messages.shift()!, 999)).rejects.toThrow("wrong sender");
  expect(f.broker.get(pid)).toBeUndefined();
});


test("shared job leader, owner and foreground survive reordered successful admissions", async () => {
  for (const selection of [0, -1]) {
    const f = fixture();
    const ownerPid = f.root.spawn(1, request({ job: -1 })); await f.flush();
    const owner = f.client(f.broker.get(ownerPid)!);
    const leaderPid = owner.spawn(ownerPid, request({ job: selection }));
    const job = owner.jobOf(leaderPid);
    const leaderMessage = f.messages.shift()!;
    const memberPid = f.root.spawn(1, request({ job }));
    await f.broker.handle(f.messages.shift()!);
    expect(f.supervisor.job(job)).toMatchObject({ ownerPid, leaderPid, foreground: selection === 0, leaderResult: null });
    expect(f.supervisor.canWaitJob(ownerPid, job)).toBe(true);
    const member = f.client(f.broker.get(memberPid)!);
    member.exit(19); await f.flush();
    expect(f.supervisor.waitJob(ownerPid, job)).toBeNull();
    expect(f.supervisor.job(job)?.leaderResult).toBeNull();
    await f.broker.handle(leaderMessage);
    const leader = f.client(f.broker.get(leaderPid)!);
    leader.exit(4); await f.flush();
    expect(f.supervisor.waitJob(ownerPid, job)).toEqual({ kind: "exited", code: 4, status: 4 });
    expectErrno(() => f.root.waitJob(1, job), 12);
  }
});

test("a locally failed unposted leader remains authoritative for its admitted shared member", async () => {
  const f = fixture();
  const ownerPid = f.root.spawn(1, request({ job: -1 })); await f.flush();
  const owner = f.client(f.broker.get(ownerPid)!);
  const { fd } = f.source(owner.options.descriptors);
  let leaderTransport!: WorkerProcessTransport;
  let memberPid = 0, released = false, failedLeaderJob = 0;
  const client = new WorkerProcessClient({ ...owner.options,
    prepareSpawn() { return {
      release() {
        const state = workerProcessState(leaderTransport);
        expect(controlLoad(state.confirmed, 0)).toBe(1);
        expect(controlLoad(state.jobConfirmed, 0)).toBe(1);
        expect(controlLoad(state.jobPending, 0)).toBe(1);
        released = true;
      },
    }; },
    codec: { ...f.codec, export(_source, pid) {
      // The reservation is visible to another live worker before this exporter fails.
      leaderTransport = { ...f.transport, slot: 2, pid };
      failedLeaderJob = workerProcessState(leaderTransport).job;
      memberPid = f.root.spawn(1, request({ job: failedLeaderJob }));
      throw new Error("local export failed");
    } },
  });
  expect(() => client.spawn(ownerPid, request({ fds: [{ child: 1, parent: fd }] }))).toThrow("local export failed");
  expect(released).toBe(true);
  expect(() => workerProcessState(leaderTransport)).toThrow();
  expect(f.messages.length).toBe(1);
  await f.flush();
  expect(f.supervisor.get(leaderTransport.pid)).toBeUndefined();
  expect(f.supervisor.job(failedLeaderJob)).toMatchObject({ ownerPid, leaderPid: leaderTransport.pid, foreground: true, leaderResult: null });
  expect(f.supervisor.canWaitJob(ownerPid, failedLeaderJob)).toBe(true);
  const member = f.client(f.broker.get(memberPid)!);
  member.exit(7); await f.flush();
  expect(f.supervisor.waitJob(ownerPid, failedLeaderJob)).toEqual({ kind: "start-failed", code: 13, error: "EACCES", status: null });
});

test("worker transfer release follows published commit or failed cancellation confirmation", () => {
  const f = fixture();
  const order: string[] = [];
  const client = new WorkerProcessClient({ ...f.root.options, prepareSpawn() { return {
    commit() { expect(f.messages.length).toBe(1); order.push("commit"); },
    release() { order.push("release"); },
  }; } });
  client.spawn(1, request());
  expect(order).toEqual(["commit", "release"]);
  const failed = new WorkerProcessClient({ ...f.root.options,
    postMessage() { throw new Error("publication failed"); },
    prepareSpawn() { return {
      cancel() { order.push("cancel"); },
      release() {
        const state = workerProcessState({ ...f.transport, slot: 2, pid: 3 });
        expect(controlLoad(state.confirmed, 0)).toBe(1);
        expect(controlLoad(state.jobConfirmed, 0)).toBe(1);
        expect(controlLoad(state.jobPending, 0)).toBe(0);
        order.push("failed-release");
      },
    }; },
  });
  expect(() => failed.spawn(1, request())).toThrow("publication failed");
  expect(order).toEqual(["commit", "release", "cancel", "failed-release"]);
});

test("broker disposal preserves safe confirmation after listener cleanup without awaiting physical termination", async () => {
  let finishFence!: () => void, finishTermination!: () => void;
  const fence = new Promise<void>(resolve => { finishFence = resolve; });
  const termination = new Promise<void>(resolve => { finishTermination = resolve; });
  let terminationStarted = false, physicallyTerminated = false;
  const f = fixture({ quiesce: () => fence, terminate() {
    terminationStarted = true;
    return termination.then(() => { physicallyTerminated = true; });
  } });
  const pid = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(pid);
  const transport = f.broker.get(pid)!;
  const state = workerProcessState(transport);
  try {
    f.broker.dispose();
    // Embeddings may immediately dispose their supervisor and remove every listener too.
    f.supervisor.dispose();
    expect(terminationStarted).toBe(false);
    expect(physicallyTerminated).toBe(false);
    expect(f.broker.get(pid)).toBeUndefined();
    expect(f.broker.getIdentity(pid)).toBeUndefined();
    expect(controlLoad(state.confirmed, 0)).toBe(0);
    expect(controlLoad(state.jobConfirmed, 0)).toBe(0);
    expect(f.root.wait(1, pid)).toBeNull();
    const before = controlLoad(state.wake, 0);
    finishFence(); await fence; await Promise.resolve();
    expect(terminationStarted).toBe(true);
    expect(physicallyTerminated).toBe(false);
    expect(controlLoad(state.confirmed, 0)).toBe(1);
    expect(controlLoad(state.jobConfirmed, 0)).toBe(1);
    expect(controlLoad(state.jobPending, 0)).toBe(0);
    expect(controlLoad(state.wake, 0)).toBeGreaterThan(before);
    expectErrno(() => f.root.wait(1, pid), 12);
  } finally { finishFence(); finishTermination(); await termination; }
});

test("broker disposal remains unconfirmed when the host-work fence fails", async () => {
  let failFence!: (error: unknown) => void;
  const fence = new Promise<void>((_resolve, reject) => { failFence = reject; });
  const f = fixture({ quiesce: () => fence });
  const pid = f.root.spawn(1, request()); await f.flush();
  const state = workerProcessState(f.broker.get(pid)!);
  f.broker.dispose(); f.supervisor.dispose();
  failFence(new Error("fence failed"));
  await fence.catch(() => {}); await Promise.resolve();
  expect(controlLoad(state.confirmed, 0)).toBe(0);
  expect(controlLoad(state.jobConfirmed, 0)).toBe(0);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(f.broker.getIdentity(pid)).toBeUndefined();
});


test("more than three thousand same-job child lifetimes recycle bounded process slots", async () => {
  const f = fixture({ capacity: 3 });
  for (let cycle = 0; cycle < 3101; cycle++) {
    const pid = f.root.spawn(1, request({ job: f.root.job }));
    await f.flush();
    f.supervisor.exit(pid, cycle);
    expect(f.root.wait(1, pid)?.code).toBe(cycle);
    await f.flush();
    expect(f.supervisor.get(pid)).toBeUndefined();
    expectErrno(() => f.root.wait(1, pid), 12);
    f.contexts.delete(pid);
    expect(directorySlots(f.transport.directory)).toHaveLength(1);
    expect(directoryJobs(f.transport.directory)).toHaveLength(1);
    expect(Array.from(f.supervisor.table.values())).toHaveLength(1);
    expect(Reflect.get(f.broker, "transports").size).toBe(1);
  }
});

test("more than three thousand distinct job lifetimes recycle process and job slots", async () => {
  const f = fixture({ capacity: 3 });
  for (let cycle = 0; cycle < 3101; cycle++) {
    const pid = f.root.spawn(1, request());
    const job = f.root.jobOf(pid);
    await f.flush();
    f.supervisor.exit(pid, cycle);
    expect(f.root.waitJob(1, job)?.code).toBe(cycle);
    await f.flush();
    f.contexts.delete(pid);
    expect(directorySlots(f.transport.directory)).toHaveLength(1);
    expect(directoryJobs(f.transport.directory)).toHaveLength(1);
    expect(Array.from(f.supervisor.table.values())).toHaveLength(1);
    expect(f.supervisor.job(job)).toBeUndefined();
    expect(Reflect.get(f.broker, "transports").size).toBe(1);
  }
});

test("captured signals, outcomes and confirmation cells cannot write a reused process slot", async () => {
  const f = fixture({ capacity: 2 });
  const oldPid = f.root.spawn(1, request({ job: f.root.job })); await f.flush();
  const oldTransport = f.broker.get(oldPid)!;
  const old = workerProcessState(oldTransport);
  f.supervisor.exit(oldPid, Number.MAX_SAFE_INTEGER);
  const returned = f.supervisor.reap(1, oldPid);
  const pid = f.root.spawn(1, request({ job: f.root.job })); await f.flush();
  const next = workerProcessState(f.broker.get(pid)!);
  expect(next.slot).toBe(old.slot);
  expectErrno(() => controlStore(old.confirmed, 0, 1), 71);
  expectErrno(() => controlStore(old.signals.interrupt, 0, 9), 71);
  expectErrno(() => controlStore(old.signals.requestedSignal, 0, 9), 71);
  expectErrno(() => setSignalDisposition(old.signals.signalState, 15, SignalDisposition.HANDLE), 71);
  expectErrno(() => claimOutcome(old.signals.outcome, { kind: "signaled", code: 9 }), 71);
  expectErrno(() => readOutcome(old.signals.outcome), 71);
  expectErrno(() => workerProcessState(oldTransport), 71);
  expect(readOutcome(next.signals.outcome)).toBeNull();
  expect(controlLoad(next.confirmed)).toBe(0);
  expect(controlLoad(next.signals.interrupt)).toBe(0);
  expect(returned.code).toBe(Number.MAX_SAFE_INTEGER);
});

function readyForCollection(transport: WorkerProcessTransport): void {
  const state = workerProcessState(transport);
  claimOutcome(state.signals.outcome, { kind: "exited", code: 0 });
  controlStore(state.confirmed, 0, 1);
  controlStore(state.jobConfirmed, 0, 1);
  state.jobPending.add(0, -1);
  if (state.pid === state.jobLeaderPid) claimOutcome(state.jobOutcome, { kind: "exited", code: 0 });
}

test("concurrent ancestor collectors help frozen forwarding edges without resurrecting a retired ancestor", () => {
  const root = createWorkerProcessTransport({ capacity: 4 });
  const a = { ...root, ...reserveDirectoryProcess(root, 2, 1, 1, 1, 0) };
  const b = { ...root, ...reserveDirectoryProcess(a, 3, 2, 1, 1, 0) };
  const c = { ...root, ...reserveDirectoryProcess(b, 4, 3, 1, 1, 0) };
  readyForCollection(a); readyForCollection(b);
  const edge = workerProcessState(b).controlParent;
  const original = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
    const previous = original(array, index, expected, replacement);
    if (!raced && array.buffer === edge.buffer && array.byteOffset === edge.byteOffset && replacement === packedControl(3, -3)) {
      raced = true;
      collectDirectoryProcess(a);
    }
    return previous;
  }) as typeof Atomics.compareExchange;
  try { collectDirectoryProcess(b); }
  finally { Atomics.compareExchange = original; }
  expect(raced).toBe(true);
  expect(controlLoad(workerProcessState(c).controlParent)).toBe(1);
  expect(directorySlots(root.directory)).toHaveLength(2);
});

test("a job collector completes when an individual collector wins after its slot snapshot", () => {
  const root = createWorkerProcessTransport({ capacity: 3 });
  const leader = { ...root, ...reserveDirectoryProcess(root, 2, 1, 2, 1) };
  const member = { ...root, ...reserveDirectoryProcess(leader, 3, 2, 2, 1, workerProcessState(leader).jobSlot) };
  readyForCollection(leader); readyForCollection(member);
  const state = workerProcessState(member);
  const original = Atomics.load;
  let raced = false;
  Atomics.load = ((array: BigInt64Array, index: number) => {
    const value = original(array, index);
    if (!raced && array instanceof BigInt64Array && index === 0 && array.byteOffset === state.signals.outcome.byteOffset - 5 * 8 && controlLoad(state.jobPending) === -1) {
      raced = true;
      collectDirectoryProcess(member);
    }
    return value;
  }) as typeof Atomics.load;
  try { expect(collectDirectoryJob(root.directory, workerProcessState(leader).jobSlot, 2).code).toBe(0); }
  finally { Atomics.load = original; }
  expect(raced).toBe(true);
  expect(directorySlots(root.directory)).toHaveLength(1);
  expect(directoryJobs(root.directory)).toHaveLength(1);
});


test("a pending wait resolves its captured immutable result after another collector reuses the slot", async () => {
  const f = fixture({ capacity: 2 });
  const pid = f.root.spawn(1, request({ job: f.root.job })); await f.flush();
  const transport = f.broker.get(pid)!;
  const waiting = f.supervisor.waitForExit(1, pid);
  f.supervisor.exit(pid, 47);
  const selected = f.supervisor.reap(1, pid);
  const replacement = f.root.spawn(1, request({ job: f.root.job })); await f.flush();
  const state = workerProcessState(f.broker.get(replacement)!);
  expect(state.slot).toBe(transport.slot);
  expect(await waiting).toEqual({ kind: "exited", code: 47, status: 47 });
  expect(Object.isFrozen(selected)).toBe(true);
  expectErrno(() => f.root.wait(1, pid), 12);
  expectErrno(() => confirmWorkerProcessJob(transport), 71);
  expect(readOutcome(state.signals.outcome)).toBeNull();
  expect(controlLoad(state.confirmed)).toBe(0);
});

test("a pending launch stops only its captured old handle after collection and row reuse", async () => {
  let finishLaunch!: (handle: ProcessHandle) => void;
  let first = true, oldStops = 0, newStops = 0;
  let enteredLaunch!: () => void;
  const entered = new Promise<void>(resolve => { enteredLaunch = resolve; });
  const pending = new Promise<ProcessHandle>(resolve => { finishLaunch = resolve; });
  const f = fixture({ capacity: 2, launch() {
    if (first) { first = false; enteredLaunch(); return pending; }
    return { terminate() { newStops++; } };
  } });
  const pid = f.root.spawn(1, request({ job: f.root.job })); await f.flush();
  const starting = f.supervisor.start(pid);
  cleanups.push(() => finishLaunch({ terminate() { oldStops++; } }));
  await entered;
  const context = f.contexts.get(pid)!;
  expect(context).toBeDefined();
  f.supervisor.exit(pid, 8); f.supervisor.reap(1, pid);
  const replacement = f.root.spawn(1, request({ job: f.root.job })); await f.flush();
  await f.supervisor.start(replacement);
  finishLaunch({ terminate() { oldStops++; } });
  await starting;
  expect(oldStops).toBe(1); expect(newStops).toBe(0);
  context.exit(99);
  expect(readOutcome(workerProcessState(f.broker.get(replacement)!).signals.outcome)).toBeNull();
  expect(f.supervisor.get(replacement)?.result).toBeNull();
});

test("reentrant process reap before job confirmation completes shared collection once confirmed", async () => {
  const f = fixture({ capacity: 2 });
  const pid = f.root.spawn(1, request({ job: f.root.job })); await f.flush();
  const waiting = f.supervisor.waitForExit(1, pid);
  f.supervisor.onChildExit(event => { if (event.pid === pid) f.supervisor.reap(1, pid); });
  f.supervisor.exit(pid, 21);
  expect(await waiting).toEqual({ kind: "exited", code: 21, status: 21 });
  expect(f.broker.get(pid)).toBeUndefined();
  expect(directorySlots(f.transport.directory)).toEqual([0]);
  const replacement = f.root.spawn(1, request({ job: f.root.job })); await f.flush();
  expect(replacement).toBeGreaterThan(pid);
});

test("numeric admitted identities cannot reuse collected rows but captured out-of-order admissions remain valid", async () => {
  const f = fixture({ capacity: 3 });
  const earlier = f.root.spawn(1, request());
  const held = f.messages.shift()!;
  const earlierJob = workerProcessState(held.transport).job;
  const later = f.root.spawn(1, request()); await f.flush();
  const oldTransport = f.broker.get(later)!;
  const old = workerProcessState(oldTransport);
  f.supervisor.exit(later, 0);
  const oldJob = old.job;
  expect(f.root.waitJob(1, oldJob)?.code).toBe(0); await f.flush();
  expect(() => f.supervisor.reserveAdmittedSpawn(1, request({ job: f.root.job }), { pid: later, job: f.root.job })).toThrow();
  expect(() => f.supervisor.reserveAdmittedSpawn(1, request({ job: f.root.job }), { pid: later, job: f.root.job, outcome: old.signals.outcome })).toThrow();
  expect(() => f.supervisor.createRoot({ pid: later, outcome: old.signals.outcome })).toThrow();
  expect(() => f.supervisor.table.createJob(1, true, oldJob)).toThrow();
  await f.broker.handle(held);
  expect(f.supervisor.get(earlier)?.job).toBe(earlierJob);
  expect(earlier).toBeLessThan(later);
  expect(earlierJob).toBeLessThan(oldJob);
});


for (const stopAt of ["seal", "job-retiring", "member-retiring", "member-freed"] as const) {
  test(`another host pump completes job retirement after collector stops at ${stopAt}`, async () => {
    const f = fixture({ capacity: 4 });
    const leader = f.root.spawn(1, request()); await f.flush();
    const leaderTransport = f.broker.get(leader)!, client = f.client(leaderTransport);
    const member = client.spawn(leader, request({ job: client.job })); await f.flush();
    const memberClient = f.client(f.broker.get(member)!);
    const descendant = memberClient.spawn(member, request({ job: -1 })); await f.flush();
    f.supervisor.exit(member, 2); f.supervisor.exit(leader, 9);
    const group = directoryJob(f.transport.directory, workerProcessState(leaderTransport).jobSlot);
    const original = Atomics.compareExchange;
    const stopped = new Error("collector terminated");
    let interrupted = false;
    const identityOffset = leaderTransport.slot * 76 * 8 + 32;
    const groupOffset = group.outcome.byteOffset - 3 * 8;
    Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
      const value = original(array, index, expected, replacement);
      if (!interrupted && array instanceof BigInt64Array && array.buffer === f.transport.directory && index === 0 && (
        stopAt === "seal" && array.byteOffset === group.pending.byteOffset && replacement === packedControl(group.id, -1) ||
        stopAt === "job-retiring" && array.byteOffset === groupOffset && replacement === packedControl(group.id, 3) ||
        stopAt === "member-retiring" && array.byteOffset === identityOffset && replacement === packedControl(leader, 3) ||
        stopAt === "member-freed" && array.byteOffset === identityOffset && expected === packedControl(leader, 3) && replacement === 0n
      )) { interrupted = true; throw stopped; }
      return value;
    }) as typeof Atomics.compareExchange;
    try { expect(() => collectDirectoryJob(f.transport.directory, group.slot, group.id)).toThrow(stopped); }
    finally { Atomics.compareExchange = original; }
    expect(interrupted).toBe(true);
    f.broker.pump(); // No consuming worker receipt was ever posted.
    expect(f.supervisor.job(group.id)).toBeUndefined();
    expect(f.broker.get(leader)).toBeUndefined(); expect(f.broker.get(member)).toBeUndefined();
    expect(directorySlots(f.transport.directory)).toHaveLength(2);
    expect(directoryJobs(f.transport.directory)).toHaveLength(2);
    expect(f.root.canSignal(1, descendant)).toBe(true);
    f.root.killJob(f.root.jobOf(descendant), 9); await f.flush();
    // The independent descendant job remains separately consumable after its parent job.
    const remaining = Array.from(directoryGroups(f.transport.directory)).find(candidate => candidate.id !== f.root.job)!;
    expect(f.root.waitJob(1, remaining.id)?.status).toBe(137); await f.flush();
    expect(directorySlots(f.transport.directory)).toEqual([0]);
  });
}

test("host metadata reconciles a consumed job without the worker's final reap notification", async () => {
  const f = fixture({ capacity: 2 });
  const pid = f.root.spawn(1, request()); await f.flush();
  const job = f.root.jobOf(pid);
  f.supervisor.exit(pid, 18);
  const silent = new WorkerProcessClient({ ...f.root.options, postMessage() {} });
  expect(silent.waitJob(1, job)?.code).toBe(18);
  expect(f.supervisor.job(job)).toBeDefined();
  f.broker.pump();
  expect(f.supervisor.job(job)).toBeUndefined(); expect(f.broker.get(pid)).toBeUndefined();
  expect(Array.from(f.supervisor.table.values())).toHaveLength(1);
  const next = f.root.spawn(1, request()); await f.flush();
  expect(next).toBeGreaterThan(pid);
});

test("captured directory enumeration skips an unrelated process collected during its identity read", () => {
  const root = createWorkerProcessTransport({ capacity: 3 });
  const old = { ...root, ...reserveDirectoryProcess(root, 2, 1, 1, 1, 0) };
  const live = { ...root, ...reserveDirectoryProcess(root, 3, 1, 1, 1, 0) };
  readyForCollection(old);
  const oldOffset = workerProcessState(old).signals.outcome.byteOffset - 5 * 8;
  const original = Atomics.load;
  let raced = false;
  Atomics.load = ((array: BigInt64Array, index: number) => {
    const value = original(array, index);
    if (!raced && array instanceof BigInt64Array && array.buffer === root.directory && array.byteOffset === oldOffset && index === 0) {
      raced = true; collectDirectoryProcess(old);
    }
    return value;
  }) as typeof Atomics.load;
  try { expect(Array.from(directoryProcesses(root.directory), state => state.pid)).toEqual([1, live.pid]); }
  finally { Atomics.load = original; }
  expect(raced).toBe(true);
});

test("job lookup skips a different job collected during its captured header read", () => {
  const root = createWorkerProcessTransport({ capacity: 3 });
  const old = { ...root, ...reserveDirectoryProcess(root, 2, 1, 2, 1) };
  const live = { ...root, ...reserveDirectoryProcess(root, 3, 1, 3, 1) };
  readyForCollection(old);
  const state = workerProcessState(old), header = state.jobOutcome.byteOffset - 3 * 8;
  const original = Atomics.load;
  let raced = false;
  Atomics.load = ((array: BigInt64Array, index: number) => {
    const value = original(array, index);
    if (!raced && array instanceof BigInt64Array && array.buffer === root.directory && array.byteOffset === header && index === 0) {
      raced = true; collectDirectoryJob(root.directory, state.jobSlot, state.job);
    }
    return value;
  }) as typeof Atomics.load;
  try { expect(findDirectoryJob(root.directory, 3)?.leaderPid).toBe(live.pid); }
  finally { Atomics.load = original; }
  expect(raced).toBe(true);
});

test("process and job authorization follow a retiring ancestor before its forwarding scan", async () => {
  const f = fixture({ capacity: 3 });
  const parent = f.root.spawn(1, request()); await f.flush();
  const parentTransport = f.broker.get(parent)!, client = f.client(parentTransport);
  const child = client.spawn(parent, request({ job: -1 })); await f.flush();
  const job = f.root.jobOf(child);
  f.supervisor.exit(parent, 0);
  const original = Atomics.compareExchange;
  let raced = false;
  const identity = workerProcessState(parentTransport).signals.outcome.byteOffset - 5 * 8;
  Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
    const previous = original(array, index, expected, replacement);
    if (!raced && array instanceof BigInt64Array && array.buffer.byteLength === f.transport.directory.byteLength && array.byteOffset === identity && replacement === packedControl(parent, 3)) {
      raced = true;
      expect(f.root.canSignal(1, child)).toBe(true);
      expect(f.root.jobEmpty(1, job)).toBe(false);
      expect(f.root.canSignalJob(1, job)).toBe(true);
    }
    return previous;
  }) as typeof Atomics.compareExchange;
  try { f.supervisor.reap(1, parent); }
  finally { Atomics.compareExchange = original; }
  expect(raced).toBe(true);
  f.root.killJob(job, 9); await f.flush();
  expect(f.root.waitJob(1, job)?.status).toBe(137); await f.flush();
});

test("collecting a captured completed member cannot interrupt signal delivery to live job members", async () => {
  const f = fixture({ capacity: 3 });
  const old = f.root.spawn(1, request({ job: f.root.job }));
  const live = f.root.spawn(1, request({ job: f.root.job })); await f.flush();
  f.supervisor.exit(old, 4);
  const outcome = workerProcessState(f.broker.get(old)!).signals.outcome;
  const original = Atomics.load;
  let raced = false;
  Atomics.load = ((array: BigInt64Array, index: number) => {
    const value = original(array, index);
    if (!raced && array instanceof BigInt64Array && array.buffer.byteLength === outcome.buffer.byteLength && array.byteOffset === outcome.byteOffset && index === 0) {
      raced = true; f.supervisor.reap(1, old);
    }
    return value;
  }) as typeof Atomics.load;
  try { expect(() => f.root.killJob(f.root.job, 15)).not.toThrow(); }
  finally { Atomics.load = original; }
  expect(raced).toBe(true);
  expect(readOutcome(workerProcessState(f.broker.get(live)!).signals.outcome)?.status).toBe(143);
});

test("large job retirement forwards the whole group with linear directory reads", () => {
  const root = createWorkerProcessTransport({ capacity: 258 });
  const leader = { ...root, ...reserveDirectoryProcess(root, 2, 1, 2, 1) };
  const jobSlot = workerProcessState(leader).jobSlot;
  const members = [leader];
  for (let pid = 3; pid <= 257; pid++) members.push({ ...root, ...reserveDirectoryProcess(leader, pid, 2, 2, 1, jobSlot) });
  const orphan = { ...root, ...reserveDirectoryProcess(members[members.length - 1]!, 258, 257, 3, 257) };
  for (const member of members) readyForCollection(member);
  const original = Atomics.load;
  let reads = 0;
  Atomics.load = ((array: BigInt64Array, index: number) => { reads++; return original(array, index); }) as typeof Atomics.load;
  try { expect(collectDirectoryJob(root.directory, jobSlot, 2)?.code).toBe(0); }
  finally { Atomics.load = original; }
  expect(reads).toBeLessThan(258 * 50);
  expect(directorySlots(root.directory)).toHaveLength(2);
  expect(controlLoad(workerProcessState(orphan).controlParent)).toBe(1);
});


test("job recovery after partial freeing preserves internal-chain forwarding destinations", () => {
  const root = createWorkerProcessTransport({ capacity: 4 });
  const leader = { ...root, ...reserveDirectoryProcess(root, 2, 1, 2, 1) };
  const jobSlot = workerProcessState(leader).jobSlot;
  const member = { ...root, ...reserveDirectoryProcess(leader, 3, 2, 2, 1, jobSlot) };
  const descendant = { ...root, ...reserveDirectoryProcess(member, 4, 3, 3, 3) };
  readyForCollection(leader); readyForCollection(member);
  const original = Atomics.compareExchange;
  const interrupted = new Error("terminated after first member free");
  let stopped = false;
  const identity = workerProcessState(leader).signals.outcome.byteOffset - 5 * 8;
  Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
    const value = original(array, index, expected, replacement);
    if (!stopped && array instanceof BigInt64Array && array.buffer === root.directory && array.byteOffset === identity && expected === packedControl(2, 3) && replacement === 0n) {
      stopped = true; throw interrupted;
    }
    return value;
  }) as typeof Atomics.compareExchange;
  try { expect(() => collectDirectoryJob(root.directory, jobSlot, 2)).toThrow(interrupted); }
  finally { Atomics.compareExchange = original; }
  helpDirectoryJobs(root.directory);
  expect(stopped).toBe(true);
  expect(directorySlots(root.directory)).toHaveLength(2);
  expect(controlLoad(workerProcessState(descendant).controlParent)).toBe(1);
  expect(controlLoad(workerProcessState(descendant).jobControlParent)).toBe(1);
});


test("an internal readiness SRCH race cannot skip physical termination or orphan collection", async () => {
  let terminated = 0;
  const f = fixture({ capacity: 3, terminate() { terminated++; }, beforeActivation(supervisor) {
    supervisor.registerJobReadiness(() => { throw new ProcessError(ProcessErrno.SRCH, "captured job header was recycled"); });
  } });
  const parent = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(parent);
  const client = f.client(f.broker.get(parent)!);
  const child = client.spawn(parent, request()); await f.flush(); await f.supervisor.start(child);
  expect(() => f.supervisor.exit(child, 3)).not.toThrow();
  expect(f.supervisor.get(child)?.result?.code).toBe(3);
  expect(() => f.supervisor.exit(parent, 4)).not.toThrow();
  expect(terminated).toBe(2);
  expect(f.supervisor.get(child)).toBeUndefined();
});

test("host collective signaling ignores collection between its retained-record check and outcome snapshot", async () => {
  const f = fixture({ capacity: 3 });
  const leader = f.root.spawn(1, request()); await f.flush();
  const job = f.root.jobOf(leader);
  const member = f.root.spawn(1, request({ job })); await f.flush();
  const transport = f.broker.get(member)!, state = workerProcessState(transport);
  f.supervisor.onChildExit(event => { if (event.pid === leader) f.supervisor.exit(member, 4); });
  const original = Atomics.load;
  let raced = false;
  Atomics.load = ((array: BigInt64Array, index: number) => {
    const value = original(array, index);
    if (!raced && array instanceof BigInt64Array && array.buffer.byteLength === state.signals.outcome.buffer.byteLength && array.byteOffset === state.signals.outcome.byteOffset && index === 0 && f.supervisor.get(member)?.result && controlLoad(state.jobConfirmed) === 1) {
      raced = true; collectDirectoryProcess(transport);
    }
    return value;
  }) as typeof Atomics.load;
  try { expect(() => f.supervisor.killJob(job, 15)).not.toThrow(); }
  finally { Atomics.load = original; }
  expect(raced).toBe(true);
  expect(f.supervisor.get(leader)?.result?.status).toBe(143);
  expect(f.supervisor.get(member)?.result?.status).toBe(143);
  f.broker.pump();
  expect(f.supervisor.get(member)).toBeUndefined();
});

test("supervisor disposal skips unacknowledged collected records and still stops live members", async () => {
  let terminated = 0;
  const f = fixture({ capacity: 3, terminate() { terminated++; } });
  const old = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(old);
  const oldState = workerProcessState(f.broker.get(old)!);
  const { fd, counts } = f.source(f.root.options.descriptors);
  const live = f.root.spawn(1, request({ fds: [{ child: 1, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  await f.flush(); await f.supervisor.start(live);
  f.supervisor.exit(old, 21);
  const silent = new WorkerProcessClient({ ...f.root.options, postMessage() {} });
  expect(silent.waitJob(1, oldState.job)?.code).toBe(21);
  expect(() => readOutcome(oldState.signals.outcome)).toThrow("collected");
  expect(f.supervisor.get(old)?.result?.code).toBe(21); // No host receipt or pump yet.
  expect(counts[0]).toBe(1);
  expect(() => f.supervisor.dispose()).not.toThrow();
  expect(terminated).toBe(2);
  expect(counts[0]).toBe(0);
  expect(Array.from(f.supervisor.table.values())).toEqual([]);
  expect(Array.from(f.supervisor.table.jobValues())).toEqual([]);
});

test("an unposted failed spawn releases its job when parent death auto-collects its process", () => {
  const transport = createWorkerProcessTransport({ capacity: 2 });
  const descriptors = new DescriptorTable(); cleanups.push(() => descriptors.dispose());
  const { codec, source } = fakeCodec();
  const { fd, counts } = source(descriptors, "directory");
  const root = workerProcessState(transport);
  const failure = new Error("source revoked during export");
  let held = false, cancelled = 0, released = 0, posted = 0;
  const client = new WorkerProcessClient({ transport, descriptors, codec: { ...codec, export() {
    expect(held).toBe(true);
    claimOutcome(root.signals.outcome, { kind: "signaled", code: 9 });
    throw failure;
  } }, postMessage() { posted++; }, prepareSpawn() {
    held = true;
    return { cancel() { expect(held).toBe(true); cancelled++; }, release() { expect(held).toBe(true); released++; held = false; } };
  } });
  let caught: unknown;
  try { client.spawn(root.pid, request({ fds: [{ child: 3, parent: fd }] })); }
  catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect({ held, cancelled, released, posted }).toEqual({ held: false, cancelled: 1, released: 1, posted: 0 });
  expect(counts[0]).toBe(1);
  expect(directorySlots(transport.directory)).toEqual([0]);
  expect(directoryJobs(transport.directory)).toEqual([root.jobSlot]);
  helpDirectoryJobs(transport.directory);
  expect(directoryJobs(transport.directory)).toEqual([root.jobSlot]);
  // The remaining allocator capacity can admit another independent process/job;
  // no inaccessible zero-pending job occupies the second row after failed export.
  const next = { ...transport, ...reserveDirectoryProcess(transport, 3, root.pid, 3, root.pid) };
  const nextState = workerProcessState(next);
  expect(nextState.job).toBe(3);
  expect(directorySlots(transport.directory)).toHaveLength(2);
  expect(directoryJobs(transport.directory)).toHaveLength(2);
  claimOutcome(nextState.signals.outcome, { kind: "exited", code: 0 });
  confirmWorkerProcessJob(next); // Dead parent's safe child is automatically collected.
  collectDirectoryJob(transport.directory, nextState.jobSlot, nextState.job);
  confirmWorkerProcessJob(transport);
  collectDirectoryJob(transport.directory, root.jobSlot, root.job);
  expect(directorySlots(transport.directory)).toEqual([]);
  expect(directoryJobs(transport.directory)).toEqual([]);
});

test("failed spawn cleanup cannot collect a job reused during admission-fence release", () => {
  const transport = createWorkerProcessTransport({ capacity: 2 });
  const descriptors = new DescriptorTable(); cleanups.push(() => descriptors.dispose());
  const { codec, source } = fakeCodec(), { fd } = source(descriptors, "directory");
  const root = workerProcessState(transport);
  const failure = new Error("revoked export");
  let replacement!: WorkerProcessTransport;
  const client = new WorkerProcessClient({ transport, descriptors, codec: { ...codec, export() {
    claimOutcome(root.signals.outcome, { kind: "signaled", code: 9 }); throw failure;
  } }, postMessage() { throw new Error("must not publish"); }, prepareSpawn() { return { release() {
    const failedJob = findDirectoryJob(transport.directory, 2)!;
    expect(readOutcome(failedJob.outcome)).toMatchObject({ kind: "start-failed", code: 13 });
    collectDirectoryJob(transport.directory, failedJob.slot, failedJob.id);
    replacement = { ...transport, ...reserveDirectoryProcess(transport, 3, root.pid, 3, root.pid) };
    expect(workerProcessState(replacement).jobSlot).toBe(failedJob.slot);
  } }; } });
  let caught: unknown;
  try { client.spawn(root.pid, request({ fds: [{ child: 3, parent: fd }] })); }
  catch (error) { caught = error; }
  expect(caught).toBe(failure);
  const state = workerProcessState(replacement);
  expect(state.job).toBe(3);
  expect(readOutcome(state.signals.outcome)).toBeNull();
  expect(controlLoad(state.jobPending)).toBe(1);
  claimOutcome(state.signals.outcome, { kind: "exited", code: 0 });
  confirmWorkerProcessJob(replacement);
  collectDirectoryJob(transport.directory, state.jobSlot, state.job);
  confirmWorkerProcessJob(transport);
  collectDirectoryJob(transport.directory, root.jobSlot, root.job);
  expect(directorySlots(transport.directory)).toEqual([]);
  expect(directoryJobs(transport.directory)).toEqual([]);
});

test("a new job stays private when its leader's full process-slot scan races a public join", () => {
  const root = createWorkerProcessTransport({ capacity: 3 });
  const messages: WorkerProcessMessage[] = [];
  const { codec } = fakeCodec();
  const make = (transport: WorkerProcessTransport) => {
    const descriptors = new DescriptorTable(); cleanups.push(() => descriptors.dispose());
    return new WorkerProcessClient({ transport, descriptors, codec, postMessage(message) { messages.push(message); } });
  };
  const a = make(root);
  const parentPid = a.spawn(1, request({ job: a.job })), parent = messages.at(-1)!.transport;
  a.spawn(1, request({ job: a.job }));
  const filler = messages.at(-1)!.transport, b = make(parent);
  readyForCollection(filler);
  const original = Atomics.compareExchange;
  let raced = false, joinError: unknown;
  const offset = workerProcessState(filler).signals.outcome.byteOffset - 5 * 8;
  Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
    const previous = original(array, index, expected, replacement);
    if (!raced && array instanceof BigInt64Array && array.buffer === root.directory && array.byteOffset === offset && index === 0 && expected === 0n && replacement === packedControl(4, 2)) {
      raced = true;
      collectDirectoryProcess(filler);
      try { b.spawn(parentPid, request({ job: 2 })); }
      catch (error) { joinError = error; }
    }
    return previous;
  }) as typeof Atomics.compareExchange;
  try { expectErrno(() => a.spawn(1, request()), ProcessErrno.AGAIN); }
  finally { Atomics.compareExchange = original; }
  expect(raced).toBe(true);
  expect(joinError).toMatchObject({ name: "ProcessError", errno: ProcessErrno.CHILD });
  expect(messages).toHaveLength(2); // Neither the failed creator nor racing join published.
  expect(Array.from(directoryProcesses(root.directory), state => state.pid)).toEqual([1, parentPid]);
  expect(directoryJobs(root.directory)).toEqual([0]);
  helpDirectoryJobs(root.directory);
  expect(directoryJobs(root.directory)).toEqual([0]);
  const nextPid = b.spawn(parentPid, request()), next = messages.at(-1)!.transport;
  const nextState = workerProcessState(next);
  expect(nextState.pid).toBe(nextPid);
  expect(nextState.jobLeaderPid).toBe(nextPid);
  expect(nextState.jobOwner).toBe(parentPid);
  expect(readOutcome(nextState.jobOutcome)).toBeNull();
  expect(directorySlots(root.directory)).toHaveLength(3);
  expect(directoryJobs(root.directory)).toHaveLength(2);
  readyForCollection(next);
  expect(a.waitJob(1, nextState.job)?.code).toBe(0);
  readyForCollection(parent); collectDirectoryProcess(parent);
  const rootState = workerProcessState(root);
  readyForCollection(root); collectDirectoryJob(root.directory, rootState.jobSlot, rootState.job);
  expect(directorySlots(root.directory)).toEqual([]);
  expect(directoryJobs(root.directory)).toEqual([]);
});

test("a successfully published new job is joinable with its original leader and typed outcome", async () => {
  const f = fixture({ capacity: 3 });
  const leader = f.root.spawn(1, request()); await f.flush();
  const job = f.root.jobOf(leader);
  const member = f.root.spawn(1, request({ job })); await f.flush();
  expect(workerProcessState(f.broker.get(member)!)).toMatchObject({ job, jobLeaderPid: leader, jobOwner: 1 });
  f.supervisor.exit(leader, 27); f.supervisor.exit(member, 4);
  expect(f.root.waitJob(1, job)?.code).toBe(27); await f.flush();
  expect(directorySlots(f.transport.directory)).toEqual([0]);
  expect(directoryJobs(f.transport.directory)).toEqual([0]);
});

for (const joining of [false, true]) {
  test(`process initialization failure rolls back ${joining ? "joined membership" : "private job"} and its captured process reservation`, () => {
    const root = createWorkerProcessTransport({ capacity: 2 });
    const rootState = workerProcessState(root);
    const original = Atomics.store;
    const failure = new Error("initialization interrupted");
    let interrupted = false;
    Atomics.store = ((array: BigInt64Array, index: number, value: bigint) => {
      if (!interrupted && array instanceof BigInt64Array && array.buffer === root.directory && array.byteOffset === 32 + 76 * 8 && index === 1 && value === packedControl(2, 1)) {
        interrupted = true; throw failure;
      }
      return original(array, index, value);
    }) as typeof Atomics.store;
    try { expect(() => reserveDirectoryProcess(root, 2, 1, joining ? rootState.job : 2, 1, joining ? rootState.jobSlot : undefined)).toThrow(failure); }
    finally { Atomics.store = original; }
    expect(interrupted).toBe(true);
    expect(directorySlots(root.directory)).toEqual([0]);
    expect(directoryJobs(root.directory)).toEqual([0]);
    expect(controlLoad(rootState.jobPending)).toBe(1);
    const next = { ...root, ...reserveDirectoryProcess(root, 3, 1, 3, 1) };
    const state = workerProcessState(next);
    expect(state.pid).toBe(3);
    readyForCollection(next); collectDirectoryJob(root.directory, state.jobSlot, state.job);
    readyForCollection(root); collectDirectoryJob(root.directory, rootState.jobSlot, rootState.job);
    expect(directorySlots(root.directory)).toEqual([]);
    expect(directoryJobs(root.directory)).toEqual([]);
  });
}

for (const completion of ["exit", "kill"] as const) {
  test(`worker wait collects direct child but wait_job retains a live grandchild until ${completion}`, async () => {
    const f = fixture({ capacity: 3 });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const abi = new ProcessABI({ memory, descriptors: f.root.options.descriptors, fs: new MemFS(),
      pid: f.root.pid, service: f.root, signals: f.root.signals });
    const view = new DataView(memory.buffer);
    const leaderPid = f.root.spawn(f.root.pid, request()); await f.flush();
    const job = f.root.jobOf(leaderPid), leader = f.client(f.broker.get(leaderPid)!);
    const grandchildPid = leader.spawn(leaderPid, request({ job })); await f.flush();
    const grandchild = f.client(f.broker.get(grandchildPid)!);
    expect(abi.imports.wait!(leaderPid, 64)).toBe(-6);
    leader.exit(23); await f.flush();
    // Exactly bash-web's order: collect direct children first, then wait on their group.
    expect(abi.imports.wait!(leaderPid, 64)).toBe(0);
    expect(view.getInt32(68, true)).toBe(23);
    expect(abi.imports.wait!(leaderPid, 64)).toBe(-12);
    await f.flush();
    expect(directorySlots(f.transport.directory)).toHaveLength(2);
    expect(f.supervisor.get(leaderPid)).toBeUndefined();
    for (let repeat = 0; repeat < 3; repeat++) expect(abi.imports.wait_job!(job, 1, 80)).toBe(-6);
    // The orphan remains controllable even though its original parent's slot is gone.
    if (completion === "kill") f.root.kill(grandchildPid, 9);
    else grandchild.exit(7);
    await f.flush();
    expect(abi.imports.wait_job!(job, 1, 80)).toBe(0);
    expect(view.getInt32(80, true)).toBe(23);
    expect(abi.imports.wait_job!(job, 1, 80)).toBe(-12);
    await f.flush();
    expect(directorySlots(f.transport.directory)).toHaveLength(1);
    expect(directoryJobs(f.transport.directory)).toHaveLength(1);
  });
}

test("worker child polling is observational and the consuming wait releases capacity before its receipt", async () => {
  const f = fixture({ capacity: 2 });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const abi = new ProcessABI({ memory, descriptors: f.root.options.descriptors, fs: new MemFS(),
    pid: f.root.pid, service: f.root, signals: f.root.signals });
  const pid = f.root.spawn(f.root.pid, request({ job: f.root.job })); await f.flush();
  const view = new DataView(memory.buffer);
  view.setUint32(256, 2, true); view.setUint32(260, pid, true);
  f.supervisor.exit(pid, 31);
  for (let repeat = 0; repeat < 3; repeat++) {
    expect(abi.imports.poll!(256, 1, 0, 512)).toBe(1);
    expect(directorySlots(f.transport.directory)).toHaveLength(2);
  }
  expect(abi.imports.wait!(pid, 64)).toBe(0);
  expect(view.getInt32(68, true)).toBe(31);
  expect(abi.imports.wait!(pid, 64)).toBe(-12);
  expect(abi.imports.poll!(256, 1, 0, 512)).toBe(-12);
  const next = f.root.spawn(f.root.pid, request({ job: f.root.job }));
  expect(next).toBeGreaterThan(pid);
  await f.flush();
  expect(f.supervisor.get(pid)).toBeUndefined();
  expect(f.supervisor.get(next)).toBeDefined();
});

test("failed executable spawns release their slots through individual waits beyond directory capacity", async () => {
  const f = fixture({ capacity: 2 });
  for (let iteration = 0; iteration < 32; iteration++) {
    const pid = f.root.spawn(f.root.pid, request({ executable: "missing", job: f.root.job }));
    await f.flush(); await f.supervisor.start(pid);
    expect(f.root.wait(f.root.pid, pid)).toMatchObject({ kind: "start-failed", error: "ENOENT" });
    expect(directorySlots(f.transport.directory)).toHaveLength(1);
    await f.flush();
    expect(f.supervisor.get(pid)).toBeUndefined();
    expect(f.broker.get(pid)).toBeUndefined();
  }
});
