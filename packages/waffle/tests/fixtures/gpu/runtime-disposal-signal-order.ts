import assert from "node:assert/strict";
import { createRuntime } from "../../../runtime.js";
import { BrowserProcessBroker } from "../../../browser/process-broker.js";
import { FilesystemSection } from "../../../fs/protocol.js";
import { attachServiceAccess } from "../../../browser/display/service-readers.js";
import type {
  GpuServiceReply,
  GpuServiceRequest,
  ServiceBootstrap,
} from "../../../browser/display/service-protocol.js";
import { CompletionOwner } from "../../../browser/gpu/completions.js";
import { RecordRing } from "../../../browser/gpu/ring.js";

const mode = process.argv[2];
assert.ok(mode === "consumer" || mode === "display");
const NativeWorker = globalThis.Worker;
const previousFrame = globalThis.requestAnimationFrame;
const previousCancel = globalThis.cancelAnimationFrame;
const signal = new Int32Array(new SharedArrayBuffer(4));
const progress = new Int32Array(new SharedArrayBuffer(64));
let readers: SharedArrayBuffer | undefined;
let completion: CompletionOwner | undefined;
let displaySignal = -1;
let serviceStops = 0;
let physicalStops = 0;
let workerJoined = false;
let broker!: BrowserProcessBroker;
let opened!: () => void;
let serviceReply: ((event: MessageEvent<GpuServiceReply>) => void) | undefined;
const opening = new Promise<void>((resolve) => {
  opened = resolve;
});
const serviceWorker = {
  set onmessage(value: (event: MessageEvent<GpuServiceReply>) => void) {
    serviceReply = value;
  },
  postMessage(message: GpuServiceRequest | ServiceBootstrap) {
    if (message.type === "bootstrap") readers = message.readers;
    if (message.type === "open") {
      assert.ok(readers);
      completion = new CompletionOwner({
        access: attachServiceAccess(readers),
        commands: new RecordRing(message.open.commands, 8),
        replies: new RecordRing(message.open.replies, 16),
        arena: new Uint8Array(message.open.arena),
      });
      Atomics.store(new Int32Array(message.open.control), 0, 1);
      Atomics.notify(new Int32Array(message.open.control), 0);
      opened();
    }
    if (message.type !== "revoke") return;
    displaySignal = Atomics.load(signal, 0);
    completion?.finishRetirement(4);
    serviceReply?.(
      new MessageEvent("message", {
        data: { type: "retired", grant: message.grant },
      }),
    );
  },
  terminate() {
    serviceStops++;
  },
};
function waitForProgress(index: number) {
  assert.notEqual(Atomics.wait(progress, index, 0, 3000), "timed-out", `progress ${index}`);
}
async function waitForGuest() {
  while (Atomics.load(progress, 0) === 0) {
    const waiting = Atomics.waitAsync(progress, 0, 0, 3000);
    if (waiting.async) assert.notEqual(await waiting.value, "timed-out");
  }
}
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.Worker = new Proxy(NativeWorker, {
  construct(target, args) {
    if (String(args[0]).includes("gpu/service-worker")) return serviceWorker;
    return Reflect.construct(target, args);
  },
});
const runtime = createRuntime({
  filesystem: {
    mode: "memory",
    workerURL: new URL("../../../browser/fs-worker.ts", import.meta.url),
  },
  processHost(options) {
    broker = new BrowserProcessBroker(options);
    return broker;
  },
});
let worker: Worker | undefined;
let section: FilesystemSection | undefined;
let entered = false;
let consumerSignal = -1;
let controllerSignal = -1;
let root: number | undefined;
try {
  await runtime.filesystem.mkdirp("/proof");
  await runtime.processes();
  root = await broker.adoptRoot(
    { memory: [], requestedSignal: signal },
    {
      revoke() {
        controllerSignal = Atomics.load(signal, 0);
        Atomics.store(progress, 11, 1);
        Atomics.notify(progress, 11);
      },
      async stop() {
        physicalStops++;
        await worker?.terminate();
        worker = undefined;
        workerJoined = true;
        broker.rootStopped(root!);
      },
    },
  );
  const display = await runtime.display();
  const graphics = display.grant({ gpu: true, surfaces: [] });
  worker = new NativeWorker(new URL("./runtime-disposal-signal-worker.ts", import.meta.url));
  let rejectWorker!: (reason: Error) => void;
  const workerFailure = new Promise<never>((_, reject) => {
    rejectWorker = reject;
    worker!.onerror = (event) => reject(new Error(event.message));
  });
  const finished = new Promise<void>((resolve) => {
    worker!.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (typeof data === "object" && data !== null && "failure" in data)
        rejectWorker(new Error(String(data.failure)));
      if (data === "finished") resolve();
    };
  });
  broker.retainRootGraphics(root, graphics, worker);
  worker.postMessage(
    { graphics: graphics.connection, grant: broker.rootControlGrant(root), signal, progress },
    [graphics.connection.port],
  );
  await Promise.race([opening, workerFailure]);
  await Promise.race([waitForGuest(), workerFailure]);
  const identity = runtime.filesystem.createIdentity();
  section = new FilesystemSection(identity);
  runtime.retainConsumer({
    filesystem: identity,
    revoke() {
      consumerSignal = Atomics.load(signal, 0);
      if (mode !== "consumer") return;
      completion!.finishRetirement(4);
      // The old order returns closed bytes and reaches the next import before signal publication.
      waitForProgress(consumerSignal === 0 ? 3 : 1);
    },
    stop() {},
  });
  section.enter();
  entered = true;
  const disposal = runtime.dispose();
  assert.equal(runtime.dispose(), disposal);
  await Promise.race([finished, workerFailure]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const physicalStopsBeforeFence = physicalStops;
  assert.equal(serviceStops, 0);
  assert.equal(workerJoined, false);
  assert.throws(() => createRuntime(), /already owns/);
  section.exit();
  entered = false;
  await disposal;
  console.log(
    JSON.stringify({
      consumerSignal,
      displaySignal,
      controllerSignal,
      physicalStopsBeforeFence,
      physicalStopsAfterFence: physicalStops,
      serviceStops,
      workerJoined,
      returns: Atomics.load(progress, 2),
      nextImport: Atomics.load(progress, 3),
      authenticatedSignal: Atomics.load(progress, 4),
      closedBytes: Atomics.load(progress, 5),
    }),
  );
  const successor = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../../browser/fs-worker.ts", import.meta.url),
    },
  });
  await successor.dispose();
} finally {
  if (entered) section?.exit();
  await worker?.terminate();
  if (root !== undefined) broker.rootStopped(root);
  await runtime.dispose();
  globalThis.Worker = NativeWorker;
  globalThis.requestAnimationFrame = previousFrame;
  globalThis.cancelAnimationFrame = previousCancel;
}
