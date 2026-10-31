export {};
self.onmessage = () =>
  self.postMessage({ reachedBytes: -1, chunkBytes: 1024 ** 3, ceilingReached: false });
