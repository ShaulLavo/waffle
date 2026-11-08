import { afterEach, expect, test } from "bun:test";
import { createDisplayOwner } from "../browser/display/owner.js";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import { enrollGraphics } from "./fixtures/gpu/service-access.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function open(): GraphicsOpen {
  return {
    type: "open",
    id: 1,
    control: new SharedArrayBuffer(64),
    commands: new SharedArrayBuffer(128),
    replies: new SharedArrayBuffer(128),
    arena: new SharedArrayBuffer(gpuPayloadLayout.byteLength),
  };
}
function worker() {
  const state = { gate: undefined as SharedArrayBuffer | undefined, opens: 0, stops: 0 };
  const value = {
    onerror: null as (() => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onmessageerror: null,
    postMessage(message: {
      type: string;
      readers?: SharedArrayBuffer;
      open?: GraphicsOpen;
      grant?: number;
    }) {
      if (message.type === "bootstrap") {
        expect(state.gate).toBeUndefined();
        state.gate = message.readers;
      }
      if (message.type === "revoke")
        setImmediate(() =>
          value.onmessage?.(
            new MessageEvent("message", { data: { type: "retired", grant: message.grant } }),
          ),
        );
      if (message.type === "open") {
        expect(state.gate).toBeDefined();
        state.opens++;
        Atomics.store(new Int32Array(message.open!.control), 0, 1);
      }
    },
    terminate() {
      state.stops++;
    },
  };
  return { state, value };
}
function animation() {
  const raf = globalThis.requestAnimationFrame,
    cancel = globalThis.cancelAnimationFrame;
  cleanups.push(() => {
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = cancel;
  });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
}
const task = () => new Promise<void>((resolve) => setImmediate(resolve));
test("page failure joins the actual old section before replacement, and stale callbacks cannot retire its successor", async () => {
  animation();
  const workers: ReturnType<typeof worker>[] = [];
  const owner = createDisplayOwner(() => {}, {
    commandBytes: 64,
    completionBytes: 64,
    worker: () => {
      const next = worker();
      workers.push(next);
      return next.value as unknown as Worker;
    },
  });
  const readers: Worker[] = [];
  const rendezvous = new SharedArrayBuffer(8),
    cells = new Int32Array(rendezvous);
  cleanups.push(async () => {
    Atomics.store(cells, 1, 1);
    Atomics.notify(cells, 1);
    await owner.dispose();
    for (const reader of readers) await reader.terminate();
  });
  const grant = owner.display.grant({ gpu: true, surfaces: [] });
  enrollGraphics(grant);
  cleanups.push(() => grant.connection.port.close());
  const original = open();
  grant.connection.port.postMessage(original);
  await task();
  const first = workers[0]!;
  const reader = new Worker(new URL("./fixtures/gpu/service-reader-worker.ts", import.meta.url));
  readers.push(reader);
  reader.postMessage({ fence: first.state.gate, commands: original.commands, rendezvous });
  while (!Atomics.load(cells, 0)) {
    const wait = Atomics.waitAsync(cells, 0, 0);
    if (wait.async) await wait.value;
  }
  let retired = false;
  void grant.retired().then(() => {
    retired = true;
  });
  first.value.onerror!();
  first.value.onmessage!(new MessageEvent("message", { data: { type: "retired", grant: 1 } }));
  await task();
  expect(retired).toBe(false);
  expect(first.state.stops).toBe(0);
  const denied = owner.display.grant({ gpu: true, surfaces: [] });
  enrollGraphics(denied);
  cleanups.push(() => denied.connection.port.close());
  denied.connection.port.postMessage(open());
  await denied.retired();
  expect(workers).toHaveLength(1);
  Atomics.store(cells, 1, 1);
  Atomics.notify(cells, 1);
  await grant.retired();
  await task();
  expect(first.state.stops).toBe(1);
  const next = owner.display.grant({ gpu: true, surfaces: [] });
  enrollGraphics(next);
  cleanups.push(() => next.connection.port.close());
  next.connection.port.postMessage(open());
  await task();
  expect(workers).toHaveLength(2);
  first.value.onerror!();
  first.value.onmessage!(new MessageEvent("message", { data: { type: "retired", grant: 3 } }));
  expect(workers[1]!.state.stops).toBe(0);
  expect(workers[1]!.state.opens).toBe(1);
});
test("an unenrolled graphics launch fails before creating a service", async () => {
  animation();
  let creates = 0;
  const owner = createDisplayOwner(() => {}, {
    commandBytes: 64,
    completionBytes: 64,
    worker: () => {
      creates++;
      return worker().value as unknown as Worker;
    },
  });
  cleanups.push(() => owner.dispose());
  const grant = owner.display.grant({ gpu: true, surfaces: [] });
  cleanups.push(() => grant.connection.port.close());
  const original = open();
  grant.connection.port.postMessage(original);
  await grant.retired();
  expect(creates).toBe(0);
  expect(Atomics.load(new Int32Array(original.control), 0)).toBe(-64);
});

test("reentrant factory teardown owns the pending allocation and the returned Worker", async () => {
  animation();
  const holder: { owner?: ReturnType<typeof createDisplayOwner>; disposal?: Promise<void> } = {};
  const created = worker();
  const owner = createDisplayOwner(() => {}, {
    commandBytes: 64,
    completionBytes: 64,
    worker() {
      if (!holder.owner) throw new Error("owner missing");
      holder.disposal = holder.owner.dispose();
      return created.value as unknown as Worker;
    },
  });
  holder.owner = owner;
  cleanups.push(() => owner.dispose());
  const grant = owner.display.grant({ gpu: true, surfaces: [] });
  enrollGraphics(grant);
  cleanups.push(() => grant.connection.port.close());
  grant.connection.port.postMessage(open());
  await grant.retired();
  await holder.disposal;
  expect(created.state.gate).toBeUndefined();
  expect(created.state.opens).toBe(0);
  expect(created.state.stops).toBe(1);
  expect(() => owner.display.grant({ gpu: true, surfaces: [] })).toThrow("disposed");
});

test("a retired grant stays frozen during whole-service failure and its Worker cannot be reused", async () => {
  animation();
  const originalWorker = worker();
  const owner = createDisplayOwner(() => {}, {
    commandBytes: 64,
    completionBytes: 64,
    worker: () => originalWorker.value as unknown as Worker,
  });
  cleanups.push(() => owner.dispose());
  const grant = owner.display.grant({ gpu: true, surfaces: [] });
  enrollGraphics(grant);
  cleanups.push(() => grant.connection.port.close());
  const original = open();
  grant.connection.port.postMessage(original);
  await task();
  grant.dispose();
  originalWorker.value.onmessage!(
    new MessageEvent("message", { data: { type: "retired", grant: 1 } }),
  );
  await grant.retired();
  const buffers = [original.control, original.commands, original.replies, original.arena];
  const frozen = buffers.map((backing) => Array.from(new Uint8Array(backing)));
  originalWorker.value.onerror!();
  await task();
  expect(buffers.map((backing) => Array.from(new Uint8Array(backing)))).toEqual(frozen);
  expect(originalWorker.state.stops).toBe(1);
  const next = owner.display.grant({ gpu: true, surfaces: [] });
  enrollGraphics(next);
  cleanups.push(() => next.connection.port.close());
  next.connection.port.postMessage(open());
  await next.retired();
  await task();
  expect(originalWorker.state.opens).toBe(1);
  expect(originalWorker.state.stops).toBe(1);
});
