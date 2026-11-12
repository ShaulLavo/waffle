# Late Console control boundary

Status: Approved task, stopped at a fixture authority boundary. No late control is qualified.

## Observed blocker

The owned HTTP fixture cannot release a successful response after provisional body success.
`fixtureResponse` in `tests/page-runner/suite-host.ts` calls `Collector.admitFixture` before
and after awaiting the fixture handler. The latter requires the case outcome to remain
`running` and the document to remain incomplete. Both conditions exclude the requested late
phase, even while the Console observer is still active and its cutoff has not started.

A scoped experiment at input `2bcc4faab6d3d169f611f5aa7a4efe4936927fdc` confirmed the order
`gate-arrived`, `body-pass`, `settle-entered`, `gate-released`. Chromium received HTTP 410
instead of the gated response. Its first Console error was that resource failure; the exact
late marker never arrived. This is failed control construction, not a production Console
regression. The experiment has been removed from source.

## Smallest required contract

Distinguish admitting a new fixture request from completing one already admitted. Keep new
requests restricted to the exact running case. Permit an already admitted response to
complete while that same document has a provisional passing outcome and has not retired.
Cancellation, document replacement, a failed outcome and retirement must still reject it.
Retain the existing run ownership, abort handling and callback join requirements.

This extends fixture response authority and needs the coordinator's design disposition
before implementation. Do not bypass the second check or decorate collector state to
pretend the case is still running.

Once that contract is accepted, the four independent controls can release their existing
owned HTTP gate around the public `settleConsole` method. Before-cutoff controls release
after the policy accepts the actual body, require real marker delivery, then call the original
cutoff. After-cutoff controls first await the original cutoff, then release and require real
marker delivery while the frozen summary stays clean. Any reducer decoration must call the
original reducer first and record the exact page or worker context. Restore decorations and
abort every held fixture phase during teardown. Every wait must honor the remaining original
control budgets.

The original nine bodies, checks, budgets and default/selected CLI remain unchanged. Their
individual native evidence does not qualify the separate failed nine-command native session
creation run. Native late controls and independent review remain coordinator work.
