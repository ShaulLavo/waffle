import { expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { createNodeRelayServer } from "../src/node.ts";

test("repeated server close joins the same physical shutdown", async () => {
  const relay = createNodeRelayServer({
    credential: "owned-local-close-fixture",
    allowedOrigins: [],
  });
  let peer: Socket | undefined;
  let closing: Promise<void> | undefined;
  try {
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const address = relay.server.address();
    if (!address || typeof address === "string") throw new Error("Expected an owned port");
    const accepted = once(relay.server, "connection");
    peer = createConnection({ host: "127.0.0.1", port: address.port });
    await accepted;
    let closed = false;
    relay.server.once("close", () => {
      closed = true;
    });
    closing = relay.close();
    const repeated = relay.close();
    expect(repeated).toBe(closing);
    await repeated;
    expect(closed).toBe(true);
    expect(relay.server.listening).toBe(false);
    expect(relay.close()).toBe(closing);
  } finally {
    peer?.destroy();
    await closing;
    await relay.close();
  }
});
