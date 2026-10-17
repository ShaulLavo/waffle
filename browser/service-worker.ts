import type { PreviewAsk, PreviewMessage, PreviewReply } from "./preview-protocol";

/** Structural bindings keep this module usable without service-worker globals. */
export interface PreviewClient {
  readonly url: string;
  postMessage(message: PreviewMessage, transfer: MessagePort[]): void;
}

export interface PreviewServiceWorkerOptions {
  scope: string;
  clients: {
    get(id: string): Promise<PreviewClient | undefined>;
    matchAll(options: { type: "window"; includeUncontrolled: true }): Promise<readonly PreviewClient[]>;
  };
  fetch(request: Request): Promise<Response>;
  createChannel?(): MessageChannel;
  claimTimeoutMs?: number;
  /** Consumer policy, such as HTML script injection or isolation headers. */
  transformResponse?(response: Response, port: number): Response;
  unavailableResponse?(port: number): Response;
  serverErrorResponse?(message: string): Response;
  unusableResponse?(status: number, error: unknown): Response;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);
const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** Generic preview routing. Consumers attach fetch/message listeners and own other scopes. */
export function createPreviewServiceWorker(options: PreviewServiceWorkerOptions) {
  const scope = new URL(options.scope);
  const prefix = scope.pathname;
  const portPath = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d{1,5})(/.*)?$`);
  const createChannel = options.createChannel ?? (() => new MessageChannel());
  const claimTimeout = options.claimTimeoutMs ?? 3000;
  const isPreview = (client: PreviewClient) => {
    const url = new URL(client.url);
    return url.origin === scope.origin && url.pathname.startsWith(prefix);
  };

  function makeResponse(head: PreviewReply & { type: "head" }, stream: ReadableStream<Uint8Array>, ask: PreviewAsk): Response {
    const headers = new Headers();
    for (const [name, value] of head.headers) {
      if (DROP.has(name.toLowerCase())) continue;
      try { headers.append(name, value); } catch { /* Skip headers rejected by the browser. */ }
    }
    try {
      const response = new Response(ask.method === "HEAD" || NULL_BODY.has(head.status) ? null : stream, {
        status: head.status, statusText: head.statusText, headers,
      });
      return options.transformResponse?.(response, ask.port) ?? response;
    } catch (error) {
      return options.unusableResponse?.(head.status, error) ?? text(502, `Server sent an unusable response (status ${head.status}): ${String(error)}\n`);
    }
  }

  function askWindow(client: PreviewClient, ask: PreviewAsk): Promise<Response | null> {
    return new Promise(resolve => {
      const channel = createChannel();
      let body: ReadableStreamDefaultController<Uint8Array>;
      let answered = false;
      let finished = false;
      const close = () => { finished = true; clearTimeout(timer); channel.port1.close(); };
      const answer = (response: Response | null) => { answered = true; clearTimeout(timer); resolve(response); };
      const timer = setTimeout(() => { close(); answer(null); }, claimTimeout);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { body = controller; },
        cancel() { close(); },
      });
      channel.port1.onmessage = (event: MessageEvent<PreviewReply>) => {
        if (finished) return;
        const msg = event.data;
        switch (msg.type) {
          case "none": close(); answer(null); return;
          case "accepted": clearTimeout(timer); return;
          case "head": answer(makeResponse(msg, stream, ask)); return;
          case "data": body.enqueue(msg.chunk); return;
          case "end": body.close(); close(); return;
          case "error":
            close();
            if (!answered) answer(options.serverErrorResponse?.(msg.message) ?? text(502, `Server error: ${msg.message}\n`));
            else body.error(new TypeError(msg.message));
            return;
        }
      };
      try { client.postMessage(ask, [channel.port2]); }
      catch { close(); channel.port2.close(); answer(null); }
    });
  }

  async function forward(request: Request, port: number, target: string): Promise<Response> {
    const ask: PreviewAsk = {
      type: "preview-request", port, method: request.method, target,
      headers: Array.from(request.headers.entries()),
      body: request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : null,
    };
    const windows = await options.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (isPreview(client)) continue;
      const response = await askWindow(client, ask);
      if (response) return response;
    }
    return options.unavailableResponse?.(port) ?? text(502, `No server is listening on port ${port}.\n`);
  }

  async function fromClient(request: Request, clientId: string, target: string): Promise<Response> {
    const client = await options.clients.get(clientId);
    const match = client && isPreview(client) ? portPath.exec(new URL(client.url).pathname) : null;
    return match ? forward(request, Number(match[1]), target) : options.fetch(request);
  }

  function claimsSocket(client: PreviewClient, port: number): Promise<boolean> {
    return new Promise(resolve => {
      const channel = createChannel();
      const answer = (claimed: boolean) => { clearTimeout(timer); channel.port1.close(); resolve(claimed); };
      const timer = setTimeout(() => answer(false), claimTimeout);
      channel.port1.onmessage = event => answer(event.data?.type === "accepted");
      try { client.postMessage({ type: "preview-socket-probe", port }, [channel.port2]); }
      catch { channel.port2.close(); answer(false); }
    });
  }

  async function routeSocket(port: number, socket: MessagePort): Promise<void> {
    const windows = await options.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (isPreview(client) || !await claimsSocket(client, port)) continue;
      client.postMessage({ type: "preview-socket", port }, [socket]);
      return;
    }
    socket.postMessage({ type: "error" });
    socket.close();
  }

  return {
    fetch(request: Request, clientId: string): Promise<Response> | undefined {
      const url = new URL(request.url);
      if (url.origin !== scope.origin) return;
      const match = portPath.exec(url.pathname);
      if (match) return forward(request, Number(match[1]), (match[2] ?? "/") + url.search);
      if (clientId) return fromClient(request, clientId, url.pathname + url.search);
    },
    socket(port: number, clientURL: string, socket: MessagePort): Promise<void> | undefined {
      const url = new URL(clientURL);
      const match = url.origin === scope.origin ? portPath.exec(url.pathname) : null;
      if (!match || Number(match[1]) !== port) return;
      return routeSocket(port, socket);
    },
  };
}

/** Await activation even when the registering page is outside the worker's scope. */
export function activated(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) return Promise.reject(new Error("service worker registration has no worker"));
  return new Promise((resolve, reject) => {
    const check = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") return;
      worker.removeEventListener("statechange", check);
      if (worker.state === "redundant") reject(new Error("service worker became redundant before activation"));
      else resolve();
    };
    worker.addEventListener("statechange", check);
    check();
  });
}
