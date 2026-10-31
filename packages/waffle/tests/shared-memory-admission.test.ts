import { expect, test } from "bun:test";
import {
  createRuntime,
  bytes,
  pages,
  declareSharedMemoryPlatform,
  SharedMemoryAdmissionError,
} from "../index.js";

test("runtime rejects an absent platform before filesystem/worker construction", () => {
  const previous = globalThis.Worker;
  let workers = 0;
  class ObservedWorker {
    constructor() {
      workers++;
      throw new Error("unexpected worker");
    }
  }
  globalThis.Worker = ObservedWorker as unknown as typeof Worker;
  try {
    // Deliberate external-boundary misuse, never an old-shape compatibility overload.
    expect(() => Reflect.apply(createRuntime, undefined, [{}])).toThrow(/Measure|declare/);
    expect(workers).toBe(0);
  } finally {
    globalThis.Worker = previous;
  }
});

test("budget is checked on actual runtime filesystem root before creating its worker", () => {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(1),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  expect(() => createRuntime({ sharedMemory: platform })).toThrow(SharedMemoryAdmissionError);
  expect(Number(pages(2))).toBe(2);
});
