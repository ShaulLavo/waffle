import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire("/app/package.json");
const origin = "https://waffle-network.sprockt.dev";
const url = "https://waffle-relay-public.sprockt.dev:4433/v1/tcp/wt";
const input = JSON.parse(await readFile("/app/source-inputs.json", "utf8"));
assert.equal(process.version, "v26.12.1");
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(process.getuid!(), 1000);
assert.equal(process.getgid!(), 1000);
assert.match(execFileSync("openssl", ["version"], { encoding: "utf8" }), /^OpenSSL /);
for (const name of ["waffle", "waffle-relay"]) {
  const manifest = JSON.parse(await readFile(`/app/node_modules/${name}/package.json`, "utf8"));
  assert.equal(manifest.version, input.version);
  assert.equal(manifest.waffleHostInterface, 1);
}
for (const name of ["webtransport", "webtransport-transport-http3-quiche"]) {
  const manifest = JSON.parse(
    await readFile(`/app/node_modules/@fails-components/${name}/package.json`, "utf8"),
  );
  assert.equal(manifest.version, "1.6.11");
}
const addon =
  "/app/node_modules/@fails-components/webtransport-transport-http3-quiche/build/Release/webtransport.node";
const addonHash = createHash("sha256")
  .update(await readFile(addon))
  .digest("hex");
assert.equal(addonHash, "5592208da56aee0f53615b8d8c5d57c99a87618593c6343787ac9f92761daf1d");
await import(require.resolve("waffle-relay"));
await import(require.resolve("waffle-relay/node"));
assert.ok(
  !Object.keys(require.cache).some((path) => path.endsWith("webtransport.node")),
  "Ordinary entry loaded the optional native addon",
);
const { mintRelayToken } = await import(require.resolve("waffle-relay/token"));
const { serveConfig } = await import(
  require.resolve("waffle-relay/node").replace(/node\.js$/, "cli-config.js")
);
const secret = randomBytes(32).toString("hex");
const config = await serveConfig(["serve", "--config", "/app/relay.json"], {
  WAFFLE_RELAY_TOKEN_SECRET: secret,
});
assert.deepEqual(config.listen, { host: "0.0.0.0", port: 8787 });
assert.deepEqual(config.options.allowedOrigins, [origin]);
assert.equal(config.options.destinations, undefined);
assert.deepEqual(config.options.tcp.destinations, []);
assert.equal(config.options.tcp.issuer, undefined);
assert.deepEqual(config.options.tcp.webtransport, {
  bind: { host: "0.0.0.0", port: 4433 },
  advertisedUrl: url,
  certificate: "rotating-hash",
});
const token = await mintRelayToken(secret, { exp: Math.floor(Date.now() / 1000) + 60, dst: [] });
const headers = { origin, authorization: `Bearer ${token}` };
const endpoint = "http://127.0.0.1:8787";
const request = (path: string, options?: RequestInit) =>
  fetch(endpoint + path, { ...options, signal: AbortSignal.timeout(5000) });

async function ready(child: ChildProcess): Promise<void> {
  const until = performance.now() + 15000;
  while (performance.now() < until) {
    assert.equal(child.exitCode, null, "CLI exited before readiness");
    const response = await fetch(`${endpoint}/readyz`, { signal: AbortSignal.timeout(1000) }).catch(
      () => undefined,
    );
    if (response?.ok) return;
    await delay(25);
  }
  throw new Error("Native CLI readiness deadline");
}
async function stop(child: ChildProcess, exited: Promise<unknown[]>): Promise<void> {
  child.kill("SIGTERM");
  const timer = new AbortController();
  try {
    const outcome = await Promise.race([
      exited,
      delay(15000, undefined, { signal: timer.signal }).then(() => {
        throw new Error("CLI close deadline");
      }),
    ]);
    assert.equal(outcome[0], 0, "CLI did not close normally");
  } finally {
    timer.abort();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}
async function udpReleased(): Promise<void> {
  const socket = createSocket("udp4");
  try {
    const bound = once(socket, "listening");
    socket.bind(4433, "0.0.0.0");
    await bound;
  } finally {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
}
async function check(): Promise<string> {
  for (const path of ["/healthz", "/readyz"]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  const discovery = await request("/v1/tcp/session", { method: "POST", headers });
  assert.equal(discovery.status, 200);
  const body = await discovery.json();
  assert.equal(body.v, 1);
  assert.equal(body.webtransport.url, url);
  assert.equal(body.webtransport.certificateHashes.length, 1);
  const hash = body.webtransport.certificateHashes[0];
  assert.equal(hash.algorithm, "sha-256");
  assert.equal(Buffer.from(hash.value, "base64url").length, 32);
  assert.equal((await request("/v1/tcp/token", { method: "POST", headers })).status, 404);
  assert.equal(
    (await request("/v1/tcp/session", { method: "POST", headers: { origin } })).status,
    401,
  );
  assert.equal(
    (
      await request("/v1/tcp/session", {
        method: "POST",
        headers: { ...headers, origin: "https://unselected.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await request("/v1/tcp/wrong", { headers })).status, 404);
  return hash.value;
}
async function cycle(): Promise<string> {
  const child = spawn(
    process.execPath,
    ["/app/node_modules/waffle-relay/dist/cli.js", "serve", "--config", "/app/relay.json"],
    {
      env: { ...process.env, WAFFLE_RELAY_TOKEN_SECRET: secret },
      stdio: "ignore",
    },
  );
  const exited = once(child, "exit");
  try {
    await ready(child);
    return await check();
  } catch (error) {
    process.stderr.write(
      `Native candidate check failed: ${error instanceof Error ? error.message : "unknown failure"}\n`,
    );
    throw error;
  } finally {
    await stop(child, exited);
    await udpReleased();
    assert.deepEqual(await readdir(process.env.WAFFLE_RELAY_TMPDIR ?? "/tmp"), []);
  }
}
const firstHash = await cycle();
assert.notEqual(await cycle(), firstHash, "Restart reused the previous certificate");
console.log(
  JSON.stringify({
    source: input.source,
    preparationSource: input.preparationSource,
    configSha256: createHash("sha256")
      .update(await readFile("/app/relay.json"))
      .digest("hex"),
    lockSha256: createHash("sha256")
      .update(await readFile("/app/package-lock.json"))
      .digest("hex"),
    archives: input.archives,
    base: input.base,
    runtime: process.version,
    platform: "linux/amd64",
    addonSha256: addonHash,
    native: "1.6.11",
    scope: "deny-all",
    bind: "0.0.0.0:4433",
    advertisedUrl: url,
    ordinaryEntryNativeFree: true,
    startup: true,
    restart: true,
    cleanup: "joined",
    acceptance: "local candidate only, no published UDP mapping or authenticated native stream",
  }),
);
