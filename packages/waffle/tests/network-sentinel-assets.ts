export const sentinelAssets = {
  "/foreign.html": new Blob(["<!doctype html><title>Foreign root sentinel</title>"], {
    type: "text/html",
  }),
  "/sentinel-sw.js": `const identity=crypto.randomUUID(); self.addEventListener('install',e=>e.waitUntil(self.skipWaiting())); self.addEventListener('activate',e=>e.waitUntil(self.clients.claim())); self.addEventListener('message',e=>e.ports[0]?.postMessage(identity));`,
};
