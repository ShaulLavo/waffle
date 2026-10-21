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
