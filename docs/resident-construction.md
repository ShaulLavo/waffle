# Resident construction admission

The internal persistent resident factory requires a realm-local `MemoryBudget` as
its fourth argument. The request remains data-only. The authority is never a
worker message option, a cloned lease or a public runtime option. Every existing
resident fixture supplies its authority explicitly. Ordinary filesystem workers,
default connections and descendant identities are not covered by this unit.

## What construction admits

The resident constructor snapshots and validates publication limits without
creating a shared root, identity or publication backing. After both publication
guards are acquired, `ResidentConstruction` reserves the complete fixed bundle.
`openFilesystemBackend` forwards the same budget through `PersistentBackend.open`
to the unchanged startup allocator. The backend creates exactly one admitted root.
The resident connection borrows that physical backing rather than replacing it
with another tree.

The fixed plan includes capabilities, owner states, epoch, signal, revocation and
section words. It also includes every publication backing, including versions,
page readers and reader lifetimes. Empty growable segments consume allocation and
reference records at construction but zero backing bytes. Their maximum lengths
are not charged as allocated physical capacity. Future segment growth is outside
this contract.

The canonical ledger reserves bytes and records before allocation. A reentrant
allocator observes the existing reservation. Insufficient combined capacity
refuses startup without waiting under a filesystem mutation lock or invoking the
denied allocator. The same supplied authority survives repeated attempts.

## Escape and failure

The startup helper's existing conservative publication boundary is unchanged.
Once its shared state constructor publishes the root, that root remains charged
even if a later fixed-buffer allocation or startup attempt fails.

The fixed bundle stays private while its identity and local client are built.
Private failures close any created ports, detach their handlers, discard local
references and return the fixed lease. Before calling `FilesystemService.connect`,
construction retains the fixed backing and closes its lease without releasing its
references. Service attachment is treated as an escape even when it throws.
An attachment that partially registered a session is drained before disposal.

Published backing stays charged for the authority's lifetime. Stopping an owner,
closing ports, detaching a wrapper, or garbage collection does not refund it.
Cloned wrappers borrow the same root charge. The existing physical-backing probe
continues to reject a foreign root. Publication and page-reader bindings stay on
the exact same arenas.

Native opening debts and native storage close must still finish before guards
are released. In the unchanged OPFS opening route, cancellation during the pending
native directory result can still finish constructing a backend root before the
resident's next liveness check. That published root remains charged; no fixed
connection or late ready result is exposed. An unresolved or failed native close
retains its ownership debt and any reservation rather than claiming cleanup.

## What this does not bound

`pendingDataBound` remains `not-yet-enforced`. This is fixed resident construction
admission, not whole-runtime aggregate enforcement. It does not admit later
identity copies, external protocol buffers, publication payload copies, COW pages,
segment growth, checkpoint/native payloads, arbitrary caller buffers or WASM
outputs. It supplies no cross-realm subcapacity transport, generation transition,
import producer or durable replacement barrier. Ledger metadata allowances are
not JavaScript heap or process RSS measurements.

## Late checkpoint attachment

`ResidentConstruction.attach(backend, checkpoint?)` accepts the selected durable
publication only after native recovery has produced the real backend. The fixed
reservation still precedes native open. Attachment borrows that backend root and
passes the checkpoint separately from its allocator. It creates neither another
root nor another memory authority. Restore validates the seed against the admitted
limits before publishing the pair. The resident flushes the reserved session
frontier before activation. Private rollback and escaped-backing retention are
unchanged.
