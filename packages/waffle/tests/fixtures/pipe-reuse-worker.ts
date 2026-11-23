import type { PipeEndpointHandle } from "../../proc/pipes.js";
import { isolatedPipes } from "./pipes-intrinsics.ts";

const { pipes, atomics: A, hooks } = isolatedPipes();
const { attachPipeEndpoint } = pipes;
self.onmessage = ({
  data,
}: MessageEvent<{
  handle: PipeEndpointHandle;
  gate: Int32Array;
  operation: "pause" | "read" | "hold";
  /** For "hold": the pause point to stop at, holding whatever the operation holds there. */
  point?: string;
}>) => {
  const endpoint = attachPipeEndpoint(data.handle);
  if (data.operation === "hold") {
    let paused = false;
    hooks.pipePause = (point) => {
      if (paused || point !== data.point) return;
      paused = true;
      self.postMessage("paused");
      Atomics.wait(data.gate, 0, 0);
    };
    const bytes = new Uint8Array([66]);
    self.postMessage(
      data.handle.mode === "write" ? endpoint.tryWrite([bytes]) : endpoint.tryRead([bytes]),
    );
    return;
  }
  if (data.operation === "read") {
    self.postMessage("ready");
    const output = new Uint8Array(1);
    let count = 0;
    while (endpoint.read([output]) === 1) {
      if (output[0] !== 123) throw new Error("corrupt reused writer payload");
      Atomics.store(data.gate, 0, ++count);
      Atomics.notify(data.gate, 0);
    }
    self.postMessage(count);
    return;
  }
  const cas = A.compareExchange;
  let paused = false;
  A.compareExchange = ((array: BigInt64Array, index: number, old: bigint, next: bigint) => {
    if (!paused && array instanceof BigInt64Array && (old & (1n << 32n)) === 0n) {
      paused = true;
      self.postMessage("paused");
      Atomics.wait(data.gate, 0, 0);
    }
    return cas(array, index, old, next);
  }) as typeof A.compareExchange;
  try {
    self.postMessage(endpoint.tryWrite([new Uint8Array([66])]));
  } finally {
    A.compareExchange = cas;
  }
};
