import { startFixtureChild } from "./fixtures/browser-process-child.js";
import { expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  revokeFilesystem,
} from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { WorkerPipeHost } from "../proc/worker-pipes.js";
import { controlLoad } from "../proc/control.js";
import type { ProcessContext } from "../proc/types.js";

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("host failure did not settle")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("host callback failure confirms and physically closes a worker blocked in NetHost.call without an ACK", async () => {
  const previousWorker = globalThis.Worker;
  const workers: Worker[] = [],
    ports: MessagePort[] = [];
  let closed!: () => void, received!: () => void;
  const physicalClose = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const hostFailure = new Promise<void>((resolve) => {
    received = resolve;
  });
  let reaps = 0,
    cleanups = 0;
  let request: unknown;
  class ObservedWorker extends previousWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workers.push(this);
      this.addEventListener("close", () => closed());
    }
  }
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  registry.register("fixture", { adapter: "fixture", module });
  function failHostMessage(message: unknown, context: ProcessContext) {
    request = message;
    try {
      // An embedding host rejects the malformed request before answering its SAB.
      throw new TypeError("invalid tcp-listen port");
    } catch (error) {
      context.fail(error);
    }
    received();
  }
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    filesystem: {
      connect(identity) {
        const { client, server } = connectFilesystemIdentity(identity);
        ports.push(client.port, server.port);
        return client;
      },
      revoke: revokeFilesystem,
      reap() {
        reaps++;
      },
      async quiesce() {},
    },
    launch(context) {
      return broker.launchWorker(context, {
        workerUrl: new URL("./fixtures/host-failure-worker.ts", import.meta.url).href,
        request: { module, args: [], env: {} },
        onMessage: failHostMessage,
        cleanup() {
          cleanups++;
        },
      });
    },
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  const descriptors = new DescriptorTable(),
    messages: WorkerProcessMessage[] = [];
  const host = new WorkerPipeHost({
    transport: root,
    postMessage: (message) => messages.push(message),
  });
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: host.codec(),
    postMessage: (message) => messages.push(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
  });
  globalThis.Worker = ObservedWorker;
  try {
    await broker.adoptRuntimeRoot(root);
    const { pid, supervisor } = await startFixtureChild({ broker, parent: client, messages });
    const transport = broker.transportFor(pid)!;
    await bounded(hostFailure);
    expect(request).toMatchObject({
      type: "net",
      req: { type: "tcp-listen", port: NaN, host: "127.0.0.1" },
    });
    const result = await bounded(supervisor.waitForExit(client.pid, pid));
    expect(result).toEqual({ kind: "exited", code: 126, status: 126 });
    await bounded(physicalClose);
    expect(cleanups).toBe(1);
    expect(reaps).toBe(0);
    expect(controlLoad(workerProcessState(transport).confirmed, 0)).toBe(1);
  } finally {
    try {
      descriptors.dispose();
      await broker.dispose();
      await Promise.all(workers.map((worker) => worker.terminate()));
    } finally {
      for (const port of ports) port.close();
      globalThis.Worker = previousWorker;
    }
  }
});
