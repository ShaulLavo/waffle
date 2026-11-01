# Host an explicit relay

Import a server adapter only in the trusted operator application. Keep relay credentials and target profiles separate from guest configuration.

## Node or Bun

```ts
import { createNodeRelayServer } from "waffle-relay/node";

const relay = createNodeRelayServer({
  credential: operatorRelayCredential,
  allowedOrigins: ["https://your-page.example"],
  destinations: {
    mode: "fixed-origins",
    origins: ["https://your-api.example"],
  },
});
relay.server.listen(8787, "127.0.0.1");
// The application joins shutdown before dropping ownership.
await relay.close();
```

The adapter does not listen automatically. Bind to loopback unless an explicit operator TLS and origin boundary protects remote access. Do not expose a public listener merely to avoid browser CORS. Rotate the relay credential by replacing and closing its handler. The operator owns TLS, secret storage, logging policy, deployment, and shutdown.

Use `ca` only for operator-trusted TLS roots when needed. The adapter does not expose `rejectUnauthorized: false`, an unchecked hostname fetch, or an egress-verifier callback.

## Cloudflare Worker

```ts
import { createWorkerRelayHandler } from "waffle-relay/worker";

const relay = createWorkerRelayHandler({
  credential: operatorRelayCredential,
  allowedOrigins: ["https://your-page.example"],
  destinations: {
    mode: "fixed-origins",
    origins: ["https://your-api.example"],
  },
});
export default { fetch: relay.fetch };
```

Supply the credential from an operator-controlled secret binding, with generated binding types in the deployment project. Do not embed it in this example or a guest environment. Use the deployment project's current compatibility date, secret storage, and redacted logging configuration. The library itself logs no requests, headers, bodies, credentials, or error details.

Use one handler per operator configuration. Its active counter is per instance in one isolate, not a global distributed limit. Request bodies and response readers stay in their owning request context. The optional lifecycle methods are useful for same-context tests and shutdown; a Worker must not attempt cross-request I/O through another request's resources.

The Worker supports only fixed exact origins. Public HTTPS configuration is rejected before a request can run. Do not replace that rejection with DNS lookup followed by global fetch.

Cloudflare references:

- [Global fetch strictly public](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
- [Worker HTTPS API and Agent limitations](https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/)
- [Fetch and response encoding](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Platform limits](https://developers.cloudflare.com/workers/platform/limits/)

## Verify without deployment

From the repository root, prepare Waffle's existing verified network artifact and run its ordinary build, then run `bun run relay:check`. That command checks types, shared policy fixtures, real local Node and Bun HTTP/HTTPS fixtures, actual local workerd behavior, and packed exports. The workerd fixture uses the site's pinned Miniflare dependency and its supported October 13, 2026 compatibility date. Install the site dependencies before running the full gate. Native fixtures create only loopback servers and one temporary TLS certificate directory, then remove both.

`bun run --cwd packages/waffle-relay size` checks the initial runtime graph and reports optional client and Worker sizes. No public service, private Mesh app, token, or external target is required for these checks. The local workerd run is not an installed or published Cloudflare deployment.

## Run local TCP development

Build the package, then start the loopback-only relay with an explicit loopback target:

```sh
bun run --cwd packages/waffle-relay build
node packages/waffle-relay/dist/cli.js serve --dev \
	--origin http://localhost:3000 \
	--destination pg.waffle.internal,5432,127.0.0.1,5432
```

The CLI prints one development token to stderr. Keep it in trusted page state, outside guest code and logs. It expires after one hour. The secret is random, remains in memory, and changes after restart. Development mode refuses non-loopback listeners, non-loopback overrides, persistent configuration and the issuer. Each repeated `--destination` contains the guest host, guest port, numeric target host and target port, separated by commas. `--listen` defaults to `127.0.0.1` and `--port` to `8787`.

In a Node or Bun embedding, set the required Origin explicitly:

```ts
import { createRelayConnect } from "waffle-relay";
import { createNodeWebSocket } from "waffle-relay/node";

const relay = createRelayConnect({
  endpoint: "http://127.0.0.1:8787/",
  getToken: () => appOwnedToken,
  carriers: ["websocket"],
  webSocket: createNodeWebSocket("http://localhost:3000"),
});
const socket = await relay.connect(
  { host: "pg.waffle.internal", port: 5432 },
  new AbortController().signal,
);
// The application owns the socket streams and joins relay shutdown.
await relay.close();
```

A browser omits `webSocket` and sends its actual page Origin. The token and connector remain page-owned. No Waffle runtime is constructed by the relay package.

## Prepare an operator configuration

Create a secret file without printing its contents:

```sh
install -d -m 700 /work/services/waffle-relay
node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {randomBytes} from "node:crypto"; writeFileSync("/work/services/waffle-relay/token-secret", randomBytes(32).toString("hex"), {mode: 0o600, flag: "wx"})'
```

Create a secret-free configuration file with exact destinations and allowed origins:

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "allowedOrigins": ["https://your-page.example"],
  "tcp": {
    "tokenSecretFile": "/work/services/waffle-relay/token-secret",
    "destinations": [{ "host": "db.example", "port": 5432 }],
    "limits": {}
  }
}
```

Start it with `waffle-relay serve --config /path/to/config.json`. The CLI validates the entire policy before binding. Unknown fields fail. Secret files must be owner-owned, regular files with mode 0600. `WAFFLE_RELAY_TOKEN_SECRET` can supply the TCP secret instead. Do not put secret values in the JSON file, source, command-line flags, logs or guest state. The CLI creates an unrelated ephemeral HTTP credential and configures no HTTP destinations. Existing HTTP relay embedders continue to configure their own HTTP handler normally.

If you enable the private issuer, add `tcp.issuer` with `credentialFile`, `ttlSeconds` and an explicit `destinations` scope. `WAFFLE_RELAY_ISSUER_CREDENTIAL` can replace the credential file. Use a different secret. Put that endpoint behind your authenticated app or access proxy as well. Never authorize minting from reachability alone.

## Stage privately or host with a supervisor

The runnable server is WebSocket-only unless its explicit native block and optional peers are configured. Building or testing this package does not install a service or publish a route.

For private Mesh staging, install a reviewed package into a versioned directory under `/work/services/waffle-relay/releases/`. Run the CLI with an enabled user service and `Restart=on-failure`. Proxy HTTPS and WebSocket upgrades to its numeric loopback listener. Keep the private route private. Verify the exact route from an authorized device. Mesh routing is not process supervision. Record the service name, restart command and route-removal command before retaining it.

For Brine hosting, build a digest-pinned image from reviewed source. Supply the config as a secret-free file and the secret through a protected reference. Configure a health check and a Caddy route that preserves Origin and supports WebSocket upgrades. Keep `/v1/tcp/token` behind the app's authenticated boundary. Validate `brine plan --json` before `brine apply --json`. Record `brine status`, `brine logs`, restart and rollback evidence for the selected target. WebTransport needs a separate UDP listener and a supported deployment route. The approved deployment below uses direct private PC UDP, not Brine. A working WebSocket route is not proof of UDP support.

For either target, check `/healthz`, `/readyz`, rejection without a token, and a scoped connection to an operator-approved fixture. Test shutdown with live sockets. Rotate the protected secret atomically and restart the service to invalidate existing tokens. Keep the previous reviewed package for rollback without changing policy or secret scope. Limit log retention and exclude the local development token output from collectors. Remove temporary fixtures and routes after verification.

## Private PC WebTransport deployment

This lane prepares configuration only. The approved host is the private PC. Mesh supplies authenticated HTTPS and WSS; the native endpoint binds UDP only to `100.77.94.94:4433`. Nothing is public. Mesh's HTTP route does not publish or supervise UDP. Do not add Brine UDP or host-network workarounds.

Use a versioned install below `/work/services/waffle-relay/releases/` and a `current` symlink. Keep config and owner-owned mode-0600 secrets outside the version directory. Install the prepared Waffle archive and the matching relay archive together. WebTransport additionally requires these exact packages:

```sh
npm install --save-exact @fails-components/webtransport@1.6.11 @fails-components/webtransport-transport-http3-quiche@1.6.11
```

For Bun, explicitly trust `@fails-components/webtransport-transport-http3-quiche` in the application's `trustedDependencies` before its install script runs. A clean install without the explicit optional peers remains WebSocket-only. The native install script downloads a prebuild outside npm's package-integrity protection. The native entry checks the installed package versions and streams the addon through SHA-256 before evaluating the native loader. A mismatch fails before native code runs. Verify the downloaded archive before making the release current:

```text
webtransport-transport-http3-quiche-v1.6.11-napi-v6-linux-x64.tar.gz
SHA-256 6340d0f657e37daaf168fe4bd77ad227653df3e3da52c96d1448a98dbfaf4c12

build/Release/webtransport.node, extracted from that archive
SHA-256 5592208da56aee0f53615b8d8c5d57c99a87618593c6343787ac9f92761daf1d
```

The archive is the public `fails-components/webtransport` GitHub release asset under `v1.6.11`. Both npm packages record revision `71d1ba5147c7733fbfd3a375116b9f58484d9f13` and BSD-3-Clause licensing. Keep native bytes in the versioned install, never in the source repository. Only linux-x64 was executed in N3. Linux-arm64 and Darwin-arm64 release assets exist, but that is not runtime proof.

Node 22.18 or newer, OpenSSL with P-256 support, a libc-compatible linux-x64 host and the native prebuild are required. Bun 1.4.4 is also exercised. The runtime creates short-lived mode-0700 generation scratch, removes its PEM/key files before publishing, and keeps certificate material in memory. Set `WAFFLE_RELAY_TMPDIR` to the service's private data-drive scratch directory.

Add the native block to the existing secret-free config:

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "allowedOrigins": ["https://your-authenticated-page.example"],
  "tcp": {
    "tokenSecretFile": "/work/services/waffle-relay/token-secret",
    "destinations": [],
    "webtransport": {
      "host": "100.77.94.94",
      "port": 4433,
      "certificate": "rotating-hash"
    }
  }
}
```

Populate the exact destination allowlist and numeric private-target overrides before enabling the service. Configure an authenticated issuer only with a separate protected credential and an explicit narrowed scope. Tailnet reachability alone never authorizes token issuance.

The [systemd user unit](private-pc.service) pins the Node executable and joins normal shutdown. Adjust its executable path to the reviewed installed Node version. Linger is already enabled on the approved PC. Verify it rather than changing it. Create the private scratch directory before starting the unit.

D1 must record the versioned install, private Mesh route, service, exact native checksums, allowlist and secret-file ownership without recording secrets. Its acceptance checks are:

1. `systemctl --user status waffle-relay.service` reports an enabled active unit. `/healthz` and `/readyz` answer through the private Mesh HTTPS route.
2. `ss -lunp` shows UDP only on `100.77.94.94:4433`. An authorized remote Chromium device completes discovery, hash validation, a stream and a TCP exchange. A local loopback success is not that proof.
3. A forced-WebSocket exchange succeeds through Mesh with no UDP dependency. An unknown Origin, wrong path or invalid token creates no target connection.
4. Restart the user unit. Discovery advertises a changed hash, and a new Chromium session succeeds. Rotation resets WebTransport streams without replay; it leaves existing WebSocket streams alone.
5. Record bounded redacted journald output, automatic restart and persistence evidence. Use `journalctl --user -u waffle-relay.service` and filter `webtransport-endpoint` for lifecycle events.
6. Roll back the `current` symlink and restart. Verify health and a fresh exchange without changing the allowlist or secret scope.

Removal is `systemctl --user disable --now waffle-relay.service`, removal of the task's Mesh route, and deletion of the versioned service directory only after its sockets and consumers are stopped. D1 owns that deployment and its removal. N3 does not deploy or retain a service.

For reproducible package checks, build the relay, set `WAFFLE_PACKAGE_ARCHIVE` to the matching prepared Waffle archive, and run `bun run --cwd packages/waffle-relay test:install`. This verifies clean npm and Bun installs, optional-native loading, native checksum equality and actual executable startup. `test:webtransport` runs the local Chromium carrier fixture under Node and Bun. Set `WAFFLE_TEST_WINDOW=65536` to repeat its paused-direction matrix with a 64 KiB receive window. Both carriers advertise mandatory peer windows and use consumer-boundary application credit. Native write settlement alone is not a receive-memory bound. It requires the pinned Playwright Chromium installation and `NETWORK_SCRATCH_ROOT` on a data drive. Use the host's heavy runner for these fixtures.
