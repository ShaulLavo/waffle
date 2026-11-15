import assert from "node:assert/strict";

const memoryPrototype = WebAssembly.Memory.prototype;
const bufferDescriptor = Object.getOwnPropertyDescriptor(memoryPrototype, "buffer")!;
const lengthDescriptor = Object.getOwnPropertyDescriptor(
  SharedArrayBuffer.prototype,
  "byteLength",
)!;
const nativeApply = Reflect.apply;
const getterCalls = new Map<unknown, number>();
const lengthCalls = new Map<unknown, number>();

function countedGetter(descriptor: PropertyDescriptor, calls: Map<unknown, number>) {
  return {
    ...descriptor,
    get: new Proxy(descriptor.get!, {
      apply(target, receiver, args) {
        assert.equal(args.length, 0);
        calls.set(receiver, (calls.get(receiver) ?? 0) + 1);
        return nativeApply(target, receiver, args);
      },
    }),
  };
}

// Transparent controls are installed before the actual providers capture their natives.
Object.defineProperty(memoryPrototype, "buffer", countedGetter(bufferDescriptor, getterCalls));
Object.defineProperty(
  SharedArrayBuffer.prototype,
  "byteLength",
  countedGetter(lengthDescriptor, lengthCalls),
);
const { wasmMemoryByteLengthReader } = await import("../../proc/intrinsics/host.ts");
const { createWorkerMemorySampler } = await import("../../browser/worker-memory.ts");
const { memoryViews } = await import("../../core/memory-views.ts");

function sharedMemory() {
  return new WebAssembly.Memory({ initial: 1, maximum: 8, shared: true });
}

function growableViews(memory: WebAssembly.Memory) {
  const views = memoryViews(memory);
  const buffer = views.bytes().buffer;
  assert(buffer instanceof SharedArrayBuffer);
  assert.equal(
    nativeApply(
      Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "growable")!.get!,
      buffer,
      [],
    ),
    true,
    "required positive guard: real shared Wasm growable buffer must arm",
  );
  return { views, buffer };
}

async function remoteGrow(worker: Worker, memory: WebAssembly.Memory, pages: number) {
  const result = Promise.withResolvers<number>();
  worker.onmessage = (event: MessageEvent<number>) => result.resolve(event.data);
  worker.onerror = (event) => result.reject(new Error(event.message));
  worker.postMessage({ memory, pages });
  return result.promise;
}

function stableSamples(
  views: ReturnType<typeof memoryViews>,
  read: () => number,
  sampler: ReturnType<typeof createWorkerMemorySampler>,
  cell: BigInt64Array,
) {
  for (let index = 0; index < 32; index++) {
    assert.equal(read(), 262144);
    Atomics.store(cell, 0, -1n);
    sampler.sample();
    assert.equal(Atomics.load(cell, 0), 262144n);
    assert.equal(views.bytes().byteLength, 262144);
    assert.equal(views.view().byteLength, 262144);
    assert.equal(views.range(65536, 1)[0], 42);
    assert.equal(views.range(262143, 1).buffer, views.bytes().buffer);
  }
}

async function otherAgentCase(worker: Worker, route: "getter" | "stable") {
  const memory = sharedMemory();
  const { views, buffer } = growableViews(memory);
  const read = wasmMemoryByteLengthReader(memory);
  const cell = new BigInt64Array(new SharedArrayBuffer(8));
  const sampler = createWorkerMemorySampler(cell.buffer);
  sampler.bind(memory);
  assert.equal(read(), 65536);
  assert.equal(await remoteGrow(worker, memory, 0), 1);
  assert.equal(read(), 65536);
  assert.equal(await remoteGrow(worker, memory, 1), 1);
  assert.equal(read(), 131072);
  assert.equal(views.range(65536, 1)[0], 42);
  assert.equal(await remoteGrow(worker, memory, 2), 2);
  const before = getterCalls.get(memory) ?? 0;
  const beforeLengths = lengthCalls.get(buffer) ?? 0;
  if (route === "getter") {
    for (let index = 0; index < 32; index++) {
      assert.equal(memory.buffer.byteLength, buffer.byteLength);
      assert.equal(new Uint8Array(memory.buffer, buffer.byteLength - 1, 1).length, 1);
    }
  } else stableSamples(views, read, sampler, cell);
  const calls = (getterCalls.get(memory) ?? 0) - before;
  assert.equal(calls, route === "getter" ? 64 : 0);
  if (route === "stable") assert.equal((lengthCalls.get(buffer) ?? 0) - beforeLengths, 64);
  assert.equal(read(), 262144);
  assert.throws(() => views.range(262144, 1), RangeError);
  assert.equal(views.range(262144, 0).length, 0);
  return { finalBytes: buffer.byteLength, getterCalls: calls };
}

function fixedAndUnsharedCases() {
  for (const shared of [false, true]) {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 8, shared });
    Object.defineProperty(memory, "toResizableBuffer", {
      get() {
        throw Error("conversion forbidden");
      },
    });
    const views = memoryViews(memory, "forbidden");
    const read = wasmMemoryByteLengthReader(memory);
    const original = views.bytes();
    assert.equal(read(), 65536);
    memory.grow(0);
    assert.equal(read(), 65536);
    assert.equal(views.bytes().buffer, memory.buffer);
    if (!shared) assert.notEqual(views.bytes(), original);
    assert.equal(original.byteLength, shared ? 65536 : 0);
    memory.grow(1);
    const before = getterCalls.get(memory) ?? 0;
    assert.equal(read(), 131072);
    assert.equal(read(), 131072);
    assert.equal((getterCalls.get(memory) ?? 0) - before, 2);
    assert.equal(views.range(65536, 1).length, 1);
  }
  assert.throws(wasmMemoryByteLengthReader(Object.create(memoryPrototype)), TypeError);
}

function localAndRebindingCases() {
  const memory = sharedMemory();
  const read = wasmMemoryByteLengthReader(memory);
  assert.equal(read(), 65536);
  const { views } = growableViews(memory);
  assert.equal(read(), 65536);
  const cell = new BigInt64Array(new SharedArrayBuffer(8));
  const sampler = createWorkerMemorySampler(cell.buffer);
  sampler.bind(memory);
  memory.grow(0);
  sampler.sample();
  assert.equal(Atomics.load(cell, 0), 65536n);
  memory.grow(1);
  assert.equal(views.range(65536, 1).length, 1);
  sampler.sample();
  assert.equal(Atomics.load(cell, 0), 131072n);
  const replacement = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
  growableViews(replacement);
  Atomics.store(cell, 0, -1n);
  sampler.bind(replacement);
  assert.equal(Atomics.load(cell, 0), 131072n);
  memory.grow(1);
  sampler.sample();
  assert.equal(Atomics.load(cell, 0), 131072n);
  replacement.grow(1);
  sampler.sample();
  assert.equal(Atomics.load(cell, 0), 196608n);
}

async function remoteFixedCase(worker: Worker) {
  const memory = sharedMemory();
  const views = memoryViews(memory, "forbidden");
  const original = views.bytes();
  const read = wasmMemoryByteLengthReader(memory);
  assert.equal(read(), 65536);
  assert.equal(await remoteGrow(worker, memory, 0), 1);
  assert.equal(read(), 65536);
  assert.equal(await remoteGrow(worker, memory, 1), 1);
  assert.equal(read(), 131072);
  assert.equal(views.range(65536, 1)[0], 42);
  assert.equal(views.view().byteLength, 131072);
  assert.equal(views.bytes().byteLength, 131072);
  assert.equal(original.byteLength, 65536);
}

function unsharedResizableCase() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  const views = memoryViews(memory);
  const buffer = views.bytes().buffer;
  const read = wasmMemoryByteLengthReader(memory);
  assert.equal(read(), 65536);
  memory.grow(0);
  assert.equal(read(), 65536);
  memory.grow(1);
  assert.equal(read(), 131072);
  assert.equal(views.range(65536, 1).buffer, buffer);
  const before = getterCalls.get(memory) ?? 0;
  assert.equal(read(), 131072);
  assert.equal(read(), 131072);
  assert.equal((getterCalls.get(memory) ?? 0) - before, 2);
}

function tamperCases() {
  const memory = sharedMemory();
  growableViews(memory);
  const read = wasmMemoryByteLengthReader(memory);
  assert.equal(read(), 65536);
  const growable = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "growable")!;
  const replaced = () => {
    throw Error("guest getter reached");
  };
  try {
    Object.defineProperty(memoryPrototype, "buffer", { configurable: true, get: replaced });
    Object.defineProperty(SharedArrayBuffer.prototype, "byteLength", {
      configurable: true,
      get: replaced,
    });
    Object.defineProperty(SharedArrayBuffer.prototype, "growable", {
      configurable: true,
      get: replaced,
    });
    assert.throws(() => memory.buffer, /guest getter reached/);
    memory.grow(1);
    assert.equal(read(), 131072);
    assert.equal(wasmMemoryByteLengthReader(memory)(), 131072);
  } finally {
    Object.defineProperty(memoryPrototype, "buffer", countedGetter(bufferDescriptor, getterCalls));
    Object.defineProperty(
      SharedArrayBuffer.prototype,
      "byteLength",
      countedGetter(lengthDescriptor, lengthCalls),
    );
    Object.defineProperty(SharedArrayBuffer.prototype, "growable", growable);
  }
}

const worker = new Worker(new URL("./stable-memory-grow-worker.ts", import.meta.url).href);
try {
  const reports = {
    "reader-getter-other-grow": await otherAgentCase(worker, "getter"),
    "reader-stable-other-grow": await otherAgentCase(worker, "stable"),
  };
  fixedAndUnsharedCases();
  await remoteFixedCase(worker);
  unsharedResizableCase();
  localAndRebindingCases();
  tamperCases();
  console.log(JSON.stringify(reports));
} finally {
  await worker.terminate();
  Object.defineProperty(memoryPrototype, "buffer", bufferDescriptor);
  Object.defineProperty(SharedArrayBuffer.prototype, "byteLength", lengthDescriptor);
}
