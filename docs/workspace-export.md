# Coherent workspace archive export

`fs/workspace-export.ts` adapts the public `WorkspaceVfs` snapshot and version-lease
contracts to the [archive codec](workspace-archive.md). It is source-module code,
not a new package export or a `runtime.filesystem` method. No import adapter,
durable staged-root publication, or SAFE guarantee is implemented here.

```ts
import { exportWorkspaceArchive } from "../fs/workspace-export";

const archive = exportWorkspaceArchive(workspace, { signal });
for await (const chunk of archive) {
  await destination.write(chunk);
}
```

`workspace` is an already granted public root projection. The adapter neither
creates nor closes that projection. It closes only its own cursors and leases.
Consumers must finish the stream or call its iterator's `return`. An error
invalidates the entire attempt, including bytes already delivered. Destinations
must remain private until the encoder ends successfully and checked EOF is
observed. Consumers must not publish a partial stream.

## Coherence without snapshot byte retention

A public snapshot is tentative until its `complete` result. Completion does not
retain historical bytes. A file lease pins a version and records its acquisition
cut. Neither operation alone supplies a coherent file-tree export.

The adapter establishes an initial complete cut, including workspace, generation,
history, and sequence. It then uses these rules:

1. Every namespace selection scan must complete at that exact cut.
2. Every file is pinned by its exported FileId and FileVersion, never by a path
   that a rename or replacement could redirect.
3. Lease metadata must exactly match the completed namespace record. The lease's
   acquisition cut must equal the initial cut.
4. Each read requests at most 64 KiB through that lease. The returned metadata,
   cut, range, size, and owned byte allocation are checked before encoding.
5. A final completed namespace scan at the initial cut is required before the
   codec can emit its archive-end frame.

A real mutation during a scan produces the public `restart` result. A later
completed scan or acquisition at a different cut produces `resnapshot`. Missing
old versions, permissions, pressure, shutdown, and I/O refusals remain explicit
failures. There is no retry, newer-version fallback, automatic resnapshot, or
progress guarantee under churn. The caller starts a fresh export after a refusal.
Even a mutation unrelated to the selected file conservatively fails the attempt.

Writes after a file is pinned cannot change its unread old bytes. The final scan
still rejects an intervening generation change. A mutation after the final
completed scan is later than the coherent exported cut and does not invalidate
that older archive. This is an optimistic same-cut export over publication-aware
writers, not a snapshot lock or a retained whole-tree version. Unsupported direct
mutation of authority internals is outside the public writer contract.

Exported identities are provenance from the initial workspace and selected file
versions. They are not target identity reservations or import authority. The
codec's format does not embed a cut or make an identity-continuity or hardlink
restoration promise. Archive data has checksum integrity, not exporter authenticity.
`sourceFormat` is null because the public VFS does not identify a physical format.

## Canonical order with bounded state

Public snapshots use authority traversal order, which is not lexical order. The
codec requires canonical depth-first order with sorted child names. The adapter
therefore completes one full namespace scan to select the smallest path after
the previously emitted path, comparing components by JavaScript string order.
Ancestors precede descendants. For example, `/a/x` precedes `/a-`, even though a
comparison of whole path strings gives the opposite result.

Only the next candidate and previous path are retained. No whole-tree array,
corpus sort, background prefetch, or collection of file leases is created.
At most one snapshot cursor or one file lease is owned at a time. Snapshot pages
are consumed one at a time under the public count and metadata bounds. Paths use
the codec's 4,096-unit and 128-component limits. One scan accepts at most
`WORKSPACE_EXPORT_LIMITS.scanPages`, currently 32,770 pulls, including empty pages.
An endless or broken producer cannot extend a scan without bound.

This choice trades time for space. For N namespace entries, export performs
N + 1 full scans and up to quadratic namespace work, plus file bytes. Public
snapshots also rebuild their bounded derived index. Every scan still has the
public index, path, and page pressure limits. This implementation is not a
large-tree throughput claim. An efficient successor cursor would require a
separate authority contract, not an unbounded client-side sort.

The adapter requests 64 KiB chunks and uses caller-owned range outputs directly.
The codec owns frame and digest buffers. A tiny view with larger backing is
rejected instead of retaining its unbounded backing. Consumers own memory they
retain after delivery. Public leases also have their existing backing/page/key
charges, which can be larger than a chunk and can refuse acquisition. Nothing
here claims an aggregate runtime heap or disk bound.

`ArchiveOptions.budget` and `signal` are accepted. Logical entry/file/total byte
budgets are enforced by the codec. Signal and budget settings are copied when
iteration first starts. A budget failure closes the current real lease.

Completed snapshots update the projection's normal accepted change watermark.
The adapter does not consume changes, but callers must account for that ordinary
snapshot side effect when sharing the same projection with a change reader.

## Failure and cancellation ownership

`WorkspaceExportError.refusal` retains public snapshot/read refusals, or reports
`resnapshot` with expected/current cuts, `scan-limit`, or a violated public
`contract`. These errors describe an unsuccessful attempt, not missing entries.
Raw operation failures retain their original values.

Before starting each operation, the adapter checks cancellation. Once work has
started, it observes and awaits that original Promise. Abort starts the owned
cursor or lease's `close` immediately and then joins both close and the original
pending operation. A late result or rejection cannot replace the cancellation
reason, recreate ownership, or escape as an unhandled rejection. The adapter
never declares native work gone merely because an abort or deadline fired.

Cleanup runs on success, failure, cancellation and early consumer return. Falsy
primary and cleanup values remain failures. If both fail, `AggregateError` retains
the primary first and cleanup second. The codec can add an outer aggregate when
closing its entry source. A cleanup-only failure also rejects. A non-cooperating
operation or failed close cannot be forcibly reclaimed by this adapter. It waits
rather than detaching started work. The caller still owns the public projection
and its recovery when that projection reports a failed native cleanup.

## Verification boundary

`tests/workspace-export.test.ts` exercises the actual MemoryBackend, service,
client and public VFS, plus the existing deterministic cold native-range fixture.
Tests cover unsorted multi-page namespaces, exact source metadata and identities,
large bounded reads, backpressure, mutation and rename/replacement timing, stale
versions, actual cursor/lease pressure, permissions, and final-cut validation.
Held native work and delayed public responses prove joined cancellation. Tests
also check exact falsy failures, early-return cleanup and deliberately corrupted
cut/metadata/range replies.

The test suite does not certify browser import/export, durable import staging,
crash recovery, public package wiring, SAFE, aggregate memory admission, or
throughput under large or continuously changing namespaces. Those remain separate
units. This new feature requires its own independent review before integration.
