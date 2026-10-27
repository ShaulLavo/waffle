# Development

How to build, check and change Waffle. For using it, start with [Getting started](getting-started.md).

The runtime package lives in `packages/waffle`. The repository root is a private Bun workspace. Existing consumers retain their exact pre-move Git pins ([ADR 001](adr/001-install-as-an-exact-commit-git-dependency.md)); future pins use a prepared runtime release archive after it exists. No npm publication is configured.

## Set up

You need [Bun](https://bun.sh) and the Rust toolchain pinned in `rust-toolchain.toml`, including `wasm32-unknown-unknown`. CI uses Bun 1.4.4. From the repository root:

```sh
bun install --frozen-lockfile
bun install --cwd site --frozen-lockfile
bun run prepare:package
```

`bun run build:network` builds the separate Rust WASM asset. `bun run size:network` reports its independent budgets. Native and compiled-module tests run with `WAFFLE_TCP_MODULE=$PWD/packages/waffle/browser/net/network.wasm bun run test:network:rust`.

`bun run --cwd packages/waffle tooling/build-network.ts --verify` checks the artifact against the current Rust inputs and its SHA-256 checksum without running Cargo. CI restores this artifact outside `packages/waffle/dist/` and sets `WAFFLE_NETWORK_PREBUILT=1`, so missing or corrupt bytes fail rather than building again.

`bun run prepare:package` writes the Node entry points under `packages/waffle/dist/`. `packages/waffle/dist/` is ignored, and CI fails if `git ls-files packages/waffle/dist` lists anything.

## Check your change

CI runs these in the `package` job. Run them before you push:

```sh
bun run quality
bun run test
bun run size
```

- `bun run quality` runs lint, format check, three TypeScript configurations, the landing site's type check, unused-code detection, duplicate detection and the probes that prove each gate fails when it should. [Quality gates](quality.md) lists what each one covers.
- `bun run test` runs the unit tests. To run one file, pass its path: `bun test packages/waffle/tests/runtime-facade.test.ts`.
- `bun run size` bundles `packages/waffle/core`, `packages/waffle/fs` and `packages/waffle/proc` and fails if `core` exceeds the gzip budget in `packages/waffle/tooling/runtime-size.ts`. It prints the three sizes in bytes.
- `bun run --cwd packages/waffle format` rewrites files that `bun run format:check` rejects. The formatter covers every page in `docs/`, so run it after editing Markdown.
- `bun run test:ci` checks which paths trigger which CI jobs.

## Run the browser suites

The browser suites need Playwright's engines. Install them once:

```sh
bunx playwright install chromium firefox webkit
```

Run one suite in one engine, or the whole matrix:

```sh
bun packages/waffle/tests/storage-browser-runner.ts chromium
bun run test:browser
```

Set `STORAGE_SCRATCH_ROOT` to a scratch directory before you run a storage suite. Each runner removes its own browser profile and processes when it finishes. Other suites take `PROCESS_SCRATCH_ROOT` or `NETWORK_SCRATCH_ROOT`. `bun run test:browser` runs Chromium and Firefox together and WebKit afterwards, as CI does.

The libc suite builds guest binaries with a pinned wasi-sdk and runs them under Wasmtime. See [Guest libc](wasi-libc.md) for its requirements. `bun run test:libc` runs it.

## Where things live

| Path         | Holds                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------ |
| `packages/waffle/core/`      | WASI adapter, descriptors, open-file state, memory helpers.                                |
| `packages/waffle/fs/`        | The filesystem service, storage backends, VFS modes, `WorkspaceVfs`.                       |
| `packages/waffle/proc/`      | Process ABI, supervisor, jobs, signals, pipes, worker transports.                          |
| `packages/waffle/browser/`   | `SharedFilesystem`, process broker, worker bootstrap. `browser/net/` has the network code. |
| `packages/waffle/interrupt/` | The WebAssembly rewriter that inserts interruption checkpoints.                            |
| `packages/waffle/runtime.ts` | `createRuntime()` and the capability projections that guests receive.                      |
| `packages/waffle/tests/`     | Unit tests, browser runners and fixtures.                                                  |
| `packages/waffle/tooling/`   | Size gate, quality probes, benchmark and storage tooling.                                  |
| `site/`      | The landing page. It has its own `package.json` and [README](../site/README.md).           |
| `docs/`      | These docs. [The index](README.md) maps them by kind.                                      |
| `.internal/` | Working notes. Not user documentation.                                                     |

## Change the docs

Run `bun run format:check` and `bun run test:ci` after a docs change. Public pages live in `docs/` and never link into `.internal/` or `plans/`. Several source files point at a doc path, so check with `grep -rn "docs/" --include='*.ts' .` before you move or rename a page.

## Release the runtime

The repository root is a private workspace. Installable runtime archives are packed from `packages/waffle`; the root is not a consumer dependency. Existing commit pins keep their immutable pre-move trees. New consumer pins use the runtime's GitHub release archive.

After the reviewed move and main checks pass, cut a patch release from main: update `packages/waffle/package.json` and the workspace lockfile, then create and push the matching `waffle-v<version>` tag. The runtime release workflow checks that the tag version matches the package and that its commit belongs to main. It restores the exact network artifact from CI, packs `waffle-<version>.tgz`, and creates a GitHub release with that archive and its `.sha256` checksum. It uses GitHub's existing workflow token and does not publish to npm. Repeated publication fails instead of replacing release assets.

Only after the release assets exist, update consumer dependency and peer pins to the release archive URL and remove Waffle's lifecycle trust entry. The archive includes prepared Node modules, source and browser worker entries, network assets, and licenses; installation needs no prepare step. For local development, run `bun link` from `packages/waffle` and `bun link waffle` from the consumer.
