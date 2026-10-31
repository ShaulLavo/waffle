# Storage shutdown verification notes

Moved from `docs/storage.md`. These are test-run notes for the ordinary ready-shutdown path, not contract text.

Run a bounded ready IndexedDB success proof with one cached Playwright engine:

```sh
STORAGE_SCRATCH_ROOT=/work/tmp bun tests/filesystem-ready-disposal-browser-runner.ts chromium
```

The proof uses real page APIs, the real service installer and IndexedDB. A test-only
preparation gate holds admitted work through disposal. It checks the pending native
lock, the real service ACK and original backend/storage close, then joins the exact
original Worker target's close event before cleanup and reopens the dirty marker.
Only fixture configuration and gate/observation controls are injected. No ACK is
synthetic. Worker termination is still initiated explicitly by page disposal, not
natural retirement.

The separate service-only observer supports one diagnostic arm:

```sh
STORAGE_SCRATCH_ROOT=/work/tmp bun tests/filesystem-shutdown-browser-runner.ts firefox --backend indexeddb --reason error --arm raw-close-failure
```

The complete ordinary service matrix is 84 arms. Its earlier native run stopped
at the Firefox context-close 1000ms cap after 48 primary observations. That run is
RED/incomplete; the remaining 36 arms are unproved. A passing selected diagnostic
is only non-reproduction. The retained original raw close promise, capped result
and enclosing browser cleanup remain separate receipts. Neither runner proves
whole Runtime shutdown, OPFS shutdown or native failed-close lock retention. No
SAFE, public/default or full-matrix acceptance follows from these controls.
