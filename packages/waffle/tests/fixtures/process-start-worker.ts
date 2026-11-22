import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";
import { atomicsWait, atomicsWaitNative } from "../../proc/intrinsics/core.ts";

export interface ProcessStartWorkerRequest extends RuntimeWorkerRequest {
  readonly gates: SharedArrayBuffer;
}

globalThis.onmessage = ({ data }: MessageEvent<ProcessStartWorkerRequest>) => {
  const gates = new Int32Array(data.gates);
  const hold = (index: number) => {
    if (Atomics.wait(gates, index, 0, 30_000) === "timed-out")
      throw new Error(`start control gate ${index} timed out`);
  };
  void bootstrap(data, {
    resolveTerminal() {
      hold(0);
      return undefined;
    },
    imports(_imports, { wasi }) {
      if (wasi.descriptors.get(1)?.resource.kind !== "pipe")
        throw new Error("start control did not inherit stdout pipe");
      hold(1);
    },
    instantiate(imports) {
      hold(2);
      return new WebAssembly.Instance(data.module, imports);
    },
    instantiated({ instance }) {
      // What guest JavaScript in this realm would call (docs/webkit-blocking-waits.md).
      globalThis.postMessage({
        type: "realm-wait",
        installed: Atomics.wait === atomicsWait,
        cooperative: atomicsWait !== atomicsWaitNative,
      });
      globalThis.postMessage({ type: "stop-order-memory", memory: instance.exports.memory });
    },
    run: (_context, exited) => exited ?? 0,
  });
};
