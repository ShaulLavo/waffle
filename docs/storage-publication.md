# Internal local publication checkpoint

Status: incomplete and not accepted for consumer use. No public API or default
storage behavior changes. The required unified production oracle remains red.

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

## Evidence and remaining work

Focused tests exercise the real MemoryBackend family, client/service/direct
paths, retained descriptions, exact receipts, paused persistent reads, and
exported WASI/runtime_proc Wasm functions. Worker lifecycle tests pause actual
admission and observe the native worker close event before a proven-dead reap.

The supplemental same-root browser fixture covers a subset in Chromium,
Firefox and WebKit. It is not the complete required browser matrix. Complete
local path/lifecycle acceptance, the unified oracle, source-quality and all
required full gates still block a review-ready PR. This checkpoint does not
approve S1/S2, cross-tab topology, SAFE, persisted publication metadata, packed
storage, public transactions, indexing/search, performance or consumer pins.
