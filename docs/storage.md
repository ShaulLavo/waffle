# Storage ownership and lifecycle

Select product guarantees with `createRuntime({ filesystem: { mode: "fast", name, whenBusy } })`.
FAST currently preserves the existing IndexedDB workspace in every browser. SAFE is
reserved and rejects with typed `UNSUPPORTED_VFS` until its durable-ACK engine lands.
Backend names are diagnostics and internal test controls, not public product choices.
See [vfs.md](vfs.md) for immutable descriptors, limitations and format identities.

The current IndexedDB implementation defaults to `"takeover"`; `"wait"` queues instead.
Takeover uses lock stealing and epoch fencing. The internal OPFS checkpoint implementation
supports only wait: stealing a Web Lock cannot displace another worker's exclusive
sync-access handles. Both are exclusive-owner implementations, not a coherent multi-writer engine.

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

## Inspect and delete an idle workspace

`storedWorkspaces("fast")` returns actual stored workspace names in the current origin,
without a naming prefix or ordering guarantee. It validates FAST storage and omits unrelated,
unsupported and corrupt databases. It never creates or upgrades a database. Selecting corrupt
Waffle storage explicitly with `openIdleWorkspace` rejects with `VfsError` code
`INVALID_VFS_FORMAT`; selecting an unrelated database returns `"missing"`.

```ts
import { openIdleWorkspace, storedWorkspaces } from "waffle";

for (const name of await storedWorkspaces("fast")) {
  const workspace = await openIdleWorkspace({ mode: "fast", name });
  if (typeof workspace === "string") continue;
  const cursor = workspace.walk("/", { ignoreRoots: ["/app/node_modules"] });
  try {
    for (;;) {
      const page = await cursor.next();
      console.log(page.entries);
      if (page.done) break;
    }
  } finally {
    await cursor.close();
    await workspace.close();
  }
}
```

`openIdleWorkspace(selection, { signal })` takes a non-stealable maintenance lock without
waiting. It returns `"busy"` if a runtime, queued ordinary opener or another idle handle owns
the workspace, and `"missing"` if no Waffle workspace is stored. It does not need or create
the page runtime, shared filesystem memory, processes or network. Opening and reading use
only readonly transactions. They allocate no epoch or file identity and perform no migration,
garbage collection or recovery commit. A legacy or recovered tree is inspected in place,
including when the origin refuses new writes. Payload corruption is reported when its bytes
are read.

Every ordinary IndexedDB connection acquires shared maintenance ownership before opening the
database or requesting its writer lock. Ordinary runtimes can still take over from each other.
An accepted idle view holds exclusive maintenance ownership until `close()` or `delete()`
finishes. Ordinary opening waits behind it, including default takeover. A hidden or frozen
runtime remains busy, and a frozen idle owner can delay ordinary opening until it closes or
its browser context exits. Enumeration also waits behind maintenance; close an idle handle
before enumerating the same origin again.

`walk(path = "/", { signal, ignoreRoots })` includes the selected entry and every descendant
without traversing symlinks. Each page has at most 256 entries. `done: true` means exhaustive
completion; later calls return empty completed pages. Entries expose absolute `path`, `kind`,
view-local `ino`, whole-tree `nlink`, permission `mode`, byte `size`, and `mtime` in Unix
milliseconds. Symlinks also expose `target`. Legacy permission defaults are resolved to
`0700` for directories and `0600` for other entries. Empty directories and sockets remain
visible. Shared file inodes identify hard links. Directory link counts describe references in
the stored tree, with one reference for the root.

Ignored roots are exact absolute canonical paths. Empty components, repeated or trailing
slashes, `.` and `..` components, relative paths and NUL are rejected with `TypeError`.
`"/"` is a valid canonical path but cannot exclude the selected root. An ignored root equal
to or above the selected entry rejects with `RangeError`. A strict descendant root and its
whole subtree are omitted before descendant traversal. Ancestors and similarly prefixed
siblings remain visible. Disjoint, duplicate and overlapping roots are harmless. Options are
snapshotted when the cursor is created. Closing or cancelling a cursor releases its traversal
state. Every page checks cancellation and handle lifetime.

`readFile(path, { maxBytes = 8388608, signal })` returns complete copied bytes, or `undefined`
for a missing ordinary file. It matches runtime path and permission semantics. `maxBytes`
must be an integer from zero through 8 MiB. A larger stored file rejects with `RangeError`
before loading its payload. Cancellation rejects with `signal.reason`; reads never truncate.
`listFiles(path)` remains a regular-file convenience and omits empty directories and non-file
entries. A preservation tool must inspect all retained metadata and total sizes before reading
payloads, and refuse entries its restore writer cannot recreate.

`delete()` closes the inspection connection and removes the entire database while retaining
maintenance ownership. It resolves only on native deletion success. A blocking external
connection leaves deletion pending. Cancelling after the non-cancellable native request starts
does not release ownership early; the deletion settles first, then reports cancellation. A
concurrent `close()` joins that same operation. `close()` without deletion releases resources
without changing storage, and repeated calls return the same promise. Always close cursors
and handles in `finally`, including after a read or preservation failure. Once an idle handle
closes, its inspection methods reject.
