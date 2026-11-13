# Worker lifecycle and publication command

Status: Approved. Bindings implemented and source reviewed. The cross-tab native final-exclusive
check has the accepted known limit below; current CI and merge remain with the parent coordinator.

Each browser observation owns immutable Worker metadata, stable identity, ordered lifecycle replay and exact-object close waits for one document generation. The original URL bridge keeps its latest-creation lookup and historical closed promises. Browser close is an ordering observation, not proof of thread joining or resource reclamation.

Page action revocation is independent of lifecycle delivery. Owned peer close enters the closing state before the window command. Matching target destruction and listing removal retain final browser events. A missing Worker event after exact close retirement is receipt-unconfirmed, not a document-close failure. Wrong generation, stream loss, unexpected navigation and missing explicit Worker termination receipts remain failures. Per-generation driver owners and collector queries retain their actual callback and query debt through cleanup.

Both complete publication modes run the unchanged fixtures through the shared page host, including their negative controls and original 180-second budgets. Source controls check exact fixture bytes, ordered labels and the extracted original desktop dispatcher. The complete cross-tab command also has a native binding; its final-exclusive limit is recorded below. Fixture bodies and test-only transforms are unchanged.

Linux desktop controls pass both modes in Chromium and Playwright WebKit. Firefox ordinary passes. Its workspace command rejects the same absolute-URL close lookup that the original desktop command rejects, because Firefox reports the relative script URL. Linux Playwright WebKit did not deliver Worker close after peer-page closure in the bounded peer control. The adapter reports that missing event instead of synthesizing it. Neither limitation is an actual iOS Safari qualification result.

The filesystem backend is excluded and unchanged. No runtime version bump or release is included.

## Cross-tab native final-exclusive limit

Status: Known limit accepted by Managing on November 13, 2026. Native investigation stopped after
the one further authorized diagnostic. The complete original command remains FAIL, 17 of 26
ordered PASS labels, exit 1, with `runComplete: true` and passing settled teardown. This is not
complete native qualification. No assertion, inventory row, budget or required check is skipped.

At source `e84a881c83d723b6a246bf7ca47113c01de26721`, the original final exclusive assertion at
`tests/publication-cross-tab-command.ts:990` returns false after the separate claimant's genuine
native termination. Existing evaluator replies record recovery peer 6, generation 0, job 5,
request 4 as `request-invoked`, `callback-null`, then `request-fulfilled`, with zero dropped,
unavailable or ambiguous page records. This establishes unavailable acquisition. It identifies no
holder and no native request or release-query error for that check.

All five observed document closes reached exact retirement. There are 25 genuine native Worker
termination receipts among 26 initialized Workers. Peer 2 Worker 9 remains receipt-unconfirmed;
that proves neither physical survival nor ownership of the unavailable lock. Its orderly guest
stop had already joined normal guard cleanup. A separate earlier `AbortError` occurs in the
intentional queued-attachment cancellation control, which then proves exclusive reacquisition.
It is not evidence of the final failure's cause.

Evidence and exact cleanup are retained in
`/work/reports/wave-20261112/ios-suites-takeover/cross-tab-final-exclusive/telemetry/native/REPORT.md`
and `LOCK-AUDIT.json` beside it. The original command remains
`bun packages/waffle/tests/publication-cross-tab-browser-runner.ts ios-safari --result <absolute-path>`
with its maintained device, FIFO and endpoint preparation and original 180-second budget.

Reopen only with supported evidence identifying the actual continuity holder or a concrete
lock-manager defect and a new execution disposition. Do not infer a holder from an absent Worker
receipt, synthesize a close, add a lock/query retry, widen a deadline or repeat this diagnostic.
