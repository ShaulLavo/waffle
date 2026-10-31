import { testReservations } from "./fixtures/shared-memory-platform.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { NotificationWaitScope } from "../browser/notification-wait.js";
import { NetHost } from "../browser/net/host.js";
import { createRing } from "../browser/net/ring.js";
import { FilesystemClient } from "../fs/client.js";
import { createNotificationBridge } from "../browser/notification-relay.js";
import { FilesystemService } from "../fs/service.js";
import { MemoryBackend } from "../fs/backend.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  createFilesystemConnection,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
} from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ProcessTable } from "../proc/table.js";
import { ExecutableRegistry } from "../proc/registry.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { DescriptorTable } from "../core/descriptors.js";
import type { NotificationRuntimeRequest } from "./fixtures/notification-runtime-worker.js";
import { processContextGuest } from "./fixtures/process-context-guest.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

class Notices {
  private readonly events = new Map<string, unknown>();
  private readonly listeners = new Map<string, (value: unknown) => void>();
  accept(data: unknown): void {
    if (!data || typeof data !== "object" || !("type" in data) || typeof data.type !== "string")
      return;
    this.events.set(data.type, data);
    this.listeners.get(data.type)?.(data);
  }
  wait(type: string): Promise<unknown> {
    if (this.events.has(type)) return Promise.resolve(this.events.get(type));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(type);
        reject(Error(`Worker notice ${type} timed out`));
      }, 3000);
      this.listeners.set(type, (value) => {
        clearTimeout(timeout);
        this.listeners.delete(type);
        resolve(value);
      });
    });
  }
}

export async function bootstrapNotificationCase(
  workerUrl: string,
  helperUrl: string,
  mode: "arm" | "reject" | "relay",
) {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  const bridge = createNotificationBridge(helperUrl);
  const worker = new Worker(workerUrl, { type: "module" });
  const notices = new Notices();
  const marker = new Int32Array(new SharedArrayBuffer(16));
  service.connect(pair.server);
  worker.onmessage = ({ data }) => notices.accept(data);
  try {
    worker.postMessage(
      {
        module: processContextGuest,
        filesystem: pair.client,
        notifications: bridge.connection,
        args: [],
        env: {},
        mode,
        marker,
      },
      [pair.client.port, bridge.connection.port],
    );
    await notices.wait("notification-arming");
    if (mode === "arm") await bridge.dispose();
    await notices.wait("notification-bootstrap-settled");
    check(Atomics.load(marker, 0) === 0, "cancelled/rejected startup entered guest");
    check(Atomics.load(marker, 1) === 1, "bootstrap cleanup did not run exactly once");
    check(Atomics.load(bridge.connection.state, 1) === 1, "startup did not fence external owner");
    if (mode === "relay")
      check(marker[3] === 1, "startup did not receive the actual relay error reply");
    return { mode, entries: marker[0], cleanups: marker[1], relayReply: marker[3] };
  } finally {
    await bridge.dispose();
    await worker.terminate();
    await service.shutdown();
  }
}

function controlTermination(helperUrl: string, fail: boolean) {
  const NativeWorker = globalThis.Worker;
  const workers: { id: number; helper: boolean; requests: number; terminations: number }[] = [];
  const order: {
    id: number;
    worker: "helper" | "guest" | "unused";
    requests: number;
    fenced: boolean;
  }[] = [];
  let fence: Int32Array | undefined;
  let release!: () => void;
  let began!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  globalThis.Worker = class extends NativeWorker {
    private readonly observed: (typeof workers)[number];
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.observed = {
        id: workers.length,
        helper: String(url) === helperUrl,
        requests: 0,
        terminations: 0,
      };
      workers.push(this.observed);
    }
    postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
      this.observed.requests++;
      if (Array.isArray(transfer)) {
        super.postMessage(message, transfer);
        return;
      }
      super.postMessage(message, transfer);
    }
    terminate(): Promise<void> {
      this.observed.terminations++;
      order.push({
        id: this.observed.id,
        worker: this.observed.helper ? "helper" : this.observed.requests ? "guest" : "unused",
        requests: this.observed.requests,
        fenced: !!fence && Atomics.load(fence, 1) === 1,
      });
      const physical = super.terminate();
      if (!this.observed.helper) return Promise.resolve(physical);
      began();
      return Promise.resolve(physical)
        .then(() => gate)
        .then(() => {
          if (fail) throw new Error("relay termination failed after physical stop");
        });
    }
  };
  return {
    workers,
    order,
    started,
    release,
    set fence(value: Int32Array) {
      fence = value;
    },
    restore() {
      globalThis.Worker = NativeWorker;
    },
  };
}

export async function brokerNotificationCase(
  workerUrl: string,
  helperUrl: string,
  revoke: boolean,
  relayFailure = false,
) {
  const termination = controlTermination(helperUrl, relayFailure);
  const service = new FilesystemService(new MemoryBackend());
  const identities = new ProcessIdentityAllocator();
  const registry = new ExecutableRegistry();
  registry.register("notification", {
    adapter: "fixture",
    module: processContextGuest,
    interruptible: true,
  });
  const marker = new Int32Array(new SharedArrayBuffer(16));
  const notices = new Notices();
  const diagnostics: unknown[] = [];
  let hostCleanups = 0;
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table: new ProcessTable(identities),
    registry,
    filesystem: {
      connect(identity) {
        const pair = connectFilesystemIdentity(identity);
        service.connect(pair.server);
        return pair.client;
      },
      revoke: revokeFilesystem,
      reap: reapFilesystem,
      quiesce: waitForFilesystemQuiescence,
    },
    launch(context) {
      return broker.launchWorker<NotificationRuntimeRequest>(context, {
        workerUrl,
        notificationWorkerUrl: helperUrl,
        request: { module: context.module, args: [], env: {}, mode: "park", marker },
        onMessage: (data) => notices.accept(data),
        cleanup: () => {
          hostCleanups++;
        },
      });
    },
    onError: (error) => diagnostics.push(error),
  });
  const transport = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  transport.data = { filesystem: createFilesystemIdentity() };
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: {
      export() {
        throw Error("unused");
      },
      import() {
        throw Error("unused");
      },
      discard() {},
    },
    postMessage: (message) => messages.push(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
  });
  try {
    await broker.adoptRuntimeRoot(transport, { memory: [] });
    const pid = client.spawn(client.pid, {
      executable: "notification",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    for (const message of messages) await broker.runtimeMessage(message, client.pid);
    await (await broker.ready()).start(pid);
    const parked = await notices.wait("notification-parked");
    check(
      parked &&
        typeof parked === "object" &&
        "state" in parked &&
        parked.state instanceof Int32Array,
      "real Worker did not expose its external test fence",
    );
    termination.fence = parked.state;
    const borrowers = termination.workers.filter((worker) => !worker.helper && worker.requests);
    check(
      borrowers.length === 1 && borrowers[0]?.requests === 1,
      "expected one single-request borrower",
    );
    const borrower = borrowers[0]!;
    if (revoke) {
      broker.revokeRuntimeProcess(pid);
      await notices.wait("notification-fenced");
    }
    const disposal = broker.dispose();
    const settled = disposal.then(
      () => undefined,
      (error: unknown) => error,
    );
    check(disposal === broker.dispose(), "broker disposal did not join the same physical cleanup");
    await termination.started;
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      !termination.order.some((event) => event.id === borrower.id),
      "guest termination began before relay disposal settled",
    );
    const unused = termination.workers.filter((worker) => !worker.helper && worker.requests === 0);
    check(
      unused.length === 2 && unused.every((worker) => worker.terminations === 1),
      "unused idle workers were not disposed exactly once independently of the relay",
    );
    termination.release();
    const failure = await settled;
    check(
      relayFailure ? failure instanceof AggregateError : failure === undefined,
      "unexpected broker stop result",
    );
    check(hostCleanups === 1, "host cleanup did not run exactly once after physical stop");
    check(Atomics.load(parked.state, 1) === 1, "physical termination left helper unfenced");
    check(
      Atomics.load(marker, 0) === 0 && Atomics.load(marker, 1) === 0,
      "physical termination relied on guest entry/cleanup",
    );
    check(relayFailure || diagnostics.length === 0, `broker cleanup diagnostics: ${diagnostics}`);
    const processOrder = termination.order.filter((event) => event.worker !== "unused");
    check(
      termination.workers.every((worker) => worker.terminations === 1),
      "a native Worker was leaked or terminated more than once",
    );
    check(
      processOrder.length === 2 &&
        processOrder[0]?.worker === "helper" &&
        processOrder[1]?.id === borrower.id &&
        processOrder.every((event) => event.fenced),
      `native Worker termination was not externally fenced: ${JSON.stringify(termination.order)}`,
    );
    return {
      revoke,
      externalClosed: parked.state[1],
      guestCleanups: marker[1],
      hostCleanups,
      joined: true,
      relayFailure,
      terminationOrder: termination.order,
    };
  } finally {
    try {
      termination.release();
      await broker.dispose().catch(() => {});
      descriptors.dispose();
      await service.shutdown();
    } finally {
      termination.restore();
    }
  }
}

class ThrowingReleaseNetwork extends NetHost {
  releases = 0;
  failRelease = true;
  override registerNotificationSink(wake: Int32Array): () => void {
    const detach = super.registerNotificationSink(wake);
    return () => {
      detach();
      this.releases++;
      if (this.failRelease) throw new Error("network release failed");
    };
  }
}

export async function scopeDisposalFailureCase(
  helperUrl: string,
  detachPort: boolean,
  Scope = NotificationWaitScope,
  failRelease = true,
) {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const fs = new FilesystemClient(pair.client);
  const bridge = createNotificationBridge(helperUrl);
  const network = new ThrowingReleaseNetwork(createRing(), () => {});
  network.failRelease = failRelease;
  const scope = new Scope(bridge.connection, fs);
  const arm = scope.arm({ network }).then(
    () => "armed",
    (error: unknown) => String(error),
  );
  let transferred: MessagePort | undefined;
  try {
    if (detachPort) {
      const moved = structuredClone(bridge.connection.port, { transfer: [bridge.connection.port] });
      transferred = moved;
    }
    const sequence = Atomics.load(bridge.connection.state, 0);
    let failure: unknown;
    try {
      scope.dispose();
    } catch (error) {
      failure = error;
    }
    await scope.closed;
    check(
      String(failure).includes(failRelease ? "network release failed" : "dispose send failed"),
      "first cleanup failure was not reported",
    );
    check((await arm).includes("closed during arming"), "disposal did not reject pending arm");
    check(
      Atomics.load(bridge.connection.state, 1) === 1,
      "scope disposal did not fence external state",
    );
    check(
      Atomics.load(bridge.connection.state, 0) > sequence,
      "scope disposal did not publish wake",
    );
    try {
      scope.dispose();
    } catch {
      /* Retained failure is reported without repeating release. */
    }
    check(network.releases === 1, "scope release was repeated");
    return { detachPort, releases: network.releases, closed: true, pendingArmRejected: true };
  } finally {
    transferred?.close();
    await bridge.dispose();
    network.dispose();
    fs.dispose();
    await service.shutdown();
  }
}

export async function scopeSendFailureCase(workerUrl: string, helperUrl: string) {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const bridge = createNotificationBridge(helperUrl);
  const worker = new Worker(workerUrl, { type: "module" });
  const notices = new Notices();
  worker.onmessage = ({ data }) => notices.accept(data);
  worker.onerror = (event) => notices.accept({ type: "send-failure", error: event.message });
  try {
    worker.postMessage({ filesystem: pair.client, notifications: bridge.connection }, [
      pair.client.port,
      bridge.connection.port,
    ]);
    const result = await notices.wait("send-failure");
    check(
      result &&
        typeof result === "object" &&
        "failure" in result &&
        result.failure === "Error: dispose send failed",
      `real send failure was not reported: ${JSON.stringify(result)}`,
    );
    check("closes" in result && result.closes === 1, "send failure skipped native port closure");
    check(
      "rejection" in result && String(result.rejection).includes("closed during arming"),
      `send failure stranded pending arm: ${JSON.stringify(result)}`,
    );
    check(
      "fenced" in result &&
        result.fenced === 1 &&
        "sequence" in result &&
        Number(result.sequence) > 0,
      "send failure skipped fence/wake",
    );
    return { sendFailed: true, closes: result.closes };
  } finally {
    await bridge.dispose();
    await worker.terminate();
    await service.shutdown();
  }
}
