import { expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker";
import { ProcessIdentityAllocator } from "../proc/identity";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessTable } from "../proc/table";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client";
import { createFilesystemIdentity } from "../fs/protocol";

test("one browser process owner admits multiple roots with shared monotonically allocated identities", async () => {
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unknown adapter"); },
  });
  try {
    const first = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    const second = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    first.data = { filesystem: createFilesystemIdentity() };
    second.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(first);
    const supervisor = await broker.ready();
    await broker.adoptRuntimeRoot(second);
    expect(supervisor.table).toBe(table);
    expect(supervisor.get(workerProcessState(first).pid)?.parentPid).toBe(0);
    expect(supervisor.get(workerProcessState(second).pid)?.parentPid).toBe(0);
    expect(workerProcessState(second).pid).toBeGreaterThan(workerProcessState(first).pid);
    await broker.rootExit(workerProcessState(first).pid, 0);
    expect(supervisor.get(workerProcessState(second).pid)?.result).toBeNull();
  } finally { await broker.dispose(); }
});

test("root admission cannot create a live process behind concurrent disposal", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  const admission = broker.adoptRoot({ pid: identities.pid(), job: identities.job() });
  const disposal = broker.dispose();
  await expect(admission).rejects.toThrow(/disposed/);
  await disposal;
  expect(Array.from(table.values())).toHaveLength(0);
});

test("revocation never allocates a process in an unrelated root pipe registry", async () => {
  const { PipePublicationRegistry } = await import("../proc/pipes");
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  const roots = [0, 1].map(() => {
    const transport = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    transport.data = { filesystem: createFilesystemIdentity(), pipeRegistry: new PipePublicationRegistry({ processCapacity: 1, cellsPerProcess: 1, maxCells: 1 }).handle() };
    return transport;
  });
  try {
    for (const root of roots) await broker.adoptRuntimeRoot(root);
    await broker.ready();
    for (const root of roots) await broker.rootExit(workerProcessState(root).pid, 0);
    expect(Array.from(table.values(), record => record.result?.status)).toEqual([0, 0]);
  } finally { await broker.dispose(); }
});

test("failed direct root activation retains its consumer fence and stop capability", async () => {
  const proc = await import("../proc");
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const failure = new Error("partial root initialization failed");
  let release!: () => void;
  const fence = new Promise<void>(resolve => { release = resolve; });
  let revoked = 0, stopped = 0, descriptorsReleased = 0;
  class PartialSupervisor extends proc.ProcessSupervisor {
    override createRoot(options: Parameters<proc.ProcessSupervisor["createRoot"]>[0]): never {
      const pid = super.createRoot(options);
      this.get(pid)!.descriptors.open({ kind: "terminal", read: () => 0, write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }) }, 0n, 0n,
      () => { descriptorsReleased++; });
      throw failure;
    }
  }
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    activate: async () => ({ ...proc, ProcessSupervisor: PartialSupervisor }), onError() {},
    filesystem: { connect() { throw new Error("unused"); }, revoke() { revoked++; }, reap() {}, quiesce: () => fence },
    launch() { throw new Error("unused"); },
  });
  try {
    await expect(broker.adoptRoot({ pid: identities.pid(), job: identities.job() }, {
      filesystem: createFilesystemIdentity(), stop() { stopped++; },
    })).rejects.toBe(failure);
    const disposal = broker.dispose();
    expect(revoked).toBe(1);
    expect(stopped).toBe(0);
    expect(descriptorsReleased).toBe(1);
    release();
    await disposal;
    expect(stopped).toBe(1);
    expect(Array.from(table.values())).toHaveLength(0);
  } finally { release(); await broker.dispose(); }
});

test("adopting and closing a pipe-only root never activates a supervisor", async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  let activations = 0;
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    activate: async () => { activations++; return import("../proc"); },
    filesystem: { connect() { throw new Error("unused"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { throw new Error("unused"); },
  });
  try {
    const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
    root.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(root);
    await broker.rootExit(workerProcessState(root).pid, 0);
    expect(activations).toBe(0);
    expect(Array.from(table.values())).toHaveLength(0);
  } finally { await broker.dispose(); }
});
