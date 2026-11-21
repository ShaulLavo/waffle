import type { ObservedPreview1Bootstrap } from "../../browser/operations/protocol.js";
import type { RuntimeWorkerMessage, RuntimeWorkerRequest } from "../../browser/worker.js";
import { poisonProcessIntrinsics } from "./process-intrinsics.js";

const nativePost = globalThis.postMessage.bind(globalThis);
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest | ObservedPreview1Bootstrap>) => void;
  postMessage: (message: RuntimeWorkerMessage, transfer?: Transferable[]) => void;
};
let buffers: SharedArrayBuffer[] = [];
let audit: ReturnType<typeof poisonProcessIntrinsics> | undefined;
scope.postMessage = (message, transfer) => {
  if (message.type === "phase" && message.name === "instantiate")
    audit = poisonProcessIntrinsics(buffers);
  if (audit && (message.type === "exit" || message.type === "error")) {
    nativePost({ type: "operation-authority-audit", report: audit.restore() });
    audit = undefined;
  }
  if (transfer) nativePost(message, transfer);
  else nativePost(message);
};
scope.onmessage = async ({ data }) => {
  const { bootstrapObservedPreview1 } = await import("../../browser/worker.js");
  if (!Array.isArray(data)) throw new Error("Expected the broker-owned observation envelope");
  const request = data[0];
  if (!request.runtimeProcess) throw new Error("Missing bound process transport");
  buffers = [data[1].buffer, request.runtimeProcess.directory, request.runtimeProcess.identity];
  await bootstrapObservedPreview1(data);
};
