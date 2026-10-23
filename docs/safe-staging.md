# Private staged storage candidate

This unit tests durable groups against the real IndexedDB adapter. It does not
make SAFE available. `getVfsDescriptor("safe")` still throws `UNSUPPORTED_VFS`,
and FAST keeps its existing memory acknowledgement and persistence interfaces.

## One transaction kernel

`IndexedDBStorage.openCommitted` constructs a private committed store with the
`waffle-indexeddb-staged-v1` marker. It shares opening, ownership, chunk validation,
compaction, and the strict transaction kernel with FAST. Neither constructor
converts the other format.

`StagedCommitDriver` accepts an injected producer of a `CompleteStage`. The stage
contains the complete namespace batch, payloads, stable result, original
publication cut, durable payload roots, and reserved synchronous publication.
There is no new path resolver, filesystem model, or backend producer here.

The driver looks up the operation key before calling the producer. One admitted
producer owns the write turn. Another key is refused without queueing its input;
a matching pending key joins the existing work. A different request fingerprint
for the same retained key returns `conflict`.

The adapter snapshots the group before asynchronous work. It validates its
transition from the recovered head, then compares the exact prior encoded record
and ownership epoch inside the native transaction. Data, namespace records,
active generation, and the receipt envelope commit together.

## Native completion and recovery

An abort request cannot settle `NativeCommit.terminal`. The actual native event
records either committed or aborted. Adapter reconciliation finishes before the
terminal promise is delivered. An aborted outcome keeps the captured cause,
including explicit `null` or `undefined` throws.

A later adapter-memory installation error cannot change committed to aborted.
The adapter stops that authority. After native commit, the driver recovers the
committed head, calls reserved publication synchronously, and only then returns
success. Publication failure stops the driver and returns a keyed indeterminate
outcome. It never rolls back durable data.

Observer cancellation can return indeterminate while native work continues.
`drain()` still joins that work. Native and stage debt remain charged until the
terminal event, reconciliation, publication attempt, and stage release finish.
Cancellation before native submission prevents the commit.

Recovery validates the checksummed canonical envelope and its required generation
and root. A valid journal may reconstruct that exact head after snapshot damage.
Recovery rejects an older tree paired with a newer receipt, missing required
metadata, and missing retained payloads. It preserves the database on failure.
Normal FAST recovery can still select its older valid tree.

## Bounds and retained outcomes

Counters are bounded 128-bit bigints, encoded as canonical lowercase hexadecimal.
Storage checkpoint generations remain numbers. Each receipt retains its exact
result and original cut. Receipt and orphan roots participate in compaction and
recovery validation, independently of runtime range pins.

Defaults cap charged stage debt at 64 MiB, input at 8 MiB, metadata at 1 MiB,
clients at 64, and retained receipts at 1,024. Callers may lower these limits.
Admission reserves six times declared payload bytes and sixteen times the
namespace and envelope metadata allowances, plus input and publication bytes.
These are conservative declared copy charges, not measured heap or above-RAM
claims. The producer must honor its declared allocation and clean up its own
failed preparation. Returned stage sizes are checked before adapter copying.

This bounded unit issues a client on its first committed request. It has no
client-close or abandon control transaction. Receipt eviction advances a durable
per-client retirement floor. Retired keys never execute again, but an evicted
result is no longer available. Client slots are not recycled in this unit.

## Verification

Run `bun test tests/safe-staging.test.ts` for codec and pre-admission controls.
Set `SAFE_STAGING_ENGINE` to `chromium`, `firefox`, or `webkit` to run the same
file with native IndexedDB controls. Use the repository's canonical execution
queue and shared browser cache. The runner owns its server, browser, and scratch.

Native controls cover atomic abort after payload writes, exact nullish causes,
abort-request debt, commit-before-reply recovery, observer cancellation, duplicate
joins, expected-head and epoch fences, receipt retention, retirement, format
isolation, and corrupt-required-head rejection. The split-transaction negative
control uses real FAST persistence without a receipt and must fail the atomic
receipt assertion.

The producer, strict writer routing, open-file offsets, shared publication
reservations, and public mode selection remain separate integration work. This
candidate is stacked on frozen PR74 plus accepted security72. PR74's independent
review repair is not included or certified by this unit.
