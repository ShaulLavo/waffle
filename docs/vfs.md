# VFS selection

A VFS is a bundle of durability, concurrency and browser requirements. Small behaviours
such as contention are initialization settings, not separate VFSs.

```ts
import { createRuntime, getVfsDescriptor, VfsError } from "waffle";

const runtime = createRuntime({
  filesystem: { name: "workspace", vfs: "indexeddb", whenBusy: "wait" },
});
const selected = runtime.filesystem.vfs;
const defaultContract = getVfsDescriptor(); // indexeddb, without opening storage
```

The same exports are available from `waffle/runtime`, `waffle/fs` and
`waffle/browser/shared-fs`. `SharedFilesystem` accepts the same selection. `VfsSelection`
is a discriminated union: IndexedDB accepts `"takeover" | "wait"`; OPFS accepts only
`"wait"`; memory accepts no `whenBusy`. The `storage` and `persistence` options are
removed, not translated. A host that needs volatile storage selects `vfs: "memory"`.

## Available implementations

| VFS                   | Default contention | Ordinary successful mutation                  | Durability barrier               | Other tabs                                                           |
| --------------------- | ------------------ | --------------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `indexeddb` (default) | `takeover`         | Memory updated; strict storage commits follow | `flush` / guest `fsync`          | One owner; takeover revokes/fences the prior owner, or `wait` queues |
| `opfs-memory`         | `wait`             | Memory updated; OPFS checkpoint follows       | `flush` / guest `fsync`          | One owner; other tabs wait                                           |
| `memory`              | Not applicable     | Memory updated                                | Ordering only, never persistence | Independent volatile trees                                           |

The OPFS selection is the existing OPFS implementation under an explicit name, not a
new layout. `opfs-safe` and `opfs-wal` are not selectable until certified. Unknown
names, including `opfs`, fail with `VfsError` code `UNSUPPORTED_VFS`; there is no
fallback. `whenBusy` never changes the descriptor's identity.

All current implementations require a dedicated filesystem worker, SharedArrayBuffer
and cross-origin isolation. Persistent implementations additionally require Web Locks
and either IndexedDB or standard OPFS sync access handles. Capability validation does
not create files, probe unsafe handles or change storage. No new persistence algorithm,
format marker or format conversion is introduced here.

## Inspecting the contract

`getVfsDescriptor(name?)` returns a deeply frozen `VfsDescriptor`. It describes the
stable `id` and `displayName`, persistence, mutation acknowledgement, global `flush`,
guest file `fsync`, targeted flush, ownership, supported/default contention settings,
required capabilities, worker execution, direct shared-memory access, format/location,
unsupported settings and possible lifecycle states. The mounted runtime exposes that
same object as `runtime.filesystem.vfs`; mutable startup state remains separate in
`runtime.filesystem.state` and `onStateChange`.

Memory acknowledgement is not durable acknowledgement. Strict IndexedDB transactions
do not retroactively make earlier memory-only writes durable. Global flush checkpoints
ordered data and metadata; targeted flush checkpoints the selected payloads and the
namespace needed to recover them. It does not promise durability for unselected dirty
payloads. Guest `fsync` is a file-targeted barrier. To durably save then notify HMR,
await `writeFile`, then `flush(path)`, and only then notify. Closing a page before a
completed barrier may lose ordinary acknowledged writes. A checkpoint interval is a
scheduling target, not a maximum loss window.

Durability means the browser storage APIs and recovery protocol completed. It does not
protect against site-data deletion, eviction, private-session destruction, device
failure or browser violations of those APIs. Both persistent implementations retain
lazy payload loading and direct shared-memory reads/mutations.

## Storage identity and errors

The default workspace name remains `waffle-workspace`. IndexedDB still uses the exact
workspace name as its database name, version 1, with metadata, journal and data stores.
Its descriptor format ID is `waffle-indexeddb-v1`. OPFS still uses
`bun-wasm-<base64url(UTF-8(JSON.stringify(name)))>` with `data` and `metadata` directories,
two checksummed snapshots and immutable payload revisions; descriptor format ID
`waffle-opfs-snapshots-v1`. These IDs describe existing layouts, not newly written markers.
The OPFS workspace lock remains `bun-wasm:filesystem:<name>`, without a VFS ID.
IndexedDB retains its existing `bun-wasm:filesystem:indexeddb:<name>` lock.

Selecting another store does not migrate files. Existing saved IndexedDB and OPFS
workspaces keep their names and bytes. Established invalid/unrecoverable metadata or
an incompatible IndexedDB database version fails without resetting the workspace.

`VfsError` carries `name: "VfsError"`, `code` and `vfs` across worker startup:

- `UNSUPPORTED_VFS`: the requested implementation is unavailable or unknown.
- `INVALID_VFS_SETTINGS`: a supplied setting is not supported by the selection.
- `UNSUPPORTED_VFS_CAPABILITY`: required browser APIs are absent.
- `INVALID_VFS_FORMAT`: established persisted metadata is invalid/unrecoverable or
  its database version is incompatible.

Selection/settings errors reject synchronously before a worker is allocated. Worker
failures appear in the existing failed state and reject queued operations with the
same typed error, not an unclassifiable startup string. Other storage failures retain
their original error name/code and diagnostic stack. See [storage.md](storage.md) for
waiting, recovery, ownership loss and asynchronous disposal.

## Prepared consumer selector changes (not delivered)

These are the matching source changes for the later consumer-delivery PRs. No consumer
pin or implementation is changed by this step. Install exact merged Waffle commits;
update the package pin, lockfile, source lock and trusted installation policy together.

### bun-wasm `web/src/main.ts`

Replace the current `storage` query's two-way fallback with explicit validated selection:

```ts
const vfs = getVfsDescriptor(params.get("vfs") ?? "indexeddb").id;
const runtime = createRuntime({ filesystem: { vfs, name: "bun-wasm-workspace" } });
```

Import `getVfsDescriptor` with `createRuntime`. Handle `VfsError` at this initialization
boundary with a visible diagnostic; do not turn an unsupported name into IndexedDB.
Keep the workspace name and omitted-query default. Display opening/waiting separately
from failure, resume on ready, preserve unsaved-text and ownership-loss handling, and
await owner disposal before replacement. Update `web/tests/browser-filesystem-lifecycle.ts`
for waiting and automatic readiness after release. Preserve sandbox template workspace
names and write → targeted flush → HMR order in `sandbox/src/main.ts`.

### bash-web `src/browser/main.tsx`

Fetched `origin/main` already waits for storage after acquiring a runtime lease. Only
the standalone-owned creation branch should add selection; add a typed `vfs?: VfsName`
option to its owned-host options and pass it when creating the runtime:

```ts
const owned = createRuntime({
  filesystem: { workerURL: filesystemWorkerUrl, vfs: options.vfs },
  onStartupStage,
});
```

Reject or exclude a selector from the borrowed `runtime` and `acquireRuntime` branches.
They must not override the supplied runtime, create another one or dispose its owner.
Preserve idempotent lease cleanup, `waitForStorage`, waiting UI, and start the shell's
active startup timeout only after readiness. Parse any standalone query through
`getVfsDescriptor`, showing typed errors rather than defaulting an unknown name.
