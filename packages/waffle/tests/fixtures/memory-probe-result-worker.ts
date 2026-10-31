export {};
self.onmessage = () =>
  self.postMessage({
    reachedBytes: 16 * 1024 ** 3,
    chunkBytes: 8 * 1024 ** 3,
    ceilingReached: true,
  });
