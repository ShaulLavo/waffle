# Internal OPFS qualification

OPFS remains an internal checkpoint backend. The public FAST filesystem still
uses IndexedDB. These checks do not enable OPFS in `createRuntime()` or qualify
SAFE durability.

## Snapshots and errors

Index loading reads native `File` snapshots. Retained immutable payload ranges
also use `File.slice().arrayBuffer()` so they can run without acquiring another
exclusive sync handle. Ordinary unretained ranges and whole-file hydration use
the bounded sync-handle cache.

Both snapshot readers reacquire a fresh `File` after a native `DOMException`
named `NotReadableError`, with at most three attempts and 5 ms then 10 ms backoff.
Cancellation stops another attempt. Other native errors propagate unchanged.
The native control modifies a file after acquiring its snapshot and observes
the actual browser error. A browser that keeps the snapshot readable needs no
retry. An invalidated snapshot reporting another error, including `NotFoundError`,
fails that request without retry; a separate later request can acquire a fresh File.

Only malformed JSON and invalid checksummed records permit checkpoint recovery.
Failure to read any metadata snapshot rejects loading and persistence, including
an unreadable initial empty checkpoint. It cannot authorize rollback, empty
reseeding, format adoption or removal of the unreadable checkpoint.

## Allocation and ownership limits

Opening loads metadata only. It does not preload a directory tree of bodies.
Payloads live in one flat native directory, with at most `createConcurrency`
parallel checkpoint tasks across that directory. There are no recursive permits
or per-directory worker pools. A task failure stops new tasks and joins those
already admitted before removing unpublished payloads.

Whole-file hydration checks native size against retained metadata before allocating
exactly that known size. It remains a whole-file operation, not an above-RAM read.
Ranges allocate only the clipped requested bytes. Resubmitting an immutable key
compares bytes with one scratch buffer of at most 64 KiB per active task, rather
than another complete payload copy. The default 32 tasks therefore use at most
2 MiB of comparison scratch. The checkpoint still snapshots caller-supplied changed
payloads before queueing; this is separate from native read scratch and is not a
tree-wide streaming checkpoint API.

Sync handles remain exclusive and bounded by the existing cache plus in-flight
creates and metadata. Metadata lookup uses the saved index rather than opening
another native handle for stat. Immutable-key verification closes its cached
original before opening a transient handle. Failed physical close retains its
original and writer lock as described in [OPFS close ownership](opfs-close.md).
An ordinary snapshot read failure does not cancel close cleanup; close joins the
admitted read before closing handles and releasing ownership.

Resident appends write shared pages without taking whole-file snapshots for each
chunk, including when capacity grows. Checkpoints write complete new immutable
revisions. This is not incremental native-file append. A smaller overwrite names
a shorter revision; retrying an unpublished key truncates its orphan before writing.
An explicit zero-byte payload creates a native file. Metadata can also represent
empty files without a payload key. Deleting either removes the current namespace
entry; a previous checkpoint or reader can retain its old payload until collection.

## Controls

| Case | Existing or new coverage |
| --- | --- |
| Native snapshot invalidation and exact bytes | `opfs-qualification-browser.ts`, native mutation with observed error, fresh acquisition and unrelated-error propagation |
| Snapshot acquisition/read invalidation, exhaustion and cancellation | `opfs-snapshot.test.ts`, explicit native API stand-ins |
| Unknown metadata read failure versus corrupt bytes | New initial and newest read-fault controls; existing all-corrupt, corrupt-newest and torn-checkpoint browser cases |
| Many tiny files, bounded handles, exclusive lock and transient open errors | Existing 320-file cache churn, contested owner and bounded retry cases in `opfs-storage-browser.ts` |
| Few large files, smaller overwrite and zero-byte create/delete | New two-file native lifecycle with explicit flush and reopen; existing 128 MiB cold range in `opfs-range-browser.ts` |
| Append crossing capacity without per-chunk snapshots | New persistent-backend native append case, byte-exact after flush and reopen |
| Bounded comparison allocation and progressing native reads | New 256 KiB immutable-key comparison control; existing range allocation and invalid-progress controls |
| Partway failure, sibling join and cleanup | Existing payload quota, snapshot quota, same-key retry, and `opfs-close.test.ts` in-flight sibling controls |
| Complete checkpoint after interruption and identity nonreuse | Existing nine `storage-crash-r2.test.ts` OPFS schedules and `durable-identity-storage.test.ts` |
| Native directory entry publication | Not applicable: native iteration is internal metadata scanning or garbage collection, not guest readdir. Guest paging uses explicit cookies in `directory-pages.ts` and its directory paging tests. |

Run the source controls and the added native cases from the repository root:

```sh
bun test packages/waffle/tests/opfs-snapshot.test.ts packages/waffle/tests/opfs-range.test.ts packages/waffle/tests/opfs-close.test.ts packages/waffle/tests/durable-identity-storage.test.ts packages/waffle/tests/storage-crash-r2.test.ts
STORAGE_SCRATCH_ROOT=/absolute/data-drive/scratch STORAGE_TEST_FILTER="OPFS qualification" bun packages/waffle/testing/storage-browser-runner.ts chromium firefox webkit
```

These are correctness and allocation controls, not throughput measurements or
power-loss tests. They do not qualify spontaneous failed native close or real
iPhone Safari. Flush orders payload durability before naming metadata but does
not prevent browser origin eviction. See [storage ownership](storage.md).
