# Internal local publication contract

This opt-in capability is internal and not accepted for consumer use. It changes
no public API, default storage behavior, descriptor or persisted format.

The private `localPublication` symbol enables fixed shared arenas on one root.
Forks share its history and receive distinct writer sessions, never the root
observer grant. Without this configuration no publication arena is allocated.

An admitted mutation owns bounded input and a session/sequence identity. The
service and resident direct paths prepare a complete effect group before editing
bytes or namespace edges. They install its receipt before releasing the existing
filesystem global lock. Explicit cuts and changes do not depend on notifications.
No-effect receipts do not advance the generation. Retired identities cannot apply
again, and changed inputs conflict. History eviction returns an explicit gap.

Namespace plans refer to actual MemFS nodes and edges. They do not maintain a
second tree. Host replace reserves its full bounded effect before truncation.
Writes and appends admit one bounded prefix. Nonblocking preparation owns no
caller bytes and cannot perform a delayed write after EAGAIN.

Current reads use the publication order. Copied pins are immutable and charged
against fixed limits. Content versions, metadata revisions and publication cuts
are separate. All durability receipts remain `untracked`, including after flush.
Cold persistent loads check the live domain before installing hydration.

Publication admission holds only short synchronous filesystem sections. Its
arena lock carries the real owner token. The existing authority's proven-dead
reap path repairs that owner's lock. A slow or frozen live owner is not stolen.
No section is held across asynchronous preparation or transport by this domain.

## Controls and limits

The mandatory unified oracle in `tests/filesystem-publication.test.ts` interleaves
actual host calls, exported WASI `fd_pwrite` and `fd_write`, and resident direct
writers from separate connections. It checks the complete group and receipt
synchronously before any observer transport await, then checks current reads.
There is no publication-specific nudge to drop. Completion and segment delivery
remain enabled, and explicit observer reads do not depend on notifications.

The local tests and `tests/publication-browser.ts` cover namespace operations,
retained descriptions, permissions, bounded prefixes, exact and retired receipts,
immutable pins, history gaps, cold-load cancellation and domain stop. They also
cover lost replies after commit and rejection of stopped late replies. Actual
worker admission tests refuse live-holder stealing and observe native worker
closure before proven-dead reap. The browser runner is part of the registered
Chromium, Firefox and sequential WebKit matrix.

These controls use one existing root and separate workers, not independent tabs.
They do not approve S1/S2, cross-tab topology, SAFE, persisted publication metadata,
packed storage, public transactions, indexing/search, aggregate memory bounds,
above-RAM range reads, performance or consumer pins. Real Safari, iOS, owner freeze
and physical power-cut behavior remain unverified by this unit.

## Bounded independent-page resident pilot

The private resident attachment adds an experimental handoff for one retained,
small regular file on the production MemoryBackend. It is not a selectable
storage mode. The authority retains the only MemFS and publication domain; a
second page receives an ordinary descriptor and bounded operation data, never
the authority root SharedArrayBuffer.

Readiness is separate from a synchronous read, write or append. One outstanding
grant excludes authority-local direct access and service mutations. A missing
grant returns EAGAIN without capturing caller bytes. READY can be cancelled only
by its cell's no-effect transition; CLAIMED cannot be reclaimed by a timeout.
COMMITTED owns the complete result, effects and receipt before guest success.
The authority imports the selected offset and publication once. Explicit status
finds the original cell even when the final commit notification is omitted.
A missing committed payload stops the old history rather than guessing success.

Issuing the first descriptor permanently excludes ordinary direct clients of
that root, including existing clients, cached/nonblocking paths and later
descendants. The retain and exclusion share the filesystem global lock. Backend
and service access stays pending until the authority holds its own matching
shared guard and activates under that same lock. Failed acquisition stops the
history before releasing guards. Joined stop also stops idle history before
release; unfinished cleanup never counts as completed disposal. Roots that never
enable this private pilot keep their ordinary behavior.

Private claim state and invoked effect codecs use captured atomics, constructors
and byte operations. Snapshot decoding uses an owned nonshared copy. The CLAIMED
browser pause is inserted only into the test bundle after the real transition;
it receives no private view and adds no callback to shipped source.

Each attached page and actual guest worker owns its own non-stealable shared
Web Lock, keyed by workspace across authority incarnations. Recovery requests
exclusive continuity before taking any incoming shared guard. Bootstrap attaches
before setup, imports, preopens or guest start; successful local cleanup joins
attachment stop before exit acknowledgement. A failed fence retains its guard.

`tests/filesystem-publication-grant.test.ts` exercises the production authority.
`tests/publication-cross-tab-browser-runner.ts` drives two independent pages and
actual bootstrap, Preview1 and runtime_proc bodies. Its assertions cover current
reads after ACK without a commit nudge, bounded prefixes, exact import, local
exclusion, late attachment cleanup and separately observed native worker death.
Passing focused controls is not full matrix or production acceptance. The
current source report records which stages actually passed and every preserved
red. Cold files and growth beyond the resident bound are explicitly unsupported.
File-only attachments still reject namespace operations. No SAFE, durable history,
consumer pin, public API or S1/S2 acceptance follows.

A fresh resident connection reuses the full root-format allocation. It costs
25,477,140 bytes before JavaScript objects, ports and shared offsets, despite
creating no second MemFS. This is byte accounting, not aggregate memory acceptance.

## Private workspace transport

A `workspace` resident descriptor also routes namespace and metadata calls through
that same authority. Independent pages receive no authority root buffers. Each
page owns an asynchronous local bridge; actual guests use their existing
synchronous completion transport to that bridge. File-only descriptors still
have no namespace preopen. The actual worker keeps its dispose-before-joined-stop
ordering. Local bridge cleanup has a separate private reply port, so revoking the
guest identity and closing its ordinary sender cannot skip that cleanup.

The authority creates each service identity from its actual root. Resolve,
lookup, stat, permissions, readdir and blocking reads reach current service
execution, not the page's synthetic metadata or path caches. Returned handles
keep bounded authority-side capability pins until that session stops. They keep
the same inode through rename, replacement and unlink. Same-page descendants use
the existing codec's exact reservation and shared offset cell. Independent pages
do not share open-description offsets.

Namespace mutations use authority-minted session identities, separate from
transport correlation. An exact duplicate returns its original receipt; changed
input conflicts. Own-session receipt queries recover outcomes without repeating
the mutation. Raw changes, arbitrary receipt lookup, diagnostics, pins and domain
stop remain on the authority's non-inherited observer route. Neither the
workspace descriptor nor ordinary guests inherit that grant.

Requests, input, pending results and retained capabilities have fixed limits.
Queued cancellation reaches the actual service completion. Stop joins service
preparation and reservation transfer before releasing its continuity guard.
Prepared leaf grants still provide immediate nonblocking I/O; EAGAIN owns no
caller input and schedules no later syscall. No second writable tree is created.

Both stop-first and dispose-first synchronously invalidate leaf admission. The
client starts one cleanup exchange before closing its ordinary port and memoizes
its result, including failure. The bridge stops admitting data and children before
awaiting owned operations. It joins real authority replies and started descriptor
adoption, then clears retained responses and closes its channel and server port.
Cancelling an unaccepted reservation cannot cancel an accepted independent child.
A descendant connect may arrive after its controller revoked the child and released
its unclaimed reservations through another channel. The bridge checks connection
and reservation provenance separately from live admission. An exactly cancelled
identity receives only a local cleanup listener, with no authority channel, session
or data/bind path. Its parent keeps ownership until an actual dedicated stop closes
that listener. Parent revocation or stopping cannot discard that proven cleanup
ownership; neither ancestor revocation nor live/adopted reservations qualify.
Malformed or unproven connections receive no cleanup-success listener. Started
adoption still joins its real result, and a failed join retains continuity.
Only successful bridge cleanup proceeds to the separate resident session close
and continuity release. Local transport timeout is not proof of authority
completion. Failed cleanup retains the worker guard and cannot publish exit ACK.
File-only sessions may prepare only their issued retained handle; workspace handle
overrides still require the authority session's actual capability ownership.

The extended cross-tab runner keeps the resident pilot controls and adds genuine
WASI namespace operations, retained-file metadata, runtime_proc I/O, codec offset
transfer, current reads after a lost nudge, observer denial and receipt recovery.
The source report records executed results. This remains a private MemoryBackend
slice, not S1/S2, SAFE, public-mode or whole-project acceptance. Cold range loading,
growth beyond admitted bounds, durable history and consumer pins stay separate.

### Workspace backing identity

Workspace synthetic shared state, owner states and capability tables each append
one non-operational word. Ordinary and file-only allocations keep their original
sizes. Capability views and scans exclude that final word. The page bridge checks
fixed allocation lengths and compares backing stores only at those fixed final
words, using captured constructors, byte-length accessors and atomic operations.
The synchronous comparison restores zero in `finally`. It never probes a live
revocation, lock, liveness or capability word. Source/target reservation keys,
counts, owner and transfer state are still checked separately.

This check assumes only the trusted host bridge writes the trailer. All host
allocations initialize it to zero; the bridge rejects a nonzero initial trailer.
Two unrelated zero-filled or copied allocations cannot pass: changing the first
trailer to minus one leaves the other at zero. Structured-cloned aliases see the
same change. Live guest operations may change operational words concurrently,
but none of their bounded capability views or slot scans includes the trailer.

The worker bootstrap keeps `FilesystemClient` in host closures. WASI and process
imports receive guest-memory arguments and descriptor operations, not the raw
connection or trailer views. The retained-descriptor codec and identity transport
are trusted host machinery. Captured construction, copying and atomics prevent a
late guest global/prototype replacement from receiving the comparison views.
This does not protect every ordinary control view. Existing protocol revocation,
section and wake operations, shared revocation checks and capability initialization
still use some late global or prototype dispatch. Hostile same-realm JavaScript
can intercept those ordinary views and obtain their backing buffers. The supported
assumption is trusted guest-ABI use with host-exclusive trailer writes, not absence
of raw-control-memory exposure to hostile JavaScript. An untrusted host integration
or arbitrary raw-SAB writer can corrupt control memory directly and is outside
this private slice. Existing captured private grant-state protections are unchanged.
This neither claims S2/SAFE acceptance nor enables public or default operation.

## Persistent checkpoint lifetime

Existing persistent-backend checkpoints and flushes reject late successful storage
completions after backend disposal. A stopped persist completion does not install
checkpoint bookkeeping or start a payload flush. Disposal does not abort or join
an adapter operation. Rejection is not rollback, and applied v1 bytes remain saved.
Live storage failures retain their original errors and dirty retry behavior.
A later failed persist does not invalidate an earlier successful payload barrier.
Ordinary close joins admitted work and its final durable save before disposal, then joins native storage close. A failed drain or save retains the original close rejection and does not release storage.
These checks change no storage format, FAST memory ACK, or untracked receipt.
They do not provide explicit recovery, a durable publication cut, or SAFE mode.

## Private persistent resident owner

`browser/persistent-resident-owner.ts` is an internal construction and teardown owner.
It is not exported by the package and does not install a replacement Runtime filesystem.
The caller retains the returned owner before awaiting `ready`, including when readiness
fails. Only a successful `stop()` permits dropping that owner.

Selection snapshots the actual origin, implementation, exact name and current format.
The continuity key is JSON of `[origin, implementation, name]`. Format validates the
request but cannot create a separate lock namespace for the same physical store.
Bootstrap and exclusive continuity precede native open, ownership claim and load.
The new owner always waits for native ownership without stealing it. The ordinary
filesystem worker keeps its existing policy through the same backend opener.

Startup cancellation closes admission immediately and cancels an ungranted native
ownership wait without retiring its ordinary holder. The owner forwards its abort
signal and retains the original physical opening debt before the native request starts.
Readiness may reject early, but a blocked or aborted IndexedDB request remains debt
until terminal native delivery or error. A delivered DB closes once after any started
epoch transaction and lock callback retire. The cleanup owner records a started epoch
transaction and its original terminal promise before request setup, so a synchronous
setup failure cannot bypass that join. A terminal native error without a handle has
no close obligation. The owner joins the original shared opening and physical debt
before releasing guards. A failed native close retains that debt and the same failed
stop. Cancellation is not permission to forgive pending or failed physical cleanup.

A published owner stops in this order: resident transport drain, service preparation
and detached-barrier drain, final checkpoint with the publication domain still live,
backend lifetime disposal, root/service disposal, actual native storage close, then
continuity and bootstrap release. Unpublished construction omits the final checkpoint.
A live resident session or outstanding grant refuses the drain. Failure retains the
owner and remaining guards. Repeated stop returns the original promise, even if it
failed. Genuine realm destruction is distinct from successful cooperative cleanup.

Every ready result includes a new instance/history and the full `v1-new-history`
notice. Durable publication cuts are untracked, old capabilities and mutation
outcomes are not restored, and the acknowledged tail may be lost. Explicit `reopen-v1`
requires the caller's acceptance of that loss and uncertainty. This private mechanism
does not provide Runtime recovery, retirement of surviving clients, SAFE guarantees,
a public recovery API or a consumer format switch.

The cross-tab runner's `--persistent-owner-only chromium` selection passed the actual
ordinary-worker pending-claim cancellation, queued native-open delivery, injected
original physical-close failure and completed-epoch cancellation controls. It keeps
all prior factory controls, and the default runner keeps its full selection. The
native holder remains alive with unchanged bytes and epoch when only its pending
competitor is cancelled. Failed close retains the same failed stop and guards until
observed realm destruction, which is teardown rather than successful cleanup.

These bounded checks do not prove factory mutation/save/reopen recovery, refusal of
old descriptors, input/reply mutation or reentrant calls, persistent CLAIMED refusal,
other native schedules, OPFS or other-engine qualification. They do not replace the
complete registered browser matrix or independent review, and do not accept Runtime
recovery, SAFE mode, public/default APIs or consumer installation.
