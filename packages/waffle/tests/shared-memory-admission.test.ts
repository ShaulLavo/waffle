import { expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker";
import { createSharedMemoryLedger, bytes, pages } from "../memory";
import { DescriptorTable } from "../core/descriptors";
import { connectFilesystemIdentity, createFilesystemIdentity } from "../fs/protocol";
import { ProcessIdentityAllocator } from "../proc/identity";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessTable } from "../proc/table";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client";
import type { ProcessContext } from "../proc/types";

const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

test("broker refuses before filesystem connection or Worker construction", async () => {
  const previousWorker = globalThis.Worker;
  let workers = 0;
  let connections = 0;
  globalThis.Worker = class {
    constructor() { workers++; }
    postMessage() {}
    terminate() {}
  } as unknown as typeof Worker;
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const ledger = createSharedMemoryLedger({ platform: { kind: "bounded", budgetBytes: bytes(0), counts: { "fixed-buffer": true, "shared-memory": true, "private-memory": true } }, allocator: {
    createBuffer: () => new SharedArrayBuffer(1),
    createMemory: () => new WebAssembly.Memory({ initial: 0, maximum: 1 }),
  } });
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry: new ExecutableRegistry(),
    sharedMemory: ledger,
    filesystem: {
      connect(identity) { connections++; return connectFilesystemIdentity(identity).client; },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() { throw new Error("adapter launch should not run"); },
  });
  const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const state = workerProcessState(root);
  const context = {
    pid: state.pid,
    parentPid: 0,
    job: state.job,
    request: { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] },
    module: emptyModule,
    adapter: "fixture",
    interruptible: false,
    descriptors: new DescriptorTable(),
    interrupt: state.signals.interrupt,
    requestedSignal: state.signals.requestedSignal,
    signalState: state.signals.signalState,
    outcome: state.signals.outcome,
    exit() {},
    fail() {},
    defaultSignal() {},
    registerRevocation() { return () => {}; },
  } satisfies ProcessContext;
  try {
    await broker.adoptRuntimeRoot(root);
    await expect(broker.launchWorker(context, {
      workerUrl: "https://example.test/guest.js",
      request: { module: emptyModule, args: [], env: {} },
      reservation: { memory: "private", maximumPages: pages(1) },
    })).rejects.toMatchObject({ errno: 48, code: "ENOMEM" });
    expect(workers).toBe(0);
    expect(connections).toBe(0);
    expect(ledger.snapshot().reservedBytes).toBe(0);
  } finally {
    await broker.dispose();
    globalThis.Worker = previousWorker;
  }
});
