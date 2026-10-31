import { parentPort } from "node:worker_threads";
import { nodeWorkerTransfers } from "./node-worker-transfers.js";
import {
  bootstrap,
  preview1Executor,
  type RuntimeWorkerRequest,
  type RuntimeWorkerMessage,
} from "../../browser/worker.js";

let instance: WebAssembly.Instance | undefined;
let done: (() => void) | undefined;
function memory(): WebAssembly.Memory {
  const value = instance?.exports.memory;
  if (!(value instanceof WebAssembly.Memory)) throw Error("socket fixture has no memory");
  return value;
}
parentPort!.on("message", (message) => {
  if (message.request) {
    const request: RuntimeWorkerRequest = message.request;
    void bootstrap(
      request,
      message.interactive
        ? {
            hostCallFd: 0x7ffffffe,
            imports(imports, { wasi }) {
              wasi.hostCall = (slot, args) => slot + args.reduce((n, value) => n + value, 0);
              return imports;
            },
            async run(context) {
              instance = context.instance;
              parentPort!.postMessage({ type: "ready" });
              await new Promise<void>((resolve) => {
                done = resolve;
              });
              return 0;
            },
          }
        : preview1Executor,
      {
        crossOriginIsolated: true,
        postMessage(data: RuntimeWorkerMessage, transfer?: Transferable[]) {
          parentPort!.postMessage(data, nodeWorkerTransfers(transfer));
        },
      },
    );
    return;
  }
  if (message.op === "finish") {
    done?.();
    return;
  }
  try {
    let value: unknown;
    if (message.op === "write") new Uint8Array(memory().buffer).set(message.bytes, message.at);
    if (message.op === "read")
      value = new Uint8Array(memory().buffer, message.at, message.length).slice();
    if (message.op === "call") {
      const call = instance?.exports[message.name];
      if (typeof call !== "function") throw Error("missing fixture export");
      value = call(...message.args);
    }
    parentPort!.postMessage({ type: "result", id: message.id, value });
  } catch (error) {
    parentPort!.postMessage({ type: "result", id: message.id, error: String(error) });
  }
});
