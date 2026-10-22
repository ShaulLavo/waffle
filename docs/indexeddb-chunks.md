# IndexedDB immutable chunks

Status: approved implementation contract. This adapter work does not change FAST,
SAFE, multi-tab support, or the public StorageBackend API.

## Physical records and range reads

The database keeps its three object stores and native schema version 1. The
filesystem format changes to `waffle-indexeddb-chunks-v2`. OPFS keeps its identity.
Metadata snapshots, journals, active generation and writer epoch keep their current
layout. A string key in `data` holds a constant-size version-2 manifest with the
logical byte length, 64 KiB chunk size and chunk count. Compound `[key, index]`
keys hold immutable chunk records with bytes and a SHA-256 checksum. Empty files
have no chunks. Small files use one short chunk, not an inline whole-file exception
or a shared mutable pack. Packing unrelated small files is deferred.

`readRange(key, {offset, length, signal?})` validates safe nonnegative integers and
their safe sum. It reads one manifest and only intersecting chunks, validates their
lengths and checksums, and allocates the requested result clipped only at EOF.
Chunk results are consumed sequentially. Zero-length and beyond-EOF requests still
validate the manifest. Missing records, malformed metadata and corrupt chunks
reject. Abort before enqueue, while queued or during native requests preserves
the exact signal reason. Ordinary `read` assembles the same immutable chunks.

## Publication and reopen

Ordinary persist snapshots caller-owned inputs at submission. All chunk records,
manifests, namespace journal, optional snapshot, active marker and collection
remain one strict atomic transaction. Existing keys cannot be overwritten with
different bytes. Metadata-only references validate manifest sizes without reading
payload bytes. Each write transaction checks the exact allocated writer epoch.

Reopen validates the marker, metadata layout, manifest shapes and chunk key
coverage before admitting recovery candidates. Payload checksums and actual byte
lengths are checked when bytes are read. Recovery retains the existing two bases
and complete-journal-chain selection. A damaged latest reference may fall back to
a complete older base. No valid root means an error, never an empty workspace.

## Migration and interruption

Only validated v1 data, marked `waffle-indexeddb-v1` or unmarked, is eligible.
Migration must read each legacy whole-value payload once because v1 has no
physical range index. It validates legacy byte types and referenced lengths, then
copies chunks in strict epoch-fenced transactions while retaining every legacy
string record and all old namespace records. The old marker remains authoritative.
Compound keys left by an interrupted copy are staging only and are replaced on
retry. No new-format manifest is exposed until every copy completes.

One final strict epoch-fenced transaction replaces the legacy string records with
manifests and publishes the v2 marker. Failure, cancellation or epoch loss
before that commit leaves the complete old namespace and bytes authoritative.
After commit the complete v2 root is authoritative. An abort racing after durable
publication may reject its caller without rolling back that completed migration.
Close drains admitted work before releasing ownership. Unknown markers and invalid
legacy layouts are not adopted. Downgrade is unsupported.
This is saved-data migration, not concurrent code-version negotiation.

## Immutable revisions and reclamation

A payload key names one immutable revision. Existing runtime `retainedData` pins
retain detached revisions across new generations without materializing bytes.
Pins are not persisted or restored. Collection at existing snapshot compaction
boundaries retains both recovery bases, required journal references and current
pins. Once none refers to a key, the same atomic transaction removes its manifest
and the bounded chunk-key range for that revision. This does not add a reader lease
API. Callers must supply existing runtime pins while a revision is in use.

## Logical streaming export and import design

Export and import are specified here, not implemented. A future exporter pins one
committed generation, streams logical inode metadata and directory entries, then
bounded byte segments per immutable revision with lengths and checksums. A final
manifest includes filesystem identity, logical schema, generation and an archive
integrity digest. Physical IndexedDB keys and chunk packing are not the archive API.
A stalled or cancelled exporter releases pins and its bounded queue.

A future importer validates the logical schema, inode graph, names, lengths and
segment checksums while writing into an isolated staging namespace. It enforces
byte and metadata budgets, reports quota errors, and publishes one complete root
only after final integrity validation. Cancellation and interruption discard the
staging namespace without changing the old root. Adapter switching is explicit.

## Damaged recovery candidates

Reopen keeps the full physical revision inventory separate from the payloads usable
by recovery. A malformed manifest or incomplete chunk coverage makes that revision
unavailable to bases and journal successors, not absent from collection. Surviving
compound keys also identify a revision whose manifest is missing. Later eligible
compaction deletes those records once no recovery base or runtime pin needs them.
Unknown markers, metadata layouts and physical key layouts still reject. Native
request failures and exact abort reasons are not converted into unavailable data.

Before selecting a v1 migration state, recovery excludes journal successors with
missing payloads. Their journal keys stay in the physical inventory so the next
publication discards them. Migration's final size checks, strict root switch and
exact writer epoch fences are unchanged.

`IDB_REVIEW_MODE=repair bun tests/indexeddb-chunks-browser-runner.ts` runs bounded
native damaged-candidate and reclamation controls. `IDB_REVIEW_MODE=preserve` runs
migration interruption, cancellation, epoch, pin, close and existing adapter
controls without the 128 MiB range campaign.
