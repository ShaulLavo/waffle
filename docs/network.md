# Runtime-scoped loopback networking

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

- Loopback aliases share one port space. Non-loopback TCP remains unsupported.
  Virtual addresses use IPv4 loopback, including when callers use an IPv6 alias.
- Bind and connect report conflicts and refused connections synchronously.
  Port zero allocates an unused port from 49152 through 65535.
- Accepted handles belong to the listener's helper. Their peer address matches
  the connecting handle's local address. Numeric handles may coincide across hosts.
- Each TCP receive direction holds at most 1 MiB of unread data. Writes may be
  partial or return `AGAIN`. Reading releases capacity and wakes the writer's ring.
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

Low-level standalone users may construct `NetHelper` directly. Its optional fourth
argument is a `NetNamespace`, exported by `waffle/browser/net/helper`. Omitting it
creates a private namespace. Runtime consumers must use the factory instead of
creating a second namespace or a module-global runtime registry. Bun launcher
attachment and its physical worker-exit hooks are separate consumer work.

The shared namespace is smaller than another broker layer. Existing per-worker
messages carry commands, existing rings carry replies and data, and helpers route
ordinary owned socket objects. No additional cross-thread registry is needed.

## Verification

`bun test tests/runtime-network.test.ts` checks lazy ownership, retained-capability
revocation, getter reentry, late initialization, filesystem/physical-stop ordering
and cleanup failures with the actual memory filesystem worker.

`bun test tests/network-namespace.test.ts` checks independent rings, real HTTP
bytes, address identity, bind/ephemeral behavior, bounded writes, wakeups,
half-close, listener/connection cleanup and runtime isolation.

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
