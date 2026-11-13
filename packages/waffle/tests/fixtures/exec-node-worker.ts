import { parentPort } from "node:worker_threads";
import { nodeWorkerTransfers } from "./node-worker-transfers.js";
import { runExecWorker } from "./exec-worker.js";

parentPort!.on("message", (data) => {
  void runExecWorker(data, {
    crossOriginIsolated: true,
    postMessage: (message, transfer) =>
      parentPort!.postMessage(message, nodeWorkerTransfers(transfer)),
  });
});
