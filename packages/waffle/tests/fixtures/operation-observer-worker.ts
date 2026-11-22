import type { ObservedPreview1Bootstrap } from "../../browser/operations/protocol.js";
import type { RuntimeWorkerMessage, RuntimeWorkerRequest } from "../../browser/worker.js";
import { poisonProcessIntrinsics } from "./process-intrinsics.js";

const nativePost = globalThis.postMessage.bind(globalThis);
const nativeApply = Reflect.apply;
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest | ObservedPreview1Bootstrap>) => void;
  postMessage: (message: RuntimeWorkerMessage, transfer?: Transferable[]) => void;
};
let buffers: SharedArrayBuffer[] = [];
let audit: ReturnType<typeof poisonProcessIntrinsics> | undefined;
scope.postMessage = (message, transfer) => {
  if (buffers.length && message.type === "phase" && message.name === "instantiate")
    audit = poisonProcessIntrinsics(buffers);
  if (audit && (message.type === "exit" || message.type === "error")) {
    nativePost({ type: "operation-authority-audit", report: audit.restore() });
    audit = undefined;
  }
  if (transfer) nativePost(message, transfer);
  else nativePost(message);
};
scope.onmessage = async ({ data }) => {
  const { bootstrap, bootstrapObservedPreview1, preview1Executor } =
    await import("../../browser/worker.js");
  const { FilesystemClient } = await import("../../fs/client.js");
  const resolve = FilesystemClient.prototype.resolve;
  FilesystemClient.prototype.resolve = function (...args) {
    const value = nativeApply(resolve, this, args);
    if (typeof value === "number") nativePost({ type: "operation-errno-audit", errno: value });
    return value;
  };
  if (!Array.isArray(data)) {
    await bootstrap(data, preview1Executor);
    return;
  }
  const request = data[0];
  if (!request.runtimeProcess) throw new Error("Missing bound process transport");
  buffers = [data[1].buffer, request.runtimeProcess.directory, request.runtimeProcess.identity];
  await bootstrapObservedPreview1(data);
};
