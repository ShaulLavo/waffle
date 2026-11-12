# 005. Load portable TCP state as a separate Rust WASM module

Status: Accepted. Scoped Rust exception authorized on 2026-10-25.

## Context

Bun-wasm needs nonblocking TCP, including IPv6-unspecified listeners that accept IPv4 and fall back when IPv6 is unavailable. Waffle owns reusable transport behavior. Bun keeps its JavaScript APIs, JSON errors, public handle table, engine registration, and policy.

The source baseline is `d9973ca6b892ecf4b8a210be5328eb2645207d0d`. The source transport is bun-wasm PR116 at `4a734933901f5ff4c403925d1589afc2a4ce2e71`.

## Decision

Compile `network/` to one `wasm32-unknown-unknown` module, without WASI or shared memory. Rust owns bounded byte queues, nonblocking stream state, sticky failures, bind fallback, and virtual namespace address and port rules. No native threads enter WASM.

The existing `runtime.network()` dynamic import reaches `browser/net/namespace.ts`. That module loads a translated factory once per realm. Each namespace creates a fresh private ArrayBuffer owner. Runtime helpers share that instance, and runtime disposal closes helpers before disposing it. Filesystem use, program registration, and process activation do not load it.

`waffle/network` exports an explicit standalone loader. Import alone has no effects. An embedding owns each instance and must dispose it. There is no global runtime or new runtime option.

The runtime universally uses the ArrayBuffer execution form of the same Rust module. It creates no WebAssembly.Memory or WebAssembly.Instance and fetches no network.wasm. This avoids the large WebKit fast-memory reservation even for a tiny private Wasm memory. No engine detection, descriptor change or GC timing is involved.

Browser owners use only the Rust virtual namespace commands. Their OS import returns `Unsupported`. The private module instance never appears in a guest capability. Existing `NetHost`, `NetNamespace`, helper messages, ring records, JSON shapes, and guest handles remain unchanged.

Waffle's reference native adapter is `network/src/native.rs`. Only that native target links `socket2`. Its Unix readiness bridge waits in `poll` outside WASM. The module reports read/write interests so drained streams do not busy-loop. After readiness, an embedder calls `tcp_poll` or `tcp_accept` in the module. Short I/O is progress, not a message boundary. The module retains unsent bytes and delays write shutdown until its queue drains. Native host tokens are quarantined for the instance lifetime so delayed readiness cannot alias a new socket, even after raw ABI disposal. A duplicate active token is rejected without closing the live resource. Immediate close still releases resources without delivery guarantees. Explicit graceful close drains admitted output, sends FIN and discards unread input. A completion export separates writer completion from peer EOF. The consumer selects deadlines and closes the token after completion or expiry. Unix wait-many includes a socket-pair control wake so one module actor can serve all sockets and consumer commands without sleep polling.

## Build and size

Source preparation requires the pinned Rust toolchain, `wasm32-unknown-unknown`, and npm Binaryen 132.0.0 invoked explicitly by Bun. `tooling/network-translator/{package.json,bun.lock}` is an isolated build-tool pin, outside consumer dependency graphs. The producer installs privately with frozen integrity checks, no scripts and copyfile, validates executable SHA-256 and version on every use, then publishes an immutable cache directory. Concurrent producers validate and reuse the winner. Published corruption fails without deletion or repair. Only task-owned temporary installs are cleaned automatically.

The separate native Binaryen 133 program optimizer is unchanged. The network translator adds only an attribution header and `export` to its factory output. Generated JavaScript, Wasm and stamps remain ignored. Prepared archives contain both forms beside source and Node loaders. Preparation verifies them before touching `dist`, with no compiler or download. Only standalone `waffle/network` users must serve `network.wasm` beside that loader.

CI builds both forms once. Source input identity, separate checksums and the exact-artifact allocator growth trace travel outside `dist`. Every consumer verifies before installing, forbidding Cargo and translation. Compiler and Rust caches belong to the producer. `size:network` independently gates Wasm, raw generated JavaScript, its minified chunk and both loaders. The core gate is unchanged.

## Virtual resource policy and failure

All virtual TCP, pathname and abstract pairs share 512 endpoint records: at most 256 pairs. Both records remain charged until both halves close. There is no reserved pathname allocation; the existing 128 pathname/abstract pair cap also applies. Virtual TCP listeners share 1,024 records. This reduces the former theoretical TCP capacity. Native OS `Tcp` is unchanged; the standalone Wasm loader's virtual commands inherit these limits.

Queues retain at most 1 MiB per direction. Undelivered queued bytes cannot release outstanding credit, even after an over-reported acknowledgement. Fixed metadata is allocated at creation. Afterwards only one allocation site acquires lazy 4 MiB slabs, up to 136 slabs. Chunks are reused after take/close. The first queued byte therefore costs a whole slab, roughly 5.3 MiB of linear memory including initialization for the current artifact. Slabs remain until owner release. These are linear lengths, not physical memory measurements.

The 1 GiB operational envelope is conditional on the pinned allocator and exact producer artifact. The [allocator contract](../network-memory.md) records the fixed-allocation premise and complete 136-slab gate. It is separate from wasm2js's 2 GiB signed-length boundary. Producer/toolchain changes invalidate the artifact and require the gate again.

Quota exhaustion refuses a new resource without poisoning the owner. Closing resources restores admission. A catchable translated allocation throw is terminal: the loader records one `NetworkOwnerFailure`, drops its exports and never enters or recreates them. Namespace retirement marks, detaches and wakes every socket before isolated reset callbacks. Callback errors are retained on the original failure. Writes reset, reads report ECONNRESET and new loopback binds/connects refuse; external fetch and lookups remain healthy. Helpers and runtime dispose without poisoned Rust. Failed initial activation and its disposal preserve the existing shared rejection identity. No arbitrary host OOM recovery or native/framework acceptance is claimed.

## Deliberate limits

The host ABI exposes immediate nonblocking OS operations plus readiness-driven progress. It does not yet support a host whose bind operation completes asynchronously, DNS resolution, TLS, or module-owned close linger timers. Graceful retirement has no clock; the consumer keeps its deadline policy. These are not browser capabilities. Bun's matching consumer integration and facade fixtures remain Bun-owned.
