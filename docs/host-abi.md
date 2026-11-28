# Waffle host ABI

Waffle exposes browser-side capabilities to WebAssembly guests without requiring a second runtime owner. The page creates one `createRuntime()` instance, and workers receive borrowed filesystem and process capabilities through explicit bootstrap messages.

## Ownership

`SharedFilesystem` owns the worker, storage backend, identity allocator and service lifetime. A process receives a `FilesystemIdentity` and descriptor bindings; it never receives the page's filesystem owner or its disposal method. `Runtime.dispose()` fences admitted filesystem work, stops consumers only after quiescence, closes owned services last, and releases the duplicate-bundle ownership guard.

## Host filesystem writes

`SharedFilesystem.writeFile(path, data, mode)` accepts the legacy boolean append mode and the
options form `{ append?: boolean, exclusive?: boolean }`. `{ exclusive: true }` performs an
atomic create: the service reuses the same exclusive `MemFS.create` path as WASI and returns
`EEXIST` (errno 20) when the target is an existing file or directory. The filesystem service
queue serializes the existence check and insertion, so concurrent exclusive writers have one
winner. Missing parent directories retain the host API's existing `mkdirp` behavior. Append and
exclusive modes cannot be combined; ordinary writes continue to replace existing file contents.
The operation is shared by memory, IndexedDB and OPFS backends.

`SharedFilesystem.remove(path)` removes the entry at `path` without following a final
symlink, recursively for a directory, and resolves `false` when nothing exists there.
`remove(path, { ifContent })` removes only a regular file whose bytes equal `ifContent`. The
expected bytes are copied when the call is made. The service compares and removes in one
planning step under the global mutation lock, reading the file under its own lock, so a host
write lands wholly before the check (and the remove is skipped) or after it. A guest writing
through a descriptor it already has open writes to the unlinked file, as after any remove. A
missing path, a directory, a symlink or different bytes resolve `false` and change nothing.
A non-`Uint8Array` condition rejects with `TypeError`, and a malformed condition at the service
boundary fails with `EINVAL` (28). Persistent backends load a cold file's bytes before
comparing. If the bytes still aren't resident, the call fails with `ENOTSUP` (58) rather than
removing unchecked.

## Process admission

`BrowserProcessBroker` reserves identities and descriptor bindings synchronously, then activates the lazy supervisor. Worker bootstrap receives a compiled module, argv, environment, filesystem connection and optional process transport. Source bytes must pass interruption admission; a precompiled module is accepted only with explicit cooperative execution.

## WASI clocks

The browser WASI adapter supports REALTIME (0) and MONOTONIC (1). Both clock getters
return `EINVAL` (28) for process/thread CPU clocks (2/3) and unknown clock IDs,
without changing the output. Browsers expose no CPU-time clock. Invalid output
spans return `EFAULT` (21). Poll clock subscriptions use the same supported IDs;
unsupported clocks produce events with `EINVAL`. Native Node WASI clock getters
remain provided by Node and measure host process/thread time, not per-guest totals.

## File times

`fd_filestat_set_times` and `path_filestat_set_times` follow `utimensat(2)`. Each time is set
independently: `ATIM` or `MTIM` takes the given value, `ATIM_NOW` or `MTIM_NOW` takes the
filesystem clock, and neither leaves that time unchanged. A time with its `NOW` flag, or an
unknown flag bit, is `EINVAL` (28). With no time selected the call changes nothing. Any change
also sets ctime to the current time. Setting times needs no write permission: the one guest
principal owns every inode, and the owner may set times on a read-only file, as on Linux.

Filestat records report atime, mtime and ctime separately, with the full unsigned 64-bit
nanosecond value a guest set, including across reloads of OPFS and IndexedDB workspaces. The
filesystem clock has millisecond granularity. Writes and truncation set mtime and ctime; mode
changes and adding or removing a name set ctime. Reads do not update atime, as on Linux mounted
with `noatime`. Host-facing workspace metadata reports mtime in whole milliseconds.

## Process identity import

### Initial process cwd

`runtime_proc.cwd(buf_ptr: i32, buf_len: i32) -> i32` returns the caller's initial
cwd as a full UTF-8 byte count, excluding any NUL terminator. It writes the bytes
only when the count fits `buf_len`. A zero-capacity query or short buffer writes
nothing; no prefix or terminator is copied. The guest can query, allocate, and call
again. The path is preserved exactly, without normalization or filesystem lookup.

Both arguments use unsigned i32 address/length semantics. Every call validates the
whole supplied memory span, including zero-capacity queries and short buffers:
`ptr == memory size, len == 0` is valid; a pointer past memory or a span extending
past it returns `-EFAULT` (`-21`). Invalid non-i32 JavaScript arguments return
`-EINVAL` (`-28`). Memory is reacquired after reading process metadata, and caller
liveness is rechecked before copying. A dead, disposed, collected or foreign
worker-process caller returns `-ESRCH` (`-71`). Other failures retain signed WASI
errno. No output is written on failure. Existing fatal process guards may unwind
before the import runs rather than resume a guest with a selected fatal outcome.

The import reads only the authenticated caller's immutable process metadata. It
does not read or change `env`, `PWD`, the filesystem, or libc's current directory.
Spawn cwd must be absolute, NUL-free and representable as UTF-8. Direct roots set
it with `createRoot({ cwd })` / `reserveRoot({ cwd })`; shared roots set it with
`createWorkerProcessTransport({ cwd })`, and `adoptRuntimeRoot` retains that value
through lazy supervisor activation. Only omitted root cwd defaults to `/`.
Embedders with a real root cwd must pass it at root creation. Children snapshot
`SpawnRequest.cwd` into their existing transport and supervisor record.

This is a bootstrap query seam. The consuming guest must initialize its real libc
cwd before running application code; this import alone does not initialize it.

### PID

`runtime_proc.getpid: () -> i32` returns the caller's execution handle E. Waits,
signals, jobs and execution ancestry use that handle, including for a thread member.
`runtime_proc.process_id: () -> i32` returns the logical process PID P, and
`runtime_proc.parent_process_id: () -> i32` returns its immutable creation-parent PID Q.
P is positive; Q is zero for a root. All IDs fit a signed i32.

An ordinary child receives a fresh P equal to E and Q equal to its caller's P.
A spawn with `processKind: "thread"` receives a fresh E and copies the caller's whole
P/Q pair, including for nested threads. Omission or `"process"` selects an ordinary
process. Other values return `-EINVAL`. Opaque `worker` payload never selects membership.
The caller cannot choose another process to join. Parent or leader collection leaves
every admitted pair unchanged; this is creation ancestry, without dynamic reparenting.

`ProcessABIOptions.processIdentity` is required. The provider captures a frozen pair at
construction. These three scalar queries take no arguments, access no guest memory,
never wait, allocate nothing and send no service or broker request. They work before
module start without activating the supervisor. Existing worker fatal guards still apply.

## Descriptor kind import

`runtime_proc.fd_kind(fd: u32) -> i32` looks up the caller's current descriptor table
and returns the underlying resource's kind, or `-EBADF` (`-8`) for an invalid,
closed or never-opened fd. It is nonblocking and non-consuming: it reads no payload,
does not retain the endpoint or change the shared cursor, and requires no descriptor rights.
Inherited, duplicated and remapped bindings report the real underlying resource, not a
kind inferred from WASI preview1's filetype (which has no FIFO value).

| Value | Kind                                |
| ----: | ----------------------------------- |
|     0 | Other / unknown                     |
|     1 | Pipe (either runtime_proc endpoint) |
|     2 | Terminal                            |
|     3 | Regular file                        |
|     4 | Directory                           |
|     5 | Socket stream                       |

These values are append-only: existing numbers must never be reused or renumbered.
Guests must not interpret preview1 `UNKNOWN` as a pipe.
The shared `ProcessABI` exposes the import in host and worker process adapters;
the browser's signal-only worker namespace also exposes it without activating the
process service. The descriptor number itself (including stdio 0, 1 and 2) never
determines its kind.

## Guest pseudoterminals (PTY)

Guests can allocate bidirectional pseudoterminal pairs via `runtime_proc` without host-page
terminal intervention, enabling runtimes such as `bun-wasm` (`Bun.Terminal`) to attach real
interactive PTYs to spawned child processes.

- `runtime_proc.pty_open(cols: i32, rows: i32, out_ptr: i32) -> i32`:
  Allocates a paired `[master_fd, slave_fd]` backed by two shared pipe rings (`master -> slave`
  and `slave -> master`) and one 16-byte shared geometry control block, writing `master_fd` at
  `out_ptr + 0` (`u32 LE`) and `slave_fd` at `out_ptr + 4` (`u32 LE`).
  `cols` and `rows` must be integers in `1..65535` (otherwise `-EINVAL`, `-28`). An out-of-bounds
  `out_ptr` returns `-EFAULT` (`-21`) without leaking descriptors.
  - `slave_fd` reports `fd_kind === 2` (`terminal`), WASI `fd_fdstat_get` filetype `FT_CHAR` (2),
    and omits `RIGHT_FD_SEEK`/`RIGHT_FD_TELL`, so `wasi-libc` `isatty(slave_fd)` returns `1`.
  - `master_fd` reports `fd_kind === 1` (`pipe`), non-character filetype, so `isatty(master_fd)`
    returns `0`.
  - Both endpoints support full-duplex blocking WASI `fd_read`/`fd_write`, nonblocking
    `runtime_proc.read`/`write` and `FDFLAG_NONBLOCK`, `runtime_proc.poll` / `poll_oneoff`,
    and inheritance across `spawn` and `exec`. EOF on `master_fd` occurs only when the last open
    `slave_fd` across child and descendants closes (and vice versa).
- `runtime_proc.pty_resize(fd: i32, cols: i32, rows: i32) -> i32`:
  Updates the shared geometry on either `master_fd` or `slave_fd`, atomically increments the
  resize sequence counter, and notifies the PTY's shared wake word. Returns `0`, `-EINVAL` (`-28`)
  for out-of-range dimensions, `-EBADF` (`-8`) for a closed descriptor, or `-ENOTTY` (`-59`) for a
  non-PTY descriptor.
- `runtime_proc.pty_size(fd: i32, out_ptr: i32) -> i32`:
  Writes a consistent 12-byte snapshot `[cols: u32 LE, rows: u32 LE, seq: u32 LE]` at `out_ptr`
  from either `master_fd` or `slave_fd`. Returns `0`, `-EFAULT` (`-21`), `-EBADF` (`-8`), or
  `-ENOTTY` (`-59`).

## Inherited descriptor list

`runtime_proc.inherited_fd(index: u32) -> i32` returns the `index`th descriptor the process
started with, in ascending numeric order, or `-ENOENT` (`-44`) past the end. The list is a
snapshot taken in the worker after launch bindings are installed (and after an executor's
`beforeBindings` hook) and before instantiation: open stdio and every `runtime_proc` binding at
its child number, excluding preopened directories. Later `dup`, open or close calls do not
change it. It reports numbers only; use `fd_kind` for the kind and `dup` to take a reference.
Programs that forward descriptors to a child or resolve `/dev/fd/N` use this list instead of
probing a descriptor range. Sparse bindings cost one entry each. Runtime child workers start
with stdio closed unless a binding targets fd 0, 1 or 2; a page-root worker retains its default
stdio terminals.

## Reopen an existing descriptor

`runtime_proc.fd_reopen(fd: u32, oflags: u32, fdflags: u32, rights_base: u64, out_fd_ptr: u32) -> errno`
returns **positive WASI errno**, or zero after writing the lowest free fd as a little-endian
`u32`. The output span is checked before opening or truncating anything (`EFAULT`, 21).
`oflags`, `fdflags` and rights use the same bits as preview1 `path_open`; inheriting rights
are zero for this import. `fd_kind` on success reports the source's kind.

For regular files, the new description retains the same inode, even after unlink, starts
at offset zero, and owns its flags independently of the source description. `TRUNC` resizes
the inode to zero, `APPEND` selects EOF for each write, and fdstat retains `NONBLOCK`.
Browser `path_open`, `fd_fdstat_set_flags`, and `runtime_proc.fd_reopen` return `ENOTSUP`
(58) for `DSYNC`, `RSYNC`, or `SYNC` before changing files or descriptors. The Node WASI
adapter permits `DSYNC` and `SYNC` at open when Node exposes the corresponding host flags.
It returns `ENOTSUP` for `RSYNC` and unavailable synchronous flags before opening the file,
and for any change to synchronous flags via `fd_fdstat_set_flags`. It reports WASI flags
for the shared open description.
Explicit `fd_sync` and `fd_datasync` still invoke the backend barrier. `CREAT` or `EXCL` returns `EINVAL` (28),
`DIRECTORY` returns `ENOTDIR` (54), and unknown flag bits return `EINVAL`.

Regular-file reopen checks [inode access policy](permissions.md) for read and write access.
A write-only descriptor can reopen for reading when the inode permits reading. The caller's
live `/` preopen must carry `PATH_OPEN`, every requested right must fit the root preopen's
inheriting rights, and `TRUNC` requires the root preopen's `PATH_FILESTAT_SET_SIZE` right.
The source descriptor must also carry any requested [mode-mutation rights](#inode-mode-mutation)
in the corresponding base or inheriting mask. A missing root preopen or missing right returns
`ENOTCAPABLE`, errno 76.

Pipes, terminals, sockets and directories receive a new binding to the **same** description, like
`dup`, rather than a new cursor or flags. Requested rights must fit the source's rights
(`EACCES`); directory truncation returns `EISDIR` (31). Invalid or closed descriptors
return `EBADF` (8). Both process adapters and signal-only browser workers expose the import;
it does not require a spawn or process-service activation.

### Descriptor path behaviour

WASI `path_open` recognizes `/dev/fd/N`, `/proc/self/fd/N`, `/dev/stdin`, `/dev/stdout`
and `/dev/stderr`, plus normalized relative equivalents, only through the `/` preopen
or a directory binding for the filesystem root. Other directory bindings use ordinary
filesystem resolution. Root and any existing real ancestor directories still require
search permission; absent ancestors belong to the virtual namespace. Traversal checks
components before processing `.` or `..`; absolute link targets and `..` follow the
[symbolic link rules](#symbolic-links) of ordinary filesystem resolution. A trailing slash or `/.`
requires a directory source (`ENOTDIR`, 54, otherwise), before any truncation. They resolve
against the **calling process's current descriptor table**, including inherited/remapped
stdio and fd 3 when the root preopen has moved. They use the same reopen operation,
while also checking the path-open directory's rights and the requested inheriting rights.
A missing descriptor returns `ENOENT` (44), not `EBADF`. These are WASI-only virtual names:
no per-process entries or symlinks are installed in shared MemFS.

A `wasi-libc` pathname open requests rights derived from the root preopen's inheriting mask,
which includes both extended [mode-mutation rights](#inode-mode-mutation). When `path_open`
reopens a regular-file descriptor alias, Waffle keeps requested mode-mutation bits that the
source descriptor holds in the corresponding base or inheriting mask. The other requested
rights still need authorization from the live root preopen and inode policy. Explicit
`runtime_proc.fd_reopen` calls return `ENOTCAPABLE`, errno 76, when the source descriptor
lacks a requested mode right.

A regular-file stdout/stderr opened with `APPEND` does not force a later reopen to append.
For example, redirecting `echo x >/dev/stderr` with `TRUNC` leaves exactly `x\n`, even when
stderr's original description had `APPEND`. Reopening with `APPEND` (`>>`) preserves old
bytes and appends `x\n`. Neither operation advances the source description's offset or
changes its flags. Pipes and terminals keep shared-stream behaviour.

### Symbolic links

A browser worker running over the whole filesystem preopens the filesystem root as `/`. When
a process's `/` preopen opened the filesystem root (however its path is spelled), every
Preview1 path call resolves the way Linux does inside that namespace. Path arguments are still
relative to the directory descriptor they name. The decision is taken at guest entry, after
exec has installed the descriptors it keeps, and holds for the life of the process image even
if the guest later closes or renumbers the `/` preopen. File-scoped resident workers start with
no preopen and are never rooted.

- An absolute link target names a path from `/`, so resolution restarts at the filesystem root.
- `..` climbs above the directory a call starts from, up to `/`, where it stays. A descriptor
  for a directory that has since been removed still climbs to the parent it had, as on Linux;
  names inside the removed directory return `ENOENT` (44).
- A lookup that follows more than 40 links returns `ELOOP` (32); 40 is allowed.
- `path_readlink` returns the target exactly as written.
- Calls that do not follow the last component leave a final link alone: `path_filestat_get`
  and `path_open` without the follow flag (`path_open` then returns `ELOOP`), unlink, rmdir
  and rename. A trailing slash demands a directory, so stat, open and readlink follow a final
  link when the path ends in `/` (readlink of `link/` then returns `EINVAL`, 28), while unlink,
  rmdir and rename return `ENOTDIR` (54) for it.
- For `path_open`, a path that reaches `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`,
  `/dev/fd/N` or `/proc/self/fd/N` through a link or `..`, from any directory, opens the same
  virtual entry as spelling that path out; a physical file at one of those paths never stands
  in for it. Lookups continuing below a directory descriptor's alias (`/dev/fd/N/name`) use
  that directory and its real parent, within the same 40-link budget.

### Virtual `/etc/machine-id`

Waffle serves a stable, read-only virtual `/etc/machine-id` following `machine-id(5)`: 32 lowercase
hexadecimal characters plus a trailing newline (33 bytes, regular file, mode `0444`).

- **Stability & source:** Derived deterministically from the filesystem workspace UUID (which
  persists across browser reloads, restarts, and multi-tab failover on IndexedDB and OPFS backends)
  or set explicitly via `filesystem.machineId` / `WasiOptions.machineId`. Published lock-free in the
  shared filesystem root header so all workers and spawned processes observe the same value, and
  readable from the page via `runtime.filesystem.machineId`.
- **Empty root preserved:** No `/etc` directory or `/etc/machine-id` node is created in the VFS tree.
  `stat("/etc")` still returns `ENOENT` unless a physical `/etc` exists.
- **Physical override:** Unlike `/dev/null`, a real file or symlink created at `/etc/machine-id`
  always takes precedence over the virtual fallback. If a physical `/etc` directory exists without
  `machine-id`, both `/etc/machine-id` and `openat(etcFd, "machine-id")` serve the virtual file
  while still enforcing `/etc`'s search permissions.
- **WASI & host calls:** `path_open` (read-only), `path_filestat_get`, `path_permissions_get`,
  `path_probe`, `path_realpath`, `fd_fdstat_get`, `fd_filestat_get`, `fd_read`, `fd_pread`,
  `fd_seek`, `fd_tell`, `fd_dup`, `fd_reopen`, and `runtime_proc.fd_kind` (returns `3`, regular
  file) all support virtual `/etc/machine-id`. Write, truncate (`O_TRUNC`), and `fd_filestat_set_size`
  return `EACCES` (2); `O_CREAT | O_EXCL` returns `EEXIST` (20); `O_DIRECTORY` or a trailing slash
  returns `ENOTDIR` (54).

The same rules hold on every filesystem backend, since they all resolve through one tree.
Any other preopen layout, such as `/` mapped to a subdirectory or only non-root preopens,
keeps each lookup beneath the directory it starts from: an absolute target or a `..` that
would leave it returns `EPERM` (63).

## Cooperative descriptor opens

Guests with a logical descriptor table use these `runtime_fs` imports. Both return zero on
success or a positive WASI errno.

```text
path_open_cooperative(dirfd:u32, dirflags:u32, path_ptr:u32, path_len:u32, oflags:u32,
                      rights_base:u64, rights_inheriting:u64, fdflags:u32,
                      expected_alias:i64, out_ptr:u32) -> i32
fd_reopen_alias(fd:u32, oflags:u32, fdflags:u32, rights_base:u64, out_fd_ptr:u32) -> i32
```

`path_open_cooperative` requires the live `/` preopen backed by the filesystem root and a
relative UTF-8 path free of NUL bytes. It validates the pathname and the full eight-byte
result span before lookup. Directory search permissions and the symlink limit apply to
the original components. The filesystem holds the final inode and parent through the open.

An `expected_alias` of `-1` requests an ordinary open. Its result is two little-endian
`u32` words `[0, fd]`. Ordinary lookup includes `/dev/null` and virtual `/etc/machine-id`.

An `expected_alias` in `0..0xffffffff` confirms a direct logical alias and returns
`[1, logical]`. Direct aliases include `dev/stdin`, `dev/stdout`, `dev/stderr`, `dev/fd/N`,
and `proc/self/fd/N`, with repeated slashes or interior dots allowed. Confirmation rejects
`O_CREAT` and `O_EXCL` and performs no open or truncate. A mismatched or indirect alias
returns `ENOTCAPABLE` (76). Alias continuation or a trailing slash returns `ENOTDIR` (54).
A backend without guarded lookup support returns `ENOTSUP` (58).

After confirmation the guest resolves the logical number in its own table and passes the
retained endpoint’s WASI descriptor to `fd_reopen_alias`. Reopen checks the live root
preopen’s `PATH_OPEN` and inheriting rights, plus `PATH_FILESTAT_SET_SIZE` for truncation.
It rejects create and exclusive flags. Regular files reopen at offset zero with inode
access checks. Streams and virtual files intersect rights with the source description.
Standard Preview 1 `path_open` retains its four-byte result and process descriptor semantics.

## Executable access queries

`runtime_proc.access_start(path_ptr, path_len, cwd_ptr, cwd_len, mode)` copies both UTF-8
strings before returning. `cwd` must be absolute and `mode` must be X_OK (`1`); other modes,
invalid UTF-8, empty strings and NUL bytes return `-EINVAL` (`-28`). The returned positive
request ID belongs to the calling process. `access_take(request)` is `-EAGAIN` (`-6`) until
the asynchronous registry/filesystem check publishes, then consumes the request and returns
zero or `-ENOENT` (`-44`), `-EACCES` (`-2`), or `-ENOTDIR` (`-54`). `access_cancel` retires
ownership and causes a late completion to be discarded. Unknown or consumed IDs return
`-EBADF` (`-8`). There are at most 64 live requests per process, and process death retires
all of them. Queries call the same live `ExecutableRegistry.check(name, cwd)` used by spawn,
without activating the module loader, supervisor, filesystem descriptors, or process launch.
The result is point-in-time: spawn checks the live file and registration again, so an earlier
success cannot authorize an unlinked or unregistered program. Other filesystem failures retain
their WASI errno (unexpected failures are EIO, never invented ENOENT).

The process broker owns worker requests because the filesystem worker has no executable registry.
Reusing filesystem request kind 3 would couple storage to the optional process/module graph.
Cooperative in-process guests use the same imports through their existing `ProcessSupervisor`,
with the same registry check, result codes, 64-request bound and take/cancel/death ownership.
Request maps and worker completion cells are created only on first use; there is no registry
snapshot or activation of another supervisor. The imports never await, call `Atomics.wait`,
compile, spawn, or allocate descriptors.

Poll kind 5 subscribes to an executable query request ID. Both adapters store the result before
publishing completion and increment their ABI's common wake sequence only after publication,
so a completion racing `poll` cannot be lost. `ProcessABI` forwards its supplied shared `wake`
word to the in-process query service; worker clients use their process directory's wake word.
Cancellation and process death do not publish a late completion.

## Process image replacement

`runtime_proc.exec(ptr: i32, len: i32) -> i32` replaces the calling process's
executable. The UTF-8 JSON request is `{ executable, argv, env, cwd, fds }`, with
the same executable lookup, shebang handling, argument rewrite, environment policy,
and `{ parent, child }` descriptor bindings as spawn. The environment and descriptor
list are complete. Supplying `job`, `jobLifetime`, `worker`, or `processKind` returns `-EINVAL`.

Success unwinds the old image and never returns to it. The PID, parent, job,
children, waiters, cancellation authority, signal cells, and outcome remain owned
by the same process. The old Worker and its memory admission ticket stop before
the replacement's memory is admitted. The parent's wait and job cleanup observe
only the final image's result. Replacement does not publish process native return
or terminal stop between images.

Exec also preserves P/Q. A thread-kind caller or a leader with another logical member
returns precommit `-ENOTSUP`. Published undelivered reservations and pending adapter
acquisitions count. Cancellation, selected exit and logical collection do not release
membership; owned no-consumer rollback or full cleanup including native return does.
A completed member's unconsumed result alone does not block exec. The owner neither
waits for nor terminates siblings to make exec eligible. Thread publication checks
the caller's current image and retirement before exposing its handle, on both host
and guest paths. The owner closes image admission before its final logical-sibling
check. Plain singleton exec ignores unrelated directory intents; shared-memory group
exec retains its directory-wide intent guard. Successful replacement admits threads
only from its successor image.
A thread spawn whose row is already published, but whose second admission check has
not yet run when exec closes image admission, returns `-ESRCH` even though the
caller's image stays current.

Validation, descriptor staging, executable lookup, and module loading or compilation
failures return negative WASI errno before commit. The caller remains usable, and
`spawn_error(0, ...)` contains the diagnostic for that attempt. Invalid guest spans
return `-EFAULT`. Unsupported socket bindings, roots, threaded images,
and executors without an owned Worker return `-ENOTSUP`. A service without exec
returns `-ENOSYS`; a missing common wake or revocation registration returns
`-ENOTSUP`. Each attempt clears the previous diagnostic.

Reservation, Worker construction, adapter setup, instantiation, and other failures
after commit end the process with ordinary exit status 126 and a host diagnostic.
A previously selected fatal signal keeps its outcome. Handled signal dispositions
reset to default, ignored dispositions stay ignored, and a pending terminating
signal prevents replacement launch. Handled signals are not consumed while the
import waits.

A shared-memory caller can replace itself only with a fully resolved target registered
through `Runtime.registerHostAdapter`. The exact current non-root Worker must be the
group's sole launched member. Reserved or retained members and unresolved same-directory
spawn or adapter acquisitions cause precommit `-ENOTSUP`. The owner orders this check
against concurrent spawn intents and closes the group to later joins in one synchronous
transition, after target lookup and before signal reset. It never cancels an earlier join
or waits for a child to finish to make the caller eligible.

The host target retains the exact program and launcher registration through lookup and
source stop. Guest JSON, environment, module contents, paths and adapter names supply no
host classification. The target cannot acquire its own guest Worker, group or typed-thread
image through the process service. It can spawn ordinary child processes. The original
group remains charged until source filesystem and controller fences, native termination,
controller stop and adapter cleanup all succeed. Any failed stop retains the old member
and its memory charge. This transition does not cancel descendants or change PID-only KILL.

### Descriptors and preopens across exec

Aliases retain one shared open description, file offset, and descriptor flags.
Pipes retain an independent same-PID lifetime for the successor, so rollback cannot
close the caller and successful replacement introduces no EOF gap. Every unlisted
descriptor closes. The successor also removes unlisted bootstrap stdio and preopens;
it does not recreate filesystem authority that the request omitted.

An explicitly listed preopen retains the source binding's name, rights, and live
filesystem capability. Preopen metadata belongs to each binding: listing a preopen
and its ordinary duplicate preserves discovery metadata only on the preopen binding.
This preservation is specific to exec; ordinary spawn keeps its existing behavior.

`inherited_fd` excludes preopens. A shell must discover or cache its live root
preopen separately and include it explicitly in the exec request. Use its original
live descriptor as `parent`. Choose the lowest free `child` descriptor at or above
3 among the final non-preopen bindings, so a hole cannot stop libc's preopen scan.
Waffle transfers the original name and reduced rights automatically; a JSON request
cannot supply or widen that metadata. Do not substitute a newly opened root.

For the default single-root bootstrap, the root is initially within fd 3 through
`3 + original inherited binding count`, including an occupied fd 3. A caller can
cache it with `fd_prestat_get` and `fd_prestat_dir_name` before its own opens and
closes create holes. The successor's `fd_prestat_get` and ordinary `path_open`
then use the explicitly retained capability. Omitting it leaves no root preopen.

## Transport contracts

Filesystem and process transports use shared-memory completion and readiness words plus message-port control. Descriptor bindings retain independent capability pins while duplicate bindings may share an open-file cursor. Termination selects one atomic outcome; cleanup acknowledgement and filesystem quiescence are separate facts.

### Descriptor and preopen placement

When a worker receives inherited descriptor bindings, every binding target is validated and reserved before the WASI descriptor table is initialized. Preopens are then placed at the lowest free descriptor at or above fd 3, skipping all reserved targets. This keeps ordinary guests at fd 3 while preserving every inherited binding's exact descriptor number, including sparse high targets.

Only descriptors created with preopen metadata are reported by `fd_prestat_get`; an inherited stream or other non-preopen descriptor returns `BADF`. The root preopen, its rights and metadata, and its filesystem retain/release ownership move together when fd 3 is reserved. Binding installation happens after this placement and before WebAssembly instantiation, so a module start section observes the final descriptor layout.

### Typed wait results

Both imports use the same consuming result shape:

```text
runtime_proc.wait(pid: i32, out: i32) -> i32
runtime_proc.wait_job(job: i32, flags: i32, out: i32) -> i32

WaitResult (8 bytes, little-endian)
offset 0: u32 kind   0 = EXITED, 1 = SIGNALED, 2 = START_FAILED
offset 4: i32 value  exit code, signal number, or positive WASI errno
```

A return of `0` means a terminal result was collected, **including START_FAILED**.
A negative return is an error of the wait call, not an executable-start errno.
Pending calls return `-EAGAIN` (`-6`). Both calls validate the entire 8-byte output
span before consuming; an output fault leaves the child/job available. Waffle
writes only kinds 0, 1 and 2; guests must reject any unknown kind as a decode error.
Actual program exits 126 and 127 remain `{kind: 0, value: 126/127}`; signals use
`{kind: 1, value: signal}`, without adding 128 in the runtime ABI.

Host/browser `ProcessExit` keeps a named `error`, Linux-style `code`, and
`status: null` for startup failures. The shared atomic startup tag remains 3;
it is separate from guest WaitResult kind 2. These are the eight produced errors:

| Error   | Host code | Guest WASI value | Cause                                                                                                     |
| ------- | --------: | ---------------: | --------------------------------------------------------------------------------------------------------- |
| ENOENT  |         2 |               44 | Missing executable or missing path component                                                              |
| EACCES  |        13 |                2 | Directory or existing file without its admitted executable registration                                   |
| ENOTDIR |        20 |               54 | A file used as a directory, including a trailing slash on a file                                          |
| ELOOP   |        40 |               32 | Bounded interpreter-script recursion or an interpreter cycle                                              |
| ENOEXEC |         8 |               45 | Invalid/unsupported Wasm at rewrite/compile, or absent/noncallable `_start` or non-memory `memory` export |
| ENOMEM  |        12 |               48 | Allocation failure during loading or host/Worker setup                                                    |
| EAGAIN  |        11 |                6 | Process/setup resource capacity exhausted after reservation                                               |
| EIO     |         5 |               29 | Other loader or host setup failure                                                                        |

The current filesystem has no symlinks or name-length limits, so it does not
produce ELOOP or ENAMETOOLONG; executing a directory uses EACCES, not EISDIR.
Loader, network, digest and arbitrary adapter exceptions are not evidence of an
invalid executable and do not become ENOEXEC. RangeError allocation failures map
to ENOMEM. Filesystem connection, Worker construction, postMessage and early
Worker error failures use EIO unless they carry a known allocation/capacity cause.

Spawn reserves synchronously and returns its PID before asynchronous executable
admission and Worker creation. Before that return, capacity failures return
`-EAGAIN` (`-6`), allocation failures return `-ENOMEM` (`-48`), and invalid requests
return `-EINVAL` (`-28`); there is no collectable child/job for a rolled-back
reservation. Explicit BADF, SRCH and CHILD authority errors stay distinct.
Filesystem capacity errors are normalized only at spawn, not other ABI calls.
After the PID return, setup failures are collected as START_FAILED with the honest
errno above; they cannot retroactively change the spawn call's return value.

The initial Worker request carries the authoritative outcome before any dynamic
process import. The instantiate phase and executor ready hook run only after
validating callable `_start` and exported WebAssembly memory. A later exit notice
or numeric completion cannot replace the atomic typed startup outcome. Errors
after execution starts remain ordinary execution failures.

The public `waffle/proc` entry exports `startFailure(error)` to normalize host setup
errors into the same typed result. Consumers must not duplicate that errno mapping.

### Spawn error details

```text
runtime_proc.spawn_error(pid: i32, buf: u32, capacity: u32) -> i32
```

This nonblocking, non-consuming query returns the UTF-8 byte count of copied diagnostic
text, without a NUL terminator. PID `0` reads this caller's latest synchronous `spawn`
failure. Every `spawn` attempt clears that value first; a successful reservation leaves
it empty. Other imports do not overwrite it. A positive PID reads a retained direct
child's startup diagnostic, with the same child authorization as `start_status`.
Read it before consuming `wait` or `wait_job`. Collection discards the diagnostic along
with the process row; it never retains a process or job just for error reporting.

The text includes error names, messages, scalar code/errno fields, up to eight nested
causes, and a bounded original stack. Unknown thrown values, circular causes and throwing
accessors remain diagnosable. Fields and total output are truncated; the final text is at
most 4,096 UTF-8 bytes and ends on a complete code point. It is diagnostic text, not a
machine-readable error schema. Errno remains the authoritative result of `spawn`,
`start_status` and `wait`; this query changes none of their values or lifecycle rules.

A zero capacity or short buffer writes nothing and returns the required count. A sufficient
buffer receives all bytes. The entire supplied span is validated even for an empty result;
an invalid span returns `-EFAULT` (`-21`). Invalid PID or non-i32 JavaScript arguments return
`-EINVAL` (`-28`). A live child without a startup failure returns zero. A producer that has
selected startup failure but has not finished copying its text returns `-EAGAIN` (`-6`);
cooperatively yield and query again without re-subscribing to an already-ready startup
notification. If the producer cannot copy its diagnostic, it publishes an empty completed
result instead; the original startup errno remains available. Unauthorized or collected children
return `-ECHILD` (`-12`). A dead, disposed, collected or foreign caller returns `-ESRCH`
(`-71`). A custom process service without the diagnostic query returns `-ENOSYS` (`-52`)
for positive PIDs. No output is written on an error. Caller-local details become inaccessible
when the caller exits or its service is disposed.

Standalone outcomes created with `outcomeWord()` keep their diagnostic storage in the same
shared buffer as the terminal word. Raw-buffer reservations use that complete factory-created
buffer, so separate views and structured clones observe the same publication. An isolated
eight-byte buffer is not a complete standalone outcome.

A browser worker may select START_FAILED before its ordered error message reaches
the broker. Startup queries can observe that result immediately, but consuming waits
and inherited-descriptor release remain gated on the final error acknowledgement (or
an observed worker failure). The supervisor handles the selected startup failure once,
regardless of which producer selected the result; a competing exit or signal emits none.
The generic worker does not also emit this startup diagnostic.

For a child spawned through `runtime_proc`, the typed START_FAILED outcome and the optional
`spawn_error` query let its guest parent inspect the failure. Waffle's generic startup fallback writes zero
bytes to that child's stdio, pipes or terminal, including failures during registry resolution,
lazy loading, invalid Wasm, missing `_start` and adapter entry. The full error and stack are
reported once through the broker's host-side diagnostic channel (`onError`, or `console.error`
by default), the same channel used for worker cleanup errors. A registered controller's
`startFailed(error, active)` hook still runs unchanged; adapters own any output from that hook.
The parent owns its user-facing diagnostic and may print a shell error or emit a spawn error.
This policy applies to every generation, including grandchildren and retained orphan spawns.

The broker identifies these children by **both** a nonzero immutable process-table `parentPid`
and an admitted worker-process transport (`transportFor(pid)`). `controlParent` is not suitable:
it can be compressed to zero when ancestors are reaped. An adopted runtime root has
`parentPid === 0`, even though it has a transport. Embedder-controlled launches via the host
supervisor have no admitted `runtime_proc` transport, even when they have a nonzero bookkeeping
parent PID. Those roots keep the generic `runtime: process start failed: ...` line on stderr
unless their controller supplies its own hook; they have no runtime_proc parent consuming it.
There is no configuration switch.

For an inherited pipe, the broker retains an independent diagnostic-only writer lifetime:
the worker may release its imported endpoint before the final error acknowledgement. Bootstrap
closes the diagnostic-only lifetime synchronously when executable entry commits, before guest
code runs; normal guest stderr closure therefore produces EOF without an extra broker turn.
A selected startup failure instead retains that lifetime through error acknowledgement and cleanup;
for a suppressed runtime_proc child it is released without writing any diagnostic bytes.

Controller hooks and the generic fallback for embedder roots may return a promise. The supervisor retains finishing ownership
and stderr until it settles or disposal cancels it. Sinks receive an `active()` predicate and
must stop writing when it becomes false. Disposal reports ECANCELED and releases ownership
even if a custom sink never settles; late settlement cannot repeat cleanup or change the result.
The browser broker uses only `tryWrite` (missing immediate I/O reports ENOTSUP), draining partial
writes without blocking its page or pipe relay. A closed reader fails immediately; a live reader
that never drains is bounded to **five seconds without write progress** (each positive write
resets the deadline), and cancellation stops the drain on its next task turn.
Undelivered bytes are reported to the host error sink as a `ProcessError` (the stream's errno
or EAGAIN at the deadline), with the unwritten byte count when known. Delivery failure never
replaces the selected child outcome or prevents descriptor cleanup.

A shell maps START_FAILED ENOENT (WASI 44) to status 127, other startup errors to
126, signals to 128 + signal, and actual exit codes unchanged. A Node/Bun-style
guest instead emits a spawn error for START_FAILED (with the named errno and null
exit status); real exits 126/127 use its ordinary exit-event path. Neither policy
requires a Bun-specific Waffle import.

## Observing child startup

```text
runtime_proc.start_status(pid: i32) -> i32
```

This non-consuming query applies to retained direct children, with the same caller
and child authority as `wait`. A reserved PID alone does not prove successful startup.

| Return               | Meaning                                                 |
| -------------------- | ------------------------------------------------------- |
| `-EAGAIN` (`-6`)     | Admission, instantiation or setup is still pending      |
| `0`                  | Executable entry was committed successfully             |
| Positive WASI errno  | START_FAILED, using the seven values in the table above |
| `-ECANCELED` (`-11`) | Exit or a signal won before executable entry            |
| `-ECHILD` (`-12`)    | Unknown PID, not a direct child, or already collected   |

Success stays observable through immediate exit, later signals and cleanup, until
collection. Startup errors are likewise repeatedly observable without consuming a
wait result. Cancellation preserves the actual exit/signal for ordinary `wait`;
it does not replace it with a startup error. Startup observation does not wait for
descriptor release or the host filesystem quiescence fence.

Poll subscription **kind 6, CHILD_START**, uses the child PID as `id` and the existing
16-byte subscription/event layouts. It becomes readable whenever `start_status`
is no longer `-EAGAIN`. CHILD_START is **level-triggered and stays readable until
collection**; callers remove the subscription after its first event. An invalid or
collected child reports the same authority error as a child wait. Neither polling
nor querying collects a startup or terminal result. Hosts publish the atomic state
before incrementing the common wake sequence, so publication racing a poll scan or
its wait cannot be lost.

Host adapters that compose a blocking wait can call
`ProcessABI.registerPoll(subscriptions)` with readonly `{ kind, id }` pairs. It
returns `{ wake, covered, dispose }`: `wake` is the process common word when one
exists, `covered` is conservative and remains false for any source without an
accepted common-wake route, and `dispose()` releases registrations in reverse order
exactly once. Invalid kinds or IDs are rejected at this boundary. A registration
failure unwinds earlier registrations before rethrowing. This wrapper does not alter
`poll` readiness, publication, CHILD_START handling or the existing 10 ms fallback
for uncovered sources.

### Zero-time read observation

`runtime_proc.poll` with timeout 0 scans once without waiting. Kind 0 observes
regular files as ready, including write-only files and files with pending I/O or
a contended shared offset. The observation neither acquires that offset nor
starts filesystem I/O. The actual read still enforces descriptor rights and may
return `EAGAIN`. Positive and indefinite polls retain their I/O-completion wait.
Null is ready. A pipe reader is ready with data or no writers; a pipe writer is
read-ready only when no readers remain. A pending signal returns zero events
without consuming the signal or input.

### Host executable-entry boundary

The browser bootstrap completes `WebAssembly.Instance` construction (including a
Wasm start section), validates callable `_start` and exported memory, runs
`executor.instantiated`, and initializes Waffle's WASI memory views. Only then does
it atomically commit entry, directly before calling `_start`, with no fallible
user hook or setup between commitment and the call. A trap inside `_start` is a
post-start execution failure. A Wasm start section that calls `proc_exit` before
`_start` instead yields `-ECANCELED` and retains its real exit code.

Custom supervisor executors call `ProcessContext.started()` at this boundary;
worker clients call `WorkerProcessClient.started()`. Both publish readiness after
committing the shared outcome bit. Hosts with no callback inside their entry API
commit at the last fallible point before entry: validate `_start` and memory and
finish host setup, then commit immediately before the entry call. For Node's WASI,
this means immediately before `wasi.start(instance)`; its internal memory setup has
already had its only failure condition (a missing memory export) checked.

The sticky entry bit shares the terminal outcome's atomic word. Entry and a
pre-entry signal or startup failure arbitrate through that same CAS. A false
`started()`/`markStarted()` result means a terminal result prevented entry: the
host must not execute guest code. Entry commitment is not a promise that the
first guest instruction beats a racing kill. A later host failure cannot become
START_FAILED after successful entry. `readOutcome` still returns no outcome for a
started-but-running process, and terminal claiming still chooses exactly one
immutable winner. Recycled record validity applies equally before and after entry.

`WorkerExecutor.instantiated` may return a promise. Bootstrap awaits it
inside the startup cleanup boundary before calling `wasi.launch`; a rejection,
`finish()` during arming, filesystem revocation or a terminal outcome observed
after arming prevents guest entry. The execution context exposes the already-created
`ProcessABI` as optional `process`, and the same context object is passed to
`run`; no second process ABI is created.

A Node-style caller can therefore emit `spawn` once it observes zero, or `error`
without `spawn` for startup failure, without waiting for output or exit (which
could deadlock a child waiting for stdin from the `spawn` handler).

## Jobs and signals

`runtime_proc.job_of(0)` returns the calling process's current job, using the
host-bound caller pid rather than a guest-provided identity. A positive pid queries
that process's job. Spawn selectors are unchanged: `0` creates a new foreground
job, `-1` creates a new background job, and a positive id joins that job. A Bun-like
guest obtains `job_of(0)` and explicitly joins it for ordinary children; a detached
child can select `0` to create an independently controlled job.

The owner and its controlling ancestors can wait for a whole job. The leader's
outcome survives individual child reap, and `wait_job` waits for every accepted
member's filesystem/descriptor safety fence before collecting the job, including
inherited descendants whose parent already exited. Job collection removes its
completed member records, including
orphaned grandchildren; individual child reaping does not discard the job outcome.

Signal numbers use Linux numbering: `1..31` and `34..64`; `32` and `33` are invalid.
Stop signals `19..22` are not supported because Waffle has no stopped-process state.
All `runtime_proc` errors, including `signal` registration, use negative WASI errno:
`-28` (`EINVAL`) for invalid numbers/dispositions and `-58` (`ENOTSUP`) for stop signals.
An executor without a signal adapter returns `-52` (`ENOSYS`), not a Linux errno.
`signal(0,0)` dequeues a handled signal; `signal(0,4)` checks fatal state without
consuming a delivery. Modes `0`, `1`, `2`, `3` select default, ignore, handler and
self-raise respectively. `SIGKILL` cannot be ignored or handled.

`runtime_proc.kill(pid, 0)` and `runtime_proc.kill_job(job, 0)` perform the POSIX
null-signal probe on execution handles and job IDs: they validate the signal number
first, check target existence and caller permission, deliver nothing, and cause no
side effects (no pending-signal change, no wake, no revocation, no sealed-job
collection assistance, no access retirement, and no host signal message). Signal
validation runs before lookup and permission checks, so invalid or unsupported signal
numbers fail with `-28` (`EINVAL`) or `-58` (`ENOTSUP`) regardless of target authority.
For signal `0`, an existing target in the caller's table or directory that the caller
may signal (itself or a descendant, or an owned job) returns `0`; an existing visible
target outside the caller's ancestry returns `-63` (`EPERM`); and a missing, invalid,
foreign-root, sealed, or already collected target returns `-71` (`ESRCH`). A zombie
process (exited but not yet collected) still exists in the process table until
collected, so probing it returns `0` when permitted or `-63` (`EPERM`) otherwise, and
`-71` (`ESRCH`) once collected. This matches Linux (`kill_pid_info` /
`group_send_sig_info`), FreeBSD (`kern_kill` via `pfind_any`), and gVisor (`TaskWithID`
retaining `TaskExitZombie` until reaped), and matches Waffle's process-table lifecycle
and non-zero signal handling.

`runtime_proc.probe_process(pid: i32) -> i32` performs the same read-only null-signal
probe by logical process PID `P` (the value returned by `process_id` and
`parent_process_id`) rather than execution handle `E`. It checks every live or
uncollected zombie execution record in the caller's table or directory whose logical
PID equals `pid`: it returns `0` if any matching member is the caller or a descendant
in its execution ancestry, `-63` (`EPERM`) if at least one matching member exists but
none is controlled by the caller, and `-71` (`ESRCH`) if no matching member exists, if
the caller has exited, or if `pid` is non-positive. Private thread execution handles
are not logical PIDs and therefore answer `-71` (`ESRCH`). `runtime_proc.signal(0, 1|2|3)`
and `runtime_proc.default_signal(0)` continue to return `-28` (`EINVAL`). Every
non-zero signal keeps its existing rules.

Default actions terminate with a typed signal outcome except `SIGCHLD` (17),
`SIGCONT` (18), `SIGURG` (23) and `SIGWINCH` (28), which leave a running process alive.
Explicit handlers still receive these signals through the same pending-signal table.
Restoring default disposition discards pending delivery for a default-ignored
signal, but selects terminal default action for a pending terminating signal.
`default_signal` applies the same default actions independently of registered
handlers; ignored defaults return zero without revocation or terminal unwind.
An already-selected `SIGKILL` remains authoritative across all these paths.

### Stop polling

`Worker.terminate()` does not stop guest code that is running: Chromium lets it run about 2 s
more, and Safari (including iOS) never stops a Wasm loop that makes no host call. The host
therefore asks guests to stop through the process outcome, which they poll:

- What to poll: `runtime_proc.signal(0, 4)` (or the link loader's injected fatal checkpoint,
  which reads the same state). Poll it periodically while running guest code with no host
  calls, such as from a JavaScript engine's interrupt handler.
- What means stop: the call throws instead of returning `0` once the process outcome is
  `signaled`. It never consumes a handled signal, and it ignores the interrupt cell.
- The interrupt cell is not a stop flag. It is one Int32 word in the process's shared control
  block (`SignalTransport.interrupt` in `proc/signals.ts`, outside guest memory), so Wasm guest
  code cannot read it. A publisher stores the signal number there and notifies it, and a
  dequeue may clear it. Nonzero means only "something was published, look again": waits
  use it to wake, and an executor's JavaScript may read it, or `WorkerExecutor.interruptPending()`,
  to decide when to poll sooner. Only `signal(0, 4)` decides whether to stop.
- What the guest must do: let that throw unwind. Do not catch it or run more guest code. The
  worker thread then returns to its event loop and ends, which is what frees a memory group
  member's pages for reuse ([Memory groups](memory-groups.md#exit-proof)).
- What the host guarantees: before the broker terminates a single-threaded process's worker
  (kill, runtime disposal, a failed or abandoned launch, or any other physical stop), it selects `SIGKILL` as
  the outcome if none is selected yet, so `signal(0, 4)` throws before `terminate()`. It does so
  at the start of the stop, before the process's filesystem is revoked, so a stopped guest
  reports `SIGKILL` (status 137) rather than exit 1 from the revocation. An outcome
  selected earlier stays (an exit code is not rewritten), and every host call also throws once
  any outcome is selected. A guest that already returned 0 but is still flushing its exit
  output when the stop comes reports 137, as on Linux when a process is killed during its
  exit-time flush: that output was not all delivered. Exec replacement is the exception: the
  old image is stopped inside its exec call, which never returns into guest code once the
  replacement is committed.
- Threaded (wasi-threads) processes stop through their thread owner instead, which neither
  selects `SIGKILL` first nor waits for an exit report (plans/group-futex-retirement.md).
- Then the broker waits, up to about a second, for the worker to report that its guest finished
  (its `exit`, `error`, `cleanup-error` or `observation-error` message, or a worker error), and
  only then calls `terminate()`. A
  polling guest reports within a few milliseconds, so `terminate()` lands on an idle worker. It
  does not wait when no guest code can be running: the guest never entered, already finished,
  or is a memory group member parked in its futex wait, which `SIGKILL` does not wake. The second
  is a hang cap, not a speed promise.
- A guest that never polls still gets `terminate()`, after that wait. On WebKit, `terminate()`
  landing while a guest is still running can crash the page (Playwright WebKit crashed it when a
  guest was returning from a loop of host import calls), so in that rare case the user may lose
  the tab. On WebKit, including iOS Safari, `terminate()` also never stops such a guest's Wasm
  loop: it keeps a CPU core busy until the tab closes.
- An external root embedder that terminates its own worker kills the process through the
  runtime first, or disposes the runtime, which selects `SIGKILL` for every process.

The interrupt cell is an advisory wake hint, not signal readiness. Process poll and
job wait consult the authoritative handled-pending table and fatal outcome without
consuming either. Preview1 polling uses the same readiness through the worker
bootstrap. A worker request with `runtimeProcess` uses its shared signal table. An
executor owning its own `interrupt`, `requestedSignal`, or `signal` adapter must
provide `WorkerExecutor.interruptPending(): boolean` when `runtimeProcess` is absent.
The callback checks handled-pending delivery and fatal outcome without dequeueing;
bootstrap rejects a missing callback before setup or execution, with owned-resource
cleanup and a startup diagnostic. A nonzero hint is never its substitute. A delayed publisher or rearm scan may leave a discarded hint behind;
it must not cause `EINTR` or an early process-poll return. Advisory waits snapshot
the observed word and rescan within 10 ms, including clock-only preview1 polling,
because a same-number publication can leave the hint unchanged.

## Process collection and reuse

Process and job identities are monotonically allocated, non-wrapping incarnations;
shared directory slots are recyclable storage, not identities. Captured process
and job controls carry their incarnation in the same atomic word as the value.
A late Worker cannot adopt a replacement's authority by retaining a shared view.
An outcome is selected only against its process-specific running sentinel, so a
late exit or signal cannot replace a successor's outcome.

`runtime_proc.wait(pid, out)` consumes one direct child's terminal outcome. It
returns `-EAGAIN` (`-6`) while the child or its resource/filesystem cleanup fence is
pending. Success writes the existing 8-byte little-endian kind/code record and
immediately completes logical collection, independently of its job. Its shared
process slot becomes reusable after its captured native consumers return.
A subsequent wait, or a wait for a non-child, returns `-ECHILD` (`-12`). Pipe-owner
metadata has been released by the cleanup fence; a consuming wait never retains it.
An exited but uncollected child remains a zombie and retains process capacity.
A zombie keeps only its identity and exit status: its descriptors close at exit, and the
host drops its spawn's transferred descriptors (and the pipe buffers they pin) once its
Worker has physically stopped, without waiting for the parent's wait or the end of its job.
Choosing an outcome alone is not proof that a Worker's resources are safe to release.
Shared collectibility is published before host exit observers and waiters see the
result. A consuming host wait does not await native termination; pending native
returns can temporarily retain process capacity. See [Process execution observation](process-observation.md).

Poll kind 2 observes a child's readiness through
`ProcessService.childExited(parentPid, pid): boolean`; it never consumes the exit
or releases capacity. Repeated readiness polls leave exactly one successful `wait`
available. The host-side observation throws ECHILD for a collected or non-child
PID (guest poll returns `-12`). Host `wait` is consuming too; `waitForExit` remains
an asynchronous observation, and explicit host `reap` also consumes a child.

`wait_job` consumes a completed job and releases its remaining shared process
slots. Host records are reconciled by subsequent broker receipts, pumping, or host
child access; physical host-map cleanup is not synchronous with a Worker's consuming
return. The shared consuming claim is authoritative across host and Worker adapters:
a host wait, reap or child observation rejects an already-collected shared child even
before its Worker receipt arrives.
Its nonblocking form reports pending until every live member and its cleanup
fence has settled. Job-empty polling is observational. A job keeps its
leader's typed outcome independently of the leader's process row, and completed
members do not remain in its live membership. Shared job collection is helpable
if a collector stops; host cleanup also reconciles the shared state without
requiring a final Worker notification. An unconsumed completed job deliberately
retains its job row and cached outcome until its consuming wait.

`wait_job(job, flags, out)` writes the same 8-byte WaitResult as `wait`;
flags `1` is nonblocking and `0` blocks. Collecting every direct child with `wait`
does **not** consume its job: `wait_job(job, 1, out)` returns `-EAGAIN` while any
descendant member or its cleanup fence remains pending, then succeeds using the
cached leader outcome after all members finish. A failed leader returns START_FAILED
even after its individual wait and process-slot recycling; a failed nonleader is
reported by its individual wait and never replaces the leader result. Only consuming
`wait_job` itself
makes a repeat return `-ECHILD`. Unknown job IDs return `-ESRCH` (`-71`). Spawn
selectors are unchanged: `0` and `-1` create foreground/background jobs, and a
positive selector joins an existing live job.

### Caller-owned independent jobs

Spawn JSON accepts optional `jobLifetime: "caller-fatal" | "independent"` only
with a new-job selector (`0` or `-1`). Omission means `independent`; existing
foreground/background and detached-job behavior is unchanged. Unknown values,
null, and specifying a lifetime with a positive join selector return `-EINVAL`
before reservation. Joins inherit the existing job's policy. The authenticated
spawning process supplies the immutable lifetime owner; no JSON owner PID is used.

When that owner's immutable outcome is `signaled`, the host seals its caller-fatal
jobs, selects SIGKILL for their remaining members, and closes nested owned jobs.
Independent jobs and unrelated siblings survive. Ordinary exit (including status 137) and startup failure disarm the relation without killing children. Original
owner identity is separate from the mutable control ancestry used for wait authority.

The host releases owner descriptors before awaiting child cleanup. Owner completion
is withheld until owned members pass their existing filesystem/adapter fences,
their physical stops (including late acquired launch handles) settle, and their
jobs are collected through the existing incarnation-tagged consuming claims.
Queued accepted spawns are included; cleanup never blocks their admission queue.
Fence or physical-stop failure stays unconfirmed and diagnostic. No timeout,
guest Drop, second collector, or replacement child outcome completes this barrier.

### Signal-preserving cleanup wait

`wait_job(job, 2, out)` is **CLEANUP**. It preserves pending handled signals while
waiting for both safe resource confirmation and physical retirement, then writes
the same typed eight-byte leader result and consumes the job. A prior individual
child wait is optional. Flags `0` and `1` keep their existing semantics; `3` and
other flags are invalid. CLEANUP does not send a signal: a live caller first kills
the job if cancellation is required, then makes one cleanup wait.

CLEANUP registers existing job/directory and caller-revocation notifications before
scanning readiness and waits on their shared sequence without timer retries. A
handled pending signal is neither consumed nor re-emitted. A fatal caller outcome
uses the existing process-signal unwind; host lifetime cleanup continues after the
guest can no longer run. The full output span is validated before collection and
reacquired after callbacks or memory growth. Caller/job authority is unchanged;
waiting on the caller's own member job returns `-EINVAL`. Hosts without a proven
notification route return `-ENOTSUP` (`-58`). Failed physical retirement returns
`-EIO` (`-29`) without consuming the job or fabricating its leader outcome.

`ProcessService.jobCleanupReady(callerPid, job)` supplies the nonblocking predicate.
Shared job rows carry lifetime and physical-retirement state in the existing
directory, with current readers and writers using the same layout. Native hosts
use `registerJobCleanupWake` and caller revocation alongside the existing wake;
ordinary job/poll wake behavior is unchanged.

Host adapters can provide `SupervisorOptions.retire(pid)` to join physical
controller cleanup when loading or launch fails before returning a process handle.
During whole-runtime disposal the existing broker first fences all consumers,
starts their captured handle stops, and then settles controller stops. Handle-only
completion is separate from final retirement so a parent's owned-child barrier
cannot form a shutdown cycle. Coordination hooks remain on the owning supervisor;
they are omitted from the borrowed `RuntimeSupervisor` capability.

An externally executed `createRoot`/adopted root has no supervisor-owned launch
handle to certify physical termination. CLEANUP on a job containing such a root
returns `-ENOTSUP`; ordinary waits are unchanged. External roots cannot join a
caller-fatal job through root adoption. They can own one: an adopted runtime root
(a shell or Bun page root) spawns `caller-fatal` children and waits with CLEANUP.
Spawned child reservations, including worker-transport children, carry the tracked
launch/stop lifetime for this contract.

Host control fields in `ProcessContext`, `SignalTransport`, `SpawnReservation`
and `ProcessABIOptions.wait` use `ControlCells` (`Int32Array | TaggedCells`). Outcome
fields use `OutcomeWord` (`BigInt64Array | OutcomeCell`). Import `ControlCells`,
`TaggedCells` and the `controlLoad`/`controlStore`/other control helpers from
`waffle/proc/control`; they accept both standalone and tagged words. `claimOutcome` and
`readOutcome` accept that union, so consumers must use those helpers rather than
raw atomics on outcome fields. `SpawnReservation` also carries optional
`controlParent` and `rootPid`; `SharedJobIdentity` carries optional `controlParent`.
Cells are local class instances, not worker messages. Use `serializeOutcome` /
`reviveOutcome` from `waffle/proc/outcome` and `serializeTaggedCells` /
`reviveTaggedCells` from `waffle/proc/control` when carrying them in `postMessage`,
`workerData`, or a `MessagePort`. Transfers contain only shared memory and captured
identity data; receiving code rebuilds the class and checks the shared lifecycle
word, never adopts a recycled row's current identity. A job outcome's lifecycle id
is its job id, independently of the leader pid used by its running sentinel.
`WorkerProcessTransport` already carries a cloneable directory handle; obtain its
local cells with `workerProcessState` rather than embedding that returned state in
its payload. The browser broker serializes its explicit outcome before posting.
Captured stale tagged controls/outcomes throw `ProcessError(SRCH = 71)` and cannot
read or change the next occupant of the recycled slot. These are matching-package
host contracts, not version-negotiation paths.

Parent retirement collects completed children and forwards live descendants'
controlling ancestry, preserving permitted signal and wait authority through
compressed control-parent links. Immutable root ownership separately retains the
controller, output, and shutdown lifetime after intermediate controllers disappear;
it does not grant arbitrary ancestors signal authority while a direct owner lives.

Pipe publication owners are enrolled before descriptor export under the spawn
admission fence. Owner collection freezes old cursors and releases owner metadata;
a delayed Worker cannot reenroll a collected identity. Cursor cells themselves
are not reused: retained endpoint views have no cursor-incarnation field, and the
separate cursor arena defaults to 1,048,576 cells (16 MiB), with an explicit maximum up to 16,777,216 cells. Slot reuse never recycles these cells.

## Runtime-authored error diagnostics

After an executor fails, the runtime writes its diagnostic to the inherited stderr
before closing descriptors and acknowledging completion. Unlike a live program's
blocking writes, this drain uses only immediate `tryWrite` stream operations. Short
writes preserve byte order; `EAGAIN` yields to the event loop. Every positive write
resets a five-second no-progress deadline, so a reader that keeps draining receives
the complete diagnostic even when delivery takes longer than five seconds overall.
The startup broker and post-entry worker use the same `drainDiagnostic` helper and
`DIAGNOSTIC_STALL_TIMEOUT_MS` constant, publicly available from
`waffle/browser/diagnostic` to browser and Node hosts without loading browser globals.
Redirected regular-file stderr uses the same bounded policy: acquire its shared offset
lock without waiting and use `tryWrite` / `tryAppend` filesystem operations, yielding
on `EAGAIN` rather than entering a blocking filesystem transaction. When the backend
disables direct shared-memory file I/O (such as multi-tab attach), `drainAsyncFileDiagnostic`
submits bounded (`<= 64 KiB`) asynchronous writes under the shared offset lease, bounding
each stall by `DIAGNOSTIC_STALL_TIMEOUT_MS` while retaining the offset lease until any
already-dispatched write reports an authoritative commit or abort.
The execution failure claims its terminal outcome before delivery begins; signals
arriving during backpressure cannot replace that outcome. Only the synchronous
runtime-owned diagnostic write can use the still-owned stderr after that claim,
and revocation still retires its authority.

If the reader is closed, the stream lacks immediate writes, the process is revoked,
or no bytes can be written for five seconds, delivery stops and the unwritten tail
is discarded. The failure records its error and unwritten byte count on the
host diagnostic/cleanup path; descriptor and filesystem teardown still run and the
original terminal outcome is published. A stalled stderr reader must not retain a
dead child forever. This bounded policy applies only to runtime-authored diagnostics,
not to ordinary guest I/O or application-selected blocking pipe semantics.

## Mixed notification waits

The browser broker gives each guest a notification connection to one helper Worker that the
page shares among all guests using the same `notificationWorkerUrl`. The helper starts with the
first connection and is terminated with the last. Pass `notificationWorkerUrl` to
`BrowserProcessBroker.launchWorker()`. Bundle the
`waffle/browser/notification-worker` entry separately as a module Worker, just as
an embedding bundles its guest Worker. Both Workers require shared memory. The guest
Worker's lifetime observer also needs `Atomics.waitAsync`; the helper uses only blocking
waits in its own child Workers. The guest remains free to block synchronously.

`bootstrap()` supplies `context.notifications: NotificationWaitScope | undefined`
and `context.signal: AbortSignal`. Arm the scope in the awaited `instantiated`
hook, before guest entry. Pass the guest's `NetHost`, `ProcessABI` and current
process poll subscriptions to `await notifications.arm({ network, process,
subscriptions })`. An arm failure prevents entry and disposes the scope.
External revocation cancels an unresolved arm without waiting for the helper to
reply. The signal also aborts on ordinary bootstrap completion.

The returned `NotificationWaitSet` has these operations:

```ts
sample(): NotificationSample;
wait(observed: NotificationSample, deadline: number):
  "ok" | "not-equal" | "timed-out" | "closed";
setProcessSubscriptions(subscriptions: readonly PollSubscription[]): void;
dispose(): void;
```

Call `sample()` **before** reading readiness. If no operation is ready, call
`wait(sample, deadline)`. The sample contains both the common sequence and the
source generations, so a publication racing the readiness scan cannot be lost
while the relay is catching up. `deadline` is one absolute value in the host's
monotonic `performance.now()` domain, or `Infinity`. Keep that same deadline after
unrelated wakes. Treat wakes as hints and repeat the normal readiness reads.
The helper never drains a watch, reads a pipe or consumes network news.

The helper observes the actual filesystem watch word at `cells[3]`, network ring
GEN0 and process common wake. `NetHost.registerNotificationSink()` also forwards
host-local news synchronously and returns a detach function. Forwarding does not
clear `localNews`; `poll(0)` and normal network drains keep their existing behavior.
`NetHost.notification` alone covers GEN0, not local news.

The helper waits on those words only while the guest is parked. Before `wait()` blocks, it
stores a fresh park id in the connection state and sends it with the source values it
observed. It rechecks the sources after storing the id and clears the id when the blocking
call returns. Ids are never reused for a later wait. The helper publishes on the first
difference, or on a wake of a word still at its parked value, only by consuming the active id
with a compare-exchange. A retired park never publishes, and a failed claim means the guest
is running or a newer park is on its way, so the helper drops it. Source traffic while the guest runs costs the helper nothing, and a guest that
never blocks in `wait()` starts no blocking wait Workers. A malformed request fails that
guest's connection: the guest receives an error reply and the page fences its state.

Filesystem revocation and reap advance the watch word as well as notifying it, because they
can make a watch readable. A park taken before a revocation therefore differs by value, even
when the notify landed before the helper registered its wait.

`covered` is conservative. Process registration with `registerPoll(subscriptions,
"shared")` owns no guest-local release callbacks and covers only sources already
publishing to the process common word. Independent streams, terminal/resize
sources and CHILD_START remain uncovered. Their presence caps each wait at the
existing 10 ms fallback. Changing subscriptions recomputes coverage. Existing
`runtime_proc.poll` and ordinary local `registerPoll()` behavior are unchanged.

The broker installs external ownership before launch and revocation registration.
It fences the common state and removes the guest's connection from the helper on revoke,
startup failure and guest completion, and before physical guest termination. Removal settles
once the helper has dropped the connection, or once the helper Worker is terminated when that
was its last connection. One guest's malformed message fails only its own connection. Broker disposal joins
its physical stop operations before retiring ownership. On browsers,
`Worker.terminate()` has no exit-event promise; on hosts returning a termination
promise, disposal awaits it. No cleanup depends on running a guest closure after
termination. A local scope dispose detaches local news forwarding, rejects an
unresolved arm and wakes blocked waiters. Cleanup continues after release or send
errors. Repeated disposal does not repeat releases; a scope reports its retained
first cleanup error to the caller. Bootstrap includes that error in its cleanup
diagnostics.

Manual embeddings can use `createNotificationBridge(workerUrl)` from
`waffle/browser/notification-relay`, transfer its `connection.port` with the
connection to the guest, and construct `NotificationWaitScope(connection, fs)`.
The external owner must call and await `bridge.dispose()` before terminating the
guest or releasing its resources. The broker performs that ownership work for
its launched Workers.

## Memory group imports

`runtime_shm` exists only for a member of a [memory group](memory-groups.md). Addresses are
guest addresses in the shared group memory. Every import returns a negative WASI errno on failure:
`-EAGAIN` (`-6`) for a full metadata table, `-EBADF` (`-8`) for an unknown or unowned handle or pin,
`-EINVAL` (`-28`), `-ENOMEM` (`-48`) when the page budget or group address space is exhausted, and
`-ESRCH` (`-71`) for a target that is not a live member. Output records are little-endian u32.

```text
group_grow(pages) -> old page index of a fresh member-owned chunk
shm_create(len, align, out{handle, addr}) -> 0        caller holds the zeroed region
shm_attach(handle, out{addr}) -> 0                    +1 hold for the caller
shm_detach(handle) -> 0                               -1 hold
shm_pin(handle, out{pin}) -> 0                        caller must hold; pin owned by caller
shm_route(pin, pid) -> 0                              owner hands the delivery to member pid
shm_route_group(pin: u32) -> i32                      owner hands the same pin to its group; 0 on success
shm_accept(pin, out{handle, addr, len}) -> 0          owner only: +1 hold, pin consumed
shm_unpin(pin) -> 0                                   member owner, or any launched member for a group pin
shm_publish(kind, primary, companion, meta, out{token}) -> 0   caller holds both regions
shm_publication_open(token, kind, out{primary, primary_addr, primary_len,
                     companion, companion_addr, companion_len, meta}) -> 0   +1 hold per region
shm_withdraw(token) -> 0                              publishing incarnation only, once
futex_wait32(addr, expected: i32, timeout_ns: i64) -> 0 ok, 1 not-equal, 2 timed-out
futex_wait64(addr, expected: i64, timeout_ns: i64) -> same
futex_wake(addr, count) -> number woken (sync waiters, then watches in registration order)
futex_watch(addr, expected: i32, out{id}) -> 0
futex_unwatch(id) -> 0
parallelism() -> the group's reported parallelism
```

`group_grow(n)` grants exactly `n` pages without speculative leases. A one-page call adds at
most 64 KiB to the owner's backing charge, or zero when reusing a free range. Granted heap
pages remain owned until the member physically stops; free backing stays charged until the
group ends. Fixed backing is reserved separately at group creation. See
[heap acquisition and retention](memory-groups.md#heap-acquisition-and-retention) for the
profile's bounds and their limits.

`group_grow` chunks need not be contiguous with earlier ones. A negative `timeout_ns` waits
forever; `count` `0xffffffff` wakes every waiter. Waits must be 4- or 8-byte aligned.
Both widths wait natively on the guest address. Raw JavaScript `Atomics.notify` and Wasm
`memory.atomic.notify` interoperate with them; `futex_wake` also wakes raw waiters.

After every admitted agent has had native termination attempted, with no reserved member
or earlier unresolved admission, the owner irreversibly seals the group to new members.
Only then it closes each current or retired incarnation's private wait record and notifies
every waiter on each recorded pending address. A raw non-member waiter on that same cell may
receive a teardown-only spurious `ok`; callers must recheck their condition. Normal operation
and stopping one member with live siblings add no wakes or deadline changes. On WebKit,
an individually terminated worker can stay parked until a normal notify reaches it, and
Chromium can leave one parked, or still running, briefly after `terminate()` returns. Releasing a member
therefore closes its record without a wake: if a later notify wakes it, typically from the
member that reused its pages, its wait throws instead of returning to guest code.

An external root's embedder calls its exact `RootMemoryGroupMember.terminating()` in
`finally` immediately after invoking native terminate, before awaiting its result, including
when invocation throws. `stopped()` remains the assertion after successful physical stop
and cleanup. Broker-owned native stops perform the same ordering. A failed stop retains
capacity and backing debt. Neither cancellation nor a native terminate return proves memory
reclamation. Raw Wasm `memory.atomic.wait32/64`, guest busy loops and other service waits
are outside this cancellation path and can keep a stopped group's backing reserved on WebKit.

`shm_route_group` converts the current launched caller's own member pin to a group pin in
one owner step. It keeps the same unsigned 32-bit pin ID and changes no hold, pin count,
quota charge or backing charge. Unknown, unowned and already group-owned pins return
`-EBADF` without mutation. The pin survives every individual member's release and is
dropped at group end, or earlier by `shm_unpin` from any current launched member of that
same group. Concurrent unpins have one success, then `-EBADF`. `shm_route` and `shm_accept`
return `-EBADF` for group pins. Reserved, retained, released and replaced incarnations
gain no request authority. Ordinary member pins and publication authority are unchanged.

Pin IDs use the caller's implicit group namespace. Equal numbers in different groups name
independent pins; no import selects another group's state. All u32 values, including IDs
above `0x7fffffff` passed as signed Wasm i32 arguments, retain their full unsigned value.
Group pins count against the existing total pin limit. A region frees only after its last
hold, pin and publication are gone. Releasing a region makes its pages reusable, without
reducing the group's logical high-water backing charge or proving physical memory return.
See [Regions and transit pins](memory-groups.md#regions-and-transit-pins) for guest cleanup.

`shm_publish` returns `-EINVAL` for a zero `kind` or equal `primary` and `companion`, `-EBADF` when
the caller does not hold a named region, and `-EAGAIN` when the publication limit or token space is
exhausted. A `companion` of zero means none. `shm_publication_open` returns `-EBADF` for an unknown,
withdrawn, other-group or wrong-kind token, and takes nothing. A module-style publication reports a
zero companion in all three companion fields. `shm_withdraw` returns `-EBADF` for repeats and for
any caller other than the publishing incarnation. Publication tokens and region handles are
unsigned 32-bit values read from output records. See
[Publications](memory-groups.md#publications).

Poll subscription **kind 7, FUTEX**, uses a watch ID. It is ready while `*addr != expected`, and
from the first `futex_wake` that hits the watch until `futex_unwatch`. Readiness consumes nothing.
Each watch is hit once: a wake selects only pending watches, so successive or concurrent partial
wakes reach distinct watches. Output records are validated before any owner state changes; an
invalid span returns `-EINVAL` with nothing created, held, pinned or consumed.
A hit increments the process directory's common wake word, so a member polling on that word parks
until it. Kind 7 is `-EINVAL` in a process that is not a group member.

## Network and preview

The network helper performs injected `fetch` operations and writes responses to a shared ring. The host side exposes nonblocking handles and preview HTTP framing. Preview routing and service-worker registration are consumer policies; Waffle exports the routing and protocol services without choosing a URL scope.

Shared hosts also carry pathname stream sockets through `listenPath` and `connectPath`. Their wire requests are `unix-listen`, `unix-connect` and the acknowledged `unix-close`, answered in the same 12-byte reply cell with a WASI errno on failure. Socket nodes report Preview1 filetype 6 (`SOCKET_STREAM`). See [Unix-domain stream sockets](unix-sockets.md).

### Outbound connector

`RuntimeNetwork.createHelper` accepts an optional page-owned `connect?: NetConnect`. The connector
is called only for non-loopback `tcp-connect` requests and receives `{ host, port }` without a DNS
lookup in Waffle. It returns a `NetOutboundStream` with `readable`, `writable` and the actual remote
`PeerAddr`. Waffle does not import relay or carrier modules.

A configured non-loopback connect returns a handle immediately with `TCP_PENDING = 1` and local port
zero. The ring later carries `Kind.Open` with `{ local, peer }`, or `Kind.Error` with the mapped
`NetConnectError` code. While connecting, `read` and `write` return `AGAIN`, readiness is false,
and address calls return `ENOTCONN`. A shutdown is remembered until open. Close aborts a pending
connector; helper disposal cancels every connector stream.

The helper limits unread inbound bytes and unsettled outbound writes to 1 MiB per direction. A
`tcp-read` acknowledgement releases inbound credit; `Kind.Writable` releases a blocked writer.
Target EOF is `Kind.End` and does not prevent guest writes. Shutdown closes only the local write
side, while full close closes the write side gracefully and cancels reads.

### Preview 1 launch sockets

Preview 1 has no standard `connect` import. A launcher can bind an already-connecting socket
at an explicit fd. Arbitrary unmodified programs cannot initiate connections through a missing
standard import. Unknown imports still fail linking. A launcher can also bind a virtual loopback
listener for standard `sock_accept` calls. This exposes no OS listener or inbound relay.

`waffle/browser/preview1-network` exports `createPreview1Network(runtime, options)` and the types
`Preview1NetworkOptions`, `Preview1SocketBinding`, `Preview1NetworkConnection` and `Preview1Network`.
The options are `{ sockets: readonly Preview1SocketBinding[], connect?: NetConnect }`.
Each binding is either `{ fd, socket: { connect: { host, port } } }` or
`{ fd, socket: { listen: { host, port } } }`. Targets use the existing `NetHost` connect and
virtual loopback bind rules. Wildcard binds still stay inside this runtime. The fd must be a
unique integer in `0..0x7fffffff`. Connect ports are in `1..65535`; listen also accepts port zero
for an ephemeral virtual port. Preview 1 has no standard address-query import.
The selected executor's `hostCallFd` is reserved for its host-call trampoline. Bootstrap rejects
socket bindings at that number with `ENOEXEC` before opening sockets or installing descriptors.
The launcher still disposes its network helper on this startup failure. Accepted descriptors
also skip that reserved number.

The function snapshots bindings before awaiting `runtime.network()`. Empty bindings resolve to
`undefined` without activating networking or process services. Nonempty bindings create a helper
on the responsive owner and return a single-launch `{ connection, dispose() }` owner. The
connector, credentials and Web Streams stay in that owner's realm. `dispose()` is idempotent.

`BrowserProcessBroker.launchWorker(context, { network, ...options })` takes this owner, transfers
its port and supplies `RuntimeWorkerRequest.network`. It disposes the helper on launch failure,
worker error, ordinary exit, revocation and physical stop. Do not pass the owner through
`request`. A manually launched worker instead receives `network.connection` in its request and
transfers `connection.port`; that launcher must dispose the owner on every exit and failed setup.

The exact cloneable connection payload is:

```ts
interface Preview1NetworkConnection {
  readonly ring: SharedArrayBuffer;
  readonly port: MessagePort;
  readonly sockets: readonly {
    readonly fd: number;
    readonly socket:
      | { readonly connect: { readonly host: string; readonly port: number } }
      | { readonly listen: { readonly host: string; readonly port: number } };
  }[];
}
```

The ring is Waffle's single-producer helper response ring. The port carries existing `NetRequest`
messages to that helper, including synchronous reply cells. The descriptor-only `tcp-ready`
request is `{ type: "tcp-ready", id, reply }`; its 12-byte reply contains completion 1, status
1 for writable or 0 for blocked, and value 0. Existing `tcp-write` reply bytes are unchanged. No function, helper instance, stream,
relay endpoint, token or credential is part of this payload. The generic bootstrap dynamically
loads the descriptor adapter only when socket bindings exist, reserves their exact numbers before
preopen placement, and installs them before instantiation. The root preopen moves from fd 3 to
the lowest free number. Socket targets 0, 1 and 2 replace default stdio. `inherited_fd` includes these sockets; `fd_prestat_get` excludes them.

A socket is a `Stream` with `kind: "socket"`. `fd_kind` returns 5. Both `fd_fdstat_get` and
`fd_filestat_get` report `SOCKET_STREAM`, filetype 6. Its rights allow read, write, setting fd
flags, filestat, polling and shutdown. Listeners additionally carry `SOCK_ACCEPT`, right bit 29.
Accepted descriptors receive the listener's current rights without `SOCK_ACCEPT`, with zero inheriting
rights. Duplicate fds share flags, the handle and its final-close
lifetime. Passing a socket to a `runtime_proc` child returns `NOTSUP`, errno 58, before descriptor
export. Sockets may be rebound within the same process with `fd_reopen` or `dup`.

| Import                                                   | Socket behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sock_send(fd, iovs, count, flags, out_written)`         | Flags must be zero, otherwise `NOTSUP`. Partial writes are valid. It waits for open and credit unless `FDFLAG_NONBLOCK` is set, which returns `AGAIN`. After write shutdown, writes return `PIPE`. A failed connect returns its mapped errno on the first send and `PIPE` on later sends.                                                                                                                                                                                                                |
| `sock_recv(fd, iovs, count, flags, out_read, out_flags)` | Flag 2 is `RECV_WAITALL`; it reads until full, EOF or error. Nonblocking calls return available partial bytes, or `AGAIN`. `RECV_PEEK` and unknown flags return `NOTSUP`. EOF returns zero bytes. Success writes zero to `out_flags`.                                                                                                                                                                                                                                                                    |
| `sock_shutdown(fd, how)`                                 | `1` discards and ends local reads without a wire FIN. `2` sends FIN after queued writes. `3` does both. Other values return `INVAL`. Peer FIN still permits writes.                                                                                                                                                                                                                                                                                                                                      |
| `fd_read`, `fd_write`                                    | Same descriptor I/O without socket flags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `poll_oneoff`                                            | Uses the existing multi-source readiness wait and the network ring's notification word. FD_READ reports buffered bytes in `nbytes`. A listener is read-ready while an accept is pending, with `nbytes` zero; it is never write-ready unless reporting an error. Readiness does not consume a connection. Errors appear in the event's errno. A peer FIN read event has HANGUP but does not end the local write side. FD_WRITE becomes unavailable when credit is exhausted and resumes after `Writable`. |
| `fd_close`                                               | The last reference closes gracefully. Worker or owner disposal resets outstanding streams, including pending opens.                                                                                                                                                                                                                                                                                                                                                                                      |
| `sock_accept(fd, flags, out_fd)`                         | A listener waits for a pending connection, or returns `AGAIN` when its own `FDFLAG_NONBLOCK` is set. Flags must be zero or `FDFLAG_NONBLOCK` 4, otherwise `INVAL`. They set the accepted socket's flags independently of the listener. Success writes a new fd as little-endian u32. A connected socket returns `INVAL`.                                                                                                                                                                                 |

For every `sock_*` call, a valid non-socket fd returns `NOTSOCK`, errno 57; an absent fd returns
`BADF`, errno 8. The adapter's `HOST_CALL_FD` special case in `sock_send` stays first and unchanged.
Socket iovecs and result spans are validated before I/O; faults return `FAULT`, errno 21.
Accept validates flags and the entire output span before consuming a connection or allocating a
socket descriptor. Errors leave the output and pending accept unchanged. Listener read, write and
shutdown return `NOTCONN`, errno 53, or the original bind error. Non-loopback listen returns
`NOTSUP` even with an outbound connector. A bind conflict reports `ADDRINUSE`, errno 3.
Closing the last listener reference closes queued unaccepted connections but preserves accepted
sockets. Accepted sockets use the existing duplex I/O, EOF, shutdown, polling and final-close
rules. Revocation interrupts a blocking accept through the existing worker liveness check.

Listener bindings and right bit 29 are additive. Existing connected sockets still return `INVAL`
from `sock_accept`, and non-socket results stay unchanged. This additive socket contract did not require an interface increase under the bump
rule below. Existing socket calls retain their behavior; no old-shape fallback or version negotiation
is added. bun-wasm's separate `preview1Launcher` must adopt this connection payload and keep its
connector on the responsive page. That consumer handoff and a real outside line/echo exchange
are separate release gates. The scripted SSLRequest fixture proves bytes only, not a Postgres
query.

## Compatibility

Consumers pin the exact runtime build in their dependency and lockfile. Host compatibility is a separate package-metadata check, not a comparison of package versions or build identities.

The native-return execution-observation contract requires `waffleHostInterface` 2.

Installable Waffle packages also carry a positive safe integer named `waffleHostInterface`.
The runtime provides the integer, and every family requires one. A family can run only when
its required integer equals the runtime integer. Missing, malformed, non-positive, non-safe,
and mismatched values fail before installation or execution.

The integer covers the guest imports and public family modules that a family can observe. This
includes Preview 1, `runtime_fs`, `runtime_proc`, `runtime_shm`, the filesystem, process, and
memory-group services behind them, the network module, and the exported `waffle/programs`,
`waffle/programs/catalog`, `waffle/search`, `waffle/core/filesystem`, and declared `waffle/fs/*`
and `waffle/proc/*` modules. It covers signatures, results, errors, readiness, ordering,
authority, revocation, and lifetime rules.

Package versions, source commits, URLs, archive hashes, transformer inputs, producer receipts,
and artifact hashes remain integrity evidence. They do not substitute for
`waffleHostInterface`. A runtime implementation can change without an interface bump when the
observable contract stays compatible. Increase the integer monotonically when an old family cannot safely run on
the new contract. A family changes its required integer only when it starts using a newer
contract. A new export that preserves existing calls does not require a bump. A removed export,
changed signature, or incompatible result, error, readiness, authority, or lifetime rule does
when a family can depend on it: a guest import any family calls, or a module export a family
imports. Every family is type-checked against the runtime in this repository
(`bun run programs:check`), so a changed export that no family imports does not, provided every
existing guest call keeps its meaning. Replacing `FileSystem.setMtime` with `setTimes` and adding
times to `FileStat` was such a change, and the Preview 1 time calls now do what their arguments
always asked for.

The family peer `waffle: "*"` controls package-manager placement only. It does not assert any
compatibility range. Source workspaces keep `devDependencies.waffle = "workspace:*"`; published
families have only the wildcard peer and never a Waffle dependency or optional dependency.
Release and consumer tools enforce integer equality and one physical runtime independently of
that wildcard.

## Inode permission query

`runtime_fs.path_permissions_get(dirfd: u32, path_ptr: u32, path_len: u32, flags: u32, out_ptr: u32) -> i32`
returns zero or a positive WASI errno. The WASI adapter supplies the namespace without activating
process services. It checks the directory descriptor's `PATH_FILESTAT_GET` right, resolves the
UTF-8 relative pathname from that capability and checks ancestor search permissions. The path
must be nonempty, valid UTF-8 and contain no NUL. `flags` uses the same final-symlink rules as
`path_filestat_get`. Bit 0, `LOOKUPFLAGS_SYMLINK_FOLLOW`, follows a final symbolic link. Zero
leaves a final link alone unless the path ends in `/`, which demands a directory. Any other
flag bit returns `ENOTSUP`, errno 58.

Success writes exactly 16 bytes, four little-endian u32 words:

| Offset | Field           | Meaning                               |
| -----: | --------------- | ------------------------------------- |
|      0 | mode            | Actual stored inode mode              |
|      4 | modeSupported   | Bits with defined mode semantics      |
|      8 | access          | Effective-caller granted access bits  |
|     12 | accessSupported | Access bits the filesystem can answer |

Access bits are read 4, write 2 and search-or-execute 1. Supported clear bits deny access;
unsupported bits are unknown. Regular files support read/write, not registry execution.
Directories support read/write/search. See [inode policy](permissions.md) for the single
virtual principal, supported mode masks, sticky semantics and saved-metadata adoption.

Missing paths return `ENOENT`, errno 44; denied ancestor search returns `EACCES`, errno 2.
A target with no read/write grants still has queryable metadata and returns zero with clear
access bits. Missing descriptor rights return `ENOTCAPABLE`, errno 76, not inode denial.
Unsupported adapter metadata returns `ENOTSUP`, errno 58. Invalid pointers return `EFAULT`,
errno 21. Errors leave the output unchanged. This import does not extend or reinterpret the
standard 64-byte Preview1 filestat record, perform open-based inference, or fetch payloads.

## Inode mode mutation

The browser Waffle WASI adapter exposes two `runtime_fs` imports for changing regular-file and
directory permission modes. Both return zero on success or a positive WASI errno on failure.

```text
runtime_fs.path_filestat_set_mode(dirfd: u32, path_ptr: u32, path_len: u32, lookupflags: u32, mode: u32) -> i32
runtime_fs.fd_filestat_set_mode(fd: u32, mode: u32) -> i32
```

Two extended 64-bit descriptor rights gate these imports independently of timestamp, stat, and
data access rights.

| Right                          | Mask            | Gates                               |
| ------------------------------ | --------------- | ----------------------------------- |
| `RIGHT_FD_FILESTAT_SET_MODE`   | `0x1_0000_0000` | `runtime_fs.fd_filestat_set_mode`   |
| `RIGHT_PATH_FILESTAT_SET_MODE` | `0x2_0000_0000` | `runtime_fs.path_filestat_set_mode` |

Normal preopened directories start with both rights in their base and inheriting masks.
Callers receive a mode right through `path_open` when they request that bit and the parent
directory's inheriting rights include it. `fd_fdstat_set_rights` can remove either bit.

Both imports update the target inode's mode and `ctime`. Changes apply to the inode shared by
hard links and open descriptors, including retained unlinked files. Regular files accept mode
bits within `0777`, and directories accept bits within `01777`. Unsupported mode bits return
`ENOTSUP`, errno 58. The sole virtual principal owns every inode and may change its mode even
when the inode denies writes. See [inode policy](permissions.md) for effective access and persistence.

`path_filestat_set_mode` accepts only `LOOKUPFLAGS_SYMLINK_FOLLOW` in bit 0. Setting it follows
a final symbolic link. Zero leaves a final link unfollowed unless the path ends in `/`, which
requires a directory. Pathnames must be nonempty, valid UTF-8, and free of NUL bytes. Traversal
checks ancestor search permissions and follows the adapter's [symbolic link rules](#symbolic-links).

A missing descriptor right returns `ENOTCAPABLE`, errno 76. A pathname span outside guest memory
returns `EFAULT`, errno 21. An invalid pathname returns `EINVAL`, errno 28. Unknown flag bits,
an unfollowed final symlink, a target of an unsupported kind, or a filesystem adapter without mode
mutation support returns `ENOTSUP`, errno 58.

## Canonical path query

`runtime_fs.path_realpath(dirfd: u32, path_ptr: u32, path_len: u32, buf_ptr: u32, buf_len: u32, used_ptr: u32) -> i32`
is `realpath(3)` in one filesystem request. Preview 1 has no such call, so a libc `realpath`
issues one `path_readlink` per path component, each a round trip to the filesystem worker. The
import returns zero or a positive WASI errno. The WASI adapter supplies it without activating
process services.

It checks the directory descriptor's `PATH_FILESTAT_GET` right and resolves the relative
pathname from that capability as `path_open` does. The pathname is its exact UTF-8 bytes,
including a leading U+FEFF; malformed UTF-8 or a NUL returns `EINVAL`, errno 28. Resolution
follows every symbolic link, including the
final component, with the same 40-expansion limit. In the guest's root namespace (the root
preopen names the filesystem root) the result is an absolute path from the root, with `.`, `..`
and every link resolved, as Linux reports it. Otherwise lookups cannot leave the descriptor, and
the result is relative to it, `.` for the descriptor's directory itself.

Success writes the result's UTF-8 byte length to the u32 at `used_ptr` and the result, with no
NUL terminator, to `buf_ptr`. A result longer than `buf_len` returns `ENOBUFS`, errno 42, with the
needed length at `used_ptr` and nothing written to the buffer, so the guest can retry with a
larger one. The result buffer and the four bytes at `used_ptr` must not overlap: overlapping
spans return `EINVAL` before any lookup or write.

Errors match `realpath(3)`: a missing component returns `ENOENT`, errno 44, a non-directory
component or a trailing slash after a non-directory returns `ENOTDIR`, errno 54, too many link
expansions return `ELOOP`, errno 32, and denied ancestor search returns `EACCES`, errno 2. An
absolute pathname, or an escape from a capability outside the root namespace, returns `EPERM`,
errno 63. A bad descriptor returns `EBADF`, errno 8, a descriptor that is not a directory returns
`ENOTDIR`, and a missing right returns `ENOTCAPABLE`, errno 76. Invalid pointers return
`EFAULT`, errno 21. The import never fetches file payloads.

## Path probe

`runtime_fs.path_probe(dirfd: u32, paths_ptr: u32, paths_len: u32, kind: u32, found_ptr: u32) -> i32`
finds the first of several pathnames that names a regular file or a directory, in one filesystem
request. Module resolvers probe many candidates for one specifier (`./x`, `./x.ts`, `./x.js`, ...,
and `node_modules/name` in every ancestor directory). Each `path_filestat_get` is a round trip to
the filesystem worker, and most candidates are misses. The import returns zero or a positive WASI
errno. The WASI adapter supplies it without activating process services.

`paths_ptr` and `paths_len` hold one to 64 pathnames, each followed by a NUL byte. Each pathname
is its exact UTF-8 bytes, including a leading U+FEFF. `kind` 1 looks for a regular file and 2 for
a directory. Each pathname is looked up from `dirfd` as `path_filestat_get` with
`LOOKUPFLAGS_SYMLINK_FOLLOW` looks it up, so every link is followed, including the final one. The
lookups run in order, in one request, against one state of the tree, and stop at the first match.

Success writes the index of the first pathname that names a `kind` node to the u32 at
`found_ptr`, or `0xffffffff` when none does. A pathname that a stat could not resolve does not
match and is not an error: a missing component, `ENOTDIR`, `ELOOP`, a denied ancestor search, an
absolute pathname, an empty pathname and an escape from a capability outside the root namespace
all just fail to match. A symbolic link to the wanted kind matches; a dangling link does not.

A list that is empty, does not end in a NUL, holds malformed UTF-8 or holds more than 64
pathnames returns `EINVAL`, errno 28, as does any other `kind`, before any lookup or write. The
call checks the directory descriptor's `PATH_FILESTAT_GET` right: a bad descriptor returns
`EBADF`, errno 8, a descriptor that is not a directory returns `ENOTDIR`, errno 54, and a missing
right returns `ENOTCAPABLE`, errno 76. Invalid pointers return `EFAULT`, errno 21. Errors leave
`found_ptr` unchanged. The import never fetches file payloads.

## Guest filesystem watches

A synchronous guest reads committed watch events through five `runtime_fs` imports. The WASI
adapter supplies them without activating process services. Opening a watch needs a filesystem that
offers watches (`FileSystem.watches`, which `FilesystemClient` provides), or returns `ENOTSUP`,
errno 58. Open, read and close return a **positive WASI errno, 0 on success**; readiness returns
an i32 boolean. Arguments are unsigned i32.
Calls with output spans validate every span before any state changes (`EFAULT` 21), and reject
overlapping output spans (`EINVAL` 28) before draining or writing. Output is
little-endian. Ids are process-local positive u32 values, never reused within the process. They
are not descriptors: `fd_kind`, `dup`, `fd_close`, spawn bindings, `/dev/fd` and `poll` don't see
them.

```text
runtime_fs.watch_open(fd: u32, flags: u32, out_id_ptr: u32) -> errno
  fd     an open file or directory descriptor of the caller; the watch follows that node's identity
  flags  bit0 RECURSIVE (descendants of a directory; ignored for a file). Other bits: EINVAL 28
  out    u32 id

runtime_fs.watch_ready() -> i32
  1        at least one registered watch may return records, end or an error
  0        no registered watches, or every registered watch is idle

runtime_fs.watch_read(id: u32, buf_ptr: u32, buf_len: u32, out_len_ptr: u32) -> errno
  0        out_len > 0: that many bytes of whole records written
           out_len = 0: end of stream (the overflow record was already returned). Close the id
  6        EAGAIN: open, nothing pending. Nothing written. No service round trip if the
           filesystem counter hasn't moved since the last service drain
  42       ENOBUFS: the first pending record doesn't fit; out_len = its size; nothing consumed
  8        EBADF: unknown or closed id
  11       ECANCELED: the filesystem connection was revoked (the id stays closable)

runtime_fs.watch_next(out_id_ptr: u32, buf_ptr: u32, buf_len: u32, out_len_ptr: u32) -> errno
  0        out_id = ready watch id; out_len > 0: whole records written; out_len = 0: end of stream
  6        EAGAIN: no registered watch has pending records, end or an error. out_id = 0
  42       ENOBUFS: out_id = ready watch id; out_len = first record size; nothing consumed
  28       EINVAL: output spans overlap (out_id, out_len, and buf when buf_len > 0); nothing drained
  other    watch-scoped service error (e.g. EACCES 2, ECANCELED 11): out_id = affected watch id,
           out_len = 0; unscoped service error: out_id = 0; or EFAULT 21 when out of guest memory

runtime_fs.watch_close(id: u32) -> errno       0, or 8 for an unknown or already closed id
```

Record (stride = `8 + ((name_len + 3) & ~3)`, or `8` when the name is null):

```text
u8  type      1 change, 2 rename, 3 overflow (terminal)
u8  0
u16 0
u32 name_len  UTF-8 byte length; 0xffffffff = null (file watch, or overflow)
u8[name_len]  relative path, '/'-separated, no NUL, lossless UTF-8; zero padding to 4
```

The largest record is 8 + 12,288 bytes (4,096 UTF-16 units at no more than 3 bytes each), so a
64 KiB buffer always fits.

`watch_open` errors: `EBADF` 8 (bad fd), `EINVAL` 28 (fd is not a file or directory, or bad flags),
`EFAULT` 21. The rest pass through from the service: `EACCES` 2 (read permission, plus search for a
directory), `ENOENT` 44 (detached node), `EAGAIN` 6 (the root watch allocation/work budget or an incomplete
notification index), `ENOMEM` 48 (native backing allocation failure), `ENOTSUP` 58 (backend can't watch), and `ECANCELED` 11 (revoked). No
descriptor rights are required. The authority is the caller's own open description plus the
service's capability and inode checks.

Each watch keeps its own `observed` copy of the root's commit counter (`cells[3]`, which
revocation and reap also advance), sampled before
the open's service call. `watch_read` is scoped to that watch: it copies whole records from the
watch's local queue, returns `EAGAIN` without a service call when the counter hasn't moved, and
otherwise updates `observed` and performs one per-watch service read (never draining other
watches). `watch_next` drains ready watches in bounded batched service replies (`watchDrain`)
when supported by the active backend role, delivers all buffered batches before starting another
drain so per-watch guest queues stay bounded, and falls back to per-watch reads when batched
draining is unavailable. An overflow batch becomes the single type-3 record. A false `EAGAIN`
would need exactly 2^32 commits between two reads of one watch.

### Delivery guarantee

> Let process P hold watch W (opened successfully, still open, not ended, connection not revoked).
> Let mutation M be a filesystem call that **began after `watch_open` returned** and **returned success
> to its caller**: a WASI call in any guest of the same runtime root, or a settled page
> `SharedFilesystem`/`FilesystemClient` call. M must change something W reports: the watched node
> itself, a direct child, or (with RECURSIVE) a descendant reachable through directories readable and
> searchable from the root, with the root's mode still allowing read (and search, for a directory)
> and the name within bounds. Then a **drain** of W (consecutive `watch_read` calls by P, the first
> beginning after M's call returned, continuing until `EAGAIN` or end) returns a record of M's
> type and name, or an overflow record.

- The unit is the **drain, not one read**. Records queued earlier come first, and a buffer can end
  before M's record.
- **Coalescing.** M's event merges with an identical (type, identity, name) event still queued unread
  in the service. The drain then returns that earlier record, which already stands for M. Events
  that have moved to P's local queue are not merged, so a later identical event produces another
  record. Neither one record per write nor an exact count is promised.
- **Not covered:** an M that overlaps `watch_open` (it may fall into the baseline), failed or uncommitted
  calls, writes to another root, aliases outside the watched root, persistence or flush completion,
  ordering between independent writers, and ordering against any non-watch source.

### Readiness

`watch_ready()` is a non-consuming query across this process's registrations. It returns 1
for local queued records, an unobserved root commit, an ended registration, or a revoked
filesystem with a registration still present. End and revocation remain ready until the guest
closes or drops the registrations. No watches, all closed watches, and a filesystem without watch
support return 0. The query makes no service call, writes no guest memory, and does not change
ids, queue cursors, observed counters, overflow or end state. It does not clear errors.

A root commit can leave a watch without matching records, so 1 permits `watch_read` to return
`EAGAIN`; readiness is not a guarantee of a matching event. A guest can query once per turn
containing watches, skip empty reads when it returns 0, and drain watches before other sources.
It must query again on later turns, including after reentrant callbacks or writes.

There is no watch poll subscription and no timer. `Wasi.filesystemWatches` exposes the process's
`GuestWatchReadiness`: `pending()` is true while a watch has local records, or its `observed`
differs from the counter and it hasn't ended. Under exclusive-owner modes (`!remote`), it is
false after revocation. Under shared-host `whenBusy: "attach"` mode (`remote: true`),
`pending()` remains true once after revocation while a watch is open so a blocking poll wakes
and observes `ECANCELED` on `watch_read`, after which `pending()` returns false so later polls
do not spin.

- A blocking guest arms its [mixed notification set](#mixed-notification-waits) with its
  `NetHost`, then calls `NetHost.attachNotifications(set, () => wasi.filesystemWatches)`. `poll`
  then waits on that set, which already covers `cells[3]`, and returns 1 when a watch is pending.
  A counter move with no pending watch keeps waiting on the same deadline; a closed set returns 0.
- A nonblocking host using `NetHost.onNews` also gets its callback when a commit leaves a watch
  pending. That costs one readiness check per commit in the root.
- `runtime_proc.poll` is unchanged; a watch never covers or appears in its subscriptions.

`proc_exit` and process descriptor disposal forget the ids locally. The filesystem session's close
releases the service subscriptions, including after forced termination. Ids are not inherited by
spawned processes. The service, bounds and overflow rules are in
[committed filesystem watches](filesystem-watch.md).

## Advisory file locks

`runtime_fs` exposes inode-keyed advisory file locks matching Linux (`fs/locks.c`) and gVisor
(`pkg/sentry/fs/lock`), separating BSD open-file-description locks (`flock`) from POSIX byte-range
locks (`fcntl`), and additionally supporting Linux OFD byte-range locks (`F_OFD_*`). Both imports
return **positive WASI errno** (`0` on success).

```text
runtime_fs.fd_flock(fd: u32, operation: u32) -> errno
runtime_fs.fd_lock(
  fd: u32,
  cmd: u32,
  type: u32,
  whence: u32,
  start: i64,
  len: i64,
  out_ptr: u32,
) -> errno
```

### Whole-file locks (`fd_flock`)

`operation` uses the standard `sys/file.h` bits: `LOCK_SH` (`1`), `LOCK_EX` (`2`), `LOCK_UN` (`8`),
optionally OR'd with `LOCK_NB` (`4`). Exactly one base operation must be selected; unknown bits or
multiple base operations return `EINVAL` (`28`).

Locks are scoped to the **open file description (OFD)**:

- `dup` and descriptors inherited across `spawn`/`exec` share one OFD identity and therefore share
  the lock.
- Re-locking through the same OFD updates the mode: `LOCK_EX -> LOCK_SH` downgrades and wakes
  waiting shared lock requests; converting between `LOCK_SH` and `LOCK_EX` drops the prior lock
  before checking contention (matching Linux `flock(2)` even when `LOCK_NB` is set, so a failed
  nonblocking `LOCK_SH -> LOCK_EX` conversion returns `EAGAIN` without leaving `LOCK_SH` held and
  two blocking upgraders do not deadlock).
- No read or write right is required on `fd`; regular files and directories are lockable. Pipes,
  sockets, terminals and `/dev/null` return `EINVAL`.
- Closing the last descriptor referencing an OFD, or exit/revocation of all sessions holding that
  OFD, releases the lock automatically and wakes queued waiters.
- Multi-tab `whenBusy: "attach"` storage (`MultiTabBackend`) returns `ENOTSUP` (`58`) rather than
  granting tab-local locks across tabs.
- Lock metadata (active flocks, byte-range segments, queued waiters, and unsettled replies) is
  bounded; requests exceeding the limit return `ENOLCK` (`46`) without mutating state. `LOCK_UN`,
  non-splitting `F_UNLCK` (including whole-range unlocks), and descriptor closes always succeed; a
  middle-range `F_UNLCK` that splits one locked range into two when at the byte-range cap returns
  `ENOLCK` (`46`) without mutating state, matching Linux `fcntl(2)`.

### Byte-range locks (`fd_lock`)

`cmd` selects the operation: `0` = `F_GETLK`, `1` = `F_SETLK`, `2` = `F_SETLKW` (process-scoped
POSIX record locks), and `3` = `F_OFD_GETLK`, `4` = `F_OFD_SETLK`, `5` = `F_OFD_SETLKW`
(open-file-description-scoped byte-range locks). `type` is `0` = `F_RDLCK`, `1` = `F_WRLCK`, or
`2` = `F_UNLCK`. `whence` is `0` = `SEEK_SET`, `1` = `SEEK_CUR`, or `2` = `SEEK_END`. `len == 0`
locks through EOF (infinity); negative `len` locks `[pos + len, pos)`. Resulting negative offsets
return `EINVAL` (`28`); offsets above `Number.MAX_SAFE_INTEGER` return `EOVERFLOW` (`61`).

- `F_SETLK` / `F_SETLKW` (and their `F_OFD_*` variants) require `RIGHT_FD_READ` for `F_RDLCK` and
  `RIGHT_FD_WRITE` for `F_WRLCK` (`EBADF`, `8`, otherwise).
- A lock owner never conflicts with itself: overlapping edits split, replace and coalesce ranges.
- POSIX record locks are owned by the logical process: thread members (`processKind: "thread"`)
  share ownership with their process leader, and locks survive a successful `exec` for descriptors
  inherited into the replacement image (while descriptors closed on `exec` release the process's
  POSIX locks on their inodes).
- `F_GETLK` / `F_OFD_GETLK` require `type` to be `F_RDLCK` or `F_WRLCK` (`F_UNLCK` returns
  `EINVAL`, `28`), validate the 24-byte little-endian output span at `out_ptr` (`EFAULT`, `21`, if
  invalid), and write `{ u32 type, i32 pid, i64 start, i64 len }` (`type = F_UNLCK` when no
  conflict exists; `pid = -1` for conflicting OFD locks).
- Blocking waits (`F_SETLKW`, `F_OFD_SETLKW`, and `fd_flock` without `LOCK_NB`) wait outside the
  filesystem service's serial mutation queue so lock holders can unlock, close or exit without
  stalling. POSIX `F_SETLKW` checks the wait-for graph and returns `EDEADLK` (`16`) on cycles.
- Handled signals interrupt blocking waits with `EINTR` (`27`); fatal signals unwind through the
  process signal guard; filesystem revocation returns `ECANCELED` (`11`). Cancelled requests that
  race a lock grant roll back only their own operation's acquired/modified byte sub-intervals and
  wake the next waiter without undoing disjoint edits by another holder of the same OFD.
- Per POSIX, closing **any** file descriptor referring to an inode releases all process-scoped
  POSIX record locks held by that process on that inode while leaving `flock` and `F_OFD_*` locks
  on other open file descriptions intact. Session revocation or process exit releases every lock
  whose sole remaining live holder was that session (and releases POSIX locks only once the last
  live thread/session of that logical process exits). Locks follow the inode across `rename` and
  `unlink`.

## Internal network module

The Rust socket module is not a guest import namespace. Its virtual loopback commands and address rules are unchanged by the outbound connector. Trusted embedders use the separate [Network module ABI](network-module.md). Browser instances do not provide OS socket authority.

## Internal filesystem walk operations

Process workers can call `FilesystemClient.walkOpen(directory, plan)`,
`walkPage(cursor, { grant, maxEntries })`, `walkRelease(grants)` and
`walkClose(cursor)`. These are service operations, not guest WebAssembly imports
or page filesystem capabilities. Types live in `fs/walk.ts`; `fs/glob.ts` provides
the shared pure glob compiler. The existing session and directory capability
supply all authority.

Each session admits four walks and at most 256 live file grants across all walks
and in-flight batches. Each page contains at most 128 entries, and its entire
packed reply, including the next cursor, fits 64 KiB. Release the exact grant
tokens through `walkRelease`; ordinary handle retains have separate lifetimes.
A zero-credit or invalid request leaves the cursor unchanged. Page cursors are
session-local and single-use. Keep the original cursor for `walkClose` in cleanup;
closing releases all of that walk's grants, including its final page.

The service snapshots each directory's names and inode identities on entry,
rechecks ancestor and directory read/search permissions, skips symlinks and
opaque socket entries, and reports removed or replaced paths as `ENOENT` entries.
Walk state is bounded to 128 directory frames, 65,536 snapshotted entries and
1,048,576 name/path UTF-16 units per walk; paths are limited to 4,096 units.
Traversal errors appear as error entries or fail the page without committing it;
the caller can close the original cursor. Revocation and reap release all walk
state. Failed or cancelled reply publication rolls back staged grants and cursor
changes. Cancelling an already published, unconsumed reply closes its walk.
