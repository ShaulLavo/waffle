import { fixtureSpawnRequest as request } from "./fixtures/spawn-request.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { DescriptorTable, type Stream } from "../core/descriptors.js";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  connectFilesystemIdentity,
  createFilesystemConnection,
  createProcessFilesystemIdentity,
} from "../fs/index.js";

import type { PipeEndpointHandle, PipePublicationRegistryHandle } from "../proc/pipes.js";
type PipeController = import("../proc/pipes.js").PipeController;
type PipeEndpoint = import("../proc/pipes.js").PipeEndpoint;

import type { WorkerProcessMessage, WorkerProcessTransport } from "../proc/worker-client.js";
type WorkerPipeBroker = import("../proc/worker-pipes.js").WorkerPipeBroker;
type WorkerPipeHost = import("../proc/worker-pipes.js").WorkerPipeHost;
import type { ProcessContext } from "../proc/types.js";
type ProcessError = import("../proc/types.js").ProcessError;
import { isolatedProcess } from "./fixtures/isolated-process.js";

const isolated = await isolatedProcess();
const Atomics = isolated.atomics;
const { createFilesystemDescriptorCodec } =
  isolated.load<typeof import("../proc/filesystem-codec.js")>("filesystem-codec");
const { PipeController, PipeEndpoint, PipeErrno, PipePublicationRegistry, attachPipeEndpoint } =
  isolated.load<typeof import("../proc/pipes.js")>("pipes");
const { directoryJobs } = isolated.load<typeof import("../proc/directory.js")>("directory");
const { ExecutableRegistry } = isolated.load<typeof import("../proc/registry.js")>("registry");
const { ProcessSupervisor } = isolated.load<typeof import("../proc/supervisor.js")>("supervisor");
const { WorkerProcessBroker } =
  isolated.load<typeof import("../proc/worker-broker.js")>("worker-broker");
const {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessSlots,
  workerProcessState,
} = isolated.load<typeof import("../proc/worker-client.js")>("worker-client");
const { WorkerPipeBroker, WorkerPipeHost, createWorkerPipeCodec, isWorkerPipeDescriptorToken } =
  isolated.load<typeof import("../proc/worker-pipes.js")>("worker-pipes");
const { ProcessError } = isolated.load<typeof import("../proc/types.js")>("types");

const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

function output(endpoint: PipeEndpoint, capacity = 64): number | string {
  const bytes = new Uint8Array(capacity);
  const size = endpoint.tryRead([bytes]);
  return size < 0 ? size : decoder.decode(bytes.subarray(0, size));
}
async function expectRetired(broker: WorkerPipeBroker): Promise<void> {
  const deadline = performance.now() + 1000;
  while (broker.size !== 0 && performance.now() < deadline) await Bun.sleep(1);
  expect(broker.size).toBe(0);
}
function pairFixture(
  relay: "auto" | "manual" = "manual",
  cellsPerProcess = 32,
  processCapacity = 16,
) {
  const transport = createWorkerProcessTransport({ capacity: processCapacity });
  const messages: WorkerProcessMessage[] = [];
  const registry = new PipePublicationRegistry({
    processCapacity,
    cellsPerProcess,
    wake: workerProcessState(transport).wake,
  });
  registry.registerProcess(1);
  const broker = new WorkerPipeBroker({ relay });
  const host = new WorkerPipeHost({
    transport,
    registry,
    postMessage: (message) => messages.push(structuredClone(message)),
    pipe: { capacity: 8, maxWriters: 4, maxReaders: 4 },
  });
  cleanups.push(() => broker.dispose());
  return { transport, messages, registry, broker, host };
}
function processFixture(cellsPerProcess = 32, processCapacity = 16) {
  const pair = pairFixture("manual", cellsPerProcess, processCapacity);
  const executableRegistry = new ExecutableRegistry();
  executableRegistry.register("fixture", { module: emptyModule, adapter: "preview1" });
  const contexts = new Map<number, ProcessContext>();
  const supervisor = new ProcessSupervisor({
    registry: executableRegistry,
    launch(context) {
      contexts.set(context.pid, context);
      return { terminate() {} };
    },
  });
  const rootState = workerProcessState(pair.transport);
  supervisor.createRoot({
    pid: rootState.pid,
    job: rootState.job,
    observation: pair.transport,
    ...rootState.signals,
  });
  const processes = new WorkerProcessBroker({
    supervisor: async () => supervisor,
    codec: () => pair.broker.codec(),
    onPipe: (handle) => pair.broker.attach(handle as PipeEndpointHandle),
    pumpPipes: () => pair.broker.pump(),
  });
  processes.adoptRoot(pair.transport);
  const tables: DescriptorTable[] = [];
  cleanups.push(() => {
    for (const table of tables) table.dispose();
    processes.dispose();
    supervisor.dispose();
  });
  function client(transport: WorkerProcessTransport, host: WorkerPipeHost) {
    const descriptors = new DescriptorTable();
    tables.push(descriptors);
    return new WorkerProcessClient({
      transport,
      descriptors,
      codec: host.codec(),
      createPipe: () => host.createPipe(),
      revokeProcess: (pid) => host.revokeProcess(pid),
      postMessage: (message) => pair.messages.push(structuredClone(message)),
      prepareSpawn: (pid) => {
        host.registry.registerProcess(pid);
        return {
          data: { pipeRegistry: host.registry.handle() },
          cancel: () => host.registry.collectProcess(pid),
        };
      },
    });
  }
  const root = client(pair.transport, pair.host);
  return {
    ...pair,
    contexts,
    processes,
    supervisor,
    root,
    child(pid: number) {
      const transport = structuredClone(processes.get(pid)!);
      const data = transport.data as { pipeRegistry: PipePublicationRegistryHandle };
      const host = new WorkerPipeHost({
        transport,
        registry: data.pipeRegistry,
        postMessage: (message) => pair.messages.push(structuredClone(message)),
        pipe: { capacity: 8, maxWriters: 4, maxReaders: 4 },
      });
      const guest = client(transport, host);
      guest.installBindings();
      return { host, guest };
    },
    async flush() {
      while (pair.messages.length) await processes.handle(pair.messages.shift()!);
    },
  };
}

test("worker pipe factory synchronously creates shared-wake endpoints and announces a manual controller", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => {
    reader.close();
    writer.close();
  });
  expect(reader).toBeInstanceOf(PipeEndpoint);
  expect(f.messages).toHaveLength(1);
  const notice = f.messages[0]!;
  expect(notice.operation).toBe("pipe");
  if (notice.operation !== "pipe") throw new Error("not a pipe notice");
  // Attaching succeeds only when the worker has not already claimed the relay supervisor.
  f.broker.attach(notice.handle as PipeEndpointHandle);
  expect(writer.tryWrite([encoder.encode("hello")])).toBe(5);
  expect(output(reader)).toBe("hello");
  expect(Atomics.load(workerProcessState(f.transport).wake, 0)).toBeGreaterThan(0);
});

test("broker deduplicates structured-cloned SAB wrappers using the stable pipe id", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => {
    reader.close();
    writer.close();
  });
  const first = f.broker.attach(structuredClone(reader.handle()));
  const second = f.broker.attach(structuredClone(writer.handle()));
  expect(second).toBe(first);
  expect(f.broker.size).toBe(1);
});

test("broker retires closed pipes across repeated default-capacity shell pipelines", () => {
  const transport = createWorkerProcessTransport();
  const broker = new WorkerPipeBroker({ relay: "manual" });
  const host = new WorkerPipeHost({ transport, postMessage() {} });
  cleanups.push(() => broker.dispose());
  for (let iteration = 0; iteration < 4; iteration++) {
    const [reader, writer] = host.createPipe();
    cleanups.push(() => {
      reader.close();
      writer.close();
    });
    broker.attach(structuredClone(reader.handle()));
    expect(broker.size).toBe(1);
    reader.close();
    writer.close();
    broker.pump();
    expect(broker.size).toBe(0);
  }
});

test("automatic broker retires final-closed pipes without another embedding pump", async () => {
  const f = pairFixture("auto");
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => {
    reader.close();
    writer.close();
  });
  f.broker.attach(structuredClone(reader.handle()));
  reader.close();
  writer.close();
  await expectRetired(f.broker);
});

test("automatic broker retires registry-revoked endpoints without guest cleanup", async () => {
  const f = pairFixture("auto");
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => {
    reader.close();
    writer.close();
  });
  f.broker.attach(structuredClone(reader.handle()));
  f.host.revokeProcess(1);
  await expectRetired(f.broker);
});

test("broker keeps pipes alive for transferred descendants and EOF readers", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  f.registry.registerProcess(2);
  const inherited = writer.forProcess(2);
  cleanups.push(() => {
    reader.close();
    writer.close();
    inherited.close();
  });
  f.broker.attach(structuredClone(reader.handle()));
  writer.close();
  f.broker.pump();
  expect(f.broker.size).toBe(1);
  expect(inherited.tryWrite([encoder.encode("child")])).toBe(5);
  inherited.close();
  f.broker.pump();
  expect(f.broker.size).toBe(1);
  expect(output(reader)).toBe("child");
  expect(output(reader)).toBe("");
  reader.close();
  f.broker.pump();
  expect(f.broker.size).toBe(0);
});

test("already-closed pipe announcements do not retain a relay controller", async () => {
  const f = pairFixture("auto");
  const [reader, writer] = f.host.createPipe();
  const handle = structuredClone(reader.handle());
  cleanups.push(() => {
    reader.close();
    writer.close();
  });
  reader.close();
  writer.close();
  f.broker.attach(handle);
  await expectRetired(f.broker);
  // A duplicated/delayed notice cannot resurrect the same dead pipe's background relay.
  f.broker.attach(structuredClone(handle));
  await expectRetired(f.broker);
});

test("codec reserves inherited endpoint refs before return and preserves data after the parent closes", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  const parent = new DescriptorTable();
  cleanups.push(() => parent.dispose());
  const fd = parent.open(writer, 127n, 63n);
  f.registry.registerProcess(2);
  const token = f.host.codec().export(parent.get(fd)!, 2);
  expect(isWorkerPipeDescriptorToken(token)).toBe(true);
  parent.close(fd);
  const child = new DescriptorTable();
  cleanups.push(() => child.dispose());
  child.add(f.broker.codec().import(structuredClone(token), 2), {
    rightsBase: 127n,
    rightsInheriting: 63n,
  });
  const inherited = child.get(0)!.resource as PipeEndpoint;
  expect(inherited.tryWrite([encoder.encode("child")])).toBe(5);
  expect(output(reader)).toBe("child");
  child.dispose();
  expect(output(reader)).toBe("");
});

test("controller and worker imports release one transferred lifetime idempotently", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => {
    reader.close();
    writer.close();
  });
  const parent = new DescriptorTable();
  cleanups.push(() => parent.dispose());
  const fd = parent.open(writer, 3n, 3n);
  f.registry.registerProcess(2);
  const token = f.host.codec().export(parent.get(fd)!, 2);
  const control = new DescriptorTable(),
    guest = new DescriptorTable();
  cleanups.push(() => {
    control.dispose();
    guest.dispose();
  });
  control.add(f.broker.codec().import(structuredClone(token), 2), {
    rightsBase: 3n,
    rightsInheriting: 3n,
  });
  guest.add(f.host.codec().import(structuredClone(token), 2), {
    rightsBase: 3n,
    rightsInheriting: 3n,
  });
  const alias = guest.dup(0);
  guest.close(0);
  expect((guest.get(alias)!.resource as PipeEndpoint).tryWrite([encoder.encode("x")])).toBe(1);
  guest.close(alias);
  control.dispose();
  f.host.codec().discard(structuredClone(token));
  expect(output(reader)).toBe("x");
  // Parent's independent writer remains live after the transferred child reference closes.
  expect(output(reader)).toBe(-PipeErrno.AGAIN);
  writer.close();
  expect(output(reader)).toBe("");
});

test("shared pipe tokens reject imports into the wrong process", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  const table = new DescriptorTable();
  cleanups.push(() => {
    table.dispose();
    reader.close();
  });
  const fd = table.open(writer, 3n, 3n);
  f.registry.registerProcess(2);
  const token = f.host.codec().export(table.get(fd)!, 2);
  expect(() => f.host.codec().import(token, 3)).toThrow("another process");
  f.host.codec().discard(token);
});

test("broker owns relay pumping for readers inherited into another process", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  const source = new DescriptorTable();
  cleanups.push(() => source.dispose());
  const fd = source.open(reader, 3n, 3n);
  f.registry.registerProcess(2);
  const token = f.host.codec().export(source.get(fd)!, 2);
  const target = new DescriptorTable();
  cleanups.push(() => {
    target.dispose();
    writer.close();
  });
  target.add(f.broker.codec().import(structuredClone(token), 2), {
    rightsBase: 3n,
    rightsInheriting: 3n,
  });
  const inherited = target.get(0)!.resource as PipeEndpoint;
  source.close(fd);
  expect(writer.tryWrite([encoder.encode("relay")])).toBe(5);
  expect(output(inherited)).toBe(-PipeErrno.AGAIN);
  f.broker.pump();
  expect(output(inherited)).toBe("relay");
  writer.close();
  f.broker.pump();
  expect(output(inherited)).toBe("");
});

test("codec import automatically attaches the one responsive relay supervisor", async () => {
  const f = pairFixture("auto");
  const [reader, writer] = f.host.createPipe();
  const source = new DescriptorTable();
  cleanups.push(() => source.dispose());
  const fd = source.open(reader, 3n, 3n);
  f.registry.registerProcess(2);
  const token = f.host.codec().export(source.get(fd)!, 2);
  const target = new DescriptorTable();
  cleanups.push(() => {
    target.dispose();
    writer.close();
  });
  target.add(f.broker.codec().import(structuredClone(token), 2), {
    rightsBase: 3n,
    rightsInheriting: 3n,
  });
  const inherited = target.get(0)!.resource as PipeEndpoint;
  source.close(fd);
  writer.tryWrite([encoder.encode("auto")]);
  // Readiness does not reserve shared pipe bytes. A nonblocking read posts the demand
  // that lets the responsive controller deliver them to this reader's process ring.
  let result = output(inherited);
  const deadline = performance.now() + 1000;
  while (result === -PipeErrno.AGAIN && performance.now() < deadline) {
    await inherited.waitReadable();
    result = output(inherited);
  }
  expect(result).toBe("auto");
});

async function runChildPipeTransfers(
  f: ReturnType<typeof processFixture>,
  pid: number,
  iterations: number,
): Promise<void> {
  const worker = new Worker(new URL("./fixtures/worker-pipe-transfer-guest.ts", import.meta.url), {
    workerData: { transport: f.processes.get(pid), registry: f.registry.handle(), iterations },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let received = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`child pipe IPC timed out after ${received}/${iterations} transfers`)),
        3000,
      );
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (received !== iterations || code !== 0)
          reject(new Error(`child pipe worker exited ${code} after ${received} transfers`));
      });
      worker.on("message", (message) => {
        try {
          if (message.type === "runtime-proc" && message.operation === "pipe") {
            f.broker.attach(message.handle);
          } else if (message.phase === "transfer") {
            const target = new DescriptorTable();
            try {
              expect(message.sequence).toBe(received);
              target.add(f.broker.codec().import(message.token, 1), {
                rightsBase: 3n,
                rightsInheriting: 3n,
              });
              const endpoint = target.get(0)!.resource as PipeEndpoint;
              let payload = output(endpoint);
              if (payload === -PipeErrno.AGAIN) {
                f.broker.pump();
                payload = output(endpoint);
              }
              expect(payload).toBe(`child pipe ${received}`);
              f.broker.pump();
              expect(output(endpoint)).toBe("");
            } finally {
              target.dispose();
              f.broker.pump();
            }
            expect(f.broker.size).toBe(0);
            received++;
            worker.postMessage({ sequence: message.sequence });
          } else if (message.phase === "done") {
            expect(received).toBe(iterations);
            expect(message.iterations).toBe(iterations);
            resolve();
          } else if (message.phase === "failed") reject(new Error(message.error));
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

test("a real child worker repeatedly creates and transfers pipes beyond one registry page", async () => {
  const f = processFixture(128);
  const pid = f.root.spawn(1, request());
  await f.flush();
  await f.supervisor.start(pid);
  await runChildPipeTransfers(f, pid, 40);
});

test("sixteen distinct child workers each use IPC across shared registry growth", async () => {
  const f = processFixture(1, 32);
  const originalBytes = f.registry.handle().buffer.byteLength;
  const pids = new Set<number>();
  for (let child = 0; child < 16; child++) {
    const pid = f.root.spawn(1, request());
    pids.add(pid);
    await f.flush();
    await f.supervisor.start(pid);
    // Three pipes per child exceed 32 total pipelines as well as the tiny shared hint.
    // Workers are serial so every iteration owns and joins only one actual child thread.
    await runChildPipeTransfers(f, pid, 3);
    f.supervisor.exit(pid, 0);
  }
  expect(pids.size).toBe(16);
  expect(f.registry.handle().buffer.byteLength).toBeGreaterThan(originalBytes);
  expect(f.broker.size).toBe(0);
});

/** One long-lived root on the real worker-process stack: supervisor, process broker, pipe relay
 * and the root's own client. Every message crosses structured cloning, as between workers. */
function rootRuntime(
  capacity: number,
  cellsPerProcess: number,
  pipe: { capacity: number; maxReaders: number; maxWriters: number },
) {
  const transport = createWorkerProcessTransport({ capacity });
  const rootState = workerProcessState(transport);
  const registry = new PipePublicationRegistry({
    processCapacity: capacity,
    cellsPerProcess,
    maxCells: 1 << 16,
    wake: rootState.wake,
  });
  registry.registerProcess(rootState.pid);
  const pipes = new WorkerPipeBroker({ relay: "manual" });
  const messages: WorkerProcessMessage[] = [];
  const executables = new ExecutableRegistry();
  executables.register("fixture", { module: emptyModule, adapter: "preview1" });
  const diagnostics: unknown[] = [];
  let terminated = 0;
  const supervisor = new ProcessSupervisor({
    registry: executables,
    launch(context) {
      context.registerRevocation(() => registry.revoke(context.pid));
      return {
        terminate() {
          terminated++;
        },
      };
    },
    // The real host completes its resource fence here. Collection is independent of the
    // physical guest handle and is also required for ordinary (not just signaled) exits.
    quiesce: (pid) => registry.collectProcess(pid),
    onError: (error) => diagnostics.push(error),
  });
  supervisor.createRoot({
    pid: rootState.pid,
    job: rootState.job,
    observation: transport,
    ...rootState.signals,
  });
  supervisor.registerRevocation(rootState.pid, () => registry.revoke(rootState.pid));
  const processes = new WorkerProcessBroker({
    supervisor: async () => supervisor,
    codec: () => pipes.codec(),
    onPipe: (handle) => pipes.attach(handle as PipeEndpointHandle),
    pumpPipes: () => pipes.pump(),
    quiesce: (pid) => registry.collectProcess(pid),
    onError: (error) => diagnostics.push(error),
  });
  processes.adoptRoot(transport);
  const descriptors = new DescriptorTable();
  const postMessage = (message: WorkerProcessMessage) => messages.push(structuredClone(message));
  const host = new WorkerPipeHost({ transport, registry, postMessage, pipe });
  const root = new WorkerProcessClient({
    transport,
    descriptors,
    codec: host.codec(),
    postMessage,
    createPipe: () => host.createPipe(),
    prepareSpawn: (pid) => {
      registry.registerProcess(pid);
      return {
        data: { pipeRegistry: registry.handle() },
        cancel: () => registry.collectProcess(pid),
      };
    },
  });
  const flush = async () => {
    while (messages.length) await processes.handle(messages.shift()!);
  };
  cleanups.push(() => {
    descriptors.dispose();
    processes.dispose();
    supervisor.dispose();
    pipes.dispose();
    registry.collectProcess(rootState.pid);
  });
  return {
    transport,
    rootState,
    registry,
    pipes,
    messages,
    supervisor,
    processes,
    descriptors,
    root,
    flush,
    diagnostics,
    terminated: () => terminated,
    /** The child's own side of an admitted process, from its cloned worker transport. */
    child(pid: number) {
      const childTransport = structuredClone(processes.get(pid)!);
      const childHost = new WorkerPipeHost({
        transport: childTransport,
        registry: (childTransport.data as { pipeRegistry: PipePublicationRegistryHandle })
          .pipeRegistry,
        postMessage,
        pipe,
      });
      const childDescriptors = new DescriptorTable();
      const client = new WorkerProcessClient({
        transport: childTransport,
        descriptors: childDescriptors,
        codec: childHost.codec(),
        postMessage,
        createPipe: () => childHost.createPipe(),
      });
      return { descriptors: childDescriptors, client };
    },
  };
}

test("3001 pipe-backed spawn/waitJob cycles recycle a two-slot runtime and root disposal clears it", async () => {
  const f = rootRuntime(2, 1, { capacity: 8, maxReaders: 1, maxWriters: 1 });
  const { transport, rootState, registry, pipes, messages, supervisor, processes, root, flush } = f;
  const directoryBytes = transport.directory.byteLength;
  let stale: PipeEndpoint | undefined;
  try {
    for (let iteration = 0; iteration < 3001; iteration++) {
      const pid = root.spawn(rootState.pid, request()),
        job = root.jobOf(pid);
      await flush();
      await supervisor.start(pid);
      const { descriptors: childDescriptors, client: child } = f.child(pid);
      try {
        const [reader, writer] = child.createPipe();
        if (!(reader instanceof PipeEndpoint) || !(writer instanceof PipeEndpoint))
          throw new Error("pipe factory returned a non-pipe stream");
        childDescriptors.open(reader, 3n, 3n);
        childDescriptors.open(writer, 3n, 3n);
        if (!stale) stale = attachPipeEndpoint(structuredClone(writer.handle()));
        await flush();
        expect(writer.tryWrite([encoder.encode("x")])).toBe(1);
        expect(output(reader)).toBe("x");
        supervisor.exit(pid, iteration % 32);
        // Keep the guest descriptor table and retained handle alive through collection.
        expect(writer.tryWrite([encoder.encode("late")])).toBe(-PipeErrno.BADF);
        pipes.pump();
        expect(root.waitJob(rootState.pid, job)?.code).toBe(iteration % 32);
        await flush();
        expect(processes.get(pid)).toBeUndefined();
        expect(supervisor.get(pid)).toBeUndefined();
        expect(supervisor.job(job)).toBeUndefined();
        expect(Array.from(supervisor.table.values())).toHaveLength(1);
        expect(workerProcessSlots(transport)).toHaveLength(1);
        expect(directoryJobs(transport.directory)).toHaveLength(1);
        expect(registry.processCount).toBe(1);
        expect(pipes.size).toBe(0);
        expect(messages).toHaveLength(0);
        expect(f.diagnostics).toEqual([]);
      } finally {
        childDescriptors.dispose();
        registry.collectProcess(pid);
      }
    }
    expect(f.terminated()).toBe(3001);
    expect(stale!.tryWrite([encoder.encode("stale")])).toBe(-PipeErrno.BADF);
    expect(transport.directory.byteLength).toBe(directoryBytes);
    expect(registry.handle().buffer.byteLength).toBeLessThan(512 * 1024);
    supervisor.exit(rootState.pid, 0);
    processes.releaseRoot(rootState.pid);
    supervisor.dispose();
    expect(registry.processCount).toBe(0);
    expect(workerProcessSlots(transport)).toHaveLength(0);
    expect(directoryJobs(transport.directory)).toHaveLength(0);
    expect(Array.from(supervisor.table.values())).toHaveLength(0);
    expect(supervisor.job(rootState.job)).toBeUndefined();
    expect(processes.get(rootState.pid)).toBeUndefined();
    expect(pipes.size).toBe(0);
    expect(f.diagnostics).toEqual([]);
  } finally {
    stale?.close();
  }
});

/** Spawn one child into the root's own job with a fresh pipe as its stdout, as a dev server or
 * shell does; the child writes once and exits. Records weak references to what the page holds. */
async function churnChild(
  f: ReturnType<typeof rootRuntime>,
  code: number,
  held: { tokens: WeakRef<object>[]; records: WeakRef<object>[] },
): Promise<{ pid: number; reader: PipeEndpoint }> {
  const [reader, writer] = f.root.createPipe();
  if (!(reader instanceof PipeEndpoint) || !(writer instanceof PipeEndpoint))
    throw new Error("pipe factory returned a non-pipe stream");
  const writerFd = f.descriptors.open(writer, 3n, 3n);
  const job = f.rootState.job;
  const pid = f.root.spawn(
    f.rootState.pid,
    request({ job, fds: [{ child: 1, parent: writerFd }] }),
  );
  f.descriptors.close(writerFd);
  await f.flush();
  await f.supervisor.start(pid);
  const admitted = f.processes.get(pid)!;
  expect(admitted.resources.length).toBeGreaterThan(0);
  for (const token of admitted.resources) held.tokens.push(new WeakRef(token as object));
  held.records.push(new WeakRef(f.supervisor.get(pid)!));
  const child = f.child(pid);
  child.client.installBindings();
  const stdout = child.descriptors.get(1)!.resource as PipeEndpoint;
  expect(stdout.tryWrite([encoder.encode("x")])).toBe(1);
  child.descriptors.dispose();
  f.supervisor.exit(pid, code);
  f.pipes.pump();
  await f.flush();
  return { pid, reader };
}
async function liveAfterGc(refs: readonly WeakRef<object>[]): Promise<number> {
  await Bun.sleep(0);
  Bun.gc(true);
  await Bun.sleep(0);
  Bun.gc(true);
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

// Chromium holds about 4,096 pipe-sized shared buffers per page. Every child of a long-lived
// root used to stay in the supervisor's per-job record set until the root itself exited, so its
// transferred pipe tokens (and their buffers) were never released and pipe() hit ENOMEM.
test("a long-lived root's reaped children release their records and pipe buffers", async () => {
  const f = rootRuntime(4, 4, { capacity: 8, maxReaders: 2, maxWriters: 2 });
  const held = { tokens: [] as WeakRef<object>[], records: [] as WeakRef<object>[] };
  for (let iteration = 0; iteration < 400; iteration++) {
    const { pid, reader } = await churnChild(f, iteration % 32, held);
    expect(output(reader, 8)).toBe("x");
    reader.close();
    expect(f.root.wait(f.rootState.pid, pid)?.code).toBe(iteration % 32);
    await f.flush();
    expect(f.processes.get(pid)).toBeUndefined();
    expect(f.supervisor.get(pid)).toBeUndefined();
    expect(f.pipes.size).toBe(0);
  }
  // A conservative stack scan may pin the last few; everything older must be gone.
  expect(await liveAfterGc(held.records)).toBeLessThanOrEqual(8);
  expect(await liveAfterGc(held.tokens)).toBeLessThanOrEqual(8);
  expect(f.diagnostics).toEqual([]);
  f.supervisor.exit(f.rootState.pid, 0);
  f.processes.releaseRoot(f.rootState.pid);
  f.supervisor.dispose();
  expect(Array.from(f.supervisor.table.values())).toHaveLength(0);
  expect(f.diagnostics).toEqual([]);
});

test("an unwaited zombie keeps its exit status but not its transferred pipe buffers", async () => {
  const f = rootRuntime(64, 4, { capacity: 8, maxReaders: 2, maxWriters: 2 });
  const held = { tokens: [] as WeakRef<object>[], records: [] as WeakRef<object>[] };
  const zombies: number[] = [];
  for (let index = 0; index < 32; index++) {
    const { pid, reader } = await churnChild(f, index + 1, held);
    expect(output(reader, 8)).toBe("x");
    reader.close();
    const deadline = performance.now() + 5000;
    while (f.supervisor.get(pid)?.retirement === undefined && performance.now() < deadline)
      await Bun.sleep(1);
    expect(f.supervisor.get(pid)?.retirement?.kind).toBe("complete");
    zombies.push(pid);
  }
  expect(await liveAfterGc(held.tokens)).toBeLessThanOrEqual(4);
  // Zombie semantics: each child stays waitable with its status until the parent collects it.
  for (const [index, pid] of zombies.entries()) {
    expect(f.root.childExited(f.rootState.pid, pid)).toBe(true);
    expect(f.root.wait(f.rootState.pid, pid)?.code).toBe(index + 1);
    await f.flush();
    expect(f.supervisor.get(pid)).toBeUndefined();
  }
  expect(f.diagnostics).toEqual([]);
});

test("authorized worker kill freezes publication before parent-visible completion", async () => {
  const f = processFixture();
  const [reader, writer] = f.host.createPipe();
  const fd = f.root.options.descriptors.open(writer, 127n, 63n);
  const pid = f.root.spawn(1, request({ fds: [{ child: 17, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  await f.flush();
  await f.supervisor.start(pid);
  const { guest } = f.child(pid);
  const inherited = guest.options.descriptors.get(17)!.resource as PipeEndpoint;
  expect(inherited.tryWrite([encoder.encode("good")])).toBe(4);
  const late = encoder.encode("late"),
    copy = isolated.hooks.typedArrayCopy;
  let intercepted = false;
  isolated.hooks.typedArrayCopy = (target, offset, view, start, end) => {
    if (view === late) {
      intercepted = true;
      f.root.kill(pid, 9);
    }
    copy(target, offset, view, start, end);
  };
  try {
    expect(inherited.tryWrite([late])).toBe(-PipeErrno.BADF);
  } finally {
    isolated.hooks.typedArrayCopy = copy;
  }
  expect(intercepted).toBe(true);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(output(reader)).toBe("good");
  expect(output(reader)).toBe("");
  await f.flush();
  expect(f.root.wait(1, pid)?.status).toBe(137);
  reader.close();
});

test("a parent kill freezes descendant-created pipes not yet known to the broker", async () => {
  const f = processFixture();
  const pid = f.root.spawn(1, request());
  await f.flush();
  await f.supervisor.start(pid);
  const { host } = f.child(pid);
  const [reader, writer] = host.createPipe();
  expect(f.broker.size).toBe(0);
  expect(writer.tryWrite([encoder.encode("queued")])).toBe(6);
  f.root.kill(pid, 9);
  expect(writer.tryWrite([encoder.encode("late")])).toBe(-PipeErrno.BADF);
  expect(reader.tryRead([new Uint8Array(8)])).toBe(-PipeErrno.BADF);
  expect(f.registry.isRevoked(pid)).toBe(true);
  expect(f.root.wait(1, pid)).toBeNull();
  await f.flush();
  expect(f.root.wait(1, pid)?.status).toBe(137);
  reader.close();
  writer.close();
});

test("pipe codec composes actual filesystem transfers without stealing file ownership", async () => {
  const f = pairFixture();
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const filesystem = new FilesystemClient(connection.client);
  cleanups.push(() => {
    filesystem.dispose();
    service.dispose();
  });
  await filesystem.asyncCall("writeFile", ["/file"], encoder.encode("file contents"));
  const directory = await filesystem.asyncCall("preopen", ["/"]);
  const { node } = await filesystem.asyncCall("resolve", [directory, "file"]);
  filesystem.retain(node);
  const parent = new DescriptorTable();
  cleanups.push(() => parent.dispose());
  const fileFd = parent.open(
    { kind: "file", handle: node, offset: 0, append: false },
    127n,
    63n,
    () => filesystem.release(node),
  );
  const [reader, writer] = f.host.createPipe();
  const pipeFd = parent.open(writer, 127n, 63n);
  cleanups.push(() => reader.close());
  const identity = createProcessFilesystemIdentity(filesystem.connection);
  const exporter = f.host.codec(createFilesystemDescriptorCodec(filesystem, identity));
  f.registry.registerProcess(2);
  const file = exporter.export(parent.get(fileFd)!, 2),
    pipe = exporter.export(parent.get(pipeFd)!, 2);
  expect(isWorkerPipeDescriptorToken(file)).toBe(false);
  expect(isWorkerPipeDescriptorToken(pipe)).toBe(true);
  parent.close(fileFd);
  parent.close(pipeFd);
  const targetConnection = connectFilesystemIdentity(identity);
  service.connect(targetConnection.server);
  const childFilesystem = new FilesystemClient(targetConnection.client);
  cleanups.push(() => childFilesystem.dispose());
  const target = new DescriptorTable();
  cleanups.push(() => target.dispose());
  const importer = f.broker.codec(createFilesystemDescriptorCodec(childFilesystem));
  target.add(importer.import(structuredClone(file), 2), {
    rightsBase: 127n,
    rightsInheriting: 63n,
  });
  target.add(importer.import(structuredClone(pipe), 2), {
    rightsBase: 127n,
    rightsInheriting: 63n,
  });
  const resource = target.get(0)!.resource;
  if (resource.kind !== "file") throw new Error("not a file");
  const bytes = new Uint8Array(32);
  expect(childFilesystem.read(resource.handle, [bytes], resource.offset)).toBe(13);
  expect(decoder.decode(bytes.subarray(0, 13))).toBe("file contents");
  expect((target.get(1)!.resource as PipeEndpoint).tryWrite([encoder.encode("pipe")])).toBe(4);
  expect(output(reader)).toBe("pipe");
  target.dispose();
  exporter.discard(file);
  exporter.discard(pipe);
  expect(output(reader)).toBe("");
});

for (const preserveExisting of [false, true]) {
  test(`pipe capacity failure rolls back a partial pair${preserveExisting ? " without damaging existing pipes" : ""}`, () => {
    const transport = createWorkerProcessTransport();
    const registry = new PipePublicationRegistry({
      processCapacity: 8,
      cellsPerProcess: 1,
      maxCells: preserveExisting ? 7 : 3,
    });
    registry.registerProcess(1);
    const broker = new WorkerPipeBroker({ relay: "manual" });
    const messages: WorkerProcessMessage[] = [];
    cleanups.push(() => broker.dispose());
    const host = new WorkerPipeHost({
      transport,
      registry: structuredClone(registry.handle()),
      pipe: { capacity: 8, maxReaders: 4, maxWriters: 4 },
      postMessage(message) {
        messages.push(message);
        if (message.operation === "pipe") broker.attach(message.handle as PipeEndpointHandle);
      },
    });
    const existing = preserveExisting ? host.createPipe() : undefined;
    cleanups.push(() => {
      existing?.[0].close();
      existing?.[1].close();
    });
    let partial: PipeEndpoint | undefined;
    let failedController: PipeController | undefined;
    const retain = PipeController.prototype.retain;
    const retainSpy = spyOn(PipeController.prototype, "retain").mockImplementation(function (
      this: PipeController,
      pid,
      mode,
    ) {
      const endpoint = retain.call(this, pid, mode);
      partial = endpoint;
      /* oxlint-disable typescript/no-this-alias -- Record the exact controller whose partial retain failed. */
      failedController = this;
      /* oxlint-enable typescript/no-this-alias */
      return endpoint;
    });
    cleanups.push(() => retainSpy.mockRestore());
    let failure: unknown;
    try {
      host.createPipe();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProcessError);
    expect((failure as ProcessError).errno).toBe(PipeErrno.NFILE);
    // The reader was retained successfully before the writer exhausted the global budget.
    expect(partial?.mode).toBe("read");
    expect(Atomics.load(new Int32Array(partial!.handle().lifetime), 0)).toBe(1);
    expect(partial!.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.BADF);
    expect(failedController!.closed).toBe(true);
    expect(messages).toHaveLength(preserveExisting ? 1 : 0);
    expect(broker.size).toBe(preserveExisting ? 1 : 0);
    expect(host.registry.isRevoked(1)).toBe(false);
    if (existing) {
      expect(existing[1].tryWrite([encoder.encode("kept")])).toBe(4);
      expect(output(existing[0])).toBe("kept");
    }
  });
}

test("failed pipe announcement closes only the unpublished local pair", () => {
  const transport = createWorkerProcessTransport();
  const host = new WorkerPipeHost({
    transport,
    pipe: { capacity: 8 },
    postMessage() {
      throw new Error("post failed");
    },
  });
  expect(() => host.createPipe()).toThrow("post failed");
  // Pipe creation failure cannot revoke the entire creating process or its later pipes.
  expect(host.registry.isRevoked(1)).toBe(false);
});

test("uncomposed codecs fail explicitly on unsupported streams and tokens", () => {
  const codec = createWorkerPipeCodec();
  const descriptors = new DescriptorTable();
  cleanups.push(() => descriptors.dispose());
  const terminal: Stream = {
    kind: "terminal",
    read: () => 0,
    write: () => 0,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
  const fd = descriptors.open(terminal, 3n, 3n);
  expect(() => codec.export(descriptors.get(fd)!, 2)).toThrow("unsupported");
  expect(() => codec.import({ kind: "unknown" }, 2)).toThrow("unsupported");
});
