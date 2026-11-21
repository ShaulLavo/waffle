# Incremental checkpoint experiment

Run in an exclusive Waffle checkout on the PC with cached Playwright 1.64.1 and Chromium.

```sh
bun /work/heavy-runner/current/run.js --host local --class bench waffle-294 -- \
  bash .internal/incremental-checkpoint/run.sh /work/reports/waffle-294-comparison
bun /work/heavy-runner/current/run.js --host local --class browser waffle-294-phases -- \
  bash .internal/incremental-checkpoint/run.sh /work/reports/waffle-294-phases phases
```

The comparison archives main commit `4d79516d` into scratch and runs the same direct
1 KiB WASI edit and strict flush in two private databases. A fresh browser verifies
all 64 MiB and checks the prototype's persisted chunk and map identities. The runner
reports pressure-qualified timing and removes its build and profiles.

Set `WAFFLE_CHECKPOINT_LEASE=1 WAFFLE_CHECKPOINT_REPETITIONS=1` for the joined guest
and resident lease case. The phase run covers queued cuts, abort and retry, exact
reconciliation, takeover, dead writers, stages, and deletion with retained readers.
With checkout dependencies installed, `WAFFLE_CHECKPOINT_TYPECHECK=1` also checks
the patched test build's types.
