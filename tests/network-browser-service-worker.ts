/// <reference lib="webworker" />
import { createPreviewServiceWorker } from "../browser/service-worker.js";

declare const self: ServiceWorkerGlobalScope;
export function installNetworkServiceWorker(): void {
  const preview = createPreviewServiceWorker({
    scope: new URL("/_net/", self.location.origin).href,
    clients: self.clients,
    fetch: (request) => fetch(request),
  });
  self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (event) => {
    const response = preview.fetch(event.request, event.clientId);
    if (response) event.respondWith(response);
  });
}
if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope)
  installNetworkServiceWorker();
