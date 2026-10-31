# Owner machine rules

Moved from `AGENTS.md`. These apply on the owner's PC only.

- Exclusive checkouts live at `/work/worktrees/waffle/<lane>`. The shared checkout is `/work/projects/waffle`. Scratch goes in `/work/tmp/waffle-*`.
- Read the shared `machine-fleet` skill before choosing an execution host. Substantial
  PC work runs through `bun /work/platform-production/heavy/current/run.js --class
  build <label> -- <command>` (or the appropriate suite or browser class). Available
  UpCloud capacity uses the fleet's remote dispatcher and host-local heavy queue.
  Allow queue plus execution time for background jobs. Never run builds or broad
  suites outside the chosen host's queue.

The wasi-libc script also ran with `PATH=/work/cache/wasm-tools/cmake/bin:/work/cache/wasm-tools/ninja:$PATH`, `WASI_SDK_PATH=/work/cache/wasi-sdk-34.0-x86_64-linux` and `WASI_LIBC_SCRATCH_ROOT=/work/tmp`. Playwright browsers are cached at `/work/cache/ms-playwright`; the site runbook in this folder has the full commands.
