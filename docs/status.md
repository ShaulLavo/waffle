# Status and limits

Waffle is pre-1.0 and experimental. This page lists what the code does today, with the numbers and where they come from. It states facts and gives no advice. The [guides](README.md#guides) show how to work within these limits.

## Stability

- **Version:** `0.0.89` in `package.json`, with `private: true`. Only patch versions change.
- **Distribution:** exact-commit Git dependency. No npm package, no tags, no GitHub releases.
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

Waffle's code and docs do not mention Wasm threads or other post-Preview 1 interfaces.

## Limits

| Area                  | Limit                                                                                              | Source                                   |
| --------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Resident file pool    | 1 GiB by default, in 16 MiB segments of 64 KiB pages. A full pool returns `ENOSPC`.                | `fs/protocol.ts`                         |
| Workspace size        | Can exceed the pool, because clean payloads leave memory. Browser storage quota applies.           | [Storage](storage.md)                    |
| Checkpoint capture    | 512 MiB of payload copies, 8 MiB of metadata units, 64 pending operations. Over a limit: `EAGAIN`. | `fs/checkpoint-pressure.ts`              |
| Dirty growth          | 2 GiB, twice the checkpoint metadata limit, 64 waiters, for persistent backends.                   | `fs/dirty-admission.ts`                  |
| Pending-data bound    | `not-yet-enforced` for FAST.                                                                       | `getVfsDescriptor("fast")`               |
| Writers per workspace | One. A second tab waits or takes over.                                                             | [Storage](storage.md)                    |
| Durability            | A write acknowledges memory. `flush()` waits for IndexedDB.                                        | [Filesystem modes](vfs.md)               |
| Processes             | 1,024 simultaneously enrolled by default.                                                          | `proc/pipes.ts`, `proc/worker-client.ts` |
| Pipes                 | 64 KiB capacity, 16 writers and 16 readers by default. Lifetime cells exhausted: `ENFILE`.         | [Architecture](architecture.md)          |
| Signals               | Linux numbers 1 to 31 and 34 to 64. Stop signals 19 to 22 return `ENOTSUP`. No stopped state.      | [Architecture](architecture.md)          |
| Network               | Virtual loopback only: `127.0.0.1`, `0.0.0.0`, `::1`, `::`. Port 0 picks from 49152 to 65535.      | [Networking](network.md)                 |
| TCP buffering         | 1 MiB unread per direction. HTTP fetch bodies use a 512 KiB window.                                | [Networking](network.md)                 |
| Permissions           | One virtual principal. Files `0600`, directories `0700`. No owners, groups or symlinks.            | [Permissions](permissions.md)            |
| Host identity         | `runtime.hostIdentity` is `null` unless the embedder passes `uid`, `euid` and `hostname`.          | [Process identity](process-context.md)   |

## Known gaps

- Persistent storage has no coherent multi-writer engine. A frozen or hidden owner can hold the lock indefinitely.
- FAST and the memory-pressure limits are accounting units, not heap measurements.
- The internal OPFS backend and the archive, export and staged-commit code are not wired into `createRuntime()`.
