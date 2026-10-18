import { expect, test } from "bun:test";
import type {
  attachPipeEndpoint,
  attachPipePublicationRegistry,
  PipeController,
  PipeErrno,
  PipePublicationRegistry,
} from "../proc/pipes.js";
import type { createWorkerProcessTransport } from "../proc/worker-client.js";
import type { WorkerPipeBroker, WorkerPipeHost } from "../proc/worker-pipes.js";
import { isolatedProcess } from "./fixtures/isolated-process.js";

const isolated = await isolatedProcess();
const Atomics = isolated.atomics;
const {
  attachPipeEndpoint,
  attachPipePublicationRegistry,
  PipeController,
  PipeErrno,
  PipePublicationRegistry,
} = isolated.load<typeof import("../proc/pipes.js")>("pipes");
const { createWorkerProcessTransport } =
  isolated.load<typeof import("../proc/worker-client.js")>("worker-client");
const { WorkerPipeBroker, WorkerPipeHost } =
  isolated.load<typeof import("../proc/worker-pipes.js")>("worker-pipes");

const STOP = 1n << 32n;
const REVOKED = 1n << 31n;
const HEAD = REVOKED - 1n;
const bytes = new Uint8Array([120]);

function ownerWords(registry: PipePublicationRegistry): BigInt64Array {
  const handle = registry.handle();
  return new BigInt64Array(handle.buffer, 16, handle.processCapacity);
}

test("3001 pipe-backed child lifetimes reuse two owner slots and root exit leaves no owners or relays", () => {
  const registry = new PipePublicationRegistry({
    processCapacity: 2,
    cellsPerProcess: 1,
    maxCells: 1 << 16,
  });
  const cloned = attachPipePublicationRegistry(structuredClone(registry.handle()));
  const broker = new WorkerPipeBroker({ relay: "manual" });
  registry.registerProcess(1);
  let completed = 0;
  let stale: ReturnType<typeof attachPipeEndpoint> | undefined;
  try {
    for (let pid = 2; pid <= 3002; pid++) {
      registry.registerProcess(pid);
      const controller = new PipeController({
        capacity: 8,
        maxWriters: 1,
        maxReaders: 1,
        registry: cloned,
        relay: "manual",
      });
      try {
        const reader = controller.retain(pid, "read"),
          writer = controller.retain(pid, "write");
        if (pid === 2) stale = attachPipeEndpoint(structuredClone(writer.handle()));
        broker.attach(structuredClone(reader.handle()));
        expect(writer.tryWrite([bytes])).toBe(1);
        expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
        // No guest closes its descriptors. The host fence alone freezes and retires them.
        registry.revoke(pid);
        registry.collectProcess(pid);
        broker.pump();
        expect(writer.tryWrite([bytes])).toBe(-PipeErrno.BADF);
        expect(cloned.isRevoked(pid)).toBe(true);
        expect(registry.processCount).toBe(1);
        expect(broker.size).toBe(0);
        completed++;
      } finally {
        registry.collectProcess(pid);
        controller.dispose();
      }
    }
    expect(completed).toBe(3001);
    expect(stale!.tryWrite([bytes])).toBe(-PipeErrno.BADF);
    expect(() => cloned.allocate(2)).toThrow("revoked");
    cloned.revoke(2);
    cloned.collectProcess(2);
    expect(registry.processCount).toBe(1);
    // An older still-live owner can create its FIRST pipe after thousands of newer PIDs.
    const root = new PipeController({
      capacity: 8,
      maxWriters: 1,
      maxReaders: 1,
      registry,
      relay: "manual",
    });
    try {
      const reader = root.retain(1, "read"),
        writer = root.retain(1, "write");
      broker.attach(reader.handle());
      expect(writer.tryWrite([bytes])).toBe(1);
      expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
      registry.collectProcess(1);
      broker.pump();
      expect(root.closed).toBe(true);
      expect(registry.processCount).toBe(0);
      expect(broker.size).toBe(0);
    } finally {
      root.dispose();
    }
    // Owner metadata is fixed at two 8-byte words. Four permanent cells per pipe grow
    // geometrically; this workload needs less than 512 KiB and never the arena's 1 MiB cap.
    expect(ownerWords(registry).byteLength).toBe(16);
    expect(registry.handle().buffer.byteLength).toBeLessThan(512 * 1024);
  } finally {
    registry.collectProcess(1);
    broker.dispose();
    stale?.close();
  }
});

test("collected canonical views never alias the next occupant and unknown revoke creates no owner", () => {
  const registry = new PipePublicationRegistry({
    processCapacity: 1,
    cellsPerProcess: 1,
    maxCells: 8,
  });
  const retained = attachPipePublicationRegistry(structuredClone(registry.handle()));
  registry.revoke(99);
  registry.collectProcess(99);
  expect(registry.processCount).toBe(0);
  registry.registerProcess(1);
  registry.registerProcess(1);
  expect(registry.processCount).toBe(1);
  const old = retained.canonical(retained.allocate(1));
  registry.collectProcess(1);
  expect(Atomics.load(old, 0) & STOP).toBe(STOP);
  registry.registerProcess(2);
  const fresh = registry.canonical(registry.allocate(2));
  const value = Atomics.load(fresh, 0);
  Atomics.store(old, 0, 123n);
  expect(Atomics.load(fresh, 0)).toBe(value);
  expect(() => retained.allocate(1)).toThrow("revoked");
  retained.revoke(1);
  retained.collectProcess(1);
  expect(registry.processCount).toBe(1);
  expect(registry.isRevoked(2)).toBe(false);
  expect(Atomics.load(fresh, 0)).toBe(value);
  registry.collectProcess(2);
  expect(registry.processCount).toBe(0);
});

for (const phase of ["before-link", "after-link", "after-final-check"] as const) {
  test(`an allocator paused ${phase} cannot modify a recycled owner`, () => {
    const registry = new PipePublicationRegistry({
      processCapacity: 1,
      cellsPerProcess: 1,
      maxCells: 8,
    });
    registry.registerProcess(1);
    const buffer = registry.handle().buffer;
    const compareExchange = Atomics.compareExchange,
      load = Atomics.load;
    let raced = false,
      ownerLoads = 0,
      fresh = -1;
    function recycle(): void {
      raced = true;
      registry.collectProcess(1);
      registry.registerProcess(2);
      fresh = registry.allocate(2);
    }
    Atomics.compareExchange = ((
      array: BigInt64Array,
      index: number,
      expected: bigint,
      replacement: bigint,
    ) => {
      const link =
        array instanceof BigInt64Array &&
        array.buffer === buffer &&
        array.byteOffset === 16 &&
        expected >> 32n === 1n &&
        (replacement & HEAD) !== 0n &&
        !(replacement & REVOKED);
      if (!raced && link && phase === "before-link") recycle();
      const value = compareExchange(array, index, expected, replacement);
      if (!raced && link && phase === "after-link") recycle();
      return value;
    }) as typeof Atomics.compareExchange;
    Atomics.load = ((array: BigInt64Array, index: number) => {
      const value = load(array, index);
      if (
        !raced &&
        array instanceof BigInt64Array &&
        array.buffer === buffer &&
        array.byteOffset === 16
      ) {
        ownerLoads++;
        if (phase === "after-final-check" && ownerLoads === 3) recycle();
      }
      return value;
    }) as typeof Atomics.load;
    try {
      if (phase === "after-final-check") expect(registry.allocate(1)).toBe(0);
      else expect(() => registry.allocate(1)).toThrow("revoked");
    } finally {
      Atomics.compareExchange = compareExchange;
      Atomics.load = load;
    }
    expect(raced).toBe(true);
    expect(registry.processCount).toBe(1);
    expect(registry.isRevoked(2)).toBe(false);
    expect(Atomics.load(registry.canonical(0), 0) & STOP).toBe(STOP);
    expect(Atomics.load(registry.canonical(fresh), 0) & STOP).toBe(0n);
    registry.collectProcess(2);
  });
}

for (const operation of ["revoke", "collectProcess"] as const) {
  test(`a delayed ${operation} cannot freeze or clear the new owner`, () => {
    const registry = new PipePublicationRegistry({
      processCapacity: 1,
      cellsPerProcess: 1,
      maxCells: 8,
    });
    registry.registerProcess(1);
    registry.allocate(1);
    const buffer = registry.handle().buffer,
      compareExchange = Atomics.compareExchange;
    let raced = false,
      fresh = -1;
    Atomics.compareExchange = ((
      array: BigInt64Array,
      index: number,
      expected: bigint,
      replacement: bigint,
    ) => {
      const owner =
        array instanceof BigInt64Array && array.buffer === buffer && array.byteOffset === 16;
      const point =
        owner && (operation === "revoke" ? (replacement & REVOKED) !== 0n : replacement === 0n);
      if (!raced && owner && point) {
        raced = true;
        registry.collectProcess(1);
        registry.registerProcess(2);
        fresh = registry.allocate(2);
      }
      return compareExchange(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    try {
      registry[operation](1);
    } finally {
      Atomics.compareExchange = compareExchange;
    }
    expect(raced).toBe(true);
    expect(registry.processCount).toBe(1);
    expect(registry.isRevoked(2)).toBe(false);
    expect(Atomics.load(registry.canonical(fresh), 0) & STOP).toBe(0n);
    registry.collectProcess(2);
  });
}

test("late attached worker startup cannot recreate an already collected enrollment", () => {
  const transport = createWorkerProcessTransport();
  const registry = new PipePublicationRegistry({ processCapacity: 1, cellsPerProcess: 1 });
  registry.registerProcess(transport.pid);
  const handle = structuredClone(registry.handle());
  registry.collectProcess(transport.pid);
  registry.registerProcess(2);
  expect(() => new WorkerPipeHost({ transport, registry: handle, postMessage() {} })).toThrow(
    "revoked",
  );
  expect(registry.processCount).toBe(1);
  expect(registry.isRevoked(2)).toBe(false);
  registry.collectProcess(2);
});

function message<T>(worker: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("pipe registry worker timed out")), 2000);
    const onMessage = (event: MessageEvent) => finish(undefined, event.data as T);
    const onError = (event: ErrorEvent) => finish(event.error ?? new Error(event.message));
    function finish(error?: unknown, value?: T): void {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve(value!);
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

test("a physically running worker paused at owner CAS loses to collection without touching its successor", async () => {
  const registry = new PipePublicationRegistry({
    processCapacity: 1,
    cellsPerProcess: 1,
    maxCells: 8,
  });
  registry.registerProcess(1);
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const module = new URL("./fixtures/pipes-intrinsics.ts", import.meta.url).href;
  const source = `import {isolatedPipes} from ${JSON.stringify(module)};
    const isolated = isolatedPipes(), Atomics = isolated.atomics;
    const {attachPipePublicationRegistry} = isolated.pipes;
    self.onmessage = ({data}) => {
      const registry = attachPipePublicationRegistry(data.registry), gate = data.gate;
      const cas = Atomics.compareExchange;
      let paused = false;
      Atomics.compareExchange = (array, index, expected, replacement) => {
        if (!paused && array instanceof BigInt64Array && array.byteOffset === 16 &&
            expected >> 32n === 1n && (replacement & 0x7fffffffn) !== 0n) {
          paused = true;
          self.postMessage("paused");
          Atomics.wait(gate, 0, 0);
        }
        return cas(array, index, expected, replacement);
      };
      try { registry.allocate(1); self.postMessage("unexpected allocation"); }
      catch (error) { self.postMessage(error.message); }
      finally { Atomics.compareExchange = cas; }
    };`;
  const worker = new Worker(new URL(`data:application/typescript,${encodeURIComponent(source)}`));
  try {
    const paused = message<string>(worker);
    worker.postMessage({ registry: structuredClone(registry.handle()), gate });
    expect(await paused).toBe("paused");
    registry.collectProcess(1);
    registry.registerProcess(2);
    const fresh = registry.allocate(2);
    const result = message<string>(worker);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    expect(await result).toBe("pipe process is revoked");
    expect(registry.processCount).toBe(1);
    expect(registry.isRevoked(2)).toBe(false);
    expect(Atomics.load(registry.canonical(0), 0) & STOP).toBe(STOP);
    expect(Atomics.load(registry.canonical(fresh), 0) & STOP).toBe(0n);
  } finally {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    await worker.terminate();
    registry.collectProcess(2);
  }
});
