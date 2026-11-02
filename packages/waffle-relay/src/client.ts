import { attachNetFetchResponseMetadata } from "waffle/browser/net/transport";
import { Lifetime, type Exchange } from "./lifetime.js";
import { boundedStream } from "./stream.js";
import {
  encodeMeta,
  limitsFrom,
  RELAY_META_HEADER,
  RELAY_PATH,
  responseMeta,
  RelayError,
  type RelayClientOptions,
  type RelayFetchCapability,
  type RelayLimits,
} from "./protocol.js";
import { checkHeaders, credentialFrom, methodFrom, targetURL } from "./policy.js";

interface CapturedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: [string, string][];
  readonly body: BodyInit | null;
  readonly signal: AbortSignal | null;
  readonly redirect: RequestRedirect;
}
interface Chain {
  next: string;
  count: number;
}
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function createRelayFetch(options: RelayClientOptions): RelayFetchCapability {
  const endpoint = endpointURL(options.endpoint);
  const credential = credentialFrom(options.credential);
  const transport = options.transport ?? ((url, init) => globalThis.fetch(url, init));
  const limits = limitsFrom(options.limits);
  const lifetime = new Lifetime(limits);
  const chains = new WeakMap<AbortSignal, Chain>();
  return Object.freeze({
    async fetch(value: string, init: RequestInit = {}): Promise<Response> {
      lifetime.assertLive();
      const request = captureRequest(value, init);
      lifetime.assertLive();
      request.signal?.throwIfAborted();
      const count = nextHop(request, chains, limits.maxRedirects);
      return follow(request, count, { endpoint, credential, transport, limits, lifetime, chains });
    },
    revoke: (reason?: unknown) => lifetime.revoke(reason),
    close: () => lifetime.close(),
  });
}

type Client = {
  endpoint: string;
  credential: string;
  transport: NonNullable<RelayClientOptions["transport"]>;
  limits: RelayLimits;
  lifetime: Lifetime;
  chains: WeakMap<AbortSignal, Chain>;
};

async function follow(initial: CapturedRequest, start: number, client: Client): Promise<Response> {
  let request = initial;
  for (let count = start; ; count++) {
    const response = await fetchHop(request, client);
    const location = response.headers.get("location");
    if (!REDIRECTS.has(response.status) || location === null) {
      attachNetFetchResponseMetadata(response, {
        targetURL: request.url.href,
        redirected: count > 0,
      });
      return response;
    }
    if (request.redirect === "manual") {
      rememberManualHop(request, location, count, client.chains);
      return response;
    }
    let next: CapturedRequest;
    try {
      next = redirectRequest(request, response.status, location);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (request.signal)
      client.chains.set(request.signal, { next: next.url.href, count: count + 1 });
    await response.body?.cancel();
    if (request.redirect === "error" || count >= client.limits.maxRedirects)
      throw new RelayError("redirect-denied");
    request = next;
  }
}

async function fetchHop(request: CapturedRequest, client: Client): Promise<Response> {
  checkHeaders(request.headers, client.limits.maxHeaderBytes);
  if (request.url.href.length > client.limits.maxMetadataBytes)
    throw new RelayError("relay-metadata");
  const encoded = encodeMeta(
    { version: 1, method: request.method, url: request.url.href, headers: request.headers },
    client.limits.maxMetadataBytes,
  );
  const job = client.lifetime.admit(request.signal);
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    job.controller.signal.throwIfAborted();
    const upload = uploadBody(request.body, job, client.limits.maxRequestBytes);
    const headers = new Headers({
      authorization: `Bearer ${client.credential}`,
      [RELAY_META_HEADER]: encoded,
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers,
      body: upload,
      signal: job.controller.signal,
      redirect: "manual",
      credentials: "omit",
      duplex: "half",
    };
    const transport = client.transport;
    const response = await transport(client.endpoint, init);
    body = boundedStream(response.body, job, client.limits.maxResponseBytes, "response-limit");
    job.controller.signal.throwIfAborted();
    if (response.redirected || (response.url && response.url !== client.endpoint))
      throw new RelayError("relay-unavailable");
    const meta = responseMeta(
      response.headers.get(RELAY_META_HEADER),
      client.limits.maxMetadataBytes,
    );
    if (meta.kind === "error") throw new RelayError(meta.code);
    if (response.status !== 200 || meta.url !== request.url.href)
      throw new RelayError("relay-metadata");
    checkHeaders(meta.headers, client.limits.maxHeaderBytes);
    const empty =
      request.method === "HEAD" ||
      meta.status === 204 ||
      meta.status === 205 ||
      meta.status === 304;
    if (empty) await body?.cancel();
    const output = new Response(empty ? null : body, {
      status: meta.status,
      statusText: meta.statusText,
      headers: meta.headers,
    });
    attachNetFetchResponseMetadata(output, { targetURL: meta.url, redirected: false });
    return output;
  } catch (error) {
    const failure = job.controller.signal.aborted ? job.controller.signal.reason : redact(error);
    job.abort(failure);
    await body?.cancel(failure).catch(() => {});
    throw failure;
  } finally {
    job.finishSetup();
  }
}

function captureRequest(value: string, init: RequestInit): CapturedRequest {
  const method = methodFrom(init.method ?? "GET");
  const headers = new Headers(init.headers);
  const body = init.body ?? null;
  if (!headers.has("content-type")) {
    const inferred = bodyContentType(body);
    if (inferred !== null) headers.set("content-type", inferred);
  }
  const signal = init.signal ?? null;
  const redirect = init.redirect ?? "follow";
  if (redirect !== "manual" && redirect !== "follow" && redirect !== "error")
    throw new TypeError("Invalid redirect mode");
  if ((method === "GET" || method === "HEAD") && body !== null)
    throw new TypeError("GET and HEAD requests cannot have a body");
  return { url: targetURL(value), method, headers: Array.from(headers), body, signal, redirect };
}

function bodyContentType(body: BodyInit | null): string | null {
  let empty: BodyInit;
  if (typeof body === "string") empty = "";
  else if (body instanceof Blob) empty = new Blob([], { type: body.type });
  else if (body instanceof URLSearchParams) empty = new URLSearchParams();
  else return null;
  // Infer platform headers without copying or consuming the caller's payload.
  return new Request("https://localhost/", { method: "POST", body: empty }).headers.get(
    "content-type",
  );
}

function rememberManualHop(
  request: CapturedRequest,
  location: string,
  count: number,
  chains: WeakMap<AbortSignal, Chain>,
): void {
  if (!request.signal) return;
  try {
    const next = targetURL(new URL(location, request.url).href);
    chains.set(request.signal, { next: next.href, count: count + 1 });
  } catch {
    // Tracking a possible next hop must not reject an unfollowed response.
    return;
  }
}

function nextHop(
  request: CapturedRequest,
  chains: WeakMap<AbortSignal, Chain>,
  maxRedirects: number,
): number {
  const previous = request.signal ? chains.get(request.signal) : undefined;
  const count = previous?.next === request.url.href ? previous.count : 0;
  if (count > maxRedirects) throw new RelayError("redirect-denied");
  return count;
}

function redirectRequest(
  request: CapturedRequest,
  status: number,
  location: string,
): CapturedRequest {
  let url: URL;
  try {
    url = targetURL(new URL(location, request.url).href);
  } catch {
    throw new RelayError("redirect-denied");
  }
  const headers = new Headers(request.headers);
  if (url.origin !== request.url.origin) {
    for (const name of ["authorization", "cookie", "cookie2", "proxy-authorization"])
      headers.delete(name);
  }
  const discard =
    ((status === 301 || status === 302) && request.method === "POST") ||
    (status === 303 && request.method !== "GET" && request.method !== "HEAD");
  if (!discard && request.body instanceof ReadableStream) throw new RelayError("redirect-denied");
  if (discard) {
    for (const name of [
      "content-type",
      "content-length",
      "content-encoding",
      "content-language",
      "content-location",
    ])
      headers.delete(name);
  }
  return {
    ...request,
    url,
    headers: Array.from(headers),
    method: discard ? "GET" : request.method,
    body: discard ? null : request.body,
  };
}

function endpointURL(value: string | URL): string {
  const url = targetURL(String(value));
  if (url.search || (url.pathname !== "/" && url.pathname !== RELAY_PATH))
    throw new TypeError("Invalid relay endpoint path");
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new TypeError("Remote relay endpoints require HTTPS");
  url.pathname = RELAY_PATH;
  return url.href;
}

function redact(error: unknown): RelayError {
  return error instanceof RelayError ? error : new RelayError("relay-unavailable");
}

function uploadBody(body: BodyInit | null, job: Exchange, maximum: number): BodyInit | null {
  if (body === null) return null;
  if (body instanceof ReadableStream) return boundedStream(body, job, maximum, "request-limit");
  let size: number;
  if (typeof body === "string") {
    if (body.length > maximum) throw new RelayError("request-limit");
    size = new TextEncoder().encode(body).byteLength;
  } else if (body instanceof Blob) size = body.size;
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) size = body.byteLength;
  else if (body instanceof URLSearchParams)
    size = new TextEncoder().encode(body.toString()).byteLength;
  else
    throw new TypeError(
      "Relay body must be replayable bytes, text, a Blob, URLSearchParams, or a byte stream",
    );
  if (size > maximum) throw new RelayError("request-limit");
  return body;
}
