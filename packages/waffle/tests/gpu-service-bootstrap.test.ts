import { afterEach, expect, test } from "bun:test";
import { createServiceReaders } from "../browser/display/service-readers.js";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function cpuWorker() {
  const workers: Worker[] = [];
  cleanups.push(async () => {
    for (const worker of workers) await worker.terminate();
  });
  const worker = new Worker(new URL("./fixtures/gpu/service-bootstrap-worker.ts", import.meta.url));
  workers.push(worker);
  return worker;
}
for (const duplicate of [false, true])
  test(`production service bootstrap rejects ${duplicate ? "duplicate bootstrap" : "pre-bootstrap request"}`, async () => {
    const worker = cpuWorker();
    const failed = new Promise<string>((resolve) => {
      worker.onerror = (event) => {
        event.preventDefault();
        resolve(event.message);
      };
    });
    if (duplicate) {
      const fence = createServiceReaders();
      worker.postMessage({ type: "bootstrap", readers: fence.bootstrap, incarnation: 1 });
      worker.postMessage({ type: "bootstrap", readers: fence.bootstrap, incarnation: 1 });
      cleanups.push(() => fence.close().join());
    } else worker.postMessage({ type: "tick" });
    expect(await failed).toContain(
      duplicate ? "Duplicate GPU service bootstrap" : "request before bootstrap",
    );
  });
test("late bootstrap attaches to the closed allocation without reopening or settling old controls", async () => {
  const worker = cpuWorker(),
    fence = createServiceReaders();
  const proof = await fence.close().join();
  const open = {
    type: "open",
    id: 1,
    control: new SharedArrayBuffer(64),
    commands: new SharedArrayBuffer(128),
    replies: new SharedArrayBuffer(128),
    arena: new SharedArrayBuffer(gpuPayloadLayout.byteLength),
  };
  const processed = new Promise<void>((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.processed === "open") resolve();
    };
    worker.onerror = reject;
  });
  worker.postMessage({ type: "bootstrap", readers: fence.bootstrap, incarnation: 1 });
  worker.postMessage({ type: "open", grant: 1, open, surfaces: [] });
  await processed;
  expect(fence.close().accepts(proof)).toBe(true);
  expect(Atomics.load(new Int32Array(fence.bootstrap), 0)).toBe(-1);
  expect(Atomics.load(new Int32Array(open.control), 0)).toBe(0);
  expect(Atomics.load(new Int32Array(open.commands), 2)).toBe(0);
});
