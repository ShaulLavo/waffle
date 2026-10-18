# Waffle VFS family

Status: **Approved**

Owner direction: 2026-10-18.

Build four persistent VFSs with meaningful differences in durability, concurrency, browser support and performance. Keep IndexedDB as the default. Make every VFS tight and fast by measuring competing implementations, not by selecting an architecture from intuition.

A setting such as `whenBusy` is not a VFS. It belongs to initialization.

## Starting point and dependencies

Research baseline: Waffle `1c6e6bb90f41a36bb1dc8bedd046a392714424dd`, read from fetched `origin/main`, not the stale shared checkout.

At that baseline:

- IndexedDB is the default storage backend.
- Both persistent backends run behind `PersistentBackend`: memory is authoritative while running, payloads load lazily, and ordered background checkpoints persist changes.
- Ordinary write completion is not necessarily a durability barrier. `flush` and guest `fsync` provide that barrier.
- IndexedDB commits already use strict transactions, a checksummed delta journal and periodically compacted base snapshots.
- OPFS uses immutable payload revisions and two checksummed full metadata snapshots.
- OPFS uses exclusive native sync handles and one workspace owner.
- Guest filesystem clients can read and mutate shared memory directly, bypassing a service round trip.
- A page owns one `createRuntime()` instance. Programs and embedded shells borrow it.

Prerequisites and coordination:

| Work | State at research time | Required relationship |
|---|---|---|
| Exclusive host creation, [PR #16](https://github.com/ShaulLavo/waffle/pull/16) | Merged as `1c6e6bb90f41a36bb1dc8bedd046a392714424dd` | Preserve atomic exclusive creation, including aliases and directory collisions; extend it across concurrent tabs. |
| `opfs-wait` / `whenBusy`, [PR #21](https://github.com/ShaulLavo/waffle/pull/21) | Open | Land first. Reuse its opening/waiting/ready/failed/disposed lifecycle, cancellation, asynchronous disposal and ownership rules. Do not implement a competing lifecycle. |
| Inherited fd 3, [PR #19](https://github.com/ShaulLavo/waffle/pull/19) | Open | Land before final guest-fixture certification. Preserve inherited descriptors and real filesystem preopens. Inherit its approved, measured core budget rather than reverting or duplicating its work. |

Recheck these PRs before implementation. Base work on their actual merged commits, not their temporary branches.

All implementation happens in exclusive worktrees beneath `../../worktrees/waffle/`. Do not edit, build or test `.`. Use the fleet queues for substantial work, patch version bumps only, and no new GitHub issues.

## 1. Products and their contracts

Use these names for the initial API and scoreboard:

| VFS | Ordinary successful mutation means | Durability barrier | Multi-tab behavior | Browser requirements |
|---|---|---|---|---|
| `indexeddb` — default | Existing memory-first completion; strict storage commits happen behind it | `flush` / `fsync` | One active workspace owner; default takeover with epoch fencing, or queued wait | IndexedDB, Web Locks and Waffle’s existing worker/SAB requirements |
| `opfs-memory` | Memory mutation completed; persistence follows asynchronously | `flush` / `fsync` | One active owner; other tabs wait | OPFS sync handles in a dedicated worker, Web Locks; Chromium, Firefox and WebKit capability matrix |
| `opfs-wal` | Transaction committed through Waffle’s WAL and its required durability barrier | Commit already durable; `flush` / `fsync` remain ordering barriers | Several live tabs; concurrent readers, serialized writers | Chromium’s behaviorally verified `readwrite-unsafe` handles, Web Locks, dedicated workers |
| `opfs-safe` | Mutation, including its required namespace changes, is durable before completion | Every mutation is write-through; explicit barriers still order work | One active owner; other tabs wait | Standard exclusive OPFS sync handles, Web Locks; Chromium, Firefox and WebKit capability matrix |

The existing nonpersistent memory filesystem remains available for tests and applications that request it. It is not a fifth persistent product.

“Durable” means completion of the browser storage APIs and the documented recovery protocol. It does not promise survival of site-data deletion, eviction, private-session destruction, storage-device failure or browser violations of those APIs.

### IndexedDB safety is not a new durability claim

Keep the default store and its existing saved workspaces. Preserve its explicit durability semantics unless the measured experiment establishes and documents a deliberate stronger contract.

Strict IndexedDB transactions do not make an earlier memory-only write acknowledgement durable. The descriptor and documentation must say that plainly.

Takeover is also not simultaneous multi-writer access: it revokes the previous owner and fences its commits. Waiting preserves the current owner instead. Neither should be advertised as concurrent workspace execution.

### OPFS memory-first

This is deliberately relaxed durability, not deliberately corrupt storage.

- A write may complete before its bytes reach OPFS.
- A crash may lose acknowledged writes that did not pass a durability barrier.
- Recovery must still produce a valid committed tree, not a partially applied rename or corrupt namespace.
- A nominal checkpoint interval is a scheduling target, not a maximum loss window. Browser throttling, storage load and quota pressure can increase lag.
- Expose dirty bytes, oldest uncommitted mutation age and checkpoint duration to the benchmark instrumentation.
- Preserve lazy loading and resident-memory limits. “Memory-first” does not require loading every file at boot.

### OPFS WAL

The native handle mode is unsafe; Waffle’s protocol must not be.

Use concurrent native handles only underneath a whole-tree commit, locking, recovery and reclamation protocol. Do not ship a mode that merely changes the argument to `createSyncAccessHandle()`.

Require durable acknowledgement for this VFS. Group commit is allowed, but every member waits for the durable group barrier before receiving success. A relaxed-ack WAL experiment may inform `opfs-memory`; it cannot win this VFS by silently weakening its contract.

### OPFS safe

Use standard exclusive sync handles and write through before acknowledging mutations.

Cover file bytes and namespace effects: creation, directory creation, links, removal, rename and replacement. Closing a native handle alone is not the specified durability barrier.

Do not impose an eager workspace load. Compare lazy access against selective prefetch and measure cold boot. “Safe, slower, works everywhere” is the execution interpretation; any claim about slower boot must come from measurements.

## 2. Shared selection and descriptor

Introduce one selection point:

```ts
createRuntime({
  filesystem: {
    name: "workspace",
    vfs: "indexeddb",
    whenBusy: "wait",
  },
});
```

Omitting `vfs` selects `indexeddb`.

Replace the existing `storage` selector in matching consumers together. Do not retain old request shapes or add version-negotiation branches.

Define the descriptor in `fs/vfs.ts`, exported through the existing public entry points. It must describe:

- Stable ID and display name.
- Persistent or volatile storage.
- Ordinary mutation acknowledgement: memory or durable commit.
- `flush` and `fsync` guarantees, including targeted flush.
- Exclusive ownership versus concurrent tabs.
- Supported `whenBusy` values and default.
- Required browser capabilities.
- Worker requirement and whether service execution may await asynchronous work.
- Whether direct shared-memory reads or mutations are permitted.
- On-disk format identity and storage location.
- Explicitly unsupported settings.

Use the lifecycle introduced by #21. Keep capability descriptors separate from mutable lifecycle state.

Settings:

- `indexeddb`: `whenBusy: "takeover" | "wait"`, preserving the existing default.
- `opfs-memory` and `opfs-safe`: `whenBusy: "wait"` only.
- `opfs-wal`: concurrent mounting; ordinary writer-lock contention waits internally. Reject irrelevant takeover settings rather than manufacturing another VFS identity.

Unsupported capabilities, invalid settings and incompatible persisted formats must produce stable typed errors across worker startup. Preserve the error code/name when sending the failure to the page. Do not flatten it into an unclassifiable startup string.

Explicit `opfs-wal` selection must never silently become another OPFS mode, IndexedDB or memory.

### Storage identity and switching

Selecting a different store does not migrate files.

Preserve existing IndexedDB names and data. Preserve existing OPFS data when selecting its corresponding memory-first implementation.

All modes that can access the same OPFS root must participate in the same workspace-level mount/format locking namespace. Do not include the VFS ID in that lock name if doing so would let incompatible implementations mutate the same files simultaneously.

Persist a format identity before publishing a new format. An incompatible existing format produces a typed error without modifying the workspace. Moving between incompatible formats requires an explicit export/import or offline conversion under exclusive ownership. No silent empty workspace, destructive reset or automatic conversion on ordinary open.

This is stored-data handling, not support for mismatched running application versions.

## 3. Reuse one filesystem implementation

Keep these layers:

- `core/filesystem.ts`: guest-visible filesystem contract.
- `fs/backend.ts`: service execution boundary.
- `fs/persistent.ts`: reusable lazy hydration, dirty tracking and checkpoint machinery where its semantics fit.
- `fs/storage.ts`: persisted tree, payload and batch primitives.
- `fs/client.ts` and `fs/service.ts`: transport, access policy and acknowledgement ordering.

Reuse `MemFS` namespace semantics and stable inode identity. Do not implement four independent versions of rename, unlink, append, path traversal or exclusive creation.

Preserve:

- Open descriptions across rename and unlink.
- Shared offsets for inherited descriptions.
- Independent offsets for independently opened descriptions.
- Atomic append.
- Exclusive create from #16.
- Correct partial-write counts and errno behavior.
- Existing targeted-flush guarantees.
- Process revocation and owner cleanup.

### Direct paths are part of the contract

Today’s client can perform direct shared-memory write, append, resize and mtime changes, and can cache reads, stats, path resolution and directory listings.

Those paths must not bypass a VFS’s guarantees.

For the first correct implementation:

- Permit the existing direct mutation policy for memory-first modes where appropriate.
- Route `opfs-safe` mutations through the durable service path.
- Route `opfs-wal` mutations through the writer protocol.
- Disable or validate cross-tab-sensitive read caches in `opfs-wal`.
- Reintroduce optimized direct paths only with a demonstrated coherence and commit protocol, measured separately.

A synchronous WASI call can wait on its SAB completion while the filesystem worker awaits storage or Web Locks. This does not require making the guest ABI asynchronous or blocking the page thread.

### Publication and acknowledgement ordering

Do not hold a local shared-memory mutation critical section while waiting for a Web Lock, a durable commit or other unbounded asynchronous work.

Introduce a staged transaction/publication boundary:

1. Acquire the required service/workspace ordering.
2. Hydrate and validate the necessary state.
3. Revalidate paths, capabilities and generations at the transaction’s actual serialization point.
4. Produce a coherent transaction using the shared filesystem semantics.
5. Persist and flush the transaction when the VFS requires durable acknowledgement.
6. Publish the committed in-memory view under a short local mutation section.
7. Complete the guest or host request.

The implementation may use an overlay, copy-on-write delta or another measured staging technique. The invariant is fixed; the representation is not.

If cancellation or a crash happens after commit but before the response, the operation has an unknown outcome to its caller. Do not blindly replay it. Distinguish a rejected operation from an operation whose result was not observed.

## 4. Whole-tree WAL protocol

Before implementation, write down the on-disk records, lock order, publication point and recovery state machine in `docs/vfs.md`.

wa-sqlite’s `OPFSWriteAheadVFS` is a design reference, not a filesystem implementation to copy wholesale. Its page-oriented database assumptions do not cover Waffle’s directories, inode lifetimes or POSIX namespace.

### Transaction contents

A transaction must include all required changes for one filesystem operation:

- Transaction identity, prior committed generation and resulting generation.
- Inode allocation and updates.
- Directory-edge additions/removals.
- Payload references or byte-range redo records.
- File size, timestamps and link changes.
- A commit record covering the complete transaction.
- Lengths, integrity checks and format validation sufficient to reject incomplete or torn tails.

Allocate identities under the writer protocol. Two tabs must not allocate the same inode independently.

A rename, including replacement of an existing destination, commits as one namespace operation. Recovery must see its old state or its new state, never half of each. Apply the same rule to directory moves and link-count changes.

Do not promise atomicity across an application’s arbitrary sequence of separate syscalls.

### Locking and writer recovery

Use Web Locks as authoritative coordination, with a documented total lock order.

Required roles:

- Mount/format admission.
- One workspace writer.
- Read-view admission and generation pins.
- Checkpoint/reclamation.
- Open-inode lifetime pins where needed.

There is one writer at a time. Before appending, it refreshes authoritative committed state and repairs or discards an incomplete tail left by the preceding writer.

Never steal a live WAL writer because it is hidden, slow or has exceeded a timer. Worker/tab termination releases its locks; the next owner performs recovery.

Use `readwrite-unsafe` consistently for files intended to have concurrent handles. Do not mix exclusive and unsafe access to the same file accidentally.

### Reader views and cross-tab visibility

A reader takes a coherent committed view, not a collection of independently refreshed directory and payload caches.

Use generation pins with an admission/reclamation protocol that closes the race between discovering a generation and pinning it. Do not use `navigator.locks.query()` as proof that reclamation is safe.

Requirements:

- A read already in progress may complete against its pinned generation.
- An operation begun after another tab’s acknowledged commit must observe that commit or a later committed state.
- A writer can prepare new immutable data while existing readers use prior data.
- Payloads and metadata still needed by a reader cannot be overwritten or reclaimed.
- Long-lived open descriptions preserve inode identity after unlink.
- Append and exclusive create serialize against writers from other tabs.

BroadcastChannel may announce a new generation and invalidate caches promptly. It is an optimization, not the source of truth. Missing, delayed, reordered or suppressed broadcasts must not cause indefinite stale reads.

### Commit and durability

Write data and transaction records before the commit publication that makes them visible.

Before acknowledging success, flush every file whose contents are required to recover that transaction. Include log rotation and checkpoint-boundary cases. Flushing only the currently active log is insufficient if an acknowledged transaction depends on another file.

Readers must not accept a valid-looking commit whose referenced payload or namespace state is incomplete.

### Checkpoint and reclamation

Compare checkpoint layouts in the experiment phase, but preserve this ordering:

1. Select a committed checkpoint cut.
2. Write a complete recoverable checkpoint.
3. Flush its required data and metadata.
4. Publish the new checkpoint generation recoverably.
5. Retire older logs/data only after all reader and open-inode pins permit it.
6. Reuse or truncate log storage only when recovery and active readers no longer need it.

A crashed checkpoint must leave either the preceding recoverable state or the new one.

A paused reader can delay reclamation. Bound growth with measured thresholds and explicit backpressure or quota errors; do not break the reader’s guarantee, steal its pin or silently discard data.

### Recovery

Test and document:

- Empty workspace.
- Valid checkpoint plus committed tail.
- Incomplete payload/frame/commit.
- Torn or corrupt tail.
- Interrupted checkpoint publication.
- Interrupted log rotation.
- Writer/tab/browser death.
- Quota or flush failure.
- Invalid established metadata.

Stop at an invalid tail according to the recorded chain rules. Never reconnect an abandoned successor branch when a generation number is reused. Never turn corruption of an established workspace into a successful empty mount.

### Feature detection

The inspected WHATWG File System standard does not provide a portable guarantee for Chromium’s unsafe-handle extension. Accepting a dictionary argument is not proof of support: an unknown member may be ignored.

Probe in dedicated workers using a uniquely named disposable OPFS file:

1. Hold an unsafe handle open in one worker.
2. Open a second unsafe handle concurrently in another worker.
3. Verify the expected shared read/write/flush behavior.
4. Close all handles and workers.
5. Delete the probe file on success, error and cancellation.

The probe must distinguish real concurrent unsafe handles from ordinary exclusive behavior. Record probe cost in cold startup.

Firefox and WebKit must assert the expected typed unsupported result for `opfs-wal`. They are not silently skipped successes.

## 5. Competing designs, not architectural guesses

For each VFS, measure two to four candidates before committing to its production design. Keep the winner’s numbers and the losers’ numbers.

Candidates must satisfy the VFS contract to be eligible. A faster implementation that loses promised durability, violates namespace atomicity or serves stale cross-tab data is disqualified.

### What history actually says about journaling

Waffle’s IndexedDB journal was not removed.

- `037d35e86fd5b0b93e98e174cfac4991fbbd929f` introduced the metadata, journal and data stores, checksummed deltas, two base snapshots and periodic compaction.
- `538796963d3751911611330475c37a84d5067970` changed ownership and epoch fencing for retained workers/Safari reload behavior. It did not remove the journal.
- `c841b91abe86a0213a3cf1beff46d45ad58bdc48` added OPFS separately, using full metadata snapshots instead of IndexedDB’s delta journal.

The existing IndexedDB design makes ordinary metadata commits proportional to dirty changes, with full-tree work at load/compaction. Existing OPFS checkpoint metadata work grows with the workspace.

“Bring journaling back” therefore becomes a concrete experiment in OPFS redo journaling and alternative IndexedDB journal granularity. It is not a predetermined rewrite or a claim that today’s IDB journal disappeared.

Historical OPFS numbers are useful leads, not baselines: they were limited samples on different environments, not paired measurements of these candidate designs.

### Candidate matrix

| VFS | Candidates to measure |
|---|---|
| `indexeddb` | **A:** current periodic memory-first checkpoints, delta journal and immutable payloads. **B:** same layout with byte/time-bounded batching and measured compaction thresholds. **C:** strict write-through/group-commit policy, measuring ordinary completion and durable completion separately. **D:** finer-grained payload redo/chunk journal versus whole dirty-file revisions. |
| `opfs-memory` | **A:** current periodic immutable payloads plus full metadata snapshots. **B:** bounded/coalesced checkpoint batches using the same format. **C:** background redo journal plus periodic checkpoint/compaction. |
| `opfs-safe` | **A:** per-operation write-through with immutable payloads and recoverable metadata publication. **B:** durable redo journal with lazy checkpointing. **C:** group-committed durable redo, delaying each acknowledgement until the group is flushed. |
| `opfs-wal` | **A:** one append-only redo stream with copy-on-write checkpoints. **B:** segmented or dual rotating redo streams with generation pins. **C:** the simpler layout with durable group commit and coalesced checkpoint work. |

Internal speculative memory staging is admissible for the durable VFSs; acknowledging that staging before durability is not.

### Experiment discipline

For every candidate:

- State the hypothesis, changed mechanism and expected benefit.
- Run the fixed workload set and capability-appropriate multi-tab case.
- Record throughput, latency, durable completion, startup, resident memory, storage growth, recovery and bundle contribution.
- Record code complexity and additional protocol states.
- Preserve exact revision, configuration, fixture seed and runner identity.
- Keep failed correctness outcomes alongside timing results; do not delete losing rows.
- Remove losing production implementations after selection. Preserve the reproducible experiment or trace adapter outside the shipped runtime.

Start with bounded prototypes over shared primitives. Do not build four complete filesystems merely to compare one batching choice.

Budget the first screening round at one implementation day per bounded candidate and at most four dedicated benchmark VM-hours per candidate. If a candidate needs a new protocol first, land that prerequisite and name the later experiment milestone. Mark the candidate **deferred, not evaluated**; do not declare another candidate the final winner before the required comparison.

In particular, segmented/dual-log concurrency and payload-range journaling may need later milestones. Their cost is a reason to sequence them, not to pad early PRs or invent estimated wins.

## 6. Fixed workloads

Implement deterministic fixture generation and operation traces in `tooling/vfs-workloads.ts`.

Use a checked-in seed and content generator. No network, npm registry variation or dependency downloads inside measured intervals.

Run guest filesystem operations as well as host-facade operations. Prebuild guest fixtures before timing.

### W1 — large-workspace cold boot

Fixture:

- 5,000 directories.
- 50,000 files of 4 KiB.
- 32 additional files of 1 MiB.
- Deterministic tree shape and contents.

Seed and durably close before measurement.

Measure a new browser process/profile reopening the preserved workspace, filesystem readiness, first guest stat/read, and a fixed 128-file read set. Measure first-ever empty open separately.

Report metadata-only readiness separately from first-use hydration. Do not hide an eager data load outside the timer.

“Cold” means a new browser process and cold application caches. Do not claim cold OS/device caches unless a separate controlled experiment establishes that.

### W2 — npm-install-like small-file workload

Generate 2,000 package directories, each with ten files whose sizes repeat:

`0, 128, 512, 1024, 4096, 16384, 32768, 1024, 256, 2048` bytes.

Perform:

- Staging-directory creation.
- File creation/write/close.
- Package-directory rename into place.
- Fixed stat, readdir and read verification.
- A durability barrier every 100 installed packages.
- Replacement of 100 packages.
- Removal of 200 packages.
- Final global durability barrier and tree verification.

Report files/second, mutation latency, barrier latency and total time through durable completion.

### W3 — sequential throughput

Write a deterministic 128 MiB file in 64 KiB calls, flush it, read it sequentially and verify its hash.

Report:

- Ordinary write throughput.
- Durable write throughput, including the final barrier.
- Read throughput.
- Peak memory and physical/logical storage growth.

Use a fresh file for each measured repetition. Do not report a hot shared-memory reread as cold storage bandwidth.

### W4 — fsync-heavy saves

Perform 1,000 deterministic 4 KiB writes to a 256 KiB file, with `fsync` after each write. Interleave 100 temp-file/save/rename sequences with the required namespace durability barrier.

Report total durable saves/second and operation-level p50/p95/p99 acknowledgement and barrier latency.

The verification controller records each observed durable acknowledgement so crash tests can distinguish required retained data from unknown outcomes.

### W5 — multi-tab mixed load

Use four real pages sharing one origin and workspace.

For `opfs-wal`:

- Three readers and one writer, then two readers and two writers.
- Fixed reads/stats/readdirs mixed with writes, appends, exclusive creates, renames and deletes.
- A fixed 10,000-operation trace, including contended names.
- One reader deliberately holds a pinned view across a checkpoint.

Report aggregate durable operations/second, reader p95/p99, writer p95/p99, lock-wait time, fairness and checkpoint/reclamation growth.

For exclusive VFSs:

- One active owner and three contenders.
- Exercise waiting, orderly handoff and default IndexedDB takeover in separate cases.
- Measure handoff readiness and owner-revocation latency.
- Verify that contenders do not secretly execute as simultaneous owners.

Concurrent four-tab filesystem throughput is **not applicable** for exclusive VFSs. Do not substitute four independent workspaces and label that concurrent access to one workspace.

## 7. Hosts, browser matrix and measurement method

Read the current machine-fleet skill before every campaign.

### Fixed performance runner

Use **`upcloud-4`** as the dedicated reference runner for performance campaigns.

- Reserve one exclusive host-local `bench` job through the fleet dispatcher and heavy queue.
- Check owner-busy state and reservations before submission and after admission.
- Do not permanently claim the VM or change owner-busy flags.
- Keep the same VM identity, vCPU/RAM allocation, disk/filesystem, browser versions and toolchain within a comparison campaign.
- Use the remote dispatcher’s immutable staging and teardown verification.
- Use `/srv/agent-work/` for task workloads and the existing shared browser cache.
- Respect the fleet’s short physical `TMPDIR` requirement for Chromium sockets.
- Check free space before profiles, fixtures, browser installation or transferred artifacts.

Capture CPU load/steal, memory pressure, storage characteristics and versions with each run. VM jitter invalidates a timing sample; it does not erase a correctness failure.

Do not pool results from different hosts into one performance baseline.

### Browser matrix

| Target | IndexedDB | OPFS memory | OPFS safe | OPFS WAL |
|---|---|---|---|---|
| Fixed Chromium on `upcloud-4` | Full | Full | Full | Full, after behavioral probe |
| Fixed Firefox on `upcloud-4` | Full | Full | Full | Typed unsupported assertion |
| Fixed Playwright WebKit on `upcloud-4` | Full | Full | Full | Typed unsupported assertion |
| Shipping Safari on the M1 Mac | Correctness and lifecycle certification; timing tracked separately | Same | Same | Unsupported assertion unless actual support is independently demonstrated |

Playwright WebKit is not shipping Safari or iOS Safari. Use the fleet’s M1 access and atomic Mac reservation, respecting owner use. Real iPhone lifecycle certification is separate from the desktop score.

PC correctness and diagnostics use its installed heavy queue. Do not wait behind a busy PC without checking suitable fleet capacity.

### Sampling

- Initial screening: two warmups and five measured repetitions per applicable workload.
- Promotion: three warmups and nine paired baseline/candidate repetitions.
- Alternate baseline/candidate order using a fixed schedule.
- Use independent fresh run fixtures/profiles where the workload requires them.
- Report medians across repetitions and operation-level latency distributions.
- Use paired confidence intervals for regression decisions.
- Do not imply a meaningful cold-boot p99 from nine startup observations.
- Time only the prescribed interval, using browser monotonic clocks and controller-side wall time for cross-process boundaries.

No pass-by-retry. An invalid environmental run is retained and classified with its reason. A new complete campaign is a new result, not replacement of an inconvenient sample.

## 8. Scoreboard and ratchets

Add the runner and comparator:

- `tooling/vfs-benchmark.ts`
- `tooling/vfs-score.ts`
- `tooling/vfs-score-config.ts`

Store raw samples and small result summaries outside the repository, under `../../reports/waffle-vfs/`, keyed by immutable revision and campaign ID. PRs contain concise result tables and evidence references. Do not commit browser profiles, traces, screenshots, generated binaries or raw test evidence.

### Eligibility first

Every performance row has a correctness state:

- Eligible.
- Failed correctness.
- Unsupported as specified.
- Deferred/not measured.
- Invalid environment.

Only eligible rows contribute to performance scores.

Unsupported masks are fixed by the product/browser matrix. Changing the mask requires a reviewed contract change; it cannot improve a score by removing a slow browser.

### Score

For each fixed browser/VFS/workload cell, normalize its declared primary metrics against its initial eligible baseline:

- Latency or elapsed time: `baseline / candidate`.
- Throughput: `candidate / baseline`.

Take their geometric mean and multiply by 100. Fix metric weights before comparing candidates.

Primary metrics:

- W1: readiness and first-use time.
- W2: end-to-end durable installation time.
- W3: durable write throughput and verified read throughput.
- W4: durable saves/second and p95 save latency.
- W5: durable throughput and reader/writer tail latency for WAL; handoff/revocation latency for exclusive modes.

Report a score per VFS across its fixed eligible cells. Report a family score only after all four VFSs have initial eligible baselines. Until then it is explicitly incomplete.

Always show raw milliseconds, MiB/second and operations/second alongside normalized scores.

### Selection and ratcheting

A candidate wins when it:

1. Passes the complete relevant correctness contract.
2. Improves the weighted score by at least 5%, or provides a separately required capability.
3. Does not breach any guardrail.
4. Has a defensible complexity/maintenance cost.

If candidates are within measurement uncertainty, prefer the simpler one. Do not introduce a new journal or log-rotation state machine for an unmeasured theoretical win.

Keep the latest accepted best score as a ratchet. Baselines are immutable; a slower result does not reset the bar. A deliberate trade-off needs explicit recorded acceptance, not a new convenient baseline.

### Guardrails

- **Default IndexedDB:** no material regression in any fixed workload, startup or p95 durable-save latency. Promotion requires the paired upper confidence bound to remain within 5% of the accepted reference.
- **Core bundle:** retain the approved budget in `tooling/runtime-size.ts`. Research baseline was 7,168 gzip bytes; inherit any separately approved #19 change.
- **Pay-for-use:** no eager process implementation before first spawn. Unselected WAL/safe implementations must not become mandatory default-path downloads.
- **Filesystem size:** report each VFS’s compressed code and worker contribution. Any budget change must include measured justification in its PR.
- **Cold start:** no hidden capability probe, eager payload scan or additional worker startup outside the measured interval.
- **Memory/storage:** report peaks and amplification. Dirty-memory or WAL growth must have a documented bound/backpressure behavior.
- **Correctness:** never traded for score.

An inconclusive confidence interval is not proof of non-regression. Investigate noise or run another complete campaign.

## 9. Non-negotiable correctness gates

Parameterize the existing storage contract so every supported persistent VFS runs it. Preserve the existing assertions; add policy-specific expectations rather than deleting failing cases.

Relevant existing coverage includes:

- `tests/storage.test.ts`
- `tests/storage-suite-contract.test.ts`
- `tests/storage-browser.ts`
- `tests/opfs-storage-browser.ts`
- `tests/persistence.test.ts`
- `tests/persistence-queue.test.ts`
- `tests/persistence-durability.test.ts`
- `tests/filesystem-persistence-shared.test.ts`
- `tests/filesystem-atomic.test.ts`

### Crash and durability torture

Add `tests/vfs-crash-browser.ts` with deterministic barriers at:

- Before/after payload write.
- Before/after payload flush.
- Mid-frame and before/after commit.
- Before/after checkpoint publication.
- Before/after log rotation and reclamation.
- Before request response.

Kill the actual filesystem worker, tab and browser process in separate cases. Reload without graceful close, then verify file contents, directory graph, link identity and expected durable generations.

The controller survives the killed browser and records observed acknowledgements externally.

- `opfs-safe` and `opfs-wal`: every observed successful mutation survives.
- Memory-first modes: every observed durability barrier survives; later ordinary writes may be lost.
- Unknown-outcome operations may be present or absent only where the protocol permits, never half-applied.
- Previously durable unrelated data must not disappear because another write was interrupted.

Browser-process termination is not a physical power-cut experiment. State the limit of what it proves.

Run all deterministic cut points plus 32 seeded kill/reopen cycles per supported VFS/browser pair for merge certification. Run 1,000 seeded cycles per pair for the final endurance certification.

### Multi-tab torture

Add `tests/vfs-multitab-browser.ts`.

Cover:

- Two to eight real tabs.
- Competing exclusive creates and appends.
- Rename replacement and cross-directory moves.
- Unlink while another tab holds an open description.
- Reader pins during checkpoint and reclamation.
- Broadcast delivery suppressed.
- Writer death mid-transaction.
- Tab suspension and resumed stale caches.
- Quota/flush failure.
- Waiting cancellation and disposal racing lock grant.
- No writer starvation under the fixed stress trace.

Check histories against a reference model and operation-level linearization rules. A final directory listing alone cannot detect all stale reads or lost updates.

### Corruption and error handling

Inject short records, invalid checksums, missing payloads, abandoned successor branches and failed flushes.

Verify stable errors, no silent empty reset, no success acknowledgement before its required barrier, no use-after-dispose and no leaked lock/handle/worker.

Typed unsupported cases are required assertions on Firefox and WebKit, not skipped tests.

## 10. Ordered delivery

Each item is a PR-sized unit or a clearly bounded pair where experiment and production selection must remain separate. Do not expose an uncertified new VFS through the public selector.

| Step | Scope and named files | Acceptance |
|---|---|---|
| **1. Baseline and harness** | Add `tooling/vfs-workloads.ts`, `tooling/vfs-benchmark.ts` and `tooling/vfs-score.ts`; reuse existing browser runner lifecycle. | Fixed workloads reproducible; current IDB/OPFS baselines captured on the reserved runner; cleanup verified. |
| **2. Contract and selection** | Add `fs/vfs.ts`; update `browser/shared-fs.ts`, `browser/fs-worker.ts`, `runtime.ts` and `index.ts`. | #21 merged; default unchanged; descriptor/settings/errors tested; existing modes only; matching consumer selector changes prepared. |
| **3. Transaction/access boundary** | Update `fs/backend.ts`, `fs/service.ts`, `fs/client.ts` and shared-state access policy. | Durable mode cannot bypass service; no async wait inside local mutation critical sections; all existing inode, append, exclusive-create and revocation tests pass. |
| **4. IndexedDB experiments** | Bounded alternatives in `fs/indexeddb.ts` and `fs/persistent.ts`, with experiment selection confined to tooling. | At least two candidates measured across all workloads; payload-journal candidate either measured or explicitly scheduled in step 7; no default change declared final while a required rival remains unevaluated. |
| **5. OPFS memory experiments** | Compare snapshot batching in `fs/opfs.ts` and `fs/persistent.ts`. | Current and bounded-batch candidates measured; ordinary ACK and durable end-to-end numbers separated; journaling comparison scheduled in step 7. |
| **6. Recoverable OPFS transaction primitives** | Add `fs/opfs-journal.ts` and record definitions shared through `fs/storage.ts`; document `docs/vfs.md`. | Complete transaction framing, flush ordering, tail recovery and checkpoint publication tests; not publicly selectable yet. |
| **7. Journal experiments and default winners** | Run IDB granularity and OPFS background-journal candidates using the shared harness; retain only selected production mechanisms. | Every default/memory VFS has two to four measured candidates; winner/loser table complete; default IDB guardrails pass. |
| **8. Safe VFS experiments** | Add `fs/opfs-safe.ts`; compare write-through snapshots, durable journal and group commit. | Every mutation ACK is durable; at least two fully eligible designs measured; third measured or explicitly deferred before final selection; crash contract passes. |
| **9. Unsafe-handle admission and WAL writer** | Add `fs/opfs-wal.ts`; behavioral probe, mount/format rules and single writer recovery. | Chromium probe proves concurrent handles; unsupported engines return typed errors; whole-tree transaction recovery works with competing writers; still not publicly enabled. |
| **10. Concurrent readers and inode lifetime** | Complete WAL generation pins, cache validation and reclamation; extend `fs/client.ts` and `tests/vfs-multitab-browser.ts`. | Lost broadcasts, open-unlinked files, checkpoint races and killed writers pass; no page-local stale-cache shortcut. |
| **11. WAL layout experiments** | Compare single/segmented or dual log layout and durable group commit within the certified protocol. | Two to four eligible candidates measured; record deferred experiments honestly; select winner from score plus complexity, not familiarity. |
| **12. Browser certification and public enablement** | Add `tests/vfs-crash-browser.ts` and `tests/vfs-browser-runner.ts`; update CI and docs. | Full supported-engine matrix, deterministic fault points, merge torture and endurance certification pass; #19 guest fixtures integrated; only then expose all certified VFSs. |
| **13. Consumer delivery and final ratchet** | Update exact Waffle pins and matching entry points in bun-wasm and bash-web. | Standalone/borrowed ownership, waiting, save/HMR durability, unsupported errors and clean disposal verified in installed packages; final scoreboard and merged commits recorded. |

A step that exceeds one reviewable concern is split without changing its acceptance criteria. Keep default-only optimization separate from WAL correctness changes.

For every implementation PR:

- Run the repository’s install, prepare, both TypeScript checks, unit tests and size gate from its exclusive worktree.
- Run the affected browser matrix through the chosen fleet queue.
- Coordinate the next patch version.
- Obtain independent review of protocol/locking changes.
- Own checks, fixes and merge.
- Verify the host reports the PR merged and record its merge commit.
- Verify post-merge CI and the matching consumer delivery.

New copied or adapted upstream implementation requires a classified overview row and section in `docs/bun-patches.md`, with exact revision, upstream path, license, local changes and reasons. Distinguish original Waffle adapters. New code is TypeScript; do not check in generated JavaScript or binaries.

## 11. Consumer changes

### bun-wasm web

Update `../bun-wasm/web/src/main.ts`.

- Replace the current two-value storage query mapping with explicit VFS selection.
- Preserve IndexedDB default, workspace name and saved data.
- Display opening/waiting separately from failure.
- Resume automatically on ready.
- Display typed unsupported selection instead of quietly falling back.
- Preserve ownership-loss and unsaved-text handling.
- Await owner disposal before replacing a runtime.

Update `../bun-wasm/web/tests/browser-filesystem-lifecycle.ts`: the old immediate-refusal/reload expectation becomes waiting and automatic readiness after release.

### bun-wasm sandbox

Update `../bun-wasm/sandbox/src/main.ts`.

Preserve:

1. Write the file.
2. Await the required targeted durability barrier.
3. Notify HMR.

Do not send a memory-only successful save through HMR as though it were durable. Do not replay file contents through HMR as a storage mechanism.

Keep the template-specific workspace names and IndexedDB default. Add waiting and typed failure handling.

### bash-web

Use fetched current source, not the stale local checkout. Update `../bash-web/src/browser/main.tsx`.

- A standalone host may select the VFS when it creates its runtime.
- An embedded shell borrows the supplied runtime and must not override its filesystem, create another runtime or dispose its owner.
- Preserve `acquireRuntime` lease ownership and idempotent cleanup.
- Await filesystem readiness before starting the shell’s active startup timeout, or explicitly separate storage waiting in `../bash-web/src/browser/session.ts`.
- A legitimately waiting workspace is not a failed shell startup.

Update the exact peer/development pin, lockfile, source lock and package installation policy together. Preserve worker-asset generation and installed-package tests.

Across both consumers, pin actual merged Waffle commits. Do not add compatibility handling for an old worker, cached page or old API shape.

## 12. Resource ownership and cleanup

Install teardown before launching a test or benchmark.

Record pre-existing resources and task-created resources on every host:

- Processes and descendants.
- Browser contexts/profiles/workers.
- Local servers and ports.
- OPFS probe files and benchmark workspaces.
- Transferred source, guest fixtures and binaries.
- Scratch directories.
- Temporary reservations.

On success, failure, timeout and interruption:

1. Stop task-owned consumers.
2. Close handles and release locks where graceful teardown is possible.
3. Terminate remaining task-owned descendants.
4. Remove task-created profiles, storage fixtures, transferred binaries and scratch.
5. Verify cleanup on the actual execution host.

Never prune shared caches or pre-existing resources.

Retain only small result summaries and a minimal reproducible experiment under `../../reports/waffle-vfs/`. Every retained artifact needs its size, reason, cleanup owner and removal condition. No abandoned browser profile is a benchmark result.

## 13. Owner questions

Execution does not wait for these unless the owner changes the stated defaults.

1. **Safe boot interpretation:** proceed with “write-through, slower, cross-browser”; do not assume eager loading. Is “slow boots” specifically a requested trade-off, or only a description to verify?
2. **Default IDB acknowledgement:** preserve today’s memory ACK plus explicit durability barrier. Should a later measured winner instead make every ordinary mutation durable before ACK?
3. **Memory-first lag:** start with the current nominal checkpoint interval and benchmark bounded batching. Is there a desired dirty-byte or persistence-lag target beyond the explicit `flush` guarantee?

## References

- [wa-sqlite VFS examples, pinned revision](https://github.com/rhashimoto/wa-sqlite/tree/6238f532b399de77fd5f141f6e3776aeb24b2f04/src/examples)
- [OPFSWriteAheadVFS, pinned revision](https://github.com/rhashimoto/wa-sqlite/blob/6238f532b399de77fd5f141f6e3776aeb24b2f04/src/examples/OPFSWriteAheadVFS.js)
- [WriteAhead log implementation, pinned revision](https://github.com/rhashimoto/wa-sqlite/blob/6238f532b399de77fd5f141f6e3776aeb24b2f04/src/examples/WriteAhead.js)
- [Chrome: multiple readers and writers with sync access handles](https://developer.chrome.com/blog/new-dev-trial-for-multiple-readers-and-writers)
- [WHATWG File System standard](https://fs.spec.whatwg.org/)
- [IndexedDB persistence introduction](https://github.com/ShaulLavo/waffle/commit/037d35e86fd5b0b93e98e174cfac4991fbbd929f)
- [OPFS storage introduction](https://github.com/ShaulLavo/waffle/commit/c841b91abe86a0213a3cf1beff46d45ad58bdc48)
- [Ownership and Safari reload changes](https://github.com/ShaulLavo/waffle/commit/538796963d3751911611330475c37a84d5067970)

## Step 1 harness execution

Status: **Approved**. The TypeScript harness implements the fixed v1 traces; it
changes no storage implementation. `tooling/vfs-score-config.ts` freezes equal
primary-metric weights within each workload and equal browser/workload/lane cell
weights within each VFS. Family weights are equal across the four VFSs. Unsupported
assertions remain mandatory even though their cells have no performance weight.

Run screening on the reserved `upcloud-4` host, never a different host substituted
into the same baseline. A campaign has two warmups and five measured repetitions
per selected cell. Split its three browser selections into separately admitted
exclusive bench jobs if needed to respect the one-hour execution fence; use the
same campaign ID and immutable revision, retaining each browser's manifest.

The harness derives its revision from a clean Git HEAD. For dispatcher archives,
stage a Git bundle of that same commit, reconstruct its Git index as documented in
the fleet skill, and ignore only the staged bundle itself in `.git/info/exclude`.
The harness also checks the dispatcher's adjacent `manifest.json`; mismatched
source, edited source and untracked source are rejected before browser launch.
There is deliberately no command-line revision label.

```sh
bun tooling/vfs-benchmark.ts --campaign CAMPAIGN --output EXTERNAL_DIRECTORY \
  --browsers chromium --workloads W1,W2,W3,W4,W5 --lanes host,guest
bun tooling/vfs-benchmark.ts --extract DISPATCHER_GATE_LOG --output EXTERNAL_DIRECTORY
```

Keep the dispatcher log and manifest alongside the extracted `samples.json`,
`events.jsonl` and `summary.json`. Extraction refuses to overwrite existing evidence.
The log includes observed W4 acknowledgements, fixed environment invalidations and
all warmup/measured failures. Failed warmups disqualify correctness, not merely
performance statistics. Sampled process-tree RSS is a lower-bound process metric,
not unique physical memory. Resident payload end snapshots are not high-water
marks; closed-profile allocated/logical growth is not device-write amplification.
Dirty persistence lag is explicitly unmeasured until storage exposes it.

Promotion requires a paired accepted-reference source tree, the immutable initial
samples and the previously accepted summary. These are distinct inputs; initial
normalization and the best-score ratchet never reset to the new paired run.
Both source trees must have identical workload, browser adapter, guest fixture,
configuration, controller and shared runner lifecycle. Three warmups and nine
adjacent pairs alternate order; the comparator retains paired intervals and the
IndexedDB five-percent upper-bound guardrails.

```sh
bun tooling/vfs-benchmark.ts --mode promotion --campaign CAMPAIGN \
  --output EXTERNAL_DIRECTORY --candidate-root CANDIDATE_CHECKOUT \
  --initial-baseline INITIAL_SAMPLES_JSON --accepted-summary ACCEPTED_SUMMARY_JSON
bun tooling/vfs-score.ts INITIAL_SAMPLES_JSON CANDIDATE_SAMPLES_JSON \
  PAIRED_ACCEPTED_SAMPLES_JSON ACCEPTED_SUMMARY_JSON
```

The current guest lane is an original precompiled Wasm forwarding fixture driven
by TypeScript through actual preview1 calls, not a C/libc/application benchmark.
Guest namespace barriers additionally request the production global host flush;
directory `fd_sync` alone is not represented as flushing every file payload.
W5 uses four actual pages on one workspace, asserts queued waiting/FIFO ownership
and durable marker recovery, then separately measures IndexedDB default takeover
and rejection of operations from each revoked owner. No exclusive-backend number
is labeled simultaneous throughput. The future WAL trace remains unmeasured until
its protocol exists. Capacity failures retain the unchanged exact workload rather
than shrinking it or changing storage limits in this measurement-only step.

W1 retains three IndexedDB profile states separately: a fresh browser profile
with no database, an existing browser profile with its empty diagnostic database
deleted before relaunch (first visit), and a preserved seeded profile with an
existing database. Each sample records its state and raw production startup
milestones. `indexeddbOpenMs` is requested-to-resolved database open;
`treeReadyAfterIndexeddbMs` is the later ownership/recovery/tree-ready interval.
Fresh and first-visit fields are separately prefixed and are never averaged into
the seeded-reopen primary score. If added after an immutable screening campaign
has begun, capture this decomposition in a separately identified W1 campaign and
retain the earlier evidence unchanged; do not infer missing timings from totals.

Run each browser selection through its own dispatcher, independently of the chat
or shell caller's lifetime. Task-owned transient controller services may wait for
another selection's terminal marker before submitting; that local wait is outside
the next dispatcher's admission deadline. Give every dispatcher its own deadline,
immutable source bundle and terminal status. Completed browser selections are not
run again. A cancelled admission or truncated selection remains incomplete in the
campaign ledger, with its original log retained; a terminal marker alone is not a
successful measurement. Verify the dispatcher's status, required samples and actual
host cleanup before extraction. Stop and remove only task-created controller units,
bundles and scripts once their consumers finish; keep the immutable result ledger.
