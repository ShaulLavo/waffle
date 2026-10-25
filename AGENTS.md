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

- Work in an exclusive worktree. Never edit, build or test the shared checkout. Each run
  owns teardown of its processes and scratch. The owner's machine paths are in
  `.internal/owner-machine.md`.
- New code is TypeScript, except the explicitly authorized Rust network module in
  `network/` and its native socket2 adapter. Compile the portable module only to
  wasm32-unknown-unknown, loaded at runtime.network(); native OS code never enters
  browser bundles. Keep Bun APIs, JSON errors, public handles and engine policy in Bun.
  The Rust exception and source-install toolchain are recorded in ADR 005.
  Do not check in compiled JavaScript, `dist/`, binaries,
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
  compatibility negotiation. Feature PRs do not bump versions; bump the patch once at release or consumer pin update.
- Do not open GitHub issues. Fix findings in scope, or record them in the owning plan.
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
Do not duplicate another agent's substantial browser workload without coordinating.

On the owner's PC, run substantial builds and suites through the heavy runner described in
`.internal/owner-machine.md`.
