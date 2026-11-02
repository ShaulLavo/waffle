export const RELAY_META_HEADER = "x-waffle-relay-meta";
export const RELAY_PATH = "/v1/fetch";
export const RELAY_LIMITS = Object.freeze({
  maxRequestBytes: 1 << 20,
  maxResponseBytes: 64 << 20,
  maxHeaderBytes: 32 << 10,
  maxMetadataBytes: 32 << 10,
  maxRedirects: 10,
  maxConcurrent: 16,
  idleTimeoutMs: 30_000,
});

export type RelayLimits = { readonly [K in keyof typeof RELAY_LIMITS]: number };
export type RelayDestinationPolicy =
  | { readonly mode: "fixed-origins"; readonly origins: readonly string[] }
  | { readonly mode: "public-https" };

export interface RelayCredentialProfile {
  readonly origin: string;
  readonly headers: readonly (readonly [string, string])[];
}

export interface RelayServerOptions {
  readonly credential: string;
  readonly allowedOrigins: readonly string[];
  /** Defaults to an empty fixed-origin allowlist. */
  readonly destinations?: RelayDestinationPolicy;
  /** Only this operator-owned configuration can attach target credentials. */
  readonly credentials?: readonly RelayCredentialProfile[];
  readonly limits?: Partial<RelayLimits>;
}

export interface RelayClientOptions {
  readonly endpoint: URL | string;
  readonly credential: string;
  readonly limits?: Partial<RelayLimits>;
  /** Trusted outer transport. Never pass a guest-supplied function. */
  readonly transport?: (url: string, options: RequestInit) => Promise<Response>;
}

export interface RelayFetchCapability {
  readonly fetch: (url: string, options?: RequestInit) => Promise<Response>;
  /** Fence new work synchronously, then abort owned exchanges. */
  revoke(reason?: unknown): void;
  /** Abort and join exchanges, retaining failed cleanup for another close attempt. */
  close(): Promise<void>;
}

export interface RelayHandler {
  readonly fetch: (request: Request) => Promise<Response>;
  revoke(reason?: unknown): void;
  close(): Promise<void>;
}

export interface RequestMeta {
  readonly version: 1;
  readonly method: string;
  readonly url: string;
  readonly headers: [string, string][];
}

export type ResponseMeta =
  | { readonly version: 1; readonly kind: "error"; readonly code: RelayErrorCode }
  | {
      readonly version: 1;
      readonly kind: "target";
      readonly status: number;
      readonly statusText: string;
      readonly url: string;
      readonly headers: [string, string][];
    };

export type RelayErrorCode =
  | "relay-auth"
  | "relay-origin"
  | "relay-method"
  | "relay-metadata"
  | "destination-denied"
  | "request-limit"
  | "response-limit"
  | "header-limit"
  | "concurrent-limit"
  | "redirect-denied"
  | "upstream-network"
  | "upstream-aborted"
  | "relay-unavailable";

export class RelayError extends Error {
  constructor(readonly code: RelayErrorCode) {
    super(code);
    this.name = "RelayError";
  }
}

export function limitsFrom(input: Partial<RelayLimits> | undefined): RelayLimits {
  const result = { ...RELAY_LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) {
    const minimum = key === "maxRedirects" ? 0 : key === "maxMetadataBytes" ? 256 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError("Invalid relay limit");
  }
  return Object.freeze(result);
}

export function encodeMeta(value: RequestMeta | ResponseMeta, maxBytes: number): string {
  const result = encodeURIComponent(JSON.stringify(value));
  if (result.length > maxBytes) throw new RelayError("header-limit");
  return result;
}

function parseMeta(value: string | null, maxBytes: number): unknown {
  if (!value || value.length > maxBytes) throw new RelayError("relay-metadata");
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    throw new RelayError("relay-metadata");
  }
}

export function requestMeta(value: string | null, maxBytes: number): RequestMeta {
  const raw = parseMeta(value, maxBytes);
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    typeof raw.method !== "string" ||
    typeof raw.url !== "string"
  )
    throw new RelayError("relay-metadata");
  return { version: 1, method: raw.method, url: raw.url, headers: headerPairs(raw.headers) };
}

export function responseMeta(value: string | null, maxBytes: number): ResponseMeta {
  const raw = parseMeta(value, maxBytes);
  if (!isRecord(raw) || raw.version !== 1) throw new RelayError("relay-metadata");
  if (raw.kind === "error" && isErrorCode(raw.code))
    return { version: 1, kind: "error", code: raw.code };
  if (raw.kind !== "target" || !Number.isInteger(raw.status) || typeof raw.status !== "number")
    throw new RelayError("relay-metadata");
  if (
    raw.status < 200 ||
    raw.status > 599 ||
    typeof raw.statusText !== "string" ||
    typeof raw.url !== "string"
  )
    throw new RelayError("relay-metadata");
  if (/[^\t\x20-\x7e\x80-\xff]/.test(raw.statusText)) throw new RelayError("relay-metadata");
  return {
    version: 1,
    kind: "target",
    status: raw.status,
    statusText: raw.statusText,
    url: raw.url,
    headers: headerPairs(raw.headers),
  };
}

export function headerPairs(value: unknown): [string, string][] {
  if (!Array.isArray(value)) throw new RelayError("relay-metadata");
  const result: [string, string][] = [];
  for (const pair of value) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    )
      throw new RelayError("relay-metadata");
    result.push([pair[0], pair[1]]);
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is RelayErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

const ERROR_CODES = new Set<string>([
  "relay-auth",
  "relay-origin",
  "relay-method",
  "relay-metadata",
  "destination-denied",
  "request-limit",
  "response-limit",
  "header-limit",
  "concurrent-limit",
  "redirect-denied",
  "upstream-network",
  "upstream-aborted",
  "relay-unavailable",
]);
