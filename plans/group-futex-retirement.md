# Group futex retirement: release a stopped group's parked members

Status: Approved design. Managing approved D1 on November 16 only for irreversible whole-group
teardown, with admission sealed and exact generation accounting. Independent design reviews are
complete; the coordinator incorporated the bounded lifecycle corrections below from
`DESIGN-REVIEW-REVISION.md`. Implementation is authorized, followed by independent code review.
Design by Claude Opus 5.5, revised
2026-11-16 after review `/work/reports/goals/waffle-20261116/group-futex-retirement/DESIGN-REVIEW.md`.
Base: `main` at `27b03a8c519b4d48d00d3723b4ee2993d735f27d` (`waffle-v0.0.137`). Line numbers are
relative to `packages/waffle/` at that commit.

## Problem

On Safari WebContent `8624.2.5.10.4` (C4D2 simulator, iOS 26.5), `Worker.terminate()` returns while a
Worker parked in a synchronous wait with no deadline stays parked. The thread keeps its VM, so a
shared group `WebAssembly.Memory` it holds stays reserved. A wait that returns, by its deadline or
by a notify of its exact cell, lets the terminated Worker end. (Source corroboration from Safari
`7624.2.5`, `WaiterListManager.cpp` line 93; not a source match for the measured binary.)

In the Vite + React QuickJS cell on 0.0.137, one dev guest thread is parked in `futex_wait32`
(`group/member.ts:247`) on a dev group cell when dev stops. Every dev member is stopped, the
runtime has zero live groups, but the dev group's 4 GiB + 8 MiB fast slot is never released, and a
later new group's constructor is refused.

Bun 1.4.4 (JavaScriptCore) does not have this behavior: a probe on the PC showed a terminated Worker
parked in an untimed `Atomics.wait` closes promptly, and a live sibling on the same cell receives
the next one-count notify. Bun tests cannot go red for this bug.

## What is impossible, and the decision that follows

Requirements that stay in force: `futex_wait32/64` callers are woken by raw `Atomics.notify` and
Wasm `memory.atomic.notify` on their address (documented in `docs/memory-groups.md:3` and used by
`tests/memory-group-browser.ts:190-204` with `tests/fixtures/memory-group-member.c:203-213`), and
`futex_wake` wakes raw waiters; wake counts, statuses, deadlines and the native waiter queue stay as
they are; stopping one member must not wake a live sibling.

**Claim.** No portable mechanism can wake exactly one stopped member parked on address A while
another agent may also be waiting on A.

**Proof.** (1) A raw notify on A can wake a waiter only if that waiter is in A's native waiter list,
and a thread can wait on one location at a time, so every provider waiter must park natively on A
(a private cell cannot observe a raw notify, which is what the first design broke). (2) A thread
parked natively on A returns only at its deadline, on a notify of A, or by termination. Termination
fails on WebKit 8624 (measured). A finite deadline is slicing: a notify that lands between slices,
with no value change, is lost; it is excluded. (3) `Atomics.notify(A, k)` wakes the first k entries
of A's list in arrival order. That order includes raw, async and other agents' waiters, and no
portable API reads it or removes one entry. If a live waiter S arrived before the stopped member Z,
every notify that wakes Z also wakes S, and S's wait returns `ok` with no wake addressed to it.
(4) The value at A cannot be changed to release Z. So exact per-member cancellation with live
co-waiters is impossible.

**Consequence.** Stopping an individual member while other members stay live keeps today's behavior:
on WebKit 8624 the stopped Worker can stay parked until a wake at A reaches it (it can absorb that
wake, as it does on 0.0.137). Its group memory is live anyway, so this leaks no reservation. The
reservation leak happens only when the group has no live member left, and then the only agents that
can still be waiting on group memory are stopped members and non-member agents (the page or an
embedder holding `group.buffer()`). This design wakes at that point.

**D1, approved teardown-only allowance.** Only after admission is irreversibly sealed and exact
generation accounting proves no live or reserved member remains, Waffle notifies all waiters
(`count = Infinity`) on each address where a stopped member's provider futex wait is pending. A
raw non-member waiter on that address may receive `ok` without an ordinary `futex_wake`. Managing
approved that teardown-only spurious wake, requiring callers to recheck their condition. No live
member is woken, normal operation receives no extra wake, and stopping one member while siblings
remain live retains today's behavior. This approval does not authorize reversible quiescence or
reopening admission after cancellation. Document the exact boundary in `docs/host-abi.md`.

## Design

The wait itself does not change: `futex_wait32/64` keep calling captured native `Atomics.wait` on
the guest cell with the real deadline, and `futex_wake` is untouched. Raw interoperability, native
queue order, counts and statuses stay exactly as on 0.0.137. The only addition is a record of the
pending address, and a page-side wake at group quiescence.

### Per-incarnation wait record

`group/protocol.ts`: a member's private cells grow from `REPLY_WORDS` (9) to
`MEMBER_CELL_WORDS = REPLY_WORDS + WAIT_RECORD_WORDS` with `WAIT_RECORD_WORDS = 4`, laid out after
the reply words as `[epoch, addr, width, closed]`. The buffer is the existing per-incarnation
`reply` buffer that `MemoryGroupOwner.launch` already allocates (`group/state.ts:394`) through the
counted fixed-control source. That adds 16 counted fixed bytes per member incarnation (52 instead of
36), charged and refunded on the existing paths. No growable maximum, no Wasm memory, nothing in
the shared group `control` buffer, no new request field.

Each incarnation gets a new buffer, and only its own thread writes `epoch`, `addr` and `width`.
A late write by an old thread can therefore never reach a later incarnation. This is what makes
reuse safe; native `terminate()` return is not used as proof that the old thread is gone.

### Member side (`group/member.ts`)

Both widths share one helper. `epoch` is a local counter of this incarnation; its value in the
record is odd while a wait is pending.

1. `hooks.checkActive()`; existing alignment and bounds checks.
2. `atomicsStore(record, ADDR, addr)`, `atomicsStore(record, WIDTH, width)`, then
   `atomicsStore(record, EPOCH, odd)` where `odd = (epoch + 1) | 0` (parity survives int32 wrap).
3. If `atomicsLoad(record, CLOSED) !== 0`: store the next even epoch and call `stopped()`.
4. Unchanged native wait: `atomicsWait(guestView, addr / width, expected, timeout(ns))`.
5. `atomicsStore(record, EPOCH, even)`. If `atomicsLoad(record, CLOSED) !== 0`, call `stopped()`;
   otherwise return `status(result)` exactly as today.

`stopped()` calls `hooks.checkActive()` and then throws `ProcessError(SRCH, "memory group member
stopped")`; it never returns a status. Step 5 matters wherever termination does not end a woken
thread: Bun tests without real termination, WebKit 8624 (parked until a notify), and Chromium,
where `terminate()` returns while the thread is still parked or running (PR 544). A member that the
page closed never runs guest code again, unless the guest catches the throw (see "Remaining gaps"). A wake that a live member counted before the close stays
counted, like a Linux thread killed right after its futex wake. Step 3 is the stop-before-register
case.

Remove the comment at `group/member.ts:251`. The cost on the wait path is four atomic stores and two
atomic loads around a blocking call.

### Page side (`group/state.ts`)

`Member` gains private `cells: Int32Array | undefined` (absent until launch), `stopRequested`
and `waitsClosed` booleans. The response writer still writes exactly `REPLY_WORDS`, not the whole
13-word buffer. Update hand-built requests together; no old nine-word fallback is permitted.
`MemberLease` gains:

```ts
/**
 * Native termination of this incarnation's agent was requested (or attempted). Idempotent.
 * Not a stop receipt: memory, capacity, holds and pins stay until stopped() or failed().
 */
stopRequested(): void;
```

A member is **live for cancellation** while reserved, or while any unreleased agent incarnation
has not recorded its exact native termination request/attempt. This includes retained members whose
fence failed before terminate; `failed()` must never invent that request. The group is eligible for
terminal quiescence when it is not ended and has no live member. `settleStopping()` runs at the end of
`stopRequested`, of `abort` (reserved member returned) and inside `release` before the row is cleared
and before `end()`:

```text
if any member is live or an admitted reservation remains: return
if exact earlier directory/acquisition/preparation intents remain: defer and retry on settlement
irreversibly seal all new admissions for this group before any cancellation wake
for each current or retired incarnation record not already closed:
  waitsClosed = true
  atomicsStore(cells, CLOSED, 1)
  loop:
    e = atomicsLoad(cells, EPOCH); if e is even: break
    a = atomicsLoad(cells, ADDR)
    if atomicsLoad(cells, EPOCH) === e:
      decode a as unsigned, validate against the fresh buffer, notify a / 4 with Infinity; break
```

Admission state is distinct from `ended`: use `open | exec-closed(exactMember) | sealed` or an
equivalent exact representation. All actual slot insertions pass through owner `reserve`; it must
reject both closed forms. Exec rollback can reopen only its own matching exec closure, never sealed.
Already admitted reserved leases block sealing and retain their valid launch/abort paths. Cleanup,
stop, failed debt and release remain usable after sealing.

The broker supplies a synchronous terminal-admission check using exact directory identity and
version, pendingLaunches and beginPreparation state, and earlier published same-directory
acquisitions. Reuse the substantive checks from closeReplacementGroup/checkGroupIntents, explicitly
accounting for stopping incarnations. The shared directory commit linearizes earlier intents; it
does not freeze future unrelated spawns. No await, guest callback or adapter invocation occurs between
the final version check and owner seal. Deferred checks retry from exact launch settlement,
preparation settlement and earlier acquisition rejection/cancellation as well as lease transitions.
Do not poll or await unknown descendants. Do not seal a whole directory or block another group.

Before releasing a launched member's reusable slot, retain its exact private record in an owner-held
retired-record collection unless terminal cancellation already processed it. Retain only that small
private buffer/view, never the Member, lease, port, request, Memory or guest buffer. Preserve even an
even epoch because an old thread can be paused before publication. Final sealing scans current and
retired records, closes/notifies each once and drops the retired collection before end. A late lease
call cannot reinsert a released record or touch a later occupant. This intentionally retains counted
fixed bytes per retired incarnation while the group remains open; it is not bounded by live slots.
Keep collection-based ledger charges until actual collection, without a new cap or logical-release
refund. Constructor failure still refunds only its provisional reservation.

`release` also stores CLOSED=1 in the released record, without a notify, before its chunks return
to the free list (PR 544, `group/state.ts:842`). A stale thread woken later then throws instead of
resuming guest code on pages another member now owns. Final sealing still notifies the record.

`release` first sets `stopRequested` on the releasing member, so an embedder that only calls
`stopped()` still gets the wake before group end (post-stop backstop). Terminal admission sealing
must precede any wake and remain in force through cleanup debt; no later member may revive this
group. Apply the seal at every actual owner admission path and account for existing reserved and
pending admissions before deciding terminal quiescence. Existing member cleanup, accounting and
release must remain usable while sealed. Each stopped member is woken at most once. The notify
uses the current `memory.buffer` read on the page, never a cached view. Byte index `a` reaches
32- and 64-bit waiters at that address, as `futex_wake` does today. Independent review must verify
the exact synchronous owner boundary and generation accounting before implementation.

Why no wake is lost: the waiter stores the odd epoch and then reads `closed`; the page stores
`closed` and then reads the epoch. Both are sequentially consistent atomics on one buffer, so at
least one sees the other. If the waiter sees `closed`, it never parks. If the page sees the odd
epoch, it notifies `a`; the waiter is then either parked (woken) or between step 3 and step 4.

The second case is the one residual window. It is covered only by an engine property: every member
in `settleStopping` already had native termination requested, and the engine must not park a thread
whose termination was already requested when it enters the wait. JavaScriptCore's wait loop checks
`hasTerminationRequest()` before its first condition wait (7624 source corroboration); WebKit can
defer the termination request while the worker's global scope is still being created, which is
before any guest code runs. Native acceptance arm 2 measures this on 8624; it is not proved by
source. If it fails there, the residual is reported with its measured frequency, and this plan
does not add a fallback.

Epoch identity: initialize and advance the local epoch on every entry and exit with odd/even parity
preserved across signed and zero rollover. Clear pending state in finally if native wait throws.
A thread can pass its post-wait CLOSED check just before closure and begin another publication;
its next CLOSED check must stop it. Do not assume a two-scan limit. Each incarnation has fresh
storage, and only stable unsigned address snapshots are used after irreversible sealing. No counted
wake claim or reusable ticket exists. Regress paused publications and rollover explicitly.

### Stop-time call sites (`browser/process-broker.ts`)

1. Broker children, `terminateWorker` (line 2866):
   ```ts
   let ended: void | Promise<void>;
   try {
     ended = worker.terminate();
   } finally {
     child.group?.stopRequested();
   }
   await ended;
   ```
   Termination is requested before the wake, and the wake does not wait behind a termination
   promise. A throwing `terminate()` still marks the member; `child.group?.failed()` on the existing
   failure path keeps memory and capacity charged.
2. External roots stopped by the broker: `nativeStopHandle` (line 3445) gains an optional
   exact-consumer request binding, invoked in a nested try/finally around the actual captured
   terminate call, after closeAdmission succeeds and before awaiting its result. Include adopted
   controller roots through captureControllerStop/captureConsumerStop, not only the two launch
   wrappers. Bind the native consumer allocation to its exact admitted membership when admission
   commits; never look up a current membership by bare PID at later stop delivery. An independent
   helper stop must not mark the root. Failure before native invocation must not mark an attempt.
3. External roots stopped by the embedder: `RootMemoryGroupMember` gains
   ```ts
   /** The embedder requested its root agent's termination. Call before awaiting its end. Idempotent. */
   terminating(): void;
   ```
   which closes over the exact admitted lease, like `stopped()`, not the current PID mapping.
   `stopped()` stays the post-stop assertion; its release
   backstop covers embedders that do not call `terminating()` but do reach `stopped()`. An embedder
   that awaits its parked worker's end before calling `stopped()` must call `terminating()` first;
   document this on the interface and in `docs/host-abi.md`. Matching Bun integration must forward
   exact membership termination through web/src/subprocess-broker.ts and invoke it immediately
   after the captured native terminate attempt in web/src/runner.ts, before its join, keeping
   rootStopped after success. Audit its worker-entry-observation-probe fixture. The Waffle writer
   reports the concrete interface; the consumer owner makes those separate coordinated edits.

Unchanged: the controller, filesystem fence, accepted-adapter join, exec replacement order, late
handle acquisition, cleanup debt, and the point where `group.stopped()` runs (after the full
successful native stop, which can precede the outer accepted-wrapper completion, as before). Exec
replacement keeps its existing supported sole-member-to-host contract. Preserve its exact pending
intent checks and rollback boundaries; a real admitted reservation or earlier acquisition blocks
terminal sealing. A sealed owner cannot be reopened by exec rollback.

Physical versus logical: `stopRequested` and the quiescence wake make the parked thread able to end.
Neither is a receipt that the thread ended or that the reservation was returned. Group absence,
`stopped()`, observer `terminated` and ledger rows keep their meaning.

### Documentation

- `docs/host-abi.md`, memory group imports: replace "Hard termination of the member's worker is the
  cancellation path for a blocked wait." with the D1 rule, the individual-stop limit from the proof,
  and the explicit non-claim: raw `memory.atomic.wait32/64` and guest busy loops are never cancelled
  by Waffle and, on WebKit, keep a stopped group's memory reserved.
- `docs/memory-groups.md`: one paragraph on quiescence and `terminating()` for root embedders.
- `docs/shared-memory.md`: one sentence that a terminated Worker still parked in an untimed wait
  keeps shared memory reserved on WebKit.

## Scope limits

This correction covers provider futex waits on group memory only. These other untimed provider
waits are not covered and not claimed; each needs its own owner design (review section 5 has the
source facts): filesystem request signal (`fs/client.ts:262`), pipe blocking (`proc/pipes.ts:1174`),
network call reply (`browser/net/host.ts:735`), network ring (`browser/net/ring.ts:148`, returns its
wait status), notification helpers (`browser/notification-blocking-wait.ts:53`), and untimed
`controlWait` on plain controls (`proc/control.ts:181`, process waits in `proc/abi.ts`). The
established notification-wait cancellation (`browser/notification-wait.ts`) and the thread lanes'
supervised waits keep their own paths. None of these was pending at stop in the measured product
except notification helpers, which hold small fixed buffers. Record each as a follow-up item here when
it is designed; no broad notification is added in this PR.

## Remaining gaps after PR 544 (Approved follow-up; gap 1 fixed, gap 2 accepted)

Background. bun-wasm's "Shared Browser (spidermonkey)" check (`tests/fixtures/shared-wasm-memory/
group-lane-lifetime.ts`, `churn()`: 200 workers in turn, every second one killed while parked)
crashed the Chromium 156 renderer on every run on a 28-core PC. A killed member stayed parked in
`futex_wait` after `Worker.terminate()` returned, its data and stack chunks went to the free list,
the next member got the same pages, and its `futex_wake` on the same cell woke the stale thread,
which returned `ok` into its guest on a shared stack. Instrumented, six such wakes appeared in one
run. PR 544 closes the record at release (`group/state.ts:842`), so that wake now throws
(`group/member.ts:198`). Test: `a released wait32/64 woken by the reusing member stops instead of
resuming` (`tests/group-futex.test.ts:477`), red without the store. After the fix, 0 crashes in 3
full bun-wasm SpiderMonkey shared Browser runs on 28 cores. Report:
`/work/reports/goals/iphone-memory-bounds-20261116/sm-shared-browser-crash/RESULT.md`.

### Gap 1: a member running guest code when terminated

Status: fixed (2026-11-17), with the managing chat's choice of the per-incarnation Web Lock,
split in two paths after the iOS sleeper measurement below. Reproduced first on all three engines:
every run on Chromium and WebKit, 1 in 500 on Firefox.

Fix. `release()` (`group/state.ts:834`) still returns slot, holds, pins, watches and capacity at the
stop receipt. Pages then take one of two paths:

- Parked and closed (`parkedAndClosed`, `group/state.ts:894`): after the CLOSED store the owner reads
  the wait record's epoch. Odd means the member published a wait and its read of CLOSED on the way
  out still lies ahead (all four accesses are sequentially consistent), so it can only throw. Its
  chunks go to the free list at once, as after PR 544.
- Otherwise the member may be executing. Its chunks and every region it held stay off the free list
  until the owner acquires the incarnation's exit lock (`awaitExit`), which the worker took with
  `ifAvailable` before any guest code (`holdExitLock`, `group/member.ts`, called from
  `browser/worker.ts` before `createGroupMember`). On grant the owner releases the lock at once
  when the agent sent it a request (so it held the lock and has exited); otherwise the agent may
  not have taken it yet, so the owner keeps it for the page's life and that agent refuses to
  start. Pending requests outlive group end: the owner retires the backing (to the fixed-backing
  pool in bounded mode) only once every exit is proven, so pooled memory never reaches another
  group while an old busy thread may still write it, and ordinary group ends still pool it a few ms later (parked threads
  can stay alive on pooled memory; see the `catch_all` residual below). `exiting`, `exitFailures`
  (rejected lock requests, withheld for the page's life) and `quarantinedBytes` in the group
  snapshot show the withheld memory; a group that ended with an unproven exit stays in
  `memoryGroups()` as `ended: true` with its whole backing as `quarantinedBytes`, so a 1 GiB
  bounded backing held for a killed iOS busy guest is visible. Bun has no Web Locks: there the
  owner issues no exit lock and keeps the old behavior.

Cooperative stop. `terminateWorker` (`browser/process-broker.ts`) now selects SIGKILL for the
process before every child `worker.terminate()` (publication only, no change once an outcome is
settled, skipped for exec replacement); the contract is in `docs/host-abi.md`, "Stop polling". A guest that reaches a link-loader checkpoint (`__waffle_fatal`, which
bun-wasm's QuickJS interrupt handler polls through `core_checkpoint`) or makes any host call
(`checkActive`) then throws, its thread returns to the event loop and exits, and the lock frees.
Measured with the polling variant of the regression test (checkpoint import called each pass, stop
word set right before `terminate()`): exit proven 1.2 ms after terminate (median) on Chromium,
Firefox and Linux WebKit, max 5 ms, against about 2 s on Chromium and never on WebKit without it.

Cost (known and accepted, correctness over memory). A busy guest that never polls keeps its chunks
and held regions withheld until its group ends (for a group that never ends, until the page
closes): forever on WebKit, about 2 s on Chromium, about 1 ms on Firefox. On iOS Safari 26.5 such a
guest also keeps a CPU core: on the C4D2 iPhone (report
`/work/reports/waffle-gap1-running-member-20261117/IOS.md`) a terminated busy member was still
writing at 60 s in 4 of 4 runs, its lock was never granted within 60 s (0 of 4), and the tab stayed
at 400 to 730% CPU until it was closed (a same-origin navigation did not end it). A few such
threads can also get the page closed: Playwright WebKit closed the regression test's shared page
about 1 run in 3 with four of them left spinning, which is why the test now isolates busy cases. Without the gate
24 of 24 iOS runs wrote into the handed-over chunk (first stray write median 0.15 ms after
terminate). `exiting` and `quarantinedBytes` in the group snapshot make the withheld memory visible.

Later product decision (not part of this fix): when a killed busy guest does not stop (its exit
stays unproven), the product could tell the user "a stuck program is still running; reload to stop
it". The signal is already there for group members: a group snapshot whose `exiting` stays above
zero after the stop. Check the wording on iOS first: there a same-origin navigation did not end the
thread in the C4D2 runs, only closing the tab did.

Why not gate every release on the lock: real iOS Safari 26.5 (C4D2) kept a terminated sleeper
parked in an untimed `Atomics.wait` holding its Web Lock past 30 s in 3 of 3 runs (Playwright
WebKit released it in 0.4 ms), so gating sleepers would strand their pages and 1 MiB stack on
iPhone. Sleepers cost nothing extra on any engine.

Kernel comparison. Linux frees a dying task's memory only after the task can no longer run: the
exiting thread drops its own `mm` in `exit_mm()`, and pages return to the allocator when the last
user of the `mm` drops it (`mmput()`), never when a kill is merely requested. A process killed
while blocked in `futex_wait` is woken, returns through the signal path and never re-enters user
code. Waffle cannot make a browser thread exit, so the exit lock is its stand-in for the last
`mmput()`, and the closed wait record is its stand-in for "blocked in the kernel, cannot return to
user code".

Regression test (in `scripts/test-browser.ts`):
`bun packages/waffle/tests/running-member-reuse-browser-runner.ts [chromium|firefox|webkit]`. Busy
case: right after release a keeper grows and must not get the terminated member's chunk (the group
has a spare chunk); on Chromium and Firefox the exit must then be proven and the chunk reused with
no write from the old thread; on WebKit it must stay quarantined. Polling case: the same with a
guest that polls a checkpoint; the exit must be proven on every engine, WebKit included. Parked
case: a member parked in the real `futex_wait32` is reused at once. Each busy case runs last for
its chunk size, in a fresh browser context closed right after, because its WebKit threads spin
until their page goes away (with them left in the shared page, WebKit closed it about 1 run in
3); WebKit runs 2 busy repetitions per chunk size with a 1 s proof cap. 10 of 10 WebKit runs
passed after that change. Red without the gate: 3 of 3 Chromium busy runs reused before proof and
saw the old thread's writes. The polling fixture uses its own stop word as the checkpoint, so the
real path (broker SIGKILL, then `signal(0, 4)` or `__waffle_fatal`) has no end-to-end browser
test yet; `process-replacement.test.ts` checks the broker half ("SIGKILL is selected before
terminate()").

Exec out of a group (recorded, not implemented). An acknowledged exec replacement is provably out
of guest code before its worker is terminated: the old thread throws `ProcessReplaced` out of
`waitExec` (`proc/abi.ts`), unwinds to the worker's top level, disposes its member and posts
`replaced`, and only then does `acknowledgeReplacement` reach `terminate()`. A lease flag such as
`stopped({ unwound: true })` could skip the lock for it. The payoff is small: exec needs the sole
member, so the group ends at that release anyway, and with pending exits now outliving group end
the backing is still pooled once the lock frees. The accepted cost is waiting on that idle
worker's lock (not measured on iOS). Unacknowledged exec stops (kill or cancel during exec) are
not provably out of guest code and must keep the lock path.

Evidence (measured with PR 547's version of the test, commit 56152047, whose measurement knobs
are gone). `release()` runs a few microtasks after `terminateWorker`
(`browser/process-broker.ts:3031`, `ended = worker.terminate()`, then `stopRequested()`, `await`,
`stopped()`), and `terminate()` returning proves neither thread exit nor that guest code stopped. The
tightest window is a live sibling growing right after release, not a new Worker booting. The test
admits an anchor, a busy member and a keeper in a fresh group per repetition, runs the busy
member's guest in a pure Wasm loop on its chunk (heartbeat word plus a per-repetition marker, no host
calls), terminates it, releases it (synchronously, after a few microtasks as the broker does, or after
one task), then grows the keeper into the same chunk. `takePages` zero-fills a reused chunk, so any
non-zero word after the grow was written by the terminated member. Playwright 156.0.8078.4
(Chromium), 157.0 (Firefox) and WebKit 27.2 on the 28-core PC, 1 and 4 page chunks:

| Engine   | Runs | Writes into the reused chunk | First write after `terminate()` | Guest kept running after `terminate()` |
| -------- | ---: | ---------------------------: | ------------------------------- | -------------------------------------- |
| Chromium |  200 |                          200 | median 0.1 ms, max 8 ms         | median 2006 ms, max 2008 ms            |
| Firefox  |  500 |                            1 | 0.16 ms                         | under 1 ms (first 1 ms poll unchanged) |
| WebKit   |   40 |                           40 | median 0.2 ms, max 10 ms        | still writing at the 10 s and 60 s caps |

Every hit also held that repetition's own marker word. Every release timing hit on Chromium and
WebKit; the broker's microtask delay makes no difference. Firefox's one hit came with the broker's
microtask timing.
Chromium's 2 s matches a fixed forced-termination delay: `terminate()` asks the worker to stop and
forces V8 termination only later. WebKit never stopped a terminated guest that makes no host call.
Real Safari on iOS (8624) is not measured yet; its parked-sleeper behavior (Problem section)
differs from Playwright WebKit's, so measure there before choosing. Evidence logs:
`/work/reports/waffle-gap1-running-member-20261117/`.

Design options and costs:

- Proof of exit through a per-incarnation Web Lock. The worker takes an `ifAvailable` lock
  (`navigator.locks.request`) before guest code and refuses to start without it. After terminate, the
  owner requests the same lock and returns chunks only when it is granted, then keeps holding it so
  a late start cannot acquire it. Available wherever SharedArrayBuffer is (secure contexts) in
  Chromium, Firefox and Safari 15.4+. Cost: on WebKit 8624 a terminated worker parked in an untimed
  wait keeps its context (Problem section above), so its lock and pages stay held until a notify
  reaches it, which can be group end. That retains memory on WebKit and works against the iPhone
  memory bounds. Measured (`RUNNING_MEMBER_LOCK=1`): Chromium grants the lock 2003 ms after
  `terminate()` (median, max 2007 ms), and in 0 of 40 runs did the guest write after the grant, so
  it is a sound proof there; Firefox grants it after 5 ms. Playwright WebKit never granted a
  running member's lock within 10 s or 60 s, so its chunks would stay off the free list until page
  teardown (each member's data chunks plus its 1 MiB stack). A terminated sleeper parked in an
  untimed `Atomics.wait` (`RUNNING_MEMBER_SLEEPER_CAP_MS=30000`) released its lock after 2000 ms on
  Chromium, 0.1 ms on Firefox and 0.4 ms on Playwright WebKit, so Playwright WebKit does not show
  the 8624 parked-sleeper hold; that cost is still unmeasured on 8624.
- MessagePort `close` events as the proof. Not portable; check current Safari support before use.
- Quarantine: keep released chunks off the free list for a while (or until N later releases).
  Cheap and portable, lowers the odds, proves nothing, raises the group's high-water mark.
  Measured (`RUNNING_MEMBER_HOLD_MS`): on Chromium a 1000 ms hold still hit in 24 of 24 runs and a
  2100 ms hold hit in 0 of 40; the delay rests on Chromium's undocumented 2 s constant. No delay
  works on Playwright WebKit, where the guest never stops.
- Revoke on stop through the interrupt word, so a guest that polls interrupts throws at its next
  poll. Narrows the window for interruptible guests only; still not a proof.

### Gap 2: a stale waiter can absorb a counted wake meant for a live one

Status: accepted (managing, 2026-11-16). Keep the "individual stops add no wakes" contract unless
this shows up in a real failure.

Evidence. A killed member parked on a cell in a region that live siblings still hold (held regions
are not freed) stays in that cell's native FIFO. A sibling's `futex_wake(cell, 1)` wakes the stale
thread, which now throws, and the live waiter stays parked. This existed before PR 544; only what the
stale thread does after waking changed. Not observed in tests; no frequency yet. Exact per-member
cancellation is impossible with browser APIs (the proof under "What is impossible" above: the FIFO
cannot be read or edited, and any notify that reaches the stale entry also wakes earlier live
waiters). The only mitigation is a notify-all on the released record's pending address at release.
That turns the lost wake into spurious wakes, which futex callers must tolerate, but it breaks the
documented "individual stops add no wakes" contract, so it needs an owner decision.

### Guests with Wasm exception handling can catch the stop

The stop is a JavaScript throw from the import. The link loader admits `try_table`
(`interrupt/rewriter-internal.ts:291`), and a `catch_all` handler (C++ `catch (...)` or a destructor
cleanup pad) catches JavaScript exceptions, so it would run guest code on reused pages before
rethrowing or resuming. bun-wasm's guests have no exception section today. The group-end seal path
has the same property, and so does gap 1's parked fast path: C++ built with `-fwasm-exceptions`
runs destructors in `catch_all` plus `rethrow` cleanup pads as the stop unwinds, so a WebKit
sleeper woken later (by a notify or its own timeout) would write its old stack in reused pages. Parking the stale thread forever instead would bring back the WebKit
reservation leak.

## Tests

Record the runtime in each: Bun 1.4.4 is JavaScriptCore and ends parked terminated Workers, so Bun
tests check the protocol, not WebKit's defect. Parking gates use an explicit fixture message sent
right before the wait plus the record's odd epoch, never sleeps. Run each new test 3 times.

Preserved behavior (run on base and on the change; results must match):

1. `tests/memory-group-browser.ts` and its C fixture, unchanged.
2. Raw JS `Atomics.notify` and a raw Wasm `memory.atomic.notify` (a tiny module importing the group
   memory) wake provider `futex_wait32` and `futex_wait64`, returning `0`.
3. `futex_wake` wakes raw `Atomics.wait` i32 and i64 waiters and counts them.
4. Mixed budget: raw, provider and watch waiters on one address with `futex_wake(addr, 2)`:
   result `2`, sync waiters before watches. `count 0` wakes none, `0xffffffff` wakes all.
5. Not-equal, timed-out and ok statuses for both widths, one deadline, no reset.
6. Individual stop with a live sibling: A and B parked on one address, stop A through the broker. No
   quiescence notify is issued (B still parked: its record epoch stays odd and no message arrives);
   a later `futex_wake(addr, 1)` with no value change returns `1`. On Bun, B returns `0`.

New behavior:

7. Quiescence without real termination (lease methods driven directly, Workers left running to
   simulate WebKit): A parked on X, B parked on Y. `stopRequested` on A: nothing woken.
   `stopRequested` on B: both A and B wake and throw the stop error (step 5), none returns a status.
8. A page `Atomics.waitAsync` on X at quiescence resolves `"ok"` (documents D1); one on an unrecorded
   address stays pending.
9. Stop before register: `closed` already set, the next wait throws without parking.
10. A reserved, unlaunched member blocks quiescence; its `abort` triggers the settle.
11. Release backstop: an external root lease reaching `stopped()` without `terminating()` is woken
    before group end; `terminating()` wakes it before `stopped()` while a controller awaits a pending
    termination promise that only resolves when the parked worker returns.
12. Broker order: `stopRequested` runs after `worker.terminate()` was called and before its promise
    is awaited, also when it throws or rejects; debt keeps memory and capacity; join order,
    exec replacement and `group.stopped()` timing unchanged.
13. Reuse: an old incarnation's late record writes land in its own buffer; a new incarnation at the
    same index starts with a fresh record.
14. Accounting: the 16 extra counted fixed bytes per incarnation are charged. Failed construction
    refunds its provisional reservation; logical member release does not refund a successfully
    constructed backing. Retired cancellation records remain charged until collection.
15. Irreversible seal: existing reserved or pending admission prevents cancellation; the exact last
    generation's stop atomically seals all new admissions before waking. Attempts to admit through
    a retained handle during cleanup or debt cannot reopen the group. No new or unrelated live
    member receives a cancellation wake. Cleanup and release still complete on the sealed owner.
16. Staggered retirement: release parked A while B is live, reuse A's index for C, then stop B/C.
    A's exact retired record is closed (no wake) at its release and notified only at final
    sealing, including a pause before publication and late old lease calls. End drops all retired records without guest aliases.
17. Failure-before-attempt: a retained incarnation whose fence rejects before native terminate
    blocks final cancellation. Native throw/rejection after invocation marks only that exact attempt
    and keeps debt. Cover child and adopted/external root paths.
18. Pending intents: exercise real pending adapters before launchWorker, preparations, concurrent
    directory admission stamps, retained-handle joins, and settlement retries after the last lease
    transition. An unrelated group in the directory can still admit normally.
19. Adopted root and helpers: a root controller awaiting waiter return receives exact cancellation;
    an independent helper does not. An old retained native handle cannot mark a later root group.
20. Record arithmetic: unsigned high addresses without a 4 GiB allocation, both widths, all metadata
    publication/closure interleavings, native wait throw, epoch wrap and old-buffer slot reuse.

**WebKit regression.** Playwright WebKit with `JSC_logWasmMemory=1` read from the WebProcess log, scratch
under `STORAGE_SCRATCH_ROOT`, runner-owned cleanup. One page, one group, one member parked in
`futex_wait32` without a deadline; stop the process through the broker. Arms, each in a fresh page:

- Passive (pass condition): keep no Memory, buffer, lease, request, accepted wrapper or worker
  reference in the page. Retain only scalars. After stop, the log must show the release line for the
  one group allocation before anything else is constructed or notified. Base must fail this arm for
  the right reason (no release while the thread is parked), checked on the base commit first. If
  Playwright WebKit does not reproduce the base failure, say so in the PR and leave the native
  red/green to the C4D2 acceptance.
- Destructive diagnostics, separate arms after the passive one: a raw notify of the old cell, and
  a capacity ladder. These can release the parked thread themselves and never count as a pass.

## Native acceptance on C4D2 (after review and merge, under the owner FIFO)

Built by the consumer lane from a recorded Waffle commit; no build delivery or CI output. Same
observers as the Fable report (`JSC_logWasmMemory=1`, Apple `sample`), passive observation first, scalars
only:

1. Isolated control: one group with one member parked in `futex_wait32` through Waffle's real member
   code, stopped by the broker. Release line for that one allocation after the stop, with no other
   constructor or diagnostic notify before it; `sample` shows no `WebCore: Worker` thread in
   `waitSyncImpl`. Include staggered member release before the final seal. Then, as a separate step,
   the capacity ladder is supporting evidence only.
2. Window control: through a qualified test-only seam, gate after the helper has observed CLOSED=0
   and before its captured native wait call. Retain a scalar positive receipt of that exact gap,
   then terminate and seal. Exercise both widths. If native termination ends the thread at the gate,
   report that branch without claiming a later wait entry. Refusal to park after termination is an
   explicit installed-engine acceptance dependency, not a guarantee inferred from 7624 source.
   A failure remains a measured residual; never green it with slices, polling, delays or GC.
3. Product: the Vite + React QuickJS cell passes all nine phases with no refused constructor; the dev
   group's slot is released after dev stop and before the next launch's reservation, by passive log
   and stacks. Release lines carry no pointer, so this mapping is an inference from timing, size and
   count, and is reported as such.

The other four cells stay with the separate five-cell Safari acceptance.

## Steps

1. Protocol: `WAIT_RECORD_WORDS`, `MEMBER_CELL_WORDS`, record offsets.
2. `group/member.ts`: record writes and closed checks around the unchanged wait.
3. `group/state.ts`: cells buffer, `stopRequested`, `settleStopping`, release backstop.
4. `browser/process-broker.ts`: `terminateWorker`, `nativeStopHandle` `requested`, root wiring,
   `RootMemoryGroupMember.terminating()`.
5. Tests 1 to 20, then the WebKit regression.
6. Docs as listed.
7. Verify per AGENTS.md (`quality`, `test`, `size`). Independent review, merge, release 0.0.138,
   then the C4D2 acceptance.

Estimate: about 2 to 3 agent hours for steps 1 to 6.
