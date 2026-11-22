# Browser workaround evidence

Each entry identifies an active workaround, the environments that needed it, and the evidence
required to remove it. Versions identify recorded runs. Unmeasured environments have unknown
scope. Linux Playwright WebKit, shipped macOS Safari, iOS Simulator Safari, and physical iPhone
results are separate. [Tracking issue](https://github.com/ShaulLavo/waffle/issues/303).

**Reproduced** means a recorded run observed the behavior. A browser defect requires an isolated
control. **Suspected** marks a proposed explanation awaiting proof. **Reported** means an upstream
report exists. **Fixed** names the layer where the correction landed. **Retired** means Waffle
removed the workaround after its removal check. An active workaround can fix a Waffle symptom
while the underlying behavior persists.

## Guest watch loses a wake after a quiet write

- **Site.** The notification relay uses reusable blocking wait Workers for guest watch forwarding.
  [Relay](../packages/waffle/browser/notification-worker.ts) and
  [blocking wait](../packages/waffle/browser/notification-blocking-wait.ts).
- **Evidence.** Reproduced on Linux with Playwright 1.64.1, WebKit 2370 (27.2). Native
  `Atomics.notify` returned 1, but the relay's `Atomics.waitAsync` promise stayed pending. An
  isolated native Worker resumed after an unrelated message, without a second notify. The pinned
  WebKit source locates the gap between checking timers and registering the timer wake callback.
  Waffle fixed the relay in PR 375. The old relay stalled at handoff 13,889. The fixed relay passed
  200,000 handoffs and 200 fresh guest-watch contexts. The unchanged watch also passed on
  Chromium 156 and Firefox 157. The Linux distribution and exact versions for those two controls
  are unknown. Scope on macOS Safari, iOS Simulator Safari, and physical iPhone is unknown.
  [Reproduction and engine revision](browser-runtime.md#serial-guest-watch-notification-stall),
  [relay fix](https://github.com/ShaulLavo/waffle/pull/375), and
  [handoff runner](../packages/waffle/tests/notification-race-browser-runner.ts).
- **Cost.** Up to three reusable blocking wait Workers per guest. The relay remains event-driven.
- **Removal check.** Before switching back to native async waits, repeat the isolated handoffs
  and real quiet and socket-ordered watch writes with the workaround disabled on supported
  affected engines. Require each successful notify to settle without an unrelated message and
  the guest to receive the notice. Retain the blocking-worker path as a positive control.

## Worker termination and shared-page reuse

- **Site.** For applicable process Workers, the broker selects SIGKILL and waits for a running
  guest's unwind report before native termination. An individual stop with live siblings closes
  its exact wait record without adding a wake. After native termination has been attempted for
  every admitted agent and pending admissions have resolved, the owner irreversibly seals the
  group, closes current and retired wait records, and notifies their pending addresses. This
  wake can occur before cleanup completes. [Broker](../packages/waffle/browser/process-broker.ts),
  [group owner](../packages/waffle/group/state.ts), and
  [group lifetime contract](../docs/memory-groups.md#lifetime-and-physical-stop).
- **Evidence.** Reproduced on the Linux PC with Playwright WebKit 27.2, Chromium 156.0.8078.4,
  and Firefox 157.0. Reuse immediately after `Worker.terminate()` let a busy Wasm guest write
  into a sibling's pages on all three engines. The Linux release and Playwright package version
  are unknown for this record. C4D2 iPhone Simulator Safari 26.5 on iOS 26.5
  (WebContent 8624.2.5.10.4) reproduced the busy writes in 24 of 24 no-gate controls.
  Its terminated untimed sleepers held their Web Lock past the 30-second cap in 3 of 3 runs.
  The matched Linux WebKit sleepers released it in 3 of 3 runs. A Bun 1.4.4 Linux control stopped
  the parked Worker promptly and the next one-count notify reached the live sibling.
  Shipped macOS Safari and physical iPhone scope is unknown for these probes.
  [Parked waiter evidence](group-futex-retirement.md#problem),
  [busy-member evidence](group-futex-retirement.md#gap-1-a-member-running-guest-code-when-terminated),
  [reuse runner](../packages/waffle/tests/running-member-reuse-browser-runner.ts), and
  [broker stop runner](../packages/waffle/tests/stop-order-browser-runner.ts).
- **Separate crash observation.** Terminating a polling guest could crash a Linux WebKit page.
  The broker now allows a guest that polls to unwind first. The iOS 26.5 simulator had no page
  crash in 60 direct polling stops or 120 broker stops. A remaining direct Linux WebKit crash
  after the exit report has unknown cause. The serial CI page losses have their own evidence.
  [Stop-order controls](group-futex-retirement.md#gap-1-a-member-running-guest-code-when-terminated)
  and [CI triage](ci-flakes.md#webkit-drops-in-the-browser-serial-job-2026-11-11-to-2026-11-21).
- **Cost.** A non-polling guest can consume the one-second unwind cap. Busy exits remained
  unproved through the 60-second observation cap on Linux WebKit and the iOS simulator,
  withholding pages. On the simulator the guest kept a core busy until the tab closed.
  Group teardown can wake a raw waiter, which must recheck its condition.
- **Removal check.** Test each affected browser with and without the stop-order mitigation.
  Require the page to survive the polling stop. Before removing the teardown-only wake,
  prove actual exit without it, no writes after page reuse, and a live sibling receiving
  its intended notify. Preserve native wake counts and the safety proofs in every case.
  Pages may be reused only after physical stop and cleanup of the exact incarnation and
  either its closed parked-wait record or proof that its thread exited. A failed cleanup
  retains the member's debt.

## Filesystem backing on demand

- **Site.** The fixed filesystem root includes segment zero at construction. The other
  95 segments get fixed 16 MiB backing individually on first use. PR 461 replaced the
  95 eager empty growable segments. The ledger still charges the advertised extra capacity
  as one promise, with no backing for unused extra segments.
  [Allocator](../packages/waffle/fs/shared.ts),
  [segment constructor](../packages/waffle/fs/protocol.ts), and
  [reservation contract](../docs/shared-memory.md#size-for-safari).
- **Evidence.** The examined Safari WebKit 7624.2.5 branch reserves address space for the
  declared maximum of a growable shared buffer. Exact correspondence to the simulator binary
  is unknown. A separate native Wasm constructor control on C4D2 iPhone Simulator Safari 26.5
  on iOS 26.5 (WebKit 8624.2.5.10.4) reproduced stronger allocation pressure with larger
  declared maxima at one 64 KiB page per memory. Single-memory growth controls reached
  384 MiB. Those observations cover shared Wasm memory constructor pressure. Native fixed
  versus growable shared-buffer measurements, resident memory, and a physical iPhone result
  for the filesystem change are unknown. The durable internal results are under
  `/work/reports/goals/iphone-memory-ceiling/` in `probes/RESULT.md` and
  `runtime-audit/RESULT.md`. [Waffle change and test evidence](https://github.com/ShaulLavo/waffle/pull/461)
  and [empty-tree and blocked-guest controls](../packages/waffle/tests/filesystem-lazy-backing.test.ts).
- **Cost.** A Worker missing a new segment uses the owner request path until it receives the
  attachment. A synchronously blocked Worker can continue on that path.
- **Removal check.** Keep lazy allocation. Retire the Safari-specific rationale when matched
  zero-length growable and fixed-buffer controls show the declared maximum no longer consumes
  upfront reservation on supported Safari targets. Record native macOS, iOS Simulator, and
  physical iPhone separately and check first use and same-page disposal.

## A sleeping Worker stops collection in other Workers

- **Site.** On WebKit, `atomicsWait` wakes the first seconds of a sleep at growing intervals and
  allocates a little, and a process Worker installs the same function as its realm's
  `Atomics.wait`.
  [Wait](../packages/waffle/proc/intrinsics/wait.ts) and
  [behavior](../docs/webkit-blocking-waits.md).
- **Evidence.** Reproduced with Playwright 1.64.1, WebKit 2370 (27.2). On GitHub-hosted Ubuntu
  26.04 runners with four cores, bun-wasm's storage scenario stalled in 4 of 31 unmodified runs:
  a late `/bin/node` child of Vite's bundler stopped at `instantiating`. Native stacks of the
  four stalls agree. The child is inside `Wasm::Memory::tryCreate`, waiting on the synchronous
  collection WebKit runs once eight fast memories are live. Its collector thread waits in
  `SlotVisitor::drainInParallelPassively` with no timeout, and all three marking helpers are
  parked in another cycle. Twelve of thirteen sleeping Workers were in JavaScript
  `Atomics.wait`. An isolated page reproduces it on the Linux PC without Waffle: 12 of 21 runs
  stalled with native waits and 0 of 22 with waits that wake and allocate. It also reproduced
  with eight visible cores (3 of 8). The same scenario ran about 200 times on the Linux PC
  without a stall, so the full scenario's timing matters. Chromium 156 and Firefox 157 passed
  the same scenario in CI throughout. macOS Safari, iOS Simulator Safari and physical iPhone
  are unmeasured; iOS allows fewer fast memories, so the synchronous collection is more
  frequent there. Reported: no. The diagnosis and archives are in
  `/work/reports/waffle-20261121/webkit-storage-start/RESULT.md`.
  [Runner](../packages/waffle/tests/sleeping-collector-browser-runner.ts).
- **Cost.** A sleep wakes eight times in its first four seconds, at 16 ms and then doubling
  intervals, and allocates about 32 KiB each time. A wait that is notified within 16 ms is
  unchanged. A notify that lands in the microseconds of a wake reads as `"not-equal"`, or is
  missed when the value did not change. Waffle's own words always change first. Guest
  JavaScript in a process Worker gets the same wait and the same caveat.
- **Gap.** Guest futexes (the group `futex_wait` and supervised Wasm waits) keep the native wait
  for its exact queue semantics, and a Wasm guest that parks with `memory.atomic.wait32` cannot
  be wrapped. Both can still hold the helpers. Guest-instantiated Wasm past the fast-memory
  limit takes the same synchronous collection.
- **Removal check.** Run the sleeping-collector runner on each supported WebKit. Remove the
  wrapper when its native-wait control no longer stalls across repeated runs on an engine that
  includes a fix, and the bun-wasm storage scenario passes a long hosted loop without it.

## Fixed views of growing Wasm memory

- **Site.** `memoryViews()` attempts `toResizableBuffer()` where allowed. If it is absent
  or throws, the helper reacquires `memory.buffer` and rebuilds views when its identity
  changes. Callers that forbid conversion use the same refresh path by contract.
  [View helper](../packages/waffle/core/memory-views.ts).
- **Evidence.** Compatibility behavior. Bun Worker controls grow real shared Wasm memory
  from another agent and compare fixed views with kept growable ones. The unshared
  `grow(0)` control proves detachment at unchanged length. It covers a different case
  from the [receiving-worker hypothesis in issue 306](https://github.com/ShaulLavo/waffle/issues/306).
  The browser versions and OS that lacked conversion or threw are unknown, as is the scope
  of that hypothesis in Waffle. [Kept-view change and results](https://github.com/ShaulLavo/waffle/pull/528),
  [view tests](../packages/waffle/tests/memory-views.test.ts), and
  [other-agent growth control](../packages/waffle/tests/fixtures/stable-memory-reader.ts).
- **Cost.** A buffer getter for each fixed read. The cached byte view and DataView also check
  buffer identity and rebuild on change.
- **Removal check.** Retire the optional fallback when all supported engines safely convert
  every conversion-enabled memory shape that Waffle uses. Repeat shared growth across an
  actual receiving Worker and verify new-range access, bounds, and unshared detachment.
  Keep the conversion-forbidden contract and its controls.

## COOP navigation in Playwright WebKit tests

- **Site.** `navigateTestPage()` installs a temporary exact-URL route for the real document.
  The handler falls through to existing handlers and the network. It is test infrastructure.
  [Navigation helper](../packages/waffle/tests/browser-navigation.ts).
- **Evidence.** Reproduced before fixture evaluation on Ubuntu with Playwright 1.64.1,
  WebKit 2370 (27.2). The Ubuntu release is unknown. The fresh-context control recorded
  the provisional page being cancelled before the document request was reported.
  The routed control passed 2,500 navigations.
  Reported as WebKit 325840 with a proposed upstream fix. Actual macOS and iOS Safari scope
  is unknown. [Waffle results](https://github.com/ShaulLavo/waffle/pull/374),
  [WebKit report](https://bugs.webkit.org/show_bug.cgi?id=325840), and
  [upstream patch](https://github.com/WebKit/WebKit/pull/75569).
- **Route follow-up.** PR 572 replaced a predicate that made Playwright intercept every
  request. Two hosted bootstrap controls failed while an arrival reply coincided with
  route removal. The exact Playwright failure mechanism remains suspected. The unchanged
  control failed to reproduce it in 275 local runs. The exact-URL route is the Waffle
  correction. [Route change](https://github.com/ShaulLavo/waffle/pull/572) and
  [serial CI evidence](ci-flakes.md#webkit-drops-in-the-browser-serial-job-2026-11-11-to-2026-11-21).
- **Cost.** One intercepted document request. Playwright temporarily disables HTTP caching
  while the route is installed.
- **Removal check.** Verify that a supported Playwright build contains the upstream
  same-navigation fix. With the route disabled, run the retained fresh-context COOP stress
  control and complete serial suite. Preserve isolation checks, real response and abort
  outcomes, and the missing-arrival control.
  [Navigation removal procedure](../.internal/webkit-navigation.md#remove-after-the-official-engine-fix).

## Reservation and thread qualification

[Named workload qualification (#284)](https://github.com/ShaulLavo/waffle/issues/284) owns broader
workload and device measurements. See the [thread runner](../docs/threads-runtime-runner.md)
and [reservation measurements](../docs/reservation-defaults-later.md) for the respective scope.
[Waffle PR 272](https://github.com/ShaulLavo/waffle/pull/272) is closed as superseded.
Omitted `sharedMemory` still selects the unbounded default on every engine, with no browser
classification or startup probe.
