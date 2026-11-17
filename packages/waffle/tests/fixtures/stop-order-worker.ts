import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";

// The plain bootstrap, plus the guest's shared memory for the page to watch its heartbeat.
globalThis.onmessage = ({ data }: MessageEvent<RuntimeWorkerRequest>) => {
  void bootstrap(data, {
    instantiated({ instance }) {
      globalThis.postMessage({ type: "stop-order-memory", memory: instance.exports.memory });
    },
    run: (_context, exited) => exited ?? 0,
  });
};
