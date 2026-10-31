import { expect, test } from "bun:test";
import { measureSharedMemory } from "../memory/reservations.js";

test("real measurement is memoized and its probe worker terminates before the result", async () => {
  const NativeWorker = globalThis.Worker;
  let created = 0,
    terminated = 0;
  class ObservedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      created++;
    }
    terminate() {
      terminated++;
      return super.terminate();
    }
  }
  globalThis.Worker = ObservedWorker;
  try {
    const first = measureSharedMemory({
      workerURL: new URL("../memory/probe-worker.ts", import.meta.url),
    });
    const second = measureSharedMemory({
      workerURL: new URL("../memory/probe-worker.ts", import.meta.url),
    });
    expect(second).toBe(first);
    const platform = await first;
    expect(platform.source).toBe("measured");
    expect(["bounded", "unbounded"]).toContain(platform.kind);
    expect(created).toBe(1);
    expect(terminated).toBe(1);
  } finally {
    globalThis.Worker = NativeWorker;
  }
});
