import { sampledHostImportsGuest } from "./fixtures/memory-observation-guest.js";
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { createWorkerMemorySampler } from "../browser/worker-memory.js";
import { isSharedArrayBuffer } from "../proc/intrinsics.js";

function cell() {
  const value = new BigInt64Array(new SharedArrayBuffer(8));
  Atomics.store(value, 0, -1n);
  return value;
}

for (const shared of [false, true])
  test(`capacity reuse preserves zero-growth, rebinding and every publication, shared=${shared}`, () => {
    const bytes = cell();
    const sampler = createWorkerMemorySampler(bytes.buffer);
    const first = new WebAssembly.Memory({ initial: 1, maximum: 8, shared });
    sampler.bind(first);
    first.grow(0);
    Atomics.store(bytes, 0, -1n);
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(65536n);
    first.grow(1);
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(131072n);
    const second = new WebAssembly.Memory({ initial: 1, maximum: 8, shared });
    sampler.bind(second);
    first.grow(1);
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(65536n);
    second.grow(0);
    second.grow(2);
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(196608n);
    const equalCapacity = new WebAssembly.Memory({ initial: 3, maximum: 8, shared });
    Atomics.store(bytes, 0, -1n);
    sampler.bind(equalCapacity);
    expect(Atomics.load(bytes, 0)).toBe(196608n);
    second.grow(1);
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(196608n);
    equalCapacity.grow(1);
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(262144n);
    sampler.bind(new WebAssembly.Memory({ initial: 0, maximum: 1, shared }));
    expect(Atomics.load(bytes, 0)).toBe(0n);
    Atomics.store(bytes, 0, -1n);
    sampler.sample();
    expect(Atomics.load(bytes, 0)).toBe(0n);
  });

test("unchanged capacity is published at host entry, return and throw boundaries", () => {
  const bytes = cell();
  const sampler = createWorkerMemorySampler(bytes.buffer);
  sampler.bind(new WebAssembly.Memory({ initial: 1 }));
  const linked = sampler.imports(sampledHostImportsGuest(), {
    fixture: {
      grow() {
        expect(Atomics.load(bytes, 0)).toBe(65536n);
        Atomics.store(bytes, 0, -2n);
        return 17;
      },
      fail() {
        expect(Atomics.load(bytes, 0)).toBe(65536n);
        Atomics.store(bytes, 0, -3n);
        throw Error("host failure");
      },
    },
  });
  const grow = linked.fixture!.grow,
    fail = linked.fixture!.fail;
  if (typeof grow !== "function" || typeof fail !== "function")
    throw Error("missing wrapped imports");
  Atomics.store(bytes, 0, -1n);
  expect(grow()).toBe(17);
  expect(Atomics.load(bytes, 0)).toBe(65536n);
  Atomics.store(bytes, 0, -1n);
  expect(() => fail()).toThrow("host failure");
  expect(Atomics.load(bytes, 0)).toBe(65536n);
});

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
    const linked = sampler.imports(sampledHostImportsGuest(), imports);
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

for (const shared of [false, true])
  test(`cached memory length reads ignore later buffer getter replacement, shared=${shared}`, () => {
    const bytes = cell();
    const sampler = createWorkerMemorySampler(bytes.buffer);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared });
    sampler.bind(memory);
    const prototype = shared ? SharedArrayBuffer.prototype : ArrayBuffer.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "byteLength")!;
    try {
      Object.defineProperty(prototype, "byteLength", {
        configurable: true,
        get: () => {
          throw Error("replaced buffer length getter");
        },
      });
      memory.grow(1);
      sampler.sample();
      expect(Atomics.load(bytes, 0)).toBe(131072n);
    } finally {
      Object.defineProperty(prototype, "byteLength", descriptor);
    }
  });

test("the strict shared brand predicate accepts cross-realm buffers", () => {
  const ordinary: unknown = runInNewContext("new ArrayBuffer(8)");
  const shared: unknown = runInNewContext("new SharedArrayBuffer(8)");
  expect(isSharedArrayBuffer(ordinary)).toBe(false);
  expect(isSharedArrayBuffer(shared)).toBe(true);
});

test("sampled calls preserve receiver, arguments, thrown values and returned promise identity", async () => {
  const bytes = cell();
  const sampler = createWorkerMemorySampler(bytes.buffer);
  sampler.bind(new WebAssembly.Memory({ initial: 1 }));
  const result = Promise.resolve(17);
  const failure = new Error("original host failure");
  type Receiver = { name: string; observedThis?: unknown; observedArgs: unknown[] };
  const receiver: Receiver = { name: "receiver", observedArgs: [] };
  const linked = sampler.imports(sampledHostImportsGuest(), {
    fixture: {
      grow(this: Receiver, ...args: unknown[]) {
        this.observedThis = this;
        this.observedArgs = args;
        return result;
      },
      fail() {
        throw failure;
      },
    },
  });
  const grow = linked.fixture!.grow,
    fail = linked.fixture!.fail;
  if (typeof grow !== "function" || typeof fail !== "function")
    throw Error("missing wrapped imports");
  expect(Reflect.apply(grow, receiver, [17, "argument"])).toBe(result);
  expect(receiver.observedThis).toBe(receiver);
  expect(receiver.observedArgs).toEqual([17, "argument"]);
  let caught: unknown;
  try {
    fail();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  expect(Atomics.load(bytes, 0)).toBe(65536n);
  expect(await result).toBe(17);
});
