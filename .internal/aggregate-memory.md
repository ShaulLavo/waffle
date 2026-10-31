# Startup root memory admission

Waffle has an internal startup allocation hook for standalone filesystem roots.
It is not a whole-runtime memory limit. FAST still reports
`pendingDataBound: "not-yet-enforced"`.

## Covered allocation

`PersistentBackend.open(storage, { startupRoot: budget })` forwards an existing
realm-local `MemoryBudget` to the standalone shared-root constructor.
`new MemoryBackend(undefined, undefined, budget)` uses the same path.
`openFilesystemBackend` forwards this internal option within its own realm.
The public runtime does not expose or transport this authority.

Before creating the root's `SharedArrayBuffer`, the ledger reserves its complete
byte length and two allocation/reference records. One record charges the backing.
The other charges 512 declared control units for root ownership. Control units
are conservative accounting allowances, not measured heap bytes. The ledger's
own fixed tables and progress reserve remain separately charged.

Insufficient capacity fails synchronously with `MemoryBudgetError`. No backing
or partial reservation remains after admission denial. An allocator failure or
an unpublished shared-state constructor failure also returns its reservations.
This startup hook does not wait for capacity.

`SharedFilesystemState.createBuffer(budget)` admits the raw root through the same
allocator. Importing an already allocated buffer with a budget is rejected.
No factory retroactively counts imported buffers as admitted allocations.

## Aliases and lifetime

A root's buffer, typed-array views, and shared-state aliases refer to one backing
charge. `new MemoryBackend(undefined, undefined, ownerBackend)` reuses the owner's
filesystem, workspace identity, and shared state without a temporary root.
A budgeted backend accepts repeated attachments of its own physical backing,
including structured-cloned wrappers. It rejects a different connection root
without replacing its admitted root.

Published roots stay strongly owned while their authority exists. Closing or
disposing a backend, stopping the authority, or failing later backend recovery
does not refund that charge. A raw buffer alias can outlive any of those events.
Consequently, repeated opens consume new startup capacity, even after close.
Discard the authority and every alias to retire this ownership container. There
is no early-release API or wrapper-GC finalizer.

`backend.resources().startupRootBackingBytes` reports the byte length of this
backend's admitted startup backing, or zero without startup admission. Two alias
backends can report the same backing. Do not add those values together. The
single authority's `snapshot()` is the accounting source.

## Excluded allocations

The hook does not cover external connection/protocol buffers, worker transport,
segment growth, publications, version-page retention, COW, read results,
checkpoints, adapter copies, queued metadata, or native storage. Passing the
option does not create cross-worker authority or certify above-RAM access.
Existing component limits remain separate policies.

`tests/aggregate-memory-contract.test.ts` checks actual factories, allocator
ordering, rollback, alias lifetime, repeated attachment, and no-effect pressure.
Its separate persistence measurement keeps the root and three production-helper
payload copies distinct. That fixture is not native IndexedDB, heap, or RAM
certification.

## Opt-in fixed publication backing

The internal `createPublicationBuffers(limits, observe, options)` factory admits
its complete fixed backing when `options.backing` is `{ kind: "budget", budget }`,
using an existing realm-local `MemoryBudget`. `options.checkpoint` restores settled
publication state with the same admission. Validation precedes admission, and restore
initialization completes before the group is published.
Without `options.backing`, allocation has no ledger admission. The root constructor
uses `{ kind: "construction", construction }` instead, borrowing its existing admitted
owner allocation without a second admission. These backing owners are mutually exclusive.
This factory-only hook does not provide production-wide or aggregate enforcement.

Admission reserves one operation lease, ten allocation/reference records, and
all ten backing byte lengths before the first backing allocation. Observation
adds two backings and two allocation/reference records. The plan includes the
version table and both observer arrays. Each backing requests its exact full
size as both `bytes` and `maximum`. Fixed SABs are accepted and never grown.
An admission denial allocates nothing. Any unpublished construction failure,
including final registration, cancels all acquired references and reservation.

Published groups stay strongly retained under their budget. Domain aliases do
not add charges. Slot clearing, domain stop, `releaseStopped`, and budget close
do not refund published backings, since raw aliases can survive them. Repeated
funded constructions charge distinct groups. There is no early-refund API or GC
callback. Discard the authority and all aliases to retire its ownership container.

This is exact backing-byte accounting only. It excludes factory metadata,
publication preparation and encoding, returned values, transport, segment growth,
and staged or adapter copies. Ledger control-table charges remain separate.
`tests/publication-memory-accounting.test.ts` uses small synthetic constructors
to check denial, precharge ordering, rollback, fixed allocation, and alias lifetime.
The excluded allocations and whole-runtime disclaimer above still apply.

## Opt-in namespace projection backing

`new NamespaceProjectionTable(options, budget)` admits the complete private
`ArrayBuffer` when the optional realm-local `MemoryBudget` is present. Validation
precedes admission. The plan reserves the exact backing byte length, one
allocation/reference pair, and one operation lease before allocation. The 8,192
bookkeeping units reported by `allocation().chargedBytes` remain diagnostic and
are not part of this backing-only admission.

A failed allocation, view initialization, or publication registration returns the
reservation and all acquired records. Published tables remain strongly retained
under their budget. Raw aliases and budget close do not refund the charge. There
is no early-refund API, GC callback, or raw-table retirement. Construction without
the budget keeps its existing unaccounted behavior.

`NamespaceProjectionOwner.create(options, budget)` owns a retiring funded table.
Its admission includes the backing, 8,192 bookkeeping units, two
allocation/reference pairs, and one operation lease. Construction rollback and
admission denial leave no retained allocation or remote work. Retirement waits
for the final borrower, then releases both references exactly once.

`createWorkspaceVfs(client, projectionBudget)` uses this owner for every snapshot
in the memoized workspace. Repeating the factory with the same budget, or without
a budget argument, returns the established workspace. A different budget identity
is rejected instead of silently replacing or adding funding. An initial
`createWorkspaceVfs(client)` call without a budget keeps that client's projections
unaccounted.

`SharedFilesystem` accepts the package-internal symbol-keyed `localMemory` option
only with `workspace: true`. It requires a same-realm `MemoryBudget` before
connection or Worker construction and passes that identity to its memoized
workspace. The caller retains and closes the budget. Filesystem disposal never
closes it, and the budget never enters worker messages. Without this option the
ordinary workspace remains unfunded. `createRuntime()` has no corresponding
option, and this hook does not fund protocol or other runtime allocations.

Scanning and accepted workspace projections remain charged. Replacement,
cancellation, and workspace close retire their owners and release the charges
after borrowing ends. Returned pages and changes, remote cursor and protocol
allocations, and every exclusion listed above remain outside this hook. The raw
`NamespaceProjectionTable` constructor keeps its backing-only behavior and does
not gain retirement. Neither path provides production-wide or aggregate
enforcement.

`tests/namespace-projection-memory-budget.test.ts` uses a 157-byte synthetic
backing to check raw-table denial, precharge, rollback, and published lifetime.
`tests/namespace-projection-owner.test.ts` checks the real workspace factory,
including funded lifetime and memoized budget identity.
