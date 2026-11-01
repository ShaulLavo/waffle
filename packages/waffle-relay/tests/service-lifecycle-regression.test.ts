import { expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { createNodeServer } from "../src/node-server.js";
import { WebTransportLifecycle } from "../src/webtransport-lifecycle.js";

function ownerFixture() {
  let wall = 100000;
  let monoOffset = 0;
  let generations = 0;
  let scheduled = () => {};
  const owner = new WebTransportLifecycle({
    rotationMs: 1000,
    hashMode: true,
    certificate: async () => {
      if (++generations === 2) {
        monoOffset = 11900;
        throw new Error("generation failed with 100 ms remaining");
      }
      return { cert: "fixture", key: "fixture", starts: wall, expires: wall + 13 * 86400000, hash: { algorithm: "sha-256", value: "fixture" } };
    },
    construct: () => {
      const closed = Promise.withResolvers<void>();
      return { ready: Promise.resolve(), closed: closed.promise, start() {}, fence() {}, stop() { closed.resolve(); return closed.promise; } };
    },
    discovery: () => ({ url: "https://127.0.0.1:4433/v1/tcp/wt" }),
    log() {},
  }, {
    wallNow: () => wall,
    monotonicNow: () => performance.now() + monoOffset,
    scheduleCheck(callback) { scheduled = callback; return () => {}; },
    endpointStateChanged() {},
  });
  return { owner, fail() { wall += 1001; scheduled(); } };
}

test("CLI's enclosing relay close respects the failed operation's remaining budget", async () => {
  const run = ownerFixture();
  const relay = createNodeServer({ credential: "separate-http-fixture", allowedOrigins: ["http://localhost:3000"], tcp: { tokenSecret: new Uint8Array(32) } }, () => ({
    ready: run.owner.ready,
    failure: run.owner.failure,
    counters: [],
    discovery: () => run.owner.discovery(),
    status: () => run.owner.status(),
    revoke: () => run.owner.revoke(),
    close: () => run.owner.close(),
  }));
  let socket: Socket | undefined;
  try {
    await relay.tcp!.ready;
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const address = relay.server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture listener");
    socket = createConnection(address.port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    const upgraded = once(socket, "data");
    socket.write("GET /v1/tcp HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost:3000\r\n\r\n");
    const [reply] = await upgraded;
    expect(reply.toString()).toContain("101");
    socket.on("data", () => {});
    expect(relay.tcp!.active).toBe(1);
    run.fail();
    await run.owner.failure;
    const started = performance.now();
    await relay.close();
    const elapsedMs = performance.now() - started;
    console.log(JSON.stringify({ proof: "outer-relay-close-budget", remainingAtFailureMs: 100, elapsedMs, active: relay.tcp!.active, listening: relay.server.listening, nativeStatus: run.owner.status() }));
    expect(elapsedMs).toBeLessThan(1000);
  } finally {
    if (socket && !socket.destroyed) {
      const ended = once(socket, "close");
      socket.destroy();
      await ended;
    }
    await relay.close().catch(() => {});
    expect(relay.server.listening).toBe(false);
    expect(relay.tcp!.active).toBe(0);
  }
}, 10000);
