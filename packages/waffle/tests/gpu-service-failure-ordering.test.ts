import { expect, test } from "bun:test";
import { createDisplayOwner } from "../browser/display/owner.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
import { createGraphicsGuest } from "../browser/gpu/guest.js";
import { GPU_TERMINAL } from "../browser/gpu/protocol.js";
import { RecordRing } from "../browser/gpu/ring.js";
import { createSharedControlAllocator, installSharedControlAllocator } from "../memory/control.js";
import { enrollGraphics } from "./fixtures/gpu/service-access.js";

const task = () => new Promise<void>((resolve) => setImmediate(resolve));

test("service failure settles every exposed open before a guest observes revocation", async () => {
  const raf = globalThis.requestAnimationFrame,
    cancel = globalThis.cancelAnimationFrame,
    store = Atomics.store;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const restoreAllocator = installSharedControlAllocator(
    createSharedControlAllocator(
      { kind: "bounded", state: new SharedArrayBuffer(8), limit: 6_000_000 },
      () => {},
    ),
  );
  const worker = {
    onerror: undefined as (() => void) | undefined,
    onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    onmessageerror: undefined,
    postMessage() {},
    terminate() {},
  };
  const owner = createDisplayOwner(() => {}, {
    commandBytes: 4096,
    completionBytes: 4096,
    worker: () => worker as unknown as Worker,
  });
  const grant = owner.display.grant({ gpu: true, surfaces: [] });
  enrollGraphics(grant);
  const opened: GraphicsOpen[] = [];
  const port = grant.connection.port;
  const post = port.postMessage.bind(port);
  port.postMessage = (message: GraphicsOpen | { type: "close"; id: number }) => {
    if (message.type !== "open") return post(message);
    opened.push(message);
    post(message);
    store(new Int32Array(message.control), 0, 1);
  };
  const memory = new WebAssembly.Memory({ initial: 1 });
  const guest = createGraphicsGuest(
    grant.connection,
    () => memory,
    () => {},
  );
  const gpu = guest.imports.runtime_gpu!;
  let interleaves = 0;
  try {
    const open = gpu.open,
      completions = gpu.completions;
    if (typeof open !== "function" || typeof completions !== "function")
      throw new Error("Missing graphics imports");
    expect(open(0, 0)).toBe(0);
    expect(open(0, 4)).toBe(0);
    await task();
    expect(worker.onerror).toBeFunction();
    expect(opened).toHaveLength(2);
    expect(opened.map((open) => new RecordRing(open.commands, 8).terminal())).toEqual([
      undefined,
      undefined,
    ]);
    Atomics.store = new Proxy(store, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        const [cells, index, value] = args;
        if (!(cells instanceof Int32Array) || cells.buffer !== grant.connection.revocation)
          return result;
        if (index !== 0 || value !== 1) return result;
        interleaves++;
        // Run the real guest immediately after the page's real revocation store.
        expect(completions(1, 64, 64, 0n, 4)).toBe(-64);
        expect(completions(2, 64, 64, 0n, 4)).toBe(-64);
        return result;
      },
    });
    worker.onerror!();
    Atomics.store = store;
    await grant.retired();
    await task();
    expect(interleaves).toBeGreaterThan(0);
    for (const open of opened) {
      expect(Atomics.load(new Int32Array(open.control), 0)).toBe(-64);
      expect(Atomics.load(new Int32Array(open.control), 1)).toBe(GPU_TERMINAL.service);
      expect(Atomics.load(new Int32Array(open.arena), 0)).toBe(GPU_TERMINAL.service);
      expect(new RecordRing(open.commands, 8).terminal()?.reason).toBe(GPU_TERMINAL.service);
      expect(new RecordRing(open.replies, 16).terminal()?.reason).toBe(GPU_TERMINAL.service);
    }
  } finally {
    Atomics.store = store;
    guest.dispose();
    worker.onerror?.();
    await owner.dispose();
    port.close();
    restoreAllocator();
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = cancel;
  }
});
