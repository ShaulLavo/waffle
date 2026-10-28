import { MessagePort, type Transferable } from "node:worker_threads";

/** This embedding transfers only filesystem/notification ports and output byte buffers. */
export function nodeWorkerTransfers(
  values: readonly globalThis.Transferable[] = [],
): Transferable[] {
  return values.map((value) => {
    if (value instanceof MessagePort || value instanceof ArrayBuffer) return value;
    throw new TypeError("unsupported Node Worker fixture transfer");
  });
}
