import { expect, test } from "bun:test";
import { Worker as NodeWorker } from "node:worker_threads";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { createPreview1Network } from "../browser/preview1-network.js";
import { createRuntimeNetwork } from "../browser/net/runtime.js";
import { createRuntimeTerminalCodec } from "../browser/runtime-terminals.js";
import { RIGHTS_ALL } from "../core/rights.js";
import { DescriptorTable } from "../core/descriptors.js";
import { testReservations } from "./fixtures/shared-memory-platform.js";
import { FilesystemRequestPool } from "../fs/request-memory.js";
import { SharedMemoryLedger, declareSharedMemoryPlatform, bytes } from "../memory/reservations.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemService } from "../fs/service.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
} from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import type { RuntimeWorkerRequest, RuntimeWorkerMessage } from "../browser/worker.js";
import { nodeWorkerTransfers } from "./fixtures/node-worker-transfers.js";
import { socketModule, scriptedSocket } from "./preview1-socket-support.js";

function launchReservations(bounded: boolean) {
  if (!bounded) return testReservations();
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(96 * 1024 ** 2),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
  });
  return new SharedMemoryLedger(platform).openRuntime(platform);
}

for (const failure of [false, "post", "link", "host-call", "budget"] as const)
  test(`broker-owned generic launch transfers only cloneable socket data, startup failure=${failure}`, async () => {
    const originalWorker = globalThis.Worker;
    const workers: NodeWorker[] = [];
    const ports: MessagePort[] = [];
    const requests: RuntimeWorkerRequest[] = [];
    const diagnostics: unknown[] = [];
    const output: Uint8Array[] = [];
    const networkOwner = await createRuntimeNetwork(() => {});
    const stream = scriptedSocket(false, true);
    let connects = 0;
    const network = await createPreview1Network(
      { network: async () => networkOwner.network },
      {
        sockets: [{ fd: 3, socket: { connect: { host: "echo.example", port: 4321 } } }],
        connect: async () => {
          connects++;
          return stream.stream;
        },
      },
    );
    if (!network) throw Error("socket launch missing");
    let releases = 0;
    const owned = {
      connection: network.connection,
      dispose() {
        releases++;
        network.dispose();
      },
    };
    const reservations = launchReservations(failure === "budget");
    const pools = new WeakMap<SharedArrayBuffer, FilesystemRequestPool>();
    const filesystem = new FilesystemService(new MemoryBackend());
    const identities = new ProcessIdentityAllocator();
    const table = new ProcessTable(identities);
    const registry = new ExecutableRegistry();
    const module = await socketModule(
      failure === "link" ? "preview1-socket-unknown.wat" : "preview1-socket.wat",
    );
    registry.register("socket", { module, adapter: "preview1" });
    class EmbeddingWorker {
      onmessage: ((event: { data: RuntimeWorkerMessage }) => void) | null = null;
      onerror: ((event: { preventDefault(): void; message: string; error: Error }) => void) | null =
        null;
      private readonly native = new NodeWorker(
        new URL(
          failure === "host-call"
            ? "./fixtures/preview1-socket-worker.ts"
            : "./fixtures/generic-memory-node-worker.ts",
          import.meta.url,
        ),
      );
      constructor() {
        workers.push(this.native);
        this.native.on("message", (data) => this.onmessage?.({ data }));
        this.native.on("error", (reason) => {
          const error = reason instanceof Error ? reason : new Error(String(reason));
          this.onerror?.({ preventDefault() {}, error, message: error.message });
        });
      }
      postMessage(request: RuntimeWorkerRequest, transfer: Transferable[]) {
        requests.push(request);
        if (failure === "post") throw Error("fixture postMessage failure");
        const message = failure === "host-call" ? { request, hostCallFd: 3 } : request;
        this.native.postMessage(message, nodeWorkerTransfers(transfer));
      }
      terminate() {
        return this.native.terminate();
      }
    }
    const broker = new BrowserProcessBroker({
      reservations,
      identities,
      table,
      registry,
      onError: (error) => diagnostics.push(error),
      filesystem: {
        connect(identity, headroom) {
          const pool =
            pools.get(identity.requestBudget) ??
            new FilesystemRequestPool(identity.requestBudget, undefined, reservations.arenas);
          pools.set(identity.requestBudget, pool);
          const pair = connectFilesystemIdentity(identity, pool, undefined, headroom);
          ports.push(pair.client.port, pair.server.port);
          filesystem.connect(pair.server);
          return pair.client;
        },
        revoke: revokeFilesystem,
        reap: reapFilesystem,
        quiesce: waitForFilesystemQuiescence,
      },
      launch: (context) =>
        broker.launchWorker(context, {
          workerUrl: "generic",
          network: owned,
          request: { module, args: [], env: {} },
        }),
    });
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
      capacity: 3,
    });
    const rootFilesystem = createFilesystemIdentity();
    root.data = { filesystem: rootFilesystem };
    const descriptors = new DescriptorTable();
    descriptors.openAt(
      1,
      {
        kind: "terminal",
        read: () => 0,
        write: () => 0,
        readiness: () => ({ readable: true, writable: true, hangup: false }),
      },
      RIGHTS_ALL,
      0n,
    );
    const notices: WorkerProcessMessage[] = [];
    const unavailable = (): never => {
      throw Error("fixture has no descriptor transfers");
    };
    const parent = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: createRuntimeTerminalCodec({
        descriptors,
        fallback: { export: unavailable, import: unavailable, discard: unavailable },
      }),
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(rootFilesystem) } }),
      postMessage: (message) => notices.push(message),
    });
    globalThis.Worker = EmbeddingWorker as unknown as typeof Worker;
    try {
      await broker.adoptRuntimeRoot(root, { memory: [], output: (_fd, data) => output.push(data) });
      const service = await broker.ready();
      const pid = parent.spawn(parent.pid, {
        executable: "socket",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [{ parent: 1, child: 1 }],
      });
      for (const message of notices) await broker.runtimeMessage(message, root.pid);
      await service.start(pid);
      expect(await service.waitForExit(root.pid, pid)).toMatchObject(
        failure === "budget"
          ? { kind: "start-failed", error: "ENOMEM" }
          : failure === "host-call"
            ? { kind: "start-failed", error: "ENOEXEC" }
            : failure
              ? { kind: "start-failed", error: "EIO" }
              : { kind: "exited", code: 0 },
      );
      if (failure === "budget") {
        expect(requests).toEqual([]);
        expect(workers).toEqual([]);
        expect(connects).toBe(0);
      } else {
        expect(Object.keys(requests[0]!.network!).sort()).toEqual(["port", "ring", "sockets"]);
      }
      expect(releases).toBe(1);
      if (failure === "host-call") expect(connects).toBe(0);
      if (!failure) expect(Buffer.concat(output).toString()).toBe("waffle echo\n");
      if (!failure) expect(diagnostics).toEqual([]);
    } finally {
      await broker.dispose();
      await Promise.all(workers.map((worker) => worker.terminate()));
      network.dispose();
      await networkOwner.dispose();
      filesystem.dispose();
      descriptors.dispose();
      ports.forEach((port) => port.close());
      reservations.dispose();
      globalThis.Worker = originalWorker;
    }
  });

test("socket inheritance is rejected before process admission or worker export", async () => {
  const { ProcessSupervisor } = await import("../proc/supervisor.js");
  const descriptions = new DescriptorTable();
  descriptions.openAt(
    3,
    {
      kind: "socket",
      read: () => 0,
      write: () => 0,
      readiness: () => ({ readable: true, writable: true, hangup: false }),
    },
    RIGHTS_ALL,
    0n,
  );
  const registry = new ExecutableRegistry();
  const supervisor = new ProcessSupervisor({
    registry,
    launch: () => {
      throw Error("must not launch");
    },
  });
  const parentPid = supervisor.createRoot({ descriptors: descriptions });
  const request = {
    executable: "/socket",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [{ parent: 3, child: 3 }],
  };
  const transport = createWorkerProcessTransport({ pid: 1, job: 1, capacity: 2 });
  const unavailable = (): never => {
    throw Error("must not export a socket");
  };
  const client = new WorkerProcessClient({
    transport,
    descriptors: descriptions,
    codec: { export: unavailable, import: unavailable, discard: unavailable },
    postMessage: unavailable,
  });
  try {
    expect(() => supervisor.spawn(parentPid, request)).toThrow(
      expect.objectContaining({ errno: 58 }),
    );
    expect(() => client.spawn(1, request)).toThrow(expect.objectContaining({ errno: 58 }));
  } finally {
    supervisor.dispose();
    descriptions.dispose();
  }
});
