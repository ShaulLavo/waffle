import { nodeWorkerTransfers } from "./node-worker-transfers.js";
// Embedding transport only. Execute the shipped generic entry and its unchanged executor.
import { parentPort } from "node:worker_threads";
import type { RuntimeWorkerRequest, RuntimeWorkerMessage } from "../../browser/worker.js";
const scope = globalThis as unknown as {
  crossOriginIsolated: boolean;
  postMessage(message: RuntimeWorkerMessage, transfer?: Transferable[]): void;
  onmessage(event: MessageEvent<RuntimeWorkerRequest>): Promise<void>;
};
scope.crossOriginIsolated = true;
scope.postMessage = (message, transfer) =>
  parentPort!.postMessage(message, nodeWorkerTransfers(transfer));
await import("../../browser/preview1-worker.js");
parentPort!.on("message", (data) => {
  void scope.onmessage({ data } as MessageEvent<RuntimeWorkerRequest>);
});
