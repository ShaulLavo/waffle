import { expect, test } from "bun:test";
import {
  attachPipeController,
  attachPipeEndpoint,
  PipeController,
  PipeEndpoint,
  PipePublicationRegistry,
} from "../proc/pipes.js";
import { WorkerPipeHost } from "../proc/worker-pipes.js";
import { createWorkerProcessTransport } from "../proc/worker-client.js";

function allocator() {
  const calls: number[] = [];
  return {
    calls,
    allocateShared(length: number) {
      calls.push(length);
      return new SharedArrayBuffer(length);
    },
  };
}

test("fixed pipe, local wake and endpoint controls charge exact allocations", () => {
  const allocation = allocator();
  const pipe = new PipeController({
    capacity: 8,
    maxWriters: 2,
    maxReaders: 1,
    relay: "manual",
    allocateShared: allocation.allocateShared,
  });
  try {
    expect(allocation.calls).toEqual([4, 568]);
    const reader = pipe.retain(1, "read"),
      writer = pipe.retain(2, "write");
    expect(allocation.calls).toEqual([4, 568, 4, 4, 4, 4]);
    const alias = pipe.duplicate(writer),
      child = writer.forProcess(3);
    expect(allocation.calls).toEqual([4, 568, 4, 4, 4, 4, 4, 4]);
    expect(alias.handle().fdflags).toBe(writer.handle().fdflags);
    expect(child.handle().fdflags).toBe(writer.handle().fdflags);
    expect(writer.tryWrite([new Uint8Array([9])])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
    expect(Object.values(writer.handle()).some((value) => typeof value === "function")).toBe(false);
    expect(structuredClone(writer.handle()).incarnation).toBe(0);
  } finally {
    pipe.dispose();
  }
});

test("attached backings are not charged twice and new controls use the receiving allocator", () => {
  const pipe = new PipeController({ capacity: 8, maxWriters: 2, relay: "manual" });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(2, "write");
  const allocation = allocator();
  const handle = structuredClone(writer.handle());
  const endpoint = attachPipeEndpoint(handle, allocation);
  const attached = attachPipeController(handle, { ...allocation, relay: "manual" });
  try {
    expect(allocation.calls).toEqual([]);
    const child = endpoint.forProcess(3);
    expect(allocation.calls).toEqual([4]);
    const alias = attached.duplicate(endpoint);
    expect(allocation.calls).toEqual([4, 4]);
    expect(child.tryWrite([new Uint8Array([9])])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
    alias.close();
    child.close();
  } finally {
    attached.dispose();
    pipe.dispose();
  }
});

test("fixed backing allocation failure propagates before creating a pipe", () => {
  const failure = new Error("pipe backing denied");
  const calls: number[] = [];
  expect(
    () =>
      new PipeController({
        capacity: 8,
        maxWriters: 2,
        maxReaders: 1,
        wake: new Int32Array(new SharedArrayBuffer(4)),
        relay: "manual",
        allocateShared(length) {
          calls.push(length);
          throw failure;
        },
      }),
  ).toThrow(failure);
  expect(calls).toEqual([568]);
});

for (const failAt of [2, 3]) {
  test(`endpoint control allocation ${failAt} failure creates no reservation`, () => {
    const failure = new Error("endpoint control denied");
    let count = 0,
      fail = true;
    const pipe = new PipeController({
      capacity: 8,
      maxWriters: 2,
      maxReaders: 1,
      wake: new Int32Array(new SharedArrayBuffer(4)),
      relay: "manual",
      allocateShared(length) {
        if (++count === failAt && fail) throw failure;
        return new SharedArrayBuffer(length);
      },
    });
    try {
      expect(() => pipe.retain(1, "read")).toThrow(failure);
      fail = false;
      const reader = pipe.retain(1, "read");
      expect(reader.handle().incarnation).toBe(0);
      expect(Atomics.load(new Int32Array(reader.handle().buffer, 40 + 2 * 176 + 4, 1), 0)).toBe(1);
    } finally {
      pipe.dispose();
    }
  });
}

test("worker host and imported codec endpoints retain their realm-local allocator", () => {
  const registry = new PipePublicationRegistry();
  registry.registerProcess(1);
  registry.registerProcess(2);
  const allocation = allocator();
  let announced: unknown;
  const host = new WorkerPipeHost({
    transport: createWorkerProcessTransport(),
    registry,
    allocateShared: allocation.allocateShared,
    pipe: { capacity: 8, maxWriters: 2, maxReaders: 1 },
    postMessage(message) {
      if (message.operation === "pipe") announced = structuredClone(message.handle);
    },
  });
  const pair = host.createPipe();
  if (!announced) throw new Error("pipe was not announced");
  const controller = attachPipeController(pair[0].handle(), { relay: "manual" });
  try {
    expect(allocation.calls).toEqual([568, 4, 4, 4, 4]);
    expect(announced).toEqual(structuredClone(pair[0].handle()));
    const codec = host.codec();
    const imported = codec.import({ kind: "pipe", endpoint: structuredClone(pair[1].handle()) }, 1);
    expect(allocation.calls).toEqual([568, 4, 4, 4, 4]);
    expect(imported.resource).toBeInstanceOf(PipeEndpoint);
    if (!(imported.resource instanceof PipeEndpoint)) throw new Error("missing imported pipe");
    imported.resource.forProcess(2).close();
    expect(allocation.calls).toEqual([568, 4, 4, 4, 4, 4]);
  } finally {
    registry.collectProcess(1);
    registry.collectProcess(2);
    controller.dispose();
  }
});
