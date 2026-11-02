import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  createNodeRelayServer,
  createNodeWebSocket,
  type TcpLog,
  type TcpServerOptions,
} from "waffle-relay/node";
import { createRelayConnect, type TcpStream } from "waffle-relay";
import { mintRelayToken } from "waffle-relay/token";

const origin = "https://tcp-fixture.example";
const secret = randomBytes(32);
const issuerCredential = randomBytes(32).toString("hex");
const target = { host: "db.waffle.internal", port: 5432 };
const logs: TcpLog[] = [];
const sockets = new Set<Socket>();
const servers: Server[] = [];
const relays: ReturnType<typeof createNodeRelayServer>[] = [];
const clients: ReturnType<typeof createRelayConnect>[] = [];
const raw = new Set<WebSocket>();
const children = new Set<ChildProcess>();
let cleanupPromise: Promise<void> | undefined;
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    await Promise.all(
      Array.from(children, async (child) => {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }),
    );
    for (const ws of raw) ws.terminate();
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(relays.map((relay) => relay.close()));
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await until(() => sockets.size === 0);
    assert.ok(servers.every((server) => !server.listening));
    assert.ok(relays.every((relay) => !relay.server.listening && relay.tcp?.active === 0));
  })());
process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});
const timeout = setTimeout(() => {
  void cleanup().finally(() => {
    process.stderr.write("TCP fixture deadline exceeded\n");
    process.exit(1);
  });
}, 90000);

function until(predicate: () => boolean, maximum = 3000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("Fixture condition timed out"));
    }, maximum);
    const interval = setInterval(() => {
      if (predicate()) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve();
      }
    }, 5);
  });
}
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    socket.on("error", () => {});
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function relayFor(port: number, limits: TcpServerOptions["limits"] = {}) {
  const relay = createNodeRelayServer({
    credential: randomBytes(32).toString("hex"),
    allowedOrigins: [origin],
    tcp: {
      tokenSecret: secret,
      destinations: [{ ...target, connect: { host: "127.0.0.1", port } }],
      limits,
      log: (entry) => logs.push(entry),
      issuer: { credential: issuerCredential, ttlSeconds: 60, destinations: [target] },
    },
  });
  relays.push(relay);
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const address = relay.server.address();
  assert.ok(address && typeof address !== "string");
  return { relay, endpoint: `http://127.0.0.1:${address.port}/` };
}
function clientFor(endpoint: string, token: string, pageOrigin = origin) {
  const client = createRelayConnect({
    endpoint,
    getToken: () => token,
    webSocket: createNodeWebSocket(pageOrigin),
  });
  clients.push(client);
  return client;
}
async function collect(stream: TcpStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
async function openRaw(endpoint: string, token: string, fragmented = false): Promise<WebSocket> {
  const ws = new WebSocket(endpoint.replace("http:", "ws:") + "v1/tcp", {
    origin,
    perMessageDeflate: false,
  });
  raw.add(ws);
  ws.on("error", () => {});
  ws.once("close", () => raw.delete(ws));
  await once(ws, "open");
  const reply = once(ws, "message");
  const header = JSON.stringify({ v: 1, token, ...target, window: 262144 });
  if (fragmented) {
    ws.send(header.slice(0, 5), { fin: false });
    ws.send(header.slice(5), { fin: true });
  } else ws.send(header);
  const [data] = await reply;
  assert.equal(JSON.parse(String(data)).ok, true);
  return ws;
}
async function rejection(
  endpoint: string,
  token: string,
  code: string,
  destination = target,
  pageOrigin = origin,
): Promise<void> {
  const client = clientFor(endpoint, token, pageOrigin);
  await assert.rejects(client.connect(destination, new AbortController().signal), { code });
  await client.close();
}
async function policyCases(endpoint: string, token: string): Promise<void> {
  await rejection(endpoint, token, "EACCES", { host: "unlisted.example", port: 5432 });
  await rejection(endpoint, token, "EACCES", { ...target, port: 5433 });
  await rejection(endpoint, token, "EACCES", target, "https://wrong.example");
  const wrongScope = await mintRelayToken(secret, {
    exp: Math.floor(Date.now() / 1000) + 60,
    dst: [{ host: "unlisted.example", port: 5432 }],
  });
  await rejection(endpoint, wrongScope, "EACCES");
  const expired = await mintRelayToken(secret, { exp: 11 }, 10);
  await rejection(endpoint, expired, "EACCES");
  const forged = await mintRelayToken(randomBytes(32), { exp: Math.floor(Date.now() / 1000) + 60 });
  await rejection(endpoint, forged, "EACCES");
  const session = await fetch(new URL("v1/tcp/session", endpoint), {
    method: "POST",
    headers: { origin, authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await session.json(), { v: 1, webtransport: null });
  const noAuth = await fetch(new URL("v1/tcp/session", endpoint), {
    method: "POST",
    headers: { origin },
  });
  assert.equal(noAuth.status, 401);
  const mint = async (credential: string, dst = [target]) =>
    fetch(new URL("v1/tcp/token", endpoint), {
      method: "POST",
      headers: { origin, authorization: `Bearer ${credential}` },
      body: JSON.stringify({ sub: "fixture-user", dst }),
    });
  assert.equal((await mint(token)).status, 401);
  assert.equal((await mint(issuerCredential, [{ host: "other.example", port: 80 }])).status, 401);
  assert.equal((await mint(issuerCredential)).status, 200);
  assert.equal((await fetch(new URL("healthz", endpoint))).status, 200);
  assert.equal((await fetch(new URL("readyz", endpoint))).status, 200);
}
async function halfCloseAndFraming(endpoint: string, token: string): Promise<void> {
  const client = clientFor(endpoint, token);
  const stream = await client.connect(
    { host: "DB.WAFFLE.INTERNAL.", port: 5432 },
    new AbortController().signal,
  );
  assert.equal(client.carrier, "websocket");
  assert.equal(stream.remote.address, "127.0.0.1");
  const writer = stream.writable.getWriter();
  const response = collect(stream);
  await writer.write(new TextEncoder().encode("hello"));
  await writer.close();
  assert.equal(new TextDecoder().decode(await response), "hello");
  await client.close();
  const fullClose = await clientFor(endpoint, token).connect(target, new AbortController().signal);
  const fullWriter = fullClose.writable.getWriter();
  await fullWriter.write(new Uint8Array(262144));
  await fullWriter.close();
  await fullClose.readable.cancel();
  assert.equal(fullClose.counters.sendOutstandingBytes, 0);
  const ws = await openRaw(endpoint, token, true);
  const closed = once(ws, "close");
  ws.send(new Uint8Array([1]));
  ws.send(new Uint8Array([0, 42]));
  const [code] = await closed;
  assert.equal(code, 1008);
  const duplicate = await openRaw(endpoint, token);
  const duplicateClosed = once(duplicate, "close");
  duplicate.send(new Uint8Array([1]));
  duplicate.send(new Uint8Array([1]));
  assert.equal((await duplicateClosed)[0], 1008);
  const overrun = await openRaw(endpoint, token);
  const overrunClosed = once(overrun, "close");
  overrun.send(new Uint8Array([2, 0, 0, 0, 1]));
  assert.equal((await overrunClosed)[0], 1008);
}
async function limitsCases(port: number, token: string): Promise<void> {
  const deniedRate = await relayFor(port, { attemptsPerMinute: 1 });
  await rejection(deniedRate.endpoint, token, "EACCES", { host: "unlisted.example", port: 80 });
  await rejection(deniedRate.endpoint, token, "ECONNREFUSED");
  const perSubject = await relayFor(port, {
    maxConnectionsPerSubject: 1,
    attemptsPerMinute: 2,
    idleTimeoutMs: 1000,
  });
  const first = clientFor(perSubject.endpoint, token);
  await first.connect(target, new AbortController().signal);
  await rejection(perSubject.endpoint, token, "ECONNREFUSED");
  await first.close();
  await rejection(perSubject.endpoint, token, "ECONNREFUSED");
  const total = await relayFor(port, { maxConnections: 1 });
  const live = clientFor(total.endpoint, token);
  await live.connect(target, new AbortController().signal);
  await rejection(total.endpoint, token, "ECONNREFUSED");
  await live.close();
  const idle = await relayFor(port, { idleTimeoutMs: 20 });
  const idleClient = clientFor(idle.endpoint, token);
  const stream = await idleClient.connect(target, new AbortController().signal);
  await assert.rejects(stream.readable.getReader().read(), { code: "ECONNRESET" });
  await idleClient.close();
  const header = await relayFor(port, { headerTimeoutMs: 20 });
  const ws = new WebSocket(header.endpoint.replace("http:", "ws:") + "v1/tcp", { origin });
  raw.add(ws);
  ws.on("error", () => {});
  ws.once("close", () => raw.delete(ws));
  const closed = once(ws, "close");
  await once(ws, "open");
  assert.equal((await closed)[0], 1008);
  const small = await relayFor(port, { maxOpenBytes: 16 });
  await rejection(small.endpoint, token, "ECONNRESET");
}
async function transfer(port: number, token: string): Promise<void> {
  const { relay, endpoint } = await relayFor(port);
  const client = clientFor(endpoint, token);
  const stream = await client.connect(target, new AbortController().signal);
  const writer = stream.writable.getWriter();
  const chunk = new Uint8Array(65536).fill(113);
  const count = 1024;
  let written = 0,
    received = 0,
    peakQueued = 0,
    peakReadAhead = 0;
  const rss = process.memoryUsage().rss;
  const sending = (async () => {
    for (let i = 0; i < count; i++) {
      await writer.write(chunk);
      written++;
    }
    await writer.close();
  })();
  void sending.catch(() => {});
  await until(() => stream.counters.receiveQueuedBytes === 262144);
  assert.ok(written < count, "paused reader must stop the 64 MiB sender");
  const reader = stream.readable.getReader();
  for (;;) {
    for (const counters of relay.tcp!.counters) {
      peakQueued = Math.max(peakQueued, counters.toTargetBytes, counters.toClientBytes);
      peakReadAhead = Math.max(peakReadAhead, counters.readAheadBytes);
      assert.ok(
        counters.toTargetBytes <= 262144 &&
          counters.toClientBytes <= 262144 &&
          counters.readAheadBytes <= 65536,
      );
    }
    assert.ok(
      stream.counters.receiveQueuedBytes <= 262144 &&
        stream.counters.sendOutstandingBytes <= 262144,
    );
    const next = await reader.read();
    if (next.done) break;
    received += next.value.length;
    assert.ok(next.value.every((byte) => byte === 113));
  }
  await sending;
  assert.equal(received, 64 * 1024 * 1024);
  const rssGrowth = process.memoryUsage().rss - rss;
  assert.ok(rssGrowth < 128 * 1024 * 1024, `RSS grew by ${rssGrowth}`);
  await client.close();
  await relay.close();
  process.stdout.write(
    JSON.stringify({
      fixture: "tcp-backpressure",
      runtime: process.versions.bun ? "bun" : "node",
      bytes: received,
      peakQueued,
      peakReadAhead,
      rssGrowth,
    }) + "\n",
  );
}
async function carrierLossAndShutdown(endpoint: string, token: string): Promise<void> {
  const ws = await openRaw(endpoint, token);
  ws.terminate();
  await until(() => !raw.has(ws));
  const client = clientFor(endpoint, token);
  const stream = await client.connect(target, new AbortController().signal);
  const pending = stream.readable.getReader().read();
  client.revoke();
  await assert.rejects(pending, { code: "ECONNRESET" });
  await client.close();
  await assert.rejects(client.connect(target, new AbortController().signal), { code: "EACCES" });
  const aborted = new AbortController();
  const opening = clientFor(endpoint, token);
  const promise = opening.connect(target, aborted.signal);
  aborted.abort(new Error("fixture abort"));
  await assert.rejects(promise, /fixture abort/);
  await opening.close();
  let release: ((value: string) => void) | undefined;
  const late = createRelayConnect({
    endpoint,
    getToken: () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    webSocket: createNodeWebSocket(origin),
  });
  clients.push(late);
  const lateOpen = late.connect(target, new AbortController().signal);
  await until(() => !!release);
  late.revoke();
  await assert.rejects(lateOpen);
  await late.close();
  release!(token);
}
async function cliFixture(port: number): Promise<void> {
  const reservation = createServer();
  const cliPort = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "serve",
      "--dev",
      "--port",
      String(cliPort),
      "--origin",
      origin,
      "--destination",
      `db.waffle.internal,5432,127.0.0.1,${port}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  child.once("exit", () => children.delete(child));
  let stderr = "";
  child.stderr!.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  child.stdout!.on("data", () => {});
  await until(() => /\nv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n/.test(stderr));
  assert.equal((await fetch(`http://127.0.0.1:${cliPort}/healthz`)).status, 200);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
  stderr = "";
  const probe = createServer();
  servers.push(probe);
  probe.listen(cliPort, "127.0.0.1");
  await once(probe, "listening");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

async function originAndRemoteFinCases(
  endpoint: string,
  port: number,
  token: string,
): Promise<void> {
  for (const headers of [
    {},
    { Origin: "null" },
    { Origin: [origin, origin] },
    { Origin: origin + "/" },
  ]) {
    const ws = new WebSocket(endpoint.replace("http:", "ws:") + "v1/tcp", { headers });
    raw.add(ws);
    ws.on("error", () => {});
    ws.once("close", () => raw.delete(ws));
    const response = once(ws, "message");
    await once(ws, "open");
    assert.equal(JSON.parse(String((await response)[0])).code, "relay-origin");
    if (raw.has(ws)) await once(ws, "close");
  }
  let incoming = "";
  const peerFin = createServer({ allowHalfOpen: true }, (socket) => {
    socket.end("peer-fin");
    socket.on("data", (bytes) => {
      incoming += bytes.toString();
    });
  });
  const peerPort = await listen(peerFin);
  const owned = await relayFor(peerPort);
  const client = clientFor(owned.endpoint, token);
  const stream = await client.connect(target, new AbortController().signal);
  assert.equal(new TextDecoder().decode(await collect(stream)), "peer-fin");
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode("after-peer-fin"));
  await writer.close();
  await until(() => incoming === "after-peer-fin");
  await client.close();
  await owned.relay.close();
  const bounded = await relayFor(port, { maxSubjects: 1 });
  const first = clientFor(bounded.endpoint, token);
  await first.connect(target, new AbortController().signal);
  await first.close();
  const secondSubject = await mintRelayToken(secret, {
    exp: Math.floor(Date.now() / 1000) + 60,
    sub: "different-subject",
    dst: [target],
  });
  await rejection(bounded.endpoint, secondSubject, "ECONNREFUSED");
}

async function pausedTarget(token: string): Promise<void> {
  let accepted: Socket | undefined;
  let bytes = 0;
  const targetServer = createServer({ allowHalfOpen: true }, (socket) => {
    accepted = socket;
    socket.pause();
    socket.on("data", (chunk) => {
      bytes += chunk.length;
    });
    socket.once("end", () => socket.end("drained"));
  });
  const port = await listen(targetServer);
  const { endpoint, relay } = await relayFor(port);
  const client = clientFor(endpoint, token);
  const stream = await client.connect(target, new AbortController().signal);
  const writer = stream.writable.getWriter();
  let written = 0;
  const sending = (async () => {
    for (let i = 0; i < 1024; i++) {
      await writer.write(new Uint8Array(65536));
      written++;
    }
    await writer.close();
  })();
  void sending.catch(() => {});
  await until(() => relay.tcp!.counters.some((value) => value.toTargetBytes === 262144));
  assert.ok(written < 1024, "paused TCP target must stop carrier writes");
  assert.equal(stream.counters.sendOutstandingBytes, 262144);
  accepted!.resume();
  const result = collect(stream);
  await sending;
  assert.equal(new TextDecoder().decode(await result), "drained");
  assert.equal(bytes, 64 * 1024 * 1024);
  await client.close();
  await relay.close();
}
async function shutdownAndCarrierCases(port: number, token: string): Promise<void> {
  const { relay, endpoint } = await relayFor(port, { idleTimeoutMs: 20 });
  const idle = await openRaw(endpoint, token);
  assert.equal((await once(idle, "close"))[0], 4002);
  const other = await relayFor(port);
  const ws = await openRaw(other.endpoint, token);
  const closed = once(ws, "close");
  other.relay.revoke();
  assert.equal((await closed)[0], 4004);
  await other.relay.close();
  await relay.close();
  const gone = clientFor(endpoint, token);
  await assert.rejects(gone.connect(target, new AbortController().signal), { code: "ENETUNREACH" });
  await gone.close();
  const before = await relayFor(port);
  const unopen = new WebSocket(before.endpoint.replace("http:", "ws:") + "v1/tcp", { origin });
  raw.add(unopen);
  unopen.on("error", () => {});
  unopen.once("close", () => raw.delete(unopen));
  await once(unopen, "open");
  unopen.terminate();
  await until(() => before.relay.tcp?.active === 0);
  const refusedPort = await listen(createServer());
  const refusedServer = servers.at(-1)!;
  await new Promise<void>((resolve) => refusedServer.close(() => resolve()));
  const refused = await relayFor(refusedPort);
  await rejection(refused.endpoint, token, "ECONNREFUSED");
}

try {
  const echo = createServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket));
  const port = await listen(echo);
  const { relay, endpoint } = await relayFor(port);
  const token = await mintRelayToken(secret, {
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "native-fixture",
    dst: [target],
  });
  await cliFixture(port);
  await policyCases(endpoint, token);
  await originAndRemoteFinCases(endpoint, port, token);
  await halfCloseAndFraming(endpoint, token);
  await limitsCases(port, token);
  await transfer(port, token);
  await pausedTarget(token);
  await carrierLossAndShutdown(endpoint, token);
  await shutdownAndCarrierCases(port, token);
  await until(() => relay.tcp?.active === 0);
  const opened = logs.filter((entry) => entry.event === "open");
  assert.ok(opened.length > 0);
  assert.ok(
    logs.every(
      (entry) =>
        !JSON.stringify(entry).includes(token) &&
        !JSON.stringify(entry).includes("127.0.0.1") &&
        !JSON.stringify(entry).includes(issuerCredential),
    ),
  );
  await cleanup();
  for (const entry of opened)
    assert.equal(
      logs.filter((close) => close.id === entry.id && close.event === "close").length,
      1,
    );
  const closes = logs.filter((entry) => entry.event === "close");
  assert.equal(new Set(closes.map((entry) => entry.id)).size, closes.length);
  process.stdout.write(
    JSON.stringify({
      fixture: "tcp-native",
      runtime: process.versions.bun ? "bun" : "node",
      opened: opened.length,
      closed: closes.length,
      sockets: sockets.size,
      cleanup: "joined",
    }) + "\n",
  );
} finally {
  clearTimeout(timeout);
  await cleanup();
}
