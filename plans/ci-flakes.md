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

Focused validation and PR are recorded below when complete. Probe patch and exact logs
are retained outside the repository at
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
