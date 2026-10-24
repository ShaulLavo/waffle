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
