import { expect } from "bun:test";
import * as memory from "../../memory/reservations.js";

const payload: unknown = JSON.parse(process.argv[2]!);
const NativeWorker = globalThis.Worker;
let created = 0;
let terminated = 0;
let delivered: Worker | undefined;
globalThis.Worker = new Proxy(NativeWorker, {
  construct() {
    created++;
    const worker = {
      onmessage: null as Worker["onmessage"],
      onerror: null as Worker["onerror"],
      postMessage() {
        queueMicrotask(() => {
          const handler = worker.onmessage;
          if (handler)
            Reflect.apply(handler, delivered, [new MessageEvent("message", { data: payload })]);
        });
      },
      terminate() {
        terminated++;
      },
    };
    delivered = worker as unknown as Worker;
    return worker;
  },
});
try {
  const first = memory.measureSharedMemory();
  const second = memory.measureSharedMemory();
  expect(second).toBe(first);
  const outcome = process.argv[3];
  if (outcome === "unbounded") {
    const platform = await first;
    expect(platform).toEqual({
      kind: "unbounded",
      source: "measured",
      probedBytes: memory.bytes(memory.PROBE_CEILING_BYTES),
    });
  } else if (outcome === "invalid") {
    await expect(first).rejects.toBeInstanceOf(TypeError);
  } else {
    const error: unknown = await first.then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(memory.SharedMemoryMeasurementError);
    if (!(error instanceof memory.SharedMemoryMeasurementError))
      throw new Error("missing typed refusal");
    expect(error.observation).toEqual(JSON.parse(outcome!));
  }
  expect(memory.measureSharedMemory()).toBe(first);
  expect(created).toBe(1);
  expect(terminated).toBe(1);
  expect(delivered?.onmessage).toBeNull();
  expect(delivered?.onerror).toBeNull();
} finally {
  globalThis.Worker = NativeWorker;
}
