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
have no namespace preopen. Attachment and joined-stop ordering are unchanged.

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

The extended cross-tab runner keeps the resident pilot controls and adds genuine
WASI namespace operations, retained-file metadata, runtime_proc I/O, codec offset
transfer, current reads after a lost nudge, observer denial and receipt recovery.
The source report records executed results. This remains a private MemoryBackend
slice, not S1/S2, SAFE, public-mode or whole-project acceptance. Cold range loading,
growth beyond admitted bounds, durable history and consumer pins stay separate.
