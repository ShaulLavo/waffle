import { afterEach, expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ProcessTable } from "../proc/table.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { SharedMemoryLedger, bytes, declareSharedMemoryPlatform } from "../memory/reservations.js";
import { defaultSharedMemoryPlatform } from "../memory/platform.js";
import { createSharedControlAllocator } from "../memory/control.js";
import { createDisplayOwner } from "../browser/display/owner.js";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
class ReceiptWorker extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  receipt(buffer: SharedArrayBuffer) {
    const event = new MessageEvent("message", {
      data: { type: "shared-control-allocation", buffer },
    });
    this.dispatchEvent(event);
    this.onmessage?.(event);
  }
}
for (const bounded of [false, true])
  for (const late of [false, true])
    test(`root's captured receipt sink survives maps, handlers and Runtime ledger teardown (${bounded}, ${late})`, async () => {
      const platform = bounded
        ? declareSharedMemoryPlatform({
            kind: "bounded",
            budgetBytes: bytes(512 * 1024 ** 2),
            counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
          })
        : defaultSharedMemoryPlatform;
      let finalize!: (id: number) => void;
      const registrations: { target: object; id: number }[] = [];
      const ledger = new SharedMemoryLedger(platform, undefined, (receive) => {
        finalize = receive;
        return {
          register(target, id) {
            registrations.push({ target, id });
          },
        };
      });
      const reservations = ledger.openRuntime(platform);
      const identities = new ProcessIdentityAllocator();
      const broker = new BrowserProcessBroker({
        reservations,
        identities,
        table: new ProcessTable(identities),
        registry: new ExecutableRegistry(),
        filesystem: {
          connect() {
            throw new Error("unused");
          },
          revoke() {},
          reap() {},
          async quiesce() {},
        },
        launch() {
          throw new Error("unused");
        },
        onError(error) {
          throw error;
        },
      });
      cleanup.push(() => broker.dispose());
      const root = await broker.adoptRoot({ memory: [] });
      let sent = 0,
        failed: (() => void) | undefined;
      const worker = {
        postMessage(message: { type: string }) {
          if (message.type === "open") sent++;
        },
        terminate() {},
        set onerror(value: () => void) {
          failed = value;
        },
      } as unknown as Worker;
      const raf = globalThis.requestAnimationFrame,
        cancel = globalThis.cancelAnimationFrame;
      cleanup.push(() => {
        globalThis.requestAnimationFrame = raf;
        globalThis.cancelAnimationFrame = cancel;
      });
      globalThis.requestAnimationFrame = () => 1;
      globalThis.cancelAnimationFrame = () => {};
      const owner = createDisplayOwner(() => {}, {
        worker: () => worker,
        commandBytes: 4096,
        completionBytes: 4096,
      });
      cleanup.push(() => owner.dispose());
      const grant = owner.display.grant({ gpu: true, surfaces: [] });
      cleanup.push(() => grant.connection.port.close());
      const rootWorker = new ReceiptWorker();
      broker.retainRootGraphics(root, grant, rootWorker as unknown as Worker);
      broker.retainRootGraphics(root, grant, rootWorker as unknown as Worker);
      const receipts: SharedArrayBuffer[] = [];
      const allocate = createSharedControlAllocator(broker.rootControlGrant(root), (backing) =>
        receipts.push(structuredClone(backing)),
      );
      const original: GraphicsOpen = {
        type: "open",
        id: 1,
        control: allocate(64),
        commands: allocate(4160),
        replies: allocate(4160),
        arena: allocate(gpuPayloadLayout.byteLength),
      };
      const openB = structuredClone(original);
      expect(openB.arena).not.toBe(receipts[3]);
      if (!late) for (const receipt of receipts) rootWorker.receipt(receipt);
      grant.connection.port.postMessage(openB);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sent).toBe(1);
      failed!();
      await grant.retired();
      await owner.dispose();
      broker.rootStopped(root);
      rootWorker.onmessage = null;
      reservations.dispose();
      const successor = ledger.openRuntime(platform);
      if (late) for (const receipt of receipts) rootWorker.receipt(receipt);
      for (const receipt of receipts) {
        const registration = registrations.find((entry) => entry.target === receipt);
        if (registration) finalize(registration.id);
      }
      expect(successor.snapshot().debtBytes).toBe(64 + 4160 + 4160 + gpuPayloadLayout.byteLength);
      expect(new Uint8Array(openB.arena).byteLength).toBe(gpuPayloadLayout.byteLength);
      successor.dispose();
    });
