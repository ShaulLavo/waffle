# WebKit COOP navigation workaround

Playwright 1.64.1 uses WebKit 2370, which contains
[WebKit 325840](https://bugs.webkit.org/show_bug.cgi?id=325840).
The network process can request a COOP process swap before the UI process handles the
old web process's load-start message. That late message cancels the same navigation's
provisional page. Playwright can then lose the cancellation and wait until its original
navigation timeout.

`tests/browser-navigation.ts` installs a one-use request route for the target document
on WebKit. The route immediately falls through to the existing handlers and real network.
Processing its interception message orders the old process's load-start IPC before the
server can answer and trigger the COOP swap. It does not synthesize a response or retry a
navigation. The root response, COOP/COEP headers, contexts, assertions and navigation
options stay with their original callers. Routing temporarily disables WebKit's HTTP
cache while that one request is admitted; the registration is removed before fixture
evaluation. Chromium and Firefox use their original navigation path.

The native `browser-navigation-browser-runner.ts` checks request admission at the real
server, cross-origin isolation, HTTP errors, existing abort handlers and persistent
WebKit contexts. `browser-navigation.test.ts` guards fixture migration and original
timeout/error propagation. The standalone root-navigation diagnostic intentionally
continues to exercise the unmodified engine.

## Remove after the official engine fix

Status: Approved. Owner: Waffle browser harness.

When a supported Playwright release contains
[WebKit PR 75569](https://github.com/WebKit/WebKit/pull/75569), verify its WebKit source
revision includes the same-navigation cancellation guard. Upgrade Playwright through
the normal PR path, remove the WebKit interception branch, and replace the admission
ordering assertion with a regression for the fixed native navigation. Run the complete
serial suite and the retained fresh-context COOP stress reproducer. Keep every original
fixture assertion and timeout.

November 6 evidence and the rerunnable migration/stress drivers are in
`/work/reports/wave-20261106/webkit-navigation/RESULT.md`. The separate guest-watch
notification stall happens after fixture evaluation starts and is not this engine bug.
