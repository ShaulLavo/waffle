# Waffle

Waffle is the browser runtime for WebAssembly programs. The page owns one `createRuntime()`
instance and guests borrow its capabilities; never create a second runtime. `bun-wasm` and
`bash-web` consume Waffle as an exact commit-pinned Git dependency and list `waffle` in Bun's
`trustedDependencies`, so installation runs `prepare` and emits the Node entry points. Keep
source-only consumers and the generated Node exports working together.

## Where things live

- Read `docs/development.md` for the layout and `docs/concepts.md` before changing ownership,
  process or worker code.
- Read `docs/host-abi.md` before changing anything a guest can call.
- Read `docs/private-authority.md` before passing a runtime value into guest-reachable code.
- `plans/` holds owned follow-up work. `.internal/` holds working notes. Neither is user
  documentation, and public docs never link to them.

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
- Size budgets catch accidental growth. When a change needs more, raise the budget in the
  same PR and note the measured numbers. Do not contort the design to fit.
- Every new or changed copied or adapted upstream implementation needs a classified
  overview row and section in `docs/bun-patches.md`, including upstream path and
  revision, local changes and reasons. Distinguish original adapters.
- Change matching consumers together. Write no old-shape fallbacks, version-skew paths or
  compatibility negotiation. Bump only the patch version; concurrent PRs coordinate
  the next unused patch before landing.
- Do not open GitHub issues. Fix findings in scope, or give the owning plan enough
  evidence for another lane to act.
- Source files and the landing site link to `docs/host-abi.md`, `docs/runtime-startup.md`,
  `docs/private-authority.md`, `docs/bun-patches.md`, `docs/getting-started.md` and
  `docs/architecture.md`. Keep those paths. Before moving any doc, run
  `grep -rn "docs/" --include='*.ts' --include='*.astro' .`.

## Verify

Run from the exclusive worktree:

```sh
bun install --frozen-lockfile
bun install --cwd site --frozen-lockfile
bun run prepare
bun run quality
bun test ./tests
bun run size
```

`bun run format` fixes Markdown formatting in `docs/`. `README.md` and `AGENTS.md` are not
formatter inputs.

The browser storage matrix is `bun tests/storage-browser-runner.ts chromium firefox webkit`.
It requires Playwright's three browser engines. Set `STORAGE_SCRATCH_ROOT` to a
verified data-drive scratch directory; the runner owns its browser and profile cleanup.
Do not duplicate another lane's substantial browser workload without coordinating.

Read the shared `machine-fleet` skill before choosing an execution host. Substantial
PC work runs through `bun /work/platform-production/heavy/current/run.js --class
build <label> -- <command>` (or the appropriate suite or browser class). Available
UpCloud capacity uses the fleet's remote dispatcher and host-local heavy queue.
Allow queue plus execution time for background jobs. Never run builds or broad
suites outside the chosen host's queue.
