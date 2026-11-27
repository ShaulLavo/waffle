import { attachPtyEndpoint, type PtyEndpointHandle } from "../../proc/pty.js";

function waitForGate(gate: Int32Array): void {
  while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0);
}

self.onmessage = ({
  data,
}: MessageEvent<{
  readonly handle: PtyEndpointHandle;
  readonly iterations: number;
  readonly checkpoint: SharedArrayBuffer;
  readonly checkpointSeq: number;
}>) => {
  const endpoint = attachPtyEndpoint(data.handle);
  const gate = new Int32Array(data.checkpoint);
  try {
    for (let i = 1; i <= data.iterations; i++) {
      endpoint.resize(80 + (i % 500), 24 + (i % 200));
      if (i === data.checkpointSeq) waitForGate(gate);
    }
    self.postMessage({ done: true });
  } finally {
    endpoint.close();
  }
};
