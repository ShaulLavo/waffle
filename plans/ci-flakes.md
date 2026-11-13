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
