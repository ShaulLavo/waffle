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

`runtime_proc.getpid: () -> i32` returns the calling process's own positive runtime PID,
not its parent PID or job ID. `ProcessABI` reads its already-bound `options.pid` directly;
the call takes no arguments, reads no guest memory, never waits and sends no service or
broker request. In-process and worker adapters expose the same import. It adds no eager
process-service activation, helper export or RPC operation.

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
the inode to zero; `APPEND` selects EOF for each write. Other preview1 fdflags, including
`NONBLOCK`, are retained in fdstat. `CREAT` or `EXCL` returns `EINVAL` (28), `DIRECTORY`
returns `ENOTDIR` (54), and unknown flag bits return `EINVAL`.

The source's rights do not restrict a regular-file reopen: a write-only descriptor can
reopen for reading if the inode allows it. Current [inode access policy](permissions.md)
is authoritative (`EACCES`, 2). The caller's live `/` preopen must still allow `PATH_OPEN`,
the requested rights must fit its inheriting rights, and `TRUNC` requires its
`PATH_FILESTAT_SET_SIZE` right (`ENOTCAPABLE`, 76). No root preopen means no regular-file
reopen. Rights stripped from the root are not restored by reopening another descriptor.

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
components before processing `.` or `..`; escaping the capability root returns `EPERM`
(63), just as ordinary filesystem resolution does. A trailing slash or `/.`
requires a directory source (`ENOTDIR`, 54, otherwise), before any truncation. They resolve
against the **calling process's current descriptor table**, including inherited/remapped
stdio and fd 3 when the root preopen has moved. They use the same reopen operation,
while also checking the path-open directory's rights and the requested inheriting rights.
A missing descriptor returns `ENOENT` (44), not `EBADF`. These are WASI-only virtual names:
no per-process entries or symlinks are installed in shared MemFS.

A regular-file stdout/stderr opened with `APPEND` does not force a later reopen to append.
For example, redirecting `echo x >/dev/stderr` with `TRUNC` leaves exactly `x\n`, even when
stderr's original description had `APPEND`. Reopening with `APPEND` (`>>`) preserves old
bytes and appends `x\n`. Neither operation advances the source description's offset or
changes its flags. Pipes and terminals keep shared-stream behaviour.

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

A browser worker may select START_FAILED before its ordered error message reaches
the broker. Startup queries can observe that result immediately, but consuming waits
and inherited-descriptor release remain gated on the final error acknowledgement (or
an observed worker failure). The supervisor handles the selected startup failure once,
regardless of which producer selected the result; a competing exit or signal emits none.
The generic worker does not also emit this startup diagnostic.

For a child spawned through `runtime_proc`, the typed START_FAILED outcome is the only
Waffle report delivered to its guest parent. Waffle's generic startup fallback writes zero
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

Default actions terminate with a typed signal outcome except `SIGCHLD` (17),
`SIGCONT` (18), `SIGURG` (23) and `SIGWINCH` (28), which leave a running process alive.
Explicit handlers still receive these signals through the same pending-signal table.
Restoring default disposition discards pending delivery for a default-ignored
signal, but selects terminal default action for a pending terminating signal.
`default_signal` applies the same default actions independently of registered
handlers; ignored defaults return zero without revocation or terminal unwind.
An already-selected `SIGKILL` remains authoritative across all these paths.

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
immediately releases that child's shared process slot, independently of its job.
A subsequent wait, or a wait for a non-child, returns `-ECHILD` (`-12`). Pipe-owner
metadata has been released by the cleanup fence; a consuming wait never retains it.
An exited but uncollected child remains a zombie and retains process capacity.
Choosing an outcome alone is not proof that a Worker's resources are safe to release.
Shared collectibility is published before host exit observers and waiters see the
result, so a consuming host wait can immediately reserve replacement capacity.

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
on `EAGAIN` rather than entering a blocking filesystem transaction.
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

The browser broker can own one notification helper Worker per guest. Pass
`notificationWorkerUrl` to `BrowserProcessBroker.launchWorker()`. Bundle the
`waffle/browser/notification-worker` entry separately as a module Worker, just as
an embedding bundles its guest Worker. Both Workers require shared memory and
`Atomics.waitAsync`. The guest remains free to block synchronously.

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

`covered` is conservative. Process registration with `registerPoll(subscriptions,
"shared")` owns no guest-local release callbacks and covers only sources already
publishing to the process common word. Independent streams, terminal/resize
sources and CHILD_START remain uncovered. Their presence caps each wait at the
existing 10 ms fallback. Changing subscriptions recomputes coverage. Existing
`runtime_proc.poll` and ordinary local `registerPoll()` behavior are unchanged.

The broker installs external ownership before launch and revocation registration.
It fences the common state and terminates the helper on revoke, startup failure
and guest completion, and before physical guest termination. Broker disposal joins
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
shm_accept(pin, out{handle, addr, len}) -> 0          owner only: +1 hold, pin consumed
shm_unpin(pin) -> 0                                   owner only: delivery discarded
futex_wait32(addr, expected: i32, timeout_ns: i64) -> 0 ok, 1 not-equal, 2 timed-out
futex_wait64(addr, expected: i64, timeout_ns: i64) -> same
futex_wake(addr, count) -> number woken (sync waiters, then watches in registration order)
futex_watch(addr, expected: i32, out{id}) -> 0
futex_unwatch(id) -> 0
parallelism() -> the group's reported parallelism
```

`group_grow` chunks need not be contiguous with earlier ones. A negative `timeout_ns` waits
forever; `count` `0xffffffff` wakes every waiter. Waits must be 4- or 8-byte aligned. Hard
termination of the member's worker is the cancellation path for a blocked wait.

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
standard import. Unknown imports still fail linking. Listener bindings and `sock_accept` on a
listener are not implemented.

`waffle/browser/preview1-network` exports `createPreview1Network(runtime, options)` and the types
`Preview1NetworkOptions`, `Preview1SocketBinding`, `Preview1NetworkConnection` and `Preview1Network`.
The options are `{ sockets: readonly Preview1SocketBinding[], connect?: NetConnect }`.
Each binding is `{ fd, socket: { connect: { host, port } } }`. Targets use the existing `NetHost`
connect rules. The fd must be a unique integer in `0..0x7fffffff`; ports are in `1..65535`.
The selected executor's `hostCallFd` is reserved for its host-call trampoline. Bootstrap rejects
socket bindings at that number with `ENOEXEC` before opening sockets or installing descriptors.
The launcher still disposes its network helper on this startup failure.

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
    readonly socket: { readonly connect: { readonly host: string; readonly port: number } };
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
flags, filestat, polling and shutdown. Duplicate fds share flags, the handle and its final-close
lifetime. Passing a socket to a `runtime_proc` child returns `NOTSUP`, errno 58, before descriptor
export. Sockets may be rebound within the same process with `fd_reopen` or `dup`.

| Import                                                   | Socket behavior                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sock_send(fd, iovs, count, flags, out_written)`         | Flags must be zero, otherwise `NOTSUP`. Partial writes are valid. It waits for open and credit unless `FDFLAG_NONBLOCK` is set, which returns `AGAIN`. After write shutdown, writes return `PIPE`. A failed connect returns its mapped errno on the first send and `PIPE` on later sends.                                           |
| `sock_recv(fd, iovs, count, flags, out_read, out_flags)` | Flag 2 is `RECV_WAITALL`; it reads until full, EOF or error. Nonblocking calls return available partial bytes, or `AGAIN`. `RECV_PEEK` and unknown flags return `NOTSUP`. EOF returns zero bytes. Success writes zero to `out_flags`.                                                                                               |
| `sock_shutdown(fd, how)`                                 | `1` discards and ends local reads without a wire FIN. `2` sends FIN after queued writes. `3` does both. Other values return `INVAL`. Peer FIN still permits writes.                                                                                                                                                                 |
| `fd_read`, `fd_write`                                    | Same descriptor I/O without socket flags.                                                                                                                                                                                                                                                                                           |
| `poll_oneoff`                                            | Uses the existing multi-source readiness wait and the network ring's notification word. FD_READ reports buffered bytes in `nbytes`. Errors appear in the event's errno. A peer FIN read event has HANGUP but does not end the local write side. FD_WRITE becomes unavailable when credit is exhausted and resumes after `Writable`. |
| `fd_close`                                               | The last reference closes gracefully. Worker or owner disposal resets outstanding streams, including pending opens.                                                                                                                                                                                                                 |
| `sock_accept`                                            | A connected socket returns `INVAL`; listener support is deferred.                                                                                                                                                                                                                                                                   |

For every `sock_*` call, a valid non-socket fd returns `NOTSOCK`, errno 57; an absent fd returns
`BADF`, errno 8. The adapter's `HOST_CALL_FD` special case in `sock_send` stays first and unchanged.
Socket iovecs and result spans are validated before I/O; faults return `FAULT`, errno 21.

These are additive imports and descriptor values. `waffleHostInterface` remains 1 under the bump
rule below. Existing calls retain their behavior; no old-shape fallback or version negotiation
is added. bun-wasm's separate `preview1Launcher` must adopt this connection payload and keep its
connector on the responsive page. That consumer handoff and a real outside line/echo exchange
are separate release gates. The scripted SSLRequest fixture proves bytes only, not a Postgres
query.

## Compatibility

Consumers pin the exact runtime build in their dependency and lockfile. Host compatibility is a separate package-metadata check, not a comparison of package versions or build identities.

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
changed signature, or incompatible result, error, readiness, authority, or lifetime rule does.

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
must be nonempty, valid UTF-8 and contain no NUL. Flags must be zero; follow-link or other flags
return `ENOTSUP`, errno 58, because symlinks are unsupported.

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

## Guest filesystem watches

A synchronous guest reads committed watch events through three `runtime_fs` imports. The WASI
adapter supplies them without activating process services; they need a filesystem that offers
watches (`FileSystem.watches`, which `FilesystemClient` provides), and return `ENOTSUP`, errno 58,
otherwise. All three return a **positive WASI errno, 0 on success**. Arguments are unsigned i32.
Each call validates every output span before any state changes (`EFAULT` 21). Output is
little-endian. Ids are process-local positive u32 values, never reused within the process. They
are not descriptors: `fd_kind`, `dup`, `fd_close`, spawn bindings, `/dev/fd` and `poll` don't see
them.

```text
runtime_fs.watch_open(fd: u32, flags: u32, out_id_ptr: u32) -> errno
  fd     an open file or directory descriptor of the caller; the watch follows that node's identity
  flags  bit0 RECURSIVE (descendants of a directory; ignored for a file). Other bits: EINVAL 28
  out    u32 id

runtime_fs.watch_read(id: u32, buf_ptr: u32, buf_len: u32, out_len_ptr: u32) -> errno
  0        out_len > 0: that many bytes of whole records written
           out_len = 0: end of stream (the overflow record was already returned). Close the id
  6        EAGAIN: open, nothing pending. Nothing written. No service round trip if the
           filesystem counter hasn't moved since this watch's last service read
  42       ENOBUFS: the first pending record doesn't fit; out_len = its size; nothing consumed
  8        EBADF: unknown or closed id
  11       ECANCELED: the filesystem connection was revoked (the id stays closable)

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

Each watch keeps its own `observed` copy of the root's commit counter (`cells[3]`), sampled before
the open's service call. `watch_read` first copies whole records from the watch's local queue.
With an empty queue, an unchanged counter returns `EAGAIN` without a service call. A moved counter
updates `observed` before one synchronous service read, whose batch fills the queue; an overflow
batch becomes the single type-3 record. A false `EAGAIN` would need exactly 2^32 commits between
two reads of one watch.

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

There is no watch poll subscription and no timer. `Wasi.filesystemWatches` exposes the process's
`GuestWatchReadiness`: `pending()` is true while a watch has local records, or its `observed`
differs from the counter and it hasn't ended. It is false after revocation.

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
