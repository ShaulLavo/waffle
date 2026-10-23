# WorkspaceVfs reads, snapshots, and changes

`WorkspaceVfs` is the trusted root's read-only namespace projection. Memory and
persistent runtimes use the same namespace and all-writer publication order as
WASI. Enable it before the filesystem worker starts with
`createRuntime({ filesystem: { mode: "memory", workspace: true } })`, or use
`mode: "fast"` for the persistent runtime. The capability is
`runtime.filesystem.workspace`. Without the option, that property is `undefined`.

Low-level owners can import `createFilesystemConnection`, `FilesystemService`,
`FilesystemClient`, and `createWorkspaceVfs` from `waffle/fs`. A root connection
created with `createFilesystemConnection(undefined, { workspace: true })` grants
observer access. Guest forks do not inherit that grant. Activation after writers
start is not supported. The root package exports the public contract types.

## Reads and stat

`read(target, range?, atVersion?, signal?)` reads by current absolute path or
`FileId`. It works before any snapshot. `range` has nonnegative safe-integer
`offset` and `length` fields. Their sum must also be safe. An omitted range reads
the selected complete file, subject to the per-result limit below.

An `ok` result contains `value.stat`, `value.range`, and caller-owned
`value.bytes`. Stat includes the actual `id`, `version`, acquisition `cut`,
`kind`, `size`, `mtime`, and `mode`. Metadata and cuts are frozen. Byte arrays do
not alias shared storage. `range.length` equals the returned byte count. Only
EOF shortens a valid request. Beyond EOF returns zero bytes after identity and
permission checks. Native missing, corrupt, or short payloads never become a
short success.

Selection uses the same namespace and lock as writers. A write after selection
cannot change the bytes or relabel the returned version. Cold reads use bounded
physical ranges without registering or hydrating the complete file. Resident
reads retain only intersecting pages. Unregistered memory seed reads copy only
the requested bytes.

`stat(target, at?, signal?)` selects current metadata when `at` is omitted or
matches the complete current `NamespaceCut`. A retained lease also supplies stat
by FileId at its exact acquisition cut. Other old, foreign, or future cuts return
`generation-gone`. Paths always name the current namespace. Historical path
lookup is not inferred from a current name or a snapshot index.

## Full version leases

`pin(target, atVersion?, signal?)` returns an `ok` result containing a
`VersionLease`. Its frozen `stat` records the complete selected version and its
acquisition cut. `lease.read(range?, signal?)` can read any range of that version,
including bytes never read before later writes. `lease.close()` forbids new
borrows, cancels active borrows, and joins their actual I/O before releasing the
backing. Repeated close returns the same Promise.

A lease survives writes, resize, chmod, rename, unlink, replacement, final file
handle release, and slot reuse. Resident writers copy pinned pages before any
mutation. Cold leases retain immutable payload keys in the adapter's GC roots.
Acquisition does not copy or read a complete payload. Seed leases retain and
charge their original complete buffer.

With `atVersion`, the current inode must match or this projection must hold a
matching FileId/version lease. Otherwise read and pin return `version-gone`, even
if recovery still retains the old physical key. A path naming a replacement
inode never redirects to the former inode. An absent path is `not-found`; an
absent ID with an explicit version is `version-gone` unless an owned lease
supplies it. A lease remains readable after a later chmod because permission was
checked at acquisition. It grants no write permission.

Reopen preserves surviving FileIds and FileVersions but creates a fresh history.
Old cuts and leases do not transfer to the new root. Snapshot completion alone
retains neither historical bytes nor historical stat.

## Read results and pressure

Read, stat, and pin return a discriminated `ReadOutcome`, not a newer-version
fallback. Refusals include `not-found`, `not-file`, `denied`, `version-gone`,
`generation-gone`, `restart`, `lease-closed`, `cancelled`, `stopped`, `unavailable`,
`pressure`, `invalid`, `io`, and `corrupt`. `invalid.field` names `target`,
`range`, `version`, or `cut`. A bounded ID traversal interrupted by a mutation
returns `restart` with the current cut. A private resident writer with a pending
grant returns `unavailable`; staging bytes are never selected.

`WORKSPACE_READ_LIMITS` is exported with these root-wide bounds:

| Resource | Bound |
| --- | ---: |
| Explicit leases | 16 |
| Active read, stat, or pin operations | 4 |
| Returned bytes per read | 1 MiB |
| In-flight result and transport reservation | 16 MiB |
| Unique retained resident pages and seed buffers | 256 MiB |
| Retained disk payloads, including deferred reader-only GC debt | 512 MiB |
| Charged reader metadata | 2 MiB |
| Output chunk | 64 KiB |

A whole-file read over 1 MiB returns `pressure/result-bytes` before payload I/O.
Read a large file in ranges through its lease instead. Budgets are shared by all
public projections of the same root. Duplicate leases share physical backing
charges but each owns metadata and a lease slot. Public roots allocate a fixed
64 KiB shared page-reference table and 512 bytes of serial-qualified reader
lifetime state; private roots allocate neither. Guest forks share that
table without receiving the observer grant.

Result reservations include protocol buffers, service chunks, and the final
caller array. These deterministic charges are not exact JS heap measurements or
a combined runtime/index/cache budget. Backend `resources()` diagnostics report
current and peak reader charges. `WorkspaceVfs` does not expose these diagnostics. Retired shared pages remain in physical `usedBytes` until their
last reference closes. Released reader-only disk payloads remain charged as
`readerStorageDebt` until actual native GC deletion. Closing a lease cannot erase
that deferred debt.

Cancellation and root shutdown stop admission first. Native work, completion
replies, and backing references remain owned until their actual settlement.
Close after revocation waits for the service
to acknowledge the original reader drain. Late delivery cannot recreate a closed lease. Failed cleanup rejects and retains
its original owner rather than pretending the resource is gone. Signals and
wall-clock time are not proof that native storage work has stopped.

## Snapshot

`snapshot({ prefix?: string, includeDirs?: boolean }, signal?: AbortSignal)`
returns a cursor with asynchronous `next()` and `close()` methods. Defaults are
`prefix: "/"` and `includeDirs: true`.

Each pull returns one of these results:

- `entries` contains a bounded array of `NamespaceEntry` records. Each record has
  `id`, `version`, absolute `path`, `kind`, `size`, `mtime`, and `mode`.
- `complete` contains `cut`, with logical `workspace`, `generation`, and
  `watermark` containing `history` and `seq`.
- `restart` contains the current cut. A mutation invalidated the unfinished scan.
- `pressure` names the exhausted resource. Resource overflow terminates the attempt.
  Concurrent `next()` calls return `pressure` with resource `pull` without cancelling
  the original pull.
- `cancelled` or `stopped` terminates the attempt.

Entries are tentative until `complete`. A caller stages pages under one attempt
and discards them on any other terminal result. Empty entry pages are not
completion. Repeated terminal pulls return the same result. `close()` is
idempotent and cancels an unfinished attempt.

`prefix` selects an exact file or directory subtree, not a string prefix.
`/src` does not select `/src2`. Traversal validates permissions and dot segments
before canonicalizing the path. A missing prefix selects no entries. Directory
permissions still apply when `includeDirs` is false.

Every scan visits the whole namespace to seed subsequent whole-workspace changes,
even when output is filtered. It uses iterative tree traversal, not a full-tree
array. Cold persistent entries require no payload reads or per-node shared
handles. The owner retains a bounded derived parent/name index. That index never
authorizes filesystem operations and is not a second filesystem authority.

## Changes

`changes(after: Watermark, signal?: AbortSignal)` pulls without waiting for a
notification. Resume from this owner's completed snapshot watermark, then from
the previous `changes.next`. Positions from another projection, stale positions,
foreign histories, and future positions require a new snapshot.

`changes` returns ordered, indivisible `batches` and `next`. An empty array means
caught up at that pull. Each batch includes `seq`, `generation`, `actor`, the
actual per-writer `transaction`, `durability`, and complete `changes`.

Content records include actual `id`, historical `version`, resulting historical
`paths`, and write `range` or resulting `size` where applicable. Metadata records
include mode and modification time. Entry records include parent identity/version,
name, before/after identity/version, and before/after absolute paths. A rename's
entry effects stay in one batch. Hard links produce multiple paths. Retained
unlinked files have no paths. Later writes and renames cannot rewrite earlier
batch identities, versions, or paths.

A `gap` returns `oldestAvailable`, `current`, and `resync: "snapshot"`.
`oldestAvailable` identifies the first retained batch, so its immediate predecessor
is the ring's earliest resumable position. A gap invalidates the owner's derived
index. `gap.current` alone cannot resume changes. A new completed snapshot is
required. Output/index pressure also invalidates the index rather than returning
partial groups. Concurrent change pulls return `pressure` with resource `pull`
without cancelling the original pull. Cancellation after a change pull starts requires resnapshot.

Snapshot completion captures generation and watermark under the same global
section used by writers. A later mutation is in the log or causes an explicit
gap. No notification registration window exists. There is no retention lease or
snapshot progress guarantee under continuous churn.

## Identities and durability

`FileId`, `FileVersion`, `Generation`, and `ChangeSeq` are distinct opaque branded
`bigint` types. File identity is independent of names and handles. Recovered file
IDs and revisions survive ordinary persistent reopen. Modification of bytes,
size, metadata, or directory entries advances each affected node's revision once
per actual mutation group. No-effect mutations do not advance generation.

A history is one live publication incarnation. Ordinary reopen starts fresh
history, even when file IDs and revisions survive. Sequence comparisons require
the same history. Storage generation and private numeric `contentVersion` are not
public change generation or `FileVersion`.

Durability remains `{ kind: "untracked" }`. A completed cut is not a recoverable
commit proof. Existing explicit `flush()` behavior is unchanged. FAST can lose
writes after the last saved checkpoint. This API does not provide SAFE semantics.

## Bounds and cleanup

`WORKSPACE_LIMITS` is exported from `waffle/fs`.

| Resource                |                                  Bound |
| ----------------------- | -------------------------------------: |
| Active snapshot cursors |                                      2 |
| Entries per page        |                                    128 |
| Charged page metadata   |                                 64 KiB |
| Visited edges per pull  |                                    512 |
| Traversal depth         |                                    128 |
| Absolute path           |                      4096 UTF-16 units |
| Derived index           | 32768 edges and 2 MiB charged metadata |
| Projected change page   |                   1 MiB charged output |
| Concurrent change pulls |                                      1 |

Charges are deterministic limits, not exact JavaScript heap measurements. The
existing shared metadata table bounds each scan's resident overlay. A held cursor
retains bounded iterator frames, not a writer lock. Overflow returns typed
pressure, never silent truncation. Lock acquisition inherits the existing
filesystem owner behavior; these bounds do not promise a wall-clock deadline.

Public activation also bounds mutation admission to 64 writer sessions, four
operation slots per session, 64 KiB input, 8 KiB arguments, 512 effects and 512 KiB
encoded effects per group. The ring retains at most 32 groups in 16 MiB. A writer
recycles its own oldest committed receipt at its quota. Mutation admission errors
remain filesystem errors. This opt-in mode does not change mutation ACK or
persistent format guarantees.

Signals cancel before start, between pulls, or while a response is in flight.
Cancellation releases completion receipts and remote cursor frames. Serial
closure prevents late response delivery from recreating a cursor. `workspace.close()`
closes only the projection. Runtime disposal or root revocation stops its cursors
and history. Consumers own previously returned pages and their memory.

## Scope

This API implements namespace snapshots, changes, bounded reads, generation stat,
and explicit full-file version leases. Live search, index validation,
import/export, aggregate memory pressure, SAFE durability, endurance
certification, and real Safari proof remain
in [the VFS plan](../plans/001-vfs-family.md#4-workspacevfs-beside-wasi).
