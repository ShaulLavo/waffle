import { BlockList, isIP } from "node:net";
import { RelayError } from "./protocol.js";

// Conservative global-unicast policy, including documentation, transition and metadata ranges.
const denied4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] satisfies [string, number][])
  denied4.addSubnet(network, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const denied6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] satisfies [string, number][])
  denied6.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied4.check(address, "ipv4");
  return family === 6 && global6.check(address, "ipv6") && !denied6.check(address, "ipv6");
}

export function requirePublicAddresses(addresses: readonly { address: string }[]): void {
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new RelayError("destination-denied");
}
