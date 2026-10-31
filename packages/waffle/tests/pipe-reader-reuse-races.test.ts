import { afterEach, expect, test } from "bun:test";
import { isolatedPipes } from "./fixtures/pipes-intrinsics.ts";
import type { PipeEndpointHandle } from "../proc/pipes.js";

const { pipes, atomics: A, hooks } = isolatedPipes();
const { PipeController, PipeErrno, PipePublicationRegistry, attachPipeEndpoint } = pipes;
const controllers: InstanceType<typeof PipeController>[] = [];
const STOP = 1n << 32n;
function words(handle: PipeEndpointHandle) {
  const stride = 40 + handle.capacity + Math.min(handle.capacity, 1024) * 16;
  const offset = 40 + (handle.maxWriters + handle.slot) * stride;
  return {
    owner: new Int32Array(handle.buffer, offset, 1),
    refs: new Int32Array(handle.buffer, offset + 4, 1),
    epoch: new Int32Array(handle.buffer, offset + 36, 1),
    published: new BigInt64Array(handle.buffer, offset + 8, 1),
    consumed: new BigInt64Array(handle.buffer, offset + 16, 1),
  };
}
function sameWord(a: ArrayBufferView, b: ArrayBufferView) {
  return a.buffer === b.buffer && a.byteOffset === b.byteOffset;
}
function singleReader() {
  const pipe = new PipeController({ capacity: 8, maxReaders: 1, relay: "manual" });
  controllers.push(pipe);
  const first = pipe.retain(1, "read"),
    writer = pipe.retain(3, "write");
  first.close();
  const reader = pipe.retain(2, "read");
  return { pipe, reader, writer };
}
afterEach(() => {
  for (const pipe of controllers.splice(0)) pipe.dispose();
});

for (const phase of ["payload", "published"] as const) {
  test(`reader reuse waits for a relay paused at ${phase}, then recovers exactly once`, () => {
    const { pipe, reader, writer } = singleReader();
    const stale = attachPipeEndpoint(structuredClone(reader.handle()));
    const state = words(reader.handle());
    const cas = A.compareExchange,
      subarray = hooks.typedArraySubarray;
    const payload = new Uint8Array([10, 11, 12]);
    expect(writer.tryWrite([payload])).toBe(3);
    expect(reader.tryRead([new Uint8Array(8)])).toBe(-PipeErrno.AGAIN);
    let paused = false;
    function pause() {
      paused = true;
      expect(Atomics.load(state.epoch, 0)).toBe(256 + 2);
      pipe.revoke(2);
      expect(Atomics.load(state.owner, 0)).toBe(2);
      expect(Atomics.load(state.refs, 0)).toBe(-1);
      expect(() => pipe.retain(4, "read")).toThrow("busy");
      expect(Atomics.load(state.epoch, 0)).toBe(256 + 2);
    }
    hooks.typedArraySubarray = (view, begin, end) => {
      if (phase === "payload" && !paused && Atomics.load(state.epoch, 0) === 258) pause();
      return subarray(view, begin, end);
    };
    A.compareExchange = ((array: BigInt64Array, index: number, old: bigint, next: bigint) => {
      const result = cas(array, index, old, next);
      if (phase === "published" && !paused && sameWord(array, state.published) && result === old)
        pause();
      return result;
    }) as typeof A.compareExchange;
    try {
      pipe.pumpRelay();
    } finally {
      A.compareExchange = cas;
      hooks.typedArraySubarray = subarray;
    }
    expect(paused).toBe(true);
    expect(Atomics.load(state.epoch, 0)).toBe(256);
    // pumpRelay's next bounded step recovers a dead committed delivery before returning.
    expect(Atomics.load(state.published, 0) & 0xffffffffn).toBe(phase === "payload" ? 0n : 3n);
    const next = pipe.retain(4, "read");
    expect(next.handle().incarnation).toBe(2);
    stale.close();
    expect(stale.tryRead([new Uint8Array(8)])).toBe(-PipeErrno.BADF);
    expect(Atomics.load(state.owner, 0)).toBe(4);
    expect(Atomics.load(state.refs, 0)).toBe(1);
    expect(Atomics.load(state.epoch, 0)).toBe(512);
    const output = new Uint8Array(8);
    expect(next.tryRead([output])).toBe(-PipeErrno.AGAIN);
    pipe.pumpRelay();
    expect(next.tryRead([output])).toBe(3);
    expect(output.subarray(0, 3)).toEqual(payload);
    expect(next.tryRead([output])).toBe(-PipeErrno.AGAIN);
    writer.close();
    pipe.pumpRelay();
    expect(next.tryRead([output])).toBe(0);
  });
}

test("undrained dead reader stays unavailable until relay recovery consumes its records", () => {
  const { pipe, reader, writer } = singleReader();
  expect(writer.tryWrite([new Uint8Array([10, 11, 12])])).toBe(3);
  expect(reader.tryRead([new Uint8Array(8)])).toBe(-PipeErrno.AGAIN);
  pipe.pumpRelay();
  reader.close();
  const state = words(reader.handle());
  expect(Atomics.load(state.epoch, 0)).toBe(256);
  expect(() => pipe.retain(4, "read")).toThrow("unread");
  expect(Atomics.load(state.owner, 0)).toBe(2);
  pipe.pumpRelay();
  const next = pipe.retain(4, "read");
  expect(Atomics.load(state.epoch, 0)).toBe(512);
  expect(next.tryRead([new Uint8Array(8)])).toBe(-PipeErrno.AGAIN);
  pipe.pumpRelay();
  const output = new Uint8Array(8);
  expect(next.tryRead([output])).toBe(3);
  expect(output.subarray(0, 3)).toEqual(new Uint8Array([10, 11, 12]));
});

test("single reader reclaim switches to relay before publishing its replacement", () => {
  const registry = new PipePublicationRegistry();
  for (const pid of [1, 2, 3]) registry.registerProcess(pid);
  const pipe = new PipeController({ capacity: 8, maxReaders: 1, registry, relay: "manual" });
  controllers.push(pipe);
  const first = pipe.retain(1, "read"),
    writer = pipe.retain(3, "write");
  expect(writer.tryWrite([new Uint8Array([9])])).toBe(1);
  first.close();
  const state = words(first.handle()),
    store = A.store;
  let observed = false;
  A.store = ((array: Int32Array, index: number, value: number) => {
    if (sameWord(array, state.owner) && value === 2) {
      observed = true;
      expect(pipe.mode).toBe("relay");
      expect(Atomics.load(state.epoch, 0)).toBe(256);
      expect(Atomics.load(state.refs, 0)).toBe(1);
    }
    return store(array, index, value);
  }) as typeof A.store;
  let next: ReturnType<typeof pipe.retain>;
  try {
    next = pipe.retain(2, "read");
  } finally {
    A.store = store;
  }
  expect(observed).toBe(true);
  expect(next.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  pipe.pumpRelay();
  const output = new Uint8Array(1);
  expect(next.tryRead([output])).toBe(1);
  expect(output[0]).toBe(9);
  for (const pid of [1, 2, 3]) registry.collectProcess(pid);
});

test("a relay-mode read holds its incarnation through consumption and demand", () => {
  const { pipe, reader, writer } = singleReader();
  expect(writer.tryWrite([new Uint8Array([9])])).toBe(1);
  expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  pipe.pumpRelay();
  const state = words(reader.handle()),
    subarray = hooks.typedArraySubarray;
  let paused = false;
  hooks.typedArraySubarray = (view, begin, end) => {
    if (!paused && view.buffer === reader.handle().buffer) {
      paused = true;
      reader.close();
      expect(Atomics.load(state.epoch, 0)).toBe(257);
      expect(() => pipe.retain(4, "read")).toThrow("busy");
      expect(Atomics.load(state.consumed, 0) & STOP).toBe(STOP);
    }
    return subarray(view, begin, end);
  };
  try {
    expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  } finally {
    hooks.typedArraySubarray = subarray;
  }
  expect(paused).toBe(true);
  expect(Atomics.load(state.epoch, 0)).toBe(256);
  pipe.pumpRelay();
  const next = pipe.retain(4, "read");
  expect(Atomics.load(state.epoch, 0)).toBe(512);
  expect(next.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  pipe.pumpRelay();
  const output = new Uint8Array(1);
  expect(next.tryRead([output])).toBe(1);
  expect(output[0]).toBe(9);
});
