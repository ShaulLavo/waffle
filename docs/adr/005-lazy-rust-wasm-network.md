# 005. Load portable TCP state as a separate Rust WASM module

Status: Accepted. Scoped Rust exception authorized on 2026-10-25.

## Context

Bun-wasm needs nonblocking TCP, including IPv6-unspecified listeners that accept IPv4 and fall back when IPv6 is unavailable. Waffle owns reusable transport behavior. Bun keeps its JavaScript APIs, JSON errors, public handle table, engine registration, and policy.

The source baseline is `d9973ca6b892ecf4b8a210be5328eb2645207d0d`. The source transport is bun-wasm PR116 at `4a734933901f5ff4c403925d1589afc2a4ce2e71`.

## Decision

Compile `network/` to one `wasm32-unknown-unknown` module, without WASI or shared memory. Rust owns bounded byte queues, nonblocking stream state, sticky failures, bind fallback, and virtual namespace address and port rules. No native threads enter WASM.

The existing `runtime.network()` dynamic import reaches `browser/net/namespace.ts`. That module compiles the asset once per realm. Each namespace creates a fresh instance. Runtime helpers share that instance, and runtime disposal closes helpers before disposing it. Filesystem use, program registration, and process activation do not load it.

`waffle/network` exports an explicit standalone loader. Import alone has no effects. An embedding owns each instance and must dispose it. There is no global runtime or new runtime option.

Browser instances use only the Rust virtual namespace commands. Their OS import returns `Unsupported`. The private module instance never appears in a guest capability. Existing `NetHost`, `NetNamespace`, helper messages, ring records, JSON shapes, and guest handles remain unchanged.

Waffle's reference native adapter is `network/src/native.rs`. Only that native target links `socket2`. Its Unix readiness bridge waits in `poll` outside WASM. The module reports read/write interests so drained streams do not busy-loop. After readiness, an embedder calls `tcp_poll` or `tcp_accept` in the module. Short I/O is progress, not a message boundary. The module retains unsent bytes and delays write shutdown until its queue drains. Native host tokens are quarantined for the instance lifetime so delayed readiness cannot alias a new socket, even after raw ABI disposal. A duplicate active token is rejected without closing the live resource. Immediate close still releases resources without delivery guarantees. Explicit graceful close drains admitted output, sends FIN and discards unread input. A completion export separates writer completion from peer EOF. The consumer selects deadlines and closes the token after completion or expiry. Unix wait-many includes a socket-pair control wake so one module actor can serve all sockets and consumer commands without sleep polling.

## Build and size

Source installation now requires the pinned Rust toolchain and `wasm32-unknown-unknown` target. `prepare` builds a missing or stale asset and copies it beside the prepared Node loader. Generated WASM stays ignored. Browser bundlers must serve `network.wasm` beside the emitted network code with `application/wasm`.

CI builds the exact-input asset once. Its input stamp and SHA-256 checksum travel with the ignored asset outside `dist/`. Package and browser jobs verify both before installation and forbid Cargo. Preparation verifies again before deleting `dist/`, then copies the asset beside the emitted loader. Rust toolchain, Cargo downloads, and target artifacts are cached. Rust checks run when their path filter selects inputs, on manual dispatch, or when an exact artifact is absent.

`size:network` reports raw WASM, gzip WASM, and gzip loader bytes independently. The first measured sizes are 85,060 raw WASM bytes, 26,853 gzip WASM bytes, and 664 gzip loader bytes. The respective budgets are 88,000, 28,000, and 800 bytes. Token quarantine adds 4,062 raw bytes and 560 gzip bytes to the initial module measurement; the raw budget rises from 85,000 to 88,000 bytes. The core budget is unchanged. Native graceful retirement and completion exports measure 89,877 raw and 28,225 gzip bytes, with the unchanged 664-byte gzip loader. Their budgets are 92,000 raw, 29,000 gzip and 800 loader bytes. Unix readiness code remains outside the asset.

## Deliberate limits

The host ABI exposes immediate nonblocking OS operations plus readiness-driven progress. It does not yet support a host whose bind operation completes asynchronously, DNS resolution, TLS, or module-owned close linger timers. Graceful retirement has no clock; the consumer keeps its deadline policy. These are not browser capabilities. Bun's matching consumer integration and facade fixtures remain Bun-owned.
