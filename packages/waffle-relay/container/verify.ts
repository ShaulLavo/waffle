import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire("/app/package.json");
const nodeEntry = require.resolve("waffle-relay/node");
const internal = (file: string) => nodeEntry.replace(/node\.js$/, file);
const { createNodeRelayServer } = await import(nodeEntry);
const { mintRelayToken } = await import(require.resolve("waffle-relay/token"));
const { serveConfig } = await import(internal("cli-config.js"));
const { tcpPolicy, resolveDestination } = await import(internal("tcp-policy.js"));
const { default: WebSocket } = await import(require.resolve("ws"));
const secret = randomBytes(32).toString("hex");
assert.equal(process.version, "v26.12.1");
assert.equal(process.arch, "x64");
assert.equal(process.platform, "linux");
for (const name of ["waffle", "waffle-relay"]) {
  const manifest = JSON.parse(await readFile(`/app/node_modules/${name}/package.json`, "utf8"));
  assert.equal(manifest.version, "0.0.109");
}
const files = await readdir("/app/node_modules", { recursive: true });
assert.ok(!files.includes("@fails-components"));
assert.ok(files.every((path) => !path.endsWith(".node")));
const config = await serveConfig(["serve", "--config", "/app/relay.json"], {
  WAFFLE_RELAY_TOKEN_SECRET: secret,
});
const origin = "https://waffle-network.sprockt.dev";
const target = { host: "waffle-relay-public.sprockt.dev", port: 80 };
assert.deepEqual(config.options.allowedOrigins, [origin]);
assert.deepEqual(config.options.tcp.destinations, [target]);
assert.equal(config.options.tcp.issuer, undefined);
assert.ok(!("webtransport" in config.options.tcp));

// The selected name is resolved with a stub, so qualification never dials or looks it up.
const policy = tcpPolicy(config.options.tcp, config.options.allowedOrigins);
assert.deepEqual(Array.from(policy.destinations.values()), [target]);
assert.equal(policy.issuer, undefined);
const [entry] = policy.destinations.values();
const answer =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
assert.deepEqual(await resolveDestination(entry, answer("1.1.1.1")), { host: "1.1.1.1", port: 80 });
for (const addresses of [["10.0.0.1"], ["1.1.1.1", "100.64.0.1"], ["::1"]])
  await assert.rejects(resolveDestination(entry, answer(...addresses)), {
    code: "destination-denied",
  });
await assert.rejects(resolveDestination(entry, answer()), { code: "dns-failed" });

const relay = createNodeRelayServer(config.options);
relay.server.listen(0, "127.0.0.1");
await once(relay.server, "listening");
const now = Math.floor(Date.now() / 1000);
const token = (sub: string, dst?: (typeof target)[]) =>
  mintRelayToken(secret, { exp: now + 60, sub, ...(dst ? { dst } : {}) });
// Every request here fails before resolution: none of them reaches DNS or a target socket.
async function openReply(endpoint: string, bearer: string, host: string, port: number) {
  const socket = new WebSocket(`${endpoint.replace(/^http/, "ws")}/v1/tcp`, {
    origin,
    perMessageDeflate: false,
  });
  const reply = new Promise<string>((resolve, reject) => {
    socket.once("open", () =>
      socket.send(JSON.stringify({ v: 1, token: bearer, host, port, window: 65536 })),
    );
    socket.once("message", (data: unknown) => resolve(String(data)));
    socket.once("close", () => reject(new Error("Relay closed before its open reply")));
    socket.once("error", reject);
  });
  try {
    return JSON.parse(await reply);
  } finally {
    socket.terminate();
  }
}
try {
  const address = relay.server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  for (const path of ["/healthz", "/readyz"]) {
    const response = await fetch(endpoint + path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  const headers = { origin, authorization: `Bearer ${await token("discovery", [])}` };
  const discovery = await fetch(`${endpoint}/v1/tcp/session`, { method: "POST", headers });
  assert.equal(discovery.status, 200);
  assert.deepEqual(await discovery.json(), { v: 1, webtransport: null });
  assert.equal((await fetch(`${endpoint}/v1/tcp/token`, { method: "POST", headers })).status, 404);
  const denied = await fetch(`${endpoint}/v1/tcp/session`, {
    method: "POST",
    headers: { origin: "https://unselected.invalid" },
  });
  assert.equal(denied.status, 403);
  const expired = await mintRelayToken(secret, { exp: now - 1, dst: [target] }, now - 60);
  for (const authorization of [undefined, "Bearer v1.invalid.token", `Bearer ${expired}`]) {
    const response = await fetch(`${endpoint}/v1/tcp/session`, {
      method: "POST",
      headers: authorization ? { origin, authorization } : { origin },
    });
    assert.equal(response.status, 401);
  }
  const unlisted = [
    { host: target.host, port: 443 },
    { host: target.host, port: 8080 },
    { host: "waffle-network.sprockt.dev", port: 80 },
    { host: "1.1.1.1", port: 80 },
    { host: "127.0.0.1", port: 8787 },
  ];
  for (const [index, { host, port }] of unlisted.entries()) {
    const reply = await openReply(endpoint, await token(`unlisted-${index}`), host, port);
    assert.deepEqual(reply, { v: 1, ok: false, code: "destination-denied" });
  }
  const scoped = await token("scoped", [target]);
  assert.deepEqual(await openReply(endpoint, scoped, target.host, 443), {
    v: 1,
    ok: false,
    code: "relay-auth",
  });
  for (const bearer of ["v1.invalid.token", expired])
    assert.deepEqual(await openReply(endpoint, bearer, target.host, target.port), {
      v: 1,
      ok: false,
      code: "relay-auth",
    });
} finally {
  await relay.close();
}
console.log(
  JSON.stringify({
    runtime: process.version,
    platform: "linux/amd64",
    scope: [`${target.host}:${target.port}`],
    native: false,
    webtransport: null,
    cleanup: "joined",
  }),
);
