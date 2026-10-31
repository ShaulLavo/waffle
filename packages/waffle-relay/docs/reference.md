# Relay configuration and limits

## Entry points

- `waffle-relay` exports `createRelayFetch`, `createRelayConnect`, their errors, and configuration types. It imports no Node server code.
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

The HTTP fetch relay remains HTTP-only. TCP is a separate opt-in capability described below. The Worker adapter has no TCP endpoints.

## TCP client

`createRelayConnect({ endpoint, getToken, carriers?, webSocket?, windowBytes?, connectTimeoutMs? })` returns `{ connect, carrier, revoke, close }`. It imports no Waffle outbound connector module. Its stream shape is structurally compatible with a page-owned connector.

`endpoint` is an HTTPS root URL without credentials, query or fragment. HTTP is accepted only for `localhost`, `127.0.0.1` and `[::1]`. `getToken` runs for every connect. Tokens never enter the URL or guest state. The WebSocket implementation loads dynamically on the first connection. The default carrier order is `["webtransport", "websocket"]`, but this foundation implements only WebSocket. It makes no WebTransport probe or retry. An exclusively WebTransport configuration fails with `ENETUNREACH`.

Browsers supply Origin. Node and Bun pass `webSocket: createNodeWebSocket(origin)`, imported from `waffle-relay/node`. This adapter sets the exact page origin, disables compression and redirects, and caps messages at 64 KiB plus one type byte. A custom `webSocket` factory is a trusted host adapter, not guest input.

`connect({ host, port }, signal)` resolves after the successful open reply. The result contains `readable`, `writable`, `remote` and diagnostic `counters`. Reader EOF is the target's FIN. Writer close sends FIN without ending reads. Abort, carrier loss and revocation reset the connection. Reader cancellation normally resets too. After writer FIN, reader cancellation instead discards replies while preserving already-sent uploads until both FINs or the drain deadline. Established connections never reconnect. `revoke()` fences admission synchronously. `close()` also joins allocated carrier cleanup. A caller-aborted connection retains the caller's abort reason. Other failures use redacted `RelayConnectError.code` values.

The 15 second client deadline includes token retrieval, lazy loading, carrier setup and open. The signal remains attached after open. The client does not retain a failed carrier for a later attempt. A late token result cannot create a carrier after revocation. Native adapters force termination at the cleanup deadline. Browsers expose no force-terminate API, so the deadline releases local ownership after requesting close; the browser owns the remaining close handshake. The caller owns queued `WritableStream` writes and must await each write rather than enqueue an unbounded series.

## TCP server policy

`createNodeRelayServer` accepts an optional `tcp` block. Without it, the TCP routes do not exist. With it, the server exposes `tcp.active`, per-connection `tcp.counters`, and `revoke()` beside the existing HTTP methods. Closing the server revokes both capabilities and joins target and carrier receipts. The HTTP fetch protocol and policy are unchanged.

`tcp.tokenSecret` is a string or byte array containing at least 32 bytes. It differs from the HTTP credential. `tcp.destinations` defaults to an empty list. Each entry is `{ host, port, connect?, allowMail? }`. There are no wildcards, ranges or public-forwarding modes.

All matching uses the same structured `{ host, port }` key. Names become lowercase ASCII through IDNA conversion, with one optional trailing dot removed. IPv6 literals are compressed. IPv4-mapped IPv6 keys become IPv4. Alternate IPv4 spellings, credentials, scopes, invalid labels and ambiguous authorities are rejected. The port is an integer from 1 to 65535.

Without an override, the server resolves all A and AAAA answers once per connection. Every answer must be globally routable. Empty resolution fails. Mixed global and private answers fail together. Mapped IPv6 DNS answers, loopback, private, tailnet, link-local, metadata, multicast and other special-use addresses fail. The target socket receives the selected numeric address directly and does not resolve again.

`connect` is an operator-only numeric override. It can reach private targets but cannot change which guest-visible key is allowed. The guest never selects an override. Ports 25, 465 and 587 in either the requested or override destination require `allowMail: true` at configuration load.

TCP requests require one canonical non-null Origin matching `allowedOrigins` exactly. Missing, duplicated, malformed or alternate spellings fail. Policy failures create no target socket. Origin and admission denials use an open-error reply followed by carrier close, without starting a target. The outer listener also bounds unauthenticated sockets. At most eight denied WebSocket handshakes wait for cleanup; excess denials close their transport immediately.

## TCP tokens and issuer

`waffle-relay/token` exports `mintRelayToken(secret, claims)`. Claims contain integer Unix-second `exp`, optional printable opaque `sub` of at most 128 characters, and optional `dst` with at most 128 structured destination keys. Scope can narrow the server allowlist, never widen it. Omitted scope still requires the server allowlist.

The format is `v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`. The MAC input is `waffle-relay-tcp-v1.` followed by the encoded payload. Verification uses WebCrypto's HMAC verification, not a string comparison. `now >= exp` rejects without grace. Expiry beyond 24 hours also fails. Invalid tokens return only `relay-auth`.

The optional issuer is `{ credential, ttlSeconds, destinations }`. Its credential differs from the TCP secret and is at least 32 bytes. Its explicit destination scope must be a subset of the relay allowlist. `POST /v1/tcp/token` requires that separate bearer credential and an allowed Origin. The JSON body is `{ sub, dst }`. Requested scope must be within the issuer scope. The issuer never authorizes a request merely because it arrived over a private network. It is absent in development mode.

## TCP protocol v1

`GET /v1/tcp` upgrades to one WebSocket per TCP stream. Its first message in each direction is UTF-8 JSON text, at most 8 KiB:

```json
{ "v": 1, "token": "<app-owned token>", "host": "db.example", "port": 5432 }
```

The reply is `{ v: 1, ok: true, remote: { address, port, family } }` or `{ v: 1, ok: false, code }`. The remote endpoint is the selected numeric target. A client sends no payload before success. A second header or data during opening is a protocol error. The shared incremental decoder also supports a two-byte big-endian length prefix for later stream carriers, including fragmented prefixes, JSON, and a following payload.

After open, binary messages begin with a type byte. `0` carries 1 to 65536 data bytes. `1` carries no payload and means FIN. `2` carries a nonzero big-endian u32 credit increment. Each direction starts with 262144 bytes of credit. Duplicate FIN, data after FIN, text after open, invalid types, malformed messages, excess credit and credit overruns close with 1008.

Both FINs and all acknowledged data are required for graceful close with 1000. Reset codes are 4001 for target reset, 4002 for idle timeout, 4003 for a relay limit, and 4004 for shutdown. Other abnormal closes are carrier loss. A five-second drain deadline bounds half-close and carrier teardown. The target uses `allowHalfOpen`, `TCP_NODELAY`, and keepalive after 60 seconds.

Before open, auth, origin and policy errors map to `EACCES`, limits and refusal to `ECONNREFUSED`, DNS failure to `ENOTFOUND`, connect timeout to `ETIMEDOUT`, and target unreachability to `EHOSTUNREACH`. Carrier loss before a reply maps to `ENETUNREACH`. After open, resets map to `ECONNRESET`.

## TCP limits and diagnostics

| `tcp.limits` field         | Default |
| -------------------------- | ------: |
| `maxConnections`           |      64 |
| `maxConnectionsPerSubject` |      16 |
| `attemptsPerMinute`        |      30 |
| `maxSubjects`              |    4096 |
| `maxOpenBytes`             |    8192 |
| `headerTimeoutMs`          |    5000 |
| `connectTimeoutMs`         |   10000 |
| `idleTimeoutMs`            |  900000 |
| `windowBytes`              |  262144 |

The subject is `sub`, or a SHA-256 token hash when `sub` is absent. Rate accounting uses fixed one-minute windows. Inactive expired subjects are removed before admission. The bounded subject table rejects new subjects when full. Header and window limits may be lowered, not raised above protocol maxima. A lowered window requires the same client `windowBytes`. Idle timeout `0` disables that timer.

Server counters are `toTargetBytes`, `toClientBytes` and `readAheadBytes`. The first two count admitted bytes not yet consumed by their receiver. Target write completion returns upload credit. Actual client reads return download credit. A paused TCP read uses one fixed 64 KiB `onread` buffer, so read-ahead cannot grow with the stream's internal high-water mark. Client counters are `receiveQueuedBytes` and `sendOutstandingBytes`. These counters exclude the caller-owned guest queues, whose 1 MiB bound belongs to the injected helper, not this package.

`tcp.log` receives bounded structured events. The default writes JSON to stdout. Each admitted connection logs an open on success and exactly one terminal close after cleanup. Events include time, connection ID, subject, canonical requested destination, carrier, byte counts, duration and close reason. They contain no token, payload, issuer credential, raw error text or resolved override. Logger failures do not retain connections.

`GET /healthz` returns `{ ok: true }`. `GET /readyz` returns 200 while this local listener accepts work and 503 after revocation. Neither response reveals configuration. This WebSocket-only readiness does not certify TLS proxy configuration, UDP reachability or a production deployment.
