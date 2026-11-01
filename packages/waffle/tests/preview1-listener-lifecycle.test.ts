import { expect, test } from "bun:test";
import { NetHelper, NetNamespace } from "../browser/net/helper.js";
import type { RuntimeNetwork } from "../browser/net/runtime.js";
import { lookupAddress } from "../browser/net/address.js";
import { networkPeer } from "./network-worker-peer.js";
import { socketGuest, uint, type SocketGuest } from "./preview1-socket-support.js";

function ownedHandles(helper: NetHelper): number {
  let count = 0;
  for (const key of ["listeners", "sockets", "pending", "outbound", "connections"]) {
    const table: unknown = Reflect.get(helper, key);
    if (!(table instanceof Map)) throw Error(`missing helper ownership table ${key}`);
    count += table.size;
  }
  return count;
}

for (const accept of [false, true])
  test(`listener owner teardown releases every actual helper handle, accepted=${accept}`, async () => {
    const namespace = await NetNamespace.create();
    const helpers: NetHelper[] = [];
    const network: RuntimeNetwork = {
      lookup: lookupAddress,
      createHelper(options) {
        const helper = new NetHelper(options.ring, options.fetch, options.hooks, namespace);
        helpers.push(helper);
        return helper;
      },
    };
    const peer = networkPeer(network);
    let guest: SocketGuest | undefined;
    try {
      await peer.ready;
      guest = await socketGuest({
        network,
        bindings: [{ fd: 3, socket: { listen: { host: "localhost", port: 32163 } } }],
      });
      expect(await peer.call({ op: "connect", port: 32163 })).toBeGreaterThan(0);
      if (accept) {
        expect(await guest.call("sock_accept", 3, 0, 32)).toBe(0);
        expect(await guest.call("fd_kind", uint(await guest.read(32, 4)))).toBe(5);
      }
      expect(await peer.call({ op: "connect", port: 32163 })).toBeGreaterThan(0);
      expect(helpers.reduce((count, helper) => count + ownedHandles(helper), 0)).toBeGreaterThan(0);
      guest.network.dispose();
      expect(namespace.has(32163)).toBe(false);
    } finally {
      await guest?.close();
      peer.close();
      for (const helper of helpers) helper.dispose();
      expect(helpers.map(ownedHandles)).toEqual([0, 0]);
      expect(namespace.has(32163)).toBe(false);
      namespace.dispose();
    }
  });
