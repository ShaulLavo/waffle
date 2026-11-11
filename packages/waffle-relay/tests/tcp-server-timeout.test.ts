import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { ServerTcpStream } from "../src/tcp-server-stream.js";
import { TcpAdmissions, tcpPolicy } from "../src/tcp-policy.js";
import { mintRelayToken } from "../src/token.js";

test("a hanging resolution is bounded, late results cannot dial, and close/log happen once", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const target = { host: "fixture.example", port: 5432 };
  const policy = tcpPolicy(
    {
      tokenSecret: secret,
      destinations: [target],
      limits: { connectTimeoutMs: 20 },
      log: (entry) => logs.push(entry.event),
    },
    ["https://fixture.example"],
  );
  const admissions = new TcpAdmissions(policy.limits);
  const logs: string[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let connection: ServerTcpStream | undefined;
  let late: ((addresses: { address: string; family: number }[]) => void) | undefined;
  const clients = new Set<WebSocket>();
  server.on("upgrade", (request, socket, head) =>
    wss.handleUpgrade(request, socket, head, (ws) => {
      connection = new ServerTcpStream(
        ws,
        policy,
        admissions,
        admissions.reserve(),
        () =>
          new Promise((resolve) => {
            late = resolve;
          }),
      );
    }),
  );
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const token = await mintRelayToken(secret, { exp: Math.floor(Date.now() / 1000) + 60 });
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/tcp`);
    clients.add(ws);
    ws.on("error", () => {});
    await once(ws, "open");
    const reply = once(ws, "message");
    ws.send(JSON.stringify({ v: 1, token, ...target, window: 262144 }));
    expect(JSON.parse(String((await reply)[0]))).toEqual({
      v: 1,
      ok: false,
      code: "target-timeout",
    });
    await connection!.done;
    expect(admissions.active).toBe(0);
    expect(logs).toEqual(["close"]);
    late!([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    connection!.revoke();
    await connection!.done;
    expect(logs).toEqual(["close"]);
  } finally {
    for (const client of clients) client.terminate();
    connection?.revoke();
    await connection?.done;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(server.listening).toBe(false);
  }
});
