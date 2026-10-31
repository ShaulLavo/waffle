# Coherent workspace archive export

`fs/workspace-export.ts` adapts the public `WorkspaceVfs` snapshot and version-lease
contracts to the [archive codec](workspace-archive.md). The package root, `waffle/fs`,
and `waffle/fs/index` export the same function. There is no `runtime.filesystem`
export method. No import adapter,
durable staged-root publication, or SAFE guarantee is implemented here.

```ts
import { exportWorkspaceArchive } from "waffle";

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
therefore completes a full namespace scan to select a bounded window of the
smallest paths after the previously emitted path. It compares components by
JavaScript string order. Ancestors precede descendants. For example, `/a/x`
precedes `/a-`, even though whole-path comparison gives the opposite result.

Each window holds at most 128 candidates and 64 KiB of charged metadata. The
charge per candidate is `256 + 4 * path.length + 32 * componentCount`, plus
`2 * target.length + utf8ByteLength(target)` for a link. Each link record pays
independently, including repeated equal target strings. Insertion can temporarily
add one admitted candidate. A single candidate larger than an empty window
fails with `WorkspaceArchiveError` code `LIMIT`, never empty-success termination.
The selector also retains the previous path and the earliest excluded path,
each under the codec's path and depth limits. The excluded path prevents gaps
when inserting an earlier, cheaper candidate frees space. A window can therefore
be smaller than its limits. The adapter drains the owned candidate array before
starting another selection scan.

No whole-tree array, corpus sort, background prefetch, or collection of file
leases is created. At most one snapshot cursor or one file lease is owned at a
time. Snapshot pages are consumed one at a time under the public count and
metadata bounds. The page guards detect provider violations after delivery;
they do not constrain allocations made by a broken provider. The metadata
charges do not claim a bound on JavaScript object overhead or aggregate heap.
Paths use the codec's 4,096-unit and 128-component limits. Backslashes and lone
UTF-16 surrogates are valid workspace names but cannot be represented by this
archive format. They produce `format-path` with the offending path, without
renaming or silently omitting the entry. Well-formed Unicode, including astral
characters, is supported.

One scan accepts at most `WORKSPACE_EXPORT_LIMITS.scanPages` pulls, derived as
`WORKSPACE_LIMITS.indexEdges + 2`, including empty pages. An endless producer
cannot extend a scan without bound. Every window-selection scan must complete at
the initial cut. After the last window, an empty same-cut selection scan remains
mandatory before END.

### Measured cost and remaining limit

The original one-candidate implementation at `e866426e` made N + 1 complete
namespace scans. The independent review measured 1,000 empty files at 4.8 seconds
and 2,000 at 20.9 seconds. This repair reproduced 4.724 and 19.921 seconds on the
PC with the same in-process MemoryBackend fixture, ten directories plus root,
Bun 1.4.4, and the canonical build queue. Those are baseline measurements, not
bounds or remote-worker measurements.

With the bounded window, the same probe measured 0.756 and 3.694 seconds. Archive
byte counts were unchanged. Short-path windows amortize namespace scans over up
to 128 entries. Long paths can reduce that count. This is a practical reduction
in rescans, not a fast-large-tree claim. Work remains quadratic at fixed window
size. Public FileId lookup also scans the namespace per pin, and snapshot pulls
rebuild authority metadata and the projection's bounded index. The adapter does
not change those authority costs or their existing pressure limits.

A large-tree user-facing export still needs separate authority work: a bounded
canonical successor cursor and efficient version-pinned FileId lookup, retaining
cut validation and resource admission. Neither change is granted by this module's
three-file scope. Under churn, a longer attempt still has more opportunities to
fail and require a fresh export.

The adapter requests 64 KiB chunks and uses caller-owned range outputs directly.
The codec owns frame and digest buffers. Range bytes must be an exact-size,
zero-offset Uint8Array over a fixed ArrayBuffer. SharedArrayBuffer, resizable
ArrayBuffer, subclasses, and views with larger backing are contract violations.
They are rejected rather than retained. Consumers own memory they
retain after delivery. Public leases also have their existing backing/page/key
charges, which can be larger than a chunk and can refuse acquisition. Nothing
here claims an aggregate runtime heap or disk bound.

`WorkspaceExportOptions.budget` and `signal` are accepted. Logical entry/file/total byte
budgets are enforced by the codec. Signal and budget settings are copied when
iteration first starts. A budget failure closes the current real lease.

Completed snapshots update the projection's normal accepted change watermark.
The adapter does not consume changes, but callers must account for that ordinary
snapshot side effect when sharing the same projection with a change reader.

## Symbolic links in archive v2

The composed public `NamespaceEntry` already includes raw symbolic-link metadata.
A completed snapshot validates the link inode's own id, version, path, mode,
mtime, size, and raw target at the selected cut. The adapter copies those
primitive fields into its bounded candidate window. It does not retain a mutable
provider record as authority. Only files enter the lease and payload-iterator
path. Directories and links carry no DATA frames. No live `readlink`, referent
lookup, pin, stat, or read is performed for a link.

The encoder and passive parser use `waffle-workspace-archive-v2` and magic
`WAFLAR02`. There is no v1 compatibility path. Required raw targets are stored
losslessly in checksummed entry JSON, including lone surrogates. Absolute,
relative, dangling, cyclic, repeated-separator, dot-component, and backslash
text is preserved without traversal or normalization. Link modes use the existing
`0600` supported mask and retain the supplied bits.

Unknown kinds still fail `INVALID` before path or target access, copying,
charging, pinning, or reading. Every delivered link pays its target charge in
the page guard, even outside the selected window. The public-page estimate is
`192 + 2 * path.length + 2 * target.length + utf8ByteLength(target)`. It omits the
producer's name and is only a detectable lower bound. Target UTF-16 units are
debited before an allocation-free, bounded UTF-8 scan. Window retention also
includes that target allowance. Oversized targets fail `LIMIT` explicitly.

The codec preflights the exact complete JSON UTF-8 length before stringify or
encoding. Entry metadata must fit 16 KiB. JSON escape length and declared raw
target UTF-8 size are different quantities. Links count against `maxEntries` and
their declared sizes share `maxTotalBytes` with file bytes. `maxFileBytes` applies
only to files. The v2 END stores separate file and link-target byte totals.

These guards bound admitted exporter metadata and codec buffers, not all earlier
producer allocations or aggregate runtime heap. The separate producer target
preallocation defect is not fixed or qualified by this unit. Same-cut scans,
final empty scan, refusal invalidation, and joined cleanup remain mandatory.
There is no arbitrary historical target lookup or promise to finish under churn.

Archive paths are virtual paths, never host extraction paths. The passive parser
returns data only. The internal import driver explicitly refuses links before
its file/directory-only staging sink sees them. Public import, virtual link
materialization, host extraction, SAFE, N5, native, consumer, and shipping holds
remain unchanged.

## Failure and cancellation ownership

`WorkspaceExportError.refusal` retains public snapshot/read refusals, or reports
`resnapshot` with expected/current cuts, `scan-limit`, `format-path` with the
offending path, or a violated public `contract`. The module exports the
`ExportRefusal` and `WorkspaceExportOptions` types through the same package entries.
`WorkspaceArchiveError` is also exported for format and budget failures. The codec
parser, encoder, staging sink, and import driver remain internal. A directory traversal
`FilesystemError` with permission errno 2 maps to `denied`, matching file-read
denial. These errors describe an unsuccessful attempt, not missing entries.
Other raw operation failures retain their original values, including falsy values.
An abort reason is never remapped as a permission denial.

Before starting each operation, the adapter checks cancellation. Once work has
started, it observes and awaits that original Promise. Abort starts the owned
cursor or lease's `close` immediately and then joins both close and the original
pending operation. The wait result uses a non-thenable envelope so fulfillment
does not re-observe a delivered value's `then` getter. Delivered accessors stay
intact. A late result or rejection cannot replace the cancellation
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
cut/metadata/range replies. Acquired lease stat corruption is checked for empty
and nonempty files across id, version, kind, size, mtime, mode, and cut. Read
metadata tests include kind, size, mtime, and mode. Deliberate removed-check
controls must fail those tests. Real-source window tests exercise both metadata
and count limits, including insertions that reopen space behind an excluded path.
Promise-delivery tests count exactly one `then` observation for pages and read
outcomes, preserve fulfilled accessors, and retain exact falsy getter rejections.

The test suite does not certify browser import/export, durable import staging,
crash recovery, link import, SAFE, aggregate memory admission, or
throughput under large or continuously changing namespaces. Those remain separate
units. This new feature requires its own independent review before integration.

`tests/workspace-export-public.test.ts` exercises the root and both fs package
entries against a real service and granted projection. Prepared Node modules use
the same exporter and stream bounded bytes. Early return releases the owned lease
without closing the caller projection. Broken-provider controls inject unsupported
unknown-kind metadata around real snapshot cursors. They prove pre-charge
refusal and cleanup. R68 service fixtures additionally cover real raw link leaves,
source identity and metadata, churn around completed cuts, target-inclusive
windows, codec/page/window/total limits, no END on refusal, and early return.
These controls do not establish whole-runtime allocation safety or release the
independent integration holds.
