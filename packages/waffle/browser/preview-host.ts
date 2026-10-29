import type { ConnectionSink, PreviewConnection } from "./net/helper.js";
import {
  ResponseParser,
  serializeRequest,
  serializeUpgrade,
  type ResponseHead,
} from "./net/http1.js";
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

/** Waffle serializes this head before forwarding later socket data. */
export interface PreviewSocketRequest {
  url: string;
  method: string;
  headers: [string, string][];
}

/** Host adapters authenticate their owner connection before installing this grant. */
export interface PreviewHostRelay extends PreviewHostDispatcher {
  readonly authorization: PreviewHostAuthorization;
  readonly origin: string;
  readonly closed: boolean;
  fetch(authorization: unknown, request: Request): Promise<Response>;
  /** Opens an upgrade with its guest-view request head already written. */
  connect(
    authorization: unknown,
    request: PreviewSocketRequest,
    sink: ConnectionSink,
  ): PreviewConnection | null;
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
  | ({ type: "socket"; authorization: PreviewHostAuthorization } & PreviewSocketRequest);

/** One pull acknowledges one HTTP body chunk. Socket data carries trailing upgrade bytes and later TCP bytes. */
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
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("Preview request requires an HTTP(S) protocol");
  if (url.origin !== origin || url.username || url.password)
    throw new TypeError("Preview request does not match its bound origin");
  return url;
}

interface RelayRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
  signal: AbortSignal;
}

interface RelayResponse {
  head: ResponseHead;
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null;
}

type ReadResponse = (authorization: unknown, request: RelayRequest) => Promise<RelayResponse>;

function headerPairs(headers: readonly [string, string][]): [string, string][] {
  if (!Array.isArray(headers)) throw new TypeError("Invalid preview HTTP headers");
  return headers.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new TypeError("Invalid preview HTTP header pair");
    const [name, value] = pair;
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      !/^[\t\x20-\x7e\x80-\xff]*$/.test(value)
    )
      throw new TypeError("Invalid preview HTTP header");
    return [name, value];
  });
}

function upgradeHeaders(
  headers: [string, string][],
  originPort: (origin: string) => number | undefined,
): [string, string][] {
  const hosts = headers.filter(([name]) => name.toLowerCase() === "host");
  const origins = headers.filter(([name]) => name.toLowerCase() === "origin");
  if (hosts.length > 1 || origins.length > 1)
    throw new TypeError("Duplicate preview upgrade authority");
  const source = origins[0];
  if (!source) return headers;
  const port = originPort(source[1]);
  if (port === undefined) throw new TypeError("Unauthorized preview upgrade Origin");
  const rest = headers.filter(([name]) => name.toLowerCase() !== "origin");
  const translated: [string, string][] = [["Origin", `http://localhost:${port}`]];
  return translated.concat(rest);
}

function responseHead(head: ResponseHead): ResponseHead {
  if (
    head.status < 200 ||
    head.status > 599 ||
    !Number.isInteger(head.status) ||
    !/^[\t\x20-\x7e\x80-\xff]*$/.test(head.statusText)
  )
    throw new TypeError("Invalid preview HTTP response status");
  const headers = headerPairs(head.headers).filter(([name]) => !FRAMING.has(name.toLowerCase()));
  return { status: head.status, statusText: head.statusText, headers };
}

/** The router calls this lazily; it opens only its existing virtual network connections. */
export function createPreviewHostRelay(
  server: Pick<PreviewServer, "connect">,
  owner: string,
  options: PreviewHostOptions & { origin: string; originPort(origin: string): number | undefined },
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

  function open(input: unknown, url: string, sink: ConnectionSink): PreviewConnection | null {
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

  function connect(
    input: unknown,
    request: PreviewSocketRequest,
    sink: ConnectionSink,
  ): PreviewConnection | null {
    const url = check(input, request.url);
    const headers = upgradeHeaders(headerPairs(request.headers), options.originPort);
    if (typeof request.method !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(request.method))
      throw new TypeError("Invalid preview HTTP method");
    const head = serializeUpgrade(
      { method: request.method, target: url.pathname + url.search, headers },
      `localhost:${authorization.port}`,
    );
    const connection = open(input, request.url, sink);
    connection?.write(head);
    return connection;
  }

  async function fetchResponse(input: unknown, request: Request): Promise<Response> {
    check(input, request.url);
    request.signal.throwIfAborted();
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    const result = await readResponse(input, {
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers),
      body,
      signal: request.signal,
    });
    return new Response(result.body, result.head);
  }

  function readResponse(input: unknown, request: RelayRequest): Promise<RelayResponse> {
    const url = check(input, request.url);
    request.signal.throwIfAborted();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(request.method))
      throw new TypeError("Invalid preview HTTP method");
    if (["GET", "HEAD"].includes(request.method.toUpperCase()) && request.body !== null)
      throw new TypeError("Preview GET/HEAD requests cannot have a body");
    const headers = headerPairs(request.headers);
    return new Promise((resolve, reject) => {
      let connection: PreviewConnection | null = null;
      let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
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
      const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(value) {
          controller = value;
        },
        pull: resume,
        cancel: cleanup,
      });
      const parser = new ResponseParser(
        {
          head: (head) =>
            resolve({
              head: responseHead(head),
              body: request.method === "HEAD" || BODYLESS.has(head.status) ? null : stream,
            }),
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
        connection = open(input, request.url, {
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
              headers,
              body: request.body,
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
    dispatch: (open, exchange) =>
      dispatchPreviewHost(relay, open, exchange, lifetime.signal, readResponse),
  };
  return relay;
}

async function dispatchPreviewHost(
  relay: PreviewHostRelay,
  open: PreviewHostOpen,
  exchange: PreviewHostExchange,
  lifetime: AbortSignal,
  readResponse: ReadResponse,
): Promise<void> {
  try {
    lifetime.throwIfAborted();
    switch (open.type) {
      case "socket":
        await dispatchSocket(relay, open, exchange, lifetime);
        break;
      case "http":
        await dispatchHTTP(readResponse, open, exchange, lifetime);
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
  readResponse: ReadResponse,
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
    if (open.body !== null && !(open.body instanceof ArrayBuffer))
      throw new TypeError("Invalid preview HTTP body");
    const result = await readResponse(open.authorization, {
      url: open.url,
      method: open.method,
      headers: open.headers,
      body: open.body === null ? null : new Uint8Array(open.body),
      signal: cancelled.signal,
    });
    cancelled.signal.throwIfAborted();
    exchange.postMessage({ type: "accepted" });
    exchange.postMessage({
      type: "head",
      ...result.head,
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
      connection = relay.connect(open.authorization, open, {
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
