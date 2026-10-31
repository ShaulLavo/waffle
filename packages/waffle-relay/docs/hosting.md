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

This PR's runnable server is WebSocket-only. It does not install a service, publish a route, bind UDP, issue certificates or claim a production deployment.

For private Mesh staging, install a reviewed package into a versioned directory under `/work/services/waffle-relay/releases/`. Run the CLI with an enabled user service and `Restart=on-failure`. Proxy HTTPS and WebSocket upgrades to its numeric loopback listener. Keep the private route private. Verify the exact route from an authorized device. Mesh routing is not process supervision. Record the service name, restart command and route-removal command before retaining it.

For Brine hosting, build a digest-pinned image from reviewed source. Supply the config as a secret-free file and the secret through a protected reference. Configure a health check and a Caddy route that preserves Origin and supports WebSocket upgrades. Keep `/v1/tcp/token` behind the app's authenticated boundary. Validate `brine plan --json` before `brine apply --json`. Record `brine status`, `brine logs`, restart and rollback evidence for the selected target. WebTransport needs a separate UDP listener and route in the later carrier work. A working WebSocket route is not proof of UDP support.

For either target, check `/healthz`, `/readyz`, rejection without a token, and a scoped connection to an operator-approved fixture. Test shutdown with live sockets. Rotate the protected secret atomically and restart the service to invalidate existing tokens. Keep the previous reviewed package for rollback without changing policy or secret scope. Limit log retention and exclude the local development token output from collectors. Remove temporary fixtures and routes after verification.
