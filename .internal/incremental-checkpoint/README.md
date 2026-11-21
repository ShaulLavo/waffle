# Incremental checkpoint experiment

Run from an exclusive checkout on the PC with cached Playwright 1.64.1 and its Chromium engine.

```sh
bun /work/heavy-runner/current/run.js --host local --class bench waffle-294 -- \
  bash .internal/incremental-checkpoint/run.sh /work/reports/waffle-294-comparison
```

The command archives tracked package source into scratch, patches the maintained VFS
fixture in both arms, and applies the experimental hooks only in the prototype arm.
Each arm seeds its own database, performs the same direct 1 KiB WASI edit to a
resident 64 MiB file, flushes, closes Chromium, and checks all 64 MiB in a new process.
The prototype database has its own name and format marker.
