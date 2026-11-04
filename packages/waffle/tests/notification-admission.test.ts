import { expect, test } from "bun:test";
import { createNotificationBridge } from "../browser/notification-relay";
import { installSharedControlAllocator } from "../memory/allocator";
import {
  SharedMemoryAdmissionError,
  SharedMemoryLedger,
  bytes,
  declareSharedMemoryPlatform,
} from "../memory/reservations";

test("notification control-budget refusal closes both untransferred ports", () => {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(1),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  const restoreAllocator = installSharedControlAllocator((length) =>
    reservations.buffer("control", { kind: "fixed-buffer", length: bytes(length) }),
  );
  const NativeMessageChannel = globalThis.MessageChannel;
  const ports: MessagePort[] = [];
  const closed = new Set<MessagePort>();
  function track(port: MessagePort): void {
    ports.push(port);
    const close = port.close.bind(port);
    port.close = () => {
      closed.add(port);
      close();
    };
  }
  class TrackedMessageChannel extends NativeMessageChannel {
    constructor() {
      super();
      track(this.port1);
      track(this.port2);
    }
  }
  globalThis.MessageChannel = TrackedMessageChannel;
  try {
    expect(() => createNotificationBridge("must-not-launch")).toThrow(SharedMemoryAdmissionError);
    expect(ports).toHaveLength(2);
    expect(closed.size).toBe(2);
    expect(reservations.snapshot().reservedBytes).toBe(0);
  } finally {
    globalThis.MessageChannel = NativeMessageChannel;
    restoreAllocator();
    for (const port of ports) port.close();
    reservations.dispose();
  }
});
