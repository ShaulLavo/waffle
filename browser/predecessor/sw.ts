// Service worker for Bun.serve previews and the browser engine's ES modules. The page registers it
// twice, never over itself (its COOP/COEP headers stay untouched):
//
// Scope `<app>/__bunwasm/` controls the bun workers started from `<app>/__bunwasm/worker.js`. The
// worker puts each program module into Cache Storage under `<app>/__bunwasm/m/<run>/<key>` before
// importing it, and this worker serves those URLs, so modules have named URLs and import cycles
// link natively (engine-host.js). Other paths under the scope are the app's own files.
//
// Scope `<app>/__preview/` controls only preview tabs:
// A request for `<app>/__preview/<port>/<path>` is forwarded to the playground window running a
// guest server on <port> (see preview.ts), which turns it into an HTTP/1.1 connection for bun.wasm
// and streams the parsed response back here. Root-relative requests made by a preview page (e.g.
// `/style.css`) go to the same port.

import type { PreviewAsk, PreviewReply } from "./preview-protocol";

const sw = self as unknown as ServiceWorkerGlobalScope;
/** Path of the scope, `<app>/__preview/`. */
const prefix = new URL(sw.registration.scope).pathname;
const PORT_PATH = new RegExp(`^${escapeRegExp(prefix)}(\\d{1,5})(/.*)?$`);
declare const __PREVIEW_SOCKET_SCRIPT__: string;
const SOCKET_SCRIPT_PATH = new URL("../preview-websocket.js", sw.registration.scope).pathname;
const MODULES = prefix.endsWith("/__bunwasm/");
/** How long a window has to claim a request before we try the next one. */
const CLAIM_TIMEOUT_MS = 3000;

sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener("fetch", (event) => {
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
  const direct = PORT_PATH.exec(url.pathname);
  if (direct) {
    event.respondWith(forward(event.request, Number(direct[1]), (direct[2] ?? "/") + url.search));
    return;
  }
  // Every client this worker controls is a preview page, so any other same-origin request it makes
  // belongs to that page's server.
  if (!event.clientId) return;
  event.respondWith(fromPreviewClient(event.request, event.clientId, url.pathname + url.search));
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

async function fromPreviewClient(request: Request, clientId: string, target: string): Promise<Response> {
  const client = await sw.clients.get(clientId);
  const match = client ? PORT_PATH.exec(new URL(client.url).pathname) : null;
  if (!match) return fetch(request);
  return forward(request, Number(match[1]), target);
}

async function forward(request: Request, port: number, target: string): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const ask: PreviewAsk = {
    type: "preview-request",
    port,
    method: request.method,
    target,
    headers: Array.from(request.headers),
    body: hasBody ? await request.arrayBuffer() : null,
  };
  const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).pathname.startsWith(prefix)) continue; // a preview tab, not a playground
    const response = await askWindow(client, ask);
    if (response) return response;
  }
  return text(502, `No bun.wasm server is listening on port ${port}.\nStart one in the playground (Bun.serve), then reload this page.\n`);
}

/** Resolves to the response, or null when this window has no server on the port. */
function askWindow(client: Client, ask: PreviewAsk): Promise<Response | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let body: ReadableStreamDefaultController<Uint8Array> | null = null;
    let answered = false;
    const answer = (response: Response | null) => {
      answered = true;
      clearTimeout(timer);
      resolve(response);
    };
    const timer = setTimeout(() => answer(null), CLAIM_TIMEOUT_MS);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => void (body = controller),
      cancel: () => channel.port1.close(),
    });
    channel.port1.onmessage = (event: MessageEvent<PreviewReply>) => {
      const msg = event.data;
      switch (msg.type) {
        case "none":
          answer(null);
          return;
        case "accepted":
          clearTimeout(timer);
          return;
        case "head":
          answer(makeResponse(msg, stream, ask.port));
          return;
        case "data":
          body?.enqueue(msg.chunk);
          return;
        case "end":
          body?.close();
          channel.port1.close();
          return;
        case "error":
          channel.port1.close();
          if (!answered) answer(text(502, `bun.wasm server error: ${msg.message}\n`));
          else body?.error(new TypeError(msg.message));
          return;
      }
    };
    client.postMessage(ask, [channel.port2]);
  });
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
/** Framing headers describe the HTTP/1.1 bytes, not the decoded body we hand over. */
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);

function makeResponse(head: PreviewReply & { type: "head" }, stream: ReadableStream<Uint8Array>, port: number): Response {
  const headers = new Headers();
  for (const [name, value] of head.headers) {
    if (DROP.has(name)) continue;
    try {
      headers.append(name, value);
    } catch {
      /* a header the browser won't accept: skip it */
    }
  }
  try {
    const encoding = headers.get("content-encoding");
    const html = headers.get("content-type")?.toLowerCase().includes("text/html") && !encoding;
    const body = html ? injectSocket(stream, port) : stream;
    if (html) {
      headers.set("cross-origin-embedder-policy", "require-corp");
      headers.set("cross-origin-opener-policy", "same-origin");
    }
    return new Response(NULL_BODY.has(head.status) ? null : body, { status: head.status, statusText: head.statusText, headers });
  } catch (err) {
    return text(502, `bun.wasm server sent an unusable response (status ${head.status}): ${String(err)}\n`);
  }
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

sw.addEventListener("message", (event) => {
  if (MODULES || event.data?.type !== "preview-socket" || !event.ports[0]) return;
  const client = event.source;
  if (!client || !("url" in client)) return;
  const match = PORT_PATH.exec(new URL(client.url).pathname);
  if (!match || Number(match[1]) !== event.data.port) return;
  event.waitUntil(routeSocket(event.data.port, event.ports[0]));
});

async function routeSocket(port: number, socket: MessagePort): Promise<void> {
  const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).pathname.startsWith(prefix)) continue;
    if (!await claimsSocket(client, port)) continue;
    client.postMessage({ type: "preview-socket", port }, [socket]);
    return;
  }
  socket.postMessage({ type: "error" });
  socket.close();
}

function claimsSocket(client: Client, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const answer = (claimed: boolean) => { clearTimeout(timer); channel.port1.close(); resolve(claimed); };
    const timer = setTimeout(() => answer(false), CLAIM_TIMEOUT_MS);
    channel.port1.onmessage = (event) => answer(event.data?.type === "accepted");
    client.postMessage({ type: "preview-socket-probe", port }, [channel.port2]);
  });
}
