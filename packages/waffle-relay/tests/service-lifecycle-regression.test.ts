import { expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { createNodeServer } from "../src/node-server.js";
import { WebTransportLifecycle } from "../src/webtransport-lifecycle.js";

function fixture() {
  let wall = 100000;
  let monoOffset = 0;
  let generations = 0;
  let scheduled = () => {};
  const owner = new WebTransportLifecycle(
    {
      rotationMs: 1000,
      hashMode: true,
      certificate: async () => {
        if (++generations === 2) {
          monoOffset = 11900;
          throw new Error("generation failed with 100 ms remaining");
        }
        return {
          cert: "fixture",
          key: "fixture",
          starts: wall,
          expires: wall + 13 * 86400000,
          hash: { algorithm: "sha-256", value: "fixture" },
        };
      },
      construct: () => {
        const closed = Promise.withResolvers<void>();
        return {
          ready: Promise.resolve(),
          closed: closed.promise,
          start() {},
          fence() {},
          stop() {
            closed.resolve();
            return closed.promise;
          },
        };
      },
      discovery: () => ({ url: "https://127.0.0.1:4433/v1/tcp/wt" }),
      log() {},
    },
    {
      wallNow: () => wall,
      monotonicNow: () => performance.now() + monoOffset,
      scheduleCheck(callback) {
        scheduled = callback;
        return () => {};
      },
      endpointStateChanged() {},
    },
  );
  const relay = createNodeServer(
    {
      credential: "separate-http-fixture",
      allowedOrigins: ["http://localhost:3000"],
      tcp: { tokenSecret: new Uint8Array(32), log() {} },
    },
    () => ({
      ready: owner.ready,
      failure: owner.failure,
      counters: [],
      discovery: () => owner.discovery(),
      status: () => owner.status(),
      closeBudget: () => owner.closeBudget(),
      revoke: () => owner.revoke(),
      close: () => owner.close(),
    }),
  );
  let socket: Socket | undefined;
  return {
    owner,
    relay,
    fail() {
      wall += 1001;
      scheduled();
    },
    expire() {
      monoOffset += 1000;
    },
    async connect() {
      await relay.tcp!.ready;
      relay.server.listen(0, "127.0.0.1");
      await once(relay.server, "listening");
      const address = relay.server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture listener");
      socket = createConnection(address.port, "127.0.0.1");
      socket.on("error", () => {});
      await once(socket, "connect");
      const upgraded = once(socket, "data");
      socket.write(
        "GET /v1/tcp HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost:3000\r\n\r\n",
      );
      const [reply] = await upgraded;
      expect(reply.toString()).toContain("101");
      socket.on("data", () => {});
      expect(relay.tcp!.active).toBe(1);
    },
    async cleanup() {
      if (socket && !socket.destroyed) {
        const ended = once(socket, "close");
        socket.destroy();
        await ended;
      }
      await relay.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(relay.server.listening).toBe(false);
      expect(socket?.destroyed).toBe(true);
      expect(owner.status().ownedEndpoints).toBe(0);
    },
  };
}

test.each([false, true])(
  "enclosing relay close inherits the fatal budget, expired=%s",
  async (expired) => {
    const run = fixture();
    try {
      await run.connect();
      run.fail();
      await run.owner.failure;
      if (expired) run.expire();
      const started = performance.now();
      const closing = run.relay.close();
      const error = await closing.then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsedMs = performance.now() - started;
      if (expired) expect(error).toBeInstanceOf(Error);
      expect(elapsedMs).toBeLessThan(500);
      expect(run.relay.close()).toBe(closing);
      if (error) await expect(run.relay.close()).rejects.toBe(error);
      else {
        expect(run.relay.tcp!.active).toBe(0);
        expect(run.relay.tcp!.counters).toHaveLength(0);
      }
      if (expired) {
        expect(run.relay.tcp!.active).toBe(1);
        expect(run.relay.tcp!.counters).toHaveLength(1);
      }
      console.info(
        JSON.stringify({
          proof: "enclosing-relay-budget",
          expired,
          elapsedMs,
          failed: error !== undefined,
          active: run.relay.tcp!.active,
        }),
      );
    } finally {
      await run.cleanup();
    }
  },
);
