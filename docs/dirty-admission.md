# Dirty-growth admission

Persistent backends enable one shared dirty-admission ledger by default. Host
operations, service requests, and direct guest writes use that ledger before
changing file bytes, logical size, mode, time, or namespace. Memory-only backends
leave it disabled. This is a bounded pressure unit, not certification of the full
FAST pending-data contract. The public `pendingDataBound` remains unenforced.

## Accounting units

`PersistentBackend.open` accepts internal `dirtyLimits` with `maxBytes`,
`maxMetadataBytes`, and `maxWaiters`. Defaults are 2 GiB, twice the checkpoint
metadata limit, and 64 waiters. `dirtyLimits: false` isolates checkpoint-only tests.
The checkpoint limits still cap immutable bytes, metadata, and operations.

The fixed shared ledger uses these charges:

| Category               | Charge and lifetime                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resident payload       | Assigned shared pages, once per physical page, rounded to 64 KiB.                                                                                                                                                   |
| Dirty payload headroom | Twice each slot's maximum logical size since the last complete, successful, quiescent capture. Shrink and unlink do not erase this debt.                                                                            |
| Immutable copies       | The checkpoint reservation includes the private snapshot and adapter submission copy. It survives cancellation until the owned persist and requested flush settle.                                                  |
| Namespace              | Four times 256 units per new inode plus 64 units and twice the UTF-16 name length per new directory entry, including the whole prior contents of each first-dirty directory. Clean cold namespace is diagnostic only. Removed names retain their dirty charge until a successful complete cut. |
| Dirty metadata         | 1024 units per first-dirty slot.                                                                                                                                                                                    |
| Runtime pins           | 2048 units per registered slot, released when the slot is freed. This covers conservative retained-key lists in queued checkpoints.                                                                                 |
| Operation metadata     | A fixed 1024-unit base plus the existing checkpoint reservation for each admitted immutable operation.                                                                                                              |
| Waiters                | At most `maxWaiters` observation records. No producer payload queue is added.                                                                                                                                       |

A mutation must leave both of these inequalities true:

```text
resident + 2 * dirtyPayloadHeadroom + immutableCopies <= maxBytes
2 * metadataHeadroom + immutableMetadata <= maxMetadataBytes
```

The extra factor on dirty headroom reserves room for a later complete cut while
older copies remain held. Capture checks resident pages, retained dirty headroom,
and its actual additional immutable reservation. Dirty payload headroom and
metadata headroom must also fit one checkpoint. A single indivisible file that
cannot fit returns EAGAIN rather than waiting for impossible progress.

These are conservative accounting units, not JavaScript heap byte measurements.
The counters distinguish resident pages, dirty headroom, immutable copies,
namespace, dirty metadata, pins, operations, waiters, and rejected attempts. Loaded clean namespace is not pending checkpoint debt.
`accountedBytes` reports resident plus dirty headroom plus live immutable copies.
Admission reserves more than that diagnostic sum.

## Mutation and publication

Direct `tryWrite` and `tryAppend` reject with no logical effect and no scheduled
writer when admission fails. Blocking direct writes request capacity observation
only after releasing the shared global and file locks, then retry their own
sources. Real worker tests cover this route both with and without local
publication. Resize and timestamp fallbacks use the service's same admission.

The service and persistent host route namespace edits through the existing typed
namespace plans. Created inodes remain private until the complete mutation has
reserved dirty bytes and metadata. Failure discards those staged inodes. File
bytes, directory edges, modes, and timestamps publish synchronously after
admission. Existing capacity preparation can reserve pages without changing file
bytes, size, revision, or namespace. It remains inside the same resident ceiling.

Local publication checks dirty capacity before moving an admission to committing.
A pressure failure cannot leave a pending publication that later changes bytes.
FAST success still acknowledges memory. It does not await durability.

## Waiting and release

The lock order is global mutation lock, then file lock. Persistence, capacity
observation, and cancellation waits hold neither. A waiter nudges existing
checkpoint progress or starts one when dirty debt can be retired. There is no
empty-checkpoint retry loop when no debt or pending checkpoint can free capacity.
A full waiter budget returns EAGAIN immediately. Cancellation and revocation
release the waiter record and preparation pins without installing a delayed write.

An unsuccessful checkpoint releases its own immutable copy reservation, not dirty
debt. A successful checkpoint clears debt only if its shared mutation revision
is still current and its cut includes every dirty detached writer. A later write
or a skipped detached file keeps the conservative debt. Read, close, cancellation,
and checkpoint work do not depend on acquiring a producer slot. Ordered targeted
flushes and ordinary close retain their existing ownership.

## Limits of this unit

This ledger does not bound total browser RAM. Unassigned shared segment capacity,
fixed allocator tables, cold namespace indexes, request transport payloads,
capability tables, publication arenas and receipts, native storage serialization,
and future tool or search work do not share this aggregate budget. Namespace
planning has a separate finite effect bound. Raw mutable `backend.fs` access is an
internal MemFS escape hatch, not an admitted persistent API.

No above-RAM, endurance, SAFE, multi-tab authority, or power-loss claim follows.
A held flush does not fence later writers. Reversible owner pause, drain, and
release is a separate contract and is not implemented here.
