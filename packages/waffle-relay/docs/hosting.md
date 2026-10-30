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
