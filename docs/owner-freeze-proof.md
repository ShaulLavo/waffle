# Native persistent owner freeze proof

This tests-only Chromium scenario distinguishes a paused persistent authority from
worker death. It demonstrates short-freeze continuity and a transport-timeout cleanup
prerequisite. It does not certify production freeze recovery or automatic failover.

The production source starts at `e0ef92157dcc8ac658be30a372dffa0534c63fa6`.
Only the dedicated runner, page control, namespaced fixtures, and this document change.
The earlier [persistent authority proof](persistent-authority-proof.md) remains a
separate drained-stop and reopen test.

## What actually stops

Four independent same-origin pages have no opener. Page A starts the real
`createPersistentResidentOwner`, native IndexedDB backend, filesystem service, and
resident authority in `/owner-freeze-owner.js`. Every page attaches through the
existing private workspace protocol. No authority heap crosses pages.

The runner discovers exactly that worker's Chromium target and attaches a debugger
session. `Debugger.pause` stops its execution context, not a cooperative fixture
promise, simulated dead-writer flag, dropped reply, or delayed storage callback.
The runner requires the native `Debugger.paused` event. A separate test-only shared
counter stops changing while page D's clock advances. An ordinary worker message
probe stays pending. `Debugger.resume`, its native event, the original probe reply,
and renewed counter changes demonstrate resumption of the same worker.

The counter carries no filesystem authority. The read-only publication observer
stays inside the actual factory worker and returns copied cuts and effects. Page D
independently records BroadcastChannel request, cancel, and reply metadata without
changing delivery. Browser debugging can affect scheduling, so this proves a native
execution pause, not OS process suspension, mobile lifecycle suspension, or an
IndexedDB transaction frozen at a selected durable boundary.

## The fixed schedule and observed contract

The runner seeds `/dir/a` with `[10,20,30]`. Page B boots a real Preview 1 Wasm guest
through production worker bootstrap. Its `fd_write` calls the actual WASI bindings
and private workspace bridge, not a JavaScript substitute for a filesystem write.

During the first pause, page B appends `41` and page C renames `a` to `target`.
Page D must independently observe both outgoing requests. Both callers and the
owner probe remain pending. No matching transport reply appears while paused.
A second real persistent factory attempt on page D fails with errno 6. Native lock
inspection shows that the original target still holds its storage, bootstrap, and
continuity guards. Neither the runner nor the factory steals those guards.

After resume, the original guest write succeeds once and the rename succeeds.
A current read returns `[10,20,30,41]` under `target`, with `a` absent. Exactly two
consecutive publications remain in the same history. The runner checks the append's
byte range and metadata, both rename entry changes, their shared file identity,
and the parent metadata. These FAST receipts still say `durability: untracked`.
No durable fence was added to the ACK path.

Before the second pause, page C allocates an explicit mutation identity. During
that pause, the guest attempts to append `42`, and page C attempts an append of
`43` with that identity. Both requests cross the real three-second transport bound.
The host rejects with errno 6. The Wasm call returns errno 6 without overwriting its
count sentinel. The runner permits 2.9 to 4.5 seconds for host observation, including
scheduler slack. No successful reply appears during the pause. The owner probe is
still pending, its execution counter is unchanged, and a second factory is refused
again. A timeout has established neither writer death nor a no-effect receipt.

After the original owner resumes, this fixed native schedule has no additional
publication and no additional bytes. The explicit host identity reports `retired`.
The proof asserts these exact observations. It does not turn `retired` into a
committed outcome, nor generalize this schedule's cancellation ordering into a
no-effect guarantee for other races. There is no replay or automatic retry.
A subsequent current read and flush still work in the original history.

## The demonstrated production prerequisite

After the deadline, native execution resumes but normal cleanup does not fully
recover. The guest finishes with `cleanup-error`, not a clean exit. Page C's peer
stop reports errno 6. The original persistent owner stop reports that resident
clients must finish their original cleanup.

The causal path is bounded and visible in current source:

- `ResidentChannel.call` in `fs/publication-attachment.ts` removes a timed-out call,
  sends cancellation, and permanently sets `unconfirmed`.
- `WorkspaceBridge.stopOwned` calls `assertSettled`. A consumed late reply cannot
  clear the earlier uncertainty, so this bridge cannot finish its original stop.
- Guest bootstrap reports that failed bridge join as `cleanup-error`.
- `ResidentAuthorityServer.drainPersistentTransport` in
  `browser/publication-authority.ts` refuses owner cleanup while sessions remain.

A production follow-up must reconcile timed-out request identity, cancellation,
terminal outcomes, and the original bridge cleanup debt without authorizing takeover
from elapsed time. Its proposed production write set starts with
`fs/publication-attachment.ts`, `fs/publication-workspace.ts`, and
`browser/publication-authority.ts`, with matching focused tests. Durable receipt
continuity may require a separately reviewed design. This proof changes none of
those files and does not select transaction-fenced FAST publication.

## Run and inspect

Use an exclusive installed checkout and the execution host's canonical browser
queue. Reuse its installed Playwright Chromium. On the PC:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
OWNER_FREEZE_PORT=$port OWNER_FREEZE_REPORT=/work/tmp/owner-freeze.json \
STORAGE_SCRATCH_ROOT=/work/tmp WAFFLE_BROWSER_TIMEOUT=140000 \
bun /work/platform-production/heavy/current/run.js --class browser owner-freeze -- \
  bun scripts/browser-supervisor.ts 5000 bun tests/owner-freeze-browser-runner.ts
```

Each of eight schedule steps has a 12-second bound. The runner has a 150-second
outer deadline. The ledger retains completed, failed, and unrun steps, caller
outcomes, native debugger observations, publication effects, and teardown results.
A passing observation schedule is not a claim that the documented cleanup gap is
fixed. Raw failed schedules must be retained rather than replaced by a retry.

`--negative-control` deliberately omits `Debugger.pause`. It must fail the native
pause assertion after the first two steps. The other five steps remain unrun.
This control checks detection of a fake freeze, not a production regression.

Teardown is installed before browser allocation. It resumes any paused target,
joins every original tracked operation, attempts each peer and owner stop once,
and records unresolved joins honestly. It then closes the original pages and
requires native worker close events. A fresh audit-only page checks that all owned
locks are gone and deletes the test database. This extra page runs only after the
four-page scenario ends. Browser lifecycle cleanup and the outer supervisor retire
the browser, profile, server, and scratch even after failure. Native containment
retires the unresolved protocol resources. It does not repair their failed joins.

## Limits

The native observations use Chromium 156.0.8078.4 on Linux, with IndexedDB, on
October 23, 2026 in Asia/Jerusalem. Evidence timestamps use UTC on October 22.
The proof covers no OPFS, Safari, iOS, last-client lifecycle, unexpected death,
CLAIMED direct grant frozen inside a mutation, resumed stale epoch after authorized
replacement, SAFE, transparent durable history recovery, or endurance campaign.
No successor is authorized while the original guards remain held. There is no
stale-successor scenario to claim as certified here.
