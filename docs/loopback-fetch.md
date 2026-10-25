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
