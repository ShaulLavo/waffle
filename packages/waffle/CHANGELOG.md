# @waffle-os/runtime

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
