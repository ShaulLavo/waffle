# Architecture and API notes

This page is the reference for the browser runtime's ownership, filesystem, process, pipe and
guest interfaces. For the mental model, read [How Waffle works](concepts.md). To build something,
start with [Getting started](getting-started.md).

## Package layers

The package exports the browser runtime at `waffle`, with separate `waffle/core`, `waffle/fs`,
`waffle/proc` and lightweight `waffle/proc/stub` entries. Network and terminal adapters live under
`waffle/browser/net/*` and `waffle/browser/runtime-terminals`; core imports none of them.
`waffle/programs` installs program packages on a runtime's filesystem, loaded on first exec.
For explicit preload, on-demand configuration, picks, and removal, see [Configure program loading](guides/configure-program-loading.md).
See [network ownership and transports](network.md) for the network contract.
The [package export map](../packages/waffle/package.json) lists the supported entry points.

## WASI adapter and filesystem contract

```ts
import { Wasi } from "waffle/core";

const wasi = new Wasi({
  args: ["program"],
  env: {},
  fs,
  preopens: { "/": "/" },
  stdout: (bytes) => output(bytes),
  stderr: (bytes) => errors(bytes),
  sleep,
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

The borrowed process service's `isIdleWorker(worker)` reports whether an already-observed worker
is still inert in that service's precreated pool. Membership ends before a worker is leased.
The query exposes no worker references or termination controls; process ownership and cleanup
checks apply after the worker receives its process request.

`reserveSpawn` synchronously snapshots argv/env/cwd and retains descriptor bindings (including
nonstandard fds); `start` asynchronously resolves the module and launches the worker. `spawn`
combines them without waiting. `FirstSpawnStub` from `./proc/stub` reserves before returning and
shares a single delayed activation promise. `ProcessIdentityAllocator` supplies monotonic ids in
shared memory so a blocked guest can reserve its pid before the page imports the service.
`wait` is nonblocking; `waitForExit` and `onChildExit` provide asynchronous completion.
Missing and non-runnable executables publish a typed `start-failed` outcome with
`ENOENT` or `EACCES`, separate from ordinary exits. Process outcomes preserve typed startup
failures; shell-facing status helpers may derive conventional 127 (missing) and 126 (not runnable)
values separately.

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

Each process has per-signal default, ignored or handled dispositions. Signal numbers are
Linux `1..31` and `34..64`; `32` and `33` are invalid. Stop signals `19..22` return
WASI ENOTSUP: no stopped state is implemented. `SIGCHLD`, `SIGCONT`, `SIGURG` and
`SIGWINCH` default to no action on a running process. Other accepted signals immediately
select a signaled outcome (`128 + signal`) and revoke descriptors when no handler is registered. Ignored signals do nothing; handled signals set their own pending bit
without revoking the guest, whose ordinary `exit` retains its code. Registration and removal are
synchronous, including restoring the default when the last listener is removed. Distinct pending
signals cannot overwrite one another; repeated instances of one signal may coalesce. Removing a
pending handler to default applies that default immediately; ignoring it clears the pending bit.
The shared interrupt word is a wake hint, not the authoritative queue. `observeSignal` adopts a
request already published by a guest without publishing it again. Worker requests with
`runtimeProcess` supply authoritative readiness automatically. Executors with their own
`interrupt`, `requestedSignal` or `signal` adapter must provide a nonconsuming
`interruptPending(): boolean` callback; bootstrap rejects a missing callback before setup.
The callback, not a stale wake hint, determines preview1 poll interruption.

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
killed buffers are never assigned to another process. After the first worker launch, the broker
precreates up to two unused workers across all worker URLs. A consumer that launches its own root
worker takes one from the same pool with `takeWorker(url)`. Each worker runs at most one process;
used workers follow the existing quiescence and termination path. The registry already caches
compiled modules per registration, and source registrations share a bounded content cache.
Paired Chromium command timings for worker precreation remain pending.

The generic service's registry, process table and supervisor are dynamically imported on first
spawn. Small identity, typed-outcome and signal-state leaves are available earlier for synchronous
root control; importing them must not pull in the service barrel. The bundle gate checks both this
boundary and the approximately 1 KiB compressed first-spawn stub. Bun's existing pipe/slot transport
is measured separately and remains available alongside the lazy generic process adapters.
Source-backed program registrations compile through Waffle's interrupt rewriter, which inserts
checkpoints for CPU-bound WebAssembly, including standard SIMD guests. Precompiled modules require `cooperative: true` from their
adapter instead. Handled signals dispatch during cooperative event-loop turns; unhandled default
actions select their outcomes immediately. See [the host ABI](host-abi.md) for executable-entry
and interrupt contracts.

The same bounded module-promise cache also reuses admitted byte output across pages through
an optional Cache Storage store. Keys bind the source hash, rewriter revision and admission
policy. A hit streams the stored response while verifying its body; a miss uses the normal
rewrite and compile path. Stored bytes contain no instance or runtime authority. This trusts
the app's cache writer, not hostile same-origin storage. It saves admission work, not proven
persistent machine code, and does not stream the original source download into the compiler.
Source, digest, admission, store and compile measures separate those costs without changing
source errors or the lazy compiler import.

The store trims writes to 32 entries, at most 48 MiB per entry and 192 MiB total. This realm
serializes writes and eviction; independent tabs may trim concurrently. These storage limits
are not a whole-process memory bound. Clearing admitted entries forces later pages to repeat
admission. Existing in-memory modules remain until their page closes. Between runs, clear
only Waffle's admitted-byte caches:

```ts
for (const name of await caches.keys()) {
  if (name.startsWith("waffle-admitted:")) await caches.delete(name);
}
```

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
  adapter: "bun:quickjs",
  module,
  cooperative: true,
});
```

Pass `{ exclusive: true }` as the third argument when a host must create a file without
clobbering an existing file or directory. The check and creation are one filesystem operation;
existing paths reject with Waffle's `EEXIST` filesystem error. The older boolean third argument
remains the append mode, and ordinary writes still replace existing files.

```ts
await runtime.filesystem.writeFile("/bin/bun", "registered executable\n", { exclusive: true });
```

This makes filesystem inspection, a shell's `$PATH` search and process admission agree on the
same path. The shell searches `$PATH`; Waffle's spawn does not. Spawn resolves its executable
relative to the request's snapshotted `cwd` and walks the actual filesystem tree before
canonicalizing the registration key, even for a cached module. A missing intermediate cannot
be canceled by a later `..`; a regular file used as a directory or given a trailing slash
produces `ENOTDIR` (shell status 126). Absolute page paths treat the parent of `/` as `/`,
without weakening the separate capability-relative WASI resolver. A missing file produces
`ENOENT` (shell status 127).
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

[Worker memory samples](worker-memory.md) describes actual allocation samples and their physical cleanup lifetime through `ProcessService.workerMemory()`.

1. `setup(context)` receives the request, filesystem client, signal state and helpers.
2. `namespaces(context)` returns extra `WebAssembly.Imports` namespaces for the linker.
   `runtime_proc` remains Waffle-owned; an extension cannot replace it here.
3. `beforeBindings({ wasi, ...context })` runs after default stdio and preopens are created,
   but before inherited descriptors are installed. Incoming targets are already reserved for
   preopen placement; the hook can release unused default stdio.
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

**Preopen discovery:** inherited descriptor numbers are reserved before constructing WASI.
Each preopen takes the lowest free descriptor starting at 3: root is normally fd 3, or fd 4
when fd 3 is inherited. Sparse high targets do not move root above them. Inherited bindings
keep their requested numbers. Unpatched wasi-libc stops discovery at the first non-preopen;
guests that inherit fd 3 must use [Waffle's patched libc scan](wasi-libc.md). Direct `Wasi`
callers pass incoming targets as `reservedFds` before installing them.

`spawnData()` runs for each actual spawn under filesystem transfer admission. It returns
structured-cloneable, guest-specific metadata; `filesystem` and `pipeRegistry` are reserved
and overwritten with the runtime's authoritative capabilities. Metadata is not implicitly
copied from the parent: allocate any per-process admission state afresh in this hook.
Pipes retain their bounded defaults: 64 KiB capacity, 16 writers and 16 readers.

`resolveTerminal(target: 0 | 1 | 2): Stream | undefined` maps inherited terminal provenance to a
process-local endpoint, including interactive input. Capture request metadata during `setup`
if the endpoint needs it. The terminal codec owns provenance: duplication, redirection and
later generations preserve the original target, not the destination fd number. Bindings
sharing a transferred reference also share one open description; the resolver stream's
`close` runs on that description's last release. Return `undefined` for a target to use its
default, just as when no resolver is provided: stdin remains EOF and output uses the checked
host callbacks. A stdin-only resolver can return `target === 0 ? attachment.resolve(0) : undefined`
to keep host output without routing it back through `WorkerSetupContext.post`. The same resolver
option is available directly on
`createRuntimeTerminalCodec` from `waffle/browser/runtime-terminals`.

Terminal-session endpoints for targets 0, 1 and 2 share the policy's input cursor and foreground
readiness. WASI descriptor rights determine whether each bound fd may read; the endpoint's
target number does not prohibit input. Output still uses the policy's target 1 or 2 destination,
and target 0 remains unwritable.

Terminal stop ordering and the trusted native-death hook are described in
[Terminal consumer lifetime](terminal-lifetime.md).

`createTerminalInput()` provides the generic foreground input transport. The page keeps the
returned producer and its `buffer`, and feeds bytes with `pushTerminalInput()`; the helper splits
large pastes into bounded `TerminalDisplay.input()` turns and returns an accepted prefix alongside
`AGAIN`, `CANCELED`, or `CLOSED` when a later chunk cannot be admitted. Callers retry only the
unaccepted tail; the helper never silently slices or drops a chunk. An executor attaches the buffer with `attachTerminalInput()` and supplies
`createTerminalInputPolicy()` to `attachTerminal()`. Raw turns deliver bytes as entered. Cooked
turns hold partial lines, normalize CR and CRLF to LF across attachments, and treat Ctrl-D or a
closed producer as EOF. A live empty read returns `AGAIN`, and cancellation returns `CANCELED`;
neither is mistaken for EOF. Foreground selection and process-specific stream resolution still
belong to the terminal session and codec, so background members cannot consume the selected job's
input.

`context.post("stdout" | "stderr", bytes)` writes through the **current** fd1 or fd2 after
Wasi creation, not a startup snapshot. File writes preserve append and shared offsets;
pipe and terminal writes use blocking stream I/O and return `true` only for a complete
write. A closed or directory fd returns `false`. Default terminal destinations still post
to the host directly, so aliases of those destinations do not follow unrelated redirects.
During `setup`, before Wasi exists, `post` uses the supplied stdio or host callback.

### Host terminal output

A terminal target that no resolver claims writes to the root's host destination. Workers that
`launchWorker` starts write it into a bounded buffer the page drains, so they behave like a
TTY: a blocking write waits for room, an immediate write returns the exact prefix it accepted
or `AGAIN`, and nothing is dropped or counted as written before it was accepted. A pending
signal ends a blocking write with its accepted prefix, or `EINTR` before any. Before the exit
becomes visible to a parent, the Worker waits until the page has delivered every byte, so a
shell prompt cannot overtake a child's last output.

The root chooses its destination when it calls `adoptRuntimeRoot`:

```ts
await service.adoptRuntimeRoot(root, {
  // Accept a prefix of `data` and return its length, from 0 to data.length.
  tryOutput: (fd, data) => terminal.tryWrite(fd, data),
});
// After the display reads from a full terminal:
service.outputDrained(root.pid);
```

A short count keeps the rest buffered and holds the writer until `outputDrained(rootPid)`.
`output(fd, data)` remains for destinations that take every byte. The two are exclusive. A
call to `outputDrained` from inside `tryOutput` joins the delivery already running; the count
that `tryOutput` returns decides it, so it cannot loop.

Accepted bytes belong to the root's terminal, not to the process that wrote them. All writers
under one root share one 64 KiB budget, headers included. A writer stores bytes only with
credit the page granted it, and asks for more when it runs out; idle writers give unused
credit back. When a Worker stops, by exit, kill, revocation or disposal, its unused credit
returns, and the bytes it was told it wrote move from its shared buffer into page memory of
exactly their size. They are still delivered, in order, and still count against the root's
budget, so later writers wait for credit instead of taking new storage. Memory per root is
therefore one budget of accepted output, plus one 64 KiB buffer per live Worker. Accepted
bytes are discarded only when the root itself retires undelivered; that is reported through
the broker's `onError`.

A Worker started outside `launchWorker` has no such buffer: its host terminal output is posted
as `stdout` and `stderr` messages, and that host takes every byte.

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
producer cannot publish past that frozen watermark. Each ring also counts synchronous mutations
in a finite slot incarnation. Reuse advances that incarnation only at zero active sections;
stale endpoint writes, closes and pid revocation cannot change its replacement. A Worker
terminated inside a section leaves the slot quarantined rather than permitting unsafe reuse.
Raw buffers remain private runtime authority, not a guest corruption sandbox.

The default pipe retains one fixed 2,622,760-byte buffer and admits 16 simultaneous writing
processes and 16 reading processes. Closed writer rings can append new owners after unread
committed records, preserving tickets, record pins and cursor counters. Reader rings must be
fully drained or recovered by the relay before reuse. Reclaiming a direct reader switches to
relay mode before publishing its replacement. Fresh slots are preferred. Each slot permits
8,388,607 reuses without wrapping; active, quarantined or incarnation-exhausted slots consume
capacity. Saturation returns ENFILE (41), independently of payload backpressure (EAGAIN).

Without a publication registry, reclaimed slots do not retain historical revoked-pid tombstones:
a direct host retain of that old pid can create a new endpoint. Production enrolls unique child
pids in the registry, which permanently refuses collected identities. Retained old endpoints
still fail their incarnation check.

Registry cells are append-only, 16 bytes each, in a growable shared buffer. A simple same-process
pipe uses four cells, or 64 bytes of lifetime metadata after its pipe buffers are released.
Defaults allocate 2,105,360 bytes initially and allow 1,048,576 cells, or 16,785,424 bytes
including owner metadata. An explicit maximum can admit up to 16,777,216 cells. The optional
host allocator receives both exact sizes before construction so page owners can account for
the declared backing. A fresh direct writer uses a publication cell and a reader-lease cell;
each reused writer needs only one new publication cell. Each fresh or reused reader needs two
cells. A root-held default pipe with 3,001 sequential child writers uses 3,020 cells, or 48,320
bytes of cell storage, without growing its initial registry backing. The root's four cells and
15 fresh writer leases are included. Cells remain shared with all other service uses.
`PipeOptions.allocateShared(length)` supplies a realm-local allocator for fixed pipe backing,
a locally created wake, endpoint lifetimes and new description flags. Attached handles reuse
existing backing without charging it again; their later endpoint controls use the receiving
realm's allocator. `attachPipeEndpoint` and `attachPipeController` accept that allocator in
private options, as do worker host, broker and codec construction. No function crosses the
cloneable wire handle. Inherited descriptions share flags and allocate only a new lifetime.
The hook provides accounting, not a nominal allowance, refund policy or lifetime ledger.

The separate process directory supports 1,024 simultaneously enrolled processes; collected
process rows can be reused. Exhausting either bound returns WASI ENFILE (41). `cellsPerProcess` is an initial-size hint, not a lifetime cap.

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

Every guest ABI call is nonblocking except `poll` and blocking `wait_job`. See
[the host ABI reference](host-abi.md) for the full contract and startup-result error table. Descriptor I/O returns a byte count, zero for EOF or
zero-length I/O, or a negative WASI errno; a partial write is permitted. EAGAIN is -6 and EPIPE
is -64. Spawn reserves inherited capabilities before returning the child PID.

| Import                                                      | Contract                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawn(ptr, len)`                                           | UTF-8 JSON `{ executable, argv, env, cwd, job, fds: [{ child, parent }] }`; job 0 creates a foreground job, -1 creates a background job, and a positive value joins an existing job. Returns PID or negative errno.                                    |
| `access_start(path_ptr, path_len, cwd_ptr, cwd_len, mode)`  | Copies a UTF-8 executable name and absolute cwd synchronously. `mode` must be X_OK (`1`). Returns a positive process-owned request ID, or a negative errno; it never loads a module or allocates descriptors.                                          |
| `access_take(request)`                                      | Returns `-EAGAIN` (`-6`) while the query is pending, then consumes it and returns `0` when the live registered file is runnable, or `-ENOENT` (`-44`), `-EACCES` (`-2`), or `-ENOTDIR` (`-54`). A consumed or unknown request returns `-EBADF` (`-8`). |
| `access_cancel(request)`                                    | Retires the request and discards any late filesystem/registry completion. Returns `0`, or `-EBADF` for an already retired request.                                                                                                                     |
| `pipe(out)`                                                 | Writes two little-endian u32 fds, reader then writer; returns 0.                                                                                                                                                                                       |
| `dup(fd)`                                                   | Returns a new fd sharing the open description and offset. Use preview1 `fd_close` to close either binding.                                                                                                                                             |
| `read(fd, ptr, len)`, `write(fd, ptr, len)`                 | Use the same fd namespace as preview1. Filesystem cold reads/growth prepare asynchronously and return EAGAIN without consuming bytes or advancing the shared offset.                                                                                   |
| `start_status(pid)`                                         | Returns 0 once executable entry is committed, `-EAGAIN` while startup is pending, a positive WASI startup errno on failure, or `-ECANCELED` if cancellation prevented entry. Does not consume the child.                                               |
| `wait(pid, out)`                                            | Returns 0 and writes u32 kind (0 exited, 1 signaled, 2 start-failed), then i32 exit code, signal number or positive WASI startup errno respectively; returns `-EAGAIN` before confirmed cleanup.                                                       |
| `wait_job(job, flags, out)`                                 | Writes the same eight-byte typed result as `wait`; flags 0 blocks until completion, flags 1 returns `-EAGAIN` while pending.                                                                                                                           |
| `kill(pid, sig)`, `kill_job(job, sig)`                      | Return 0 or negative errno. PID targets require self/ancestor authority; a job requires its exact owner.                                                                                                                                               |
| `job_of(pid)`                                               | Returns the job ID or negative errno. PID 0 selects the caller. Ordinary Bun children explicitly join `job_of(0)`; detached children create a new job with selector 0.                                                                                 |
| `poll(subs, count, timeout_ms, out)`                        | Returns event count; 0 on timeout or a pending signal. Timeout -1 has no deadline.                                                                                                                                                                     |
| `interrupted()`, `signal(sig, mode)`, `default_signal(sig)` | Share the signal queue and dispositions. Errors use negative WASI errno: EINVAL -28, ENOTSUP -58, unavailable adapter ENOSYS -52. Terminating defaults unwind with `ProcessSignalExit`; ignored defaults return 0.                                     |

Poll subscriptions are 16 bytes: u32 kind, u32 id, u64 userdata. Output events are 16 bytes:
u64 userdata, u32 kind, u32 flags. All fields are little-endian. Kinds are readable fd (0),
writable fd (1), child exit (2), filesystem completion (3), job completion (4), and executable
query completion (5), and child startup (6); flag bit 0 means hangup. Executable query requests are bounded to 64 live
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

See [storage ownership and lifecycle](storage.md) for `whenBusy`, waiting, takeover and disposal.

`StorageBackend` separates index loading, immutable payload reads, batched commits and flushing
from guest transport. `PersistentBackend.open(storage)` loads only the index. Payloads enter the
shared pool on first read or modification; clean idle files can leave it again. The workspace
may therefore exceed the 1.5 GiB resident pool, subject to browser storage quota. Dirty data cannot
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

`SharedFilesystem({ mode: "memory" })` selects a disposable memory-only filesystem;
`name` selects an isolated database for tests/workspaces. Closing a page without a completed
flush may lose its uncommitted edits; browser persistence is not a power-loss-safe host filesystem.

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
the pool cap (1.5 GiB by default, rounded to whole segments); files can span segments up to the
independent 1 GiB per-file ceiling. A full pool reports WASI ENOSPC, while a request beyond the addressable
maximum reports WASI EFBIG.
The 1.5 GiB ceiling leaves 512 MiB of headroom for sequential package installs beyond a
retained 1 GiB tree. Smaller explicit caps still apply. It is a payload reservation limit,
not an aggregate browser or process memory budget. The fixed allocator layout occupies
59.45 MiB including its first 16 MiB data segment. Ordinary connections retain their
64 MiB root allocation. Startup-admitted standalone roots charge the exact layout,
65,664 bytes more than the former 1 GiB aggregate layout. Additional payload backing grows
lazily in 16 MiB steps. Browser allocation failure can still return ENOSPC below the
configured cap, and grown backing remains allocated until disposal.
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
The filesystem owner takes file and global locks with a waiting acquisition. Another owner's
section is synchronous and short, and while it waits the owner sweeps connections and reclaims
the locks of proven-dead owners. A blocking request never fails with EAGAIN because another owner
holds a shared lock; one cancelled or revoked during the wait ends cancelled. Only nonblocking
guest paths (`try*` I/O and readiness probes) report that contention as EAGAIN.
When a blocked guest spawns a child, it creates only a `FilesystemIdentity`. The runnable page
uses `connectFilesystemIdentity` to create the MessageChannel and attach the service endpoint,
then transfers the client endpoint to the child. Creating a new channel in a blocked guest
would deadlock Firefox. `createFilesystemConnection`/`client.fork()` are for runnable controllers
and non-blocking setup, not that guest spawn path. A low-level `FilesystemClient` also needs the
trusted `FilesystemClientOptions.connect` capability before `fork()` can allocate an identity or
channel; without it, `fork()` fails with `ENOTSUP`. Ordinary `SharedFilesystem.fork()` supplies
that connector through the dedicated filesystem Worker and is unchanged.

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

Imports are limited to implemented `wasi_snapshot_preview1` names, the built-in
`runtime_fs.path_permissions_get` query, and explicit `namespaces`.
An unknown namespace/name fails at linking, rather than receiving a fabricated ENOSYS stub.
Imported memories must be supplied as `WebAssembly.Memory` values in their declared namespace;
the host uses that memory even when the guest does not re-export it. Bun's socket slot adapter
configures `hostCallFd` and `hostCall` in the consumer; no Bun networking code is pulled into core.

Plain Node consumers that only need the JavaScript memory helper use
`waffle/core/memory-views`, without loading the TypeScript WASI adapter. The repository's
unbundled headless hosts import that JavaScript source relatively, so native CLI tests do not require
installing playground dependencies.

## Lazy network implementation

`runtime.network()` owns one separate Rust WASM instance through its namespace. Core and process loading do not load this module. Browser helpers retain virtual-only transport and unchanged rings. Native embedders wire the Waffle-owned OS adapter explicitly. See [ADR 005](adr/005-lazy-rust-wasm-network.md).
