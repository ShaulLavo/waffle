import {
  bootstrap,
  describeWorkerError,
  type RuntimeWorkerMessage,
  type WorkerExecutor,
} from "../browser/worker.js";
import { observationModule } from "./fixtures/process-observation-controls.js";
import { standaloneRuntimeProcess } from "./fixtures/standalone-runtime-process.js";
import { expect, spyOn, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createFilesystemConnection, createFilesystemIdentity } from "../fs/protocol.js";
import { TaggedCells, controlLoad } from "../proc/control.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { captureProcessObserver } from "../proc/observation.js";
import { readOutcome, claimOutcome } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { setSignalDisposition, takeSignal } from "../proc/signals.js";
import { ProcessTable } from "../proc/table.js";
import { ProcessError, ProcessErrno, type ProcessContext } from "../proc/types.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { testReservations } from "./fixtures/shared-memory-platform.js";

const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

async function fixture() {
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module: emptyModule, adapter: "fixture", interruptible: true });
  const diagnostics: unknown[] = [];
  const contexts = new Map<number, ProcessContext>();
  const stops: number[] = [];
  const acknowledgements = new Map<number, boolean>();
  const heldStops = new Map<number, Promise<void>>();
  const messages: WorkerProcessMessage[] = [];
  const descriptorTables: DescriptorTable[] = [];
  let rootStops = 0;
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table,
    registry,
    filesystem: {
      connect() {
        throw new Error("No filesystem service or real worker belongs to this control");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    onError(error) {
      diagnostics.push(error);
    },
    launch(context) {
      contexts.set(context.pid, context);
      broker.registerController(context.pid, {
        canConfirmExit: () => acknowledgements.get(context.pid) !== false,
      });
      return {
        terminate() {
          stops.push(context.pid);
          return heldStops.get(context.pid);
        },
      };
    },
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
    capacity: 12,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  function client(transport: typeof root) {
    const descriptors = new DescriptorTable();
    descriptorTables.push(descriptors);
    return new WorkerProcessClient({
      transport,
      descriptors,
      codec: {
        export() {
          throw new Error("No descriptors exported");
        },
        import() {
          throw new Error("No descriptors imported");
        },
        discard() {},
      },
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
      postMessage(message) {
        messages.push(message);
      },
    });
  }
  await broker.adoptRuntimeRoot(root, {
    memory: [],
    stop() {
      rootStops++;
    },
  });
  const supervisor = await broker.ready();
  const shell = client(root);
  setSignalDisposition(shell.signals.signalState, 2, 2);
  async function drain() {
    while (messages.length) {
      const message = messages.shift();
      if (!message) throw new Error("Missing queued message");
      const sender =
        message.operation === "spawn"
          ? workerProcessState(message.transport).parentPid
          : message.transport.pid;
      await broker.runtimeMessage(message, sender);
    }
  }
  async function spawn(parent: WorkerProcessClient, job: number) {
    const pid = parent.spawn(parent.pid, {
      executable: "fixture",
      argv: [],
      env: {},
      cwd: "/",
      job,
      fds: [],
    });
    await drain();
    await supervisor.start(pid);
    const transport = broker.transportFor(pid);
    if (!transport) throw new Error("Missing admitted child");
    const state = workerProcessState(transport);
    return { pid, parent, transport, state, client: client(transport) };
  }
  async function close() {
    acknowledgements.clear();
    for (const descriptors of descriptorTables) descriptors.dispose();
    await broker.dispose();
    expect(Array.from(table.values())).toEqual([]);
    expect(diagnostics).toEqual([]);
  }
  return {
    broker,
    supervisor,
    shell,
    root,
    spawn,
    drain,
    contexts,
    stops,
    acknowledgements,
    heldStops,
    diagnostics,
    close,
    rootStops: () => rootStops,
  };
}

async function pipeline() {
  const f = await fixture();
  try {
    const stage = await f.spawn(f.shell, 0);
    const job = stage.state.job;
    const grep = await f.spawn(f.shell, job);
    const emit = await f.spawn(stage.client, job);
    const yes = await f.spawn(stage.client, job);
    const cat = await f.spawn(stage.client, job);
    f.supervisor.exit(emit.pid, 0);
    await f.supervisor.waitForExit(stage.pid, emit.pid);
    return { ...f, stage, grep, emit, yes, cat, job };
  } catch (error) {
    await f.close();
    throw error;
  }
}

async function exercisePipeline(gateway: "host" | "worker", collection: "before" | "captured") {
  const f = await pipeline();
  let hook: ReturnType<typeof spyOn> | undefined;
  let collected = false;
  const collect = () => {
    collected = true;
    expect(f.stage.client.wait(f.stage.pid, f.emit.pid)).toMatchObject({ kind: "exited", code: 0 });
  };
  const original = TaggedCells.prototype.load;
  function load(this: TaggedCells, index = 0) {
    if (
      !collected &&
      this.id === f.stage.pid &&
      this.byteOffset === f.stage.state.signals.requestedSignal.byteOffset
    )
      collect();
    return Reflect.apply(original, this, [index]);
  }
  try {
    if (collection === "before") collect();
    else hook = spyOn(TaggedCells.prototype, "load").mockImplementation(load);
    const lives = [f.stage, f.grep, f.yes, f.cat];
    const waiting = Promise.all(
      lives.map((child) => f.supervisor.waitForExit(child.parent.pid, child.pid)),
    );
    if (gateway === "host") await f.broker.killJob(f.job, 2);
    else f.shell.killJob(f.job, 2);
    hook?.mockRestore();
    hook = undefined;
    expect(collected).toBe(true);
    for (const child of lives)
      expect(readOutcome(child.state.signals.outcome)).toMatchObject({ kind: "signaled", code: 2 });
    await f.drain();
    const exits = await waiting;
    expect(exits.every((result) => result.kind === "signaled" && result.code === 2)).toBe(true);
    expect(f.shell.waitJob(f.shell.pid, f.job)).toMatchObject({ kind: "signaled", code: 2 });
    await f.drain();
    expect(f.supervisor.get(f.shell.pid)?.result).toBeNull();
    expect(readOutcome(f.shell.signals.outcome)).toBeNull();
    expect(f.rootStops()).toBe(0);
    expect(f.stops.sort()).toEqual(
      lives
        .map((child) => child.pid)
        .concat([f.emit.pid])
        .sort(),
    );
    expect(f.diagnostics).toEqual([]);
  } finally {
    hook?.mockRestore();
    await f.close();
  }
}

for (const gateway of ["host", "worker"] as const) {
  for (const collection of ["before", "captured"] as const) {
    test(`pipeline SIGINT via ${gateway}, emit collection ${collection} signal publication`, () =>
      exercisePipeline(gateway, collection));
  }
}

test("queued ordinary exit remains ordinary and uncollectible until acknowledgement", async () => {
  const f = await fixture();
  try {
    const child = await f.spawn(f.shell, 0);
    f.acknowledgements.set(child.pid, false);
    child.client.exit(23);
    expect(readOutcome(child.state.signals.outcome)).toMatchObject({ kind: "exited", code: 23 });
    await f.broker.killJob(child.state.job, 2);
    await f.drain();
    expect(f.supervisor.get(child.pid)?.result).toBeNull();
    expect(controlLoad(child.state.confirmed)).toBe(0);
    expect(f.shell.wait(f.shell.pid, child.pid)).toBeNull();
    expect(f.stops).toEqual([]);
    f.acknowledgements.set(child.pid, true);
    f.supervisor.exit(child.pid, 23);
    expect(await f.supervisor.waitForExit(f.shell.pid, child.pid)).toMatchObject({
      kind: "exited",
      code: 23,
    });
    expect(f.shell.waitJob(f.shell.pid, child.state.job)).toMatchObject({
      kind: "exited",
      code: 23,
    });
    await f.drain();
    expect(f.rootStops()).toBe(0);
  } finally {
    await f.close();
  }
});

test("retained raw controls reproduce exact error after legitimate wait; observation is separate", async () => {
  const f = await fixture();
  try {
    const child = await f.spawn(f.shell, 0);
    const observer = captureProcessObserver(child.transport);
    const context = f.contexts.get(child.pid);
    if (!context) throw new Error("Missing fake launch context");
    f.supervisor.exit(child.pid, 0);
    await f.supervisor.waitForExit(f.shell.pid, child.pid);
    expect(f.shell.wait(f.shell.pid, child.pid)).toMatchObject({ kind: "exited", code: 0 });
    const stale = () => readOutcome(context.outcome);
    expect(stale).toThrow(ProcessError);
    expect(() => claimOutcome(context.outcome, { kind: "signaled", code: 2 })).toThrow(
      ProcessError,
    );
    expect(() => workerProcessState(child.transport)).toThrow(ProcessError);
    expect(() => child.client.exit(99)).toThrow(ProcessError);
    expect(observer.read().kind).toBe("terminated");
    const successor = await f.spawn(f.shell, 0);
    expect(successor.state.slot).toBe(child.state.slot);
    expect(readOutcome(successor.state.signals.outcome)).toBeNull();
    expect(stale).toThrow(ProcessError);
    expect(() => child.client.exit(99)).toThrow(ProcessError);
    expect(() => claimOutcome(context.outcome, { kind: "signaled", code: 2 })).toThrow(
      ProcessError,
    );
    expect(readOutcome(successor.state.signals.outcome)).toBeNull();
    expect(readOutcome(f.shell.signals.outcome)).toBeNull();
  } finally {
    await f.close();
  }
});

test("handled shell SIGINT remains pending until explicitly taken", async () => {
  const f = await fixture();
  try {
    await f.broker.kill(f.shell.pid, 2);
    expect(readOutcome(f.shell.signals.outcome)).toBeNull();
    expect(takeSignal(f.shell.signals.signalState, f.shell.signals.interrupt)).toBe(2);
    expect(takeSignal(f.shell.signals.signalState, f.shell.signals.interrupt)).toBe(0);
    expect(f.rootStops()).toBe(0);
  } finally {
    await f.close();
  }
});

async function bootstrapCollection(
  kind: "exited" | "signaled",
  collection: "run" | "before-finish" = "run",
  cleanupError?: Error,
) {
  const f = await fixture();
  const child = await f.spawn(f.shell, 0);
  const stop = Promise.withResolvers<void>();
  f.heldStops.set(child.pid, stop.promise);
  f.acknowledgements.set(child.pid, false);
  const observer = captureProcessObserver(child.transport);
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [];
  const waiting = f.supervisor.waitForExit(f.shell.pid, child.pid);
  let descriptors: DescriptorTable | undefined;
  let releases = 0;
  const selected = { kind, code: kind === "exited" ? 126 : 2 };
  const collect = () => {
    expect(f.acknowledgements.get(child.pid)).toBe(false);
    expect(f.shell.wait(f.shell.pid, child.pid)).toMatchObject(selected);
    expect(observer.read()).toMatchObject({ kind: "selected", result: selected });
    expect(() => child.client.exit(99)).toThrow(ProcessError);
  };
  const executor: WorkerExecutor = {
    setup({ fs }) {
      fs.preopen = () => 1;
      fs.retain = () => {};
      fs.release = () => {
        releases++;
      };
    },
    beforeBindings({ wasi }) {
      descriptors = wasi.descriptors;
    },
    beforeFinish() {
      if (collection === "before-finish") collect();
      if (cleanupError) throw cleanupError;
    },
    namespaces() {
      return { env: { held() {} } };
    },
    async run(context) {
      const host = f.contexts.get(child.pid);
      if (!host) throw new Error("Missing host-owned launch context");
      if (kind === "exited") host.fail(new Error("Test-owned host dispatch failure"));
      else await f.broker.kill(child.pid, 2);
      expect(await waiting).toMatchObject(selected);
      if (collection === "run") collect();
      expect(observer.read()).toMatchObject({ kind: "selected", result: selected });
      context.checkActive();
      throw new Error("A collected terminal process must never continue");
    },
  };
  try {
    await bootstrap(
      {
        module: observationModule,
        args: [],
        env: {},
        runtimeProcess: standaloneRuntimeProcess(child.transport),
        controlGrant: { kind: "unbounded" },
        filesystem: connection.client,
      },
      executor,
      {
        crossOriginIsolated: true,
        postMessage(message) {
          messages.push(message);
        },
      },
    );
    expect(releases).toBe(1);
    expect(descriptors).toBeDefined();
    expect(descriptors?.rootPreopen()).toBeUndefined();
    expect(descriptors?.inheritable()).toEqual([]);
    expect(
      Atomics.load(new Int32Array(connection.client.ownerStates), connection.client.owner),
    ).toBe(2);
    expect(f.stops).toEqual([child.pid]);
    expect(observer.read()).toMatchObject({ kind: "selected", result: selected });
    const successor = await f.spawn(f.shell, 0);
    expect(successor.state.slot).not.toBe(child.state.slot);
    expect(readOutcome(successor.state.signals.outcome)).toBeNull();
    expect(() => child.client.exit(99)).toThrow(ProcessError);
    expect(readOutcome(successor.state.signals.outcome)).toBeNull();
    return messages;
  } finally {
    stop.resolve();
    connection.client.port.close();
    connection.server.port.close();
    await f.close();
  }
}

for (const boundary of ["run", "before-finish"] as const)
  test(`selected host failure and SIGINT finish after collection at ${boundary} without secondary cleanup errors`, async () => {
    const ordinary = await bootstrapCollection("exited", boundary);
    const signaled = await bootstrapCollection("signaled", boundary);
    const ordinaryExit = ordinary.find((message) => message.type === "exit");
    const signaledExit = signaled.find((message) => message.type === "exit");
    expect(ordinaryExit).toMatchObject({ type: "exit", code: 126, signal: undefined });
    expect(signaledExit).toMatchObject({ type: "exit", code: 130, signal: 2 });
    if (ordinaryExit?.type !== "exit" || signaledExit?.type !== "exit")
      throw new Error("Missing typed exit");
    expect(ordinaryExit.cleanupErrors).toBeUndefined();
    expect(signaledExit.cleanupErrors).toBeUndefined();
  });

for (const cleanupError of [
  new Error("unrelated cleanup callback failure"),
  new ProcessError(ProcessErrno.SRCH, "unrelated callback authority failure"),
  new ProcessError(ProcessErrno.CHILD, "unrelated callback child failure"),
])
  test(`selected completion retains ${cleanupError.name}: ${cleanupError.message}`, async () => {
    const messages = await bootstrapCollection("exited", "before-finish", cleanupError);
    const exit = messages.find((message) => message.type === "exit");
    expect(exit).toMatchObject({ type: "exit", code: 126, signal: undefined });
    if (exit?.type !== "exit") throw new Error("Missing typed exit");
    expect(exit.cleanupErrors).toEqual([describeWorkerError(cleanupError)]);
  });
