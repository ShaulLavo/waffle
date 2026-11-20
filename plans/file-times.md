# File access, modification and change times

Status: Approved (coordinator, 2026-11-20). One PR.

## Problem

bun-wasm's filesystem tests (bun-wasm PR 978) found that guests cannot keep file times:

- `fd_filestat_set_times` and `path_filestat_set_times` in `core/wasi.ts` ignore the access
  time and divide the modification time down to whole milliseconds.
- `writeFilestat` reports the modification time as atime, mtime and ctime.

A guest that sets an access time, or a nanosecond modification time, reads back something
Linux would not give it.

## What guests get

The behaviour follows Linux `utimensat(2)` and `stat(2)`:

- `fst_flags` sets each time independently: `ATIM` (1) takes the given atime, `ATIM_NOW` (2)
  takes the current time, neither leaves it alone; `MTIM` (4) and `MTIM_NOW` (8) do the same
  for mtime. `ATIM` with `ATIM_NOW`, or `MTIM` with `MTIM_NOW`, is `EINVAL`, as in wasmtime.
  Unknown flag bits are `EINVAL`. With no time selected the call succeeds and changes nothing,
  ctime included, as Linux returns early when both times are `UTIME_OMIT`.
- Times keep full WASI precision: an unsigned 64-bit nanosecond count. What a guest sets is what
  it reads back, and what survives a reload on OPFS and IndexedDB.
- "Now" is `Date.now()` in nanoseconds, so file times taken from the clock have millisecond
  granularity. Linux file timestamps also come from a coarse clock.
- ctime becomes the operation time whenever an inode's data or metadata changes: write, append,
  truncate, a time change, a mode change, and a change in its names (link, unlink, rename of the
  inode). A directory whose entries change gets a new mtime and ctime, as today for mtime.
  Each of these paths already holds the file lock and stores mtime, mode or the link count, so
  ctime is one more store there.
- Setting times needs no write permission. Waffle has one virtual principal that owns every
  inode, and Linux lets the owner set times on a read-only file (`tar -x` and `cp -p` rely on
  it).
- atime is set at creation and by explicit time changes. Reads do not update it, which matches
  Linux mounted with `noatime`. Updating it on reads would add a shared store and a persistence
  write to every read; `relatime` behaviour can come later if a guest needs it.

## Representation

Two layers, two units:

- **The guest-facing filesystem** (`FileSystem`, `FileStat`, the in-memory tree, the shared
  slots, persisted records, publication intents) carries `atime`, `mtime` and `ctime` as
  `bigint` nanoseconds. A JavaScript number cannot hold nanoseconds since 1970 exactly (they
  passed 2^53 in April 1970), so a number would cost precision.
- **The host workspace layer** (namespace records, `lookup()` metadata, workspace export,
  workspace archives, publication `metadata` and `inode` effects) keeps `mtime` as whole
  milliseconds, derived as `Number(ns / 1_000_000n)`. Host code compares it with `Date.now()`
  and serializes it as JSON; nothing there needs nanoseconds. `lookup()` metadata also gains
  `ctime` (milliseconds) so the git package's `ctimeMs` stops reusing mtime.

`FileSystem.setMtime(handle, ms)` becomes `setTimes(handle, atime, mtime)`, each `bigint` or
`null` for "leave alone". The caller resolves "now" to a value first, so a published mutation
replays the same times.

## Shared slot layout

Each worker-backed filesystem keeps one slot per registered file in the fixed root
`SharedArrayBuffer` (`fs/shared.ts`, `SLOT_WORDS` in `fs/storage-geometry.ts`). Today mtime is
two 32-bit words of whole milliseconds (words 2 and 3), read and written as two separate
`Atomics` operations.

New layout, `SLOT_WORDS` 24 → 28:

| Words | Field                                  |
| ----- | -------------------------------------- |
| 2–3   | mtime, unsigned 64-bit nanoseconds     |
| 24–25 | atime, unsigned 64-bit nanoseconds     |
| 26–27 | ctime, unsigned 64-bit nanoseconds     |

All other words keep their indexes. A `BigUint64Array` view over the slot region reads and
writes each time with one 64-bit `Atomics` operation, which also removes today's possible torn
read between the two mtime halves. The view needs 8-byte alignment: the slot region starts at
word `SLOT_OFFSET` = 393,296 (even), `SLOT_WORDS` stays even and the three fields start on even
words.

Memory: 16 more bytes per slot. With 32,768 slots the fixed root grows by 512 KiB, from
33,289,256 to 33,813,544 bytes (1.6%). The root is a fixed buffer allocated at startup, so
the startup memory budget already counts its full size; no growable reservation changes.

## Persisted records

`PersistedNode` (`fs/storage.ts`), stored as JSON in OPFS snapshots and as records in
IndexedDB, replaces `mtime: number` with `atime`, `mtime` and `ctime`, each a decimal string of
the nanosecond count. Validation accepts only canonical unsigned decimal strings up to
2^64 − 1. A JSON number cannot carry the value exactly, and a string keeps both stores on one
shape.

Old records: a record with a numeric `mtime` and no `atime` or `ctime` fails record
validation, so neither backend recovers a snapshot from an old store and opening it fails
with `INVALID_VFS_FORMAT` ("no valid snapshot can be recovered"), the repository's existing
answer to unreadable metadata. It never resets the store. The format identity markers
(`waffle-opfs-snapshots-v1`, `waffle-indexeddb-chunks-v2`) name the storage layout, which does
not change, so they stay; bumping them would also route a v2 IndexedDB store into the v1
migration path. There is no migration; there are no outside users.

Recovery: a returning browser must still be able to start over. The public
`deleteWorkspace({ mode: "fast", name })` deletes the named workspace from IndexedDB and OPFS
without reading its records (only the format markers identify it), and returns `"busy"`
instead of touching a workspace a runtime, opener or idle handle holds. It is generic recovery
for any unreadable workspace, not migration code. Consumers offer it as "Start fresh" on
`INVALID_VFS_FORMAT`. Waffle's own site and examples use only memory mode, so they need no
such button.

## Workspace archive

The archive format (`waffle-workspace-archive-v2`, `fs/workspace-archive.ts`) does not change.
It moves project contents between workspaces, as tar or zip would: importing creates new
inodes, whose ctime is the import time and whose atime has no meaning yet. Its entries keep
`mtime` in milliseconds, the unit of the workspace layer that produces and consumes them. A
nanosecond remainder below one millisecond does not survive export and import. Old archives
load as before.

## Publication intent

The publication `setMtime` intent (`fs/publication.ts`, admission in `fs/shared.ts` and
`fs/publication-grant.ts`, client path in `fs/client.ts`) becomes
`{ kind: "setTimes", handle, atime: bigint | null, mtime: bigint | null }`. The service
operation is renamed to `setTimes` with arguments `[handle, atime, mtime]`; the transport
already encodes `bigint`. The publication domain's canonical JSON encodes `bigint` as a
decimal string so admission compares the same bytes on both sides.

Effects keep their shape. A `metadata` effect is emitted when the mode or the millisecond
mtime changes. An atime-only change, or a change below one millisecond, emits no workspace
effect, because the workspace layer cannot see it; the change still reaches persistence,
which captures changed nodes and slot revisions, not effects.

Write and resize plans take one clock reading and use it for mtime and ctime.

## What changes where

| Area                                | Change                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `core/filesystem.ts`                | `FileStat` times as `bigint` ns; `setTimes` replaces `setMtime`                          |
| `core/wasi.ts`                      | both set-times calls follow `fst_flags`; `writeFilestat` writes all three times          |
| `thread/lane.ts`, `guest-imports.ts`| the thread stat reply carries three times; guest stat writes them                        |
| `fs/memory.ts`                      | nodes carry three times; ctime on metadata and link changes                              |
| `fs/shared.ts`, `storage-geometry`  | slot layout above; `setTimes`; ctime on write, resize, mode and link-count changes       |
| `fs/backend.ts`, `fs/client.ts`     | `setTimes` action and intent; ms derivation for effects and `lookup()`                    |
| `fs/publication*.ts`, `service.ts`  | intent and operation rename; `bigint` in canonical JSON                                  |
| `fs/persistent.ts`, `storage.ts`, `persisted-tree.ts` | record shape and validation; OPFS and IndexedDB store the records unchanged |
| workspace layer                     | derives ms from ns where it reads `FileStat` or tree nodes                               |
| `packages/git`                      | `ctimeMs` from the new `lookup()` ctime                                                  |

## Tests

These fail on main and pass after the change:

- set both times, then stat: exact atime and mtime, ctime advanced (memory, shared worker
  client, publication client);
- set only atime, and only mtime: the other time unchanged;
- `ATIM_NOW` and `MTIM_NOW`: time within the call's clock window;
- conflicting flags: `EINVAL`;
- nanosecond round trip: `1_700_000_000_123_456_789n` reads back exactly through
  `path_filestat_get` and `fd_filestat_get`;
- persistence across reopen with nanosecond atime, mtime and ctime, in the Bun persistence
  tests and in the real browser storage runner for OPFS and IndexedDB.

Performance: measure shared `stat` and 4 KiB `pwrite` through the worker client before and
after, and report the numbers in the PR.
