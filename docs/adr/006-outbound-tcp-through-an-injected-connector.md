# ADR 006: Outbound TCP through an injected connector

## Status

Accepted on 2026-10-31.

## Decision

Browser Waffle keeps its Rust network module virtual-only and accepts an optional page-owned
`NetConnect` function on `RuntimeNetwork.createHelper`. Loopback names and addresses always use the
existing virtual namespace. A non-loopback connect uses the injected connector only when the helper
was explicitly configured; otherwise it returns the existing `ENOTSUP` result.

The connector returns a `NetOutboundStream` with Web Streams and the actual remote `PeerAddr`. The
helper publishes a pending connect immediately, then an `Open` ring record or a mapped `Error`
record. The guest-facing host retains the existing 1 MiB receive and write limits, records a
pre-open shutdown, aborts pending connects on close, and disposes every connector stream with its
worker helper.

## Consequences

Relay and carrier code remain page-owned and are not imported by Waffle core. The worker boundary
carries only ring records and ordinary socket metadata. DNS remains localhost-only, and the relay
or another trusted page connector resolves and validates non-loopback names.
