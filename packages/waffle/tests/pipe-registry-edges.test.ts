import { expect, test } from "bun:test";
import * as production from "../proc/pipes.js";
import { PipeRealm } from "./fixtures/pipe-interleave.ts";
import { isolatedPipes } from "./fixtures/pipes-intrinsics.ts";

// Registry edges found in review: growth racing a revoke scan, a Worker stopping while it
// retires a pipe, the tag check on an unheld load, and a cell at its hold limit.
type Pipes = typeof production;
type Registry = InstanceType<Pipes["PipePublicationRegistry"]>;
const STOP = 1n << 32n;

function enrolled(pipes: Pipes, processes: number, maxCells: number): Registry {
  const registry = new pipes.PipePublicationRegistry({
    processCapacity: processes,
    cellsPerProcess: 1,
    maxCells,
  });
  for (let pid = 1; pid < processes; pid++) registry.registerProcess(pid);
  return registry;
}
function tinyPipe(pipes: Pipes, registry: Registry) {
  return new pipes.PipeController({
    registry,
    capacity: 8,
    maxWriters: 1,
    maxReaders: 1,
    relay: "manual",
  });
}

test("a revoke while an allocator grows the registry sees only backed cells", () => {
  const isolated = isolatedPipes();
  const pipes = isolated.pipes as unknown as Pipes;
  const grow = isolated.hooks.sharedArrayBufferGrow;
  const registry = enrolled(pipes, 4, 64);
  // Fill the four initially backed cells; the next allocation must grow the buffer.
  for (let index = 0; index < 4; index++) registry.allocate(1);
  let revoked: unknown = "not run";
  isolated.hooks.sharedArrayBufferGrow = (buffer, length) => {
    isolated.hooks.sharedArrayBufferGrow = grow;
    try {
      registry.revoke(2);
      revoked = undefined;
    } catch (error) {
      revoked = error;
    }
    grow(buffer, length);
  };
  try {
    expect(registry.allocate(1) & 0xffff).toBe(4);
  } finally {
    isolated.hooks.sharedArrayBufferGrow = grow;
  }
  expect(revoked).toBeUndefined();
});

test("an allocator that stops while growing the registry leaves kills and collection working", () => {
  const isolated = isolatedPipes();
  const pipes = isolated.pipes as unknown as Pipes;
  const grow = isolated.hooks.sharedArrayBufferGrow;
  const registry = enrolled(pipes, 4, 64);
  for (let index = 0; index < 4; index++) registry.allocate(1);
  isolated.hooks.sharedArrayBufferGrow = () => {
    throw new Error("worker stopped here");
  };
  try {
    expect(() => registry.allocate(1)).toThrow("worker stopped here");
  } finally {
    isolated.hooks.sharedArrayBufferGrow = grow;
  }
  expect(() => registry.revoke(2)).not.toThrow();
  expect(() => registry.collectProcess(2)).not.toThrow();
  expect(registry.cellsInUse).toBe(4);
  expect(registry.processCount).toBe(2);
  expect(registry.allocate(1) & 0xffff).toBe(4);
});

test("a Worker that stops while retiring a pipe leaves the rest of its retirement to the next check", () => {
  const page = new PipeRealm(),
    guest = new PipeRealm();
  const registry = enrolled(page.pipes, 8, 16);
  const pipe = tinyPipe(page.pipes, registry);
  const reader = pipe.retain(2, "read");
  const writer = pipe.retain(1, "write");
  const guestReader = guest.adopt(reader);
  writer.close();
  // The guest stops right after it wins the retiring CAS, before it releases any cell.
  const died = new Error("guest stopped");
  const atomics = guest.atomics as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = new Map<string, unknown>();
  let dead = false;
  for (const name of ["load", "store", "add", "or", "exchange", "compareExchange", "notify"]) {
    const real = (Atomics as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
    original.set(name, atomics[name]);
    atomics[name] = (...args: unknown[]) => {
      if (dead) throw died;
      const result = real(...args);
      const retiring = name === "compareExchange" && args[2] !== -1 && args[3] === -1;
      if (retiring && result === args[2] && (args[0] as Int32Array).byteOffset === 0) dead = true;
      return result;
    };
  }
  expect(() => guestReader.close()).toThrow(died);
  expect(dead).toBe(true);
  expect(registry.cellsInUse).toBe(4);
  // The page's next look at the pipe finishes the retirement.
  expect(pipe.closed).toBe(true);
  expect(registry.cellsInUse).toBe(0);
  pipe.dispose();
});

test("an unheld cursor load rejects a cell reused between its mapping and cursor loads", () => {
  const page = new PipeRealm(),
    guest = new PipeRealm();
  const registry = enrolled(page.pipes, 8, 16);
  const pipe = tinyPipe(page.pipes, registry);
  const hostReader = pipe.retain(2, "read");
  const hostWriter = pipe.retain(1, "write");
  const reader = guest.adopt(hostReader);
  const mapping = page.pipes.pipeRingOffset(hostWriter.handle()) + 24;
  const buffer = reader.handle().buffer;
  const atomics = guest.atomics as unknown as { load: (view: unknown, index: number) => unknown };
  let fired = false;
  atomics.load = (view, index) => {
    const value = Atomics.load(view as Int32Array, index);
    const words = view as Int32Array;
    if (fired || words.buffer !== buffer || words.byteOffset !== mapping) return value;
    fired = true;
    // The guest has read the mapping word but not the cell. The page retires the pipe, and a
    // later pipe takes its cells and moves their cursors.
    hostReader.close();
    hostWriter.close();
    expect(pipe.closed).toBe(true);
    const next = tinyPipe(page.pipes, registry);
    const nextReader = next.retain(4, "read");
    const nextWriter = next.retain(3, "write");
    expect(nextWriter.tryWrite([new Uint8Array([1, 2, 3])])).toBe(3);
    expect(nextReader.tryRead([new Uint8Array(1)])).toBe(1);
    return value;
  };
  // The old pipe never held a byte; the guest must not report the later pipe's bytes.
  expect(reader.readiness().nbytes).toBe(0);
  expect(fired).toBe(true);
});

/** Set a cell's hold count to its limit; returns a function restoring the original word. */
function saturate(registry: Registry, index: number, processes: number): () => void {
  const epochs = new Int32Array(registry.handle().buffer, 16 + processes * 8);
  const original = Atomics.load(epochs, index * 4);
  Atomics.store(epochs, index * 4, original | 0xffff);
  return () => Atomics.store(epochs, index * 4, original);
}

test("a write refused at a cell's hold limit leaves its ring section", () => {
  const registry = enrolled(production, 8, 16);
  const pipe = tinyPipe(production, registry);
  const reader = pipe.retain(2, "read");
  const writer = pipe.retain(1, "write");
  const handle = writer.handle();
  const ring = production.pipeRingOffset(handle);
  const published = Atomics.load(new Int32Array(handle.buffer, ring + 24, 1), 0) - 1;
  const restore = saturate(registry, published & 0xffff, 8);
  expect(() => writer.tryWrite([new Uint8Array([1])])).toThrow(RangeError);
  restore();
  expect(Atomics.load(new Int32Array(handle.buffer, ring + 36, 1), 0) & 0xff).toBe(0);
  expect(writer.tryWrite([new Uint8Array([1])])).toBe(1);
  expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
  pipe.dispose();
});

test("a revocation meeting a cell at its hold limit still freezes, wakes and collects the rest", () => {
  const registry = enrolled(production, 8, 16);
  const first = registry.allocate(1),
    second = registry.allocate(1);
  const wake = registry.wake;
  const restore = saturate(registry, first & 0xffff, 8);
  const before = Atomics.load(wake, 0);
  expect(() => registry.revoke(1)).toThrow(RangeError);
  expect(Atomics.load(registry.canonical(second), 0) & STOP).toBe(STOP);
  expect(Atomics.load(wake, 0)).not.toBe(before);
  const count = registry.processCount;
  expect(() => registry.collectProcess(1)).toThrow(RangeError);
  expect(registry.processCount).toBe(count - 1);
  restore();
});
