import { bootstrap, preview1Executor, type RuntimeWorkerRequest } from "./worker";

// Dedicated entry point: its entire import graph belongs to the reusable runtime.
const context = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void>;
};
context.onmessage = event => bootstrap(event.data, preview1Executor);
