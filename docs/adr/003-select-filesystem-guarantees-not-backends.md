# 003. Select filesystem guarantees, not storage backends

Status: accepted
Date: 2026-10-18

## Context

Browsers offer IndexedDB and OPFS, with different locking and durability behavior. The filesystem API used to name implementations: first through `storage` and `persistence` selectors, then through `vfs: "indexeddb" | "opfs-memory" | "memory"`. A backend name says nothing about what survives a crash. A workspace saved by one engine must also never reopen as an empty one.

## Decision

`createRuntime({ filesystem: { mode } })` takes `"fast"`, `"safe"` or `"memory"`, and each mode names a guarantee. Backend names are internal test controls. `"safe"` is reserved and throws `UNSUPPORTED_VFS` until an engine that meets its contract exists. The old selectors are rejected, not translated.

## Alternatives considered

- **Keep naming the backend** (`vfs: "opfs-memory"`). This was the earlier shape. It ties consumers to an adapter and leaves the guarantee implicit.
- **Map `"safe"` to FAST until it exists.** Callers would get weaker durability than they asked for without being told. A typed error is the honest answer.
- **Pick the best backend per browser.** FAST uses IndexedDB in every browser so saved workspaces keep their identity. A later adapter change must come with an explicit migration or export path.

## Consequences

- `getVfsDescriptor(mode)` and `runtime.filesystem.vfs` report the contract and the mounted implementation, including `pendingDataBound` and `multiTab`.
- Persisted data carries a format identity (`waffle-indexeddb-chunks-v2`). A mismatch fails with `INVALID_VFS_FORMAT` and never resets the workspace.
- OPFS exists only as an internal conformance implementation.
- Consumers must handle the typed `VfsError` codes instead of falling back.
