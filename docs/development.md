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

### Run the low-level Rust threads proof

The optional threads runner consumes an existing producer receipt and artifact. It verifies both
against the current source before opening a browser and never invokes a compiler. Run it with
Playwright's Chromium and Firefox, using an unused explicit loopback port:

```sh
THREAD_FIXTURE_DIR=/absolute/path/to/fixture PROCESS_SCRATCH_ROOT=/work/tmp \
THREAD_BROWSER_PORT=19437 bun packages/waffle/tests/threads-browser-runner.ts chromium firefox
```

Add `--case pair`, `--case repeat`, or `--case nested` to run one stock Rust mode.
Every invocation first proves start-section wait32 and wait64 registration, delayed entry,
canonical pipe output, real filesystem reads, and bounded child-exit controls in that engine. A child grows the shared memory while main is
parked in wait32 or wait64. The private control route retains the captured wait buffer until its
matching clear or real host-idle event, and terminal teardown wakes the parked address.
The Rust modes check exact stdout and all child returns with native shared memory starting at
17 pages and capped at 512 pages. No growable-buffer conversion or allocator patch is used.

Prepare the same proof for actual desktop Safari without copying a checkout or installing a compiler:

```sh
THREAD_FIXTURE_DIR=/absolute/path/to/fixture \
  bun packages/waffle/tests/threads-browser-runner.ts --prepare /work/tmp/threads-safari
# Transfer that directory to a reserved Mac and start a task-owned safaridriver on port 19438.
bun /path/to/threads-safari/runner.mjs /path/to/threads-safari http://127.0.0.1:19438 19437
```

The Safari runner checks packet hashes, requires desktop Safari capabilities, and deletes only
its own WebDriver session. Both runners own their loopback server and browser resources. Remove
the transferred and prepared packets after saving the small reports. Native stop requests and
host-idle receipts do not measure OS memory reclamation.

This is an internal service and guest-bridge embedding, not a production threaded Runtime launcher.
It does not qualify reservation accounting, aggregate backing lifetime, Runtime two-step kill,
all growth-time cancellation races, or iOS. Playwright WebKit is not actual Safari evidence.

### Run the local TCP relay matrix

The network runner first runs the unchanged no-relay loopback cases, then the relay cases.
The relay fixture binds only loopback and owns its real TCP echo and SSLRequest targets.
It checks a worker's Bun-shaped `NetHost` calls and the shipped Preview 1 worker with page-owned
`createPreview1Network` bindings. The SSLRequest exchange is transport coverage, not a Postgres query.

```sh
NETWORK_SCRATCH_ROOT=/work/tmp bun packages/waffle/tests/network-browser-runner.ts chromium firefox webkit
```

For just the relay cases, run `packages/waffle/tests/network-relay-browser-runner.ts` with the same engines.
Use a physically short scratch root, at most 36 bytes, so browser profile socket paths fit.
The Chromium and Firefox cases require the relay package's declared optional native peers.
A normal frozen root install runs their installer. After an `--ignore-scripts` install, run
`bun run --cwd packages/waffle-relay/node_modules/@fails-components/webtransport-transport-http3-quiche install`.
The production native entry still verifies the exact package versions and addon checksum.
WebSocket-only WebKit never loads that entry.

The report includes the engine version and actual carrier. Chromium and Firefox exercise the
complete WebTransport probe with fragmented open headers, forced WebSocket, and real invalid-certificate
fallback. A failure stays blocking. Playwright WebKit proves only WebSocket and is not Safari evidence.
Each case checks exact bytes, pending and terminal errors, half-close, helper and runtime disposal,
client closure, and zero remaining relay admissions and target sockets.

To prepare the same WebSocket fixture for a later actual Safari run, use the existing manual driver:

```sh
bun packages/waffle/tooling/workspace-safari-runner.ts --relay-prepare /work/tmp/waffle-relay-safari
# Transfer the prepared directory to the Mac, then run there:
bun /path/to/waffle-relay-safari/runner.mjs --relay-run /path/to/waffle-relay-safari
```

The portable directory includes the browser bundles and WASM fixtures. It needs Bun and enabled
Safari WebDriver, not a repository install or native WebTransport peers. The driver owns its Safari
session, local relay and target listeners. Remove the prepared directory after retaining the small report.
Actual Safari, iPhone and deployed remote UDP acceptance remain separate checks.

The libc suite builds guest binaries with a pinned wasi-sdk and runs them under Wasmtime. See [Guest libc](wasi-libc.md) for its requirements. `bun run test:libc` runs it.

## Where things live

| Path                         | Holds                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/waffle/core/`      | WASI adapter, descriptors, open-file state, memory helpers.                                |
| `packages/waffle/fs/`        | The filesystem service, storage backends, VFS modes, `WorkspaceVfs`.                       |
| `packages/waffle/proc/`      | Process ABI, supervisor, jobs, signals, pipes, worker transports.                          |
| `packages/waffle/browser/`   | `SharedFilesystem`, process broker, worker bootstrap. `browser/net/` has the network code. |
| `packages/waffle/interrupt/` | The WebAssembly rewriter that inserts interruption checkpoints.                            |
| `packages/waffle/runtime.ts` | `createRuntime()` and the capability projections that guests receive.                      |
| `packages/waffle/tests/`     | Unit tests, browser runners and fixtures.                                                  |
| `packages/waffle/tooling/`   | Size gate, quality probes, benchmark and storage tooling.                                  |
| `site/`                      | The landing page. It has its own `package.json` and [README](../site/README.md).           |
| `docs/`                      | These docs. [The index](README.md) maps them by kind.                                      |
| `.internal/`                 | Working notes. Not user documentation.                                                     |

## Change the docs

Run `bun run format:check` and `bun run test:ci` after a docs change. Public pages live in `docs/` and never link into `.internal/` or `plans/`. Several source files point at a doc path, so check with `grep -rn "docs/" --include='*.ts' .` before you move or rename a page.

## Release the runtime

The repository root is a private workspace. Installable runtime archives are packed from `packages/waffle`; the root is not a consumer dependency. Existing commit pins keep their immutable pre-move trees. New consumer pins use the runtime's GitHub release archive.

After the reviewed move and main checks pass, cut a patch release from main: update both `packages/waffle/package.json` and `packages/waffle-relay/package.json` to the same version and update the workspace lockfile, then create and push the matching `waffle-v<version>` tag. The runtime release workflow checks that the tag version matches the package and that its commit belongs to main. It restores the exact network artifact from CI, packs `waffle-<version>.tgz` and `waffle-relay-<version>.tgz`, and creates a draft GitHub release with both archives and their separate `.sha256` checksums. It uses GitHub's existing workflow token and does not publish to npm. Repeated publication fails instead of replacing release assets.

Only after the release assets exist, update consumer dependency and peer pins to the release archive URL and remove Waffle's lifecycle trust entry. The archive includes prepared Node modules, source and browser worker entries, network assets, and licenses; installation needs no prepare step. For local development, run `bun link` from `packages/waffle` and `bun link waffle` from the consumer.
