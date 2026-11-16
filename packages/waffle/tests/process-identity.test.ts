import { afterEach, expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import { controlStore } from "../proc/control.js";
import { collectDirectoryProcess, directoryHasProcessSibling } from "../proc/directory.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { captureNativeReturn } from "../proc/observation.js";
import { claimOutcome } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { ProcessTable } from "../proc/table.js";
import {
  ProcessErrno,
  type AdmittedSpawnReservation,
  type ProcessContext,
  type SpawnRequest,
} from "../proc/types.js";
import { WorkerProcessBroker } from "../proc/worker-broker.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  confirmWorkerProcessJob,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
  executable: "fixture",
  argv: [],
  env: {},
  cwd: "/",
  job: -1,
  fds: [],
  ...overrides,
});
const codec = {
  export(): never {
    throw new Error("unused export");
  },
  import(): never {
    throw new Error("unused import");
  },
  discard() {},
};
function fixture(capacity = 16) {
  const identities = new ProcessIdentityAllocator();
  const root = createWorkerProcessTransport({ identity: identities.buffer, capacity });
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "fixture" });
  const contexts: ProcessContext[] = [];
  const supervisor = new ProcessSupervisor({
    table: new ProcessTable(identities),
    registry,
    launch(context) {
      contexts.push(context);
      return { terminate() {} };
    },
  });
  supervisor.createRoot({
    pid: root.pid,
    job: workerProcessState(root).job,
    observation: root,
    ...workerProcessState(root).signals,
  });
  const broker = new WorkerProcessBroker({ supervisor: async () => supervisor, codec });
  broker.adoptRoot(root);
  const messages: WorkerProcessMessage[] = [];
  function client(
    transport: WorkerProcessTransport,
    post = (message: WorkerProcessMessage) => {
      messages.push(message);
    },
  ) {
    const descriptors = new DescriptorTable();
    cleanups.push(() => descriptors.dispose());
    return new WorkerProcessClient({ transport, descriptors, codec, postMessage: post });
  }
  cleanups.push(() => {
    broker.dispose();
    supervisor.dispose();
  });
  const parent = client(root);
  function take() {
    const message = messages.shift();
    if (message?.operation !== "spawn") throw new Error("expected published spawn");
    return message;
  }
  async function spawn(caller: WorkerProcessClient, spec = request()) {
    const pid = caller.spawn(caller.pid, spec);
    const message = take();
    await broker.handle(message, caller.pid);
    await supervisor.start(pid);
    return { pid, transport: message.transport, client: client(message.transport) };
  }
  return { identities, supervisor, contexts, root, parent, broker, messages, client, take, spawn };
}
function code(action: () => unknown, errno: number) {
  expect(action).toThrow(expect.objectContaining({ errno }));
}

test("automatic shared roots reserve fresh IDs and explicit reservations are preserved", () => {
  const identities = new ProcessIdentityAllocator();
  const first = createWorkerProcessTransport({ identity: identities.buffer, capacity: 1 });
  const second = createWorkerProcessTransport({ identity: identities.buffer, capacity: 1 });
  const explicit = createWorkerProcessTransport({
    identity: identities.buffer,
    pid: 71,
    capacity: 1,
  });
  const next = createWorkerProcessTransport({ identity: identities.buffer, capacity: 1 });
  expect([first.pid, second.pid, explicit.pid, next.pid]).toEqual([1, 2, 71, 72]);
  for (const root of [first, second, explicit, next])
    expect(workerProcessState(root).processIdentity).toEqual({ pid: root.pid, parentPid: 0 });
  const f = fixture();
  const reserved = f.identities.pid();
  const adopted = createWorkerProcessTransport({
    identity: f.identities.buffer,
    pid: reserved,
    capacity: 1,
  });
  f.broker.adoptRoot(adopted);
  expect(f.identities.pid()).toBe(reserved + 1);
});

test("actual host reservations keep execution ancestry separate from logical processes", async () => {
  const f = fixture();
  const s = f.supervisor,
    root = f.root.pid;
  const first = s.reserveSpawn(root, request());
  const second = s.reserveSpawn(root, request({ worker: { opaque: true } }));
  const thread = s.reserveSpawn(first, request({ processKind: "thread" }));
  const nested = s.reserveSpawn(thread, request({ processKind: "thread", worker: {} }));
  const child = s.reserveSpawn(thread, request());
  expect([first, second, thread, nested, child]).toEqual([2, 3, 4, 5, 6]);
  expect(s.get(first)!.processIdentity).toEqual({ pid: first, parentPid: root });
  expect(s.get(second)!.processIdentity).toEqual({ pid: second, parentPid: root });
  expect(s.get(thread)!.processIdentity).toEqual(s.get(first)!.processIdentity);
  expect(s.get(nested)!.processIdentity).toEqual(s.get(first)!.processIdentity);
  expect(s.get(child)!.processIdentity).toEqual({ pid: child, parentPid: first });
  expect(s.get(child)!.parentPid).toBe(thread);
  code(() => s.wait(first, child), ProcessErrno.CHILD);
  await s.start(thread);
  expect(f.contexts[0]!.processIdentity).toEqual({ pid: first, parentPid: root });
  expect(Object.isFrozen(f.contexts[0]!.processIdentity)).toBe(true);
});

test("worker and nested-worker admission copies the caller pair before delivery", async () => {
  const f = fixture();
  const child = await f.spawn(f.parent);
  const thread = await f.spawn(child.client, request({ processKind: "thread" }));
  const nested = await f.spawn(thread.client, request({ processKind: "thread" }));
  const grandchild = await f.spawn(thread.client, request());
  expect(thread.client.processIdentity).toEqual({ pid: child.pid, parentPid: f.root.pid });
  expect(nested.client.processIdentity).toEqual(thread.client.processIdentity);
  expect(grandchild.client.processIdentity).toEqual({ pid: grandchild.pid, parentPid: child.pid });
  expect(f.supervisor.get(grandchild.pid)!.parentPid).toBe(thread.pid);
  expect(f.supervisor.get(thread.pid)!.processIdentity).toEqual(thread.client.processIdentity);
  expect(Object.isFrozen(thread.client.processIdentity)).toBe(true);
  expect(Reflect.set(thread.client.processIdentity, "pid", 700)).toBe(false);
  const oldPair = thread.client.processIdentity;
  f.supervisor.exit(child.pid, 0);
  f.supervisor.wait(f.root.pid, child.pid);
  expect(f.supervisor.get(child.pid)).toBeUndefined();
  const later = await f.spawn(thread.client, request());
  expect(thread.client.processIdentity).toBe(oldPair);
  expect(later.client.processIdentity.parentPid).toBe(child.pid);
});

test("delayed adoption uses the published pair after creator collection", async () => {
  const f = fixture();
  const thread = await f.spawn(f.parent, request({ processKind: "thread" }));
  const pid = thread.client.spawn(thread.pid, request());
  const notice = f.take();
  const pair = workerProcessState(notice.transport).processIdentity;
  f.supervisor.exit(thread.pid, 0);
  f.supervisor.wait(f.root.pid, thread.pid);
  f.broker.pump();
  await f.broker.handle(notice, thread.pid);
  expect(f.supervisor.get(pid)!.processIdentity).toEqual(pair);
  expect(pair).toEqual({ pid, parentPid: f.root.pid });
});

for (const kind of [null, 0, "unknown", {}, []]) {
  test(`malformed process kind ${JSON.stringify(kind)} cannot publish a host or guest reservation`, () => {
    const f = fixture();
    const malformed = { ...request(), processKind: kind } as unknown as SpawnRequest;
    code(() => f.parent.spawn(f.root.pid, malformed), ProcessErrno.INVAL);
    code(() => f.supervisor.reserveSpawn(f.root.pid, malformed), ProcessErrno.INVAL);
    expect(f.messages).toHaveLength(0);
    expect(f.identities.pid()).toBe(2);
  });
}

test("worker metadata is independent from explicit process kind", async () => {
  const f = fixture();
  const ordinary = await f.spawn(
    f.parent,
    request({ worker: { processKind: "thread", pid: 700 } }),
  );
  const thread = await f.spawn(f.parent, request({ processKind: "thread" }));
  expect(ordinary.client.processIdentity).toEqual({ pid: ordinary.pid, parentPid: f.root.pid });
  expect(thread.client.processIdentity).toEqual({ pid: f.root.pid, parentPid: 0 });
});

for (const collectParent of [false, true]) {
  test(`admitted transfer requires its captured pair after parent collection=${collectParent}`, async () => {
    const f = fixture();
    const creator = await f.spawn(f.parent);
    const pid = creator.client.spawn(creator.pid, request({ processKind: "thread" }));
    const notice = f.take(),
      state = workerProcessState(notice.transport);
    const mutablePair = { ...state.processIdentity };
    const retained = new DescriptorTable();
    const reservation = {
      pid,
      observation: notice.transport,
      ...state.signals,
      job: state.job,
      processIdentity: mutablePair,
    };
    if (collectParent) {
      f.supervisor.exit(creator.pid, 0);
      f.supervisor.wait(f.root.pid, creator.pid);
      expect(f.supervisor.get(creator.pid)).toBeUndefined();
    }
    const missing = {
      ...reservation,
      processIdentity: undefined,
    } as unknown as AdmittedSpawnReservation;
    code(
      () => f.supervisor.reserveAdmittedSpawn(creator.pid, notice.request, missing, retained),
      ProcessErrno.INVAL,
    );
    code(
      () =>
        f.supervisor.reserveAdmittedSpawn(
          creator.pid,
          notice.request,
          { ...reservation, processIdentity: { pid, parentPid: creator.pid } },
          retained,
        ),
      ProcessErrno.INVAL,
    );
    code(
      () => f.supervisor.reserveAdmittedSpawn(creator.pid, request(), reservation, retained),
      ProcessErrno.INVAL,
    );
    code(
      () =>
        f.supervisor.reserveSpawn(creator.pid, request(), {
          processIdentity: state.processIdentity,
        }),
      ProcessErrno.INVAL,
    );
    f.supervisor.reserveAdmittedSpawn(creator.pid, notice.request, reservation, retained);
    mutablePair.pid = 700;
    expect(f.supervisor.get(pid)!.processIdentity).toEqual(state.processIdentity);
    retained.dispose();
  });
}

test("a changed delayed request kind is rejected with owned rollback", async () => {
  const f = fixture();
  const pid = f.parent.spawn(f.root.pid, request({ processKind: "thread" }));
  const notice = f.take();
  notice.request.processKind = "process";
  await expect(f.broker.handle(notice, f.root.pid)).rejects.toMatchObject({
    errno: ProcessErrno.INVAL,
  });
  expect(f.supervisor.get(pid)).toBeUndefined();
  expect(directoryHasProcessSibling(f.root, f.root.pid)).toBe(false);
});

test("ABI scalar queries capture immutable admission without memory, service or waits", () => {
  const f = fixture();
  const pair = { pid: 31, parentPid: 7 };
  const unused = (): never => {
    throw new Error("scalar query accessed a service");
  };
  const abi = new ProcessABI({
    pid: 47,
    processIdentity: pair,
    memory: unused,
    descriptors: new DescriptorTable(),
    fs: new MemFS(),
    service: new Proxy(f.supervisor, { get: unused }),
    signals: workerProcessState(f.root).signals,
    wait: unused,
  });
  pair.pid = 99;
  pair.parentPid = 98;
  expect(abi.imports.getpid!()).toBe(47);
  expect(abi.imports.process_id!()).toBe(31);
  expect(abi.imports.parent_process_id!()).toBe(7);
});

test("a collected member blocks through native return but completed unconsumed results do not", () => {
  const f = fixture();
  f.parent.spawn(f.root.pid, request({ processKind: "thread" }));
  const notice = f.take(),
    state = workerProcessState(notice.transport);
  const returned = captureNativeReturn(notice.transport);
  expect(directoryHasProcessSibling(f.root, f.root.pid)).toBe(true);
  claimOutcome(state.signals.outcome, { kind: "exited", code: 0 });
  expect(directoryHasProcessSibling(f.root, f.root.pid)).toBe(true);
  controlStore(state.confirmed, 0, 1);
  confirmWorkerProcessJob(notice.transport);
  collectDirectoryProcess(notice.transport);
  expect(directoryHasProcessSibling(f.root, f.root.pid)).toBe(true);
  returned();
  expect(directoryHasProcessSibling(f.root, f.root.pid)).toBe(false);
  const again = f.parent.spawn(f.root.pid, request({ processKind: "thread" }));
  const completed = f.take(),
    live = workerProcessState(completed.transport);
  claimOutcome(live.signals.outcome, { kind: "exited", code: 0 });
  captureNativeReturn(completed.transport)();
  controlStore(live.confirmed, 0, 1);
  confirmWorkerProcessJob(completed.transport);
  expect(directoryHasProcessSibling(f.root, f.root.pid)).toBe(false);
  expect(workerProcessState(completed.transport).pid).toBe(again);
});

test("uncertain publication retains its sibling blocker", () => {
  const f = fixture(2);
  const failing = f.client(f.root, () => {
    throw new Error("post failed");
  });
  expect(() => failing.spawn(f.root.pid, request({ processKind: "thread" }))).toThrow(
    "post failed",
  );
  // A throwing publisher has uncertain ownership, so this reservation must stay blocked.
  expect(directoryHasProcessSibling(f.root, f.root.pid)).toBe(true);
});

test("thread publication rejects retiring and stale image generations", () => {
  const f = fixture();
  const state = workerProcessState(f.root);
  controlStore(state.imageAdmission, 0, -1);
  code(
    () => f.supervisor.reserveSpawn(f.root.pid, request({ processKind: "thread" })),
    ProcessErrno.SRCH,
  );
  code(() => f.parent.spawn(f.root.pid, request({ processKind: "thread" })), ProcessErrno.SRCH);
  controlStore(state.imageAdmission, 0, 2);
  code(
    () => f.supervisor.reserveSpawn(f.root.pid, request({ processKind: "thread" })),
    ProcessErrno.SRCH,
  );
  code(() => f.parent.spawn(f.root.pid, request({ processKind: "thread" })), ProcessErrno.SRCH);
  const successor = f.client({ ...f.root, generation: 2 });
  expect(successor.spawn(f.root.pid, request({ processKind: "thread" }))).toBe(2);
});

test("identity exhaustion burns execution gaps and never wraps", () => {
  const f = fixture(2);
  f.identities.observePid(0x7ffffffe);
  const pid = f.parent.spawn(f.root.pid, request({ processKind: "thread" }));
  expect(pid).toBe(0x7fffffff);
  expect(workerProcessState(f.take().transport).processIdentity.pid).toBe(f.root.pid);
  code(() => f.parent.spawn(f.root.pid, request()), ProcessErrno.AGAIN);
});

test("no-consumer rollback frees membership and reuses rows without reusing identities", () => {
  const f = fixture(2);
  const source = f.parent.options.descriptors.open(
    {
      kind: "device",
      read: () => 0,
      write: () => 0,
      readiness: () => ({ readable: true, writable: true, hangup: false }),
    },
    0n,
    0n,
  );
  expect(() =>
    f.parent.spawn(
      f.root.pid,
      request({ job: f.parent.job, processKind: "thread", fds: [{ parent: source, child: 0 }] }),
    ),
  ).toThrow("unused export");
  expect(directoryHasProcessSibling(f.root, f.root.pid)).toBe(false);
  const pid = f.parent.spawn(f.root.pid, request({ job: f.parent.job, processKind: "thread" }));
  const notice = f.take(),
    old = f.client(notice.transport);
  const pair = old.processIdentity;
  const state = workerProcessState(notice.transport);
  claimOutcome(state.signals.outcome, { kind: "exited", code: 0 });
  captureNativeReturn(notice.transport)();
  controlStore(state.confirmed, 0, 1);
  confirmWorkerProcessJob(notice.transport);
  collectDirectoryProcess(notice.transport);
  const next = f.parent.spawn(f.root.pid, request({ job: f.parent.job }));
  const reused = f.take();
  expect(reused.transport.slot).toBe(notice.transport.slot);
  expect(next).toBeGreaterThan(pid);
  expect(pair).toEqual({ pid: f.root.pid, parentPid: 0 });
  expect(() => workerProcessState(notice.transport)).toThrow();
  expect(workerProcessState(reused.transport).processIdentity).toEqual({
    pid: next,
    parentPid: f.root.pid,
  });
});

test("guest thread publication rechecks retirement after host preparation", () => {
  const f = fixture();
  const state = workerProcessState(f.root);
  f.parent.options.prepareSpawn = () => {
    controlStore(state.imageAdmission, 0, -1);
    return {};
  };
  code(() => f.parent.spawn(f.root.pid, request({ processKind: "thread" })), ProcessErrno.SRCH);
  expect(f.messages).toHaveLength(0);
  expect(directoryHasProcessSibling(f.root, f.root.pid)).toBe(false);
  controlStore(state.imageAdmission, 0, 1);
  f.parent.options.prepareSpawn = undefined;
  expect(f.parent.spawn(f.root.pid, request({ processKind: "thread" }))).toBeGreaterThan(2);
});

test("host thread publication rechecks its captured image after descriptor reentry", () => {
  const f = fixture();
  const parent = f.supervisor.get(f.root.pid)!;
  const descriptor = parent.image.descriptors.open(
    {
      kind: "terminal",
      read: () => 0,
      write: () => 0,
      readiness: () => ({ readable: true, writable: true, hangup: false }),
      forProcess() {
        parent.image.phase = "retiring";
        return this;
      },
    },
    0n,
    0n,
  );
  code(
    () =>
      f.supervisor.reserveSpawn(
        f.root.pid,
        request({ processKind: "thread", fds: [{ parent: descriptor, child: 0 }] }),
      ),
    ProcessErrno.SRCH,
  );
  expect(Array.from(f.supervisor.table.values())).toHaveLength(1);
});

test("the actual ABI validates JSON kinds and exec rejects an identity selection", () => {
  const f = fixture();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const abi = new ProcessABI({
    memory,
    processIdentity: f.parent.processIdentity,
    pid: f.root.pid,
    fs: new MemFS(),
    descriptors: f.supervisor.get(f.root.pid)!.image.descriptors,
    service: f.supervisor,
    signals: workerProcessState(f.root).signals,
  });
  const invoke = (operation: "spawn" | "exec", value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    new Uint8Array(memory.buffer).set(bytes);
    return abi.imports[operation]!(0, bytes.length);
  };
  for (const processKind of [null, 1, "other", {}, []])
    expect(invoke("spawn", { ...request(), processKind })).toBe(-ProcessErrno.INVAL);
  const thread = invoke("spawn", request({ processKind: "thread" }));
  expect(f.supervisor.get(thread)!.processIdentity).toEqual({ pid: f.root.pid, parentPid: 0 });
  const ordinary = invoke("spawn", request({ worker: {} }));
  expect(f.supervisor.get(ordinary)!.processIdentity).toEqual({
    pid: ordinary,
    parentPid: f.root.pid,
  });
  const exec = { executable: "fixture", argv: [], env: {}, cwd: "/", fds: [] };
  expect(invoke("exec", { ...exec, processKind: "process" })).toBe(-ProcessErrno.INVAL);
});
