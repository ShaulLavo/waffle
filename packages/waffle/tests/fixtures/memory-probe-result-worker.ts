export {};
self.onmessage = () =>
  self.postMessage({
    growableBytes: 1024 ** 3,
    ceilingReached: false,
    counts: { "fixed-buffer": true, "shared-memory": true, "private-memory": false },
  });
