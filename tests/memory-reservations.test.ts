import { expect, test } from "bun:test";
import {
  BOUNDED_ARENA_BYTES,
  BOUNDED_GROUP_MAXIMUM_PAGES,
  BOUNDED_PIPE_REGISTRY_CELLS,
  DESKTOP_ARENA_BYTES,
  DESKTOP_GROUP_MAXIMUM_PAGES,
  DESKTOP_PIPE_REGISTRY_CELLS,
  PAGE_BYTES,
  SharedMemoryAdmissionError,
  bytes,
  createSharedMemoryLedger,
  measureSharedMemory,
  pages,
  type ReservationAllocator,
  type ReservationShape,
  type SharedMemoryPlatform,
} from "../memory";

function allocator(calls: ReservationShape[] = []): ReservationAllocator {
  return {
    createBuffer(shape) {
      calls.push(shape);
      return new SharedArrayBuffer(1);
    },
    createMemory(shape) {
      calls.push(shape);
      return new WebAssembly.Memory({ initial: 0, maximum: 1, shared: shape.kind === "shared-memory" });
    },
  };
}

function bounded(budgetBytes: number, counts = { "fixed-buffer": true, "shared-memory": true, "private-memory": true }): SharedMemoryPlatform {
  return { kind: "bounded", budgetBytes: bytes(budgetBytes), counts };
}

test("pins desktop reservation policy without constructing desktop-sized buffers", () => {
  const calls: ReservationShape[] = [];
  const ledger = createSharedMemoryLedger({ platform: { kind: "unbounded", probedBytes: bytes(16 * 1024 * 1024 * 1024) }, allocator: allocator(calls) });
  const runtime = ledger.runtimeToken();
  expect(ledger.groupMemory()).toEqual({ kind: "growable", maximumPages: pages(DESKTOP_GROUP_MAXIMUM_PAGES) });
  expect(ledger.pipeRegistryCells()).toBe(DESKTOP_PIPE_REGISTRY_CELLS);
  const arena = ledger.arena(runtime);
  expect(arena).toBeInstanceOf(SharedArrayBuffer);
  expect(calls[0]).toEqual({ kind: "growable-buffer", maximum: bytes(DESKTOP_ARENA_BYTES) });
});

test("bounded policy uses the planning defaults and the explicit group size", () => {
  const ledger = createSharedMemoryLedger({ platform: bounded(8 * 1024 * 1024), allocator: allocator() });
  expect(ledger.groupMemory()).toEqual({ kind: "fixed", pages: pages(BOUNDED_GROUP_MAXIMUM_PAGES) });
  expect(ledger.groupMemory(pages(7))).toEqual({ kind: "fixed", pages: pages(7) });
  expect(ledger.pipeRegistryCells()).toBe(BOUNDED_PIPE_REGISTRY_CELLS);
  expect(BOUNDED_ARENA_BYTES).toBe(64 * 1024 * 1024);
});

test("admission is atomic and reports exact byte breakdown", () => {
  const ledger = createSharedMemoryLedger({ platform: bounded(PAGE_BYTES * 5), allocator: allocator() });
  const guest = { memory: "private" as const, maximumPages: pages(4) };
  const ticket = ledger.admit({ pid: 7, executable: "fixture", guest, connections: 0 });
  expect(ledger.snapshot().reservedBytes).toBe(PAGE_BYTES * 4);
  ticket.abort();
  expect(ledger.snapshot().reservedBytes).toBe(0);
  expect(() => ledger.admit({ pid: 7, executable: "fixture", guest: { memory: "private", maximumPages: pages(6) }, connections: 0 })).toThrow(SharedMemoryAdmissionError);
  try {
    ledger.admit({ pid: 7, executable: "fixture", guest: { memory: "private", maximumPages: pages(6) }, connections: 0 });
  } catch (error) {
    expect(error).toBeInstanceOf(SharedMemoryAdmissionError);
    expect((error as SharedMemoryAdmissionError).refusal).toMatchObject({ kind: "budget", requested: PAGE_BYTES * 6, available: PAGE_BYTES * 5, budget: PAGE_BYTES * 5 });
  }
  expect(ledger.snapshot().reservedBytes).toBe(0);
});

test("worker stop releases guest memory while an arena is pooled and reused", () => {
  const calls: ReservationShape[] = [];
  const ledger = createSharedMemoryLedger({ platform: { kind: "unbounded", probedBytes: bytes(16 * 1024 * 1024 * 1024) }, allocator: allocator(calls) });
  const first = ledger.admit({ pid: 1, executable: "one", guest: { memory: "private", maximumPages: pages(2) }, connections: 1 });
  const launched = first.launched();
  launched.stopped();
  expect(ledger.snapshot().holders.some(holder => holder.label === "request-arena" && holder.state === "idle")).toBe(true);
  const allocations = calls.length;
  const second = ledger.admit({ pid: 2, executable: "two", guest: { memory: "private", maximumPages: pages(2) }, connections: 1 });
  expect(calls.length).toBe(allocations + 1);
  second.launched().failed(new Error("stop failed"));
  expect(ledger.snapshot().holders.some(holder => holder.state === "debt")).toBe(true);
});

test("awaiting release stays charged until collection", () => {
  const ledger = createSharedMemoryLedger({ platform: bounded(1024, { "fixed-buffer": true, "shared-memory": true, "private-memory": true }), allocator: allocator() });
  const runtime = ledger.runtimeToken();
  ledger.reserveBuffer("filesystem-root", { kind: "fixed-buffer", length: bytes(512) }, runtime);
  ledger.disposeRuntime(runtime);
  expect(ledger.snapshot()).toMatchObject({ reservedBytes: 512, awaitingReleaseBytes: 512, availableBytes: 512 });
  expect(() => ledger.admit({ pid: 1, executable: "fixture", guest: { memory: "private", maximumPages: pages(1) }, connections: 0 })).toThrow(SharedMemoryAdmissionError);
  ledger.collectRuntime(runtime);
  expect(ledger.snapshot()).toMatchObject({ reservedBytes: 0, awaitingReleaseBytes: 0, availableBytes: 1024 });
});

test("bounded platforms refuse growable shared memory with many agents", () => {
  const ledger = createSharedMemoryLedger({ platform: bounded(PAGE_BYTES * 100), allocator: allocator() });
  const result = ledger.check({ memory: "shared", growth: "growable", maximumPages: pages(1), agents: "many" });
  expect(result.kind).toBe("refused");
  if (result.kind === "refused") expect(result.error.refusal.kind).toBe("configuration");
  expect(ledger.check({ memory: "shared", growth: "fixed", pages: pages(1), agents: "many" }).kind).toBe("admitted");
});

test("desktop admits growable shared memory with many agents", () => {
  const ledger = createSharedMemoryLedger({ platform: { kind: "unbounded", probedBytes: bytes(16 * 1024 * 1024 * 1024) }, allocator: allocator() });
  expect(ledger.check({ memory: "shared", growth: "growable", maximumPages: pages(1), agents: "many" }).kind).toBe("admitted");
});

test("declared maximum is accounted independently of current byte length", () => {
  const ledger = createSharedMemoryLedger({ platform: bounded(2_000), allocator: allocator() });
  const runtime = ledger.runtimeToken();
  ledger.reserveBuffer("filesystem-segment", { kind: "growable-buffer", maximum: bytes(1_500) }, runtime);
  expect(ledger.snapshot().holders[0]).toMatchObject({ declaredBytes: 1_500, grownBytes: 1 });
  expect(ledger.snapshot().reservedBytes).toBe(1_500);
});

test("probe result is converted to measured platform without UA sniffing", async () => {
  const boundedPlatform = await measureSharedMemory({ probe: async () => ({ growableBytes: 512 * 1024 * 1024, ceilingReached: false, counts: { "fixed-buffer": false, "shared-memory": true, "private-memory": false } }) });
  expect(boundedPlatform).toEqual({ kind: "bounded", budgetBytes: bytes(256 * 1024 * 1024), counts: { "fixed-buffer": false, "shared-memory": true, "private-memory": false } });
  const desktopPlatform = await measureSharedMemory({ probe: async () => ({ growableBytes: 16 * 1024 * 1024 * 1024, ceilingReached: true, counts: { "fixed-buffer": true, "shared-memory": true, "private-memory": true } }) });
  expect(desktopPlatform).toEqual({ kind: "unbounded", probedBytes: bytes(16 * 1024 * 1024 * 1024) });
});

test("native allocation refusal becomes a typed platform refusal", () => {
  const throwingAllocator: ReservationAllocator = {
    createBuffer() { throw new RangeError("out of memory"); },
    createMemory() { throw new RangeError("out of memory"); },
  };
  const ledger = createSharedMemoryLedger({ platform: bounded(PAGE_BYTES * 10), allocator: throwingAllocator });
  expect(() => ledger.admit({ pid: 1, executable: "fixture", guest: { memory: "private", maximumPages: pages(1) }, connections: 0 })).toThrow(SharedMemoryAdmissionError);
  try {
    ledger.admit({ pid: 1, executable: "fixture", guest: { memory: "private", maximumPages: pages(1) }, connections: 0 });
  } catch (error) {
    expect(error).toBeInstanceOf(SharedMemoryAdmissionError);
    expect((error as SharedMemoryAdmissionError).refusal.kind).toBe("platform");
  }
});

test("group memories are fixed and recycled by declared page count", () => {
  const calls: ReservationShape[] = [];
  const ledger = createSharedMemoryLedger({ platform: bounded(PAGE_BYTES * 8), allocator: allocator(calls) });
  const shape = { kind: "shared-memory" as const, growth: "fixed" as const, pages: pages(2) };
  const first = ledger.reserveMemory("memory-group", shape);
  ledger.releaseGroupMemory(first);
  const allocations = calls.length;
  const second = ledger.reserveMemory("memory-group", shape);
  expect(second).toBe(first);
  expect(calls.length).toBe(allocations);
  ledger.releaseGroupMemory(second);
});

test("runtime-held reservations stay independent across runtime tokens", () => {
  const ledger = createSharedMemoryLedger({ platform: bounded(2_000), allocator: allocator() });
  const first = ledger.runtimeToken();
  const second = ledger.runtimeToken();
  ledger.reserveBuffer("filesystem-root", { kind: "fixed-buffer", length: bytes(500) }, first);
  ledger.reserveBuffer("filesystem-root", { kind: "fixed-buffer", length: bytes(300) }, second);
  ledger.disposeRuntime(first);
  const holders = ledger.snapshot().holders;
  expect(holders.filter(holder => holder.state === "awaiting-collection")).toHaveLength(1);
  expect(holders.filter(holder => holder.state === "live")).toHaveLength(1);
  ledger.collectRuntime(first);
  expect(ledger.snapshot().reservedBytes).toBe(300);
});

test("bounded arena reuse does not consume a second slot", () => {
  const budget = BOUNDED_ARENA_BYTES + PAGE_BYTES;
  const calls: ReservationShape[] = [];
  const ledger = createSharedMemoryLedger({ platform: bounded(budget), allocator: allocator(calls) });
  const first = ledger.admit({ pid: 1, executable: "one", guest: { memory: "private", maximumPages: pages(1) }, connections: 1 });
  first.launched().stopped();
  const allocations = calls.length;
  const second = ledger.admit({ pid: 2, executable: "two", guest: { memory: "private", maximumPages: pages(1) }, connections: 1 });
  expect(calls.length).toBe(allocations + 1);
  second.abort();
});
