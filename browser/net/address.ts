import type { PeerAddr } from "./protocol.js";

type TcpAddress = Omit<PeerAddr, "port">;

export function tcpAddress(host: string): TcpAddress | undefined {
  if (host === "localhost" || host === "127.0.0.1")
    return { address: "127.0.0.1", family: "IPv4" };
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
