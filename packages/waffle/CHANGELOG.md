# @waffle-os/runtime

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
