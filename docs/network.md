# Runtime-scoped networking

`await runtime.network()` returns one lazy network capability per `createRuntime()`.
Each guest worker borrows a distinct helper and ring. Helpers share localhost on
the runtime owner's event-loop thread. Their object lifetimes own listeners and
sockets, not PIDs or guest handles. Networking does not activate process services.

## Launcher wiring

```ts
import type { Runtime } from "waffle";
import { NetHost } from "waffle/browser/net/host";
import { createRing } from "waffle/browser/net/ring";

// On the runtime owner's event-loop thread, for each admitted worker:
const network = await runtime.network();
const ring = createRing();
const helper = network.createHelper({ ring, fetch: fetchPolicy, hooks: previewHooks });
// Forward this worker's NetRequests to helper.handle(request).
// Give the ring to the worker through its normal startup message.

// Inside that worker, with its existing outgoing request transport:
const host = new NetHost(ring, sendNetRequest, writeGuestFile, { shared: true });
```

The names `fetchPolicy`, `previewHooks`, `sendNetRequest` and `writeGuestFile` are
consumer callbacks. Preview hooks register and unregister this helper with the
existing `PreviewRouter`. External fetch policy remains injected.

To let a guest use pathname sockets, also pass a `pathScope` to `createHelper`. See
[Unix-domain stream sockets](unix-sockets.md).

Shared hosts send bind, connect and write commands through their existing sender.
A private shared reply buffer lets the worker wait for the helper's answer.
Incoming bytes, accepts, EOF and writable notifications use the existing ring.
This requires a worker that may use `Atomics.wait`, plus a helper on a different,
responsive event-loop thread. Do not put a shared host on the browser main thread
or put its helper on the blocked guest thread. These calls do not introduce a
second process broker, a second ring consumer or guest-engine bindings.

Omitting `{ shared: true }` retains standalone, in-host pipes. That mode has no
cross-worker namespace. It is a separate capability choice, not version detection.
Do not mix standalone and shared hosts inside one runtime's shared network.

## Socket contract

- Loopback aliases share one port space. Non-loopback TCP remains unsupported unless the page
  explicitly injects a `NetConnect` policy into the helper. The connector receives the original
  hostname and port and returns a Web Streams duplex plus the actual remote address.
  Listeners retain their bind family. IPv6-any listeners accept both families and
  report mapped IPv4 endpoints. See [Browser TCP addresses](browser-network-addresses.md).
- Loopback bind and connect report conflicts and refused connections synchronously.
  Port zero allocates an unused port from 49152 through 65535.
- Accepted handles belong to the listener's helper. Their peer address matches
  the connecting handle's local address, mapped for an IPv4 connection accepted by
  an IPv6-any listener. Numeric handles may coincide across hosts.
- Each TCP receive direction holds at most 1 MiB of unread data. Writes may be
  partial or return `AGAIN`. Reading releases capacity and wakes the writer's ring.
- Shared HTTP fetches retain socket credit while parsed body bytes wait for the
  existing 512 KiB fetch window. Only guest reads acknowledge that window. Pausing
  a reader therefore bounds parser-owned response copies too; cancelling the fetch
  closes its socket and wakes its blocked peer. This applies within one helper and
  between helpers. A host-side `ConnectionSink.data` or `PreviewSink.data` may return
  a `Promise<void>` to defer input credit until its downstream consumer is ready.
- A failed listening hook rolls back the reservation and preview registration
  through the stopped hook. Caller request accessors are read before admission;
  revocation from an accessor or hook cannot create a new listener or connection.
- Shutdown sends EOF in one direction; replies can still travel in the other.
  Full close makes later peer writes fail. Bytes already written precede EOF.
- Closing a listener rejects queued accepts but does not close accepted sockets.
  Closing an accepted socket does not stop its listener.

Call `host.dispose()` for cooperative guest shutdown. Always call `helper.dispose()`
when its worker exits, crashes, fails admission or is terminated, even when the
worker cannot run its own cleanup. `runtime.dispose()` also releases remaining helpers after its existing filesystem
and physical worker-stop fences, before disposing the process host and filesystem.
A failed filesystem fence retains network ownership rather than killing live
consumers. Retained factory/helper operations reject after disposal begins;
helper disposal stays idempotent. The helper removes its listeners, rejects its queued accepts, closes its own
connections and signals peers. It never disposes another helper or namespace.
Worker termination alone cannot invoke page-side cleanup; the launcher owns that
exit hook. Host disposal also stops its ring watcher.

Low-level standalone users first await `NetNamespace.create()`, exported by
`waffle/browser/net/helper`, then pass that initialized namespace as the required
fourth argument to `new NetHelper(ring, fetch, hooks, namespace)`. They dispose their
helpers before disposing the namespace. Compilation is shared and starts only at
this explicit async boundary; each namespace owns a separate module instance.
Importing the helper or runtime network owner never waits for compilation. Runtime
consumers must use `await runtime.network()` instead of creating a second namespace
or a module-global runtime registry. Bun launcher attachment and its physical
worker-exit hooks are separate consumer work.

The shared namespace is smaller than another broker layer. Existing per-worker
messages carry commands, existing rings carry replies and data, and helpers route
ordinary owned socket objects. No additional cross-thread registry is needed.

## Outbound connectors

The page can supply `connect?: NetConnect` alongside its fetch policy:

```ts
import type { NetConnect } from "waffle/browser/net/outbound";

const connect: NetConnect = appConnect;
const helper = network.createHelper({ ring, fetch: fetchPolicy, connect });
```

`appConnect` is trusted page code. It receives `{ host, port }` with the original unresolved
host and an `AbortSignal`. It returns `Promise<NetOutboundStream>` with `readable`, `writable`,
and the actual remote `PeerAddr`. The function is captured once when the helper is created.
Low-level `NetHelper` construction accepts the same connector as its optional eighth argument.
No connector function, stream, token or carrier object crosses into the guest worker.
Waffle imports no relay or carrier implementation. See [ADR 006](adr/006-outbound-tcp-through-an-injected-connector.md).

The synchronous helper reply is `TCP_PENDING = 1` with local port 0. The host returns a handle,
then receives either `Kind.Open = 12` with `{ local, peer }` or `Kind.Error`. While pending,
reads and writes, including empty writes, return `AGAIN`. Address calls fail with `ENOTCONN`.
An empty write returns 0 after open and `ERROR` after failure. The failure is available through
both the handle's error and `error(0)`. Pre-open error codes are `EACCES`, `ECONNREFUSED`,
`ENOTFOUND`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH` and `ECONNRESET`.
Unknown errors and post-open failures map to `ECONNRESET`. Guest errors carry the requested
host and port, not private connector diagnostics.

Each receive direction admits at most 1 MiB of unread guest bytes. The helper stops pulling
when that credit is exhausted and resumes only after `tcp-read` acknowledgements. A connector
must supply bounded, pull-driven chunks and bound its own upstream queues. Guest writes accept
at most 1 MiB of unsettled bytes, with partial writes or `AGAIN` at the limit. A settlement
publishes `Kind.Writable` when capacity returns. One writer preserves accepted byte order.

Shutdown closes that writer after accepted bytes, including when shutdown arrives before open.
Target EOF produces `Kind.End`, but guest writes remain allowed. Guest close flushes accepted
writes and cancels reads without aborting an established connector. Closing while pending aborts
the connect signal. Helper disposal aborts the signal, writer and reader immediately, including
a graceful close still draining. The connector owns its underlying socket cleanup and drain deadline.

Loopback connects never invoke this function. External lookup and non-loopback listeners
remain unsupported. The connector resolves names at connect time, while `lookup` remains
localhost-only. See [Browser TCP addresses](browser-network-addresses.md#outbound-connections).

## Verification

`bun test tests/runtime-network.test.ts` checks lazy ownership, retained-capability
revocation, getter reentry, late initialization, filesystem/physical-stop ordering
and cleanup failures with the actual memory filesystem worker.

`bun test tests/network-namespace.test.ts` checks independent rings, real HTTP
bytes, address identity, bind/ephemeral behavior, bounded writes, wakeups,
half-close, listener/connection cleanup and runtime isolation.

`bun test tests/network-flow-control.test.ts` runs actual workers against the same
paused-reader, bounded-buffer, read-wakeup, streaming-EOF and cancellation cases
used by the browser matrix. It also checks rollback after a listening hook throws.

`bun test tests/network-outbound.test.ts` drives real worker hosts against controlled streams
and a test-only `node:net` connector. It checks pending and failed opens, both credit limits,
half-close, EOF, graceful close, cancellation and disposal. Every native listener and socket
is closed by its test. Relay carriers and browser-engine outbound coverage are separate work.

Run the real browser check through the repository's process supervisor:

```sh
NETWORK_SCRATCH_ROOT=/verified/data/drive/scratch \
NETWORK_TEST_PORT=43827 NETWORK_BROWSERS=chromium,firefox,webkit \
WAFFLE_NETWORK_BROWSER=1 bun test tests/network-browser.test.ts
```

Reserve that free port and use the host's heavy-job queue. Browser engines must
already be installed. The test creates a runtime and actual browser workers, exercises their
sender/ring transports, performs HTTP over cross-worker TCP, and fetches a preview
through the real service worker. It unregisters its service worker and closes its
workers, contexts, browser, server and scratch on completion or failure.
The dedicated `tests/network-browser-runner.ts` also accepts engine names for the
repository browser-matrix driver. Consumer framework packages are not part of
this transport fixture and are not claimed as verified by it.

## Portable socket implementation

The existing lazy `runtime.network()` activation loads a separate Rust WASM module. Each runtime namespace owns one instance. Rust owns virtual ports, endpoint metadata, byte queues, credit, and half-close state. The TypeScript helper still owns rings, fetch, HTTP, preview callbacks, and cleanup ordering. The Rust module remains virtual-only in browsers; outbound streams bypass it through the page connector.

Native embedders can load the same module explicitly and wire Waffle's native `socket2` adapter. IPv6-any listeners disable IPv6-only mode and fall back to IPv4 when IPv6 is unavailable. Bun retains its own JSON, handle table, JavaScript APIs, engine wiring, and policy. See [Network module ABI](network-module.md) and [ADR 005](adr/005-lazy-rust-wasm-network.md).
