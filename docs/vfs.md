# Filesystem modes

Choose guarantees, not a browser storage API.

```ts
import { createRuntime, getVfsDescriptor, VfsError } from "waffle";

const runtime = createRuntime({
  filesystem: { name: "workspace", mode: "fast", whenBusy: "wait" },
});
const selected = runtime.filesystem.vfs;
const defaultContract = getVfsDescriptor(); // FAST, without opening storage
```

The same exports are available from `waffle/runtime`, `waffle/fs` and
`waffle/browser/shared-fs`. `SharedFilesystem` accepts the same `VfsSelection`.
`mode` is `"fast" | "safe" | "memory"`; omitted means FAST. Memory is nonpersistent
and accepts no `whenBusy`. The removed `vfs`, `storage` and `persistence` selectors
are rejected, not translated. Backend names are not accepted modes.

## Guarantees and current availability

| Mode   | Contract                                                                                                                                                                                                         | Available now                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| FAST   | Memory acknowledgement; mutations after the last completed durable checkpoint may be lost. Recovery must be a consistent committed filesystem.                                                                   | Existing IndexedDB checkpoint engine; internal OPFS checkpoint implementation for conformance tests. |
| SAFE   | Every successful mutation is durably recoverable before success, including namespace effects. A complete strict IndexedDB transaction or durable redo record is sufficient; final-page checkpointing may follow. | No. `mode: "safe"` throws typed `UNSUPPORTED_VFS`, with no fallback.                                 |
| Memory | Isolated volatile tree; flush is ordering only.                                                                                                                                                                  | Yes, for tests and explicitly nonpersistent uses.                                                    |

The checkpoint engine does not yet provide bounded pending data with backpressure,
coherent multi-tab writers, above-RAM workloads, or a combined memory budget. Opt-in
[WorkspaceVfs](workspace-vfs.md) supports bounded current and leased-version ranges
without whole-file hydration. The checkpoint engine
descriptors truthfully report `pendingDataBound: "not-yet-enforced"` and
`multiTab: "exclusive-owner"`. The API/identity step does not certify a new engine.

FAST currently uses IndexedDB in every browser to preserve saved workspace identity.
Browser-specific adapters may win later experiments; changing adapters must include
an explicit reopen/migration/export story, never silently start an empty workspace.
Implementation overrides are internal Symbol-keyed test controls, not exported
product options. An override cannot make SAFE run on a FAST engine.

## Inspecting the mounted implementation

`getVfsDescriptor(mode?)` returns a deeply frozen descriptor of the current default
implementation for that mode. `runtime.filesystem.vfs` reports the actual mounted
implementation. It contains `mode`, `implementation`, persistence, mutation ACK,
`durabilityPoint`, `lossBound`, pending-data limits, flush/fsync semantics, multi-tab
behavior, supported/default contention, browser requirements, format identity and
location, direct shared-memory capabilities and lifecycle states. Mutable startup
state remains in `runtime.filesystem.state` and `onStateChange`.

Ordinary memory ACK is not durable ACK, even when later IndexedDB transactions use
strict durability. Await `writeFile`, then `flush(path)`, then notify HMR. Targeted
flush and guest `fsync` checkpoint selected payloads plus their recovery namespace;
they do not promise durability for unrelated dirty payloads. A global flush is the
whole-tree barrier. Checkpoint interval is a scheduling target, not a maximum loss
window. Browser close/reload cannot guarantee saving memory-only changes. A future
Waffle-controlled reload must order/pause mutations, await flush, then reload.

The SAFE target covers tab/worker death, browser crashes and OS/power loss within
the browser's durable-storage contract. Neither mode protects against hardware
failure, browser bugs, eviction or user deletion. A browser-accepted storage barrier
is not a physical power-cut measurement.

Current implementations require a dedicated worker, SharedArrayBuffer and cross-origin
isolation. Persistent implementations additionally require Web Locks and their storage
API. IndexedDB defaults to takeover (epoch fencing), with wait supported. Internal
OPFS supports wait only. Neither provides simultaneous coherent writers today. A
frozen owner can retain its lock indefinitely; see [storage.md](storage.md) for
waiting, ownership loss, cancellation and asynchronous disposal.

## Persisted identity and startup errors

Default workspace: `waffle-workspace`. IndexedDB uses the exact workspace name,
database version 1, and metadata/journal/data stores. Its persisted metadata key
`format` is `waffle-indexeddb-chunks-v2`. Marked or validated unmarked v1
workspaces migrate through staged chunks; the v1 root stays authoritative until
the complete v2 root is published. Downgrade to v1 is unsupported. OPFS keeps
`bun-wasm-<base64url(UTF-8(JSON.stringify(name)))>/{data,metadata}` and adds
`metadata/format-waffle-opfs-snapshots-v1`. Identity is in the OPFS directory-entry
name, so an interrupted empty marker payload cannot change it. Existing unmarked
layouts are adopted only after recovery validates their established format.

The existing checksummed journals/snapshots, immutable payloads and lock names remain:
`bun-wasm:filesystem:indexeddb:<name>` and `bun-wasm:filesystem:<name>`. A mismatched
identity, incompatible database version/schema, or unrecoverable established metadata
fails without resetting or replacing the saved filesystem. No automatic format
conversion or adapter migration is provided by this step.

`VfsError` preserves class, `name`, `code`, `vfs` and diagnostic stack across startup:

- `UNSUPPORTED_VFS`: unavailable/unknown mode (including SAFE today).
- `INVALID_VFS_SETTINGS`: invalid settings for the selected mode/implementation.
- `UNSUPPORTED_VFS_CAPABILITY`: required browser APIs absent.
- `INVALID_VFS_FORMAT`: persisted identity/schema/version mismatch or unrecoverable metadata.

`vfs` is a diagnostic identity: `safe` for unavailable SAFE, or the physical
implementation for storage errors. Selection/settings errors occur before worker
allocation. Worker startup failure enters the existing failed state and rejects
queued operations with the typed error. Other storage errors retain their original
diagnostics; no blanket fallback conceals failure.
