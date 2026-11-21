import { expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createFilesystemIdentity, type FilesystemIdentity } from "../fs/protocol.js";
import { commandExecTransfer, commandTransferBytes } from "../proc/command-transfer.js";
import { controlLoad } from "../proc/control.js";
import {
  directoryAdmissionVersion,
  findDirectoryJob,
  findDirectoryProcess,
} from "../proc/directory.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { readOutcome } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import type { ProcessContext, SpawnRequest } from "../proc/types.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerDescriptorCodec,
  type WorkerProcessClientOptions,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import { testReservations } from "./fixtures/shared-memory-platform.js";

const ready = () => {};
const executable = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request: SpawnRequest = {
  executable: "/guest",
  argv: ["guest"],
  cwd: "/",
  env: {},
  job: -1,
  fds: [],
};
const noDescriptors: WorkerDescriptorCodec = {
  export() {
    throw Error("unexpected descriptor export");
  },
  import() {
    throw Error("unexpected descriptor import");
  },
  discard() {},
};

interface FixtureOptions {
  launch?: (context: ProcessContext) => void | Promise<void>;
  quiesce?: (filesystem: FilesystemIdentity) => void | Promise<void>;
  queued?: (root: WorkerProcessTransport, broker: BrowserProcessBroker) => void;
  capacity?: number;
}

async function fixture(options: FixtureOptions = {}) {
  const calls: number[] = [];
  const diagnostics: unknown[] = [];
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const registry = new ExecutableRegistry();
  const launch = (context: ProcessContext) => {
    calls.push(context.pid);
    const pending = options.launch?.(context);
    const handle = { terminate: ready };
    return pending ? pending.then(() => handle) : handle;
  };
  registry.register("/guest", {
    module: executable,
    adapter: "test",
    interruptible: true,
    execution: { kind: "guest", launch },
  });
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    launch,
    reservations: testReservations(),
    filesystem: {
      connect() {
        throw Error("this control never starts a Worker");
      },
      revoke: ready,
      reap: ready,
      async quiesce(filesystem) {
        await options.quiesce?.(filesystem);
      },
    },
    onProcessAdmission(event) {
      if (event.stage === "queued") options.queued?.(root, broker);
    },
    onError(error) {
      diagnostics.push(error);
    },
  });
  const transport = createWorkerProcessTransport({
    identity: identities.buffer,
    capacity: options.capacity ?? 6,
  });
  const root = {
    ...transport,
    commandTransfer: new SharedArrayBuffer(commandTransferBytes(transport.directory)),
  };
  const filesystem = createFilesystemIdentity();
  const supervisor = await broker.ready();
  await broker.adoptCommandRoot(root, { memory: [], filesystem, stop: ready });
  const notices: WorkerProcessMessage[] = [];
  const descriptors = new DescriptorTable();
  const client = (
    transport: WorkerProcessTransport = root,
    overrides: Partial<WorkerProcessClientOptions> = {},
  ) =>
    new WorkerProcessClient({
      transport,
      descriptors,
      codec: noDescriptors,
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(filesystem) } }),
      postMessage: (message) => notices.push(message),
      ...overrides,
    });
  function spawn(source = client(), input = request) {
    const pid = source.spawn(source.pid, input);
    const message = notices.shift();
    if (message?.operation !== "spawn") throw new Error("No published spawn");
    return { pid, message, transport: message.transport };
  }
  function close() {
    descriptors.dispose();
    return broker.dispose().catch(() => {});
  }
  return { calls, diagnostics, root, broker, supervisor, spawn, close, client, descriptors };
}

async function until(test: () => boolean) {
  const abort = AbortSignal.timeout(5000);
  while (!test()) {
    if (abort.aborted) throw new Error("command scope did not settle");
    await Bun.sleep(0);
  }
}

for (const stage of ["before publication", "after publication", "queued admission"] as const) {
  test(`stop while a spawn holds directory admission at ${stage}`, async () => {
    const f = await fixture({
      queued:
        stage === "queued admission" ? (root, broker) => broker.stopCommandRoot(root) : undefined,
    });
    try {
      const events: string[] = [];
      let pending: Promise<void> | undefined;
      let transferred: WorkerProcessTransport | undefined;
      const source = f.client(f.root, {
        beginSpawnTransfer() {
          expect(() => directoryAdmissionVersion(f.root.directory)).not.toThrow();
          events.push("enter");
          return () => {
            expect(() => directoryAdmissionVersion(f.root.directory)).not.toThrow();
            events.push("leave");
          };
        },
        prepareSpawn() {
          expect(() => directoryAdmissionVersion(f.root.directory)).toThrow("unresolved");
          if (stage === "before publication") f.broker.stopCommandRoot(f.root);
          return { data: { filesystem: createFilesystemIdentity() } };
        },
        postMessage(message) {
          if (message.operation !== "spawn") throw new Error("expected spawn");
          transferred = message.transport;
          expect(() => directoryAdmissionVersion(f.root.directory)).toThrow("unresolved");
          pending = f.broker.runtimeMessage(message, f.root.pid).catch(() => {});
          if (stage === "after publication") f.broker.stopCommandRoot(f.root);
          expect(f.broker.checkCommandCleanup(f.root, false)).toBe(false);
        },
      });
      source.spawn(source.pid, request);
      if (!transferred) throw new Error("missing transfer");
      const state = workerProcessState(transferred);
      await pending;
      await until(() => controlLoad(state.confirmed) === 1);
      expect(readOutcome(state.signals.outcome)?.kind).toBe("signaled");
      await until(() => f.broker.checkCommandCleanup(f.root, true));
      await f.broker.retireCommandRoot(f.root);
      expect(events).toEqual(["enter", "leave"]);
      expect(f.calls).toEqual([]);
      expect(Array.from(f.supervisor.table.values())).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

for (const location of ["direct rejection", "queued rejection"] as const) {
  test(`command cleanup retains the failed transfer from ${location}`, async () => {
    const fail = new Error("unconfirmed rejected transfer");
    let fenceEntered = false;
    const f = await fixture({
      queued:
        location === "queued rejection"
          ? (root, broker) => broker.stopCommandRoot(root)
          : undefined,
      quiesce: () => {
        fenceEntered = true;
        throw fail;
      },
    });
    try {
      const child = f.spawn();
      if (location === "direct rejection") f.broker.stopCommandRoot(f.root);
      await f.broker.runtimeMessage(child.message, f.root.pid).catch(() => {});
      await until(() => f.diagnostics.length > 0);
      expect(fenceEntered).toBe(true);
      expect(controlLoad(workerProcessState(child.transport).confirmed)).toBe(0);
      expect(() => f.broker.checkCommandCleanup(f.root, true)).toThrow("transfer cleanup failed");
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test("failed spawn rollback without a child row is observable before the producer leaves", async () => {
  const f = await fixture({ capacity: 1 });
  try {
    let freed = false;
    const source = f.client(f.root, {
      beginSpawnTransfer: () => () => {
        freed = true;
      },
      prepareSpawn: () => ({
        cancel() {
          throw new Error("cancel left retained data");
        },
      }),
    });
    expect(() => source.spawn(source.pid, request)).toThrow();
    expect(freed).toBe(true);
    expect(() => f.broker.checkCommandCleanup(f.root, true)).toThrow("Spawn transfer to process");
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a collected process still holds its command until its late adapter handle returns", async () => {
  const entered = Promise.withResolvers<ProcessContext>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({
    launch(context) {
      context.started();
      entered.resolve(context);
      return release.promise;
    },
  });
  try {
    const child = f.spawn();
    const { job } = workerProcessState(child.transport);
    await f.broker.runtimeMessage(child.message, f.root.pid);
    const context = await entered.promise;
    context.exit(0);
    await until(() => controlLoad(workerProcessState(child.transport).confirmed) === 1);
    expect(f.supervisor.waitJob(f.root.pid, job)).toMatchObject({ kind: "exited", code: 0 });
    expect(findDirectoryJob(f.root.directory, job)).toBeUndefined();
    expect(f.broker.checkCommandCleanup(f.root, true)).toBe(false);
    release.resolve();
    await until(() => f.broker.checkCommandCleanup(f.root, true));
    await f.broker.retireCommandRoot(f.root);
    expect(f.supervisor.get(child.pid)).toBeUndefined();
  } finally {
    release.resolve();
    await f.close();
  }
});

test("descriptor rollback failure keeps the exact unpublished child unconfirmed", async () => {
  const f = await fixture();
  const cause = new Error("discard did not release the transferred description");
  try {
    const stream = () => ({
      kind: "pipe" as const,
      read: () => 0,
      write: () => 0,
      readiness: () => ({ readable: true, writable: true, hangup: false }),
    });
    for (const fd of [0, 1]) f.descriptors.openAt(fd, stream(), 0n, 0n);
    const target = Promise.withResolvers<number>();
    let published = false;
    let exported = false;
    const source = f.client(f.root, {
      postMessage: () => {
        published = true;
      },
      codec: {
        ...noDescriptors,
        export(_descriptor, pid) {
          if (exported) throw new Error("second descriptor export failed");
          exported = true;
          target.resolve(pid);
          return { kind: "retained" };
        },
        discard() {
          throw cause;
        },
      },
    });
    expect(() =>
      source.spawn(source.pid, {
        ...request,
        fds: [
          { parent: 0, child: 0 },
          { parent: 1, child: 1 },
        ],
      }),
    ).toThrow("second descriptor export failed");
    expect(published).toBe(false);
    const pid = await target.promise;
    const state = findDirectoryProcess(f.root, pid);
    expect(state).toBeDefined();
    expect(state && controlLoad(state.confirmed)).toBe(0);
    expect(() => f.broker.checkCommandCleanup(f.root, true)).toThrow(
      `Spawn transfer to process ${pid}`,
    );
  } finally {
    await f.close();
  }
});

test("a staged exec rejection holds the source and reports the exact failure", async () => {
  const staged = createFilesystemIdentity();
  const fence = Promise.withResolvers<void>();
  const fenced = Promise.withResolvers<void>();
  const failure = new Error("staged filesystem release failed");
  const f = await fixture({
    launch: (context) => {
      context.started();
    },
    quiesce: (identity) => {
      if (identity !== staged) return;
      fenced.resolve();
      return fence.promise;
    },
  });
  try {
    const child = f.spawn();
    await f.broker.runtimeMessage(child.message, f.root.pid);
    await f.supervisor.start(child.pid);
    const stagedMessage =
      Promise.withResolvers<Extract<WorkerProcessMessage, { operation: "exec" }>>();
    const source = f.client(child.transport, {
      prepareExec: () => ({ data: { filesystem: staged } }),
      registerRevocation: () => ready,
      postMessage(message) {
        if (message.operation !== "exec") throw new Error("expected exec");
        stagedMessage.resolve(message);
      },
    });
    source.exec(child.pid, request);
    const message = await stagedMessage.promise;
    const state = workerProcessState(child.transport);
    const handoff = commandExecTransfer(child.transport);
    if (!handoff) throw new Error("missing scoped exec handoff");
    expect(controlLoad(handoff)).toBe(2);
    f.broker.rejectRuntimeMessage(message, child.pid);
    await fenced.promise;
    f.broker.stopCommandRoot(f.root);
    expect(f.broker.checkCommandCleanup(f.root, true)).toBe(false);
    expect(controlLoad(state.confirmed)).toBe(0);
    fence.reject(failure);
    await until(() => f.diagnostics.includes(failure));
    expect(() => f.broker.checkCommandCleanup(f.root, true)).toThrow("transfer cleanup failed");
    expect(controlLoad(handoff)).toBe(2);
    expect(controlLoad(state.confirmed)).toBe(0);
  } finally {
    fence.resolve();
    await f.close();
  }
});

test("the leader can exit while an independent child's real retirement fences remain pending", async () => {
  const contexts = new Map<number, ProcessContext>();
  const release = Promise.withResolvers<void>();
  let held: FilesystemIdentity | undefined;
  const f = await fixture({
    launch(context) {
      contexts.set(context.pid, context);
      context.started();
    },
    quiesce(identity) {
      if (identity === held) return release.promise;
    },
  });
  try {
    const leader = f.spawn();
    await f.broker.runtimeMessage(leader.message, f.root.pid);
    await f.supervisor.start(leader.pid);
    held = createFilesystemIdentity();
    const child = f.spawn(
      f.client(leader.transport, {
        prepareSpawn: () => ({ data: { filesystem: held } }),
      }),
    );
    await f.broker.runtimeMessage(child.message, leader.pid);
    await f.supervisor.start(child.pid);
    const parent = contexts.get(leader.pid);
    const descendant = contexts.get(child.pid);
    if (!parent || !descendant) throw new Error("missing process adapter");
    const outcome = workerProcessState(leader.transport).jobOutcome;
    parent.exit(17);
    await until(() => readOutcome(outcome)?.code === 17);
    expect(f.broker.checkCommandCleanup(f.root, true)).toBe(false);
    f.broker.stopCommandRoot(f.root);
    expect(f.broker.checkCommandCleanup(f.root, true)).toBe(false);
    const childState = workerProcessState(child.transport);
    expect(readOutcome(childState.signals.outcome)).toMatchObject({ kind: "signaled", code: 9 });
    expect(controlLoad(childState.confirmed)).toBe(0);
    release.resolve();
    await until(() => f.broker.checkCommandCleanup(f.root, true));
    await f.broker.retireCommandRoot(f.root);
  } finally {
    release.resolve();
    await f.close();
  }
});
