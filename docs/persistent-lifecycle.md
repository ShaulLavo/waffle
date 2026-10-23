# Persistent owner and borrower lifecycle

The persistent resident factory has an explicit owner lifetime. Borrower sessions do
not own that factory. Closing the last borrower does not stop the owner, close its
IndexedDB connection, or release its bootstrap and continuity guards. A new borrower
can reconnect to the same descriptor and history while that owner remains live.

`PersistentResidentOwner.stop()` stops admission and joins admitted work. It does
not turn a live borrower, a queued grant, or an unresolved storage operation into
successful cleanup. An unsuccessful stop retains its original promise and guards.
Native realm death is different from a successful protocol stop.

## Permanent controls

`tests/persistent-lifecycle-r2-browser-runner.ts` uses the canonical
`BrowserRunnerLifecycle` and Linux browser supervisor. It starts four independent
same-origin Chromium pages. Page A starts a dedicated worker with the actual
`createPersistentResidentOwner`, native IndexedDB storage, filesystem service, and
`ResidentAuthorityServer`. Pages B and C are borrowers. Page D observes native locks,
copied transport metadata, and read-only native saved records. No authority heap
crosses pages.

The fixed schedule checks these boundaries:

- A completed flush saves `/saved` as `[10,20,30]` in real IndexedDB records.
- Both original borrowers finish session cleanup and close their pages. The explicit
  worker owner remains live with its native storage, bootstrap, and continuity guards.
  A replacement factory is refused. Two fresh pages reconnect to the original history.
- The fixture holds one actual prepared-grant reply. Its caller reaches the existing
  three-second deadline with errno 6. Original borrower cleanup remains pending and
  retains its continuity guard. The late reply cancels the original grant, permits
  original cleanup, and changes neither the bytes nor the publication cut.
- A direct append acknowledges `90` and settles as a committed volatile FAST receipt.
  Other-page current reads see `[10,20,30,90]`. The fixture holds checkpoint delivery
  before calling native `IndexedDBStorage.persist`. Saved records still contain
  `[10,20,30]`. This deliberately selects a permitted unsaved tail without changing
  the ACK path or substituting a storage provider.
- A flush and another borrower's queued preparation overlap owner stop. Native storage
  close and guard release must not run while ownership remains unresolved.
- `Worker.terminate()` and Playwright's native worker `close` event establish actual
  worker death. Owner locks disappear, but borrower continuity guards still prevent
  replacement. Timeout and transport silence establish no death.
- Closing the remaining borrower pages retires their native guards. This is native
  containment, not a claim that their unresolved protocol cleanup succeeded.
- Explicit `reopen-v1` acceptance creates a fresh instance and history. The old cut
  reports a gap. The old mutation outcome is unknown. A stale descriptor fails with
  errno 11. Old settlement data fails under both its old token and a newly opened
  session token. Fresh reads recover `[10,20,30]`, not the unsaved `90`.
- A new append of `44`, current read, completed flush, and native record inspection
  succeed after reopen. Final cleanup observes every worker closed, no owned native
  locks, database deletion, and browser/profile/server/scratch retirement.

The factory notice remains explicit:

```text
kind: v1-new-history
durablePublicationCut: untracked
oldCapabilities: not-restored
oldMutationOutcomes: not-restored
acknowledgedTail: may-be-lost
```

## Reproduction

Run from an exclusive installed checkout through the execution host's canonical
browser queue. The fixture needs an explicit free port and installed Playwright
Chromium. The Linux payload is:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
export PERSISTENT_LIFECYCLE_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
PERSISTENT_LIFECYCLE_REPORT=/work/tmp/persistent-lifecycle.json \
STORAGE_SCRATCH_ROOT=/work/tmp WAFFLE_BROWSER_TIMEOUT=180000 \
bun scripts/browser-supervisor.ts 5000 bun tests/persistent-lifecycle-r2-browser-runner.ts
```

Each of the twelve steps has a twelve-second bound. The ledger retains completed,
failed, and unrun steps. `--negative-control` deliberately stops the explicit owner
when its last borrower closes. It must fail the retained-owner-lock assertion after
two completed steps. That control tests the oracle, not a production defect.

`bun test tests/persistent-lifecycle-r2.test.ts` checks final-session reconnect and
old-token rejection with the production authority. It also checks failure-ledger
retention. Existing [four-page coherence](persistent-authority-proof.md) and
[native freeze/resume](owner-freeze-proof.md) controls remain separate and unchanged.

## Limits

This is one bounded native Chromium schedule with fixture-only reply and checkpoint
holds. It proves no transparent failover, durable receipt continuity, automatic
successor election, or successful protocol cleanup of lost realms. Worker termination
is not a physical power cut. The schedule does not certify OPFS, Safari, iOS,
SharedWorker last-window policy, frozen CLAIMED mutation recovery, or endurance.
A completed flush preserves the selected saved snapshot. A volatile acknowledged
tail may be lost after actual authority death. No durable fence was added to every
FAST acknowledgment.
