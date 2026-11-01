import assert from "node:assert/strict";
import { once } from "node:events";
import { createSocket } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import { createNodeRelayServer, type TcpLog } from "../../waffle-relay/src/node.js";
import { mintRelayToken } from "../../waffle-relay/src/token.js";
import type { RelayBrowserConfig, RelayModeResult } from "./network-relay-contract.js";

export function createRelayBrowserFixture() {
  const sockets = new Set<Socket>();
  const servers = new Set<Server>();
  const logs: TcpLog[] = [];
  const received = { echo: 0, ssl: 0 };
  let relay: ReturnType<typeof createNodeRelayServer> | undefined;
  let config: RelayBrowserConfig | undefined;
  let closing: Promise<void> | undefined;
  let nativePort: number | undefined;
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  };
  const echo = createServer({ allowHalfOpen: true }, (socket) => {
    own(socket);
    echoBytes(socket, (count) => {
      received.echo += count;
    });
  });
  const ssl = createServer({ allowHalfOpen: true }, (socket) => {
    own(socket);
    let request = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      received.ssl += chunk.length;
      request = Buffer.concat([request, chunk]);
      if (request.length < 8) return;
      if (!request.equals(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]))) socket.resetAndDestroy();
      else socket.end("N");
    });
    socket.on("end", () => socket.end());
  });
  servers.add(echo);
  servers.add(ssl);
  const close = () => (closing ??= teardown());
  async function teardown(): Promise<void> {
    const results = await Promise.allSettled([relay?.close()]);
    await Promise.all(Array.from(sockets, destroy));
    await Promise.all(Array.from(servers, stopServer));
    assert.equal(sockets.size, 0, "target sockets remain after fixture disposal");
    assert.equal(relay?.tcp?.active ?? 0, 0, "relay admissions remain after fixture disposal");
    assert.ok(Array.from(servers).every((server) => !server.listening));
    assert.ok(!relay?.server.listening, "relay HTTP listener remains");
    if (nativePort !== undefined) await assertUdpReleased(nativePort);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Relay browser fixture cleanup failed");
    console.log(
      JSON.stringify({
        cleanup: "network-relay",
        sockets: sockets.size,
        active: relay?.tcp?.active ?? 0,
        listeners: 0,
        udpReleased: nativePort !== undefined,
        received,
      }),
    );
  }
  return {
    close,
    async start(origin: string, native: boolean): Promise<RelayBrowserConfig> {
      const echoPort = await listen(echo);
      const sslPort = await listen(ssl);
      const refused = createServer();
      servers.add(refused);
      const refusedPort = await listen(refused);
      await stopServer(refused);
      const targets = {
        echo: { host: "echo.waffle.test", port: 9000 },
        ssl: { host: "ssl.waffle.test", port: 5432 },
        refused: { host: "refused.waffle.test", port: 9001 },
        denied: { host: "denied.waffle.test", port: 9002 },
      };
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const tcp = {
        tokenSecret: secret,
        destinations: [
          { ...targets.echo, connect: { host: "127.0.0.1", port: echoPort } },
          { ...targets.ssl, connect: { host: "127.0.0.1", port: sslPort } },
          { ...targets.refused, connect: { host: "127.0.0.1", port: refusedPort } },
        ],
        log: (entry: TcpLog) => logs.push(entry),
      };
      const options = { credential: "browser-fixture-http-only", allowedOrigins: [origin], tcp };
      if (native) {
        const entry = new URL("../../waffle-relay/src/node-webtransport.ts", import.meta.url).href;
        const {
          createNodeWebTransportRelayServer,
        }: typeof import("../../waffle-relay/src/node-webtransport.js") = await import(entry);
        nativePort = await udpPort();
        relay = createNodeWebTransportRelayServer({
          ...options,
          tcp: { ...tcp, webtransport: { bind: { host: "127.0.0.1", port: nativePort } } },
        });
      } else relay = createNodeRelayServer(options);
      await relay.tcp?.ready;
      const port = await listen(relay.server);
      const token = await mintRelayToken(secret, {
        exp: Math.floor(Date.now() / 1000) + 600,
        sub: "n5-browser",
        dst: [targets.echo, targets.ssl, targets.refused],
      });
      config = { endpoint: `http://127.0.0.1:${port}/`, token, targets, native };
      return config;
    },
    async idle(): Promise<Response> {
      await waitFor(
        () => sockets.size === 0 && (relay?.tcp?.active ?? 0) === 0,
        "relay and target disposal",
      );
      return Response.json({ sockets: sockets.size, active: relay?.tcp?.active ?? 0 });
    },
    verify(carriers: readonly RelayModeResult["carrier"][]): void {
      assert.ok(config);
      for (const carrier of carriers) {
        const opens = logs.filter((entry) => entry.event === "open" && entry.carrier === carrier);
        assert.ok(
          opens.some((entry) => entry.destination?.host === config?.targets.echo.host),
          `No actual ${carrier} echo admission`,
        );
        assert.ok(
          opens.some((entry) => entry.destination?.host === config?.targets.ssl.host),
          `No actual ${carrier} SSLRequest admission`,
        );
      }
      assert.ok(
        logs.some(
          (entry) => entry.event === "close" && entry.sentBytes > 0 && entry.receivedBytes > 0,
        ),
        "No bidirectional payload accounting",
      );
      assert.ok(
        !logs.some(
          (entry) =>
            entry.event === "open" && entry.destination?.host === config?.targets.denied.host,
        ),
        "Denied destination was admitted",
      );
      assert.ok(received.echo > 0 && received.ssl >= 8, "Real TCP targets saw no payload");
      console.log(
        JSON.stringify({
          relay: "actual-carriers",
          opens: logs
            .filter((entry) => entry.event === "open")
            .map(({ carrier, destination }) => ({ carrier, destination })),
          received,
        }),
      );
    },
  };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function stopServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function destroy(socket: Socket): Promise<void> {
  const closed = once(socket, "close").catch(() => {});
  socket.destroy();
  await closed;
}
async function udpPort(): Promise<number> {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    return socket.address().port;
  } finally {
    await new Promise<void>((resolve) => socket.close(resolve));
  }
}
async function waitFor(ready: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await Bun.sleep(10);
  }
}

async function assertUdpReleased(port: number): Promise<void> {
  const socket = createSocket("udp4");
  try {
    const bound = once(socket, "listening");
    socket.bind(port, "127.0.0.1");
    await bound;
  } finally {
    await new Promise<void>((resolve) => socket.close(resolve));
  }
}

function echoBytes(socket: Socket, received: (count: number) => void): void {
  let prefix: Buffer | undefined = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    received(chunk.length);
    if (!prefix) {
      socket.write(chunk);
      return;
    }
    prefix = Buffer.concat([prefix, chunk]);
    if (prefix.length < 6) return;
    if (prefix.subarray(0, 6).toString() === "RESET\n") {
      socket.resetAndDestroy();
      return;
    }
    socket.write(prefix);
    prefix = undefined;
  });
  socket.on("end", () => {
    if (prefix) socket.end(prefix);
    else socket.end();
  });
}
