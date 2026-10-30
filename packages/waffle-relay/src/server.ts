import { Lifetime, type Exchange } from "./lifetime.js";
import { boundedStream } from "./stream.js";
import {
  encodeMeta,
  RELAY_META_HEADER,
  RELAY_PATH,
  requestMeta,
  RelayError,
  type RelayHandler,
  type RelayServerOptions,
  type ResponseMeta,
  type RequestMeta,
} from "./protocol.js";
import {
  admitDestination,
  checkHeaders,
  methodFrom,
  normalizeOptions,
  requestHeaders,
  responseHeaders,
  targetURL,
  type Policy,
} from "./policy.js";

/** Adapter-only contract. Each call performs exactly one hop and returns decoded bytes. */
export interface Egress {
  fetch(
    url: URL,
    init: {
      method: string;
      headers: Headers;
      body: ReadableStream<Uint8Array> | null;
      signal: AbortSignal;
    },
    job: Exchange,
  ): Promise<Response>;
}

/** Shared authentication, policy, protocol, streaming, and lifetime implementation. */
export function createRelayHandler(options: RelayServerOptions, egress: Egress): RelayHandler {
  const policy = normalizeOptions(options);
  const lifetime = new Lifetime(policy.limits);
  const key = secretKey(policy.credential);
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const origin = request.headers.get("origin");
      try {
        lifetime.assertLive();
        checkEnvelope(request, policy, origin);
        if (request.method === "OPTIONS") return outerResponse(null, policy, origin, 204);
        if (!(await authenticates(request.headers.get("authorization") ?? "", key)))
          throw new RelayError("relay-auth");
        lifetime.assertLive();
        const meta = requestMeta(
          request.headers.get(RELAY_META_HEADER),
          policy.limits.maxMetadataBytes,
        );
        const url = targetURL(meta.url);
        admitDestination(url, policy.destinations);
        const method = methodFrom(meta.method);
        const headers = requestHeaders(meta.headers, url, policy);
        const job = lifetime.admit(request.signal);
        return exchange(request, { ...meta, method }, url, headers, policy, egress, job, origin);
      } catch (error) {
        return failureResponse(error, policy, origin);
      }
    },
    revoke: (reason?: unknown) => lifetime.revoke(reason),
    close: () => lifetime.close(),
  });
}

async function exchange(
  request: Request,
  meta: RequestMeta,
  url: URL,
  headers: Headers,
  policy: Policy,
  egress: Egress,
  job: Exchange,
  origin: string | null,
): Promise<Response> {
  let upstream: Response | undefined;
  try {
    job.controller.signal.throwIfAborted();
    const body = await requestBody(request, meta.method, job, policy.limits.maxRequestBytes);
    upstream = await egress.fetch(
      url,
      { method: meta.method, headers, body, signal: job.controller.signal },
      job,
    );
    const responseBody = boundedStream(
      upstream.body,
      job,
      policy.limits.maxResponseBytes,
      "response-limit",
      true,
    );
    if (job.controller.signal.aborted) throw job.controller.signal.reason;
    const safeHeaders = responseHeaders(Array.from(upstream.headers), policy.limits.maxHeaderBytes);
    const metadata: ResponseMeta = {
      version: 1,
      kind: "target",
      status: upstream.status,
      statusText: upstream.statusText,
      url: url.href,
      headers: safeHeaders,
    };
    // Metadata is created here, never copied from an upstream response header or response.url.
    const encoded = encodeMeta(metadata, policy.limits.maxMetadataBytes);
    const response = outerResponse(responseBody, policy, origin, 200);
    response.headers.set(RELAY_META_HEADER, encoded);
    return response;
  } catch (error) {
    job.abort(error);
    if (upstream && !upstream.body?.locked) await upstream.body?.cancel().catch(() => {});
    return failureResponse(error, policy, origin);
  } finally {
    job.finishSetup();
  }
}

function checkEnvelope(request: Request, policy: Policy, origin: string | null): void {
  const url = new URL(request.url);
  if (url.pathname !== RELAY_PATH || url.search) throw new RelayError("relay-unavailable");
  if (origin !== null && !policy.allowedOrigins.includes(origin))
    throw new RelayError("relay-origin");
  if (request.method !== "POST" && request.method !== "OPTIONS")
    throw new RelayError("relay-method");
  checkHeaders(
    Array.from(request.headers),
    policy.limits.maxHeaderBytes + policy.limits.maxMetadataBytes + 8192,
  );
}

function outerResponse(
  body: ReadableStream<Uint8Array> | null,
  policy: Policy,
  origin: string | null,
  status: number,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    vary: "Origin",
    "content-type": "application/octet-stream",
  });
  if (origin !== null && policy.allowedOrigins.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "POST, OPTIONS");
    headers.set("access-control-allow-headers", `authorization, ${RELAY_META_HEADER}`);
    headers.set("access-control-expose-headers", RELAY_META_HEADER);
  }
  return new Response(body, { status, headers });
}

function failureResponse(error: unknown, policy: Policy, origin: string | null): Response {
  const code = error instanceof RelayError ? error.code : "upstream-network";
  const response = outerResponse(null, policy, origin, code === "relay-auth" ? 401 : 400);
  response.headers.set(
    RELAY_META_HEADER,
    encodeMeta({ version: 1, kind: "error", code }, policy.limits.maxMetadataBytes),
  );
  return response;
}

function secretKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function authenticates(value: string, key: Promise<CryptoKey>): Promise<boolean> {
  const selected = await key;
  const message = new Uint8Array(32);
  const expected = await crypto.subtle.sign("HMAC", selected, message);
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  const candidate = await secretKey(supplied || "invalid-credential");
  return crypto.subtle.verify("HMAC", candidate, expected, message);
}

async function requestBody(
  request: Request,
  method: string,
  job: Exchange,
  maximum: number,
): Promise<ReadableStream<Uint8Array> | null> {
  const empty = method === "GET" || method === "HEAD";
  const body = boundedStream(request.body, job, empty ? 0 : maximum, "request-limit", true);
  if (!empty || !body) return body;
  const reader = body.getReader();
  try {
    for (;;) {
      if ((await reader.read()).done) return null;
    }
  } finally {
    reader.releaseLock();
  }
}
