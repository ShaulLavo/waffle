# Experimental E5 filesystem protocol

Status: Approved proof only. Baseline `15ba700268b6199e22ef61aa0d9464798c0d9562`.
No production exports, format, default, consumer or permissions changes.

## Two availability choices

1. `fenced-safe` and `fenced-fast` use one SharedWorker sequencer. Every mutation
   and ordinary read validates the authority epoch in the same IndexedDB
   transaction that publishes or admits it. Fenced replies recheck authority
   after any test-controlled response parking, so even an already admitted read
   or committed write cannot emit an old-authority success after replacement.
   This final read is an epoch fence, not a stronger durability promise for FAST. SAFE requests explicitly strict
   durability and waits for completion. Fenced FAST uses relaxed transactions;
   this is an experimental stronger tab-death behavior, not a requirement that
   replaces the approved memory-ACK FAST option. Suspected authority replacement
   increments the epoch transactionally and may proceed while the old worker lives.
2. `volatile-fast` holds a non-stealable Web Lock for its entire authority life.
   Mutations ACK from its memory tree without an IDB transaction. Suspected death
   does not permit takeover while that lock remains held. An independent replacement
   returns bounded UNAVAILABLE. Only actual lock release permits a successor.
   Strict checkpoints fence publication. Recovery changes history incarnation and
   explicitly gaps old cursors and unresolved operations. A heartbeat is never a fence.

A graceful close drains its ordered queue, checkpoints and invalidates its epoch.
Abrupt worker termination does not drain. Real browser/OS suspension is a separate
control, never inferred from a test gate or requested CDP lifecycle state.

## Data and authority

A request carries workspace, authority epoch, client incarnation, monotonic client
operation sequence, history incarnation, actor and a discriminated operation.
Operation identity is client plus sequence, independent of epoch. Reusing an identity
with different arguments is an error. SAFE receipts persist atomically with bytes,
namespace and changes, so a dropped response is resolved with the same identity.

The bounded proof stores one structured-clone record containing a production MemFS
root, file versions, generation, history, change sequence, strict durable watermark,
receipts and a bounded change history. Full-root copying is intentionally a tiny
correctness fixture, not a packed-engine revival or production storage proposal.
IDs are MemFS inode numbers. Rename preserves identity and content version.
Generation labels one coherent tree; sequence labels change delivery; history
prevents reuse after volatile loss; watermark advances only on strict completion.
Checkpoint does not invent a logical mutation. Every FAST authority restart
changes history and clears the old change log conservatively, including relaxed
IDB FAST. Its strict claim checkpoints the recovered cut. Persisted duplicate
receipts remain queryable across histories before an absent receipt is rejected
as OUTCOME_UNKNOWN. SAFE preserves its strict history. An ahead-of-head change
cursor returns a gap, never an empty caught-up batch. Format is proof-only and isolated
under a random database name. It never opens a saved workspace.

Only the authority runs real MemFS operations. Every ordinary tool read/snapshot
visits the authority. Followers hold no read-authoritative tree. Notifications are
optional nudges; changes pull the ordered log and detect gaps even when the final
nudge is dropped. Explicit snapshots return the bounded full tree with paths/bytes plus its exact
stream cursor. This is not the production streamed WorkspaceVfs API.

Each independent tab has a dedicated guest worker and a tab-local SAB mailbox.
The guest runs an original generated Wasm fixture through production WASI and a
synchronous FileSystem bridge. Bytes and operations cross the tab's MessagePort;
no SAB is sent to the SharedWorker. No guest mutates follower data and ACKs locally.
The bridge is experimental, not a production syscall-path performance claim.
It has no retained-unlinked-handle semantics; retain/release are no-ops and
unlink, link and guest fsync throw UNSUPPORTED. The existing production direct
SAB writer remains unchanged and is not covered by this bridge proof.

## Fixed controls and bounds

First control: four independently created pages write/read one workspace, then
close the first page while the other three continue. Follow with duplicate append
IDs, conflicting reuse, rename replacement, snapshot/stream race, dropped final
nudge/reply, parked append/rename plus stale authority resumption, graceful drain,
last-client close and abrupt actual worker termination where controllable.
The external termination control includes an acknowledged tail, a dropped reply
with a stored receipt, and a separately parked unpublished append.
Run the unchanged current production path as an exclusive-ownership control.

Limits are small and explicit: 64 KiB per request, 1 MiB tree payload, 256 retained
receipts and 64 change records, 32 queued commands, 64 pending requests per client,
8 attached ports per worker and 256 trace events. These fixture limits do not
prove production aggregate memory/above-RAM bounds. Receipt exhaustion rejects admission rather than
forgetting an operation. Client requests and test gates have fixed deadlines.
A bootstrap lock queue has a 3-second abort bound. A request can carry an
explicit admission expiry; a parked request resumed after that time fails before
mutation. Client response deadlines alone do not imply cancellation or failure
of a previously published operation. Recover its receipt, never replay under a
new identity.
All gates/phase controls are labeled deterministic interleavings, not owner freeze.
Unsupported actual freeze, Safari/iOS, or process-kill controls remain NOT VERIFIED.

The runner starts its fixture server and browsers inside one canonical UpCloud-4
browser/3000 job. Dispatcher outer deadline is 7200 seconds. Teardown is installed
before setup, and profiles, server, source and scratch belong to that job. No fresh
benchmark campaign, universal speed claim, public transact, PR or topology promotion.

## Frozen evidence preserved

E3 remains rejected: W2 regression, censored cells and unbounded debt are not erased.
E4 shared-stat and other prototypes stay separate; no combined speedup is inferred.
Original E5 measured transports and failed freeze controls, not a coherent VFS.
This proof supplements those reports without editing or rerunning their campaigns.
