import { TcpFailure, type TcpTarget } from "./tcp-protocol.js";

/** The serialized object, not a host:port concatenation, is the scope identity. */
export function destinationKey(target: TcpTarget): string {
  return JSON.stringify(canonicalDestination(target));
}
export function canonicalDestination(target: TcpTarget): TcpTarget {
  const { host, port } = target;
  if (
    typeof host !== "string" ||
    !host ||
    host.length > 254 ||
    host.trim() !== host ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    /[/@?#%\\\s]/.test(host)
  )
    throw new TcpFailure("destination-denied");
  if (host.includes(":")) return { host: canonicalIPv6(host), port };
  let url: URL;
  try {
    url = new URL(`http://${host}/`);
  } catch {
    throw new TcpFailure("destination-denied");
  }
  const name = url.hostname.replace(/\.$/, "");
  if (url.port || !name || name.length > 253) throw new TcpFailure("destination-denied");
  if (/^[0-9.]+$/.test(name)) {
    if (name !== host.replace(/\.$/, "") || !/^\d+\.\d+\.\d+\.\d+$/.test(name))
      throw new TcpFailure("destination-denied");
    return { host: name, port };
  }
  if (name.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    throw new TcpFailure("destination-denied");
  return { host: name, port };
}
function canonicalIPv6(value: string): string {
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!/^[0-9a-f:.]+$/i.test(host)) throw new TcpFailure("destination-denied");
  let name: string;
  try {
    name = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    throw new TcpFailure("destination-denied");
  }
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(name);
  if (!mapped) return name;
  const first = parseInt(mapped[1]!, 16),
    second = parseInt(mapped[2]!, 16);
  return `${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`;
}

export function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TcpFailure("relay-origin");
  }
  if (!/^https?:$/.test(url.protocol) || url.origin === "null" || value !== url.origin)
    throw new TcpFailure("relay-origin");
  return value;
}
