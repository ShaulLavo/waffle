# Loopback Fetch contracts

`NetHelper` applies Fetch redirect policy before publishing a response head to `NetHost`.
The same policy handles virtual HTTP listeners and injected `NetFetch` responses.

- `follow`, the default, resolves relative `Location` values against the current URL and follows at most 20 redirects.
- `manual` returns the redirect response without following it. Virtual responses retain their status, headers and body rather than becoming browser `opaqueredirect` responses.
- `error` fails the fetch on a redirect status, even when `Location` is absent.
- Redirect statuses are 301, 302, 303, 307 and 308. POST changes to GET for 301 and 302. A 303 changes methods other than GET and HEAD to GET. These changes discard the body and its content headers. Other redirects replay the snapshotted request body.
- Cross-origin hops remove authorization and cookie headers. Destinations must use HTTP or HTTPS and cannot contain URL credentials.
- Each hop selects a current virtual listener or calls the injected network policy. External policy calls receive `redirect: "manual"` so hidden redirects cannot bypass the helper's destination checks or loop limit.

A browser's native Fetch can hide a redirect's status and `Location` as an `opaqueredirect` response. The helper cannot follow that response. `follow` and `error` fail with `TypeError`; `manual` retains the browser response. Embedders that need external redirects must supply a policy that exposes redirect heads. Waffle does not retry with a less restrictive network policy.

Intermediate bodies are cancelled rather than buffered. Cancellation closes the virtual peer or aborts the pending external request. Final bodies keep the existing Fetch acknowledgement window and virtual TCP receive credit.

## Compressed response bodies

Fetch Data records contain decoded application bytes. `Content-Encoding` and `Content-Length` retain the server's wire metadata, as with browser Fetch. `FetchHead` does not emit `bodyEncoding`. A consumer must not decode again from `Content-Encoding`.

Only virtual HTTP bodies need content decoding. External `NetFetch` bodies are already decoded and pass through unchanged, even when their headers still name an encoding.

Virtual decoding uses incremental platform `DecompressionStream` instances, with Fetch acknowledgement backpressure and cancellation propagated through each decoder. Gzip, x-gzip, deflate, br and zstd are recognized. Stacked encodings are decoded in reverse order. Identity is a pass-through. Brotli and zstd require support from the embedding platform; unavailable codecs and unknown encodings fail the body with `TypeError` after the response head. Malformed or truncated compressed input also fails the body instead of ending successfully. HEAD, 204 and 304 responses have no compressed body to decode.

The Bun consumer contract test runs the read-only consumer's actual `net.js` and `compression_streams.ts` factories against shared-Worker response output. Set `BUN_WASM_SOURCE` to its source checkout and run:

```sh
BUN_WASM_SOURCE=/path/to/bun-wasm bun test tests/loopback-fetch-bun-consumer.test.ts
```

This proves that the consumer passes already-decoded bodies through without constructing another codec. It is a source-executed contract check, not a compiled bun-wasm guest or browser-engine end-to-end test.
