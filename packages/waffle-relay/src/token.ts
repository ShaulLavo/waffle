import { canonicalDestination } from "./tcp-destination.js";
import { record, TcpFailure, type TcpTarget } from "./tcp-protocol.js";

export interface RelayTokenClaims {
  readonly exp: number;
  readonly sub?: string;
  readonly dst?: readonly TcpTarget[];
}
const encoder = new TextEncoder();
const prefix = "waffle-relay-tcp-v1.";
export function tokenKey(secret: Uint8Array | string): Promise<CryptoKey> {
  const bytes = typeof secret === "string" ? encoder.encode(secret) : secret;
  if (bytes.length < 32) throw new TypeError("TCP token secret must contain at least 32 bytes");
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function claimsFrom(value: unknown, now: number): RelayTokenClaims {
  if (
    !record(value) ||
    typeof value.exp !== "number" ||
    !Number.isSafeInteger(value.exp) ||
    value.exp <= now ||
    value.exp > now + 86400
  )
    throw new TcpFailure("relay-auth");
  if (
    value.sub !== undefined &&
    (typeof value.sub !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value.sub))
  )
    throw new TcpFailure("relay-auth");
  if (value.dst !== undefined && (!Array.isArray(value.dst) || value.dst.length > 128))
    throw new TcpFailure("relay-auth");
  const dst = value.dst?.map((entry: unknown) => {
    if (!record(entry) || typeof entry.host !== "string" || typeof entry.port !== "number")
      throw new TcpFailure("relay-auth");
    return canonicalDestination({ host: entry.host, port: entry.port });
  });
  return {
    exp: value.exp,
    ...(typeof value.sub === "string" ? { sub: value.sub } : {}),
    ...(dst ? { dst } : {}),
  };
}
export async function mintRelayToken(
  secret: Uint8Array | string,
  claims: RelayTokenClaims,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claimsFrom(claims, now))));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await tokenKey(secret),
    encoder.encode(prefix + payload),
  );
  return `v1.${payload}.${base64url(new Uint8Array(signature))}`;
}
export async function verifyRelayToken(
  key: CryptoKey,
  token: string,
  now = Math.floor(Date.now() / 1000),
): Promise<RelayTokenClaims> {
  try {
    if (token.length > 8192) throw new TcpFailure("relay-auth");
    const parts = token.split(".");
    const payload = parts[1],
      signature = parts[2];
    if (parts.length !== 3 || parts[0] !== "v1" || !payload || !signature)
      throw new TcpFailure("relay-auth");
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        decode64(signature),
        encoder.encode(prefix + payload),
      ))
    )
      throw new TcpFailure("relay-auth");
    return claimsFrom(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode64(payload))),
      now,
    );
  } catch {
    throw new TcpFailure("relay-auth");
  }
}
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TcpFailure("relay-auth");
  const result = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );
  if (base64url(result) !== value) throw new TcpFailure("relay-auth");
  return result;
}
