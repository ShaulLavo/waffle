# Bounded checkpoint capture

`PersistentBackend` limits retained checkpoint work before copying file bytes or
namespace entries. This is checkpoint admission, not all-writer dirty admission.
FAST still acknowledges memory writes before durability, and its public
`pendingDataBound` remains `not-yet-enforced`.

## Admission and accounting

`PersistentBackend.open(storage, { checkpointLimits })` accepts partial limits.
Defaults are 512 MiB of payload-copy bytes, 8 MiB of metadata accounting units,
and 64 pending checkpoint operations. Limits are positive safe integers.

A checkpoint reserves all three resources during the synchronous shared mutation
section. `maxBytes` charges twice the captured payload length. One copy belongs to
the immutable checkpoint and one to the storage adapter's `snapshotBatch`.
Resident shared pages are not copied into this ledger or counted twice.

Metadata accounting charges 256 units per checkpoint, inode, and removal, plus
64 units and two units per name character for each captured directory entry.
Capture-time payload pins add 128 units and two per key character. The total is
multiplied by four to charge capture containers, adapter metadata copies, and pin
lists. These are defined accounting units, not a portable JavaScript heap-size
measurement. Fixed-size scans of the shared slot table precede admission, but
payloads, dirty sets, and directory-entry arrays do not.

Runtime pins can change while a capture waits. Before building the storage pin
list, execution reserves additional metadata for the current pins with the same
four-times charge. If that reservation fails, normal checkpoint failure recovery
restores dirty work and invalidates dependent captures before storage receives
the batch.

The operation reservation also covers unchanged explicit saves and payload
barriers. Reservations include queued and in-flight work and remain held until
the actual persist and requested flush settle. A held flush therefore cannot
release capacity early. The existing separate ownership of sibling flushes and
terminal close is unchanged.

At capacity, admission rejects with `FilesystemError` errno 6, EAGAIN, before
making a capture. There is no waiter queue and no delayed retry or mutation.
The caller can retry after earlier work settles. A single dirty capture larger
than a configured limit also rejects. It needs a larger configured budget or
smaller dirty work before it can save. This unit does not split atomic
namespace checkpoints to hide that limitation.

## Ordering, failure, and cancellation

Admitted captures retain their original bytes, namespace, and targeted payload
keys. Commits remain ordered by the existing persistence tail. No new capture or
barrier coalescing crosses a mutation or target boundary. The timer's existing
pending-checkpoint suppression still applies.

Persist failure restores current dirty work and invalidates later captures.
Payload flush failure does not roll back a generation that already committed.
Both paths release their reservations after actual settlement. Synchronous
capture failure releases the reservation and clears optimistic payload baselines
so the next checkpoint recaptures bytes rather than referring to an absent key.

`checkpoint(durable, target, signal)` and `flush(target, signal)` optionally accept
an `AbortSignal`. An already aborted signal rejects before capture. After
admission, cancellation ends only that caller's observation. It cannot discard
an immutable batch that later captures may reference. The underlying operation
remains owned, accounted, and joined by `close()` until storage settles. There is
no pretend release of an in-flight native operation. `dispose()` likewise does
not free reservations before their actual work settles.

All waits for storage occur after the guest mutation lock is released. Ordinary
host and direct guest writes remain memory operations while persistence waits.

## Diagnostics and limits of the claim

`backend.checkpointPressure()` returns a fresh internal diagnostic snapshot:

- `limits`, `pendingBytes`, and `pendingMetadataBytes` describe capture reservations.
- `pendingOperations`, `queuedOperations`, and `inFlightOperations` describe actual
  owned checkpoint and barrier work, not cancelled observers.
- `oldestAgeMs` is the oldest pending reservation's age, or zero when empty.
- `lastLatencyMs` and `maxLatencyMs` measure admission through actual settlement,
  including queue and storage time, for successful and failed checkpoints.
- `rejected` counts pressure admission or execution-time pin-growth rejections.

These counters exclude dirty bytes not yet captured, the resident page pool,
committed adapter state, native serialization buffers, and browser internals.
They do not prove aggregate memory bounds, slow-native-storage performance,
SAFE, above-RAM range access, or full FAST pressure compliance.

The next unit must admit dirty growth before host, service, and direct shared
writers change memory. It needs matching contracts in `shared.ts`, `service.ts`,
and their backend and client callers. Blocking producers must wait or cancel
outside guest locks; nonblocking producers must return a no-effect result.
Storage-owned transient serialization and persistent pin debt need their own
accounting contract before an aggregate memory guarantee is possible.

`tests/checkpoint-pressure.test.ts` exercises production `PersistentBackend` and
shared-memory operations with a held storage boundary that uses the production
`snapshotBatch`. Tiny budgets prove rejection before copies, namespace-only
accounting, targeted immutable cuts, cancellation ownership, reservation release,
and stable generations after failure. Existing persistence and close tests remain
unchanged. No native storage campaign is implied by these deterministic tests.
