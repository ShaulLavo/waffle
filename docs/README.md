# Waffle docs

Start with [Getting started](getting-started.md). It builds a page that runs a runtime in about a screen of code. Each section below holds one kind of page.

## Start here

- [Getting started](getting-started.md): tutorial. Build and serve a page that writes and reads a file.
- [Status and limits](status.md): what works, what does not, with numbers.
- [Troubleshooting](troubleshooting.md): the messages you can hit and their fixes.

## Guides

- [Run a WASI program](guides/run-a-wasi-program.md): register a compiled program, spawn it, read its output and exit status.
- [Persist the filesystem](guides/persist-the-filesystem.md): keep files between page loads and handle a second tab.
- [Install program packages](guides/install-program-packages.md): put a package's programs on `PATH` and load each one on first run.

## Concepts

- [How Waffle works](concepts.md): ownership, the services, the life of a spawn, and why kills take two steps.

## Reference

Dry and exact. Each page mirrors the code it describes.

- [Host ABI](host-abi.md): guest imports, wait results, startup errors and the permission query.
- [Architecture and API notes](architecture.md): package entries, WASI adapter, processes, signals, pipes and the shared filesystem service.
- [Filesystem modes](vfs.md): `fast`, `safe` and `memory`, descriptors, persisted formats and typed errors.
- [Storage ownership and lifecycle](storage.md): `whenBusy`, waiting, takeover, cancellation and disposal.
- [WorkspaceVfs](workspace-vfs.md): read-only snapshots, version leases and change feeds.
- [Workspace search](workspace-search.md): pull-driven live search over a `WorkspaceVfs`.
- [Permissions](permissions.md): mode bits and effective access.
- [Process identity](process-context.md): `hostIdentity` and process metadata.
- [Runtime startup](runtime-startup.md): `onStartupStage` stages and timestamps.
- [Memory groups](memory-groups.md): shared Wasm memory across member processes, limits and lifetime.
- [Networking](network.md): runtime-scoped loopback sockets, helpers and previews.
- [Browser TCP addresses](browser-network-addresses.md): bind rules and address reporting.
- [Guest libc](wasi-libc.md): descriptor placement and the patched preopen scan.

## Internals

For people who change Waffle. These pages describe code that is internal to the package.

- [Development](development.md): setup, checks, repository layout.
- [Quality gates](quality.md): lint, format, type, unused-code and duplicate checks.
- [Source provenance](bun-patches.md): copied and adapted code, with upstream revisions.
- [Private process authority](private-authority.md): why authority never passes through guest-mutable builtins.
- [IndexedDB immutable chunks](indexeddb-chunks.md): on-disk chunk format and range reads.
- [OPFS payload ranges](opfs-ranges.md): range reads on the internal OPFS backend.
- [OPFS close ownership](opfs-close.md): failed-close handling on the internal OPFS backend.

## Decisions

- [001. Install as an exact-commit Git dependency](adr/001-install-as-an-exact-commit-git-dependency.md)
- [002. The page owns one runtime and guests borrow capabilities](adr/002-page-owns-one-runtime.md)
- [003. Select filesystem guarantees, not storage backends](adr/003-select-filesystem-guarantees-not-backends.md)
- [004. Load the process service on first spawn](adr/004-load-the-process-service-on-first-spawn.md)
