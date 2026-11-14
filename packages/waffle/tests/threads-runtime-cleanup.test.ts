import { expect, test } from "bun:test";
import { cleanupThreadRuntime } from "./threads-runtime-cleanup.js";

test("teardown restores the Worker and releases its observer after cleanup failures", async () => {
  const NativeWorker = globalThis.Worker;
  let retained: WebAssembly.Memory | undefined = new WebAssembly.Memory({ initial: 1 });
  const events: string[] = [];
  globalThis.Worker = class extends NativeWorker {};
  try {
    await expect(
      cleanupThreadRuntime({
        release: [
          () => {
            events.push("release");
            throw new Error("release failed");
          },
          () => {
            events.push("descriptors");
          },
        ],
        dispose: async () => {
          events.push("dispose");
          throw new Error("dispose failed");
        },
        workers: [
          {
            terminate() {
              events.push("first worker");
              throw new Error("worker failed");
            },
          },
          {
            terminate() {
              events.push("second worker");
            },
          },
        ],
        restore: () => {
          retained = undefined;
          globalThis.Worker = NativeWorker;
          events.push("restore");
        },
      }),
    ).rejects.toThrow("Runtime thread cleanup failed");
    expect(events).toEqual([
      "release",
      "descriptors",
      "dispose",
      "first worker",
      "second worker",
      "restore",
    ]);
    expect(retained).toBeUndefined();
    expect(globalThis.Worker).toBe(NativeWorker);
  } finally {
    globalThis.Worker = NativeWorker;
  }
});
