import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire("/app/package.json");
const { createNodeRelayServer } = await import(require.resolve("waffle-relay/node"));
const { mintRelayToken } = await import(require.resolve("waffle-relay/token"));
const { serveConfig } = await import(
  require.resolve("waffle-relay/node").replace(/node\.js$/, "cli-config.js")
);
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
assert.deepEqual(config.options.allowedOrigins, [origin]);
assert.deepEqual(config.options.tcp.destinations, []);
assert.equal(config.options.tcp.issuer, undefined);
assert.ok(!("webtransport" in config.options.tcp));
const relay = createNodeRelayServer(config.options);
relay.server.listen(0, "127.0.0.1");
await once(relay.server, "listening");
try {
  const address = relay.server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  for (const path of ["/healthz", "/readyz"]) {
    const response = await fetch(endpoint + path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  const token = await mintRelayToken(secret, {
    exp: Math.floor(Date.now() / 1000) + 60,
    dst: [],
  });
  const headers = { origin, authorization: `Bearer ${token}` };
  const discovery = await fetch(`${endpoint}/v1/tcp/session`, { method: "POST", headers });
  assert.equal(discovery.status, 200);
  assert.deepEqual(await discovery.json(), { v: 1, webtransport: null });
  assert.equal((await fetch(`${endpoint}/v1/tcp/token`, { method: "POST", headers })).status, 404);
  const denied = await fetch(`${endpoint}/v1/tcp/session`, {
    method: "POST",
    headers: { origin: "https://unselected.invalid" },
  });
  assert.equal(denied.status, 403);
  const unauthenticated = await fetch(`${endpoint}/v1/tcp/session`, {
    method: "POST",
    headers: { origin },
  });
  assert.equal(unauthenticated.status, 401);
} finally {
  await relay.close();
}
console.log(
  JSON.stringify({
    runtime: process.version,
    platform: "linux/amd64",
    scope: "deny-all",
    native: false,
    webtransport: null,
    cleanup: "joined",
  }),
);
