# CI failures observed during 0.0.127

Status: Approved follow-up. Managing assigns a separate owner for the flake-fix pass.
Keep the original assertions and deadlines. Fix deterministic causes before changing bounds.

## Terminal input notification

`packages/waffle/tests/terminal-control.test.ts:477`, test
`input observations wake and join on data, cancellation, and lock-only release in another Session`.
CI run 43396082672, attempt 1, package job 131790440640 expected the notification sequence
to change after the wait returned success, but it remained 0. The test passed in attempt 2
and in 25 focused PC repetitions. GPU publication changes do not touch this code.

Reproduce with `bun test packages/waffle/tests/terminal-control.test.ts --test-name-pattern 'input observations wake and join' --rerun-each 25`.
Inspect the observation wake and cross-session lock release ordering. No cause is confirmed.

The terminal pass on 2026-11-13 confirmed a test ordering error, fixed in
[PR 504](https://github.com/ShaulLavo/waffle/pull/504). `InputBuffer.unlock()` stores the
unlocked token and notifies lock waiters before clearing contention and incrementing the
notification sequence. `InputObservation` waits on both words and joins the losing native
registration. Its successful lock wake can therefore return while the sequence is still 0.
The original assertion read that later sequence without waiting for its publication.

The worker fixture now pauses after the real lock notification and before the sequence
increment. With the original assertion, commit `f31046a9` deterministically fails with
`Expected: not 0`, matching attempt 1's original log. The corrected test requires a successful
observation while the lock is zero, the sequence is unchanged and no bytes are available.
It then releases the worker, joins its release acknowledgement and retains the original
sequence-change assertion. Data, cancellation and single-use assertions remain. No runtime
code or retries were added, and no deadline or bound was increased. New barrier joins use
the test file's existing bounded-wait helper.

Fail-before and pass-after use
`bun test packages/waffle/tests/terminal-control.test.ts --test-name-pattern 'input observations wake and join'`.
Exact logs and resource records are retained outside the repository at
`/work/reports/ci-flakes/terminal-order-20261113/`. Validation passed on the PC through the
shared heavy runner: 100 forced repetitions, all 165 terminal tests, the full package suite
with 8,751 passes, 188 skips and no failures, all 90 CI path tests, package preparation,
repository quality checks and bundle-size gates. The earlier 25 unreproduced repetitions
remain historical evidence. Independent review and GitHub CI are owned by the parent.

## Allocation completion before dispatch response

`packages/waffle/tests/page-runner/host-drive.test.ts:860`, test
`allocation may settle before its dispatch response but cannot return early`.
CI run 43396082672, attempt 2, package job 131818297535 expected exit 0 but received 1.
The test took 190.91 ms. The fixture uses an 80 ms case budget and 35 ms cleanup timeout;
contention is a possible explanation, not an established cause. It passed in attempt 1
and in 25 focused PC repetitions. No assertion or bound has been changed.

Reproduce with `bun test packages/waffle/tests/page-runner/host-drive.test.ts --test-name-pattern 'allocation may settle before its dispatch response' --rerun-each 25`.
The original test passed another 25 focused PC repetitions on 2026-11-13. The CI log
retains only exit 1, not the case result or failure phase, so contention remains unproved.
A deterministic probe held the logical clock at 100 ms until task completion and advanced
it to 181 ms before the dispatch response returned. The unchanged success assertion failed
with exit 1. Its case body was `{ status: "fail", error: "Error: Host setup/body timed out" }`;
teardown passed, the allocation was recorded, and the name was never returned.
This proves that accepted task completion does not override the body deadline. It does not
establish which phase expired in the historical CI run.

The fixture now holds the allocation response with an explicit promise after both reports
are accepted. The ordering test controls the clock and checks that no name returns while
that response is held. It releases at 79 ms for success and exactly 80 ms for body failure,
retaining the original 80 ms case budget and 35 ms cleanup timeout. Assertions retain the
case body, teardown, ledger, run completion and cleanup. The full suite result accompanies
any exit mismatch. Runtime code is unchanged.

Fix: [PR 505](https://github.com/ShaulLavo/waffle/pull/505). Both boundary cases passed
25 repetitions each, and all 159 host-drive tests passed. Package preparation, quality and
size checks passed. The full package-suite result is recorded in the PR.
Probe patch and exact logs are retained outside the repository at
`/work/reports/waffle-ci-flakes/allocation-20261113/`.

## GPU terminal reason selection

`packages/waffle/tests/gpu-service-failure-browser.ts:153`, through `joinedBaseline:422`,
failed on both attempts of CI run 43387453391. The message was
`GPU service failure open waiter or rings not terminal`. All terminal fields were set:
one grant selected revoked reason 4 instead of the required service reason 5.

A deterministic GPU-only regression reproduced the cause without a filesystem.
The display owner published revocation before settling exposed opens, allowing the guest
to select reason 4 first. [PR 498](https://github.com/ShaulLavo/waffle/pull/498) moves settlement
before revocation publication. Its regression and both hosted browser groups passed.
Keep the exact browser assertions. Check for recurrence after this fix, rather than classifying
the historical race as an unresolved timing failure.

Original job logs and browser protocol artifacts remain attached to the named GitHub runs.
Local reports are under `/work/reports/wasm-performance/next-speed/readlink/landing/`.

## WebKit drops in the browser (serial) job, 2026-11-11 to 2026-11-21

Survey of every attempt of the 400 CI runs created since 2026-11-09 found 23 failed
`browser (serial)` jobs. The serial group runs one runner process at a time
(`scripts/test-browser.ts`), so pages or contexts from different runners are never alive
together. No job logged a kernel OOM kill, and the only WebKit `crash` events came from one
runner, fixed below. There is no single common cause. The failures sort into these classes.

Bootstrap arrival, missing control (`tests/page-runner/bootstrap-arrival-browser.test.ts`):
runs 44458468086 (job 135341119555) and 44863392930 attempt 2 (job 136729953309) failed
inside Playwright with `Object with guid response@... was not bound in the connection`,
an uncaught error from a context `response` or `requestFinished` event. Only the missing
control sends its arrival reply (410) while the navigation is still removing the WebKit
COOP admission route. That route used a predicate. Playwright cannot serialize a predicate,
so it intercepted every request on the page and reported the arrival fetch to the client.
The admission route now uses an exact-URL RegExp that Playwright matches in its server,
so other requests are no longer intercepted and reported. 275 runs of the unchanged missing
control never reproduced the error on the PC, including six concurrent copies on one core, so
the exact Playwright mechanism is unproven. Gating the 410 on navigation completion instead brought back the keep-alive
script-probe timeout (6 of 30 runs on one core), so the test keeps its `Bun.sleep(1)`.
Run 43897086084 (job 133411378090) is that earlier timeout.

Running member reuse, WebKit page crash during `runningMemberReuse` with 4 pages
(`{"engine":"webkit","crash":true}`, then `Target page, context or browser has been closed`):
runs 44379349283, 44451516070 and 44459103051, all before PR 550 moved the busy case into a
fresh browser. No recurrence since.

Browser controls, `tests/page-runner/browser-controls-runner.ts webkit --prepared`, one
control each time, all different:

- peer-storage, `collector-failure`, `AbortError: The connection was closed.` on the
  `indexeddb: contested open waits and reads flushed data` group: run 44863392930 attempt 1.
- canonical-ownership: `Process browser resource closure did not settle during teardown`,
  twice, from `process-recycling-browser-runner-control.ts:20`, through the 5 s
  `BrowserRunnerLifecycle` cleanup cap: run 44150624471 (job 134281761723).
- worker-capability-in-flight-loss: jobs 132073113045 and 131228509004 deliberately
  navigated away while the registration settlement was held. Both then reported an
  unconfirmed registration and hit `script probe timed out` during independent cleanup
  verification. The deliberate navigation is part of the control. The logs do not
  establish a browser page closure. [November 13 job](https://github.com/ShaulLavo/waffle/actions/runs/43479634957/job/132073113045) ·
  [November 12 job](https://github.com/ShaulLavo/waffle/actions/runs/43231333992/job/131228509004)

  Linux WebKit 2370 reproduced the failure in the worker-capability control family on
  one CPU core. The verification document had already read the root worker identity.
  It blocked while unregistering fixture workers, with its page open and browser
  connected. The verification document now reads the registration map and identities.
  Its disposable browser context owns teardown, and the control requires confirmation
  of both session and browser closure. The verification page rejects any added call to
  `unregister()`. The finish document still exercises the actual cleanup logic, and the
  in-flight control still requires an unconfirmed registration attempt.
- framework-extra: `Registered framework context closed timed out`
  (`page-runner/framework-host.ts:732`): run 43394478779.
- host-deadline-teardown: `Body timeout extension changed the independent teardown clock`
  (`page-runner/host-drive-controls.ts:146`): run 43072689064.

The link runner hit `evaluate: Target page, context or browser has been closed` in
run 44729859695, attempt 1. Navigation returned before evaluation began. The runner had
no listeners for Playwright's `close` or `crash` events, so the error does not identify the
lost target. Run 44132865705 failed the `group cleanup` assertion on a branch that checked
the group without waiting for its exit-lock proof. Linux WebKit 2370 passed 24 ordinary
link runs and another 24 on one CPU core. [Link failure](https://github.com/ShaulLavo/waffle/actions/runs/44729859695/attempts/1) ·
[Group cleanup failure](https://github.com/ShaulLavo/waffle/actions/runs/44132865705/attempts/1) ·
[PR 548](https://github.com/ShaulLavo/waffle/pull/548)

Others were branch-specific or appeared only once: process-recycling
`stale checks leave the entire directory untouched` (two runs on one branch,
43672756188 and 43676204297), publication-cross-tab (43609712880, 43203653200),
storage (43976877773), asset-load-recovery (44712567168), notification-fairness
(44451516070).

The canonical-ownership failure only recorded two expired resource-close waits. The
framework-extra failure recorded a different wait, `Registered framework context closed`,
after the fixture's WebDriver session deletion succeeded. Compare those waits with the
native process start and exit records before changing a hang cap. The link runner now
records its navigation or evaluation phase, page events, and WebKit stderr. If evaluation
reports a closed target while the page stays open and the browser stays connected, collect
`DEBUG=pw:protocol` for that runner and look for the active WebKit target's destruction or
provisional target commit.
