# Relay configuration and limits

## Entry points

- `waffle-relay` exports `createRelayFetch`, `RelayError`, and configuration types. It imports no Node server code.
- `waffle-relay/node` exports `createNodeRelayServer`. The same adapter runs on Node and Bun.
- `waffle-relay/worker` exports `createWorkerRelayHandler`. It uses the Worker's Fetch API.

The base `waffle` package has no relay dependency. Its lazy network helper reads validated, page-owned response metadata from `waffle/browser/net/transport`. Ordinary direct fetch responses keep their existing URL and redirect behavior. An upstream header or similarly named response property cannot supply transport metadata.

## Client

`createRelayFetch({ endpoint, credential, limits?, transport? })` returns `{ fetch, revoke, close }`. The endpoint must use HTTPS except for exact loopback HTTP hosts. It accepts `/` or `/v1/fetch`, with no URL credentials, query, or fragment. The bearer credential must contain 16 to 4096 printable ASCII characters.

The host must keep the credential out of guest state, headers, environment, logs, and error reports. Guest `Authorization` never authenticates the relay. `transport` is an optional trusted host transport, captured once, not a guest callback.

`fetch` accepts HTTP and HTTPS, seven ordinary HTTP methods, safe headers, and a raw body. Bodies may be bytes, text, Blob, URLSearchParams, or a byte stream. Replayable bodies retain their representation, so browsers need not support streaming uploads for Waffle's byte-array requests. FormData is rejected rather than buffered without a size bound. A body stream cannot be replayed across a preserving redirect. Manual mode returns the redirect without replaying the body or requiring a usable Location. Body-inferred content types follow the platform Request behavior unless the caller supplies an explicit content type.

Manual hops driven by one helper signal share a redirect count. The client also implements `follow` and `error` redirect modes. Every hop makes a fresh policy-checked server request. Cross-origin redirects drop caller credentials. Server credential profiles are selected independently by the new exact origin, so a profile never leaks to another origin.

Returned Fetch bodies contain decoded bytes. Transport metadata carries the target URL to Waffle's `FetchHead`. A directly inspected synthetic `Response.url` remains empty; it is not the relay endpoint and is not used as authenticated metadata.

## Server policy

Both adapters accept `credential`, `allowedOrigins`, `destinations`, `credentials`, and `limits`. `destinations` defaults to `{ mode: "fixed-origins", origins: [] }`, which denies every destination. Origins are exact HTTP origins, including port. Paths, queries, credentials, fragments, suffix matches, and wildcards are not origin policy syntax.

Node and Bun also accept `{ mode: "public-https" }`. Each hop resolves once, rejects empty or mixed public/private answer sets, and passes a selected numeric address directly to the socket connection. The original Host and TLS server name remain intact. TLS verification cannot be disabled. Public mode denies HTTP, loopback, link-local, private, carrier-grade NAT, multicast, documentation, IPv4-mapped IPv6, NAT64, and transition addresses. The IPv6 policy conservatively admits only global unicast outside its reserved ranges. Fixed mode may reach an exact operator-selected private origin; public mode never inherits that permission.

The Worker adapter rejects `public-https` synchronously. It has no connection-validated public-address connector. `global_fetch_strictly_public` changes own-zone routing; it is not peer-IP classification. The Worker cannot promise host-private-network reach or a global concurrency bound across isolates.

Credential profiles contain an exact `origin` and operator-owned `headers`. Guest cookies, authorization, proxy headers, authority, forwarding headers, connection-nominated headers, and relay metadata are stripped. Target cookies and relay-looking headers never reach the caller. Content length and encoding headers are removed because the returned body is decoded and streamed.

## Limits

Limits apply per hop and per capability or handler instance. The redirect budget belongs to the client/helper chain, not a cross-request server session. An authenticated operator can start another independent request.

| Limit                                  |    Default |
| -------------------------------------- | ---------: |
| Request body                           |      1 MiB |
| Decoded response body                  |     64 MiB |
| Target headers                         |     32 KiB |
| Percent-encoded protocol metadata      |     32 KiB |
| Redirects                              |         10 |
| Concurrent active exchanges            |         16 |
| Idle time, including stalled consumers | 30 seconds |

Streaming uses pull-driven readers with no eager output queue. Neither adapter base64-encodes bodies or aggregates response bodies. Node preserves socket backpressure and retains its connection until actual socket close. Worker Fetch and stream cancellation receipts are platform receipts, not proof that a remote server stopped executing.

`revoke(reason?)` fences new admissions synchronously and aborts active work. `close()` also joins late transport results, readers, and connection receipts. Caller abort reasons retain their identity. A failed cancellation remains redacted cleanup debt, and repeated `close()` calls reject instead of claiming settlement. A platform that never settles a transport promise keeps `close()` pending.

Target HTTP status codes remain target responses, including 401 and 403. Relay policy and authentication failures use bounded `RelayError.code` values before target headers arrive. An error after streamed headers may terminate the HTTP body; the client reports a redacted transport failure rather than inventing a target status or echoing an upstream error. There is no old-version protocol fallback.

Only HTTP is supported. WebSocket upgrades, raw TCP, SSH, secret discovery, device-login UI, and process registration are outside this package.
