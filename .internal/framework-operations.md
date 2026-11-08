# Bound framework operations

Status: Approved shared source unit implemented. Parent owns independent review,
final CI, merge, release and consumer qualification.

This change owns the shared framework queue, host, bootstrap, public framework
operation types, and permanent unit and synthetic DOM controls under
`packages/waffle/tests/page-runner/`. It does not change consumer registration,
original suites, clocks, native drivers, versions, or dependency pins.

The queue owns one root slot and a separate sealed lifetime for each callback.
Domain operations are root-only. Actual child callbacks and HTTP requests must
settle before success, including work admitted while a child is draining.

Ordinary viewport completion supports sequential calls. The framework's existing
iframe-only done/fail events do not correlate concurrent calls individually.
The synthetic correlation control demonstrates both promises resolving after
one provider completion while the second provider is still held.

Synthetic DOM controls and separate installed SDK controls are not a combined
admitted official-provider qualification. That consumer gate still needs the
construction-time public registrar, queued mutable-context checks, ordinary
framework event path, actual SDK callback and save joins in one admitted fixture.
No original or native execution is authorized by these controls.
