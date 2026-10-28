import { expect, test } from "bun:test";
import { createWorkerMemorySampler } from "../browser/worker-memory.js";

function cell() {
  const value = new BigInt64Array(new SharedArrayBuffer(8));
  Atomics.store(value, 0, -1n);
  return value;
}

for (const shared of [false, true])
  test(`actual memory samples follow growth and host boundaries, shared=${shared}`, () => {
    const bytes = cell();
    const sampler = createWorkerMemorySampler(bytes.buffer);
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(-1n);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 8, shared });
    sampler.bind(memory);
    expect(Atomics.load(bytes, 0)).toBe(65536n);
    const imports = {
      fixture: {
        grow() {
          memory.grow(1);
          return 17;
        },
        fail() {
          memory.grow(1);
          throw Error("host call failed");
        },
      },
    };
    Object.freeze(imports.fixture);
    Object.freeze(imports);
    const linked = sampler.imports(imports);
    const grow = linked.fixture!.grow,
      fail = linked.fixture!.fail;
    if (typeof grow !== "function" || typeof fail !== "function")
      throw Error("missing wrapped imports");
    expect(grow()).toBe(17);
    expect(Atomics.load(bytes, 0)).toBe(131072n);
    expect(() => fail()).toThrow("host call failed");
    expect(Atomics.load(bytes, 0)).toBe(196608n);
    memory.grow(1);
    expect(Atomics.load(bytes, 0)).toBe(196608n); // No real-time or peak guarantee.
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(262144n);
  });

test("an observation requires one 64-bit shared cell", () => {
  expect(() => createWorkerMemorySampler(new SharedArrayBuffer(16))).toThrow(TypeError);
});

test("zero is an actual sample and guest replacement of memory.buffer cannot forge it", () => {
  const bytes = cell();
  const sampler = createWorkerMemorySampler(bytes.buffer);
  const memory = new WebAssembly.Memory({ initial: 0, maximum: 4 });
  sampler.bind(memory);
  expect(Atomics.load(bytes, 0)).toBe(0n);
  const descriptor = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer")!;
  try {
    Object.defineProperty(WebAssembly.Memory.prototype, "buffer", {
      configurable: true,
      get: () => new ArrayBuffer(1),
    });
    memory.grow(1);
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(65536n);
  } finally {
    Object.defineProperty(WebAssembly.Memory.prototype, "buffer", descriptor);
  }
});
