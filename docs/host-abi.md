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

## Process admission

`BrowserProcessBroker` reserves identities and descriptor bindings synchronously, then activates the lazy supervisor. Worker bootstrap receives a compiled module, argv, environment, filesystem connection and optional process transport. Source bytes must pass interruption admission; a precompiled module is accepted only with explicit cooperative execution.

## Process identity import

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

These values are append-only: existing numbers must never be reused or renumbered.
No socket kind is assigned. Guests must not interpret preview1 `UNKNOWN` as a pipe.
The shared `ProcessABI` exposes the import in host and worker process adapters;
the browser's signal-only worker namespace also exposes it without activating the
process service. The descriptor number itself (including stdio 0, 1 and 2) never
determines its kind.

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

Pipes, terminals and directories receive a new binding to the **same** description, like
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
it is separate from guest WaitResult kind 2. These are the seven produced errors:

| Error   | Host code | Guest WASI value | Cause                                                                                                     |
| ------- | --------: | ---------------: | --------------------------------------------------------------------------------------------------------- |
| ENOENT  |         2 |               44 | Missing executable or missing path component                                                              |
| EACCES  |        13 |                2 | Directory or existing file without its admitted executable registration                                   |
| ENOTDIR |        20 |               54 | A file used as a directory, including a trailing slash on a file                                          |
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
separate cursor arena remains bounded at 16,777,216 cells (256 MiB).

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

## Network and preview

The network helper performs injected `fetch` operations and writes responses to a shared ring. The host side exposes nonblocking handles and preview HTTP framing. Preview routing and service-worker registration are consumer policies; Waffle exports the routing and protocol services without choosing a URL scope.

## Compatibility

Waffle does not promise compatibility with an older runtime package or a stale consumer. Consumers pin one exact Git commit and use the matching exports and lockfile.

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

## Internal network module

The Rust socket module is not a guest import namespace. Guest network calls, numeric results, ring records, addresses, and JSON errors are unchanged. Trusted embedders use the separate [Network module ABI](network-module.md). Browser instances do not provide OS socket authority.
