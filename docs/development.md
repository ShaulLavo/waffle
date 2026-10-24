# Development

How to build, check and change Waffle. For using it, start with [Getting started](getting-started.md).

Waffle is a private, exact-commit Git dependency while its public API settles ([ADR 001](adr/001-install-as-an-exact-commit-git-dependency.md)). Consumers pin a commit and list `waffle` in Bun's `trustedDependencies`. Do not rely on an npm tarball or a sibling checkout.

## Set up

You need [Bun](https://bun.sh). CI uses Bun 1.4.4. From the repository root:

```sh
bun install --frozen-lockfile
bun install --cwd site --frozen-lockfile
bun run prepare
```

`bun run prepare` writes the Node entry points under `dist/`. `dist/` is ignored, and CI fails if `git ls-files dist` lists anything.

## Check your change

CI runs these in the `package` job. Run them before you push:

```sh
bun run quality
bun test ./tests
bun run size
```

- `bun run quality` runs lint, format check, three TypeScript configurations, the landing site's type check, unused-code detection, duplicate detection and the probes that prove each gate fails when it should. [Quality gates](quality.md) lists what each one covers.
- `bun test ./tests` runs the unit tests. To run one file, pass its path: `bun test tests/runtime-facade.test.ts`.
- `bun run size` bundles `core`, `fs` and `proc` and fails if `core` exceeds the gzip budget in `tooling/runtime-size.ts`. It prints the three sizes in bytes.
- `bun run format` rewrites files that `bun run format:check` rejects. The formatter covers every page in `docs/`, so run it after editing Markdown.
- `bun run test:ci` checks which paths trigger which CI jobs.

## Run the browser suites

The browser suites need Playwright's engines. Install them once:

```sh
bunx playwright install chromium firefox webkit
```

Run one suite in one engine, or the whole matrix:

```sh
bun tests/storage-browser-runner.ts chromium
bun run test:browser
```

Set `STORAGE_SCRATCH_ROOT` to a scratch directory before you run a storage suite. Each runner removes its own browser profile and processes when it finishes. Other suites take `PROCESS_SCRATCH_ROOT` or `NETWORK_SCRATCH_ROOT`. `bun run test:browser` runs Chromium and Firefox together and WebKit afterwards, as CI does.

The libc suite builds guest binaries with a pinned wasi-sdk and runs them under Wasmtime. See [Guest libc](wasi-libc.md) for its requirements. `bun run test:libc` runs it.

## Where things live

| Path         | Holds                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------ |
| `core/`      | WASI adapter, descriptors, open-file state, memory helpers.                                |
| `fs/`        | The filesystem service, storage backends, VFS modes, `WorkspaceVfs`.                       |
| `proc/`      | Process ABI, supervisor, jobs, signals, pipes, worker transports.                          |
| `browser/`   | `SharedFilesystem`, process broker, worker bootstrap. `browser/net/` has the network code. |
| `interrupt/` | The WebAssembly rewriter that inserts interruption checkpoints.                            |
| `runtime.ts` | `createRuntime()` and the capability projections that guests receive.                      |
| `tests/`     | Unit tests, browser runners and fixtures.                                                  |
| `tooling/`   | Size gate, quality probes, benchmark and storage tooling.                                  |
| `site/`      | The landing page. It has its own `package.json` and [runbook](site.md).                    |
| `docs/`      | These docs. [The index](README.md) maps them by kind.                                      |
| `.internal/` | Working notes. Not user documentation.                                                     |

## Change the docs

Run `bun run format:check` and `bun test tooling/ci-paths.test.ts` after a docs change. Public pages live in `docs/` and never link into `.internal/` or `plans/`. Several source files point at a doc path, so check with `grep -rn "docs/" --include='*.ts' .` before you move or rename a page.
