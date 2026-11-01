import { isIP } from "node:net";

export const WEBTRANSPORT_PATH = "/v1/tcp/wt";

export interface WebTransportBind {
  readonly host: string;
  readonly port: number;
}

export interface WebTransportAddressOptions {
  readonly bind: WebTransportBind;
  readonly advertisedUrl?: string | URL;
}

export interface WebTransportAddressSnapshot {
  readonly bind: WebTransportBind;
  readonly advertisedUrl: string;
  readonly advertisedHostname: string;
}

interface IpIdentity {
  readonly family: 4 | 6;
  readonly value: string;
  readonly loopback: boolean;
  readonly unspecified: boolean;
}

export function snapshotWebTransportAddress(
  options: WebTransportAddressOptions,
): WebTransportAddressSnapshot {
  const bind = parseBind(options.bind);
  const advertised = parseAdvertised(options.advertisedUrl, bind);
  return Object.freeze({
    bind: Object.freeze(bind),
    advertisedUrl: advertised.url,
    advertisedHostname: advertised.hostname,
  });
}

function parseBind(value: WebTransportBind): WebTransportBind {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("WebTransport bind requires a numeric address and port");
  if (Object.keys(value).some((key) => key !== "host" && key !== "port"))
    throw new TypeError("Unknown WebTransport bind field");
  const { host, port } = value;
  if (typeof host !== "string")
    throw new TypeError("WebTransport bind requires a numeric address and port");
  const identity = parseIp(host);
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new TypeError("WebTransport bind requires a port from 1 through 65535");
  return { host: identity.value, port };
}

function parseAdvertised(
  value: string | URL | undefined,
  bind: WebTransportBind,
): { readonly url: string; readonly hostname: string } {
  if (value === undefined) {
    const bindIdentity = parseIp(bind.host);
    if (!bindIdentity.loopback)
      throw new TypeError("WebTransport advertisedUrl is required for a non-loopback bind");
    return {
      url: serializeUrl(bindIdentity.value, bind.port),
      hostname: bindIdentity.value,
    };
  }
  if (typeof value !== "string" && !(value instanceof URL))
    throw new TypeError("WebTransport advertisedUrl must be a URL");
  const serialized = typeof value === "string" ? value : value.href;
  if (serialized.includes("?") || serialized.includes("#"))
    throw new TypeError("WebTransport advertisedUrl cannot contain a query or fragment");
  let url: URL;
  try {
    url = new URL(serialized);
  } catch {
    throw new TypeError("Invalid WebTransport advertisedUrl");
  }
  if (url.protocol !== "https:") throw new TypeError("WebTransport advertisedUrl must use HTTPS");
  if (url.username || url.password)
    throw new TypeError("WebTransport advertisedUrl cannot contain credentials");
  if (url.pathname !== WEBTRANSPORT_PATH)
    throw new TypeError("WebTransport advertisedUrl must use the native endpoint path");
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new TypeError("WebTransport advertisedUrl has an invalid port");
  const hostname = normalizeHostname(url.hostname);
  return { url: url.href, hostname };
}

function normalizeHostname(value: string): string {
  const hostname = unbracket(value);
  if (!hostname || hostname.includes("%"))
    throw new TypeError("WebTransport advertisedUrl has an invalid hostname");
  const family = isIP(hostname);
  if (!family) return hostname;
  const identity = parseIp(hostname);
  if (identity.unspecified)
    throw new TypeError("WebTransport advertisedUrl cannot use an unspecified address");
  return identity.value;
}

function parseIp(value: string): IpIdentity {
  if (value.includes("%")) throw new TypeError("WebTransport address cannot use a scoped IP");
  const family = isIP(value);
  if (family !== 4 && family !== 6)
    throw new TypeError("WebTransport bind requires a numeric IPv4 or IPv6 address");
  if (family === 4) {
    return {
      family,
      value,
      loopback: value.split(".")[0] === "127",
      unspecified: value === "0.0.0.0",
    };
  }
  const canonical = canonicalIpv6(value);
  if (canonical.startsWith("::ffff:"))
    throw new TypeError("WebTransport address cannot use an IPv4-mapped IPv6 address");
  return {
    family,
    value: canonical,
    loopback: canonical === "::1",
    unspecified: canonical === "::",
  };
}

function canonicalIpv6(value: string): string {
  let url: URL;
  try {
    url = new URL(`https://[${value}]/`);
  } catch {
    throw new TypeError("WebTransport address has an invalid IPv6 literal");
  }
  return unbracket(url.hostname).toLowerCase();
}

function unbracket(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function serializeUrl(host: string, port: number): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `https://${authority}:${port}${WEBTRANSPORT_PATH}`;
}
