import { expect, test } from "bun:test";
import { isolatedPipes } from "./fixtures/pipes-intrinsics.ts";

const byte = new Uint8Array([65]);
const { pipes, atomics } = isolatedPipes();
const { PipeController, PipePublicationRegistry, attachPipeEndpoint, PipeErrno } = pipes;

for (const phase of ["before", "after"] as const) {
  test(`a paused old payload CAS ${phase} revocation cannot mutate a reused writer`, () => {
    const pipe = new PipeController({ capacity: 8, maxWriters: 1, maxReaders: 1, relay: "manual" });
    const reader = pipe.retain(1, "read"),
      writer = pipe.retain(2, "write");
    const stale = attachPipeEndpoint(structuredClone(writer.handle()));
    const compare = atomics.compareExchange;
    let raced = false;
    atomics.compareExchange = ((
      array: BigInt64Array,
      index: number,
      expected: bigint,
      next: bigint,
    ) => {
      if (
        raced ||
        !(array instanceof BigInt64Array) ||
        array.length !== 2 ||
        (next & 0xffffffffn) !== 65n
      )
        return compare(array, index, expected, next);
      raced = true;
      const result = phase === "after" ? compare(array, index, expected, next) : undefined;
      pipe.revoke(2);
      const replacement = pipe.retain(3, "write");
      expect(replacement.tryWrite([new Uint8Array([90])])).toBe(1);
      const output = new Uint8Array(1);
      expect(reader.tryRead([output])).toBe(1);
      expect(output[0]).toBe(90);
      return phase === "after" ? result : compare(array, index, expected, next);
    }) as typeof atomics.compareExchange;
    try {
      expect(writer.tryWrite([byte])).toBe(-PipeErrno.BADF);
      expect(raced).toBe(true);
      expect(stale.tryWrite([byte])).toBe(-PipeErrno.BADF);
      stale.close();
      expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
      expect(pipe.resourceUsage.activeWriters).toBe(1);
    } finally {
      atomics.compareExchange = compare;
      pipe.dispose();
    }
  });
}

test("reader membership is reusable and queued delivery survives cancellation", () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 1, maxReaders: 1, relay: "manual" });
  let reader = pipe.retain(1, "read");
  const writer = pipe.retain(1, "write");
  const stale = attachPipeEndpoint(structuredClone(reader.handle()));
  try {
    for (let pid = 2; pid < 102; pid++) {
      reader.close();
      reader = pipe.retain(pid, "read");
      expect(writer.tryWrite([byte])).toBe(1);
      expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
      pipe.pumpRelay();
      pipe.revoke(pid);
      pipe.pumpRelay();
      const next = pipe.retain(pid + 1000, "read");
      expect(next.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
      pipe.pumpRelay();
      const output = new Uint8Array(1);
      expect(next.tryRead([output])).toBe(1);
      expect(output[0]).toBe(65);
      next.close();
    }
    expect(stale.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.BADF);
  } finally {
    pipe.dispose();
  }
});

test("registry-backed persistent slots retain constant backing after child collection", () => {
  const registry = new PipePublicationRegistry({
    processCapacity: 2,
    cellsPerProcess: 4,
    maxCells: 8,
  });
  registry.registerProcess(1);
  const pipe = new PipeController({
    capacity: 8,
    maxReaders: 1,
    maxWriters: 2,
    registry,
    relay: "manual",
  });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(1, "write");
  try {
    for (let pid = 2; pid < 3003; pid++) {
      registry.registerProcess(pid);
      const child = writer.forProcess(pid);
      expect(child.tryWrite([byte])).toBe(1);
      registry.collectProcess(pid);
      const output = new Uint8Array(1);
      expect(reader.tryRead([output])).toBe(1);
      expect(output[0]).toBe(65);
      expect(child.tryWrite([byte])).toBe(-PipeErrno.BADF);
      expect(registry.resourceUsage.allocatedCells).toBeLessThanOrEqual(6);
    }
    expect(registry.resourceUsage.backingBytes).toBe(160);
    console.log(
      JSON.stringify({ cycles: 3001, pipe: pipe.resourceUsage, registry: registry.resourceUsage }),
    );
  } finally {
    pipe.dispose();
  }
  expect(registry.resourceUsage.activeCells).toBe(0);
});

test("delayed same-pid close cannot decrement a replacement incarnation", () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 1, maxReaders: 1, relay: "manual" });
  const reader = pipe.retain(1, "read"),
    old = pipe.retain(2, "write");
  const compare = atomics.compareExchange;
  let replacement: typeof old | undefined,
    raced = false;
  atomics.compareExchange = ((
    array: BigInt64Array,
    index: number,
    expected: bigint,
    next: bigint,
  ) => {
    if (
      !raced &&
      array instanceof BigInt64Array &&
      array.byteOffset === 48 &&
      (expected & 0xffffffffn) === 1n &&
      next === expected - 1n
    ) {
      raced = true;
      pipe.revoke(2);
      pipe.retain(3, "write").close();
      replacement = pipe.retain(2, "write");
    }
    return compare(array, index, expected, next);
  }) as typeof atomics.compareExchange;
  try {
    old.close();
    expect(raced).toBe(true);
    expect(() => pipe.duplicate(old)).toThrow("closed");
    expect(replacement!.tryWrite([byte])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
  } finally {
    atomics.compareExchange = compare;
    pipe.dispose();
  }
});

test("an in-progress reservation cannot be stolen by another pid", () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 1, maxReaders: 1, relay: "manual" });
  const reader = pipe.retain(1, "read");
  const compare = atomics.compareExchange;
  let raced = false;
  atomics.compareExchange = ((
    array: BigInt64Array,
    index: number,
    expected: bigint,
    next: bigint,
  ) => {
    const result = compare(array, index, expected, next);
    if (!raced && array instanceof BigInt64Array && array.byteOffset === 48 && next & (1n << 32n)) {
      raced = true;
      expect(() => pipe.retain(3, "write")).toThrow("limit");
    }
    return result;
  }) as typeof atomics.compareExchange;
  try {
    const writer = pipe.retain(2, "write");
    expect(raced).toBe(true);
    expect(writer.tryWrite([byte])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
  } finally {
    atomics.compareExchange = compare;
    pipe.dispose();
  }
});

test("a retain paused after publication cannot borrow the replacement generation", () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 1, maxReaders: 1, relay: "manual" });
  const reader = pipe.retain(1, "read");
  const compare = atomics.compareExchange;
  let replacement: ReturnType<typeof pipe.retain> | undefined,
    raced = false;
  atomics.compareExchange = ((
    array: BigInt64Array,
    index: number,
    expected: bigint,
    next: bigint,
  ) => {
    const result = compare(array, index, expected, next);
    if (
      !raced &&
      array instanceof BigInt64Array &&
      array.byteOffset === 48 &&
      expected & (1n << 32n) &&
      !(next & (1n << 32n)) &&
      (next & 0xffffffffn) === 1n
    ) {
      raced = true;
      pipe.revoke(2);
      pipe.retain(3, "write").close();
      replacement = pipe.retain(2, "write");
    }
    return result;
  }) as typeof atomics.compareExchange;
  try {
    expect(() => pipe.retain(2, "write")).toThrow("closed");
    expect(raced).toBe(true);
    expect(replacement!.tryWrite([byte])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
  } finally {
    atomics.compareExchange = compare;
    pipe.dispose();
  }
});

test("capacity failure preserves existing participants and closed queued records", () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 1, maxReaders: 1, relay: "manual" });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(2, "write");
  try {
    expect(() => pipe.retain(3, "write")).toThrow("limit");
    expect(writer.tryWrite([byte])).toBe(1);
    writer.close();
    expect(() => pipe.retain(3, "write")).toThrow("limit");
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
    const replacement = pipe.retain(3, "write");
    expect(replacement.tryWrite([byte])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
  } finally {
    pipe.dispose();
  }
});

test("opaque transfer and inheritance retain description flags independently of slot reuse", () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 2, maxReaders: 1, relay: "manual" });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(1, "write");
  try {
    const attached = attachPipeEndpoint(structuredClone(writer.handle()));
    for (let pid = 2; pid < 102; pid++) {
      const child = writer.forProcess(pid),
        duplicate = pipe.duplicate(child);
      child.fdflags = pid;
      expect(writer.fdflags).toBe(pid);
      expect(attached.fdflags).toBe(pid);
      expect(duplicate.fdflags).toBe(pid);
      expect(reader.fdflags).toBe(0);
      child.close();
      duplicate.close();
    }
  } finally {
    pipe.dispose();
  }
});

function workerMessage<T>(worker: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("pipe worker proof timed out")), 5000);
    const message = (event: MessageEvent<T>) => finish(undefined, event.data);
    const error = (event: ErrorEvent) => finish(event.error ?? new Error(event.message));
    function finish(failure?: unknown, value?: T): void {
      clearTimeout(timer);
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", error);
      if (failure) reject(failure);
      else resolve(value!);
    }
    worker.addEventListener("message", message);
    worker.addEventListener("error", error);
  });
}

test("a pre-cloned blocked Worker reads 3001 reused writer incarnations and wakes on cancellation", async () => {
  const pipe = new PipeController({ maxWriters: 2, relay: "manual" });
  const reader = pipe.retain(1, "read"),
    parent = pipe.retain(1, "write");
  const module = new URL("../proc/pipes.ts", import.meta.url).href;
  const source = `import {attachPipeEndpoint} from ${JSON.stringify(module)};
    self.onmessage = ({data}) => {
      const reader = attachPipeEndpoint(data), output = new Uint8Array(1);
      self.postMessage("ready");
      for (;;) {
        const count = reader.read([output]);
        self.postMessage({count, byte: output[0]});
        if (count < 1) return;
      }
    };`;
  const worker = new Worker(new URL(`data:application/typescript,${encodeURIComponent(source)}`));
  try {
    const ready = workerMessage<string>(worker);
    worker.postMessage(structuredClone(reader.handle()));
    expect(await ready).toBe("ready");
    for (let pid = 2; pid < 3003; pid++) {
      const response = workerMessage<{ count: number; byte: number }>(worker);
      const child = parent.forProcess(pid);
      expect(child.tryWrite([byte])).toBe(1);
      child.close();
      expect(await response).toEqual({ count: 1, byte: 65 });
    }
    const cancelled = workerMessage<{ count: number }>(worker);
    reader.revoke();
    expect((await cancelled).count).toBe(-PipeErrno.BADF);
    console.log(JSON.stringify({ workerCycles: 3001, ...pipe.resourceUsage }));
  } finally {
    pipe.dispose();
    await worker.terminate();
  }
}, 20_000);

test("a physically paused Worker payload CAS cannot change a replacement writer", async () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 1, maxReaders: 1, relay: "manual" });
  const reader = pipe.retain(1, "read"),
    old = pipe.retain(2, "write");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const fixture = new URL("./fixtures/pipes-intrinsics.ts", import.meta.url).href;
  const source = `import {isolatedPipes} from ${JSON.stringify(fixture)};
    const {pipes, atomics} = isolatedPipes();
    self.onmessage = ({data}) => {
      const endpoint = pipes.attachPipeEndpoint(data.endpoint), compare = atomics.compareExchange;
      let paused = false;
      atomics.compareExchange = (array, index, expected, next) => {
        if (!paused && array instanceof BigInt64Array && array.length === 2 && (next & 0xffffffffn) === 65n) {
          paused = true; self.postMessage("paused"); Atomics.wait(data.gate, 0, 0);
        }
        return compare(array, index, expected, next);
      };
      self.postMessage(endpoint.tryWrite([new Uint8Array([65])]));
    };`;
  const worker = new Worker(new URL(`data:application/typescript,${encodeURIComponent(source)}`));
  try {
    const paused = workerMessage<string>(worker);
    worker.postMessage({ endpoint: structuredClone(old.handle()), gate });
    expect(await paused).toBe("paused");
    pipe.revoke(2);
    const replacement = pipe.retain(3, "write");
    expect(replacement.tryWrite([new Uint8Array([90])])).toBe(1);
    const result = workerMessage<number>(worker);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    expect(await result).toBe(-PipeErrno.BADF);
    const output = new Uint8Array(1);
    expect(reader.tryRead([output])).toBe(1);
    expect(output[0]).toBe(90);
  } finally {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    await worker.terminate();
    pipe.dispose();
  }
});

test("reusing a closed writer slot cannot expose EOF while its reservation is unpublished", () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 2, maxReaders: 1, relay: "manual" });
  const reader = pipe.retain(1, "read"),
    parent = pipe.retain(1, "write");
  pipe.retain(2, "write").close();
  const compare = atomics.compareExchange;
  let raced = false;
  atomics.compareExchange = ((
    array: BigInt64Array,
    index: number,
    expected: bigint,
    next: bigint,
  ) => {
    const result = compare(array, index, expected, next);
    if (
      !raced &&
      array instanceof BigInt64Array &&
      !!(next & (1n << 32n)) &&
      (next & 0xffffffffn) === 4n
    ) {
      raced = true;
      parent.close();
      expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
    }
    return result;
  }) as typeof atomics.compareExchange;
  try {
    const child = parent.forProcess(4);
    expect(raced).toBe(true);
    expect(child.tryWrite([byte])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
  } finally {
    atomics.compareExchange = compare;
    pipe.dispose();
  }
});

test("a delayed relay destination write cannot publish into its replacement reader", () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 1, maxReaders: 1, relay: "manual" });
  const initial = pipe.retain(1, "read"),
    writer = pipe.retain(1, "write");
  initial.close();
  const reader = pipe.retain(2, "read");
  expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  expect(writer.tryWrite([byte])).toBe(1);
  const compare = atomics.compareExchange;
  let replacement: typeof reader | undefined,
    raced = false;
  atomics.compareExchange = ((
    array: BigInt64Array,
    index: number,
    expected: bigint,
    next: bigint,
  ) => {
    if (
      !raced &&
      array instanceof BigInt64Array &&
      array.byteOffset === 368 &&
      (next & 0xffffffffn) === 65n
    ) {
      raced = true;
      pipe.revoke(2);
      replacement = pipe.retain(3, "read");
      expect(replacement.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
    }
    return compare(array, index, expected, next);
  }) as typeof atomics.compareExchange;
  try {
    pipe.pumpRelay();
    expect(raced).toBe(true);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.BADF);
    const output = new Uint8Array(1);
    expect(replacement!.tryRead([output])).toBe(1);
    expect(output[0]).toBe(65);
    expect(writer.tryWrite([new Uint8Array([90])])).toBe(1);
    expect(replacement!.tryRead([output])).toBe(-PipeErrno.AGAIN);
    pipe.pumpRelay();
    expect(replacement!.tryRead([output])).toBe(1);
    expect(output[0]).toBe(90);
  } finally {
    atomics.compareExchange = compare;
    pipe.dispose();
  }
});
