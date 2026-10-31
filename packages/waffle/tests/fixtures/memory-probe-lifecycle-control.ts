import { expect } from "bun:test";
import { bytes, measureSharedMemory, PROBE_CEILING_BYTES } from "../../memory/reservations.js";

const workerURL = new URL(process.argv[2]!, import.meta.url);
const NativeWorker = globalThis.Worker;
const owned: { worker: Worker; stopped: Promise<void> }[] = [];
globalThis.Worker = new Proxy(NativeWorker, {
  construct() {
    const worker = new NativeWorker(workerURL, { type: "module" });
    const stopped = new Promise<void>((resolve) =>
      worker.addEventListener("close", () => resolve(), { once: true }),
    );
    owned.push({ worker, stopped });
    return worker;
  },
});
try {
  const pending = measureSharedMemory({ workerURL });
  if (process.argv[3] === "success")
    expect(await pending).toEqual({
      kind: "unbounded",
      source: "measured",
      probedBytes: bytes(PROBE_CEILING_BYTES),
    });
  else await expect(pending).rejects.toThrow(process.argv[3]);
  expect(measureSharedMemory()).toBe(pending);
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
