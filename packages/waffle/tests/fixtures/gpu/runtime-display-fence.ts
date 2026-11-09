import { bytes, declareSharedMemoryPlatform } from "../../../memory/reservations.js";
import { createSharedControlAllocator } from "../../../memory/control.js";
import assert from "node:assert/strict";
import { createRuntime } from "../../../runtime.js";
import { BrowserProcessBroker } from "../../../browser/process-broker.js";
import { gpuPayloadLayout } from "../../../browser/display/generated/graphics-layout.js";
import type { GraphicsOpen } from "../../../browser/display/protocol.js";

const mode = process.argv[2];
if (!mode) throw new Error("Missing display control mode");
const NativeWorker = globalThis.Worker;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
let gate: SharedArrayBuffer | undefined;
let failure: (() => void) | undefined;
let stops = 0;
let opens = 0;
const serviceWorker = {
  onmessage: null,
  set onerror(value: () => void) {
    failure = value;
  },
  postMessage(message: { type: string; readers?: SharedArrayBuffer; open?: GraphicsOpen }) {
    if (message.type === "bootstrap") {
      gate = message.readers;
      if (mode.startsWith("failed-wait"))
        Reflect.set(globalThis, Symbol.for("waffle.test.displayGate"), gate);
    }
    if (message.type === "open") {
      opens++;
      Atomics.store(new Int32Array(message.open!.control), 0, 1);
    }
  },
  terminate() {
    stops++;
    if (mode === "throw") throw new Error("captured stop failed");
  },
};
globalThis.Worker = new Proxy(NativeWorker, {
  construct(target, args) {
    if (String(args[0]).includes("gpu/service-worker")) return serviceWorker;
    return Reflect.construct(target, args);
  },
});
let broker!: BrowserProcessBroker;
const sharedMemory =
  mode === "late-bounded"
    ? declareSharedMemoryPlatform({
        kind: "bounded",
        budgetBytes: bytes(6 * 1024 ** 3),
        counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
      })
    : undefined;
const runtime = createRuntime({
  sharedMemory,
  filesystem: {
    mode: "memory",
    workerURL: new URL("../../../browser/fs-worker.ts", import.meta.url),
  },
  processHost(options) {
    broker = new BrowserProcessBroker(options);
    return broker;
  },
});
if (mode === "pending") {
  const activation = runtime.display();
  const disposal = runtime.dispose();
  await assert.rejects(activation, /disposed/);
  await disposal;
  assert.equal(gate, undefined);
  const successor = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../../browser/fs-worker.ts", import.meta.url),
    },
  });
  await successor.dispose();
  console.log(`display ${mode} retains the actual Runtime guard and filesystem`);
  process.exit(0);
}
await runtime.filesystem.mkdirp("/proof");
const display = await runtime.display();
const grant = display.grant({ gpu: true, surfaces: [] });
await runtime.processes();
const root = await broker.adoptRoot({ memory: [] });
const receipts = new EventTarget();
broker.retainRootGraphics(root, grant, receipts as unknown as Worker);
const allocations: SharedArrayBuffer[] = [];
const allocate = createSharedControlAllocator(broker.rootControlGrant(root), (backing) =>
  allocations.push(structuredClone(backing)),
);
const valid: GraphicsOpen = structuredClone({
  type: "open",
  id: 1,
  control: allocate(64),
  commands: allocate(64 + 4 * 1024 ** 2),
  replies: allocate(64 + 256 * 1024),
  arena: allocate(gpuPayloadLayout.byteLength),
});
grant.connection.port.postMessage(valid);
while (!gate || !opens) await new Promise<void>((resolve) => setImmediate(resolve));
let reader: Worker | undefined;
let rendezvousCells: Int32Array | undefined;
if (mode === "abandoned" || mode.startsWith("failed-wait")) {
  const rendezvous = new SharedArrayBuffer(8),
    cells = new Int32Array(rendezvous);
  rendezvousCells = cells;
  reader = new NativeWorker(new URL("./service-reader-worker.ts", import.meta.url));
  reader.postMessage({ fence: gate, commands: valid.commands, rendezvous });
  while (Atomics.load(cells, 0) === 0) {
    const wait = Atomics.waitAsync(cells, 0, 0);
    if (wait.async) await wait.value;
  }
  if (mode === "abandoned") {
    await reader.terminate();
    reader = undefined;
  }
}
let retired = false;
void grant.retired().then(() => {
  retired = true;
});
if (mode !== "failed-wait-after-suspend") failure!();
if (mode.startsWith("late-")) broker.rootStopped(root);
const disposal = runtime.dispose();
if (mode === "failed-wait-after-suspend") failure!();
assert.equal(runtime.dispose(), disposal);
assert.ok(Atomics.load(new Int32Array(gate), 0) < 0);
let disposed = false,
  error: unknown;
void disposal.then(
  () => {
    disposed = true;
  },
  (cause: unknown) => {
    error = cause;
  },
);
if (mode.startsWith("failed-wait")) {
  await disposal.catch(() => {});
  assert.match(String(error), /captured reader wait failed/);
  assert.equal(retired, false);
  assert.equal(stops, 0);
  const completed = new Promise<void>((resolve) => {
    reader!.onmessage = () => resolve();
  });
  Atomics.store(rendezvousCells!, 1, 1);
  Atomics.notify(rendezvousCells!, 1);
  await completed;
  await reader!.terminate();
  reader = undefined;
  assert.equal(Atomics.load(new Int32Array(gate), 0), -1);
} else if (mode === "abandoned") {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(retired, false);
  assert.equal(disposed, false);
  assert.equal(stops, 0);
  assert.equal(Atomics.load(new Int32Array(gate), 0), -2);
} else if (!mode.startsWith("late-")) {
  await disposal.catch(() => {});
  assert.equal(retired, true);
  assert.equal(stops, 1);
  assert.match(String(error), /captured stop failed/);
}
if (mode.startsWith("late-")) {
  await disposal;
  assert.equal(retired, true);
  const successor = createRuntime({
    sharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../../browser/fs-worker.ts", import.meta.url),
    },
  });
  for (const buffer of allocations)
    receipts.dispatchEvent(
      new MessageEvent("message", { data: { type: "shared-control-allocation", buffer } }),
    );
  const debt = successor.sharedMemory
    .snapshot()
    .holders.filter((holder) => holder.label === "guest-control" && holder.state === "debt")
    .reduce((sum, holder) => sum + holder.declaredBytes, 0);
  assert.equal(
    debt,
    allocations.reduce((sum, backing) => sum + backing.byteLength, 0),
  );
  await successor.dispose();
} else assert.throws(() => createRuntime(), /already owns/);
grant.connection.port.close();
globalThis.Worker = NativeWorker;
console.log(`display ${mode} retains the actual Runtime guard and filesystem`);
process.exit(0);
