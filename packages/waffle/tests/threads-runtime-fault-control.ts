import assert from "node:assert/strict";
import { createRuntime } from "../runtime.ts";
import { BrowserProcessBroker, type ProcessFilesystem } from "../browser/process-broker.ts";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.ts";
import { createWorkerPipeCodec } from "../proc/worker-pipes.ts";
import { DescriptorTable } from "../core/descriptors.ts";
import { guestModule, wait32 } from "./threads-guest-module.ts";
import { bytes, declareSharedMemoryPlatform } from "../memory/index.ts";
import { consumedControlBytes, type SharedControlGrant } from "../memory/control.ts";
import { isRevoked, type FilesystemConnection, type FilesystemIdentity } from "../fs/protocol.ts";
import type { GuestWorkerEvent, GuestWorkerRequest } from "../thread/guest-worker.ts";
import type { ThreadServiceCommand } from "../thread/runtime-protocol.ts";

const selected = process.argv[2];
const NativeWorker = globalThis.Worker;
const workers: Worker[] = [];
const events: string[] = [];
const signals = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
const grants: SharedControlGrant[] = [];
const descriptors = new DescriptorTable();
let connection: FilesystemConnection | undefined;
let canonical: Worker | undefined;
let guestConstructors = 0;
let guestStops = 0;
let serviceStops = 0;
let cleanupCalls = 0;
let uncertainDeliveries = 0;
const unhandled: string[] = [];
process.on("unhandledRejection", (error) => unhandled.push(String(error)));
let fenceStarted = 0;
let fencePassed = 0;
let failure = "";
let guestMemory: WebAssembly.Memory | undefined;
let serviceMemory: WebAssembly.Memory | undefined;
function signal(event: string): void {
  events.push(event);
  signals.get(event)?.resolve();
}
function observed(event: string): Promise<void> {
  if (events.includes(event)) return Promise.resolve();
  let ready = signals.get(event);
  if (!ready) {
    ready = Promise.withResolvers<void>();
    signals.set(event, ready);
  }
  return ready.promise;
}
async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 12000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function outcome<T>(pending: Promise<T>) {
  try {
    return { kind: "value" as const, value: await bounded(pending, "product operation") };
  } catch (error) {
    if (String(error).includes("did not settle")) throw error;
    return { kind: "error" as const, error: String(error) };
  }
}
function filesystemObserver(filesystem: ProcessFilesystem): ProcessFilesystem {
  return {
    ...filesystem,
    quiesce: async (identity: FilesystemIdentity) => {
      const own = identity.sections === connection?.sections;
      if (own) {
        fenceStarted++;
        signal("filesystem-fence-started");
      }
      await filesystem.quiesce(identity);
      if (!own) return;
      assert.equal(isRevoked(identity), true);
      assert.equal(Atomics.load(new Int32Array(identity.sections), 0), 0);
      fencePassed++;
      signal("filesystem-fence-passed");
    },
  };
}
function observeService(worker: Worker): void {
  canonical = worker;
  worker.addEventListener("message", ({ data }) => {
    if (typeof data?.kind !== "string") return;
    if (data.kind === "fixture-failure") failure = data.error;
    if (data.kind === "fixture-drain-started") assert.equal(data.revoked, true);
    signal(data.kind);
  });
}
function observeGuest(worker: Worker): void {
  worker.addEventListener("message", ({ data }: MessageEvent<GuestWorkerEvent>) =>
    signal(data.kind),
  );
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    signal("guest-load-error");
  });
}
function instrumentService(worker: Worker): void {
  observeService(worker);
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (
    message: ThreadServiceCommand,
    transfer: Transferable[] | StructuredSerializeOptions = [],
  ) => {
    const transfers = Array.isArray(transfer) ? transfer : (transfer.transfer ?? []);
    if (message.kind !== "thread-service") return post(message, transfers);
    connection = message.filesystem;
    serviceMemory = message.memory;
    grants.push(message.controlGrant);
    post({ ...message, fixture: selected }, transfers);
  };
  worker.terminate = () => {
    serviceStops++;
    assert.ok(fencePassed > 0, "native service stop requires executed filesystem fence");
    assert.equal(Atomics.load(new Int32Array(connection!.sections), 0), 0);
    signal("service-stop");
    return Reflect.apply(NativeWorker.prototype.terminate, worker, []);
  };
}
function instrumentGuest(worker: Worker): void {
  observeGuest(worker);
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (
    message: GuestWorkerRequest | { kind: "enter" | "close" },
    transfer: Transferable[] | StructuredSerializeOptions = [],
  ) => {
    const transfers = Array.isArray(transfer) ? transfer : (transfer.transfer ?? []);
    if (!("module" in message)) return post(message, transfers);
    guestMemory = message.memory;
    post(message, transfers);
    if (selected !== "guest-post") return;
    uncertainDeliveries++;
    throw new Error("fixture guest delivery failed after native postMessage");
  };
  worker.terminate = () => {
    guestStops++;
    if (selected === "guest-stop") throw new Error("fixture guest physical stop failed");
    return Reflect.apply(NativeWorker.prototype.terminate, worker, []);
  };
}
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    const guest = String(url).includes("/thread/guest-bootstrap");
    if (guest) guestConstructors++;
    if (guest && selected === "guest-constructor") {
      signal("guest-constructor-failed");
      throw new Error("fixture guest constructor failed");
    }
    const actual =
      guest && selected === "guest-bootstrap"
        ? new URL("./threads-runtime-fault-bootstrap.ts", import.meta.url)
        : url;
    super(actual, options);
    workers.push(this);
    if (String(url).includes("threads-runtime-fault-service")) instrumentService(this);
    if (guest) instrumentGuest(this);
  }
};
const errors: string[] = [];
const runtime = createRuntime({
  sharedMemory: declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(3 * 1024 ** 3),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
  }),
  filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  processHost: (options) =>
    new BrowserProcessBroker({
      ...options,
      filesystem: filesystemObserver(options.filesystem),
      onError: (error) => errors.push(String(error)),
    }),
});
async function cleanupWorkers(): Promise<void> {
  try {
    if (canonical && connection && Atomics.load(new Int32Array(connection.sections), 0)) {
      canonical.postMessage({ kind: "fixture-release" });
      await bounded(observed("fixture-released"), "teardown section release");
      assert.equal(Atomics.load(new Int32Array(connection.sections), 0), 0);
    }
  } finally {
    descriptors.dispose();
    const stopped = await Promise.allSettled(
      workers.map((worker) => Reflect.apply(NativeWorker.prototype.terminate, worker, [])),
    );
    globalThis.Worker = NativeWorker;
    for (const result of stopped) assert.equal(result.status, "fulfilled");
  }
}
function assertRetained() {
  const snapshot = runtime.sharedMemory.snapshot();
  assert.equal(snapshot.sharedGuests.length, 1);
  const backing = snapshot.sharedGuests[0]!;
  assert.equal(backing.phase, "debt");
  assert.equal(backing.chargedBytes, 33554432);
  assert.ok(snapshot.debtBytes >= backing.chargedBytes);
  assert.throws(() => createRuntime(), /live page runtime/);
  return snapshot;
}
try {
  runtime.registerAdapter("fault", (context, service) =>
    service.launchWorker(context, {
      workerUrl: new URL("../browser/preview1-worker.ts", import.meta.url).href,
      threaded: {
        serviceWorkerUrl: new URL("./threads-runtime-fault-service.ts", import.meta.url).href,
        guestWorkerUrl: new URL("../thread/guest-bootstrap.ts", import.meta.url).href,
      },
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
      cleanup: () => {
        cleanupCalls++;
      },
    }),
  );
  runtime.registerProgram("/fault", {
    adapter: "fault",
    source: guestModule({
      imports: [{ module: "wasi", name: "thread-spawn", params: [0x7f] }],
      initial: wait32(0),
    }),
  });
  await runtime.filesystem.writeFile("/fault", "registered");
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const root = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
    capacity: 8,
  });
  root.data = { filesystem: runtime.filesystem.createIdentity() };
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: createWorkerPipeCodec(),
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
  });
  await service.adoptRuntimeRoot(root, { memory: [], stop: () => descriptors.dispose() });
  const pid = client.spawn(root.pid, {
    executable: "/fault",
    argv: ["fault"],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
  });
  while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
  await supervisor.start(pid);
  await bounded(observed("fixture-held"), "canonical service section");
  assert.ok(connection);
  assert.equal(Atomics.load(new Int32Array(connection.sections), 0), 1);
  if (selected === "guest-stop" || selected === "drain-failure") {
    await bounded(observed("wait-registered"), "real guest wait");
    await service.kill(pid, 9);
    await bounded(observed("fixture-drain-started"), "ordered service drain");
  }
  if (selected === "guest-constructor")
    await bounded(observed("guest-constructor-failed"), "guest construction failure");
  if (selected === "guest-bootstrap")
    await bounded(observed("guest-load-error"), "guest load failure");
  if (selected === "guest-post") await bounded(observed("host-idle"), "delivered guest shutdown");
  if (selected === "control-exhaustion" || selected === "drain-failure")
    await bounded(observed("fixture-failure"), "real service fault");
  assert.ok(serviceMemory);
  const heap = serviceMemory.buffer;
  const controls = runtime.sharedMemory
    .snapshot()
    .holders.filter((holder) => holder.label === "guest-control");
  const disposing = outcome(runtime.dispose());
  if (selected === "guest-constructor" || selected === "guest-stop") {
    await bounded(observed("fixture-drain-started"), "ordered service drain");
    assert.equal(fencePassed, 0);
    assert.equal(serviceStops, 0);
    canonical!.postMessage({ kind: "fixture-probe" });
    await bounded(observed("fixture-probed"), "live service behind fence");
    assert.equal(fencePassed, 0);
    canonical!.postMessage({ kind: "fixture-release" });
    await bounded(observed("fixture-released"), "section release");
  }
  const disposal = await disposing;
  const first = runtime.sharedMemory.snapshot();
  const consumed = grants.map(consumedControlBytes);
  const stopCounts = { guestStops, serviceStops, cleanupCalls };
  const repeated = await outcome(runtime.dispose());
  assert.deepEqual(repeated, disposal);
  assert.deepEqual({ guestStops, serviceStops, cleanupCalls }, stopCounts);
  assert.deepEqual(grants.map(consumedControlBytes), consumed);
  assert.deepEqual(runtime.sharedMemory.snapshot(), first);
  if (selected === "guest-constructor") {
    assert.equal(disposal.kind, "value");
    assert.equal(cleanupCalls, 1);
    assert.equal(guestConstructors, 1);
    assert.equal(guestStops, 0);
    assert.equal(serviceStops, 1);
    assert.equal(first.sharedGuests[0]!.phase, "awaiting-collection");
    assert.deepEqual(first.sharedGuests[0]!.aliases, { reserved: 0, transferred: 0, retained: 0 });
  } else {
    assert.equal(disposal.kind, "error");
    const debt = assertRetained();
    assert.equal(debt.sharedGuests[0]!.id, first.sharedGuests[0]!.id);
    assert.equal(cleanupCalls, 0);
    const retainedControls = debt.holders.filter((holder) => holder.label === "guest-control");
    assert.ok(retainedControls.length > 0, "failed cleanup must keep charged control ownership");
    assert.ok(retainedControls.every((holder) => holder.state !== "awaiting-collection"));
    if (selected !== "guest-stop") assert.deepEqual(retainedControls, controls);
    if (selected === "guest-stop") {
      assert.equal(debt.sharedGuests[0]!.fence, "passed");
      assert.equal(guestStops, 1);
      assert.equal(serviceStops, 1);
      assert.equal(retainedControls.length, 1);
      assert.equal(retainedControls[0]!.state, "debt");
      assert.equal(retainedControls[0]!.declaredBytes, 64 * 1024 * 1024);
      assert.equal(debt.sharedGuests[0]!.aliases.retained, 1);
    } else {
      assert.equal(fencePassed, 0);
      assert.equal(serviceStops, 0);
      assert.equal(Atomics.load(new Int32Array(connection.sections), 0), 1);
    }
  }
  if (selected === "guest-post") assert.equal(uncertainDeliveries, 1);
  if (selected === "control-exhaustion") {
    assert.equal(guestConstructors, 0);
    assert.equal(consumed[0], 64 * 1024 * 1024);
    assert.equal(events.includes("fixture-grant-full"), true);
    assert.match(failure, /shared control byte grant exhausted/);
  }
  if (selected === "drain-failure") {
    assert.match(failure, /invalid control message/);
    assert.equal(events.includes("fixture-drain-completed"), false);
    assert.equal(fenceStarted, 0);
  }
  assert.equal(serviceMemory.buffer, heap);
  assert.equal(heap.byteLength, 2 * 65536);
  if (guestMemory) assert.equal(guestMemory.buffer, heap);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    unhandled,
    [],
    "fault teardown must handle every rejected guest lifecycle promise",
  );
  console.log(`fault case passed: ${selected}`);
  console.log(
    JSON.stringify({
      selected,
      guestConstructors,
      guestStops,
      serviceStops,
      cleanupCalls,
      fenceStarted,
      fencePassed,
      consumed,
      events,
      errors,
      holders: first.holders.filter((holder) => holder.label === "guest-control"),
      backings: first.sharedGuests,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      selected,
      guestConstructors,
      guestStops,
      serviceStops,
      cleanupCalls,
      fenceStarted,
      fencePassed,
      failure,
      events,
      errors,
      unhandled,
    }),
  );
  throw error;
} finally {
  await cleanupWorkers();
}
