# Bound framework operations

Status: Approved, implementation in progress.

This change owns the shared framework queue, host, bootstrap, public framework
operation types, and their permanent unit and synthetic DOM controls under
`packages/waffle/tests/page-runner/`. It does not change consumer registration,
original suites, clocks, native drivers, versions, or dependency pins.

The queue owns one root slot and a separate sealed lifetime for each callback.
Domain operations are root-only. Actual child callbacks and HTTP requests must
settle before success, including work admitted while a child is draining.

Ordinary viewport completion supports sequential calls. The framework's existing
iframe-only done/fail events do not correlate concurrent calls individually.
Synthetic DOM and fixture transport controls are not native qualification.
