import type { RuntimeWorkerRequest } from "./worker.js";

// Keep the executable entry out of shared chunks: launch URLs can carry a fragment.
const context = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void>;
};
context.onmessage = async (event) => {
  let implementation: typeof import("./worker.js");
  try {
    implementation = await import("./worker.js");
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
    return;
  }
  await implementation.bootstrap(event.data, implementation.preview1Executor);
};
