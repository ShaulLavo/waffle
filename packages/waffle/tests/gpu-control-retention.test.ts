import { expect, test } from "bun:test";
import { SharedMemoryLedger, bytes, declareSharedMemoryPlatform } from "../memory/reservations.js";
import { defaultSharedMemoryPlatform } from "../memory/platform.js";
import { createSharedControlAllocator } from "../memory/control.js";

for (const bounded of [false, true]) for (const late of [false, true]) {
  test(`original receipt A survives clone B, finalizer and disposal (${bounded}, ${late})`, () => {
    const platform = bounded ? declareSharedMemoryPlatform({
      kind: "bounded", budgetBytes: bytes(256 * 1024 * 1024),
      counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
    }) : defaultSharedMemoryPlatform;
    let collect!: (id: number) => void;
    const receipts: { target: object; id: number }[] = [];
    const ledger = new SharedMemoryLedger(platform, undefined, (receive) => {
      collect = receive;
      return { register(target, id) { receipts.push({ target, id }); } };
    });
    const reservations = ledger.openRuntime(platform);
    const ticket = reservations.admit({ pid: 1, executable: "graphics", guest: { kind: "declared", memories: [] }, group: "none", connection: false, controls: true });
    ticket.retainControlsForGraphics();
    ticket.retainControlsForGraphics();
    const launched = ticket.launched();
    let receiptA!: SharedArrayBuffer;
    const allocate = createSharedControlAllocator(ticket.control, (buffer) => { receiptA = structuredClone(buffer); });
    const original = allocate(64);
    const openB = structuredClone(original);
    expect(openB).not.toBe(receiptA);
    if (!late) launched.controlAllocated(receiptA);
    launched.stopped();
    reservations.dispose();
    if (late) launched.controlAllocated(receiptA);
    const a = receipts.find((receipt) => receipt.target === receiptA);
    if (!bounded) { expect(a).toBeDefined(); collect(a!.id); }
    const second = ledger.openRuntime(platform);
    expect(second.snapshot().debtBytes).toBe(64);
    launched.stopped();
    launched.failed([new Error("late failure")]);
    expect(second.snapshot().debtBytes).toBe(64);
    expect(openB.byteLength).toBe(64);
    second.dispose();
  });
}
