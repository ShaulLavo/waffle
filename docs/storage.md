# Storage ownership and lifecycle

Select product guarantees with `createRuntime({ filesystem: { mode: "fast", name, whenBusy } })`.
FAST currently preserves the existing IndexedDB workspace in every browser. SAFE is
reserved and rejects with typed `UNSUPPORTED_VFS` until its durable-ACK engine lands.
Backend names are diagnostics and internal test controls, not public product choices.
See [vfs.md](vfs.md) for immutable descriptors, limitations and format identities.

The current IndexedDB implementation defaults to `"takeover"`; `"wait"` queues instead.
Takeover uses lock stealing and epoch fencing. The internal OPFS checkpoint implementation
supports only wait: stealing a Web Lock cannot displace another worker's exclusive
sync-access handles. These are existing exclusive-owner implementations, not the planned
coherent multi-writer engine.

A wait-policy instance queues one exclusive Web Lock request, with no stealing or repeated
attempts. `runtime.filesystem.state.status` is `"opening"`, `"waiting"`, `"ready"`, `"failed"`
or `"disposed"`. `filesystem.onStateChange` (also accepted in filesystem initialization)
observes these typed transitions. Waiting lasts until the workspace is ready, which can
include loading and recovery after ownership is granted. An uncontended open may also briefly
pass through waiting; it is not a storage error. Once the current owner closes or crashes, the
same instance acquires ownership, loads the saved workspace and becomes ready without a reload. A frozen or hidden owner can hold
its lock indefinitely. Several waiters acquire ownership in Web Locks queue order.

File operations issued while opening/waiting remain pending and execute only after ownership
and recovery. No guest filesystem request is served before ownership. Cancellation does not
replay any operation: `await runtime.dispose()` cancels pending startup through the worker's
`AbortSignal`, including an unresolved IndexedDB open under either busy policy. IndexedDB cannot
abort an open request itself; a late success closes its database without requesting ownership or
publishing a backend. Disposal revokes queued filesystem operations with `FilesystemError` errno 11
(`ECANCELED`), and waits for abort/cleanup acknowledgement before terminating. A direct
`SharedFilesystem` owner uses `await fs.dispose()` instead. Disposal is idempotent. An acquired
OPFS backend still closes its handles before releasing its lock. Real storage failures remain
fatal and appear as `state.status === "failed"` with `state.error`. An IndexedDB deletion or
upgrade closes and cancels a waiting connection, rather than leaving the database blocked.

`SharedFilesystem({ mode: "memory" })` selects a disposable memory-only filesystem; `name`
selects isolated storage for tests/workspaces. The worker is not a power-loss-safe host
filesystem beyond the browser's storage guarantees; closing a page without a completed flush
may lose its uncommitted edits.
