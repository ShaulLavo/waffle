---
"@waffle-os/runtime": patch
---

Add existing-only IndexedDB opens, advisory file locks, guest pseudoterminals, virtual `/etc/machine-id`, public `filesystem.stat`, and browser transport and multi-tab fixes.

- `IndexedDBStorage.open` and `IndexedDBStorage.openCommitted` accept `createIfMissing: false` to open an existing database without creating a new one. If the database is absent, Waffle aborts the upgrade transaction while holding the maintenance lock, waits for cleanup before releasing the lock, and rejects with `IndexedDBStorageMissingError` without allocating epoch 1.
- `runtime_fs.fd_flock` and `runtime_fs.fd_lock` add inode-keyed advisory file locks for open-file-description whole-file locks, POSIX process-scoped byte-range locks, and Linux OFD byte-range locks.
- `runtime_proc.pty_open`, `runtime_proc.pty_resize`, and `runtime_proc.pty_size` let guests open bidirectional pseudoterminal pairs, update shared geometry with an atomic resize sequence, and read back `[cols, rows, seq]`.
- Guests can read a stable, read-only 33-byte virtual `/etc/machine-id` derived from the workspace UUID or set with `machineId` on filesystem or WASI options, and pages can read it from `runtime.filesystem.machineId`.
- `runtime.filesystem.stat` returns single-path `PathStat` metadata without reading file bytes or listing directory children, and the package exports `PathStat` and `StatOptions`. Failed `SharedFilesystem` mutations no longer replay their errors onto later `drain()` calls because each mutation promise owns its own rejection.
- `SharedFilesystem` caps concurrent host async requests at 256, one quarter of the 1,024-request transport quota, and queues extra callers in FIFO order so bursts do not exhaust the quota or block overflow `take` follow-ups.
- Multi-tab Host and Peer handling renews a lapsed Host lease on Peer reads, writes, `statPath`, `flush`, and `chunk-get` instead of failing with `ECANCELED`. Terminal Host failures cancel the background checkpoint timer and stop stale `ok: true` Peer replies, and runtime disposal finishes cleanly after shared-host ownership loss.
- `PreviewRouter` adds `close()`, tracks and closes open socket tunnels on unregister, server replacement, or peer close, and sends liveness pings configured with `socketPingIntervalMs` and `socketMissedPings` to drop silent tunnels.
