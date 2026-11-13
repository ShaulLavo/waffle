import { Worker as NodeWorker } from "node:worker_threads";
import { nodeWorkerTransfers } from "./node-worker-transfers.js";

export function installExecNodeWorkers(): () => void {
  const previous = globalThis.Worker;
  class HostWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string; error: Error; preventDefault(): void }) => void) | null =
      null;
    readonly native: NodeWorker;
    stopping?: Promise<void>;
    constructor(url: string | URL) {
      this.native = new NodeWorker(typeof url === "string" ? new URL(url) : url);
      this.native.on("message", (data) => this.onmessage?.({ data }));
      this.native.on("error", (error) => {
        const fault = error instanceof Error ? error : new Error(String(error));
        this.onerror?.({ message: fault.message, error: fault, preventDefault() {} });
      });
    }
    postMessage(message: unknown, transfer?: Transferable[]) {
      this.native.postMessage(message, nodeWorkerTransfers(transfer));
    }
    terminate(): Promise<void> {
      return (this.stopping ??= this.native.terminate().then(() => {}));
    }
  }
  globalThis.Worker = HostWorker as unknown as typeof Worker;
  return () => {
    globalThis.Worker = previous;
  };
}
