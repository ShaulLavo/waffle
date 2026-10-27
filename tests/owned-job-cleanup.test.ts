import { afterEach, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { DescriptorTable, OpenDescription } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI, ProcessSignalExit } from "../proc/abi.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor, type SupervisorOptions } from "../proc/supervisor.js";
import { controlLoad } from "../proc/control.js";
import { SIGNAL_PENDING, requestSignal, setSignalDisposition } from "../proc/signals.js";
import { readOutcome } from "../proc/outcome.js";
import { checkedJobLifetime, type SpawnRequest } from "../proc/types.js";
import { WorkerProcessBroker } from "../proc/worker-broker.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
  type WorkerDescriptorCodec,
} from "../proc/worker-client.js";
import { findDirectoryJob, directoryGroups } from "../proc/directory.js";
import {
  createFilesystemIdentity,
  FilesystemSection,
  revokeFilesystem,
  waitForFilesystemQuiescence,
  createProcessFilesystemIdentity,
  reapFilesystem,
} from "../fs/protocol.js";
import { filesystemFileFixture } from "./fixtures/filesystem-file.js";
import {
  createFilesystemDescriptorCodec,
  isFilesystemDescriptorToken,
} from "../proc/filesystem-codec.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const spec = (owned = false, job = 0): SpawnRequest => ({
  executable: "fixture",
  argv: [],
  env: {},
  cwd: "/",
  job,
  fds: [],
  ...(owned ? { jobLifetime: "caller-fatal" } : {}),
});
function fixture(options: Partial<SupervisorOptions> = {}) {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "fixture" });
  const supervisor = new ProcessSupervisor({
    registry,
    launch: () => ({ terminate() {} }),
    ...options,
  });
  cleanups.push(() => supervisor.dispose());
  const root = supervisor.createRoot();
  return { supervisor, root };
}
test("fatal caller closes only explicitly owned independent jobs and nested owned descendants", async () => {
  const { supervisor: s, root } = fixture();
  const owner = s.reserveSpawn(root, spec());
  const child = s.reserveSpawn(owner, spec(true));
  const job = s.jobOf(child);
  const grandchild = s.reserveSpawn(child, spec(false, job));
  const nested = s.reserveSpawn(child, spec(true));
  const detached = s.reserveSpawn(owner, spec());
  const background = s.reserveSpawn(owner, spec(false, -1));
  const sibling = s.reserveSpawn(root, spec());
  s.registerRevocation(owner, () => {
    expect(() => s.reserveSpawn(nested, spec())).toThrow(/parent process has exited/);
    expect(() => s.reserveSpawn(grandchild, spec())).toThrow(/parent process has exited/);
  });
  s.kill(owner, 9);
  await s.waitForExit(root, owner);
  expect(s.get(child)).toBeUndefined();
  expect(s.get(grandchild)).toBeUndefined();
  expect(s.get(nested)).toBeUndefined();
  expect(s.job(job)).toBeUndefined();
  for (const pid of [detached, background, sibling])
    expect(readOutcome(s.get(pid)!.outcome)).toBeNull();
});
test("ordinary owner exit disarms the lifetime without killing its child", async () => {
  const { supervisor: s, root } = fixture();
  const owner = s.reserveSpawn(root, spec());
  const child = s.reserveSpawn(owner, spec(true));
  s.exit(owner, 137);
  await s.waitForExit(root, owner);
  expect(s.job(s.jobOf(child))?.lifetimeState).toBe("disarmed");
  expect(readOutcome(s.get(child)!.outcome)).toBeNull();
});
test("owner completion waits for sparse inherited FD release, filesystem fence and asynchronous physical stop", async () => {
  const fence = Promise.withResolvers<void>();
  const stop = Promise.withResolvers<void>();
  let child = 0,
    stopped = false,
    released = false;
  const { supervisor: s, root } = fixture({
    quiesce: (pid) => (pid === child ? fence.promise : undefined),
    launch: () => ({
      terminate() {
        stopped = true;
        return stop.promise;
      },
    }),
  });
  cleanups.push(() => {
    fence.resolve();
    stop.resolve();
  });
  const owner = s.reserveSpawn(root, spec());
  const fd = s.get(owner)!.descriptors.open({ kind: "directory", handle: 1 }, 0n, 0n, () => {
    released = true;
  });
  child = s.reserveSpawn(owner, { ...spec(true), fds: [{ parent: fd, child: 1000000 }] });
  await s.start(child);
  s.kill(owner, 9);
  expect(s.get(owner)?.result).toBeNull();
  expect(s.get(owner)?.descriptors.get(fd)).toBeUndefined();
  await turn();
  expect(released).toBe(true);
  expect(stopped).toBe(false);
  fence.resolve();
  await turn();
  expect(stopped).toBe(true);
  expect(s.get(owner)?.result).toBeNull();
  stop.resolve();
  await s.waitForExit(root, owner);
  expect(s.get(child)).toBeUndefined();
});
test("physical stop failure stays unconfirmed instead of releasing owner cleanup", async () => {
  const errors: unknown[] = [];
  const failure = new Error("stop failed");
  const { supervisor: s, root } = fixture({
    launch: () => ({
      terminate() {
        return Promise.reject(failure);
      },
    }),
    onError: (error) => errors.push(error),
  });
  const owner = s.reserveSpawn(root, spec());
  const child = s.reserveSpawn(owner, spec(true));
  await s.start(child);
  s.kill(owner, 9);
  await turn();
  expect(s.get(owner)?.result).toBeNull();
  expect(errors).toContain(failure);
  expect(s.job(s.jobOf(child))).toBeDefined();
});
test("lifetime validation preserves omission and rejects unknown or positive-join selections", () => {
  expect(checkedJobLifetime(0, undefined)).toBe("independent");
  expect(checkedJobLifetime(-1, "caller-fatal")).toBe("caller-fatal");
  for (const value of [true, null, "unknown"]) expect(() => checkedJobLifetime(0, value)).toThrow();
  expect(() => checkedJobLifetime(5, "independent")).toThrow();
  expect(() => checkedJobLifetime(5, "caller-fatal")).toThrow();
});
test("CLEANUP wait preserves pending handled signals and validates output before collecting", async () => {
  const { supervisor: s, root } = fixture();
  const pid = s.reserveSpawn(root, spec(true));
  s.exit(pid, 23);
  await turn();
  const signals = s.get(root)!;
  const memory = new WebAssembly.Memory({ initial: 1 });
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const abi = new ProcessABI({
    memory,
    fs: new MemFS(),
    descriptors: signals.descriptors,
    service: s,
    pid: root,
    signals,
    wake,
  });
  expect(abi.imports.signal!(15, 2)).toBe(0);
  requestSignal(signals, 15);
  const job = s.jobOf(pid);
  expect(abi.imports.wait_job!(job, 2, 65532)).toBe(-21);
  expect(s.job(job)).toBeDefined();
  expect(abi.imports.wait_job!(job, 2, 64)).toBe(0);
  expect(new DataView(memory.buffer).getInt32(68, true)).toBe(23);
  expect(controlLoad(signals.signalState, 15) & SIGNAL_PENDING).toBe(SIGNAL_PENDING);
  expect(abi.imports.interrupted!()).toBe(15);
  expect(abi.imports.wait_job!(s.jobOf(root), 2, 64)).toBe(-28);
});

function sharedFixture(
  options: Partial<SupervisorOptions> = {},
  suppliedCodec?: WorkerDescriptorCodec,
) {
  const transport = createWorkerProcessTransport({ capacity: 16 });
  const rootState = workerProcessState(transport);
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "fixture" });
  const s = new ProcessSupervisor({ registry, launch: () => ({ terminate() {} }), ...options });
  s.createRoot({ pid: rootState.pid, job: rootState.job, ...rootState.signals });
  const messages: WorkerProcessMessage[] = [];
  const codec = suppliedCodec ?? {
    export(): never {
      throw new Error("unexpected descriptor export");
    },
    import(): never {
      throw new Error("unexpected descriptor import");
    },
    discard() {},
  };
  const broker = new WorkerProcessBroker({ supervisor: async () => s, codec });
  broker.adoptRoot(transport);
  cleanups.push(() => {
    broker.dispose();
    s.dispose();
  });
  const client = (value: WorkerProcessTransport) => {
    const descriptors = new DescriptorTable();
    cleanups.push(() => descriptors.dispose());
    return new WorkerProcessClient({
      transport: value,
      descriptors,
      codec,
      postMessage: (m) => messages.push(structuredClone(m)),
    });
  };
  async function admit() {
    const notice = messages.shift()!;
    if (notice.operation !== "spawn") throw new Error("expected spawn");
    await broker.handle(notice, workerProcessState(notice.transport).parentPid);
    await s.start(notice.transport.pid);
    return notice.transport;
  }
  return { s, transport, broker, client, root: client(transport), messages, admit };
}
test("shared fatal owner closes queued owned child and grandchild without blocking admission", async () => {
  const f = sharedFixture();
  const ownerPid = f.root.spawn(f.root.pid, spec());
  const owner = f.client(await f.admit());
  const childPid = owner.spawn(ownerPid, spec(true));
  const childNotice = f.messages.shift()!;
  if (childNotice.operation !== "spawn") throw new Error("expected child");
  const child = f.client(childNotice.transport);
  const grandchild = child.spawn(childPid, spec(false, child.job));
  const grandchildNotice = f.messages.shift()!;
  if (grandchildNotice.operation !== "spawn") throw new Error("expected grandchild");
  f.root.kill(ownerPid, 9);
  const signal = f.messages.shift()!;
  await f.broker.handle(signal, f.root.pid);
  expect(f.s.get(ownerPid)?.result).toBeNull();
  await f.broker.handle(childNotice, ownerPid);
  await f.broker.handle(grandchildNotice, childPid);
  const result = await f.s.waitForExit(f.root.pid, ownerPid);
  expect(result).toMatchObject({ kind: "signaled", code: 9 });
  expect(f.s.get(childPid)).toBeUndefined();
  expect(f.s.get(grandchild)).toBeUndefined();
  expect(findDirectoryJob(f.transport.directory, child.job)).toBeUndefined();
});
test("shared owned closure retires active nested jobs while independent jobs survive", async () => {
  const stopped: number[] = [];
  const f = sharedFixture({
    launch: (context) => ({
      terminate() {
        stopped.push(context.pid);
      },
    }),
  });
  const ownerPid = f.root.spawn(f.root.pid, spec());
  const owner = f.client(await f.admit());
  const childPid = owner.spawn(ownerPid, spec(true));
  const child = f.client(await f.admit());
  const grandchild = child.spawn(childPid, spec(false, child.job));
  await f.admit();
  const nested = child.spawn(childPid, spec(true));
  await f.admit();
  const detached = owner.spawn(ownerPid, spec());
  await f.admit();
  const background = owner.spawn(ownerPid, spec(false, -1));
  await f.admit();
  f.root.kill(ownerPid, 9);
  await f.broker.handle(f.messages.shift()!, f.root.pid);
  await f.s.waitForExit(f.root.pid, ownerPid);
  for (const pid of [childPid, grandchild, nested]) {
    expect(stopped).toContain(pid);
    expect(f.s.get(pid)).toBeUndefined();
  }
  for (const pid of [detached, background]) {
    expect(f.s.get(pid)?.state).toBe("running");
    expect(stopped).not.toContain(pid);
  }
});
test("owner fatal selection during export rolls back the unpublished owned reservation", async () => {
  let discarded = 0;
  const codec: WorkerDescriptorCodec = {
    export() {
      f.root.kill(f.root.pid, 9);
      return {};
    },
    import: () => new OpenDescription({ kind: "directory", handle: 1 }),
    discard() {
      discarded++;
    },
  };
  const f = sharedFixture({}, codec);
  const fd = f.root.options.descriptors.open({ kind: "directory", handle: 1 }, 0n, 0n);
  expect(() =>
    f.root.spawn(f.root.pid, { ...spec(true), fds: [{ parent: fd, child: 17 }] }),
  ).toThrow();
  expect(discarded).toBe(1);
  expect(f.messages.some((message) => message.operation === "spawn")).toBe(false);
  await f.broker.handle(f.messages.shift()!, f.root.pid);
  await f.s.waitForExit(0, f.root.pid);
  expect(Array.from(directoryGroups(f.transport.directory), (group) => group.id)).toEqual([
    f.root.job,
  ]);
});
test("late acquired handles keep physical retirement pending after ordinary process collection", async () => {
  const handle = Promise.withResolvers<{ terminate(): Promise<void> }>();
  const stop = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const { supervisor: s, root } = fixture({
    launch() {
      entered.resolve();
      return handle.promise;
    },
  });
  cleanups.push(() => {
    handle.resolve({ terminate: () => stop.promise });
    stop.resolve();
  });
  const pid = s.reserveSpawn(root, spec(true));
  const starting = s.start(pid);
  await entered.promise;
  const job = s.jobOf(pid);
  s.kill(pid, 9);
  await s.waitForExit(root, pid);
  s.reap(root, pid);
  expect(s.jobCleanupReady(root, job)).toBe(false);
  handle.resolve({ terminate: () => stop.promise });
  await starting;
  expect(s.jobCleanupReady(root, job)).toBe(false);
  stop.resolve();
  await turn();
  expect(s.jobCleanupReady(root, job)).toBe(true);
  expect(s.waitJob(root, job)).toMatchObject({ kind: "signaled", code: 9 });
});
test("CLEANUP waits on a notification despite handled TERM, but fatal outcome unwinds", () => {
  const { supervisor: s, root } = fixture();
  const signals = s.get(root)!;
  const pid = s.reserveSpawn(root, spec(true));
  const memory = new WebAssembly.Memory({ initial: 1 });
  const wake = new Int32Array(new SharedArrayBuffer(4));
  let waits = 0;
  const abi = new ProcessABI({
    memory,
    fs: new MemFS(),
    descriptors: signals.descriptors,
    service: s,
    pid: root,
    signals,
    wake,
    wait(ms) {
      expect(ms).toBe(Infinity);
      waits++;
      s.kill(root, 9);
    },
  });
  abi.imports.signal!(15, 2);
  requestSignal(signals, 15);
  expect(() => abi.imports.wait_job!(s.jobOf(pid), 2, 64)).toThrow(ProcessSignalExit);
  expect(waits).toBe(1);
  expect(controlLoad(signals.signalState, 15) & SIGNAL_PENDING).toBe(SIGNAL_PENDING);
});
test("CLEANUP rejects unsupported notification routes, foreign jobs and repeated collection", async () => {
  const { supervisor: s, root } = fixture();
  const pid = s.reserveSpawn(root, spec());
  const job = s.jobOf(pid);
  s.exit(pid, 0);
  await turn();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const signals = s.get(root)!;
  const options = {
    memory,
    fs: new MemFS(),
    descriptors: signals.descriptors,
    service: s,
    pid: root,
    signals,
  };
  expect(new ProcessABI(options).imports.wait_job!(job, 2, 0)).toBe(-58);
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const other = s.createRoot();
  const stranger = new ProcessABI({ ...options, pid: other, signals: s.get(other)!, wake });
  expect(stranger.imports.wait_job!(job, 2, 0)).toBe(-63);
  const abi = new ProcessABI({ ...options, wake });
  expect(abi.imports.wait_job!(9999, 2, 0)).toBe(-71);
  expect(abi.imports.wait_job!(job, 2, 0)).toBe(0);
  expect(abi.imports.wait_job!(job, 2, 0)).toBe(-12);
});
test("CLEANUP reacquires growing guest memory before consuming the job", async () => {
  const { supervisor: s, root } = fixture();
  const pid = s.reserveSpawn(root, spec());
  const job = s.jobOf(pid);
  s.exit(pid, 23);
  await turn();
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  let views = 0;
  const abi = new ProcessABI({
    memory: () => {
      if (++views === 2) memory.grow(1);
      return memory;
    },
    fs: new MemFS(),
    descriptors: s.get(root)!.descriptors,
    service: s,
    pid: root,
    signals: s.get(root)!,
    wake: new Int32Array(new SharedArrayBuffer(4)),
  });
  expect(abi.imports.wait_job!(job, 2, 64)).toBe(0);
  expect(memory.buffer.byteLength).toBe(131072);
  expect(new DataView(memory.buffer).getInt32(68, true)).toBe(23);
});
test("shared CLEANUP reports physical-retirement error without collecting the job", async () => {
  const failure = new Error("physical stop refused");
  const f = sharedFixture({
    launch: () => ({ terminate: () => Promise.reject(failure) }),
    onError() {},
  });
  const pid = f.root.spawn(f.root.pid, spec());
  const transport = await f.admit();
  const job = workerProcessState(transport).job;
  f.root.kill(pid, 9);
  await f.broker.handle(f.messages.shift()!, f.root.pid);
  await turn();
  const abi = new ProcessABI({
    memory: new WebAssembly.Memory({ initial: 1 }),
    fs: new MemFS(),
    descriptors: f.root.options.descriptors,
    service: f.root,
    pid: f.root.pid,
    signals: f.root.signals,
    wake: f.root.wake,
  });
  expect(abi.imports.wait_job!(job, 2, 0)).toBe(-29);
  expect(findDirectoryJob(f.transport.directory, job)).toBeDefined();
  expect(f.root.jobEmpty(f.root.pid, job)).toBe(true);
});
test("a real filesystem section fences owner cleanup before physical retirement", async () => {
  const identity = createFilesystemIdentity();
  const section = new FilesystemSection(identity);
  let child = 0,
    stopped = false;
  const { supervisor: s, root } = fixture({
    quiesce: (pid) => (pid === child ? waitForFilesystemQuiescence(identity) : undefined),
    launch: () => ({
      terminate() {
        expect(Atomics.load(new Int32Array(identity.sections), 0)).toBe(0);
        stopped = true;
      },
    }),
  });
  const owner = s.reserveSpawn(root, spec());
  child = s.reserveSpawn(owner, spec(true));
  await s.start(child);
  section.enter();
  cleanups.push(() => {
    section.exit();
  });
  s.registerRevocation(child, () => revokeFilesystem(identity));
  s.kill(owner, 9);
  expect(stopped).toBe(false);
  expect(s.get(owner)?.result).toBeNull();
  section.exit();
  cleanups.pop();
  await s.waitForExit(root, owner);
  expect(stopped).toBe(true);
});

function cleanupWorker(f: ReturnType<typeof sharedFixture>, job: number) {
  const ready = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<{
    kind: string;
    signal?: number;
    result?: number;
    pending?: number;
    first?: number;
    second?: number;
    outcome?: number[];
  }>();
  const notices: Promise<void>[] = [];
  const worker = new Worker(new URL("./fixtures/owned-job-wait-worker.ts", import.meta.url), {
    workerData: { transport: f.transport, job },
  });
  cleanups.push(async () => {
    await worker.terminate();
  });
  void finished.promise.catch(() => {});
  worker.on("error", (error) => {
    ready.reject(error);
    finished.reject(error);
  });
  worker.on("message", (message: WorkerProcessMessage | { kind: string }) => {
    if ("type" in message) {
      notices.push(f.broker.handle(message, f.root.pid));
      return;
    }
    if (message.kind === "waiting") ready.resolve();
    else finished.resolve(message);
  });
  return { ready: ready.promise, finished: finished.promise, notices };
}
test("shared owned cleanup releases a real sparse filesystem token only through its section fence", async () => {
  const filesystemCleanups: (() => void)[] = [];
  cleanups.push(() => {
    while (filesystemCleanups.length) filesystemCleanups.pop()!();
  });
  const fs = await filesystemFileFixture(filesystemCleanups);
  const identity = createProcessFilesystemIdentity(fs.client.connection);
  cleanups.push(() => {
    revokeFilesystem(identity);
    reapFilesystem(identity);
  });
  const exporter = createFilesystemDescriptorCodec(fs.client, identity);
  const importer = createFilesystemDescriptorCodec(identity, undefined, () => fs.client.sweep());
  const codec: WorkerDescriptorCodec = {
    export: exporter.export,
    import: importer.import,
    discard: exporter.discard,
  };
  const section = new FilesystemSection(identity);
  let child = 0,
    stopped = false;
  const f = sharedFixture(
    {
      quiesce: (pid) => (pid === child ? waitForFilesystemQuiescence(identity) : undefined),
      launch(context) {
        context.registerRevocation(() => revokeFilesystem(identity));
        return {
          terminate() {
            expect(Atomics.load(new Int32Array(identity.sections), 0)).toBe(0);
            stopped = true;
          },
        };
      },
    },
    codec,
  );
  const fd = f.root.options.descriptors.open(
    { kind: "file", handle: fs.handle, offset: 0, append: false },
    127n,
    0n,
    () => fs.client.release(fs.handle),
  );
  child = f.root.spawn(f.root.pid, { ...spec(true), fds: [{ parent: fd, child: 1000000 }] });
  const notice = f.messages[0];
  if (notice?.operation !== "spawn") throw new Error("expected spawn");
  const token = notice.transport.resources[0];
  if (!isFilesystemDescriptorToken(token)) throw new Error("expected filesystem token");
  f.root.options.descriptors.close(fd);
  await f.admit();
  expect(f.s.get(child)?.descriptors.get(1000000)?.resource.kind).toBe("file");
  section.enter();
  cleanups.push(() => section.exit());
  f.root.kill(f.root.pid, 9);
  await f.broker.handle(f.messages.shift()!, f.root.pid);
  expect(f.s.get(f.root.pid)?.result).toBeNull();
  expect(stopped).toBe(false);
  section.exit();
  cleanups.pop();
  await f.s.waitForExit(0, f.root.pid);
  expect(stopped).toBe(true);
  expect(new Int32Array(identity.capabilities)[token.reservation.targetKey + 1]).toBe(0);
  expect(await fs.client.asyncCall("readFile", ["/file"])).toEqual(
    new TextEncoder().encode("abcdef"),
  );
});
for (const fatal of [false, true])
  test(`actual blocked worker CLEANUP is notified by retirement and preserves fatal/handled signals (fatal=${fatal})`, async () => {
    const fence = Promise.withResolvers<void>();
    const physical = Promise.withResolvers<void>();
    let child = 0;
    const f = sharedFixture({
      quiesce: (pid) => (pid === child ? fence.promise : undefined),
      launch: () => ({ terminate: () => physical.promise }),
    });
    cleanups.push(() => {
      fence.resolve();
      physical.resolve();
    });
    child = f.root.spawn(f.root.pid, spec(true));
    const childTransport = await f.admit();
    const job = workerProcessState(childTransport).job;
    f.root.killJob(job, 9);
    await f.broker.handle(f.messages.shift()!, f.root.pid);
    setSignalDisposition(f.root.signals.signalState, 15, 2, f.root.signals.interrupt);
    requestSignal(f.root.signals, 15);
    const worker = cleanupWorker(f, job);
    await worker.ready;
    requestSignal(f.root.signals, 15);
    if (fatal) {
      f.root.kill(f.root.pid, 9);
      await f.broker.handle(f.messages.shift()!, f.root.pid);
      expect(await worker.finished).toMatchObject({ kind: "fatal", signal: 9 });
      expect(f.s.get(f.root.pid)?.result).toBeNull();
    }
    fence.resolve();
    await turn();
    if (!fatal) expect(f.root.jobCleanupReady(f.root.pid, job)).toBe(false);
    physical.resolve();
    if (fatal) await f.s.waitForExit(0, f.root.pid);
    else
      expect(await worker.finished).toMatchObject({
        kind: "complete",
        result: 0,
        pending: SIGNAL_PENDING,
        first: 15,
        second: 0,
        outcome: [1, 9],
      });
    await Promise.all(worker.notices);
    expect(f.s.job(job)).toBeUndefined();
  });
