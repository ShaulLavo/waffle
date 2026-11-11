import { expect, test } from "bun:test";
import { SharedMemoryLedger, bytes, declareSharedMemoryPlatform } from "../memory/reservations.js";
import { defaultSharedMemoryPlatform } from "../memory/platform.js";
import { createSharedControlAllocator } from "../memory/control.js";

for (const bounded of [false, true])
  for (const late of [false, true]) {
    test(`original receipt A survives clone B, finalizer and disposal (${bounded}, ${late})`, () => {
      const platform = bounded
        ? declareSharedMemoryPlatform({
            kind: "bounded",
            budgetBytes: bytes(256 * 1024 * 1024),
            counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
          })
        : defaultSharedMemoryPlatform;
      let collect!: (id: number) => void;
      const receipts: { target: object; id: number }[] = [];
      const ledger = new SharedMemoryLedger(platform, undefined, (receive) => {
        collect = receive;
        return {
          register(target, id) {
            receipts.push({ target, id });
          },
        };
      });
      const reservations = ledger.openRuntime(platform);
      const ticket = reservations.admit({
        pid: 1,
        executable: "graphics",
        guest: { kind: "declared", memories: [] },
        group: "none",
        connection: false,
        controls: true,
      });
      ticket.retainControlsForGraphics();
      ticket.retainControlsForGraphics();
      const launched = ticket.launched();
      let receiptA!: SharedArrayBuffer;
      const allocate = createSharedControlAllocator(ticket.control, (buffer) => {
        receiptA = structuredClone(buffer);
      });
      const original = allocate(64);
      const openB = structuredClone(original);
      expect(openB).not.toBe(receiptA);
      if (!late) launched.controlAllocated(receiptA);
      launched.stopped();
      reservations.dispose();
      if (late) launched.controlAllocated(receiptA);
      const a = receipts.find((receipt) => receipt.target === receiptA);
      if (!bounded) {
        expect(a).toBeDefined();
        collect(a!.id);
      }
      const second = ledger.openRuntime(platform);
      expect(second.snapshot().debtBytes).toBe(64);
      launched.stopped();
      launched.failed([new Error("late failure")]);
      expect(second.snapshot().debtBytes).toBe(64);
      expect(openB.byteLength).toBe(64);
      second.dispose();
    });
  }

for (const bounded of [false, true])
  test(`old graphics ticket keeps its accounting rule after successor platform change (${bounded})`, () => {
    const original = bounded
      ? declareSharedMemoryPlatform({
          kind: "bounded",
          budgetBytes: bytes(256 * 1024 ** 2),
          counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
        })
      : defaultSharedMemoryPlatform;
    const ledger = new SharedMemoryLedger(original),
      runtime = ledger.openRuntime(original);
    const ticket = runtime.admit({
      pid: 1,
      executable: "original graphics",
      guest: { kind: "declared", memories: [] },
      group: "none",
      connection: false,
      controls: true,
    });
    ticket.retainControlsForGraphics();
    const launched = ticket.launched();
    let receipt!: SharedArrayBuffer;
    const allocate = createSharedControlAllocator(ticket.control, (backing) => {
      receipt = structuredClone(backing);
    });
    allocate(64);
    runtime.dispose();
    const successor = ledger.openRuntime(
      declareSharedMemoryPlatform({
        kind: "bounded",
        budgetBytes: bytes(256 * 1024 ** 2),
        counts: { fixedBuffer: false, sharedMemory: true, privateMemory: false },
      }),
    );
    launched.controlAllocated(receipt);
    launched.stopped();
    expect(successor.snapshot().debtBytes).toBe(64);
    successor.dispose();
  });

test("late enrollment cannot retrofit provenance after an allocation receipt", () => {
  const runtime = new SharedMemoryLedger(defaultSharedMemoryPlatform).openRuntime(
    defaultSharedMemoryPlatform,
  );
  const ticket = runtime.admit({
    pid: 1,
    executable: "unenrolled",
    guest: { kind: "declared", memories: [] },
    group: "none",
    connection: false,
    controls: true,
  });
  ticket.launched().controlAllocated(new SharedArrayBuffer(64));
  expect(() => ticket.retainControlsForGraphics()).toThrow("precede allocation receipts");
  ticket.launched().stopped();
  runtime.dispose();
});

function boundedControls() {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(256 * 1024 * 1024),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  return new SharedMemoryLedger(platform).openRuntime(platform);
}
function controlTicket(runtime: ReturnType<typeof boundedControls>, pid: number) {
  return runtime.admit({
    pid,
    executable: "accounting fixture",
    guest: { kind: "declared", memories: [] },
    group: "none",
    connection: false,
    controls: true,
  });
}
function allocateControls(ticket: ReturnType<typeof controlTicket>, length: number) {
  const launched = ticket.launched();
  const allocate = createSharedControlAllocator(ticket.control, (buffer) =>
    launched.controlAllocated(structuredClone(buffer)),
  );
  allocate(length);
  return launched;
}
test("bounded graphics enrollment preserves the live full grant until physical stop", () => {
  const runtime = boundedControls(),
    ticket = controlTicket(runtime, 1);
  const before = runtime.snapshot();
  ticket.retainControlsForGraphics();
  const enrolled = runtime.snapshot();
  expect(enrolled.reservedBytes).toBe(before.reservedBytes);
  expect(enrolled.debtBytes).toBe(0);
  expect(enrolled.holders.filter((holder) => holder.label === "guest-control")).toMatchObject([
    { state: "live", declaredBytes: 64 * 1024 * 1024 },
  ]);
  const launched = allocateControls(ticket, 64);
  runtime.dispose();
  expect(
    runtime.snapshot().holders.filter((holder) => holder.label === "guest-control"),
  ).toMatchObject([{ state: "debt", declaredBytes: 64 * 1024 * 1024 }]);
  launched.stopped();
  expect(runtime.snapshot().debtBytes).toBe(64);
  expect(
    runtime.snapshot().holders.filter((holder) => holder.label === "guest-control"),
  ).toMatchObject([{ state: "debt", declaredBytes: 64 }]);
});
test("real bounded graphics ledger preserves exact active-grant and consumed-debt accounting", () => {
  const runtime = boundedControls(),
    root = controlTicket(runtime, 1);
  const seed = controlTicket(runtime, 2);
  seed.retainControlsForGraphics();
  const stopped = allocateControls(seed, 5_505_220);
  stopped.stopped();
  const peer = controlTicket(runtime, 3);
  peer.retainControlsForGraphics();
  const running = allocateControls(peer, 5_505_220);
  const controls = () =>
    runtime
      .snapshot()
      .holders.filter((holder) => holder.label === "guest-control")
      .map((holder) => ({ state: holder.state, declaredBytes: holder.declaredBytes }));
  try {
    expect(controls()).toEqual([
      { state: "live", declaredBytes: 67_108_864 },
      { state: "debt", declaredBytes: 5_505_220 },
      { state: "live", declaredBytes: 67_108_864 },
    ]);
    running.stopped();
    expect(controls()).toEqual([
      { state: "live", declaredBytes: 67_108_864 },
      { state: "debt", declaredBytes: 5_505_220 },
      { state: "debt", declaredBytes: 5_505_220 },
    ]);
  } finally {
    running.stopped();
    root.launched().stopped();
    runtime.dispose();
  }
});
