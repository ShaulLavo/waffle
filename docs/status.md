# Status and limits

Waffle is pre-1.0 and experimental. This page lists what the code does today, with the numbers and where they come from. It states facts and gives no advice. The [guides](README.md#guides) show how to work within these limits.

## Current delivery

- [PR #207](https://github.com/ShaulLavo/waffle/pull/207) merged memory groups, shared Wasm memory, admission limits, wake handling and cleanup. See [Memory groups](memory-groups.md).
- Opt-in grep and ripgrep host executors use the exported search engine and worker entries. Native guests remain the fallback.
- Preview upgrades carry structured authority through live owner routes and enforce path, query, header and lifetime guards.
- No consumer dependency repin is included.

## Stability

- **Version:** `0.0.102` in `packages/waffle/package.json`, with `private: true`. Only patch versions change.
- **Distribution:** GitHub release archives of the runtime package (`waffle-v<version>` tags). Existing exact-commit Git pins keep installing their old trees. No npm package.
- **API compatibility:** none promised between revisions. Consumers move their pin, lockfile and code together.
- **Changelog:** none. Read the commit history between two pins.
- **SAFE filesystem:** reserved. `mode: "safe"` throws `VfsError` with code `UNSUPPORTED_VFS`.
- **Security audit:** none recorded in this repository.

Why Git pins: [ADR 001](adr/001-install-as-an-exact-commit-git-dependency.md).

## Requirements

Every filesystem mode needs `SharedArrayBuffer`, cross-origin isolation (the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers) and a dedicated worker. `mode: "fast"` also needs IndexedDB and Web Locks. `getVfsDescriptor(mode).requirements` lists them in code.

Without `SharedArrayBuffer`, `createRuntime()` throws `Page runtime requires SharedArrayBuffer and cross-origin isolation`, or the import fails first with `SharedArrayBuffer is not defined`.

## Browser support

The CI `browser` job installs Playwright's Chromium, Firefox and WebKit on `ubuntu-latest`. It runs these suites in all three engines: safe-staging, storage, storage-lock, process-recycling, network, publication and publication-cross-tab. The Getting started example was also run in Chromium on macOS.

- **Chromium, Firefox and WebKit (Playwright, Linux):** tested in CI.
- **Safari on macOS or iOS, as shipped:** not tested in CI. `tooling/workspace-safari-runner.ts` is a manual WebDriver runner.
- **Chrome on Android:** not tested.
- **Node and Bun:** run the unit tests and tooling. The browser suites run only in browsers.

## Guest programs

- **WASI Preview 1 command that exports `_start` and memory:** runs through the generic `preview1` worker. See [Run a WASI program](guides/run-a-wasi-program.md).
- **Module that imports `runtime_proc`:** gets spawn, pipes, jobs, signals and poll. See [Host ABI](host-abi.md).
- **Module that imports an unknown namespace or name:** fails at link time. Waffle adds no stub that returns `ENOSYS`.
- **Preview 1 `sock_accept`, `sock_recv`, `sock_shutdown`:** return `ENOTSUP`. TCP reaches guests only through an adapter such as Bun's.
- **Symlinks (`path_symlink`):** return `ENOTSUP`.
- **Guest that inherits file descriptor 3 and scans preopens:** needs a wasi-libc rebuilt with the patch in [Guest libc](wasi-libc.md).
- **Bun and Bash Web:** run on Waffle through their own adapters, in their own repositories.

Memory groups support cooperative shared-memory guests. Production thread scheduling and a Rust allocator rewrite are not delivered.

## Limits

| Area                  | Limit                                                                                              | Source                                   |
| --------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Resident file pool    | 1.5 GiB by default, in 16 MiB segments of 64 KiB pages. A full pool returns `ENOSPC`.              | `fs/protocol.ts`                         |
| Workspace size        | Can exceed the pool, because clean payloads leave memory. Browser storage quota applies.           | [Storage](storage.md)                    |
| Checkpoint capture    | 512 MiB of payload copies, 8 MiB of metadata units, 64 pending operations. Over a limit: `EAGAIN`. | `fs/checkpoint-pressure.ts`              |
| Dirty growth          | 2 GiB, twice the checkpoint metadata limit, 64 waiters, for persistent backends.                   | `fs/dirty-admission.ts`                  |
| Pending-data bound    | `not-yet-enforced` for FAST.                                                                       | `getVfsDescriptor("fast")`               |
| Writers per workspace | One. A second tab waits or takes over.                                                             | [Storage](storage.md)                    |
| Durability            | A write acknowledges memory. `flush()` waits for IndexedDB.                                        | [Filesystem modes](vfs.md)               |
| Processes             | 1,024 simultaneously enrolled by default.                                                          | `proc/pipes.ts`, `proc/worker-client.ts` |
| Pipes                 | 64 KiB capacity, 16 writers and 16 readers by default. Lifetime cells exhausted: `ENFILE`.         | [Architecture](architecture.md)          |
| Signals               | Linux numbers 1 to 31 and 34 to 64. Stop signals 19 to 22 return `ENOTSUP`. No stopped state.      | [Architecture](architecture.md)          |
| Browser network       | Virtual loopback only: `127.0.0.1`, `0.0.0.0`, `::1`, `::`. Port 0 picks from 49152 to 65535.      | [Networking](network.md)                 |
| TCP buffering         | 1 MiB unread per direction. HTTP fetch bodies use a 512 KiB window.                                | [Networking](network.md)                 |
| Permissions           | One virtual principal. Files `0600`, directories `0700`. No owners, groups or symlinks.            | [Permissions](permissions.md)            |
| Host identity         | `runtime.hostIdentity` is `null` unless the embedder passes `uid`, `euid` and `hostname`.          | [Process identity](process-context.md)   |

## Virtual name lookup

`(await runtime.network()).lookup("localhost", { family: 0, hints: 0 })` returns a fresh array containing `{ address: "127.0.0.1", family: 4 }`. The call opens no listener or socket and makes no fetch or process request. It provides the runtime backing needed by Bun's DNS adapter for Vite's localhost startup check. Bun still owns callbacks, promises, sorting and `all`.

Numeric `127.0.0.1` and `::1` also resolve. Unsupported names and nonzero hints throw `ENOTSUP`, not `ENOTFOUND`. This is virtual loopback policy, not OS DNS or external TCP. The [lookup contract](network-lookup.md) lists results, options, errors and lifetime rules.

## Separate network module

The lazy Rust `wasm32-unknown-unknown` module and Waffle-owned native `socket2` binding are implemented in PR105. This is a scoped Rust exception, recorded in [ADR 005](adr/005-lazy-rust-wasm-network.md). The runtime loads the module at `runtime.network()`, with one instance per runtime and no OS socket binding in browser hosts. Guest network calls, rings, JSON and handles are unchanged.

Measured on 2026-10-25 with the pinned Rust toolchain and `bun run size:network`:

| Artifact                     |  Bytes | Separate budget |
| ---------------------------- | -----: | --------------: |
| Network WASM                 | 85,060 |          88,000 |
| Network WASM, gzip           | 26,856 |          28,000 |
| Lazy JavaScript loader, gzip |    664 |             800 |

The core measured 9,196 gzip bytes. Its existing 9,782-byte budget is unchanged. Source installation now needs the pinned Rust toolchain and WASM target. Generated assets are not checked in.

Native tests cover real IPv4 and IPv6 connections, IPv6-only OS controls, disposable-child IPv4 fallback, partial host operations, backpressure, readiness, half-close and cleanup. The browser network matrix passes in Chromium, Firefox and WebKit and remains virtual-only. Bun consumer wiring, its matching dependency pin and facade fixtures are not delivered here. The host ABI supports immediate nonblocking bind and readiness-driven connect/I/O, not asynchronous bind completion, DNS, TLS or close-linger timers. The reference readiness wait is Unix-only. See [Network module ABI](network-module.md).

## Known gaps

- Persistent storage has no coherent multi-writer engine. A frozen or hidden owner can hold the lock indefinitely.
- FAST and the memory-pressure limits are accounting units, not heap measurements.
- The internal OPFS backend and the archive, export and staged-commit code are not wired into `createRuntime()`.
