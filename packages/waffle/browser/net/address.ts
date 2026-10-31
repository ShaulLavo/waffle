import type { PeerAddr } from "./protocol.js";

type TcpAddress = Omit<PeerAddr, "port">;

type RuntimeNetworkLookupFamily = 0 | 4 | 6;

export interface RuntimeNetworkLookupOptions {
  readonly family?: RuntimeNetworkLookupFamily;
  readonly hints?: number;
}

export interface RuntimeNetworkLookupResult {
  address: string;
  family: 4 | 6;
}

export type RuntimeNetworkLookupErrorCode = "ENOTFOUND" | "ENOTSUP";

export class RuntimeNetworkLookupError extends Error {
  readonly code: RuntimeNetworkLookupErrorCode;
  readonly syscall = "getaddrinfo";
  readonly hostname: string;

  constructor(code: RuntimeNetworkLookupErrorCode, hostname: string, message: string) {
    super(message);
    this.name = "RuntimeNetworkLookupError";
    this.code = code;
    this.hostname = hostname;
  }
}

const IPV4_LOOPBACK_RESULTS = [
  { address: "127.0.0.1", family: 4 },
] as const satisfies readonly RuntimeNetworkLookupResult[];
const IPV6_LOOPBACK_RESULTS = [
  { address: "::1", family: 6 },
] as const satisfies readonly RuntimeNetworkLookupResult[];

function addressesForHostname(hostname: string): readonly RuntimeNetworkLookupResult[] | undefined {
  switch (hostname) {
    case "localhost":
      return IPV4_LOOPBACK_RESULTS;
    case "127.0.0.1":
      return IPV4_LOOPBACK_RESULTS;
    case "::1":
      return IPV6_LOOPBACK_RESULTS;
    default:
      return undefined;
  }
}

function copyResults(results: readonly RuntimeNetworkLookupResult[]): RuntimeNetworkLookupResult[] {
  return results.map((result) => ({ ...result }));
}

function unsupported(hostname: string, reason: string): RuntimeNetworkLookupError {
  return new RuntimeNetworkLookupError("ENOTSUP", hostname, reason);
}

function missing(hostname: string, family: RuntimeNetworkLookupFamily): RuntimeNetworkLookupError {
  return new RuntimeNetworkLookupError(
    "ENOTFOUND",
    hostname,
    `No ${family === 4 ? "IPv4" : "IPv6"} address found for ${hostname}`,
  );
}

export function lookupAddress(
  hostname: string,
  options: RuntimeNetworkLookupOptions = {},
): RuntimeNetworkLookupResult[] {
  if (typeof hostname !== "string" || hostname.length === 0)
    throw new TypeError("Lookup hostname must be a nonempty string");
  const family = options.family ?? 0;
  if (family !== 0 && family !== 4 && family !== 6)
    throw new TypeError("Lookup family must be 0, 4, or 6");
  const hints = options.hints ?? 0;
  if (hints !== 0) throw unsupported(hostname, "Lookup hints are not supported");

  const addresses = addressesForHostname(hostname);
  if (!addresses) throw unsupported(hostname, `Lookup is not supported for ${hostname}`);
  if (family === 0) return copyResults(addresses);
  const filtered = addresses.filter((result) => result.family === family);
  if (filtered.length === 0) throw missing(hostname, family);
  return copyResults(filtered);
}

export function tcpAddress(host: string): TcpAddress | undefined {
  if (host === "localhost" || host === "127.0.0.1") return { address: "127.0.0.1", family: "IPv4" };
  if (host === "0.0.0.0") return { address: host, family: "IPv4" };
  if (!/^[\da-f:]+$/i.test(host)) return undefined;
  try {
    const address = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    if (address === "::" || address === "::1") return { address, family: "IPv6" };
  } catch {
    return undefined;
  }
  return undefined;
}

export function loopbackAddress(address: TcpAddress): TcpAddress {
  return { address: address.family === "IPv6" ? "::1" : "127.0.0.1", family: address.family };
}

export function acceptedAddress(bind: TcpAddress, target: TcpAddress): TcpAddress | undefined {
  if (bind.family === target.family) return loopbackAddress(target);
  if (bind.address === "::") return { address: "::ffff:127.0.0.1", family: "IPv6" };
  return undefined;
}
