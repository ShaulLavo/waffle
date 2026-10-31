import { expect, test } from "bun:test";
import { bytes, measureSharedMemory, type SharedMemoryPlatform } from "../memory/reservations.js";

async function observedProbe(
  workerURL: URL,
  check: (pending: Promise<SharedMemoryPlatform>) => Promise<void>,
): Promise<void> {
  const NativeWorker = globalThis.Worker;
  const owned: { worker: Worker; stopped: Promise<void> }[] = [];
  globalThis.Worker = new Proxy(NativeWorker, {
    construct() {
      const worker = new NativeWorker(workerURL, { type: "module" });
      const stopped = new Promise<void>((resolve) => {
        worker.addEventListener("close", () => resolve(), { once: true });
      });
      owned.push({ worker, stopped });
      return worker;
    },
  });
  try {
    await check(measureSharedMemory({ workerURL, remeasure: true }));
    expect(owned).toHaveLength(1);
    expect(owned[0]!.worker.onmessage).toBeNull();
    expect(owned[0]!.worker.onerror).toBeNull();
  } finally {
    globalThis.Worker = NativeWorker;
    await Promise.all(
      owned.map(({ worker, stopped }) => {
        worker.terminate();
        return stopped;
      }),
    );
  }
}

test("successful memory measurement releases probe message and error handlers", async () => {
  await observedProbe(
    new URL("./fixtures/memory-probe-result-worker.ts", import.meta.url),
    async (pending) => {
      expect(await pending).toEqual({
        kind: "bounded",
        source: "measured",
        budgetBytes: bytes(768 * 1024 ** 2),
        counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
      });
    },
  );
});

test("invalid memory measurement releases probe message and error handlers", async () => {
  await observedProbe(
    new URL("./fixtures/memory-probe-invalid-worker.ts", import.meta.url),
    async (pending) => {
      await expect(pending).rejects.toThrow("Invalid shared-memory probe capacity");
    },
  );
});

test("failed memory measurement releases probe message and error handlers", async () => {
  await observedProbe(
    new URL("./fixtures/memory-probe-error-worker.ts", import.meta.url),
    async (pending) => {
      await expect(pending).rejects.toThrow("probe lifecycle failure");
    },
  );
});
