# Waffle

Waffle is the browser runtime for WebAssembly programs: processes, pipes, filesystem,
network services and worker bootstrap. The page owns one `createRuntime()` instance;
guests borrow its capabilities instead of creating another runtime.

`bun-wasm` and `bash-web` consume Waffle as an exact commit-pinned Git dependency.
Consumers list `waffle` in Bun's `trustedDependencies` so installation runs `prepare`
and emits the Node entry points. Keep source-only consumers and the generated Node
exports working together.

## Layout

- `core/`: WASI, descriptors, open-file state and memory helpers.
- `fs/`: shared filesystem services and storage backends.
- `proc/`: process ABI, jobs, signals, pipes and worker transports.
- `browser/`: runtime ownership, worker bootstrap and process broker;
  `browser/net/` contains network transports and preview HTTP services.
- `interrupt/`: WebAssembly interruption admission and checkpoints.
- `tooling/`: bundle-size checks. `docs/host-abi.md` describes the guest/host contract.
- `tests/`: unit and browser storage tests. `plans/`: owned follow-up work.

## Rules

- Work in an exclusive `/work/worktrees/waffle/<lane>` checkout. Never edit, build or
  test the shared `/work/projects/waffle` checkout. Scratch goes in
  `/work/tmp/waffle-*`; each run owns teardown of its processes and scratch.
- New code is TypeScript. Do not check in compiled JavaScript, `dist/`, binaries,
  screenshots or test evidence: consumers clone this repository. The existing
  `core/memory-views.js` source exception is recorded in `docs/bun-patches.md`.
- Preserve pay-for-use loading: do not load the process implementation before the
  first spawn. Keep bundle-size gates and the core gzip budget in
  `tooling/runtime-size.ts`.
- Size budgets catch accidental growth. When a change needs more, raise the budget in the same PR and note the measured numbers; don't contort the design to fit.
- Every new or changed copied/adapted upstream implementation needs a classified
  overview row and section in `docs/bun-patches.md`, including upstream path and
  revision, local changes and reasons. Distinguish original adapters.
- Change matching consumers together. No old-shape fallbacks, version-skew paths or
  compatibility negotiation. Only patch version bumps; concurrent PRs coordinate
  the next unused patch before landing.
- Do not open GitHub issues. Fix findings in scope or give the owning plan enough
  evidence for another lane to act.

## Gates

Run from the exclusive worktree:

```sh
bun install --frozen-lockfile
bun install --cwd site --frozen-lockfile
bun run prepare
bun run quality
bun test ./tests
bun run size
```

The browser storage matrix is `bun tests/storage-browser-runner.ts chromium firefox webkit`.
It requires Playwright's three browser engines. Set `STORAGE_SCRATCH_ROOT` to a
verified data-drive scratch directory; the runner owns its browser/profile cleanup.
Do not duplicate another lane's substantial browser workload without coordinating.

Read the shared `machine-fleet` skill before choosing an execution host. Substantial
PC work runs through `bun /work/platform-production/heavy/current/run.js --class
build <label> -- <command>` (or the appropriate suite/browser class). Available
UpCloud capacity uses the fleet's remote dispatcher and host-local heavy queue.
Allow queue plus execution time for background jobs; never run builds or broad
suites outside the chosen host's queue.
