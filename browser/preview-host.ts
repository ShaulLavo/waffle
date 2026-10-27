import type { ConnectionSink, PreviewConnection } from "./net/helper.js";
import { ResponseParser, serializeRequest, type ResponseHead } from "./net/http1.js";
import type { PreviewServer } from "./preview.js";

export interface PreviewHostOptions {
  port: number;
  signal?: AbortSignal;
}

/** Private control-plane grant. Never send this to the preview application. */
export interface PreviewHostAuthorization {
  readonly owner: string;
  readonly port: number;
  readonly origin: string;
  readonly capability: string;
}

/** Host adapters authenticate their owner connection before installing this grant. */
export interface PreviewHostRelay {
  readonly authorization: PreviewHostAuthorization;
  readonly origin: string;
  readonly closed: boolean;
  fetch(authorization: unknown, request: Request): Promise<Response>;
  /** Raw HTTP upgrade/duplex bytes. The host owns the native WebSocket upgrade adapter. */
  connect(authorization: unknown, url: string, sink: ConnectionSink): PreviewConnection | null;
  close(): void;
}

/** One request on an authenticated host-owner session; body buffers are transferable. */
export type PreviewHostOpen =
  | {
      type: "http";
      authorization: PreviewHostAuthorization;
      url: string;
      method: string;
      headers: [string, string][];
      body: ArrayBuffer | null;
    }
  | { type: "socket"; authorization: PreviewHostAuthorization; url: string };

/** One pull acknowledges one HTTP body chunk. Socket data carries raw HTTP upgrade/TCP bytes. */
export type PreviewHostInput =
  | { type: "pull" }
  | { type: "data"; chunk: Uint8Array<ArrayBuffer> }
  | { type: "end" };

export type PreviewHostOutput =
  | { type: "accepted" }
  | { type: "head"; status: number; statusText: string; headers: [string, string][] }
  | { type: "data"; chunk: Uint8Array<ArrayBuffer> }
  | { type: "end" }
  | { type: "error"; message: string };

/** The producer's authenticated native transport adapts each exchange to its own framing. */
export interface PreviewHostExchange {
  postMessage(message: PreviewHostOutput, transfer?: ArrayBuffer[]): void;
  onmessage: ((message: PreviewHostInput) => void) | null;
  close(): void;
}

/** Draft exchange endpoint contract; direct relay construction is already implemented. */
export interface PreviewHostDispatcher {
  dispatch(open: PreviewHostOpen, exchange: PreviewHostExchange): Promise<void>;
}

interface ActiveConnection {
  connection: PreviewConnection | null;
  sink: ConnectionSink;
  closed: boolean;
}

const BODYLESS = new Set([204, 205, 304]);
const FRAMING = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);

function rootOrigin(input: string): string {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new TypeError("Preview host requires an HTTP(S) root origin");
  return url.origin;
}

function authorized(input: unknown, grant: PreviewHostAuthorization): boolean {
  return (
    !!input &&
    typeof input === "object" &&
    "owner" in input &&
    input.owner === grant.owner &&
    "port" in input &&
    input.port === grant.port &&
    "origin" in input &&
    input.origin === grant.origin &&
    "capability" in input &&
    input.capability === grant.capability
  );
}

function requestURL(input: string, origin: string): URL {
  const url = new URL(input);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.origin !== origin || url.username || url.password)
    throw new TypeError("Preview request does not match its bound origin");
  return url;
}

function response(head: ResponseHead, body: ReadableStream<Uint8Array>, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of head.headers) {
    if (!FRAMING.has(name.toLowerCase())) headers.append(name, value);
  }
  return new Response(method === "HEAD" || BODYLESS.has(head.status) ? null : body, {
    status: head.status,
    statusText: head.statusText,
    headers,
  });
}

/** The router calls this lazily; it opens only its existing virtual network connections. */
export function createPreviewHostRelay(
  server: Pick<PreviewServer, "connect">,
  owner: string,
  options: PreviewHostOptions & { origin: string },
): PreviewHostRelay {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new TypeError("Invalid preview port");
  options.signal?.throwIfAborted();
  const origin = rootOrigin(options.origin);
  const authorization = Object.freeze({
    owner,
    port: options.port,
    origin,
    capability: crypto.randomUUID(),
  });
  const active = new Set<ActiveConnection>();
  const signal = options.signal;
  let closed = false;

  function check(input: unknown, url: string): URL {
    if (closed) throw new Error("Preview host relay is closed");
    if (!authorized(input, authorization)) throw new TypeError("Unauthorized preview host relay");
    return requestURL(url, origin);
  }

  function finish(item: ActiveConnection, error?: string): void {
    if (item.closed) return;
    item.closed = true;
    active.delete(item);
    item.connection?.close();
    if (error !== undefined) item.sink.error(error);
    else item.sink.end();
  }

  function connect(input: unknown, url: string, sink: ConnectionSink): PreviewConnection | null {
    check(input, url);
    const item: ActiveConnection = { connection: null, sink, closed: false };
    active.add(item);
    try {
      item.connection = server.connect(authorization.port, {
        data: (bytes) => (item.closed ? undefined : sink.data(bytes)),
        end: () => finish(item),
        error: (message) => finish(item, message),
      });
    } catch (error) {
      finish(item, String(error));
      throw error;
    }
    if (!item.connection) {
      active.delete(item);
      return null;
    }
    if (item.closed) item.connection.close();
    return {
      write(bytes) {
        if (!item.closed) item.connection?.write(bytes);
      },
      close: () => finish(item),
    };
  }

  async function fetchResponse(input: unknown, request: Request): Promise<Response> {
    const url = check(input, request.url);
    request.signal.throwIfAborted();
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    request.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let connection: PreviewConnection | null = null;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let finished = false;
      let credit: { promise: Promise<void>; release(): void } | undefined;
      const resume = () => {
        credit?.release();
        credit = undefined;
      };
      const cleanup = () => {
        finished = true;
        resume();
        request.signal.removeEventListener("abort", abort);
        connection?.close();
      };
      const fail = (error: Error) => {
        if (finished) return;
        controller.error(error);
        reject(error);
        cleanup();
      };
      const abort = () =>
        fail(new Error("Preview request aborted", { cause: request.signal.reason }));
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        pull: resume,
        cancel: cleanup,
      });
      const parser = new ResponseParser(
        {
          head: (head) => resolve(response(head, stream, request.method)),
          data: (chunk) => {
            if (finished) return;
            controller.enqueue(chunk);
            if ((controller.desiredSize ?? 0) > 0 || credit) return;
            let release = () => {};
            const promise = new Promise<void>((resolve) => {
              release = resolve;
            });
            credit = { promise, release };
          },
          end: () => {
            if (!finished) controller.close();
            cleanup();
          },
          error: (message) => fail(new Error(message)),
        },
        request.method === "HEAD",
      );
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        connection = connect(input, request.url, {
          data: (bytes) => {
            parser.push(bytes);
            return credit?.promise;
          },
          end: () => parser.end(),
          error: (message) => fail(new Error(message)),
        });
        if (!connection) throw new Error("No preview server is listening");
        connection.write(
          serializeRequest(
            {
              method: request.method,
              target: url.pathname + url.search,
              headers: Array.from(request.headers),
              body,
            },
            url.host,
          ),
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", close);
    for (const item of active) finish(item, "Preview host relay closed");
  }
  signal?.addEventListener("abort", close, { once: true });
  return {
    authorization,
    origin,
    get closed() {
      return closed;
    },
    fetch: fetchResponse,
    connect,
    close,
  };
}
