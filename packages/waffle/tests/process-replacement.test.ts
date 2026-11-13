import { expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import type { RuntimeWorkerRequest } from "../browser/worker.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  revokeFilesystem,
} from "../fs/protocol.js";
import { controlLoad } from "../proc/control.js";
import { readExecCompletion } from "../proc/exec.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { captureProcessObserver } from "../proc/observation.js";
import { readOutcome } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { setSignalDisposition, SignalDisposition, signalDisposition } from "../proc/signals.js";
import { ProcessTable } from "../proc/table.js";
import { ProcessErrno, type ExecRequest, type ProcessContext } from "../proc/types.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
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
  options: { stop?: () => void | Promise<void>; launch?: (context: ProcessContext) => void } = {},
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
  registry.register("fixture", { adapter: "fixture", module, interruptible: true });
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
      async quiesce() {},
    },
    launch(context) {
      contexts.push(context);
      options.launch?.(context);
      return broker.launchWorker(context, {
        workerUrl: "http://localhost/exec-fixture.ts",
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
        },
      });
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
  const pid = parent.service.spawn(root.pid, { ...request({ cwd: "/" }), job: -1 });
  await flush(root.pid);
  await supervisor.start(pid);
  supervisor.started(pid);
  let caller = client(workers[0]!.request.runtimeProcess!);
  async function stage(spec = request()) {
    const completion = caller.service.exec(pid, spec);
    await flush(pid);
    await until(() => readExecCompletion(completion) !== null);
    return readExecCompletion(completion)!;
  }
  async function replace(spec = request()) {
    const previousCount = workers.length;
    expect((await stage(spec)).result).toBe(0);
    caller.fds.dispose();
    workers[previousCount - 1]!.emit({ type: "replaced" });
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
    supervisor,
    table,
    registry,
    pid,
    root,
    parent,
    contexts,
    workers,
    diagnostics,
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
