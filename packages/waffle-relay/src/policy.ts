import {
  limitsFrom,
  RelayError,
  type RelayCredentialProfile,
  type RelayDestinationPolicy,
  type RelayServerOptions,
} from "./protocol.js";

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);
const REQUEST_PRIVATE = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "host",
  "origin",
  "referer",
  "content-length",
  "accept-encoding",
  "forwarded",
  "via",
  "expect",
]);

export function targetURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError("destination-denied");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash)
    throw new RelayError("destination-denied");
  return url;
}

export function exactOrigin(value: string): string {
  const url = targetURL(value);
  if (url.href !== `${url.origin}/`) throw new TypeError("Expected an exact HTTP origin");
  return url.origin;
}

export function methodFrom(value: string): string {
  const method = value.toUpperCase();
  if (!METHODS.has(method)) throw new RelayError("relay-method");
  return method;
}

export function normalizeOptions(options: RelayServerOptions) {
  const credential = credentialFrom(options.credential);
  const allowedOrigins = options.allowedOrigins.map(exactOrigin);
  const selected = options.destinations ?? { mode: "fixed-origins", origins: [] };
  const destinations: RelayDestinationPolicy =
    selected.mode === "fixed-origins"
      ? { mode: "fixed-origins", origins: selected.origins.map(exactOrigin) }
      : { mode: "public-https" };
  const credentials = (options.credentials ?? []).map(credentialProfile);
  const limits = limitsFrom(options.limits);
  return Object.freeze({ credential, allowedOrigins, destinations, credentials, limits });
}
export type Policy = ReturnType<typeof normalizeOptions>;

export function credentialFrom(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    throw new TypeError("Relay credential must be 16 to 4096 printable ASCII characters");
  return value;
}

export function admitDestination(url: URL, policy: RelayDestinationPolicy): void {
  if (policy.mode === "fixed-origins") {
    if (!policy.origins.includes(url.origin)) throw new RelayError("destination-denied");
    return;
  }
  if (url.protocol !== "https:") throw new RelayError("destination-denied");
}

export function requestHeaders(
  pairs: readonly (readonly [string, string])[],
  url: URL,
  policy: Policy,
): Headers {
  checkHeaders(pairs, policy.limits.maxHeaderBytes);
  const result = new Headers();
  const connection = connectionHeaders(pairs);
  for (const [name, value] of pairs) {
    if (deniedRequestHeader(name, connection)) continue;
    result.append(name, value);
  }
  const profile = policy.credentials.find((entry) => entry.origin === url.origin);
  for (const [name, value] of profile?.headers ?? []) result.set(name, value);
  result.set("accept-encoding", "identity");
  checkHeaders(Array.from(result), policy.limits.maxHeaderBytes);
  return result;
}

export function responseHeaders(
  pairs: readonly (readonly [string, string])[],
  maxBytes: number,
): [string, string][] {
  checkHeaders(pairs, maxBytes);
  const connection = connectionHeaders(pairs);
  return pairs
    .filter(([name]) => {
      const lower = name.toLowerCase();
      return (
        !HOP_HEADERS.has(lower) &&
        !connection.has(lower) &&
        !lower.startsWith("x-waffle-relay-") &&
        lower !== "set-cookie" &&
        lower !== "set-cookie2" &&
        lower !== "content-length" &&
        lower !== "content-encoding"
      );
    })
    .map(([name, value]) => [name, value]);
}

export function checkHeaders(
  pairs: readonly (readonly [string, string])[],
  maxBytes: number,
): void {
  let size = 0;
  for (const [name, value] of pairs) {
    if (!TOKEN.test(name) || Array.from(value).some(invalidHeaderCharacter))
      throw new RelayError("relay-metadata");
    size += new TextEncoder().encode(name + value).byteLength + 4;
    if (size > maxBytes) throw new RelayError("header-limit");
  }
}

function deniedRequestHeader(name: string, connection: Set<string>): boolean {
  const lower = name.toLowerCase();
  return (
    REQUEST_PRIVATE.has(lower) ||
    HOP_HEADERS.has(lower) ||
    connection.has(lower) ||
    /^(proxy-|sec-|x-forwarded-|x-waffle-relay-)/.test(lower)
  );
}

function connectionHeaders(pairs: readonly (readonly [string, string])[]): Set<string> {
  return new Set(
    pairs
      .filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) =>
        value
          .toLowerCase()
          .split(",")
          .map((part) => part.trim()),
      ),
  );
}

function credentialProfile(profile: RelayCredentialProfile): RelayCredentialProfile {
  const origin = exactOrigin(profile.origin);
  const headers: [string, string][] = profile.headers.map(([name, value]) => [name, value]);
  checkHeaders(headers, 32 << 10);
  if (
    headers.some(
      ([name]) =>
        HOP_HEADERS.has(name.toLowerCase()) || /^(host|content-length|x-waffle-relay-)/i.test(name),
    )
  )
    throw new TypeError("Invalid credential profile header");
  return { origin, headers };
}

function invalidHeaderCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return (code < 32 && code !== 9) || code === 127;
}
