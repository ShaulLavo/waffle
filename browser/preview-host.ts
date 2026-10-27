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
export interface PreviewHostRelay extends PreviewHostDispatcher {
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

/** One exchange per HTTP request or raw upgraded connection. */
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
  const lifetime = new AbortController();
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
    lifetime.abort();
    signal?.removeEventListener("abort", close);
    for (const item of active) finish(item, "Preview host relay closed");
  }
  signal?.addEventListener("abort", close, { once: true });
  const relay: PreviewHostRelay = {
    authorization,
    origin,
    get closed() {
      return closed;
    },
    fetch: fetchResponse,
    connect,
    close,
    dispatch: (open, exchange) => dispatchPreviewHost(relay, open, exchange, lifetime.signal),
  };
  return relay;
}

async function dispatchPreviewHost(
  relay: PreviewHostRelay,
  open: PreviewHostOpen,
  exchange: PreviewHostExchange,
  lifetime: AbortSignal,
): Promise<void> {
  try {
    lifetime.throwIfAborted();
    switch (open.type) {
      case "socket":
        await dispatchSocket(relay, open, exchange, lifetime);
        break;
      case "http":
        await dispatchHTTP(relay, open, exchange, lifetime);
        break;
      default: {
        const unexpected: never = open;
        throw new TypeError(`Invalid preview relay open: ${String(unexpected)}`);
      }
    }
  } catch (error) {
    exchange.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    exchange.onmessage = null;
    exchange.close();
  }
}

async function dispatchHTTP(
  relay: PreviewHostRelay,
  open: PreviewHostOpen & { type: "http" },
  exchange: PreviewHostExchange,
  lifetime: AbortSignal,
): Promise<void> {
  const cancelled = new AbortController();
  let acknowledge = () => {};
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  const abort = () => {
    cancelled.abort();
    acknowledge();
  };
  lifetime.addEventListener("abort", abort, { once: true });
  exchange.onmessage = (message) => {
    if (message.type === "end") abort();
    else if (message.type === "pull") acknowledge();
    else abort();
  };
  try {
    const result = await relay.fetch(
      open.authorization,
      new Request(open.url, {
        method: open.method,
        headers: open.headers,
        body: open.body,
        signal: cancelled.signal,
      }),
    );
    cancelled.signal.throwIfAborted();
    exchange.postMessage({ type: "accepted" });
    exchange.postMessage({
      type: "head",
      status: result.status,
      statusText: result.statusText,
      headers: Array.from(result.headers),
    });
    reader = result.body?.getReader();
    await sendBody(reader, exchange, cancelled.signal, (ready) => {
      acknowledge = ready;
    });
    exchange.postMessage({ type: "end" });
  } finally {
    lifetime.removeEventListener("abort", abort);
    await reader?.cancel();
  }
}

async function sendBody(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined,
  exchange: PreviewHostExchange,
  signal: AbortSignal,
  ready: (acknowledge: () => void) => void,
): Promise<void> {
  if (!reader) return;
  for (;;) {
    signal.throwIfAborted();
    const chunk = await reader.read();
    signal.throwIfAborted();
    if (chunk.done) return;
    const pulled = new Promise<void>((resolve) => {
      ready(resolve);
    });
    exchange.postMessage({ type: "data", chunk: chunk.value }, [chunk.value.buffer]);
    await pulled;
  }
}

function dispatchSocket(
  relay: PreviewHostRelay,
  open: PreviewHostOpen & { type: "socket" },
  exchange: PreviewHostExchange,
  lifetime: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let connection: PreviewConnection | null = null;
    let ready = false;
    let ended = false;
    const pending: PreviewHostOutput[] = [];
    const fail = (error: unknown) => {
      ended = true;
      lifetime.removeEventListener("abort", abort);
      connection?.close();
      reject(error);
    };
    const send = (message: PreviewHostOutput) => {
      if (!ready) {
        pending.push(message);
        return;
      }
      try {
        exchange.postMessage(message, message.type === "data" ? [message.chunk.buffer] : []);
      } catch (error) {
        fail(error);
      }
    };
    const finish = (message: PreviewHostOutput) => {
      if (ended) return;
      ended = true;
      lifetime.removeEventListener("abort", abort);
      send(message);
      connection?.close();
      resolve();
    };
    const abort = () => finish({ type: "error", message: "Preview host relay closed" });
    exchange.onmessage = (message) => {
      if (ended) return;
      if (message.type === "end") finish({ type: "end" });
      else if (message.type === "data" && message.chunk instanceof Uint8Array)
        connection?.write(message.chunk);
      else finish({ type: "error", message: "Invalid preview socket input" });
    };
    lifetime.addEventListener("abort", abort, { once: true });
    try {
      connection = relay.connect(open.authorization, open.url, {
        data: (bytes) => {
          if (!ended) send({ type: "data", chunk: bytes.slice() });
        },
        end: () => finish({ type: "end" }),
        error: (message) => finish({ type: "error", message }),
      });
      if (!connection) throw new Error("No preview server is listening");
      ready = true;
      exchange.postMessage({ type: "accepted" });
      for (const message of pending) send(message);
      if (ended) connection.close();
    } catch (error) {
      fail(error);
    }
  });
}
