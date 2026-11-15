import { expect } from "bun:test";
import { BrowserProcessBroker } from "../../browser/process-broker.js";
import type { RuntimeWorkerRequest } from "../../browser/worker.js";
import { DescriptorTable } from "../../core/descriptors.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
} from "../../fs/protocol.js";
import { ProcessIdentityAllocator } from "../../proc/identity.js";
import { ExecutableRegistry } from "../../proc/registry.js";
import { ProcessTable } from "../../proc/table.js";
import type { ProcessHandle } from "../../proc/types.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../../proc/worker-client.js";
import { observationModule, awaitObservationBarrier } from "./process-observation-controls.js";
import { testReservations } from "./shared-memory-platform.js";

type Options = {
  owned?: boolean;
  adapterHeld?: boolean;
  nativeHeld?: boolean;
  lateHandle?: boolean;
  joinJob?: number;
};
type Event = { phase: string; pid: number; serial: number };
type AdmissionActor = ReturnType<typeof actor>;
function actor(pid: number, options: Options) {
  const adapter = Promise.withResolvers<void>();
  const native = Promise.withResolvers<void>();
  const handle = Promise.withResolvers<void>();
  if (!options.adapterHeld) adapter.resolve();
  if (!options.nativeHeld) native.resolve();
  if (!options.lateHandle) handle.resolve();
  return {
    pid,
    gate: new Int32Array(new SharedArrayBuffer(12)),
    filesystem: createFilesystemIdentity(),
    adapter,
    native,
    handle,
    starting: Promise.resolve(),
    serial: 0,
  };
}
export function releaseSection(entry: AdmissionActor) {
  Atomics.store(entry.gate, 1, 1);
  Atomics.notify(entry.gate, 1);
}
async function acceptHandle(entry: AdmissionActor, handle: ProcessHandle, events: Event[]) {
  await entry.handle.promise;
  events.push({ phase: "adapter-returned", pid: entry.pid, serial: entry.serial });
  return {
    terminate() {
      events.push({ phase: "accepted-handle-invoked", pid: entry.pid, serial: entry.serial });
      return observeStop(entry, handle.terminate(), events, "accepted-handle");
    },
  };
}
function observeStop(
  entry: AdmissionActor,
  stopping: void | Promise<void>,
  events: Event[],
  prefix: string,
) {
  const event = (phase: string) => events.push({ phase, pid: entry.pid, serial: entry.serial });
  if (stopping)
    void stopping.then(
      () => event(`${prefix}-fulfilled`),
      () => event(`${prefix}-rejected`),
    );
  else event(`${prefix}-fulfilled`);
  return stopping;
}

/** Controls own real Workers; only the unavailable platform refusal is injected. */
export async function admissionControl(capacity = 16) {
  const NativeWorker = globalThis.Worker;
  const workers: ControlledWorker[] = [];
  const ports: MessagePort[] = [];
  const descriptors: DescriptorTable[] = [];
  const errors: unknown[] = [];
  const events: Event[] = [];
  const actors = new Map<number, AdmissionActor>();
  const sections = new Map<SharedArrayBuffer, AdmissionActor>();
  const notices: { sender: number; message: WorkerProcessMessage }[] = [];
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const registry = new ExecutableRegistry();
  const reservations = testReservations();
  let supplied: Options = {};
  let constructing: AdmissionActor | undefined;
  let attempts = 0;
  let injected: Error | undefined;
  registry.register("fixture", {
    adapter: "fixture",
    module: observationModule,
    interruptible: true,
  });

  class ControlledWorker extends NativeWorker {
    private stopping?: Promise<void>;
    readonly entry: AdmissionActor;
    constructor(url: string | URL, options?: WorkerOptions) {
      attempts++;
      if (injected) {
        const error = injected;
        injected = undefined;
        throw error;
      }
      const entry = constructing;
      if (!entry) throw new Error("unbound Worker acquisition");
      super(url, options);
      this.entry = entry;
      entry.serial = workers.length + 1;
      workers.push(this);
      events.push({ phase: "constructed", pid: entry.pid, serial: entry.serial });
    }
    override terminate(): Promise<void> {
      if (this.stopping) return this.stopping;
      const stopping = (this.stopping = this.stopNow());
      observeStop(this.entry, stopping, events, "native-stop");
      return stopping;
    }
    private async stopNow() {
      const entry = this.entry;
      events.push({ phase: "native-invoked", pid: entry.pid, serial: entry.serial });
      await entry.native.promise;
      await super.terminate();
      events.push({ phase: "native-api-returned", pid: entry.pid, serial: entry.serial });
    }
  }
  const broker = new BrowserProcessBroker({
    reservations,
    identities,
    table,
    registry,
    onError: (error) => errors.push(error),
    filesystem: {
      connect(identity) {
        const pair = connectFilesystemIdentity(identity);
        ports.push(pair.client.port, pair.server.port);
        return pair.client;
      },
      revoke: revokeFilesystem,
      reap: reapFilesystem,
      async quiesce(identity) {
        const entry = sections.get(identity.sections);
        if (entry) events.push({ phase: "fs-entered", pid: entry.pid, serial: entry.serial });
        await waitForFilesystemQuiescence(identity);
        if (entry) events.push({ phase: "fs-returned", pid: entry.pid, serial: entry.serial });
      },
    },
    launch(context): ProcessHandle | Promise<ProcessHandle> {
      const entry = actors.get(context.pid);
      if (!entry) throw new Error("missing actor");
      broker.registerController(context.pid, { quiesce: () => entry.adapter.promise });
      constructing = entry;
      let handle: ProcessHandle;
      try {
        handle = broker.launchWorker<RuntimeWorkerRequest & { gate: SharedArrayBuffer }>(context, {
          workerUrl: new URL("./process-observation-worker.ts", import.meta.url).href,
          request: { module: context.module, args: [], env: {}, gate: entry.gate.buffer },
        });
      } finally {
        constructing = undefined;
      }
      return acceptHandle(entry, handle, events);
    },
  });

  function client(transport: WorkerProcessTransport) {
    const fds = new DescriptorTable();
    descriptors.push(fds);
    return new WorkerProcessClient({
      transport,
      descriptors: fds,
      codec: {
        export(): never {
          throw new Error("no descriptors in this control");
        },
        import(): never {
          throw new Error("no descriptors in this control");
        },
        discard() {},
      },
      postMessage: (message) => notices.push({ sender: transport.pid, message }),
      prepareSpawn(pid) {
        const entry = actor(pid, supplied);
        actors.set(pid, entry);
        sections.set(entry.filesystem.sections, entry);
        return { data: { filesystem: entry.filesystem } };
      },
    });
  }
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
    capacity,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  const parent = client(root);
  const dispose = async () => {
    for (const entry of actors.values()) {
      releaseSection(entry);
      entry.adapter.resolve();
      entry.native.resolve();
      entry.handle.resolve();
    }
    try {
      await broker.dispose();
    } finally {
      await stopWorkers();
    }
  };
  async function stopWorkers() {
    try {
      await Promise.all(workers.map((worker) => worker.terminate()));
    } finally {
      for (const port of ports) port.close();
      for (const fds of descriptors) fds.dispose();
      reservations.dispose();
      globalThis.Worker = NativeWorker;
    }
  }
  globalThis.Worker = ControlledWorker;
  try {
    await broker.adoptRuntimeRoot(root, { memory: [] });
    const supervisor = await broker.ready();
    async function spawn(owner = parent, options: Options = {}) {
      supplied = options;
      const pid = owner.spawn(owner.pid, {
        executable: "fixture",
        argv: [],
        env: {},
        cwd: "/",
        job: options.joinJob ?? -1,
        fds: [],
        ...(options.owned ? { jobLifetime: "caller-fatal" } : {}),
      });
      const notice = notices.shift();
      if (!notice) throw new Error("missing accepted notice");
      await broker.runtimeMessage(notice.message, notice.sender);
      const entry = actors.get(pid);
      if (!entry) throw new Error("missing reserved actor");
      entry.starting = supervisor.start(pid);
      return entry;
    }
    const ready = (entry: AdmissionActor) =>
      awaitObservationBarrier(() => Atomics.load(entry.gate, 0) === 1);
    const phase = (entry: AdmissionActor, name: string) =>
      events.some((event) => event.pid === entry.pid && event.phase === name);
    function scalar(label: string) {
      return {
        label,
        attempts,
        constructed: workers.length,
        errors: errors.length,
        events: events.slice(),
      };
    }
    function assertFresh() {
      expect(new Set(workers).size).toBe(workers.length);
      for (const worker of workers) expect(broker.isIdleWorker(worker)).toBe(false);
    }
    return {
      broker,
      supervisor,
      parent,
      spawn,
      client,
      ready,
      phase,
      scalar,
      errors,
      dispose,
      assertFresh,
      attempts: () => attempts,
      inject: (error: Error) => {
        injected = error;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
