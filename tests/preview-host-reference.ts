import type { PreviewRouter, PreviewServer } from "../browser/preview.js";
import type {
  PreviewHostRelay,
  PreviewHostAuthorization,
  PreviewHostExchange,
  PreviewHostOpen,
} from "../browser/preview-host.js";

/** Test-only native host: origin mapping/grants stay private; the browser selects only an app URL. */
export async function startPreviewReferenceHost(options: {
  router: PreviewRouter;
  port: number;
  allocated(origin: string): void;
}) {
  const lifetime = new AbortController();
  let relay: PreviewHostRelay | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      relay
        ? referenceRequest(relay, relay.authorization, request)
        : new Response("Not bound", { status: 503 }),
  });
  try {
    options.allocated(server.url.origin);
    relay = await options.router.bindHost({ port: options.port, signal: lifetime.signal });
  } catch (error) {
    server.stop(true);
    throw error;
  }
  return {
    url: server.url,
    close() {
      lifetime.abort();
      server.stop(true);
    },
  };
}

/** Adapts the published wire protocol, including actual buffer transfer and HTTP pull credit. */
async function referenceRequest(
  relay: PreviewHostRelay,
  authorization: PreviewHostAuthorization,
  request: Request,
): Promise<Response> {
  const open: PreviewHostOpen = {
    type: "http",
    authorization,
    url: request.url,
    method: request.method,
    headers: Array.from(request.headers),
    body: request.body ? await request.arrayBuffer() : null,
  };
  return new Promise((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const exchange: PreviewHostExchange = {
      onmessage: null,
      close() {
        request.signal.removeEventListener("abort", cancel);
      },
      postMessage(output, transfer) {
        const message = structuredClone(output, { transfer });
        if (message.type === "head")
          resolve(
            new Response(
              request.method === "HEAD" || [204, 205, 304].includes(message.status) ? null : stream,
              message,
            ),
          );
        if (message.type === "data") {
          controller.enqueue(message.chunk);
          if ((controller.desiredSize ?? 0) > 0) pull();
        }
        if (message.type === "end") controller.close();
        if (message.type === "error") {
          const error = new Error(message.message);
          controller.error(error);
          reject(error);
        }
      },
    };
    const pull = () => exchange.onmessage?.({ type: "pull" });
    const cancel = () => exchange.onmessage?.({ type: "end" });
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull,
      cancel,
    });
    request.signal.addEventListener("abort", cancel, { once: true });
    void relay.dispatch(open, exchange).catch(reject);
  });
}

/** A test-only producer, pinned to one known native SSR server, never a general loopback proxy. */
export function nativePreviewFixture(nativePort: number): {
  server: PreviewServer;
  close(): Promise<void>;
} {
  const sockets = new Set<Promise<Bun.Socket>>();
  const server: PreviewServer = {
    request() {
      throw new Error("The root relay must use the raw virtual server connection");
    },
    connect(_port, sink) {
      let closed = false;
      const socket = Bun.connect({
        hostname: "127.0.0.1",
        port: nativePort,
        socket: {
          data(socket, bytes) {
            const receipt = sink.data(new Uint8Array(bytes));
            if (!receipt) return;
            socket.pause();
            void receipt.then(
              () => {
                if (!closed) socket.resume();
              },
              (error) => sink.error(String(error)),
            );
          },
          close() {
            sink.end();
          },
          error(_socket, error) {
            sink.error(error.message);
          },
        },
      });
      sockets.add(socket);
      void socket.catch((error) => sink.error(String(error)));
      return {
        write(bytes) {
          void socket.then((value) => {
            if (!closed) value.write(bytes);
          });
        },
        close() {
          closed = true;
          void socket.then((value) => value.end()).catch(() => {});
        },
      };
    },
  };
  return {
    server,
    async close() {
      const results = await Promise.allSettled(sockets);
      for (const result of results) if (result.status === "fulfilled") result.value.terminate();
      sockets.clear();
    },
  };
}
