import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { once } from "node:events";
import { lookup } from "node:dns/promises";
import { createNodeRelayServer } from "waffle-relay/node";
import { createRelayFetch } from "waffle-relay";

const TOKEN = "owned-local-fixture-token-only";
const temporary =
  process.env.WAFFLE_RELAY_TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
const scratch = mkdtempSync(join(temporary, "waffle-relay-native-"));
const servers: Server[] = [];
const cleanups: (() => Promise<void>)[] = [];
const sockets = new Set<import("node:net").Socket>();
const requests: { path: string; auth: string | undefined; host: string | undefined }[] = [];
const chunks = gzipSync("decoded fixture body");
const controller = new AbortController();
let teardown: Promise<void> | undefined;
const cleanup = (): Promise<void> =>
  (teardown ??= (async () => {
    controller.abort();
    const failures: unknown[] = [];
    for (const operation of cleanups.reverse()) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.all(
      Array.from(
        sockets,
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", resolve);
            socket.destroy();
          }),
      ),
    );
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(scratch, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
  })());
process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(scratch, "key.pem"),
      "-out",
      join(scratch, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const target = createServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      auth: request.headers.authorization,
      host: request.headers.host,
    });
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/final" });
      response.end("discard");
      return;
    }
    if (request.url === "/gzip") {
      response.writeHead(200, { "content-encoding": "gzip", "content-length": chunks.length });
      response.end(chunks);
      return;
    }
    if (request.url === "/slow") {
      response.writeHead(200);
      response.write("first");
      return;
    }
    if (request.url === "/status") {
      response.writeHead(403);
      response.end("target policy");
      return;
    }
    if (request.url === "/upload") {
      let total = 0;
      request.on("data", (chunk) => {
        total += chunk.length;
      });
      request.on("end", () => response.end(String(total)));
      return;
    }
    response.end("local fixture");
  });
  const port = await listen(target);
  const origin = `http://127.0.0.1:${port}`;
  const secure = createHTTPSServer(
    { key: readFileSync(join(scratch, "key.pem")), cert: readFileSync(join(scratch, "cert.pem")) },
    (request, response) => response.end(request.headers.host),
  );
  const tlsHost = (await lookup("localhost", { all: true }))[0];
  assert.ok(tlsHost);
  const tlsPort = await listen(secure, tlsHost.address);
  const secureOrigin = `https://localhost:${tlsPort}`;
  const secureIPOrigin = `https://${tlsHost.family === 6 ? `[${tlsHost.address}]` : tlsHost.address}:${tlsPort}`;
  const relay = createNodeRelayServer({
    credential: TOKEN,
    allowedOrigins: ["https://owned.example.test"],
    destinations: { mode: "fixed-origins", origins: [origin, secureOrigin, secureIPOrigin] },
    credentials: [{ origin, headers: [["authorization", "fixture-origin-policy"]] }],
    ca: readFileSync(join(scratch, "cert.pem")),
    limits: { idleTimeoutMs: 2000 },
  });
  const relayPort = await listen(relay.server);
  cleanups.push(() => relay.close());
  const client = createRelayFetch({ endpoint: `http://127.0.0.1:${relayPort}`, credential: TOKEN });
  cleanups.push(() => client.close());
  assert.equal(await (await client.fetch(`${origin}/final`)).text(), "local fixture");
  assert.equal(await (await client.fetch(`${origin}/redirect`)).text(), "local fixture");
  assert.equal(
    await (
      await client.fetch(`${origin}/upload`, { method: "POST", body: new Uint8Array(65537) })
    ).text(),
    "65537",
  );
  const compressed = await client.fetch(`${origin}/gzip`);
  assert.equal(await compressed.text(), "decoded fixture body");
  assert.equal(compressed.headers.get("content-encoding"), null);
  const deniedTarget = await client.fetch(`${origin}/status`);
  assert.equal(deniedTarget.status, 403);
  assert.equal(await deniedTarget.text(), "target policy");
  assert.equal(await (await client.fetch(secureOrigin)).text(), `localhost:${tlsPort}`);
  await assert.rejects(
    client.fetch(secureIPOrigin),
    (error) => error instanceof Error && error.message === "upstream-network",
  );
  assert.ok(requests.every((item) => item.auth === "fixture-origin-policy"));
  assert.ok(requests.every((item) => item.host === `127.0.0.1:${port}`));

  const publicRelay = createNodeRelayServer({
    credential: TOKEN,
    allowedOrigins: [],
    destinations: { mode: "public-https" },
  });
  const publicPort = await listen(publicRelay.server);
  cleanups.push(() => publicRelay.close());
  const publicClient = createRelayFetch({
    endpoint: `http://127.0.0.1:${publicPort}`,
    credential: TOKEN,
  });
  cleanups.push(() => publicClient.close());
  for (const url of [
    secureOrigin,
    `https://localhost:${tlsPort}`,
    "https://[::ffff:127.0.0.1]/",
    "http://127.0.0.1/",
  ])
    await assert.rejects(
      publicClient.fetch(url),
      (error) => error instanceof Error && error.message === "destination-denied",
    );

  const response = await client.fetch(`${origin}/slow`, { signal: controller.signal });
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  const reason = new Error("fixture cancellation reason");
  controller.abort(reason);
  await assert.rejects(reader.read(), (error) => error === reason);
  await client.close();
  await relay.close();
  assert.equal(relay.server.listening, false);
  console.log(
    JSON.stringify({
      runtime: process.versions.bun ? "Bun" : "Node",
      http: true,
      https: true,
      redirects: true,
      decoded: true,
      upload: 65537,
      publicDenials: 4,
      cancellation: true,
      localTargetRequests: requests.length,
    }),
  );
} finally {
  await cleanup();
  assert.equal(sockets.size, 0, "owned sockets remain after teardown");
}
