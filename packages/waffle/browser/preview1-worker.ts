import type { RuntimeWorkerRequest } from "./worker.js";
import type { ObservedPreview1Bootstrap } from "./operations/protocol.js";

// Keep the executable entry out of shared chunks: launch URLs can carry a fragment.
const context = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<RuntimeWorkerRequest | ObservedPreview1Bootstrap>,
  ) => Promise<void>;
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
  if (Array.isArray(event.data)) {
    await implementation.bootstrapObservedPreview1(event.data);
    return;
  }
  await implementation.bootstrap(event.data, implementation.preview1Executor);
};
