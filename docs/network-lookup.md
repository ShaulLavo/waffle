# Virtual name lookup

`runtime.network()` exposes the runtime's virtual loopback lookup policy. The same JavaScript capability is available to browser bridges and native JavaScript embedders. The standalone Rust socket module has no resolver operation.

```ts
const network = await runtime.network();
const records = network.lookup("localhost", { family: 0, hints: 0 });
// [{ address: "127.0.0.1", family: 4 }]
```

`lookup` is synchronous after network activation. It returns a fresh mutable array of fresh `{ address: string, family: 4 | 6 }` records in resolver order. It needs no helper, ring, listener or socket. It performs no fetch, OS DNS, child creation or network-module I/O. Network activation retains its existing lazy WASM load and runtime-owned instance.

## Names and options

| Hostname    | Family 0 result                         |
| ----------- | --------------------------------------- |
| `localhost` | `[{ address: "127.0.0.1", family: 4 }]` |
| `127.0.0.1` | `[{ address: "127.0.0.1", family: 4 }]` |
| `::1`       | `[{ address: "::1", family: 6 }]`       |

`family` defaults to `0`. Values `4` and `6` filter the result. `hints` defaults to `0`, the only supported value. Names are exact and case-sensitive. Wildcard bind addresses, expanded literals and other names are unsupported by this lookup API. Existing TCP bind and connect address rules are unchanged.

Bun owns overload validation, IP-literal fast paths, callbacks, promises, `all`, `verbatim`, ordering and default-order state. Its adapter translates native `flags` to Waffle's `hints` before calling this capability. Those facade options are not Waffle lookup options. With current virtual policy, both Vite calls, `lookup("localhost")` and `lookup("localhost", { verbatim: true })`, select the single IPv4 result in Bun.

## Errors and lifetime

Lookup failures throw the exported `RuntimeNetworkLookupError`. The error has `name: "RuntimeNetworkLookupError"`, a descriptive `message`, `code`, `syscall: "getaddrinfo"` and the original `hostname`.

- `ENOTSUP` means Waffle cannot resolve that name or honor nonzero hints. It does not mean the name is absent from OS DNS.
- `ENOTFOUND` means a supported name has no record in the requested family. For example, `localhost` with family `6`, or `::1` with family `4`.
- An empty or non-string hostname, or a family outside `0`, `4`, `6`, throws `TypeError`. Bun's public validation and error-code translation remain in Bun.
- Once runtime disposal starts, a saved lookup capability throws `Error("Runtime is disposed")`, including when an option getter starts disposal.

Adapters preserve `code`, `syscall` and `hostname` when sending a failure through their own promise or callback bridge. No empty successful array or `ENOTFOUND` substitutes for unsupported resolution. No arbitrary DNS or outbound TCP capability is implied.

The lookup implementation is original Waffle code. Its localhost and numeric loopback policy follows `tcpAddress` at `3d5304bf44390bfc4ab520aae60d7c0f6c9267a9`; it copies no Bun or OS resolver implementation.
