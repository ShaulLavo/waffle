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

## Reversible owner write barrier

`runtime.pauseFilesystemWrites({ signal })` returns a `FilesystemWriteBarrier` lease.
Only the runtime owner can acquire it. Borrowed filesystems, process services, and
filesystem connections do not acquire or release leases.

```ts
const barrier = await runtime.pauseFilesystemWrites({ signal });
try {
  await barrier.flush();
  // Inspect the stable cut or begin navigation synchronously here.
} finally {
  await barrier.release();
}
```

Acquisition closes one shared root gate and drains earlier admitted mutations.
An earlier mutation keeps its admission through page dispatch, cold loading,
pressure retries, service execution, and resident write-grant settlement. Existing,
independent, pending, and future guest identities inherit the same gate. The lease
pauses filesystem writes, not processes. Reads, handle cleanup, and checkpoint
progress remain available.

Later mutations receive `FilesystemError` errno 6, `EAGAIN`, without effects.
Nonblocking guest writes return `-6`. Waffle retains no payload or delayed write
for those rejected calls. The caller must retry explicitly after release. This
covers bytes, file sizes, modes, timestamps, and namespace changes. Ordinary
`filesystem.flush(path)` remains nonexclusive and does not acquire a lease.

`barrier.flush()` joins concurrent calls and flushes the whole filesystem while
writes remain excluded. A rejected flush leaves the lease held. The owner can
retry or release it, using the same runtime and guest identities. `release()` is
idempotent, waits for an in-flight lease flush to settle, and reopens admission.
An old lease cannot reopen a newer one. Disposal and ownership loss are terminal
and cannot be reversed by release.

The optional signal cancels acquisition only. Abort does not cancel earlier
mutations and cannot reopen a delivered lease. Overlapping acquisition rejects
with errno 6 instead of queueing another owner. A failed earlier mutation rejects
acquisition and reopens the gate rather than returning a successful cut.

Admission has 64 producer records per root, 512 MiB of reserved payload copies,
and a 16 MiB transport-metadata reservation cap. Encoded mutation arguments are
bounded to 8192 bytes and response capacity to 64 KiB. Reservations also count
against enabled dirty-byte and metadata limits. String encoding and fallback
copies reserve before allocation. A single 128 MiB ASCII `writeFile` fits the
default limits. Capacity exhaustion rejects without a queued write. Completed
low-level `FilesystemCompletion` objects remain caller-owned until `release()`.
No persistence wait holds a guest mutation lock, and FAST acknowledgements do not
become durable acknowledgements.

## Ordinary ready shutdown

A ready ordinary persistent `SharedFilesystem` revokes new work immediately when
`dispose()` starts. Repeated calls return the original promise. The page keeps its
root and Worker until the original service shutdown ACK and root section fence
finish. A failed ACK or Worker error rejects that promise and retains the failed
owner. A success ACK followed by an error before the fence finishes still fails.

Ownership loss after readiness also rejects the original disposal promise with the
same error object as the failed page state. It does not send a new dispose request,
claim a cleanup ACK, or terminate the failed owner. The storage-lock browser test
checks that the original native Worker remains live, then awaits page teardown.
Takeover lets the successor run and read flushed data. That does not prove that the
failed owner's backend closed successfully or independently observe Worker death.

The service joins admitted preparations, requests, maintenance and section fences
before releasing pins and closing its backend. `PersistentBackend.close()` also
returns one original promise, rejects new work, and joins admitted reads/checkpoints
before its final durable save and native storage close. A failed drain or final save
does not initiate native close. A failed native close remains the original failure.
These ordinary paths do not finalize private publication owners.

Run a bounded ready IndexedDB success proof with one cached Playwright engine:

```sh
STORAGE_SCRATCH_ROOT=/work/tmp bun tests/filesystem-ready-disposal-browser-runner.ts chromium
```

The proof uses real page APIs, the real service installer and IndexedDB. A test-only
preparation gate holds admitted work through disposal. It checks the pending native
lock, the real service ACK and original backend/storage close, then joins the exact
original Worker target's close event before cleanup and reopens the dirty marker.
Only fixture configuration and gate/observation controls are injected. No ACK is
synthetic. Worker termination is still initiated explicitly by page disposal, not
natural retirement.

The separate service-only observer supports one diagnostic arm:

```sh
STORAGE_SCRATCH_ROOT=/work/tmp bun tests/filesystem-shutdown-browser-runner.ts firefox --backend indexeddb --reason error --arm raw-close-failure
```

The complete ordinary service matrix is 84 arms. Its earlier native run stopped
at the Firefox context-close 1000ms cap after 48 primary observations. That run is
RED/incomplete; the remaining 36 arms are unproved. A passing selected diagnostic
is only non-reproduction. The retained original raw close promise, capped result
and enclosing browser cleanup remain separate receipts. Neither runner proves
whole Runtime shutdown, OPFS shutdown or native failed-close lock retention. No
SAFE, public/default or full-matrix acceptance follows from these controls.
