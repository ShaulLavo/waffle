import { expect, test, spyOn } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { MemoryGroups } from "../group/state.js";
import {
  GroupOp,
  PAGE_BYTES,
  WAIT_CLOSED,
  WAIT_ADDR,
  WAIT_WIDTH,
  WAIT_EPOCH,
} from "../group/protocol.js";
import { groupLinkProgram } from "./fixtures/group-link-program.js";
import type { LinkedWorkerRequest } from "../link/index.js";
import type { RuntimeWorkerRequest } from "../browser/worker.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  revokeFilesystem,
} from "../fs/protocol.js";
import { enterTerminalSection, leaveTerminalSection } from "../proc/terminal-lifetime.js";
import { controlLoad } from "../proc/control.js";
import { readExecCompletion } from "../proc/exec.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { captureProcessObserver } from "../proc/observation.js";
import { readOutcome } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import {
  setSignalDisposition,
  SignalDisposition,
  signalDisposition,
  requestSignal,
} from "../proc/signals.js";
import { ProcessTable } from "../proc/table.js";
import {
  ProcessError,
  ProcessErrno,
  type ExecRequest,
  type ProcessContext,
} from "../proc/types.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  workerProcessDirectoryId,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import { WorkerPipeHost } from "../proc/worker-pipes.js";
import { bytes } from "../memory/reservations.js";
import { PipePublicationRegistry } from "../proc/pipes.js";
import { testReservations } from "./fixtures/shared-memory-platform.js";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request = (overrides: Partial<ExecRequest> = {}): ExecRequest => ({
  executable: "fixture",
  argv: ["next"],
  env: { NEW: "value" },
  cwd: "/next",
  fds: [],
  ...overrides,
});
function deferred() {
  return Promise.withResolvers<void>();
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("replacement test deadline");
    await Bun.sleep(1);
  }
}
async function fixture(
  options: {
    stop?: () => void | Promise<void>;
    quiesce?: () => void | Promise<void>;
    construct?: () => void;
    launch?: (
      context: ProcessContext,
    ) =>
      | void
      | import("../proc/types.js").ProcessHandle
      | Promise<import("../proc/types.js").ProcessHandle>;
    hostOnly?: boolean;
    shared?: boolean;
    typed?: boolean;
    acquired?: (context: ProcessContext) => Promise<void>;
    wrap?: (
      handle: import("../proc/types.js").ProcessHandle,
    ) => import("../proc/types.js").ProcessHandle;
  } = {},
) {
  const previous = globalThis.Worker;
  const workers: FakeWorker[] = [];
  const ports: MessagePort[] = [];
  const descriptors: DescriptorTable[] = [];
  const contexts: ProcessContext[] = [];
  const diagnostics: unknown[] = [];
  const reaped: number[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    request!: RuntimeWorkerRequest;
    stops = 0;
    constructor() {
      options.construct?.();
      workers.push(this);
    }
    postMessage(value: RuntimeWorkerRequest) {
      this.request = value;
    }
    terminate() {
      this.stops++;
      return options.stop?.();
    }
    emit(data: unknown) {
      this.onmessage?.({ data } as MessageEvent);
    }
    error() {
      this.onerror?.({ message: "retiring worker failed", preventDefault() {} } as ErrorEvent);
    }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const registry = new ExecutableRegistry();
  const shared = options.shared ? await groupLinkProgram() : undefined;
  registry.register("fixture", {
    adapter: "fixture",
    module: shared?.module ?? module,
    interruptible: true,
  });
  registry.register("host", {
    adapter: "host",
    module,
    execution: Object.freeze({
      kind: "host",
      launch: (context: ProcessContext) => {
        contexts.push(context);
        return options.launch?.(context) ?? { terminate() {} };
      },
    }),
  });
  const reservations = testReservations();
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    reservations,
    onError: (error) => diagnostics.push(error),
    filesystem: {
      connect(identity) {
        const pair = connectFilesystemIdentity(identity);
        ports.push(pair.client.port, pair.server.port);
        return pair.client;
      },
      revoke: revokeFilesystem,
      reap: (identity) => {
        reaped.push(identity.owner);
      },
      async quiesce() {
        await options.quiesce?.();
      },
    },
    launch(context) {
      if (context.execution?.kind === "host") return context.execution.launch(context);
      contexts.push(context);
      const custom = options.launch?.(context);
      if (custom) return custom;
      if (options.hostOnly) return { terminate() {} };
      const handle = broker.launchWorker(context, {
        workerUrl: "http://localhost/exec-fixture.ts",
        memoryGroup: shared ? "new" : undefined,
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          ...(shared ? { linkPlan: shared.linkPlan } : {}),
        },
      });
      const accepted = options.wrap?.(handle) ?? handle;
      return options.acquired ? options.acquired(context).then(() => accepted) : accepted;
    },
  });
  const root = createWorkerProcessTransport({ identity: identities.buffer, capacity: 32 });
  const notices: WorkerProcessMessage[] = [];
  const pipeRegistry = new PipePublicationRegistry({
    wake: workerProcessState(root).wake,
    allocate: (initial, maximum) =>
      reservations.buffer("pipe-registry", {
        kind: "growable-buffer",
        initial,
        maximum: bytes(maximum),
      }),
  });
  pipeRegistry.registerProcess(root.pid);
  const rootHost = new WorkerPipeHost({
    transport: root,
    registry: pipeRegistry,
    postMessage: (message) => notices.push(message),
  });
  root.data = { filesystem: createFilesystemIdentity(), pipeRegistry: rootHost.registry.handle() };
  function client(transport: WorkerProcessTransport) {
    const fds = new DescriptorTable();
    descriptors.push(fds);
    const host = new WorkerPipeHost({
      transport,
      registry: rootHost.registry,
      postMessage: (message) => notices.push(message),
    });
    const service = new WorkerProcessClient({
      transport,
      descriptors: fds,
      codec: host.codec(),
      postMessage: (message) => notices.push(message),
      registerRevocation: () => () => {},
      prepareSpawn(pid) {
        host.registry.registerProcess(pid);
        return {
          data: { filesystem: createFilesystemIdentity(), pipeRegistry: host.registry.handle() },
        };
      },
      prepareExec() {
        return {
          data: { filesystem: createFilesystemIdentity(), pipeRegistry: host.registry.handle() },
          codec: host.codec(undefined, true),
        };
      },
    });
    service.installBindings();
    return { service, fds, host };
  }
  async function flush(sender: number) {
    for (const message of notices.splice(0)) await broker.runtimeMessage(message, sender);
  }
  const parent = client(root);
  await broker.adoptRuntimeRoot(root, { memory: [] });
  const supervisor = await broker.ready();
  const pid = parent.service.spawn(root.pid, {
    ...request({ cwd: "/" }),
    job: -1,
    ...(options.typed ? { worker: { type: "fixture" } } : {}),
  });
  await flush(root.pid);
  await supervisor.start(pid);
  supervisor.started(pid);
  let caller = client(broker.transportFor(pid)!);
  async function stage(spec = request()) {
    const completion = caller.service.exec(pid, spec);
    await flush(pid);
    await until(() => readExecCompletion(completion) !== null);
    return readExecCompletion(completion)!;
  }
  async function replace(spec = request()) {
    const previousCount = workers.length;
    const retiring = workers.find(
      (worker) => worker.request.runtimeProcess?.pid === pid && worker.stops === 0,
    )!;
    expect((await stage(spec)).result).toBe(0);
    caller.fds.dispose();
    retiring.emit({ type: "replaced" });
    await until(() => workers.length === previousCount + 1);
    await supervisor.start(pid);
    caller = client(workers[workers.length - 1]!.request.runtimeProcess!);
  }
  async function close() {
    try {
      for (const fds of descriptors) fds.dispose();
      await broker.dispose();
    } finally {
      for (const port of ports) port.close();
      globalThis.Worker = previous;
    }
  }
  return {
    broker,
    reservations,
    supervisor,
    table,
    registry,
    pid,
    root,
    parent,
    contexts,
    workers,
    diagnostics,
    notices,
    groups() {
      const groups: unknown = Reflect.get(broker, "groups");
      if (!(groups instanceof MemoryGroups)) throw new Error("expected admitted memory groups");
      return groups;
    },
    reaped,
    client,
    get caller() {
      return caller;
    },
    stage,
    replace,
    flush,
    close,
  };
}

test("an unresolved real adapter defers the stopped group's seal and settles it on acquisition rejection", async () => {
  const pending = Promise.withResolvers<import("../proc/types.js").ProcessHandle>();
  const entered = deferred(),
    stopped = deferred();
  const failure = new Error("earlier acquisition rejected");
  const f = await fixture({
    shared: true,
    stop: () => stopped.promise,
    launch: (context) => {
      if (context.pid !== 2) {
        entered.resolve();
        return pending.promise;
      }
    },
  });
  let starting: Promise<void> | undefined;
  const cells = new Int32Array(f.workers[0]!.request.memoryGroup!.reply);
  const sibling = f.parent.service.spawn(f.root.pid, { ...request({ cwd: "/" }), job: -1 });
  try {
    await f.flush(f.root.pid);
    starting = f.supervisor.start(sibling).catch(() => {});
    await entered.promise;
    f.supervisor.kill(f.pid, 9);
    await until(() => f.workers[0]!.stops === 1);
    expect(Atomics.load(cells, WAIT_CLOSED)).toBe(0);
    const group = f.broker.memoryGroupOf(f.pid)!;
    const reserved = f.groups().admit(90, workerProcessDirectoryId(f.root), group);
    reserved.abort();
    expect(Atomics.load(cells, WAIT_CLOSED)).toBe(0);
    pending.reject(failure);
    await starting;
    // The retry comes from acquisition settlement, not another lease transition or a pump.
    expect(Atomics.load(cells, WAIT_CLOSED)).toBe(1);
    expect(() => f.groups().owner(group)!.reserve(91)).toThrow("admission is closed");
  } finally {
    pending.resolve({ terminate() {} });
    stopped.resolve();
    await starting;
    await f.close().catch((error) => {
      expect(error).toBeInstanceOf(AggregateError);
    });
  }
});

test("a pending adapter can still join before the terminal seal, and live siblings receive no stop wake", async () => {
  const pending = Promise.withResolvers<import("../proc/types.js").ProcessHandle>();
  const entered = Promise.withResolvers<ProcessContext>(),
    stopped = deferred();
  const f = await fixture({
    shared: true,
    stop: () => stopped.promise,
    launch: (context) => {
      if (context.pid !== 2) {
        entered.resolve(context);
        return pending.promise;
      }
    },
  });
  const group = f.broker.memoryGroupOf(f.pid)!;
  const cells = new Int32Array(f.workers[0]!.request.memoryGroup!.reply);
  let starting: Promise<void> | undefined;
  try {
    const sibling = f.parent.service.spawn(f.root.pid, { ...request({ cwd: "/" }), job: -1 });
    await f.flush(f.root.pid);
    starting = f.supervisor.start(sibling);
    const context = await entered.promise;
    f.supervisor.kill(f.pid, 9);
    await until(() => f.workers[0]!.stops === 1);
    const handle = f.broker.launchWorker<LinkedWorkerRequest>(context, {
      workerUrl: "http://localhost/later-group.ts",
      memoryGroup: group,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        linkPlan: Reflect.get(f.workers[0]!.request, "linkPlan"),
      },
    });
    pending.resolve(handle);
    await starting;
    expect(Atomics.load(cells, WAIT_CLOSED)).toBe(0);
    const next = new Int32Array(f.workers[1]!.request.memoryGroup!.reply);
    expect(Atomics.load(next, WAIT_CLOSED)).toBe(0);
    f.supervisor.kill(sibling, 9);
    await until(() => f.workers[1]!.stops === 1);
    expect(Atomics.load(cells, WAIT_CLOSED)).toBe(1);
    expect(Atomics.load(next, WAIT_CLOSED)).toBe(1);
    const unrelated = f.groups().admit(92, workerProcessDirectoryId(f.root), "new");
    const extra = f.groups().admit(93, workerProcessDirectoryId(f.root), unrelated.group);
    extra.abort();
    unrelated.abort();
  } finally {
    pending.resolve({ terminate() {} });
    stopped.resolve();
    await starting;
    await f.close();
  }
});

for (const mode of ["loader-rejection", "cancel-before-adapter"] as const) {
  test(`${mode} settles an exact earlier acquisition without waiting for its row to be consumed`, async () => {
    const loading = Promise.withResolvers<WebAssembly.Module>();
    const entered = deferred(),
      stopping = deferred(),
      quiescent = deferred();
    const f = await fixture({ shared: true, stop: () => stopping.promise });
    f.registry.register("earlier", {
      adapter: "fixture",
      module: () => {
        entered.resolve();
        return loading.promise;
      },
    });
    const sibling = f.parent.service.spawn(f.root.pid, {
      ...request({ executable: "earlier", cwd: "/" }),
      job: -1,
    });
    const cells = new Int32Array(f.workers[0]!.request.memoryGroup!.reply);
    let starting: Promise<void> | undefined;
    try {
      await f.flush(f.root.pid);
      f.supervisor.onProcessQuiescent((event) => {
        if (event.pid === sibling) quiescent.resolve();
      });
      starting = f.supervisor.start(sibling);
      await entered.promise;
      f.supervisor.kill(f.pid, 9);
      await until(() => f.workers[0]!.stops === 1);
      expect(Atomics.load(cells, WAIT_CLOSED)).toBe(0);
      if (mode === "loader-rejection") loading.reject(new Error("registry load rejected"));
      else f.supervisor.kill(sibling, 9);
      await quiescent.promise;
      expect(Atomics.load(cells, WAIT_CLOSED)).toBe(1);
      expect(f.table.get(sibling)).toBeDefined();
      expect(f.contexts).toHaveLength(1);
    } finally {
      loading.resolve(module);
      stopping.resolve();
      await starting;
      await f.close();
    }
  });
}

for (const mode of ["throw", "reject"] as const) {
  test(`owned child native ${mode} closes before await and preserves backing, holds and capacity debt`, async () => {
    const failure = new Error("native stop failure");
    const f = await fixture({
      shared: true,
      stop: () => {
        if (mode === "throw") throw failure;
        return Promise.reject(failure);
      },
    });
    const request = f.workers[0]!.request.memoryGroup!;
    const cells = new Int32Array(request.reply);
    const words = new Int32Array(request.memory.buffer);
    Atomics.store(cells, WAIT_ADDR, 64);
    Atomics.store(cells, WAIT_WIDTH, 4);
    Atomics.store(cells, WAIT_EPOCH, 1);
    const waiting = Atomics.waitAsync(words, 16, 0);
    const group = f.broker.memoryGroupOf(f.pid)!;
    const owner = f.groups().owner(group)!;
    const lease = f.groups().admit(90, workerProcessDirectoryId(f.root), group);
    lease.abort();
    try {
      f.supervisor.kill(f.pid, 9);
      expect(await waiting.value).toBe("ok");
      await until(() => f.broker.memoryGroups()[0]?.retained === 1);
      expect(Atomics.load(cells, WAIT_CLOSED)).toBe(1);
      expect(owner.snapshot().committedBytes).toBeGreaterThan(0);
      expect(() => owner.reserve(91)).toThrow("admission is closed");
      await expect(f.broker.dispose()).rejects.toBeInstanceOf(AggregateError);
    } finally {
      await f.close().catch(() => {});
    }
  });
}

test("an owned child fence failure retains an unattempted blocker without a cancellation wake", async () => {
  const failure = new Error("filesystem fence failed");
  const f = await fixture({
    shared: true,
    quiesce: () => {
      throw failure;
    },
  });
  const request = f.workers[0]!.request.memoryGroup!;
  const cells = new Int32Array(request.reply);
  const group = f.broker.memoryGroupOf(f.pid)!;
  const sibling = f.groups().admit(90, workerProcessDirectoryId(f.root), group);
  const launched = sibling.launch();
  try {
    const children: unknown = Reflect.get(f.broker, "children");
    if (!(children instanceof Map)) throw new Error("missing child ownership map");
    const stop: unknown = Reflect.get(f.broker, "stopPhysical");
    if (typeof stop !== "function") throw new Error("missing physical stop path");
    await expect(Reflect.apply(stop, f.broker, [children.get(f.pid)])).rejects.toBeDefined();
    expect(f.broker.memoryGroups()[0]?.retained).toBe(1);
    sibling.stopRequested();
    expect(Atomics.load(cells, WAIT_CLOSED)).toBe(0);
    expect(f.workers[0]!.stops).toBe(0);
    expect(Atomics.load(new Int32Array(launched.request.reply), WAIT_CLOSED)).toBe(0);
  } finally {
    launched.request.port.close();
    sibling.stopped();
    await f.close().catch(() => {});
  }
});

test("two execs keep PID, parent, waiters, observation and terminal lifetime until final exit", async () => {
  const f = await fixture();
  try {
    const original = f.table.require(f.pid);
    const observer = captureProcessObserver(original.observation);
    let waited = false;
    const waiting = f.supervisor.waitForExit(f.root.pid, f.pid).then((result) => {
      waited = true;
      return result;
    });
    await f.replace();
    await f.replace(request({ argv: ["third"], cwd: "/third" }));
    expect(f.table.require(f.pid)).toBe(original);
    expect(original.image.generation).toBe(3);
    expect(original.parentPid).toBe(f.root.pid);
    expect(f.caller.service.cwd(f.pid)).toBe("/third");
    expect(f.contexts[2]!.request.argv).toEqual(["third"]);
    expect(f.contexts[2]!.request.env).toEqual({ NEW: "value" });
    expect(observer.read()).toEqual({ kind: "pending" });
    expect(
      controlLoad(workerProcessState(f.workers[2]!.request.runtimeProcess!).terminalStopped),
    ).toBe(0);
    expect(waited).toBe(false);
    expect(f.workers.map((worker) => worker.stops)).toEqual([1, 1, 0]);
    f.contexts[0]!.exit(77);
    f.contexts[0]!.fail(new Error("late old failure"));
    expect(readOutcome(original.outcome)).toBeNull();
    f.workers[2]!.emit({ type: "exit", code: 7 });
    expect(await waiting).toMatchObject({ kind: "exited", code: 7 });
    await original.stopping?.complete;
    expect(observer.read()).toEqual({ kind: "terminated" });
    expect(f.workers.map((worker) => worker.stops)).toEqual([1, 1, 1]);
    expect(f.diagnostics).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const completion of ["revocation", "controller-stop", "physical-stop"] as const)
  test(`${completion} completion cannot finish a retiring image`, async () => {
    const lateStarted: boolean[] = [];
    const f = await fixture({
      stop: completion === "physical-stop" ? completeOldImage : undefined,
    });
    const oldContext = f.contexts[0]!;
    function completeOldImage() {
      lateStarted.push(oldContext.started());
      oldContext.exit(33);
    }
    const record = f.table.require(f.pid);
    const observer = captureProcessObserver(record.observation);
    let waited = false;
    const waiting = f.supervisor.waitForExit(f.root.pid, f.pid).then((result) => {
      waited = true;
      return result;
    });
    try {
      if (completion === "revocation") oldContext.registerRevocation?.(completeOldImage);
      if (completion === "controller-stop")
        f.broker.registerController(f.pid, { stop: completeOldImage });
      expect((await f.stage()).result).toBe(0);
      f.workers[0]!.emit({ type: "replaced" });
      await until(() => record.result !== null || f.workers.length === 2);
      expect(record.result).toBeNull();
      expect(f.workers).toHaveLength(2);
      expect(lateStarted).toEqual([false]);
      expect(waited).toBe(false);
      expect(observer.read()).toEqual({ kind: "pending" });
      expect(
        controlLoad(workerProcessState(f.workers[1]!.request.runtimeProcess!).terminalStopped),
      ).toBe(0);
      f.workers[1]!.emit({ type: "exit", code: 7 });
      expect(await waiting).toMatchObject({ kind: "exited", code: 7 });
      await record.stopping?.complete;
      expect(observer.read()).toEqual({ kind: "terminated" });
      expect(f.workers.map((worker) => worker.stops)).toEqual([1, 1]);
    } finally {
      await f.close();
    }
  });

test("lookup failure discards staged aliases and keeps caller pipes usable", async () => {
  const f = await fixture();
  try {
    const [reader, writer] = f.caller.host.createPipe();
    const fd = f.caller.fds.open(writer, 0n, 0n);
    const alias = f.caller.fds.dup(fd);
    await f.flush(f.pid);
    const failed = await f.stage(
      request({
        executable: "missing",
        fds: [
          { parent: fd, child: 1 },
          { parent: alias, child: 2 },
        ],
      }),
    );
    expect(failed.result).toBe(-44);
    expect(failed.diagnostic).toContain("missing");
    expect(f.table.require(f.pid).image.generation).toBe(1);
    expect(writer.tryWrite([new TextEncoder().encode("live")])).toBe(4);
    const bytes = new Uint8Array(4);
    expect(reader.tryRead([bytes])).toBe(4);
    expect(new TextDecoder().decode(bytes)).toBe("live");
    expect(readOutcome(f.table.require(f.pid).outcome)).toBeNull();
    reader.close();
  } finally {
    await f.close();
  }
});

test("exec preserves aliases, pipe flags and EOF continuity while closing omitted pipes", async () => {
  const f = await fixture();
  try {
    const [reader, writer] = f.caller.host.createPipe();
    const [omittedReader, omittedWriter] = f.caller.host.createPipe();
    const fd = f.caller.fds.open(writer, 0n, 0n);
    const alias = f.caller.fds.dup(fd);
    f.caller.fds.open(omittedWriter, 0n, 0n);
    writer.fdflags = 4;
    await f.flush(f.pid);
    writer.tryWrite([new Uint8Array([1])]);
    await f.replace(
      request({
        fds: [
          { parent: fd, child: 7 },
          { parent: alias, child: 11 },
        ],
      }),
    );
    expect(f.caller.fds.get(7)!.description).toBe(f.caller.fds.get(11)!.description);
    const inherited = f.caller.fds.get(7)!.resource;
    expect(inherited.kind).toBe("pipe");
    if (inherited.kind !== "pipe") throw new Error("inherited pipe missing");
    expect(inherited.fdflags).toBe(4);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(-ProcessErrno.AGAIN);
    expect(omittedReader.tryRead([new Uint8Array(1)])).toBe(0);
    f.caller.fds.close(7);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(-ProcessErrno.AGAIN);
    f.caller.fds.close(11);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
    reader.close();
    omittedReader.close();
  } finally {
    await f.close();
  }
});

test("replacement waits for captured physical stop before launching", async () => {
  const stopping = deferred();
  const f = await fixture({ stop: () => stopping.promise });
  try {
    expect((await f.stage()).result).toBe(0);
    f.workers[0]!.emit({ type: "replaced" });
    await until(() => f.workers[0]!.stops === 1);
    expect(f.workers.length).toBe(1);
    stopping.resolve();
    await until(() => f.workers.length === 2);
    expect(f.workers[0]!.stops).toBe(1);
  } finally {
    stopping.resolve();
    await f.close();
  }
});

for (const cancellation of ["kill", "dispose"] as const)
  test(`${cancellation} joins one pending image stop and prevents successor launch`, async () => {
    const stopping = deferred();
    const f = await fixture({ stop: () => stopping.promise });
    let disposal: Promise<void> | undefined;
    try {
      expect((await f.stage()).result).toBe(0);
      f.workers[0]!.emit({ type: "replaced" });
      await until(() => f.workers[0]!.stops === 1);
      const record = f.table.require(f.pid);
      if (cancellation === "kill") f.supervisor.kill(f.pid, 9);
      else disposal = f.broker.dispose();
      stopping.resolve();
      await until(() => record.result !== null);
      await record.stopping?.complete;
      await disposal;
      expect(record.result).toMatchObject({ kind: "signaled", code: 9 });
      expect(f.workers.length).toBe(1);
      expect(f.workers[0]!.stops).toBe(1);
      expect(captureProcessObserver(record.observation).read()).toEqual({ kind: "terminated" });
    } finally {
      stopping.resolve();
      await disposal;
      await f.close();
    }
  });

for (const failure of ["worker-error", "cleanup-error"] as const)
  test(`${failure} before replaced selects 126 and settles native return`, async () => {
    const f = await fixture();
    try {
      expect((await f.stage()).result).toBe(0);
      const record = f.table.require(f.pid);
      if (failure === "worker-error") f.workers[0]!.error();
      else
        f.workers[0]!.emit({
          type: "cleanup-error",
          message: "cleanup failed",
          cleanupErrors: ["cleanup failed"],
          code: 1,
        });
      await until(() => record.result !== null);
      await record.stopping?.complete;
      expect(record.result).toMatchObject({ kind: "exited", code: 126 });
      expect(f.workers.length).toBe(1);
      expect(f.workers[0]!.stops).toBe(1);
      expect(captureProcessObserver(record.observation).read()).toEqual({ kind: "terminated" });
    } finally {
      await f.close();
    }
  });

test("exec resets handlers, preserves ignore and applies a pending terminating signal at commit", async () => {
  const f = await fixture();
  try {
    const record = f.table.require(f.pid);
    setSignalDisposition(record.signalState, 10, SignalDisposition.HANDLE, record.interrupt);
    setSignalDisposition(record.signalState, 12, SignalDisposition.IGNORE, record.interrupt);
    await f.replace();
    expect(signalDisposition(record.signalState, 10)).toBe(SignalDisposition.DEFAULT);
    expect(signalDisposition(record.signalState, 12)).toBe(SignalDisposition.IGNORE);
    setSignalDisposition(record.signalState, 15, SignalDisposition.HANDLE, record.interrupt);
    f.supervisor.kill(f.pid, 15);
    await f.stage();
    await until(() => record.result !== null);
    expect(record.result).toMatchObject({ kind: "signaled", code: 15 });
    expect(f.workers.length).toBe(2);
  } finally {
    await f.close();
  }
});

for (const cancellation of ["kill", "dispose"] as const)
  test(`${cancellation} during terminal handoff cannot rearm and releases the successor-free native slot`, async () => {
    const f = await fixture();
    let disposal: Promise<void> | undefined;
    const record = f.table.require(f.pid);
    const transport = f.workers[0]!.request.runtimeProcess!;
    const state = workerProcessState(transport);
    const owners = Reflect.get(f.broker, "observationOwners") as Map<number, object>;
    const owner = owners.get(f.pid)!;
    let held = enterTerminalSection(state);
    expect(held).toBe(true);
    try {
      expect((await f.stage()).result).toBe(0);
      f.workers[0]!.emit({ type: "replaced" });
      await until(() => f.workers[0]!.stops === 1 && controlLoad(state.terminalAdmission) === -2);
      expect(captureProcessObserver(record.observation).read()).toEqual({ kind: "pending" });
      expect(Reflect.get(owner, "consumers")).toBe(1);
      if (cancellation === "kill") f.supervisor.kill(f.pid, 9);
      else disposal = f.broker.dispose();
      expect(enterTerminalSection(state)).toBe(false);
      leaveTerminalSection(state, transport.directory);
      held = false;
      await until(() => record.result !== null);
      await disposal;
      await record.stopping?.complete;
      expect(record.result).toMatchObject({ kind: "signaled", code: 9 });
      expect(f.workers.length).toBe(1);
      expect(f.workers[0]!.stops).toBe(1);
      expect(Reflect.get(owner, "consumers")).toBe(0);
      expect(captureProcessObserver(record.observation).read()).toEqual({ kind: "terminated" });
      let admitted = false;
      try {
        admitted = enterTerminalSection(state);
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessError);
      }
      expect(admitted).toBe(false);
    } finally {
      if (held) leaveTerminalSection(state, transport.directory);
      await disposal;
      await f.close();
    }
  });

for (const failure of ["admission", "construction"] as const)
  test(`${failure} failure before successor registration finalizes the continuous native slot`, async () => {
    let rejectConstruction = false;
    const f = await fixture({
      construct() {
        if (rejectConstruction) throw new Error("successor construction refused");
      },
    });
    const record = f.table.require(f.pid);
    const owner = (Reflect.get(f.broker, "observationOwners") as Map<number, object>).get(f.pid)!;
    let admission: ReturnType<typeof spyOn> | undefined;
    try {
      expect((await f.stage()).result).toBe(0);
      rejectConstruction = failure === "construction";
      if (failure === "admission")
        admission = spyOn(f.reservations, "admit").mockImplementationOnce(() => {
          throw new RangeError("successor admission refused");
        });
      f.workers[0]!.emit({ type: "replaced" });
      await until(() => record.result !== null);
      await record.stopping?.complete;
      expect(record.result).toMatchObject({ kind: "exited", code: 126 });
      expect(f.workers.length).toBe(1);
      expect(f.workers[0]!.stops).toBe(1);
      expect(Reflect.get(owner, "consumers")).toBe(0);
      expect(captureProcessObserver(record.observation).read()).toEqual({ kind: "terminated" });
      expect(
        f.diagnostics.some((error) => String(error).includes(`successor ${failure} refused`)),
      ).toBe(true);
    } finally {
      admission?.mockRestore();
      await f.close();
    }
  });

test("a child and caller-fatal job remain owned and waitable after replacement", async () => {
  const f = await fixture();
  try {
    const child = f.caller.service.spawn(f.pid, { ...request({ cwd: "/" }), job: -1 });
    const fatalChild = f.caller.service.spawn(f.pid, {
      ...request({ cwd: "/" }),
      job: -1,
      jobLifetime: "caller-fatal",
    });
    await f.flush(f.pid);
    await f.supervisor.start(child);
    await f.supervisor.start(fatalChild);
    const childRecord = f.table.require(child);
    const fatalRecord = f.table.require(fatalChild);
    const waiting = f.supervisor.waitForExit(f.pid, child);
    await f.replace();
    expect(childRecord.parentPid).toBe(f.pid);
    expect(f.table.job(fatalRecord.job)?.ownerPid).toBe(f.pid);
    const childWorker = f.workers.find((worker) => worker.request.runtimeProcess?.pid === child)!;
    childWorker.emit({ type: "exit", code: 23 });
    expect(await waiting).toMatchObject({ kind: "exited", code: 23 });
    expect(f.caller.service.wait(f.pid, child)).toMatchObject({ kind: "exited", code: 23 });
    f.supervisor.kill(f.pid, 9);
    await until(() => fatalRecord.result !== null);
    expect(fatalRecord.result).toMatchObject({ kind: "signaled", code: 9 });
  } finally {
    await f.close();
  }
});

for (const phase of ["in-flight", "resolving"] as const)
  test(`fatal cancellation while exec is ${phase} discards staged state once without launch`, async () => {
    const f = await fixture();
    const loading = Promise.withResolvers<WebAssembly.Module>();
    let resolving = false;
    f.registry.register("slow", {
      adapter: "fixture",
      module: () => {
        resolving = true;
        return loading.promise;
      },
    });
    const record = f.table.require(f.pid);
    try {
      const completion = f.caller.service.exec(
        f.pid,
        request({ executable: phase === "resolving" ? "slow" : "fixture" }),
      );
      if (phase === "resolving") {
        await f.flush(f.pid);
        await until(() => resolving);
      }
      f.supervisor.kill(f.pid, 9);
      if (phase === "in-flight") await f.flush(f.pid);
      await until(() => readExecCompletion(completion) !== null && record.result !== null);
      await record.stopping?.complete;
      expect(readExecCompletion(completion)!.result).toBe(-ProcessErrno.SRCH);
      expect(record.result).toMatchObject({ kind: "signaled", code: 9 });
      expect(f.reaped).toHaveLength(1);
      loading.resolve(module);
      await Promise.resolve();
      expect(f.workers).toHaveLength(1);
      expect(f.workers[0]!.stops).toBe(1);
    } finally {
      loading.resolve(module);
      await f.close();
    }
  });

test("an export failure before post closes only exported successor lifetimes", async () => {
  const f = await fixture();
  try {
    const [reader, writer] = f.caller.host.createPipe();
    const fd = f.caller.fds.open(writer, 0n, 0n);
    const unsupported = f.caller.fds.open(
      { kind: "file", handle: 123, offset: 0, append: false },
      0n,
      0n,
    );
    await f.flush(f.pid);
    const prepare = f.caller.service.options.prepareExec!;
    let cancelled = 0,
      released = 0,
      posted = 0;
    f.caller.service.options.prepareExec = (pid) => ({
      ...prepare(pid),
      cancel() {
        cancelled++;
      },
      release() {
        released++;
      },
    });
    f.caller.service.options.postMessage = () => {
      posted++;
    };
    expect(() =>
      f.caller.service.exec(
        f.pid,
        request({
          fds: [
            { parent: fd, child: 1 },
            { parent: unsupported, child: 2 },
          ],
        }),
      ),
    ).toThrow();
    expect([cancelled, released, posted]).toEqual([1, 1, 0]);
    expect(writer.tryWrite([new Uint8Array([7])])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
    expect(readOutcome(f.table.require(f.pid).outcome)).toBeNull();
    reader.close();
  } finally {
    await f.close();
  }
});

test("fatal cancellation at successor launch prevents admission and construction", async () => {
  let cancel: (() => void) | undefined;
  const f = await fixture({
    launch(context) {
      if (context.generation === 2) cancel?.();
    },
  });
  const record = f.table.require(f.pid);
  try {
    cancel = () => f.supervisor.kill(f.pid, 9);
    expect((await f.stage()).result).toBe(0);
    f.workers[0]!.emit({ type: "replaced" });
    await until(() => record.result !== null);
    await record.stopping?.complete;
    expect(record.result).toMatchObject({ kind: "signaled", code: 9 });
    expect(f.workers).toHaveLength(1);
    expect(f.workers[0]!.stops).toBe(1);
    expect(captureProcessObserver(record.observation).read()).toEqual({ kind: "terminated" });
  } finally {
    await f.close();
  }
});

test("generation 2 terminal sections are joined by the next handoff and final quiesce", async () => {
  const f = await fixture();
  let state: ReturnType<typeof workerProcessState> | undefined;
  let held = false;
  let transport: WorkerProcessTransport | undefined;
  try {
    await f.replace();
    transport = f.workers[1]!.request.runtimeProcess!;
    state = workerProcessState(transport);
    held = enterTerminalSection(state);
    expect(held).toBe(true);
    expect((await f.stage()).result).toBe(0);
    f.workers[1]!.emit({ type: "replaced" });
    await until(() => controlLoad(state!.terminalAdmission) === -2);
    expect(f.workers).toHaveLength(2);
    expect(f.workers[1]!.stops).toBe(1);
    leaveTerminalSection(state, transport.directory);
    held = false;
    await until(() => f.workers.length === 3);
    transport = f.workers[2]!.request.runtimeProcess!;
    state = workerProcessState(transport);
    held = enterTerminalSection(state);
    const record = f.table.require(f.pid);
    f.supervisor.kill(f.pid, 9);
    expect(f.workers[2]!.stops).toBe(0);
    leaveTerminalSection(state, transport.directory);
    held = false;
    await until(() => record.result !== null);
    await record.stopping?.complete;
    expect(f.workers[2]!.stops).toBe(1);
  } finally {
    if (held && state && transport) leaveTerminalSection(state, transport.directory);
    await f.close();
  }
});

test("a pre-existing physical receipt cannot certify an unproved successor launcher", async () => {
  const failure = new Error("unknown successor consumer");
  const f = await fixture({
    launch(context) {
      if (context.generation === 2) throw failure;
    },
  });
  const record = f.table.require(f.pid);
  const owner = (Reflect.get(f.broker, "observationOwners") as Map<number, object>).get(f.pid)!;
  try {
    expect((await f.stage()).result).toBe(0);
    f.workers[0]!.emit({ type: "replaced" });
    await until(() => record.result !== null);
    await expect(record.stopping!.complete).rejects.toBe(failure);
    expect(record.result).toMatchObject({ kind: "exited", code: 126 });
    expect(Reflect.get(owner, "consumers")).toBe(1);
    expect(captureProcessObserver(record.observation).read().kind).toBe("selected");
    await expect(f.broker.dispose()).rejects.toBeInstanceOf(AggregateError);
  } finally {
    await f.close().catch(() => {});
  }
});

test("root and non-Worker callers receive ENOTSUP without changing their process", async () => {
  const f = await fixture({ hostOnly: true });
  try {
    expect((await f.stage()).result).toBe(-ProcessErrno.NOTSUP);
    const completion = f.parent.service.exec(f.root.pid, request());
    await f.flush(f.root.pid);
    expect(readExecCompletion(completion)!.result).toBe(-ProcessErrno.NOTSUP);
    expect(readOutcome(f.table.require(f.pid).outcome)).toBeNull();
    expect(readOutcome(f.table.require(f.root.pid).outcome)).toBeNull();
    expect(f.workers).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("a failed captured image stop remains charged and is never retried by final cancellation", async () => {
  const failure = new Error("physical stop refused");
  const f = await fixture({ stop: () => Promise.reject(failure) });
  const record = f.table.require(f.pid);
  const owner = (Reflect.get(f.broker, "observationOwners") as Map<number, object>).get(f.pid)!;
  const charged = f.reservations.snapshot().reservedBytes;
  try {
    expect((await f.stage()).result).toBe(0);
    f.workers[0]!.emit({ type: "replaced" });
    await until(() => record.result !== null);
    await expect(record.stopping!.complete).rejects.toBeInstanceOf(AggregateError);
    f.supervisor.kill(f.pid, 9);
    expect(record.result).toMatchObject({ kind: "exited", code: 126 });
    expect(f.workers).toHaveLength(1);
    expect(f.workers[0]!.stops).toBe(1);
    expect(Reflect.get(owner, "consumers")).toBe(1);
    expect(f.reservations.snapshot().reservedBytes).toBeGreaterThanOrEqual(charged);
    await expect(f.broker.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(f.workers[0]!.stops).toBe(1);
  } finally {
    await f.close().catch(() => {});
  }
});

test("an unclassified shared target is rejected after full module resolution", async () => {
  const f = await fixture();
  const child = (Reflect.get(f.broker, "children") as Map<number, object>).get(f.pid)!;
  let loaded = false;
  f.registry.register("unresolved", {
    adapter: "fixture",
    module: () => {
      loaded = true;
      return module;
    },
  });
  try {
    Reflect.set(child, "group", {});
    expect((await f.stage(request({ executable: "unresolved" }))).result).toBe(
      -ProcessErrno.NOTSUP,
    );
    expect(loaded).toBe(true);
    expect(f.table.require(f.pid).image.generation).toBe(1);
  } finally {
    Reflect.deleteProperty(child, "group");
    await f.close();
  }
});

test("a fatal shared outcome during image stop settles without a signal notification or pump", async () => {
  const stopping = deferred();
  const f = await fixture({ stop: () => stopping.promise });
  const record = f.table.require(f.pid);
  try {
    expect((await f.stage()).result).toBe(0);
    const timer = Reflect.get(f.broker, "timer") as ReturnType<typeof setTimeout> | null;
    if (timer) clearTimeout(timer);
    Reflect.set(f.broker, "timer", null);
    f.workers[0]!.emit({ type: "replaced" });
    await until(() => f.workers[0]!.stops === 1);
    requestSignal(record, 9);
    stopping.resolve();
    await until(() => record.result !== null);
    await record.stopping?.complete;
    expect(record.result).toMatchObject({ kind: "signaled", code: 9 });
    expect(f.workers).toHaveLength(1);
    expect(f.workers[0]!.stops).toBe(1);
    expect(captureProcessObserver(record.observation).read()).toEqual({ kind: "terminated" });
  } finally {
    stopping.resolve();
    await f.close();
  }
});

test("shared source closes joins only after target resolution and retains its native-stop charge", async () => {
  const stopping = deferred();
  const loading = Promise.withResolvers<WebAssembly.Module>();
  const f = await fixture({ shared: true, stop: () => stopping.promise });
  const target = await f.registry.resolve("host");
  if (target.kind !== "module") throw new Error("expected module target");
  f.registry.register("host", { ...target, module: () => loading.promise });
  try {
    const attempt = f.stage(request({ executable: "host" }));
    await until(() => f.table.require(f.pid).replacement?.state.phase === "resolving");
    const group = f.broker.memoryGroupOf(f.pid)!;
    const earlier = f.groups().admit(90, workerProcessDirectoryId(f.root), group);
    const counters = f.broker.memoryGroups();
    loading.resolve(module);
    expect((await attempt).result).toBe(-ProcessErrno.NOTSUP);
    expect(f.broker.memoryGroups()).toEqual(counters);
    earlier.abort();
    expect((await f.stage(request({ executable: "host" }))).result).toBe(0);
    expect(() => f.groups().admit(91, workerProcessDirectoryId(f.root), group)).toThrow(
      ProcessError,
    );
    expect(() =>
      f.broker.admitRootMemoryGroup(
        f.root.pid,
        {
          module: f.workers[0]!.request.module,
          linkPlan: Reflect.get(f.workers[0]!.request, "linkPlan"),
        },
        group,
      ),
    ).toThrow(ProcessError);
    f.workers[0]!.emit({ type: "replaced" });
    await until(() => f.workers[0]!.stops === 1);
    expect(f.broker.memoryGroupOf(f.pid)).toBe(group);
    expect(f.contexts).toHaveLength(1);
    stopping.resolve();
    await until(() => f.contexts.length === 2);
    expect(f.broker.memoryGroups()).toEqual([]);
    expect(f.contexts[1]!.generation).toBe(2);
  } finally {
    stopping.resolve();
    loading.resolve(module);
    await f.close();
  }
});

for (const phase of ["reserved", "retained", "launched"] as const)
  test(`shared source preserves ${phase} members and group publications on refusal`, async () => {
    const f = await fixture({ shared: true });
    const groups = f.groups();
    const group = f.broker.memoryGroupOf(f.pid)!;
    const publisher = groups.admit(89, workerProcessDirectoryId(f.root), group);
    publisher.launch().request.port.close();
    const owner = groups.owner(group)!;
    const data = owner.request(publisher, GroupOp.CREATE, PAGE_BYTES, PAGE_BYTES)[1]!;
    const cell = owner.request(publisher, GroupOp.CREATE, 16, 16)[1]!;
    const pin = owner.request(publisher, GroupOp.PIN, data)[1]!;
    expect(owner.request(publisher, GroupOp.ROUTE_GROUP, pin)).toEqual([0]);
    expect(owner.request(publisher, GroupOp.PUBLISH, 1, data, cell, 1)[0]).toBe(0);
    publisher.stopped();
    const member = groups.admit(90, workerProcessDirectoryId(f.root), group);
    if (phase !== "reserved") member.launch().request.port.close();
    if (phase === "retained") member.failed();
    try {
      const before = f.broker.memoryGroups();
      expect(before[0]).toMatchObject({ pins: 1, published: 1 });
      expect((await f.stage(request({ executable: "host" }))).result).toBe(-ProcessErrno.NOTSUP);
      expect(f.broker.memoryGroups()).toEqual(before);
      expect(f.table.require(f.pid).image.generation).toBe(1);
    } finally {
      member.stopped();
      await f.close();
    }
  });

for (const phase of ["queued", "reserved", "pending-adapter"] as const)
  test(`an earlier same-directory ${phase} sibling intent cannot be silently declared unrelated`, async () => {
    const late = Promise.withResolvers<import("../proc/types.js").ProcessHandle>();
    const loading = Promise.withResolvers<WebAssembly.Module>();
    const f = await fixture({
      shared: true,
      launch: (context) => {
        if (phase === "pending-adapter" && context.pid !== 2) return late.promise;
      },
    });
    let starting: Promise<void> | undefined;
    try {
      if (phase === "reserved")
        f.registry.register("unresolved-sibling", {
          adapter: "fixture",
          module: () => loading.promise,
        });
      const sibling = f.parent.service.spawn(f.root.pid, {
        ...request({
          cwd: "/",
          executable: phase === "reserved" ? "unresolved-sibling" : "fixture",
        }),
        job: -1,
      });
      const notices = f.notices.splice(0);
      if (phase !== "queued")
        for (const notice of notices) await f.broker.runtimeMessage(notice, f.root.pid);
      if (phase === "pending-adapter") {
        starting = f.supervisor.start(sibling);
        await until(() => f.contexts.length === 2);
      }
      expect((await f.stage(request({ executable: "host" }))).result).toBe(-ProcessErrno.NOTSUP);
      expect(f.table.require(f.pid).image.generation).toBe(1);
      if (phase === "queued")
        for (const notice of notices) await f.broker.runtimeMessage(notice, f.root.pid);
      expect(f.broker.transportFor(sibling)).toBeDefined();
    } finally {
      loading.resolve(module);
      late.resolve({ terminate() {} });
      await starting;
      await f.close();
    }
  });

test("an independently grouped live child survives shared-source exec and legacy PID-only kill", async () => {
  const f = await fixture({ shared: true });
  try {
    const child = f.caller.service.spawn(f.pid, { ...request({ cwd: "/" }), job: -1 });
    await f.flush(f.pid);
    await f.supervisor.start(child);
    const group = f.broker.memoryGroupOf(child);
    expect(group).toBeDefined();
    expect(group).not.toBe(f.broker.memoryGroupOf(f.pid));
    const before = f.table.require(child);
    expect((await f.stage(request({ executable: "host" }))).result).toBe(0);
    f.workers[0]!.emit({ type: "replaced" });
    await until(() => f.contexts.length === 3);
    expect(f.table.require(child)).toBe(before);
    expect(f.broker.memoryGroupOf(child)).toBe(group);
    f.supervisor.kill(f.pid, 9);
    await f.table.require(f.pid).stopping?.complete;
    expect(before.result).toBeNull();
    expect(f.broker.memoryGroupOf(child)).toBe(group);
    expect(f.workers[1]!.stops).toBe(0);
  } finally {
    await f.close();
  }
});

for (const phase of ["lookup", "source-stop", "target-acquisition"] as const)
  test(`shared exec preserves the fatal winner during ${phase} and joins late handles`, async () => {
    const loading = Promise.withResolvers<WebAssembly.Module>();
    const stopping = deferred();
    const acquired = Promise.withResolvers<import("../proc/types.js").ProcessHandle>();
    let lateStops = 0;
    const f = await fixture({
      shared: true,
      stop: phase === "source-stop" ? () => stopping.promise : undefined,
      launch: (context) => {
        if (context.generation === 2 && phase === "target-acquisition") return acquired.promise;
      },
    });
    const record = f.table.require(f.pid);
    try {
      if (phase === "lookup") {
        const target = await f.registry.resolve("host");
        if (target.kind !== "module") throw new Error("expected module target");
        f.registry.register("slow-host", { ...target, module: () => loading.promise });
        const completion = f.caller.service.exec(f.pid, request({ executable: "slow-host" }));
        await f.flush(f.pid);
        await until(() => record.replacement?.state.phase === "resolving");
        f.supervisor.kill(f.pid, 9);
        loading.resolve(module);
        await until(() => readExecCompletion(completion) !== null);
        expect(readExecCompletion(completion)!.result).toBe(-ProcessErrno.SRCH);
      } else {
        expect((await f.stage(request({ executable: "host" }))).result).toBe(0);
        f.workers[0]!.emit({ type: "replaced" });
        await until(() =>
          phase === "source-stop" ? f.workers[0]!.stops === 1 : f.contexts.length === 2,
        );
        f.supervisor.kill(f.pid, 9);
        expect(captureProcessObserver(record.observation).read().kind).not.toBe("terminated");
        acquired.resolve({
          terminate() {
            lateStops++;
          },
        });
        stopping.resolve();
      }
      await until(() => record.result !== null);
      await record.stopping?.complete;
      expect(record.result).toMatchObject({ kind: "signaled", code: 9 });
      expect(f.broker.memoryGroups()).toEqual([]);
      expect(f.contexts).toHaveLength(phase === "target-acquisition" ? 2 : 1);
      expect(lateStops).toBe(phase === "target-acquisition" ? 1 : 0);
    } finally {
      acquired.resolve({
        terminate() {
          lateStops++;
        },
      });
      loading.resolve(module);
      stopping.resolve();
      await f.close();
    }
  });

test("typed shared callers remain unsupported and rejected targets preserve signal dispositions", async () => {
  const f = await fixture({ shared: true, typed: true });
  const record = f.table.require(f.pid);
  try {
    setSignalDisposition(record.signalState, 10, SignalDisposition.HANDLE, record.interrupt);
    setSignalDisposition(record.signalState, 12, SignalDisposition.IGNORE, record.interrupt);
    const before = f.broker.memoryGroups();
    expect((await f.stage(request({ executable: "host" }))).result).toBe(-ProcessErrno.NOTSUP);
    expect(signalDisposition(record.signalState, 10)).toBe(SignalDisposition.HANDLE);
    expect(signalDisposition(record.signalState, 12)).toBe(SignalDisposition.IGNORE);
    expect(f.broker.memoryGroups()).toEqual(before);
    expect(record.image.generation).toBe(1);
  } finally {
    await f.close();
  }
});

test("an opaque sibling acquisition stays visible after it constructs an independent Worker", async () => {
  const acquired = deferred();
  const f = await fixture({
    shared: true,
    acquired: (context) =>
      context.request.argv[0] === "opaque" ? acquired.promise : Promise.resolve(),
  });
  try {
    const pid = f.parent.service.spawn(f.root.pid, {
      ...request({ argv: ["opaque"], cwd: "/" }),
      job: -1,
    });
    await f.flush(f.root.pid);
    await until(() => f.workers.length === 2);
    const groups = f.broker.memoryGroups();
    expect((await f.stage(request({ executable: "host" }))).result).toBe(-ProcessErrno.NOTSUP);
    expect(f.broker.memoryGroups()).toEqual(groups);
    acquired.resolve();
    await f.supervisor.start(pid);
    expect((await f.stage(request({ executable: "host" }))).result).toBe(0);
  } finally {
    acquired.resolve();
    await f.close();
  }
});

test("the classified host successor can spawn ordinary phase children in fresh groups", async () => {
  const f = await fixture({ shared: true });
  try {
    expect((await f.stage(request({ executable: "host" }))).result).toBe(0);
    f.workers[0]!.emit({ type: "replaced" });
    await until(() => f.contexts.length === 2);
    const host = f.client(f.broker.transportFor(f.pid)!);
    const child = host.service.spawn(f.pid, { ...request({ cwd: "/" }), job: -1 });
    await f.flush(f.pid);
    await f.supervisor.start(child);
    expect(f.broker.memoryGroupOf(f.pid)).toBeUndefined();
    expect(f.broker.memoryGroupOf(child)).toBeDefined();
    expect(f.table.require(child).parentPid).toBe(f.pid);
    expect(f.workers).toHaveLength(2);
    expect(f.workers[1]!.stops).toBe(0);
  } finally {
    await f.close();
  }
});

test("a direct broker joins its exact accepted wrapper once through fatal pre-ack disposal", async () => {
  const entered = deferred();
  const released = deferred();
  let stops = 0;
  const f = await fixture({
    shared: true,
    wrap: (handle) => ({
      async terminate() {
        stops++;
        await handle.terminate();
        entered.resolve();
        await released.promise;
      },
    }),
  });
  let disposing: Promise<void> | undefined;
  const record = f.table.require(f.pid);
  try {
    expect((await f.stage(request({ executable: "host" }))).result).toBe(0);
    f.supervisor.kill(f.pid, 9);
    await entered.promise;
    expect(f.workers[0]!.stops).toBe(1);
    expect(f.broker.memoryGroups()[0]?.members).toBe(1);
    disposing = f.broker.dispose();
    expect(captureProcessObserver(record.observation).read().kind).not.toBe("terminated");
    released.resolve();
    await disposing;
    await record.stopping?.complete;
    expect(stops).toBe(1);
    expect(f.broker.memoryGroups()).toEqual([]);
    expect(captureProcessObserver(record.observation).read()).toEqual({ kind: "terminated" });
  } finally {
    released.resolve();
    await disposing;
    await f.close();
  }
});
