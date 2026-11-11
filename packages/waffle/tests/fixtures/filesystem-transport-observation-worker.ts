self.onmessage = ({ data }: MessageEvent<SharedArrayBuffer>) => {
  Atomics.add(new Int32Array(data), 0, 1);
  self.postMessage({ type: "done" });
};
self.postMessage({ type: "ready" });
