# Metadata and directory enumeration

Status: Approved. Lane r173 owns issues #115 and #118. Production FS edits await
named-symbol grants. The coordinator granted only `core/wasi.ts::writeFilestat`
and `fd_readdir` on October 25, 2026. No production changes are in this checkpoint.

## Deliver independent fixes

1. Fix #115 with regular-file link counts, shared metadata, and the deletion counter.
2. Fix #118 with byte-bounded directory pages and explicit cookie semantics.
3. Open one focused draft per independent unit after source grants. Do not include
   version bumps or unrelated watcher, stream, or cold-read work.

The test baseline is `675eee55ef3eaaa91da5d41fb8e588a5ca0bdb32`.
The released stream commit is `9acb32afb8cc1cc9da134a1cfca96349f91fc581`,
with prerequisite `db272be` included. Integrate the coordinator's chosen base before
implementation. Do not rewrite its fdstat flags, fd_read, or fd_write hunks.

## #115 data and exact source request

Use required `FileStat.nlink: number`. MemFS owns a count keyed by Node identity,
not by path or descriptor. Count actual namespace names, with one synthetic root
reference. Open descriptions do not add links. The regular-file sequence is
1, 2, 1, 0. Directory counts in this plan are namespace references, not the Unix
2-plus-subdirectory convention.

Request these exact edits:

| File                 | Symbols and change                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/filesystem.ts` | Add required `FileStat.nlink`.                                                                                                                                                                                                              |
| `core/wasi.ts`       | `writeFilestat` writes the count at offset 24. Keep stream metadata unchanged. Granted.                                                                                                                                                     |
| `fs/memory.ts`       | Add private count state and helper; rebuild in constructor; return count in `stat`; replace `hasNode` tree scan. Update counts in `create`, `link`, `removePath`, replacement `rename`, `remove`, recursive `forget`, and `applyNamespace`. |
| `fs/backend.ts`      | `MemoryBackend.sync` and `applyNamespace` synchronize the affected existing shared metadata slots. No publication-tail, read-preparation, or resize changes.                                                                                |
| `fs/shared.ts`       | Append a link-count slot field; update `SLOT_WORDS`, `register`, `snapshot`, and `statLocked`; add `setNlink` under the existing metadata lock. Do not edit `revision`, watcher mutation hooks, page allocator, or resize code.             |

`FilesystemClient.stat` can return shared metadata without RPC. Updating only
MemFS and WASI cannot make sibling clients coherent. `snapshot` is another
FileStat constructor and must not be missed. Production FileStat producers at the
baseline are MemFS.stat, SharedFilesystemState.snapshot, and statLocked.

Preserve `onLinkChange` and `onChange` callback timing. PersistentBackend has its
own link/lifetime map and recursively handles directory callback changes. Do not
replace or double-invoke those callbacks. Internal MemFS counts must decrement
recursive child edges even when the persistence callback is only for the root
removed edge. Rebuild counts from restored shared Node identities. No persistence
format or persistent-source edit is expected.

Use the existing namespace transaction boundary when updating shared counts.
Do not register file bytes again just to change a count, or turn a metadata change
into a write requiring guest write permissions. Keep content versions and watcher
publication behavior unchanged unless coordination establishes a separate need.

## #118 data and exact source request

Add this required FileSystem method. Keep full-list readdir for its other callers.

```ts
readdirPage(handle: FileHandle, cookie: bigint, byteLength: number): Uint8Array;
```

The result contains Preview1 dirent bytes, including a partial final record.
WASI keeps descriptor rights/type checks and guest-memory copying. MemFS keeps
filesystem read permissions. The service still validates handle authority.

| File                        | Symbols and change                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/filesystem.ts`        | Add `FileSystem.readdirPage`.                                                                                                                          |
| `core/wasi.ts`              | Replace only `fd_readdir` full-list materialization and slicing with a bounded-page call. Granted.                                                     |
| New `fs/directory-pages.ts` | Directory entry index and dirent encoding. No external ownership or descriptor cache. Requires source grant before creation.                           |
| `fs/memory.ts`              | Add `readdirPage`; initialize and update directory indexes at constructor and actual namespace edit points named above; clear removed-directory edges. |
| `fs/backend.ts`             | Add only the `executeOperation` directory-page dispatch case.                                                                                          |
| `fs/client.ts`              | Add only `readdirPage` using existing submit/wait/release; no cached full list or cold-read changes.                                                   |
| `fs/service.ts`             | Add directory-page operation to `checkRequest` handle allowlist. No `prepareRequest` or `PreparedRequest` change.                                      |

The existing `writeResponse` binary path supports Uint8Array and overflow
transfers. No protocol or shared-slot change is needed for #118. Bound requested
page size at the service boundary and validate cookies before index lookup.

Use an ordered live-entry index owned by the directory, with monotonic cookies.
Dot entries use cookies 1 and 2. Zero rewinds. A successor lookup resumes after a
cookie even if its edge was deleted. New edges get later cookies; replacement or
rename removes the old edge and inserts a new edge. An already-returned entry may
appear again after a rename. Do not promise a snapshot during concurrent mutation.
Handle allocation overflow explicitly rather than silently aliasing a cookie.

The target is O(log N + returned entries) lookup and O(live namespace entries)
index storage. Do not retain deleted-cookie tombstones, copy the full directory
on first use per descriptor, or replay a Map prefix on every page. There are no
iterator resources to release on close or cancel. Removing a directory releases
its index along with the directory. The existing retained open-directory policy
still applies.

Alternatives rejected for this issue are whole-list caching per descriptor,
which retains an unbounded snapshot, and cookie-offset Map traversal, which
removes transport amplification but keeps quadratic enumeration work. A new leaf
alone cannot fix the current full-list interface.

## Staged executable controls

Run from this exclusive worktree with Bun 1.4.4:

```sh
bun test tests/metadata-nlink-r173.test.ts
bun test tests/metadata-readdir-r173.test.ts
bun test tests/metadata-nlink-r173.test.ts tests/metadata-readdir-r173.test.ts -t 'green control|consumer resumes'
```

Both full files intentionally fail before production fixes. The shared fixture
runs actual WebAssembly imports, Worker, FilesystemClient, FilesystemService,
MemoryBackend, and MemFS. The persistence control runs PersistentBackend and its
real snapshot codec against a small encoded-snapshot storage adapter.

The directory consumer consumes every complete record, retries the last partial
record, checks ordinal cookies without mutation, and reaches EOF. Counters measure
MemFS materialized entries, serialized list bytes, and bytes copied in completed
service responses. Overflow result sizes are not counted twice as transport.
These are work and payload counts, not network traffic or latency measurements.

Before claiming #118 green, extend materialization instrumentation to the new
page/index entry point. The current lower-bound assertion rejects zero counts
when the old readdir override is bypassed. Add mutation, long UTF-8 names, rights,
revocation, namespace clamp, resource, and close/cancel coverage after the contract
lands. No browser storage or consumer install acceptance is claimed yet.
