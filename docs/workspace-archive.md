# Workspace archive candidate

This is a tested codec candidate for later integration, not a public Waffle
import or export API. Nothing in the runtime or package entry points calls it.
It does not migrate storage, persist a staged root, or implement SAFE. Its branch
must stay a candidate until a real bounded reader and durable staging sink use it.

## Logical data

`encodeWorkspaceArchive` consumes an async iterable of `ArchiveSourceEntry`.
A file supplies another async iterable of byte chunks. A directory has no bytes.
`parseWorkspaceArchive` emits manifest, entry, data, end-entry, and complete events.
`importWorkspaceArchive` consumes those events into an `ArchiveStagingSink`.

The manifest identifies `waffle-workspace-archive-v1`. `sourceFormat` is descriptive
provenance, not a target adapter selector. It is null or 1 to 128 lowercase ASCII
letters, digits, or hyphens. `sourceWorkspace` is null or a lowercase UUID.
Current persisted markers are
`waffle-indexeddb-chunks-v2` and `waffle-opfs-snapshots-v1`. The archive does not
contain physical inode numbers, payload keys, packs, journals, or storage handles.

Each entry preserves its absolute virtual path, file or directory kind, file byte
length, finite millisecond `mtime`, and supported permission bits. Directory size
is zero. Supported mode masks come from `permissionsFor`: `01700` for directories
and `0600` for files. No numeric ownership, executable registry, symlink, open
handle, retained unlinked file, or tool index is serialized.

`sourceIdentity` is either null or the existing durable `StoredIdentity` shape.
It contains the source workspace UUID and hexadecimal 128-bit file ID and version.
The existing identity parser checks era, serial, and version ordering. A non-null
identity must match `sourceWorkspace` in the manifest. Null identities permit
exports from namespaces without durable identities.

These identities describe the source only. The target sink must allocate fresh
workspace-owned IDs, versions, generation, and history. It must not install source
reservations or use source IDs as target authority. Repeated source IDs are legal
provenance for hardlinked source paths. This format restores each path as a
separate file, not as a shared hardlink. It makes no identity-continuity promise.
Source generation and change watermarks are deliberately absent: they cannot
serve as the target's history or index-validation token.

## Wire format

All integers use unsigned big-endian encoding. There is no compression.

The stream starts with the eight ASCII bytes `WAFLAR01`. Every following frame is:

| Field          |           Bytes |
| -------------- | --------------: |
| Type           |               1 |
| Payload length |               4 |
| Payload        | declared length |
| SHA-256 digest |              32 |

A frame digest is SHA-256 of the previous digest, the five-byte current frame
header, and its payload, in that order. The first previous digest is 32 zero bytes.
The fixed magic is checked separately. The chain detects payload and metadata
corruption, frame omission, duplication, and reordering. It is a checksum, not a
signature or authentication of the exporter. An attacker can construct a new
valid archive. No trusted origin is inferred from successful validation.

The frame types and sequence are fixed:

1. Type 1 is the manifest as fatal-decoded UTF-8 JSON. Exactly one appears first.
2. Type 2 is one entry as fatal-decoded UTF-8 JSON.
3. Type 3 contains nonempty file data. It may repeat for that entry only.
4. Type 4 has an empty payload and closes the entry, including a directory.
5. Type 5 has exactly 16 payload bytes. Two unsigned 64-bit integers give total
   entry count and total file bytes. It appears once, after the root and all entries.

Entry data must total exactly its declared file size. Directory data is rejected.
Every frame passes its checksum before its event reaches the sink. The final
counts must equal the checked entry totals. EOF must follow the archive-end frame.
Truncation, extra data, or an error from the EOF pull prevents completion.

Metadata objects have exactly the documented fields. JSON parsing follows
JavaScript JSON semantics. The encoder writes fields in its fixed order. The
parser accepts other JSON whitespace and field ordering. The archive identity is
versioned independently of persistent layouts. Unknown archive identities and
frame tags are rejected. There is no downgrade or version-skew negotiation.

## Bounded order and resource use

The first entry is the root directory `/`. Descendants follow depth-first order.
Within each directory, child names are strictly increasing by JavaScript string
comparison, which compares UTF-16 code units, not locale or UTF-8 byte order.
Every ancestor directory must appear explicitly before its children. A closed
subtree cannot reappear. This validates duplicate paths, parents, and ordering
with only a directory stack, not a set of all entries.

Paths are absolute canonical virtual paths. Empty components, `.`, `..`, NUL,
trailing separators outside `/`, backslashes, and unpaired UTF-16 surrogates are rejected.
The format does not resolve aliases or normalize names. Import must use virtual
paths, not treat archive paths as host filesystem extraction destinations.

Fixed limits are 16 KiB per metadata frame, 64 KiB per data frame, 4,096 UTF-16
units per path, and 128 path components below root. Each transport chunk is at
most 65,573 bytes, enough for a maximum data frame with its header and digest.
An upstream transport with larger chunks must split them before parsing. The
encoder likewise requires source chunks at most 64 KiB. Limits are checked before
body allocation. Transport views are copied into bounded owned buffers, so a tiny view does not
retain an arbitrarily large backing buffer. Only one frame and one transport
chunk are retained at a time,
plus bounded hashing scratch and directory prefixes. No file or archive buffer,
whole-tree index, or background prefetch queue is created.

Default logical budgets are 1,000,000 entries, 1 TiB per file, and 1 TiB of total
file bytes. `ArchiveOptions.budget` replaces all three with nonnegative safe
integers. Addition checks the remaining budget before adding, so counters cannot
overflow JavaScript's safe integer range. Quotas count directories as entries.
They bound accepted logical data, not elapsed time or external sink memory.

## Staging and publication

The sink's `begin`, `entry`, `write`, and `endEntry` methods operate only on a
private staging root. Each awaited operation supplies backpressure. Entry methods
must preserve metadata without exposing incomplete nodes. Directory metadata may
need deferred application until all descendants exist.

`complete` is the only operation allowed to select the new root. The driver calls
it only after every entry, checksum, final count, and EOF check passes and the
parser's source cleanup has joined. A sink must finish all data and metadata
persistence before an atomic root selection. Its rejection must leave the old
root selected. Cancellation must be checked before that atomic selection, not
reported as failure after a successful selection.

On parse, source, staging-write, or pre-commit cancellation failure, the driver
calls `abort` once and never calls `complete`. A failing `complete` also calls
`abort`. Abort must dispose only private staging state and leave the selected
old root unchanged. If abort fails, an `AggregateError` retains both failures.
This driver cannot enforce an arbitrary sink's storage ordering. Tests use an
explicit old-root model, not a claimed implementation of durable publication.

The later integration must prove real crash recovery before, during, and after
root selection, quota recovery, and removal of abandoned staging roots. It must
obtain a coherent source cut and version-pinned bounded range reads. Current
namespace enumeration alone does not supply coherent bytes. Source adapters must
produce the specified traversal order without an unbounded global sort.

## Cancellation and ownership

Parser cleanup calls the transport iterator's `return` on error or early consumer
return. Encoder cleanup closes both the entry and active file-byte iterators.
Pending parser pulls race the abort signal, then join `return` before failure is
returned. Sources must release their pending work in `return` or observe the same
signal themselves. An async generator blocked in a non-cancellable await can
otherwise prevent its queued `return` from finishing. There is no unsafe detached
cleanup or arbitrary timeout that declares such work gone.

Sinks receive the signal for their own pending work. The driver joins a staged
write before aborting it. A sink that never settles cannot be forcibly cleaned by
this codec. Consumers own complete consumption or iterator closure; abandoning a
generator without calling `return` gives it no cleanup opportunity.

Frame buffers are owned outputs. Producers must keep an input chunk stable until
the next pull. A sink may retain a parser data buffer, but any retained memory is
the sink's responsibility and must fit its own budget. No source memory lease or
filesystem handle is implied by an archive event.

## Verification

`bun test ./tests/workspace-archive.test.ts` checks independent SHA-256 frame
fixtures, one-byte transport splits, generated multi-chunk bytes with a slow sink,
metadata preservation, malformed paths and frames, integrity failures, truncation,
quota rejection, producer failure, cancellation, and old-root selection.

These tests prove framing and the sink call contract. They do not certify a
browser storage adapter, a real import/export API, identity adoption, SAFE, crash
recovery, or aggregate runtime memory pressure.
