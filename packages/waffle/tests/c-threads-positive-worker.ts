self.onmessage = ({ data }: MessageEvent<{ shared: SharedArrayBuffer; nonce: string }>) => {
  const cells = new Int32Array(data.shared);
  Atomics.store(cells, 0, 42);
  self.postMessage({ nonce: data.nonce, atomic: Atomics.load(cells, 0) });
};
