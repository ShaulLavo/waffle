# @waffle-os/runtime

## 0.0.160

### Patch Changes

- Add guarded cooperative opens that validate the original path before confirming a declared logical descriptor alias. Cooperative guests reopen the retained endpoint through its descriptor, with root and source rights enforced. The standard Preview 1 open contract remains compatible.

## 0.0.159

### Patch Changes

- Restore ordinary `wasi-libc` opens of regular-file aliases such as `/dev/fd/N` and `/proc/self/fd/N`. The reopened descriptor has a fresh offset and receives requested mode-mutation rights only when the source descriptor holds those rights. Root preopen and inode access checks still apply. Explicit `runtime_proc.fd_reopen` returns `ENOTCAPABLE` when the source descriptor lacks a requested mode right.

## 0.0.158

### Patch Changes

- Browser `runtime_fs.path_permissions_get` accepts `LOOKUPFLAGS_SYMLINK_FOLLOW` in bit 0, aligning with `path_filestat_get` and Rust `WasiAbi::stat` in BashWeb. Bit 0 follows a final symbolic link. Passing zero leaves a final symbolic link unfollowed unless the path ends in `/`, which requires a directory. Other flag bits return `ENOTSUP`.

  - Browser `path_open`, `fd_fdstat_set_flags`, and `runtime_proc.fd_reopen` reject unsupported `DSYNC`, `RSYNC`, and `SYNC` flags with `ENOTSUP` before changing files or descriptors. Explicit `fd_sync` and `fd_datasync` continue to invoke the backend barrier.
  - The Node WASI adapter accepts `DSYNC` and `SYNC` at open when the corresponding native flags are available. It rejects `RSYNC`, unavailable flags, and attempts to change synchronous flags on an open descriptor. It reports tracked WASI flags so a guest can update other descriptor flags.
  - Browser `runtime_fs.path_filestat_set_mode` and `runtime_fs.fd_filestat_set_mode` change regular-file and directory mode bits and update the inode's `ctime`, including across hard links or through a retained unlinked descriptor. Separate descriptor rights gate each operation and regular-file reopen preserves the source descriptor's mode-right restrictions.
  - Inode metadata, persistent storage, and workspace archives support mode masks `0777` for regular files and `01777` for directories. Creation and saved-metadata defaults remain `0600` and `0700`. Owner bits govern effective read, write, and directory-search access, and the program registry continues to govern executable admission.

## 0.0.157

### Patch Changes

- 2f1bdf9: Add existing-only IndexedDB opens, advisory file locks, guest pseudoterminals, virtual `/etc/machine-id`, public `filesystem.stat`, and browser transport and multi-tab fixes.
  
  - `IndexedDBStorage.open` and `IndexedDBStorage.openCommitted` accept `createIfMissing: false` to open an existing database without creating a new one. If the database is absent, Waffle aborts the upgrade transaction while holding the maintenance lock, waits for cleanup before releasing the lock, and rejects with `IndexedDBStorageMissingError` without allocating epoch 1.
  - `runtime_fs.fd_flock` and `runtime_fs.fd_lock` add inode-keyed advisory file locks for open-file-description whole-file locks, POSIX process-scoped byte-range locks, and Linux OFD byte-range locks.
  - `runtime_proc.pty_open`, `runtime_proc.pty_resize`, and `runtime_proc.pty_size` let guests open bidirectional pseudoterminal pairs, update shared geometry with an atomic resize sequence, and read back `[cols, rows, seq]`.
  - Guests can read a stable, read-only 33-byte virtual `/etc/machine-id` derived from the workspace UUID or set with `machineId` on filesystem or WASI options, and pages can read it from `runtime.filesystem.machineId`.
  - `runtime.filesystem.stat` returns single-path `PathStat` metadata without reading file bytes or listing directory children, and the package exports `PathStat` and `StatOptions`. Failed `SharedFilesystem` mutations no longer replay their errors onto later `drain()` calls because each mutation promise owns its own rejection.
  - `SharedFilesystem` caps concurrent host async requests at 256, one quarter of the 1,024-request transport quota, and queues extra callers in FIFO order so bursts do not exhaust the quota or block overflow `take` follow-ups.
  - Multi-tab Host and Peer handling renews a lapsed Host lease on Peer reads, writes, `statPath`, `flush`, and `chunk-get` instead of failing with `ECANCELED`. Terminal Host failures cancel the background checkpoint timer and stop stale `ok: true` Peer replies, and runtime disposal finishes cleanly after shared-host ownership loss.
  - `PreviewRouter` adds `close()`, tracks and closes open socket tunnels on unregister, server replacement, or peer close, and sends liveness pings configured with `socketPingIntervalMs` and `socketMissedPings` to drop silent tunnels.

## 0.0.156

### Patch Changes

- 5b04bb4: `PersistentBackend` now detects sequential cold descriptor scans and fetches a page-aligned 1 MiB readahead window (bounded to half the cold-read cache budget and clamped to EOF) into `ColdReadCache` in one storage read, reducing storage round trips when sequentially reading large cold files while keeping the 64 KiB transport page size unchanged.
- b329a95: Guests can check a list of candidate paths in one filesystem request with the new `runtime_fs.path_probe` import, which returns the first one that names a regular file or a directory. Module resolvers use it instead of one stat round trip per candidate.

## 0.0.155

### Patch Changes

- b9cf302: `IndexedDBStorage` now tracks recovery payload roots in O(1) via `PayloadSizes` instead of rescanning the entire tree, both bases, and every journal on every commit, runs payload chunk SHA-256 digests with bounded concurrency without copying owned single-chunk buffers a third time, clones persistence batches directly instead of calling `structuredClone` over `upserts`, and writes new payload keys directly after the epoch check without per-key `data.get` lookups.
- 2f96081: A persistent workspace under load no longer fails filesystem calls with `ECANCELED` ("host lease expired") during a large write burst such as `bun install`. The Host's lease check no longer waits for the workspace's own IndexedDB checkpoint to finish, and a call whose lease lapses between two checks renews it instead of failing.
- 03b4fec: Add bounded batched `watchDrain` and `runtime_fs.watch_next` with O(1) watch readiness tracking so guests with many open watches drain only ready subscriptions without per-watch polling round trips.

## 0.0.154

### Patch Changes

- b24d6b2: `PersistentBackend` now reconciles dirty-admission debt after a commit even when concurrent writes arrived while storage was persisting, maintains namespace metadata bytes incrementally in O(1), and skips idle background checkpoint ticks when nothing changed. Cold package installs no longer accumulate stale dirty debt across completed checkpoints and stall in `waitForDirtyCapacity`.
- 444fd2e: A filesystem client no longer sends a discard message for a reply the service keeps nothing for: an inline reply to stat, create, write, append, grow, resize, setTimes, setMode, read or readlink. Resolves, stages, walks, watches, workspace reads and overflowing replies are still discarded at once, as before. Requests also omit an absent publication admission, so the service decodes them on the plain JSON path.
- 18e9436: Listing the registered files of a shared filesystem no longer walks the whole 32,767-slot identity table each time. Persistent checkpoints and clean-cache eviction use that list, and it now comes from a per-state index checked against the table's registered-slot count.
- 8bd8e78: Filesystem requests no longer wake every connection's revocation watcher. Revocation, reap and transport failure now also bump a second word in the shared signal, and the fs worker's per-session watchers and the clients' revocation monitors wait on that word alone. A package install's fs worker used to take about five extra tasks per request just to re-check revocation.
- b15d5db: The filesystem service no longer rescans every transient capability after each request. A scan runs only when the set is over its bound, when something was unlinked since the last scan, or while an unlinked capability is still referenced. Unlinked files are still collected as soon as their last reference goes.
- 423ec71: The first read of a file from a saved IndexedDB workspace takes one transaction instead of one for the manifest plus one per 64 KiB chunk, and looking up a stored file's size no longer scans the whole file tree. Every chunk is still checked against its stored SHA-256 checksum before any byte is returned.
- e6f8031: Reopening a saved IndexedDB workspace reads every stored file's manifest in one request instead of one transaction per file. A 17,000-file workspace now opens in about 0.4 to 0.7 s instead of 2 to 5 s in Chromium, Firefox and WebKit.
- b30cf56: A persistent workspace no longer fails running filesystem calls with `ECANCELED` ("host lease expired") when its lease renewal timer runs late behind a long task. The Host renews the lease and retries the call. A call still fails when another tab has taken over, the Host is stepping down, or the workspace is closing.
- 2954b6f: A page now runs one notification relay Worker for all its processes instead of one per process, and the relay waits on filesystem, network and process words only while a process is blocked in a notification wait. A process that never blocks there, such as Bun on the Browser engine, starts no blocking-wait Workers and costs the relay nothing. Filesystem revocation and reap now advance the watch word as well as notifying it.
- 07e624e: Guests can ask for a canonical path in one filesystem request with the new `runtime_fs.path_realpath` import, instead of one `path_readlink` per path component.
- 2522750: `PreviewServer.request()` takes an optional `{ signal }`. Aborting it closes the guest server's connection for that one request, and the sink hears nothing more.

## 0.0.153

### Patch Changes

- b1b3746: `startCommand` now gives the command pipes for the standard descriptors it provides, as a captured command gets on Unix, so `isatty` is false and programs do not colour their captured output. Pass `terminal: true` to present them as a terminal instead.

## 0.0.152

### Patch Changes

- 7f79856: Multi-tab `flush()` and descriptor `sync()` now enforce strict barrier ordering on both Host and Peer tabs: barriers wait for earlier in-flight writes (including cold file hydration, dirty-capacity retries, chunked uploads, and failover queues) and hold later Host or Peer writes behind active barriers. Cancelled cold writes and chunked uploads abort before committing and release staged Host upload buffers via settlement-tracked aborts, and `FilesystemService` retains descriptor `sync()` targets until the barrier settles so an immediate `release()` cannot invalidate a queued sync.
- 665ec3f: `activated()` no longer hangs in WebKit when two pages register the same service worker at once. A worker already in the registration's active slot now counts as activated; only an installing or waiting worker is awaited.

## 0.0.151

### Patch Changes

- 9434640: Processes can now check whether another process or job exists without sending a signal, like POSIX `kill(pid, 0)`. `runtime_proc.kill(pid, 0)` checks an execution handle, `runtime_proc.kill_job(job, 0)` checks a job, and the new `runtime_proc.probe_process(pid)` checks a logical PID. Each returns `0` when the caller can signal the target or fails with `EPERM` when the target exists in the same root outside the caller's control. Missing targets and targets in another root fail with `ESRCH`. Exited processes still exist until collected. Probes wake nothing and change no state.

## 0.0.150

### Patch Changes

- 41cbd84: Support regular-file reads, writes, appends, and worker error diagnostics on `MultiTabBackend` when direct shared-memory file I/O is disabled, keeping shared file offsets atomic across signals, cancellation, and host failover. Also prevent unrelated filesystem wakeups from delaying or outliving `poll` deadlines, fix multi-buffer reads with empty leading iovecs, and expand file-descriptor conformance coverage across all storage backends.

## 0.0.149

### Patch Changes

- b20308c: Add `startCommand` options to run cooperative compiled guest modules, such as Bun, with `programs: "guest"` and to stop the remaining process tree when the first process exits with `onLeaderExit: "stop"`. Both options preserve the existing behavior by default.

## 0.0.148

### Patch Changes

- c0cc42a: Add multi-tab shared persistent filesystem support via `whenBusy: "attach"`. Multiple same-origin tabs can attach to, read, write, and watch the same live IndexedDB or OPFS workspace with automatic host election, failover, and cross-tab `fs.watch` propagation.

## 0.0.147

### Patch Changes

- 89049f7: Pipelines between programs no longer move one write every 4 ms: the page's pipe relay yields with a message-channel task instead of a clamped zero-delay timer. Guests that poll for signals between work steps no longer pay for two full scans of the signal table when nothing is pending.
- 492d6bf: Small writes and package installs run faster. Repeat reads of unchanged stored files can use an in-memory cache, and the client keeps path lookups cached through large builds. The npm package no longer includes tests, and the pipe registry reserves less memory. Opt-in Wasm trap diagnostics can annotate trap frames with function names.
- 26bb243: Symbolic links with absolute targets now work when a process's `/` is the filesystem root: the target is followed from `/`, `..` climbs above the starting directory and stops at `/`, and more than 40 links in one lookup fail with `ELOOP`.
- 15658cc: Keep thread, terminal and GPU waits and filesystem teardown moving on WebKit, which can lose the wake for an `Atomics.waitAsync`.

## 0.0.146

### Patch Changes

- 4e70af9: Expose startup markers for runtime initialization.
