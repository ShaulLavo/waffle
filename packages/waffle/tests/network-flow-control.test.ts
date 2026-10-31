import { expect, test } from "bun:test";
import { NetNamespace } from "../browser/net/helper.js";
import { networkPeer as peer } from "./network-worker-peer.js";
import { networkFlowCases } from "./network-flow-cases.js";

test("actual Worker failed publication rolls back its listener before a healthy retry", async () => {
  const namespace = await NetNamespace.create();
  const bad = peer(namespace, {
    listening() {
      throw Error("Observer failed");
    },
  });
  const good = peer(namespace);
  try {
    await Promise.all([bad.ready, good.ready]);
    expect(await bad.call({ op: "listen", port: 32206 })).toBe(-1);
    expect(await good.call({ op: "listen", port: 32206 })).toBeGreaterThan(0);
    expect(bad.failures).toEqual(["Error: Observer failed"]);
  } finally {
    bad.close();
    good.close();
    namespace.dispose();
  }
}, 5000);

test.each([false, true])(
  "actual Worker HTTP credit, read wakeups, EOF and cancellation, same helper=%s",
  async (sameHelper) => {
    const namespace = await NetNamespace.create();
    const server = peer(namespace),
      client = sameHelper ? server : peer(namespace);
    try {
      await Promise.all([server.ready, client.ready]);
      const acceptedWithoutReads = await networkFlowCases(server, client, 32207);
      expect(acceptedWithoutReads).toBeLessThanOrEqual((1 << 20) + (512 << 10));
    } finally {
      server.close();
      client.close();
      namespace.dispose();
    }
  },
  5000,
);
