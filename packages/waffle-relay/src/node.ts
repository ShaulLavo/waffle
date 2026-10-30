import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ConnectionOptions } from "node:tls";
import { normalizeOptions } from "./policy.js";
import { createRelayHandler } from "./server.js";
import { createNodeEgress } from "./node-egress.js";
import type { RelayServerOptions } from "./protocol.js";

export interface NodeRelayOptions extends RelayServerOptions {
  /** Operator-trusted TLS roots, replacing defaults when supplied. Verification cannot be disabled. */
  readonly ca?: ConnectionOptions["ca"];
}

/** Works with Node and Bun's node:http API. Does not listen until the operator calls listen(). */
export function createNodeRelayServer(options: NodeRelayOptions) {
  const policy = normalizeOptions(options);
  const relay = createRelayHandler(policy, createNodeEgress(policy, options.ca));
  const server = createServer(
    {
      maxHeaderSize: policy.limits.maxHeaderBytes + policy.limits.maxMetadataBytes + 8192,
      requestTimeout: policy.limits.idleTimeoutMs,
      headersTimeout: policy.limits.idleTimeoutMs,
    },
    (request, response) => {
      void handle(relay.fetch, request, response);
    },
  );
  server.maxConnections = policy.limits.maxConcurrent + 8;
  return Object.freeze({
    server,
    relay,
    async close() {
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
    },
  });
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
