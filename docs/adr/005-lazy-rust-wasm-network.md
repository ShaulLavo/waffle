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

Waffle's reference native adapter is `network/src/native.rs`. Only that native target links `socket2`. Its Unix readiness bridge waits in `poll` outside WASM. The module reports read/write interests so drained streams do not busy-loop. After readiness, an embedder calls `tcp_poll` or `tcp_accept` in the module. Short I/O is progress, not a message boundary. The module retains unsent bytes and delays write shutdown until its queue drains. A close releases resources immediately; it does not promise graceful delivery of unread or queued bytes.

## Build and size

Source installation now requires the pinned Rust toolchain and `wasm32-unknown-unknown` target. `prepare` builds a missing or stale asset and copies it beside the prepared Node loader. Generated WASM stays ignored. Browser bundlers must serve `network.wasm` beside the emitted network code with `application/wasm`.

CI builds the exact-input asset once. Package and browser jobs restore it and never invoke Cargo. Rust toolchain, Cargo downloads, and target artifacts are cached. Rust checks run when their path filter selects inputs, on manual dispatch, or when an exact artifact is absent.

`size:network` reports raw WASM, gzip WASM, and gzip loader bytes independently. The core budget is unchanged.

## Deliberate limits

The host ABI exposes immediate nonblocking OS operations plus readiness-driven progress. It does not yet support a host whose bind operation completes asynchronously, DNS resolution, TLS, or close linger timers. These are not browser capabilities. Bun's matching consumer integration and facade fixtures remain Bun-owned.
