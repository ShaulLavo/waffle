import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { ConnectionOptions } from "node:tls";
import { normalizeOptions } from "./policy.js";
import { createRelayHandler } from "./server.js";
import { createNodeEgress } from "./node-egress.js";
import type { RelayServerOptions } from "./protocol.js";
import { createTcpRelay } from "./tcp-server.js";
import type { TcpServerOptions } from "./tcp-policy.js";

export interface NodeRelayOptions extends RelayServerOptions {
  /** Operator-trusted TLS roots, replacing defaults when supplied. Verification cannot be disabled. */
  readonly ca?: ConnectionOptions["ca"];
  readonly tcp?: TcpServerOptions;
}

/** Works with Node and Bun's node:http API. Does not listen until the operator calls listen(). */
export function createNodeRelayServer(options: NodeRelayOptions) {
  return createNodeServer(options);
}

export function createNodeServer(
  options: NodeRelayOptions,
  carrier?: import("./tcp-carrier.js").TcpCarrierFactory,
) {
  if (options.tcp) {
    const secret =
      typeof options.tcp.tokenSecret === "string"
        ? new TextEncoder().encode(options.tcp.tokenSecret)
        : options.tcp.tokenSecret;
    const http = new TextEncoder().encode(options.credential);
    if (secret.length === http.length && secret.every((byte, index) => byte === http[index]))
      throw new TypeError("HTTP and TCP credentials must be distinct");
  }
  const policy = normalizeOptions(options);
  const relay = createRelayHandler(policy, createNodeEgress(policy, options.ca));
  const tcp = options.tcp && createTcpRelay(options.tcp, options.allowedOrigins, carrier);
  const disabledUpgrades = new Set<import("node:stream").Duplex>();
  const server = createServer(
    {
      maxHeaderSize: policy.limits.maxHeaderBytes + policy.limits.maxMetadataBytes + 8192,
      requestTimeout: policy.limits.idleTimeoutMs,
      headersTimeout: policy.limits.idleTimeoutMs,
    },
    (request, response) => {
      void (async () => {
        if (await tcp?.handle(request, response)) return;
        await handle(relay.fetch, request, response);
      })().catch(() => response.destroy());
    },
  );
  server.maxConnections =
    policy.limits.maxConcurrent + (options.tcp?.limits?.maxConnections ?? (tcp ? 64 : 0)) + 8;
  server.on("upgrade", (request, socket, head) => {
    if (tcp) tcp.upgrade(request, socket, head);
    else {
      disabledUpgrades.add(socket);
      socket.on("error", () => {});
      const timer = setTimeout(() => socket.destroy(), 5000);
      timer.unref();
      socket.once("close", () => {
        clearTimeout(timer);
        disabledUpgrades.delete(socket);
      });
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    server,
    relay,
    tcp,
    revoke() {
      relay.revoke();
      tcp?.revoke();
    },
    close() {
      if (closing) return closing;
      const completion = Promise.withResolvers<void>();
      closing = completion.promise;
      tcp?.revoke();
      for (const socket of disabledUpgrades) socket.destroy();
      void Promise.all([shutdown(relay, server), tcp?.close()]).then(
        () => completion.resolve(),
        completion.reject,
      );
      return closing;
    },
  });
}

async function shutdown(
  relay: ReturnType<typeof createRelayHandler>,
  server: Server,
): Promise<void> {
  relay.revoke();
  server.closeIdleConnections();
  const closed = new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await relay.close();
  await closed;
}

async function handle(
  fetch: (request: Request) => Promise<Response>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableFinished) controller.abort(new Error("Relay client disconnected"));
  };
  response.once("close", abort);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const headers = incomingHeaders(request);
    const body = request.method === "POST" ? requestStream(request) : null;
    const init: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      duplex: "half",
    };
    // The Host header has no authority over this handler's route or outbound destination.
    const result = await fetch(new Request(`http://localhost${request.url ?? "/"}`, init));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    reader = result.body?.getReader();
    await sendBody(reader, response, controller.signal);
    response.end();
  } catch {
    response.destroy();
  } finally {
    response.removeListener("close", abort);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  return headers;
}

function requestStream(request: IncomingMessage): ReadableStream<Uint8Array> | null {
  if (
    !request.headers["transfer-encoding"] &&
    (!request.headers["content-length"] || request.headers["content-length"] === "0")
  )
    return null;
  const iterator = request[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) throw new TypeError("Invalid request bytes");
        controller.enqueue(next.value);
      },
      async cancel() {
        // Do not destroy the response socket before a bounded policy error can be returned.
        request.unpipe();
        request.pause();
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

async function sendBody(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  if (!reader) return;
  for (;;) {
    signal.throwIfAborted();
    const next = await reader.read();
    if (next.done) return;
    if (!response.write(next.value)) await writable(response, signal);
  }
}

function writable(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("drain", drain);
      signal.removeEventListener("abort", abort);
    };
    const drain = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    response.once("drain", drain);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
