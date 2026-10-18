# Waffle

Browser runtime layers, consumed as a local TypeScript package. `./core`, `./fs`, `./proc` and
the lightweight `./proc/stub` are available now. Network and terminal implementations get their
own `./net` and `./term` entries as those plan steps land; core imports none of them.

```ts
import { Wasi } from "waffle/core";

const wasi = new Wasi({
  args: ["program"], env: {}, fs, preopens: { "/": "/" },
  stdout: bytes => output(bytes), stderr: bytes => errors(bytes), sleep,
});
const instance = new WebAssembly.Instance(module, wasi.imports(module));
const status = wasi.start(instance);
wasi.descriptors.dispose();
```

`FilesystemClient` from `./fs` implements `FileSystem`; the direct memory backend lives in
`fs/memory.ts` and is also exported as `./fs/memory`. Its handles
are filesystem-owned identities, not paths, reported inode numbers, or concrete tree nodes. A handle
used by an open description must remain valid after rename or unlink. The host calls `retain`/`release` once per
open description, not per duplicate; a filesystem worker can use those calls to reclaim detached
files after their final open description closes. `resolve` walks the real tree relative to
a directory capability and returns a handle or positive WASI errno. Other path operations work
on that result, revalidating it against concurrent path changes. Reads and
writes return byte counts or negative WASI errno, like streams; failures
do not advance the shared cursor. Resize and timestamp updates return zero or positive WASI errno.
Path operations use positive errno (creation wraps errors to distinguish them from handles).
`append` selects EOF and writes the complete iovec atomically, returning both committed bytes and
the resulting description offset. `create` carries exclusivity so competing nonexclusive creators
open the same current entry instead of replacing it or failing spuriously.
`readdir` produces one entry list per call. The blocking worker adapter implements this interface
with `Atomics.wait`, without changing preview1.

## Process service

`ProcessSupervisor` from `./proc` owns process records and separate foreground/background job
records. Its injected launcher starts one worker per process; the supervisor never executes a
guest inline. `ExecutableRegistry` maps any executable name to a compiled module (or a cached
asynchronous loader) and an opaque guest-adapter key. The Bun adapter uses its existing slots
12–15, while the same worker bootstrap can execute an ordinary preview1 module.

`reserveSpawn` synchronously snapshots argv/env/cwd and retains descriptor bindings (including
nonstandard fds); `start` asynchronously resolves the module and launches the worker. `spawn`
combines them without waiting. `FirstSpawnStub` from `./proc/stub` reserves before returning and
shares a single delayed activation promise. `ProcessIdentityAllocator` supplies monotonic ids in
shared memory so a blocked guest can reserve its pid before the page imports the service.
`wait` is nonblocking; `waitForExit` and `onChildExit` provide asynchronous completion.
Missing and non-runnable executables publish a typed `start-failed` outcome with
`ENOENT` or `EACCES`, separate from ordinary exits. The runtime_proc wait adapters
map those outcomes to 127 and 126 for guest compatibility.

`WorkerProcessClient` and `WorkerProcessBroker` connect a worker's descriptor table to that same
supervisor. `createWorkerProcessTransport` reserves shared process identities; spawn retains
serialized capabilities before posting its admission message. `WorkerDescriptorCodec` keeps the
transport independent of each resource implementation. `createFilesystemDescriptorCodec` transfers
file and directory capabilities with independent child pins and one shared open-file cursor, so
closing, unlinking or terminating the parent cannot invalidate an admitted child's descriptions.
Duplicate bindings retain their individual rights while sharing their original description.
Process-specific streams use `forProcess(pid)` once per description; their `revoke()` hook runs
before descriptor release and before `wait` or child-exit notification becomes observable.

The browser accepts an optional `runtimeProcess` transport in its run request. This path installs
all inherited bindings, including arbitrary fd numbers, before guest launch and shares the existing
supervisor with Bun subprocesses. Its codec and broker chunks remain lazy; ordinary Bun startup
does not load the generic ownership adapters. Startup failure releases the transferred capabilities.

Each process has per-signal default, ignored or handled dispositions. `kill` immediately selects
SIGINT/SIGTERM/SIGPIPE's default signaled outcome (`128 + signal`) and revokes descriptors when
no handler is registered. Ignored signals do nothing; handled signals set their own pending bit
without revoking the guest, whose ordinary `exit` retains its code. Registration and removal are
synchronous, including restoring the default when the last listener is removed. Distinct pending
signals cannot overwrite one another; repeated instances of one signal may coalesce. Removing a
pending handler to default applies that default immediately; ignoring it clears the pending bit.
The shared interrupt word is a wake hint, not the authoritative queue. `observeSignal` adopts a
request already published by a guest without publishing it again.

The preview1 adapter exposes `runtime_proc.signal(sig, mode)` for registration and self-signals,
`runtime_proc.interrupted()` for dequeue, and `runtime_proc.default_signal(sig)` for an explicit
default action. Bun uses optional host slot 18 and pumps handled signals during event-loop turns;
listener registration alone does not keep a guest alive. SIGKILL always records 137 and revokes
immediately, then requests termination; it cannot be caught or ignored. Late worker messages cannot
change a selected outcome. Guest and supervisor completion compete for one shared atomic terminal
result, so startup failure racing termination cannot leave their waits with different statuses.
The result also distinguishes ordinary exit 143 from the default SIGTERM action.
There are no escalation timers. `killJob` addresses the job namespace, including descendants in
that job but not unrelated background jobs.

Revocation hooks connect logical process death to host capabilities. Filesystem revocation is
not proof of physical teardown: an exit acknowledgement or the filesystem's admission fence
must prove host critical sections quiescent before reaping and physical termination.
Each process has fresh interrupt/revocation/transport buffers;
killed buffers are never assigned to another process. The browser keeps pooling disabled:
measurements must justify enabling it per browser before adding idle workers.

The generic service's registry, process table and supervisor are dynamically imported on first
spawn. Small identity, typed-outcome and signal-state leaves are available earlier for synchronous
root control; importing them must not pull in the service barrel. The bundle gate checks both this
boundary and the approximately 1 KiB compressed first-spawn stub. Bun's existing pipe/slot transport
is measured separately and remains available alongside the lazy generic process adapters.
CPU-bound QuickJS/JSC interrupt checkpoints are step 7a. Handled signals already dispatch during
cooperative event-loop turns, while unhandled default actions are immediate and do not depend
on those future engine hooks.

## Registration leases

`Runtime.registerAdapter(name, launcher)` and `Runtime.registerProgram(name, definition)`
return unregister functions. Call the function to remove that exact registration; repeated
calls and calls after `Runtime.dispose()` do nothing. Active duplicate names still reject:
release a registration before replacing it. An old lease never removes its replacement,
even when the same launcher function is registered again. Removing a program prevents future
lookups; removing an adapter prevents future launches through that name. Neither operation
stops running processes or changes a launcher already accepted for an in-flight process.
Registration and removal do not activate the process service or load program sources.

### Executable paths and filesystem visibility

The page runtime requires an absolute, canonical program path, such as `/bin/bun`.
Bare names (`bun`), dot segments and repeated or trailing slashes reject immediately with
an explanatory `TypeError`. Registrants create the corresponding regular file separately;
registration does not write, replace or remove filesystem entries. A small marker file is enough:
program loading still comes from the registered source or module, not the marker's contents.

```ts
await runtime.filesystem.writeFile("/bin/bun", "registered executable\n");
const unregister = runtime.registerProgram("/bin/bun", {
  adapter: "bun:quickjs", module, cooperative: true,
});
```

This makes filesystem inspection, a shell's `$PATH` search and process admission agree on the
same path. The shell searches `$PATH`; Waffle's spawn does not. Spawn resolves its executable
relative to the request's snapshotted `cwd` and walks the actual filesystem tree before
canonicalizing the registration key, even for a cached module. A missing intermediate cannot
be canceled by a later `..`; a regular file used as a directory or given a trailing slash
produces `ENOTDIR` (shell status 126). A missing file produces `ENOENT` (shell status 127).
A directory or an existing regular file without a registered program produces `EACCES`
(shell status 126); directory diagnostics explicitly identify the directory. Deleting a registered
file or replacing it with a directory therefore prevents future execution. Releasing a registration
leaves its file untouched, so an existing unregistered marker is non-runnable rather than missing.

The low-level `ExecutableRegistry` remains usable with opaque names when constructed without a
filesystem lookup. Supplying a lookup enables the same canonical path and live-file admission
used by the page runtime; registration keys in that mode must be canonical absolute paths.
The lookup receives the original absolute path and returns `{ path, kind }`, where `path` is
canonical only after a successful real-tree walk. `check(name, cwd)` applies these same live
admission rules without loading or compiling a module; `resolve` checks again on each spawn.
Executable admission orders earlier queued filesystem mutations without consuming unrelated
mutation failures reserved for an explicit filesystem `drain()`.

## Guest executor extensions

`bootstrap(request, executor, host?)` from `waffle/browser/worker` creates a worker-local
`Wasi`; it never creates another page runtime. `WorkerExecutor` keeps guest-specific policy
outside Waffle. Its optional hooks run in this order:

1. `setup(context)` receives the request, filesystem client, signal state and helpers.
2. `namespaces(context)` returns extra `WebAssembly.Imports` namespaces for the linker.
   `runtime_proc` remains Waffle-owned; an extension cannot replace it here.
3. `beforeBindings({ wasi, ...context })` runs after default stdio and the root preopen are
   created, but before inherited descriptors are installed. It can release unused default
   stdio or preserve a preopen whose fd an inherited binding will replace.
4. `imports(imports, { wasi, ...context })` runs after descriptor binding and linking, before
   instantiation. Mutate the object and return nothing, or return a replacement import object.
   Supply extra namespaces in `namespaces`, since linking rejects unknown imports first.
   Imported memory must remain the same object: replacing it throws before instantiation,
   because WASI already binds its memory views for the module's Wasm start section.
5. `instantiated({ wasi, instance, ...context })` sees the bound descriptors and instantiated
   module. `run` receives the same context after preview1 `_start` returns or exits.

A hook that calls `context.finish` ends bootstrap immediately after that hook returns;
no subsequent hook or guest entry point runs. Supplied stdio is owned from bootstrap entry,
including setup/link failures, and is closed before any cleanup acknowledgement.

**Preopen discovery:** the default root remains at fd3. Waffle does not relocate it or remove
stdio implicitly. An adapter relocating preopens must preserve wasi-libc's discovery scan:
**it scans from fd3 upward and stops at the first non-preopen**. Merely retaining the root at
a higher fd behind an inherited non-preopen fd3 is insufficient. Coordinate any relocation
with preview1 preopen-discovery imports in the `imports` hook, without changing inherited fd
numbers or their resources.

`spawnData()` runs for each actual spawn under filesystem transfer admission. It returns
structured-cloneable, guest-specific metadata; `filesystem` and `pipeRegistry` are reserved
and overwritten with the runtime's authoritative capabilities. Metadata is not implicitly
copied from the parent: allocate any per-process admission state afresh in this hook.
Pipes retain their bounded defaults: 64 KiB capacity, 16 writers and 16 readers.

`resolveTerminal(target: 0 | 1 | 2): Stream` maps inherited terminal provenance to a
process-local endpoint, including interactive input. Capture request metadata during `setup`
if the endpoint needs it. The terminal codec owns provenance: duplication, redirection and
later generations preserve the original target, not the destination fd number. Bindings
sharing a transferred reference also share one open description; the resolver stream's
`close` runs on that description's last release. Without a resolver, stdin remains EOF and
output uses the host callbacks. The same resolver option is available directly on
`createRuntimeTerminalCodec` from `waffle/browser/runtime-terminals`.

`context.post("stdout" | "stderr", bytes)` writes through the **current** fd1 or fd2 after
Wasi creation, not a startup snapshot. File writes preserve append and shared offsets;
pipe and terminal writes use blocking stream I/O and return `true` only for a complete
write. A closed or directory fd returns `false`. Default terminal destinations still post
to the host directly, so aliases of those destinations do not follow unrelated redirects.
During `setup`, before Wasi exists, `post` uses the supplied stdio or host callback.

Adapter cleanup uses the existing lifecycle, not an extra worker-stop hook. Register a
`ProcessController` with the browser process service's `registerController(pid, controller)`:
`revoke` freezes adapter work, and `quiesce` fences its admitted critical sections. The broker
joins that fence with its own filesystem fence; the callback need not use borrowed runtime
filesystem methods (which are unavailable during disposal). A worker exit acknowledgement
can skip the filesystem-release wait, **never the adapter fence**. Normal exit, startup
failure, worker errors, kill and disposal all fence before physical worker termination or
exit confirmation. Rejected fences retain resources rather than claiming safe completion.
Non-root child controllers retire after physical stop, or after confirmed construction
failure when no worker exists. `Runtime.retainConsumer({ filesystem, revoke, stop })` owns
page-disposal cleanup for external consumers; release that lease from the worker launcher's
`cleanup` callback on normal completion. Neither physical termination alone nor a logical
exit proves quiescence. These extensions do not load process-service chunks or allocate
extension state before a worker is actually spawned.

## Process-owned pipes

`PipeController` owns a bounded pipe with one single-producer ring per writing process.
`retain(pid, "read" | "write")` creates a process endpoint; dup aliases share that endpoint,
while `forProcess(pid)` reserves an independent process lifetime before spawn returns.
`tryRead`/`tryWrite` are nonblocking; the stream `read`/`write` methods wait on shared readiness
notifications for preview1 hosts. Closing the last writer produces EOF after committed data
is drained; closing the last reader produces EPIPE.

`PipePublicationRegistry` supplies canonical publication and read-lease cursors. Authorized host
code marks a process revoked before freezing its linked cursors and exposing its exit. Cursor
allocation links a new cell and then rechecks revocation before admitting the endpoint, so growth
cannot escape a concurrent kill. Guest WASM never receives this control memory. A stopped
producer cannot publish past that frozen watermark, and killed buffers are never recycled.

Registry cells are append-only, 16 bytes each, in a growable shared buffer. A simple same-process
pipe uses four cells, or 64 bytes of lifetime metadata after its pipe buffers are released.
Defaults allocate about 2 MiB initially and allow 16,777,216 cells (256 MiB plus the header),
roughly 4,194,304 simple pipes per service; additional process endpoints consume more cells.
The separate process directory has 1,024 permanent PID rows. Exhausting either bound returns
WASI ENFILE (41), not a silent reuse. `cellsPerProcess` is an initial-size hint, not a lifetime cap.

A completed write precedes any write that begins later in another process. Writes of at most
4 KiB remain contiguous across short reads; deliberately tiny pipes use their capacity as the
atomic-write bound. Bounded record metadata participates in publication and backpressure.
A single reader consumes rings directly. Multiple reading processes use one supervisor-owned
relay rather than contending on a guest-held shared lock. Readiness does not reserve bytes;
unread deliveries can be recovered from an idle, closed or killed reader. Relay work yields
between bounded batches so kill and exit messages cannot be starved by continuous traffic.

`WorkerPipeHost` creates pipes and composes endpoint transfer with other descriptor codecs.
`WorkerPipeBroker` attaches each pipe once using its stable identity and retires its controller
only after every endpoint lifetime is closed or revoked, including pending transfers. Readers
may still drain data after writer EOF. Worker-created controllers use manual relay mode; only
a responsive controller starts the automatic relay.

### Process admission diagnostics

Pass `onProcessAdmission` to `createRuntime` to observe child admission without console logging:

```ts
import { createRuntime, type ProcessAdmissionEvent } from "waffle";

const admissions: ProcessAdmissionEvent[] = [];
const runtime = createRuntime({
  onProcessAdmission(event) {
    if (admissions.length === 256) admissions.shift();
    admissions.push(event);
  },
});
```

Each frozen event contains `pid`, `parentPid`, `job`, `stage`, and an optional stable `reason`.
Transport-backed events also include `directory`, an opaque shared-directory identity string;
PID and directory together distinguish independent transport namespaces. Direct-supervisor
launches may omit it. No buffers, arguments, environment variables, or error messages are included. The consumer owns history
and its size limit. The runtime retains none, and work without an observer avoids event allocation.
Observers must not reenter process control; thrown exceptions and rejected async returns are ignored.

`received` precedes the browser's sender guards, followed by `queued`, `reserved`, `bound`, and
`starting` for an accepted transfer. A reservation or start request is **not** proof of launch:
`launching` marks adapter entry and `launched` means that adapter returned its process handle.
`skipped` with `preselected-exit`, `preselected-signal` or `preselected-start-failed` identifies an outcome already selected
when admission requests startup. A cancellation during module resolution may leave history at
`starting`. These events describe admission, not process exit or teardown.
`rejected` reasons distinguish unknown, revoked, or signaled senders, a wrong sender, a missing
parent or mismatched directory, disposal, activation, reservation, binding, and startup failures.
`dropped` means a duplicate/already-registered transfer did not acquire a second resource lifetime.
External rejection uses `external-rejection` unless the caller supplies a more specific reason.
Lower-level `BrowserProcessBroker` and `WorkerProcessBroker` expose the same observer through
`onProcessAdmission` and `onAdmission` options respectively. The standalone transport broker
reports only transport admission; its host owns adapter launch and startup-failure diagnostics.

## Guest process ABI

`ProcessABI` is exported from `waffle/proc`. Install its `imports` as the
`runtime_proc` namespace alongside preview1, using the same `wasi.descriptors` table and memory.
The browser loads this adapter lazily for modules importing the extended process interface;
`adapter: "preview1"` runs a generic WASI executable without Bun's slot adapter. Existing Bun
slots and the signal-only preview1 path remain available.

Every call is nonblocking except `poll`. Descriptor I/O returns a byte count, zero for EOF or
zero-length I/O, or a negative WASI errno; a partial write is permitted. EAGAIN is -6 and EPIPE
is -64. Spawn reserves inherited capabilities before returning the child PID.

| Import | Contract |
| --- | --- |
| `spawn(ptr, len)` | UTF-8 JSON `{ executable, argv, env, cwd, job, fds: [{ child, parent }] }`; job 0 creates a foreground job, -1 creates a background job, and a positive value joins an existing job. Returns PID or negative errno. |
| `access_start(path_ptr, path_len, cwd_ptr, cwd_len, mode)` | Copies a UTF-8 executable name and absolute cwd synchronously. `mode` must be X_OK (`1`). Returns a positive process-owned request ID, or a negative errno; it never loads a module or allocates descriptors. |
| `access_take(request)` | Returns `-EAGAIN` (`-6`) while the query is pending, then consumes it and returns `0` when the live registered file is runnable, or `-ENOENT` (`-44`), `-EACCES` (`-2`), or `-ENOTDIR` (`-54`). A consumed or unknown request returns `-EBADF` (`-8`). |
| `access_cancel(request)` | Retires the request and discards any late filesystem/registry completion. Returns `0`, or `-EBADF` for an already retired request. |
| `pipe(out)` | Writes two little-endian u32 fds, reader then writer; returns 0. |
| `dup(fd)` | Returns a new fd sharing the open description and offset. Use preview1 `fd_close` to close either binding. |
| `read(fd, ptr, len)`, `write(fd, ptr, len)` | Use the same fd namespace as preview1. Filesystem cold reads/growth prepare asynchronously and return EAGAIN without consuming bytes or advancing the shared offset. |
| `wait(pid, out)` | Returns 0 and writes u32 kind (0 exited, 1 signaled), then i32 code; returns EAGAIN before confirmed cleanup. |
| `kill(pid, sig)`, `kill_job(job, sig)` | Return 0 or negative errno. PID targets require self/ancestor authority; a job requires its exact owner. |
| `job_of(pid)` | Returns the job ID or negative errno. |
| `poll(subs, count, timeout_ms, out)` | Returns event count; 0 on timeout or a pending signal. Timeout -1 has no deadline. |
| `interrupted()`, `signal(sig, mode)`, `default_signal(sig)` | Share the existing signal queue and dispositions; default actions unwind with `ProcessSignalExit`, distinct from an unrelated WASM trap. |

Poll subscriptions are 16 bytes: u32 kind, u32 id, u64 userdata. Output events are 16 bytes:
u64 userdata, u32 kind, u32 flags. All fields are little-endian. Kinds are readable fd (0),
writable fd (1), child exit (2), filesystem completion (3), job completion (4), and executable
query completion (5); flag bit 0 means hangup. Executable query requests are bounded to 64 live
requests per process and are retired automatically when the process exits.
Signals wake poll without being consumed. Pipe publication notifies a shared readiness sequence;
independent signal, local child and filesystem sources are also rescanned within 10 ms until
all publishers guarantee the same wake address. The wait hook receives the sequence observed
before scanning, preserving publications that race the scan. Terminal adapters must expose
`tryRead`/`tryWrite` for directions that are safe to call without blocking; the ABI never calls
a preview1 blocking stdin callback accidentally.

## Shared filesystem service

One filesystem worker runs `installFilesystemWorker(self, backendFactory)` and owns the tree.
The browser entrypoint selects `PersistentBackend` with `IndexedDBStorage` by default; standalone
workers may still use the default `MemoryBackend`. The page, editor and every guest share that
tree; completed writes are visible before exit.

### Persistence and durability

`StorageBackend` separates index loading, immutable payload reads, batched commits and flushing
from guest transport. `PersistentBackend.open(storage)` loads only the index. Payloads enter the
shared pool on first read or modification; clean idle files can leave it again. The workspace
may therefore exceed the 1 GiB resident pool, subject to browser storage quota. Dirty data cannot
be evicted before its checkpoint commits. Files may span segments and are limited by the configured shared pool.

Ordinary writes acknowledge shared-memory completion, not durability. Background checkpoints
collect changed shared slots (including direct guest writes) and changed inode metadata. Each
checkpoint copies a coherent view under the shared locks, releases them, and commits in the
background. While a checkpoint is pending, timer-driven checkpoints coalesce later edits instead
of queuing more payload copies. Namespace link counts track renames and removals incrementally;
only deleting a subtree visits that subtree. A cold read leaves the service queue while waiting
for storage, then revalidates its capability and current path before execution, so it cannot hold
up unrelated memory reads or writes. `fd_sync`,
`fd_datasync`, `client.asyncCall("flush")` and the page's `fs.flush()` explicitly wait for storage.
`fs.drain()` is only a page-side ordering barrier. Editors mark a save successful and notify HMR
only after the durable flush resolves; errors leave the edit unsaved. Startup publishes a hidden
completion directory only after all examples or template files are written. An interrupted seed
is retried as a clean initialization; completed workspaces preserve edits and intentional deletions.
The sandbox's explicit reset restores its template and retries an interrupted reset on next startup.

IndexedDB commits use strict-durability atomic transactions. Immutable payloads and checksummed
metadata deltas commit beside the previous version, together with the active-generation marker.
Every 128 checkpoints, a new checksummed base index replaces the older of two snapshot slots.
Garbage collection retains payloads needed by both bases, their replayable deltas and still-open
detached files; these runtime-only payload pins do not resurrect deleted names. Recovery discards
abandoned journal successors before committing again, preventing an old broken branch from
reconnecting to a new save. It validates checksums and the inode graph; existing
but unrecoverable storage raises an error rather than silently creating an empty filesystem.

One Web Lock is held for the database connection's lifetime. A second tab using the same database
is refused with a filesystem-worker error, not made a competing writer or a stale read-only
copy. Closing the first tab releases its lock. `SharedFilesystem({ persistence: false })` selects
a disposable memory-only filesystem; `name` selects an isolated database for tests/workspaces.
The worker is not a power-loss-safe host filesystem beyond the browser's strict IndexedDB
transaction guarantee; closing a page without a completed flush may lose its uncommitted edits.

Ports schedule requests; each request owns a SharedArrayBuffer with a 32-byte completion header,
JSON operation/arguments and optional binary input. Results overwrite the data region. Large
results are read in 64 KiB pieces, not placed in a fixed-size process snapshot. A completion owns
its buffer until `release()`; buffers and revocation words are never recycled between guests.

```ts
const request = client.submit("read", [handle, 4096, 0]); // does not block
client.readiness(request.id); // { kind: 3, id, ready } for a future process poller
try {
  const bytes = await request.value();
} finally {
  request.release();
}
```

`ready`, `epoch`, `wait()`, `value()`, `cancel()` and `release()` are exposed on the completion.
The connection's shared `signal` changes on completion/cancellation so a future poller can
recheck readiness. No `runtime_proc` imports are implemented here. Read, stat and resolved-path
caches are bounded and validated by the shared mutation epoch. Retained open files read and
write shared pages directly when capacity is already allocated; neither operation needs a port
round trip. In-capacity appends select EOF and write atomically in the guest too; namespace edits and growth
remain service-owned. A direct read enters its connection's host section, checks revocation, then takes
the file's lock once and checks revocation again before copying straight into the guest's buffers;
writes and appends also hold the global mutation lock,
so the epoch stays odd until their bytes, size and timestamp are in place. Cached opens/closes use per-connection shared reference counts, while the
service alone owns backend pins. Preopens and open descriptions retain handles; transient path pins
are bounded and evicting them invalidates cached paths.

The service owns the page allocator and grows capacity geometrically in 64 KiB pages, across
16 MiB growable SharedArrayBuffer segments. Connections carry the zero-byte segment references
before execution; only the service grows their backing storage. A synchronous guest therefore
sees completed growth without returning to its event loop or receiving another port message.
`createFilesystemIdentity(undefined, maxBytes)` configures
the pool cap (1 GiB by default, rounded to whole segments); files can span segments up to the
shared address space. A full pool reports WASI ENOSPC, while a request beyond the addressable
maximum reports WASI EFBIG.
`resources()` reports allocated backing bytes, data-pool and metadata bytes (including private
capability tables), used/free bytes, the configured cap, and registered identities. Zero-byte
segment references do not count as allocated backing storage. Grown segments are retained
for page reuse until the filesystem is disposed.

Connections carry their own revocation word and every ancestor's word, plus a shared ancestry
wake signal. Blocking waits recheck revocation after a signal change; asynchronous values use
one `Atomics.waitAsync` watcher per active client alongside ordinary port notifications. Before
physically terminating a guest, its controller must `await waitForFilesystemQuiescence(identity)`,
then call `reapFilesystem(identity)` and sweep the service. Quiescence revokes synchronously and
waits for the connection's shared host-section count to reach zero. Every direct lock, capability
reference change and page write is admitted before checking revocation; a later entrant must abort
before touching storage. Looking only at current lock owners is not a safe replacement for this fence.
Each descendant has a separate count and must be quiesced separately, even after root revocation.

The count supports nested synchronous host operations, but no host section or filesystem lock may
span an `await` or a call into guest Wasm. The direct I/O hot path adds an admission increment and
revocation check before locking, then a decrement and notification when its last section exits;
it still uses the same file/global locks and shared-page copies. The service retains pins until
quiescence without blocking its event loop or requiring a guest message. `reapFilesystem` may also
be called after independently proven physical death to recover abandoned locks and settle an
existing quiescence waiter; a termination request or worker error alone is not that proof.
A filesystem-worker error revokes the root and wakes all descendants, so an absent completion
message cannot strand a guest or page startup.
When a blocked guest spawns a child, it creates only a `FilesystemIdentity`. The runnable page
uses `connectFilesystemIdentity` to create the MessageChannel and attach the service endpoint,
then transfers the client endpoint to the child. Creating a new channel in a blocked guest
would deadlock Firefox. `createFilesystemConnection`/`client.fork()` are for runnable controllers
and non-blocking setup, not that guest spawn path.

Every fd belongs to `wasi.descriptors`. A binding holds its own rights and optional preopen name;
it references an `OpenDescription` holding a file, directory, pipe or terminal resource. `dup`
shares file offset and append mode but copies rights. `inherit` retains before returning, so the
parent can close immediately. Close, replacement, `proc_exit` and table disposal drop references;
the final reference invokes the resource's release callback. A WASM `_start` that returns normally
keeps descriptors alive (Bun light continues on the host engine); the executor disposes them when
the run finishes or traps.

Pipe and terminal services implement `Stream`. I/O returns bytes or negative WASI errno; readiness
is level-triggered readable/writable/hang-up state. `poll_oneoff` rechecks blocked descriptors,
reports expired clocks alongside ready fds, and reports per-event capability/descriptor errors.
The synchronous host waits directly on a single shared stream notification, preserving the
sequence observed before scanning. Distinct notification sources use bounded rescans; signal
interrupts return EINTR without consuming the queued signal. Inject bound endpoints through
`stdio` to replace the default terminal descriptions. Generic process endpoints supply inherited
reference counts; Bun's existing child transport remains available through its slot adapter.

Imports are limited to implemented `wasi_snapshot_preview1` names and explicit `namespaces`.
An unknown namespace/name fails at linking, rather than receiving a fabricated ENOSYS stub.
Imported memories must be supplied as `WebAssembly.Memory` values in their declared namespace;
the host uses that memory even when the guest does not re-export it. Bun's socket slot adapter
configures `hostCallFd` and `hostCall` from `web/`; no Bun networking code is pulled into core.

Plain Node consumers that only need the JavaScript memory helper use
`waffle/core/memory-views`, without loading the TypeScript WASI adapter. The repository's
unbundled headless hosts import that JavaScript source relatively, so native CLI tests do not require
installing playground dependencies.

Run `bun install`, `bun run prepare`, `bun test`, and `bun run check` in this directory.
The package is intentionally `private` and is consumed through an exact trusted Git commit while
its public API is still settling; `prepare` generates ignored Node modules under `dist/` for hosts
that select the `node` export condition. Do not rely on an npm tarball or a sibling checkout.
The generic browser acceptance runner requires Playwright browsers and uses `STORAGE_SCRATCH_ROOT`
when supplied (otherwise the host temporary directory).
