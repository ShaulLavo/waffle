import { attachPtyEndpoint, type PtyEndpointHandle } from "../../proc/pty.js";

self.onmessage = ({
  data,
}: MessageEvent<{ readonly handle: PtyEndpointHandle; readonly iterations: number }>) => {
  const endpoint = attachPtyEndpoint(data.handle);
  try {
    for (let i = 1; i <= data.iterations; i++) {
      endpoint.resize(80 + (i % 500), 24 + (i % 200));
    }
    self.postMessage({ done: true });
  } finally {
    endpoint.close();
  }
};
