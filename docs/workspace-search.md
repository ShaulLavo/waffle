# Workspace search

`createWorkspaceSearch` adds pull-driven live search to an existing public
`WorkspaceVfs`. It does not open another filesystem or close the borrowed one.
This first unit is available by direct source import. Package exports are a
separate integration step.

```ts
import { createWorkspaceSearch } from "./fs/workspace-search.js";

const search = createWorkspaceSearch(runtime.filesystem);
const cursor = search.search({ kind: "text", prefix: "/src", text: "TODO" }, signal);
try {
  const page = await cursor.next();
  // Handle the tagged page as described below.
} finally {
  await cursor.close();
  await search.close();
}
```

## Queries and matches

A `files` query matches its case-sensitive text against the full file path.
Empty text lists files. A `text` query matches a nonempty UTF-8 byte pattern,
including overlapping matches and matches that cross range boundaries.
Text hits contain byte offsets and byte lengths, not character positions.
Binary files are not excluded. Search does not decode whole files, produce
snippets, rank matches, or accept regular expressions.

The prefix selects an absolute file or subtree at path-segment boundaries.
`/src` does not select `/src2`. Dot segments, NUL, duplicate separators, and
non-root trailing separators are invalid. Paths have the public workspace's
4,096 UTF-16-unit bound. File patterns have a 4,096-unit bound. Text patterns
have a 4,096-byte bound after UTF-8 encoding.

Each hit includes the actual public FileId, FileVersion, and path. Hardlinks
produce separate path results. Search checks every text lease against the
snapshot's identity, version, size, workspace, and history before reading.
An unavailable version or denied read is an explicit failure, never an empty
successful file scan.

## Pages and cuts

A `delta` contains `cut`, `retract`, and `add`. Apply all retractions, then all
additions, then adopt the cut as one operation. The only current retraction
is `{ kind: "all" }`. A delta can be empty while a file scan advances.
It describes sound partial results at its cut, not complete coverage.

A `checkpoint` contains an `IndexStamp`. It means every selected file was
processed at the tracked versions and the last sampled change feed was empty.
It is not the end of the live cursor. Another `next()` checks changes again.
It does not certify durability or the instantaneous state after the sample.
Returned hits, cuts, and stamps do not expose mutable internal feed positions.

Every other page is terminal and requires the caller to clear all results.
The sole exception is `pressure/pull`, which rejects an overlapping pull
without stopping the existing one. Repeated terminal pulls return the same
outcome after cleanup joins.

## Mutation and gap handling

Search completes a real public snapshot before publishing results, then
pulls changes from that snapshot's exact watermark before the first scan.
It uses no notification dependency or persisted watermark as a subscription.
Every later work turn pulls changes before scanning at most one byte range.

Any mutation clears all results at the last complete batch cut in that page.
The next requested turn takes a fresh snapshot. This conservative rebuild
handles ancestor moves, hardlinks, replacements, permission changes, and files
moved into the selected prefix without duplicating the namespace projector.
It does not maintain an incremental content index. Repeated mutation can
prevent progress.

Search validates history, contiguous batch sequence, increasing generations,
and the returned next position. An actual authority gap stays terminal,
including its actual `oldestAvailable`. A fresh cursor must resnapshot.
Search never adopts `gap.current` as a resumable subscription position.
A competing raw snapshot or changes consumer can invalidate the borrowed
projection and produce a gap. Do not share it concurrently with search.

A mutation after a sampled cut can occur while a read is in flight. That
read may finish at its old cut. The next observed mutation retracts its hits
before search reports a newer cut. Cancellation discards late read results.

## Ownership and bounds

The factory is memoized by workspace object. One search cursor or validator
owns the feed at a time. Another receives `pressure/query`. Work starts only
on `next()` and does not prefetch, poll, or hold a lease while the caller is
idle. Each range borrows the exact file version and joins lease close before
delivering the page. Whole-version retention still belongs to the public
reader's existing budgets. Search's byte bound is not a whole-runtime heap bound.

`close()` and abort select a terminal immediately, abort the owned operations,
and join the in-flight pull, snapshot, and lease before releasing admission.
They never call `workspace.close()`. Cleanup rejection retains the failed
join and query slot. It cannot become a checkpoint or successful close.

`WORKSPACE_SEARCH_LIMITS` sets these maxima. The factory's optional second
argument can lower them, never raise them.

| Limit                               |                               Default |
| ----------------------------------- | ------------------------------------: |
| Retained namespace entries          |                                65,536 |
| Charged names                       |                                 8 MiB |
| Charged emitted results per rebuild |                                 4 MiB |
| Active job charge                   | 128 bytes within a 1 MiB queue budget |
| Hits per page                       |                                   128 |
| Charged output per page             |                                64 KiB |
| Requested byte range                |                                64 KiB |
| Aggregate deterministic charge      |                                16 MiB |

Names cost `192 + 2 * path.length`; hits cost `96 + 2 * path.length`.
Each page reserves 256 bytes. The aggregate also includes query text, prefix,
UTF-8 pattern, matcher table, the active job, and current read/output bytes.
Emitted-result charges are conservative counters, not retained postings.
Only one bounded matcher state and the bounded namespace metadata survive
between turns. Output limits can stop inside a returned range. The next
pull rereads only its unprocessed suffix at the exact expected version.

Pressure invalidates the cursor rather than silently truncating results.
The public namespace and reader limits can reject work earlier. These are
accounting units, not measured JavaScript heap sizes. No 50,000-file capacity,
latency, persistent-storage, all-writer, or browser certification is claimed.

## Checkpoint freshness

`validateIndex(stamp, query, signal)` accepts an in-memory checkpoint shape
with bigint counters. It takes a new actual public snapshot when the feed
is free. It does not replay a saved watermark or inspect persisted postings.
It compares logical workspace, search format/schema, filesystem format/schema,
query, history, and position in that order.

An equal cut returns `valid`. An older cut returns `stale/behind` and requires
rebuild. Foreign workspace/history and future or crossed counters return
`gap` and require a snapshot. Format, schema, or query mismatch returns
`stale` with its reason. Malformed or oversized fields return `invalid/index`.
Operational snapshot failures remain failures. Validation during an active
query returns `pressure/query`.

The filesystem format comes from the paired root's VFS descriptor. Metadata
schema follows `PersistedIndex["version"]`, currently 1. Construction of a
low-level owner pair is trusted, not security attestation of arbitrary objects.

There is no persisted index writer, payload loader, hash validation, JSON
counter encoding, or saved-index display path in this unit. A valid stamp
only observes freshness at its sampled cut. It does not prove that arbitrary
saved matches are correct or that file data reached durable storage.
