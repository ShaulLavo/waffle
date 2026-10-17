// Service worker for Bun.serve previews and the browser engine's ES modules. The page registers it
// twice, never over itself (its COOP/COEP headers stay untouched):
//
// Scope `<app>/__bunwasm/` controls the bun workers started from `<app>/__bunwasm/worker.js`. The
// worker puts modules needing a named URL into Cache Storage under
// `<app>/__bunwasm/m/<run>/<key>`, so import cycles link natively (engine-host.js).
// Acyclic modules use blob URLs. Other paths under the scope are the app's own files.
//
// Scope `<app>/__preview/` controls only preview tabs:
// A request for `<app>/__preview/<port>/<path>` is forwarded to the playground window running a
// guest server on <port> (see preview.ts), which turns it into an HTTP/1.1 connection for bun.wasm
// and streams the parsed response back here. Root-relative requests made by a preview page (e.g.
// `/style.css`) go to the same port.

import { createPreviewServiceWorker } from "@bun-wasm/runtime/browser/service-worker";

const sw = self as unknown as ServiceWorkerGlobalScope;
const prefix = new URL(sw.registration.scope).pathname;
declare const __PREVIEW_SOCKET_SCRIPT__: string;
const SOCKET_SCRIPT_PATH = new URL("../preview-websocket.js", sw.registration.scope).pathname;
const MODULES = prefix.endsWith("/__bunwasm/");

const previews = createPreviewServiceWorker({
  scope: sw.registration.scope,
  clients: sw.clients,
  fetch: request => fetch(request),
  transformResponse(response, port) {
    const html = response.headers.get("content-type")?.toLowerCase().includes("text/html") && !response.headers.get("content-encoding");
    if (!html || !response.body) return response;
    const headers = new Headers(response.headers);
    headers.set("cross-origin-embedder-policy", "require-corp");
    headers.set("cross-origin-opener-policy", "same-origin");
    return new Response(injectSocket(response.body, port), { status: response.status, statusText: response.statusText, headers });
  },
  unavailableResponse: port => text(502, `No bun.wasm server is listening on port ${port}.\nStart one in the playground (Bun.serve), then reload this page.\n`),
  serverErrorResponse: message => text(502, `bun.wasm server error: ${message}\n`),
  unusableResponse: (status, error) => text(502, `bun.wasm server sent an unusable response (status ${status}): ${String(error)}\n`),
});

sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", event => event.waitUntil(sw.clients.claim()));
sw.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (MODULES) {
    if (url.pathname.startsWith(prefix)) event.respondWith(moduleScope(event.request, url.pathname.slice(prefix.length)));
    return;
  }
  if (url.pathname === SOCKET_SCRIPT_PATH) {
    event.respondWith(new Response(__PREVIEW_SOCKET_SCRIPT__, { headers: { "content-type": "text/javascript" } }));
    return;
  }
  const response = previews.fetch(event.request, event.clientId);
  if (response) event.respondWith(response);
});

/** `m/<run>/<key>`: a module the worker stored; anything else: the app file of that name. */
async function moduleScope(request: Request, rest: string): Promise<Response> {
  if (rest.startsWith("m/")) return (await caches.match(request)) ?? text(404, `bun.wasm: no such module ${rest}\n`);
  const upstream = await fetch(new URL(rest, new URL("..", sw.registration.scope)).href);
  // The page is cross-origin isolated: a worker script needs COEP of its own.
  const headers = new Headers(upstream.headers);
  headers.set("cross-origin-embedder-policy", "require-corp");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function injectSocket(stream: ReadableStream<Uint8Array>, port: number): ReadableStream<Uint8Array> {
  const script = `<script src="${SOCKET_SCRIPT_PATH}" data-bun-port="${port}" data-bun-prefix="${prefix}"></script>`;
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length < 1024) {
        const { value, done } = await reader.read();
        if (value) { chunks.push(value); length += value.length; }
        if (done || value?.includes(62)) break;
      }
      const initial = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) { initial.set(chunk, at); at += chunk.length; }
      const text = new TextDecoder().decode(initial);
      const doctype = /^\s*<!doctype[^>]*>/i.exec(text)?.[0] ?? "";
      const offset = new TextEncoder().encode(doctype).length;
      controller.enqueue(initial.subarray(0, offset));
      controller.enqueue(new TextEncoder().encode(script));
      controller.enqueue(initial.subarray(offset));
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

sw.addEventListener("message", event => {
  if (MODULES || event.data?.type !== "preview-socket" || !event.ports[0]) return;
  const client = event.source;
  if (!client || !("url" in client)) return;
  const routed = previews.socket(event.data.port, client.url, event.ports[0]);
  if (routed) event.waitUntil(routed);
});
