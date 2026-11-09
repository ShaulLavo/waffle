import type { RuntimeWorkerRequest } from "./worker.js";

// Keep the executable entry out of shared chunks: launch URLs can carry a fragment.
const context = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void>;
};
context.onmessage = async (event) => {
  const { bootstrap, preview1Executor } = await import("./worker.js");
  await bootstrap(event.data, preview1Executor);
};
