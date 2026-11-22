import type { PipeEndpointHandle } from "../../proc/pipes.js";
import { isolatedPipes } from "./pipes-intrinsics.ts";

const { pipes, atomics: A } = isolatedPipes();
const { attachPipeEndpoint, PipeErrno } = pipes;

/** Read once, then stop for good right after the consuming CAS commits, before the reader
 * returns the pages it passed. The test terminates this Worker inside that window. */
self.onmessage = ({
  data,
}: MessageEvent<{ handle: PipeEndpointHandle; gate: Int32Array; consumed: number }>) => {
  const endpoint = attachPipeEndpoint(data.handle);
  const cas = A.compareExchange;
  A.compareExchange = ((array: BigInt64Array, index: number, old: bigint, next: bigint) => {
    const previous = cas(array, index, old, next);
    if (
      array.byteOffset === data.consumed &&
      array.buffer === data.handle.buffer &&
      previous === old
    ) {
      self.postMessage("consumed");
      Atomics.wait(data.gate, 0, 0);
    }
    return previous;
  }) as typeof A.compareExchange;
  const output = new Uint8Array(65536);
  self.postMessage("ready");
  for (;;) {
    const observed = Atomics.load(endpoint.notification, 0);
    const count = endpoint.tryRead([output]);
    if (count !== -PipeErrno.AGAIN) break;
    Atomics.wait(endpoint.notification, 0, observed, 100);
  }
};
