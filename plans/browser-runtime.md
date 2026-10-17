# Browser runtime

Status: Approved (owner, 2026-10-16)

## Goal

One reusable runtime for running WASM-compiled native programs in the browser. It grows out of
bun-wasm's browser host (`web/src`) and serves bun.wasm, the shell and later programs. It
provides processes, streaming pipes, a live shared persistent filesystem, networking and, later,
threads.

It is layered and pay-for-what-you-use. Bun light (`bun-browser.wasm`, user code on the host's JS
engine) loads only core, filesystem and networking, and must not get heavier or slower to start
than it is today. The process layer loads on the first spawn.

## Decisions

- **The shell is our own** (shell track, `/work/reports/browser-shell-research/handoff-shell.md`):
  a single-threaded async core on Bashkit's parser and interpreter semantics. Brush in brush-web
  is today's working baseline and the reference for what a shell needs from the runtime; it is
  not the long-term guest. The shell's next gate, real worker-backed spawn, shared interrupt,
  inherited descriptors and a background job, runs on this runtime's process layer.
- **Pipes serve two kinds of reader.** Preview1 programs block in `fd_read`; the async shell and
  Bun's event loop use non-blocking reads and a readiness wait (`poll`). The same pipe endpoint
  supports both.
- **No WASIX.** Programs speak WASI preview1 plus our own extensions: bun-wasm's `bun_wasm` host
  slots (`docs/host-abi.md`) and brush-web's process imports. The services underneath know nothing
  about any guest ABI, so another contract can be added later as an adapter without touching them.
- **No Unix fork.** Bun, the shell and Node's `child_process` all spawn. Node's `child_process.fork()`
  and Bun's `spawn({ ipc })` are spawn plus a message channel, and we support them that way: the
  channel is a pair of pipes bound to a child descriptor, carrying newline-delimited JSON as Node
  does with `NODE_CHANNEL_FD`. A guest blocked inside synchronous WASM can't receive MessagePort
  events, but it can always `poll` a descriptor. A
  program that needs Unix fork (real bash, for example) is out of scope until a specific one
  matters.
- **One worker per process.** A supervisor stays responsive while guests block, so spawn, kill
  and Ctrl+C always work, including against CPU-bound guests (`Worker.terminate()`).
- **One filesystem service**, owned by one worker and reached from guest workers through shared
  memory. Requests are submitted without blocking and complete through a readiness handle; the
  preview1 adapter blocks on the completion, while the async shell polls it, so a cold read never
  stalls its other tasks. Writes are visible to every process when they complete. The editor saves
  through an operation that resolves only after the data and metadata are persisted, and reports
  failures. This replaces today's copy-at-spawn and merge-at-exit in both bun-wasm and brush-web.
- **Storage backends are swappable.** The filesystem service talks to storage through a small
  backend interface (load the tree, read data that isn't in memory, persist a batch, flush). We
  ship two from day one: IndexedDB, the default (fastest writes on Chromium and Safari, consistent
  reads), and OPFS. The OPFS backend is simple: one OPFS file per immutable file revision, no
  per-file flush in background checkpoints, create concurrency tuned per browser, and lazy loading
  (the spike's index loads in about 20 ms; files are read
  on first use, since reading every file takes 16-33 s in Firefox). A packed OPFS backend, 15x
  faster to write in Firefox, can come later (spike 3). Memory-only throwaway sandboxes already
  use `persistence: false`. A later backend can use IndexedDB without our own memory cache
  (lower memory, the browser caches for us; owner, 2026-10-16). Explicit `fsync(fd)` and the editor's persisted save
  flush that file's payload and the snapshot naming it before resolving; they do not promise
  durability for unrelated unsynced payloads. IndexedDB requests strict atomic transaction
  durability, while OPFS background checkpoints remain close-only with a flushed naming snapshot.
- **Killing is not instant, so kills interrupt, revoke and confirm.** Chromium waits 2 s before
  forcibly stopping a busy worker after `terminate()` (`kForcibleTerminationDelay` in Blink's
  `worker_thread.cc`; spike 2 saw CPU-bound WASM and JS keep running and writing shared memory).
  Safari and WebKit didn't stop WASM loops that make no host calls: in real Safari 26.4 all three
  such loops were still running after 5 s in 15 of 15 trials, while loops that call the host
  stopped at once. So a shared interrupt word that guests check is the required stop, not an
  optimization. Our own programs check it at their checkpoints, including inside the JS engines
  (QuickJS's interrupt handler, a JSC trap hook); third-party WASM gets checks injected at loop
  headers and function entries (covering tail-call cycles) when loaded, or is refused.
  `terminate()` stays as the backstop. Each process has a per-signal disposition: default,
  ignored or handled. When the guest retains the default disposition, the supervisor applies
  SIGINT, SIGTERM or SIGPIPE's default action immediately, recording `128 + sig` and revoking;
  it does not wait for an engine checkpoint. Only handled signals are queued for guest delivery,
  and that guest keeps its own exit code. Removing the last handler restores the runtime's
  default action, including SIGPIPE. Node/Bun JS guests initially ignore SIGPIPE until its first
  handler is installed; unrelated listener removal preserves that initial disposition.
  SIGKILL is always immediate and cannot be caught or ignored. Revocation
  wakes blocked peers at once (EOF in about 0.06 ms, EPIPE in about 0.3 ms), so pipelines never
  wait on a dying worker. There is no automatic escalation timer.
- **A killed process can't corrupt shared state.** Shared memory can't be taken back from a
  running worker, and a worker can be killed between checking a flag and publishing a write. So
  no ring is ever written by two processes: each (writing process, pipe) pair gets its own
  single-producer ring, and the reader takes from all of a pipe's rings. Each writer's canonical
  publication cursor lives in a host-only shared process directory: one atomic word holds both
  its committed position and its revoked bit. Authorized host code (the target's parent chain
  or job owner) freezes every cursor before exposing child exit; guest WASM cannot access this
  control memory. A writer publishes only by compare-and-swap on that same word, so publication
  racing revocation either commits before it or fails. Registry cells are append-only in a growable
  shared buffer. Revocation marks the process before walking its immutable linked cursor list;
  allocation initializes and links its cell, then rechecks revocation before admitting the endpoint.
  A cell missed by the killer's snapshot therefore freezes itself and cannot publish. No cell is
  recycled: stale publisher, reader or killer references can never acquire a new occupant. The reader
  drains every byte through the frozen watermark, then treats the ring as closed. Anything a zombie tries to publish afterwards is
  never read, and since a writer only fills free space, it can't overwrite unread bytes. This
  makes guest-initiated kill safe without waiting for a supervisor message round trip. Per-write
  records also preserve causal order between writers: a completed write precedes any write
  that begins later. Writes up to 4 KiB stay contiguous across short reads (a deliberately tiny
  test pipe uses its smaller capacity as that bound); larger concurrent writes may interleave.
  Record metadata is bounded and participates in publication and backpressure, not a separate
  unbounded log. A pipe with more than one reading process (rare, such as two children inheriting
  one stdin) switches to relay mode through the supervisor, which checks revocation on every
  chunk. Polling and an idle inherited reader cannot reserve bytes; unread deliveries remain
  reclaimable when a reader stops retrying, closes or dies. Relay work is bounded and yields to
  supervisor message tasks so continuous traffic cannot starve kill or exit. A killed process's
  buffers are never handed to another process; new processes get fresh ones. The default registry
  grows from about 2 MiB to at most 16,777,216 cells (256 MiB plus its header), enough for about
  4,194,304 simple same-process pipes at four 16-byte cells per pipe; extra inherited endpoints
  use more cells. The append-only lifetime bound is service-wide, not a fixed per-process cursor quota.
  The separate process directory keeps 1,024 permanent PID rows. Exhausting either bound reports
  WASI ENFILE (41). Cell recycling is not needed for this target and must never reset a cursor
  that a stale publisher, reader or killer could still reference. A guest that stops cooperatively acknowledges
  its exit; for an uncooperative kill the browser gives no teardown signal, so revocation, not
  silence, is the correctness boundary.
- **Pipes run directly between workers** over shared memory, not through the supervisor, except in
  relay mode above.
- **Not adopted:** `@wasmer/sdk`, a fork of `@bjorn3/browser_wasi_shim`, SLICC code.

## Layers

| Layer | Contents | Loaded by |
|---|---|---|
| core | WASI preview1 host, descriptor table, memory views, clocks, random | everything |
| fs | Filesystem service (memory first, IndexedDB or OPFS backend) and its client | everything that touches files |
| net | Fetch bridge, virtual TCP namespace shared across processes, preview ingress | programs that use the network |
| proc | Supervisor, worker pool, process table, pipes, IPC channel, kill and job control | first spawn |
| threads | `wasi-threads` adapter (later) | threaded programs |
| adapters | Bun slots, shell process imports, terminal (raw/cooked, resize, EOF) | the program that needs them |

Bun-specific code stays in bun-wasm: `engine-host.js`, module serving in the service worker,
the install cache, `runner.ts`.

## Steps

### 0. Spikes (done, 2026-10-16)

Reports in `/work/reports/browser-runtime/spikes/`: `1-size-startup.md`, `2-processes-pipes.md`,
`3-opfs-fs.md`, `4-wasi-host-shell.md`. What they settled:

- **Size and startup.** Runtime JS for bun light is about 30-37 KiB gzipped and adds 10-30 ms at
  startup; the 3.85 MB WASM and the demo UI (89% of the JS) dominate. Proc is imported and
  constructed on every run today. Per-layer budgets: core 7 KiB, fs 6 KiB, net 14 KiB, proc
  8 KiB gzipped, zero proc bytes before the first spawn. Step 4b measures core at 6,327 B
  gzip, up from 5,987 B after descriptor ownership (+340 B): shared fd bounds, preview1
  readiness notifications and immediate terminal capabilities belong in core, not the lazy
  process service. Its round guide/gate is now 7 KiB; the process-service lazy boundary remains
  enforced. A bounded vectored-I/O factoring trial reduced minified bytes but increased gzip
  (6,353 B), so it was reverted rather than complicating the host to meet the old 6 KiB guide.
- **Processes and pipes.** Sharing one compiled module cuts bun.wasm spawn from 57-76 ms to
  23-32 ms. A 1-2 worker idle pool saves 4-8 ms per spawn in Chromium and Firefox at 2-3 MiB per
  worker, but regressed WebKit's single spawn (51 ms against 28 ms), so pooling is optional and
  enabled per browser on measurement. A finished bun instance costs 7-27 MiB, so none are kept.
  bun-wasm's existing `SharedPipe` is as fast as a new ring (3-9 GB/s) and lean on memory, but it
  is single-producer, single-consumer with one close flag; the per-writer ring design above
  builds on it. Termination findings are in the decisions above.
- **Filesystem.** Per-file flushing, not files, made OPFS slow. IndexedDB batched writes and
  packed OPFS work everywhere; simple per-file OPFS works with parallel writes and no per-file
  flush but is slow in Firefox. Safari allows 253 open sync handles. Two backends from day one.
- **WASI host.** bun-wasm's host beats brush-web's by 2-9x per call and 4.5-10% on whole
  programs. It has nine correctness bugs to fix first (list in the spike 4 report).

### Process layer requirements from the shell

The own shell (brush-web `plans/004-own-shell.md`, `/work/reports/browser-shell-research/own-shell-spike.md`
sections 7 and 8) maps its `ProcessHost` trait onto this layer. The process layer provides:

- spawn with argv, env, cwd and arbitrary descriptor bindings (fd 3 and up, not only stdio);
- several concurrent children per parent;
- non-blocking reads and writes with readiness and child-exit notification, so a single-threaded
  async guest parks only when nothing is runnable;
- bounded pipes: EOF after the last writer closes, EPIPE after the last reader closes, partial
  writes, zero-length reads and writes;
- a shared interrupt word the guest can see while its WASM runs;
- Ctrl+C kills the foreground job and its descendants with confirmed exit, while unrelated
  background children keep running;
- a generic executable registry;
- broken pipe status: a child killed by SIGPIPE reports 141; a guest that handles EPIPE keeps its
  own status.

## Build plan

### Where it lives

The generic implementation currently lives in bun-wasm's `runtime/` package while the
[approved Waffle split](waffle-split.md) is prepared. After the split it lives in the public
MIT-licensed `ShaulLavo/waffle` repository, package `waffle`, with curated layer and browser
entry points so a bundler includes only what a page imports. Generic filesystem, process,
interruption, worker/bootstrap, network and preview services, tests and follow-on plan steps
move there. Bun's guest engines, executor, native-slot/legacy-pipe adapters and application
policy remain in `web/` here. The application creates one page-owned runtime and explicitly
passes it to Bun and `createShell({ runtime })`; runs borrow its filesystem, identities and
lazy process service. `proc` loads on the first spawn. A guest's `spawn` import can't await an `import()`, so the
guest worker keeps a stub of about 1 KiB gzipped, including identity and atomic terminal-result
primitives: it reserves a pid, takes the inherited descriptor references and returns at once,
and the supervisor loads proc and starts the process
asynchronously. A start failure shows up through `wait` (127 for a missing program, 126 for one
that can't run) and as a child-exit event in `poll`. A synchronous caller such as Bun's
`spawnSync` polls afterwards; the shell never blocks on a first spawn. The builds (`web/build.ts`,
`sandbox/build.ts`) enable code splitting and serve the split chunks under every worker scope.
bun-wasm consumes an explicitly trusted Waffle Git dependency pinned to an exact commit;
bash-web declares a Waffle peer dependency and uses an exact development pin for its own
tests. Follow the split plan's ownership, installed-package and cross-repository gates before
removing the in-tree package. Every new file that adapts upstream code gets its classified row
in the owning repository's provenance ledger, including applicable notices.

### Process ABI (for the shell lane)

The service is a TypeScript interface; guests reach it through a WASM import module named
`runtime_proc`. Bun keeps its slots, adapted onto the same service.

**Descriptors are one namespace.** Every WASI fd is a runtime descriptor; `runtime_proc` calls
take and return ordinary fd numbers, so a file opened with `path_open`, a pipe, a terminal and an
inherited descriptor are all the same thing. Descriptors point at open file descriptions with
reference counts and, for files, a shared offset, as in POSIX. `spawn` takes its references
before it returns, so the parent may close its copy immediately. A child's `fd_close`,
`fd_renumber`, exit or kill releases its references. EOF reaches readers after the last writer
reference closes; EPIPE reaches writers after the last reader reference closes.

Calls return 0 or a non-negative result on success and a negative error on failure (WASI errno
for descriptor operations; `signal` uses the Bun slot's -22 invalid-argument result). All are
non-blocking except `poll` and `wait_job` without NOHANG.

| Import | Signature | Meaning |
|---|---|---|
| `spawn` | `(desc_ptr, desc_len) -> pid` | `desc` is UTF-8 JSON: `executable`, `argv`, `env`, `cwd`, `job` (`0` for a new foreground job, `-1` for a new background job, or an existing job id), and `fds`: `[{child, parent}]` binding child fd numbers (0, 1, 2 and any higher) to parent fds. Returns the pid at once; the process starts asynchronously, and a start failure is reported through `wait`. |
| `job_of` | `(pid) -> job` | The job id a process belongs to. Job ids and pids are separate number spaces. |
| `pipe` | `(out_ptr) -> 0` | Writes two `u32` fds: read end, then write end. |
| `dup` | `(fd) -> fd` | A new descriptor for the same open description. |
| `read` | `(fd, buf, len) -> n` | `n > 0` bytes, `0` at EOF or when `len == 0`, `-EAGAIN` when empty. |
| `write` | `(fd, buf, len) -> n` | Bytes accepted (partial writes allowed), `-EAGAIN` when full, `-EPIPE` when no reader remains. |
| `wait` | `(pid, out_ptr) -> 0` | `-EAGAIN` while running; otherwise writes `u32 kind` (0 exited, 1 signaled) and `i32 code` (exit code or signal number). |
| `wait_job` | `(job, flags, status_ptr) -> errno` | Flag 1 (NOHANG) returns -6 while any member is unsafe; flag 0 blocks. Success writes one little-endian i32 leader status (exit code or 128 + signal) and reaps the whole job. Unknown job -71, reaped job -12, outside owner ancestry -63. |
| `kill` | `(pid, sig) -> 0` | Signals one process. |
| `kill_job` | `(job, sig) -> 0` | Signals every process in a job, including descendants spawned into it. |
| `poll` | `(subs_ptr, n, timeout_ms, out_ptr) -> n_ready` | Each subscription is 16 bytes: `u32 kind` (0 readable, 1 writable, 2 child exit, 3 filesystem completion, 4 job-empty), `u32 id` (fd, pid, request or job), `u64 userdata`. Each event written is 16 bytes: `u64 userdata`, `u32 kind`, `u32 flags` (bit 0 hang-up). Also returns when this process's interrupt word is set (`n_ready` may be 0). Blocks unless timeout is zero. |
| `signal` | `(sig, mode) -> result` | Synchronously sets this process's disposition: 0 default, 1 ignored, 2 handled; mode 3 raises a signal against the current disposition. `(0, 0)` dequeues the next pending handled signal (0 if none), sharing the queue with `interrupted`; `(0, 4)` polls fatal cancellation without consuming handled pending signals. Set/raise/poll returns 0, invalid arguments -22. SIGKILL cannot be registered or ignored. Bun reaches the same adapter through optional host slot 18. |

| `interrupted` | `() -> sig` | Dequeues one pending handled signal for this process (0 if none); the guest dispatches its handler at a checkpoint. Unhandled default actions have already been selected by the supervisor. Don't rely on the host call itself to make `terminate()` work: in real Safari, `terminate()` alone stopped only 13 of 50 runs with tiny injected host checks, while stopping on the returned signal worked 50 of 50 (spike 5). |
| `default_signal` | `(sig) -> never` | Takes the default action for the signal returned by a checkpoint. The adapter reports it explicitly before unwinding; the supervisor records `128 + sig`, revokes descriptors and requests physical termination. An unrelated later trap is not inferred to be a signal exit. |

Job completion preserves the leader outcome across individual reaping and later descendant
signal deaths. Member job IDs cannot move; spawns selecting separate jobs are independent.
Kind 4 is non-consuming level readiness until successful `wait_job`; repeated waits and polls
after reaping return ECHILD. Completion counts accepted reservations before host admission and
requires every member's revocation, descriptor release and filesystem/adapter quiescence, not
merely an outcome word or `Worker.terminate()`. Individual process confirmation and root
`run.done` likewise follow their own quiesce hook, never physical worker termination. Legacy
`SubprocessHost.wait` remains on the old transport until step 7b replaces it with the process
directory. A safely completed job cannot be reopened. The shared
wake is registered before capturing its sequence and scanning, preventing lost completion races.
Invalid flags return EINVAL; bad status memory does not consume the job; pending handled signals
interrupt blocking wait with EINTR without consuming delivery. See `docs/host-abi.md` for layout.


Signals are `SIGINT`, `SIGTERM`, `SIGKILL` and `SIGPIPE`. Plain preview1 processes start with the
default per-signal disposition, rather than assuming every program handles a signal. The Node/Bun
JS runtime starts SIGPIPE ignored, matching Node and Bun; an explicit JS listener changes it to
handled and removing the final SIGPIPE listener restores default, matching native Node/Bun. For SIGINT, SIGTERM and SIGPIPE, `kill`
examines the current disposition synchronously: default selects signal death, records `128 + sig`
and revokes immediately; ignored does nothing; handled queues delivery without revoking the guest.
Node/Bun listener mutations publish registration and removal before user callbacks; preview1 guests
register through `runtime_proc.signal`. A handled guest's own exit code stands, including 0 or
ordinary 143. Removing a pending handler to default immediately applies that action, while
ignoring a signal clears its pending state. Standard signals may coalesce per signal, but distinct
pending signals must not overwrite one another. Dequeue clears pending before a once-listener
removes itself. The per-signal state is authoritative; the shared interrupt word only wakes
checkpoints.

Like Node, handled signals remain pending through synchronous JavaScript and dispatch on the
next ordinary event-loop turn. Engine polls use `(0, 4)` and never call JavaScript: arbitrary
reentry can invalidate native regexp state and runtime timer bookkeeping. An infinite JS loop
with a registered handler therefore stays busy until an unhandled/default signal or SIGKILL
stops it. Idle event-loop waits must wake promptly for handled delivery. Acceptance signals
through the page broker's `kill` and `killJob` on both legacy and runtime-process routes. A
long test-only wait must return native `ok` for the exact sampled wait generation, while
removing its notification fails the same check; a short timeout rescan is not wake evidence.


An explicit `runtime_proc.default_signal(sig)` still reports a typed default action. SIGKILL
always selects 137 and revokes immediately; it cannot be caught or ignored. Guest completion
and signal death compete for one immutable outcome, so a late worker message or prior request
cannot relabel an ordinary exit. Physical termination waits for host filesystem critical sections,
not guest WASM: a per-connection section count is published before the revocation check and lock
acquisition, and cleared on exit. After revoking, the supervisor waits asynchronously for zero,
then reaps filesystem locks and terminates. A guest entering after revocation must abort before
acquiring any lock. This proves quiescence without claiming `terminate()` proves death.
Default-action statuses are 130, 143, 137 and 141. A JS EPIPE error remains catchable through
normal stream callbacks/listeners or try/catch. An escaping EPIPE follows the ordinary uncaught-error
path and exits 1, even with a SIGPIPE listener; an EPIPE-handling guest keeps its own status. The
error policy never synthesizes SIGPIPE; physical signals are delivered separately. Plain preview1
guests retain the default SIGPIPE disposition and status 141 for signal delivery.

One Ctrl+C stops an ordinary foreground program with 130 without waiting for step 7a. A
registered SIGINT handler may clean up and keep its own status. Ctrl+C signals the foreground
job and waits; a second Ctrl+C or explicit kill may send SIGKILL. Listener registration and
signal polling do not keep an otherwise idle guest alive. The runtime has no escalation timers.

WASI preview1 programs use the same descriptors through ordinary fd calls: a spawned child's
`fd_read(0)` blocks on its bound pipe, and `poll_oneoff` reports pipe readiness. Third-party
programs get `interrupted` checks injected (step 9): every 256th loop iteration plus function
entries, costing 1.27-1.8x on a real `bun build` in spike 5. A check that sees a signal traps,
and the recorded signal sets the status.

### Steps

Line counts include tests. Each row is one PR with an independent review; nothing merges without
the CI gate.

| # | Step | Estimate |
|---|---|---:|
| 1 | **Fix the WASI host bugs in place**, stacked on PR #21: the nine from spike 4, each with a failing test first, reusing spike 4's fixtures. Add the CI gate (GitHub Actions running `web/tests` and an artifact-free headless browser smoke). | 600-900 |
| 2 | **Package skeleton and core.** Create `runtime/`; move `wasi.ts`, `memory-views.js` and path helpers; one descriptor namespace with file, directory, pipe and terminal kinds and reference-counted open descriptions, so the host no longer holds MemFS nodes; explicit import namespaces instead of ENOSYS stubs; `poll_oneoff` with per-descriptor readiness. Enable code splitting in `web/build.ts` and `sandbox/build.ts`, including chunks under the scoped worker. `web/` consumes it with no behaviour change. CI checks bundle sizes against the budgets and initial downloads. | 1,500-2,200 |
| 3a | **Filesystem worker and protocol.** In-memory tree owned by one worker; non-blocking submit and completion handles over shared memory; blocking preview1 adapter; open-file identity across rename and unlink. Memory-only backend. Replaces copy-at-spawn and merge-at-exit. | 1,500-2,200 |
| 3b | **Persistence.** Backend interface; IndexedDB backend (default); background batched persistence; `fsync`; checksummed metadata written beside the old copy then swapped; Web Locks for one writer tab; the editor's persisted save. Reload test immediately after a save resolves. | 1,200-1,800 |
| 3c | **OPFS backend.** One file per immutable revision, lazy loading, bounded total native handles under Safari's 253, per-browser create concurrency, and file-scoped durability. Explicit `storage: "opfs"`; IndexedDB stays default. [Implementation and measured corpus evidence](../runtime/README.md#opfs-corpus-measurements). | 600-1,000 |
| 4a | **Processes.** Supervisor, process table, generic registry (module plus guest adapter), shared compiled modules, first-spawn stub, spawn/wait/kill/kill_job, jobs, per-signal dispositions and registration, immutable outcomes and revocation. Unhandled signals apply their default action immediately; handled signals retain the guest's own exit. Optional per-browser pool. Tests: delayed first activation while another shell task runs; one Ctrl+C stops an unhandled program with 130; a SIGINT handler exits 0 and keeps 0; removing it restores default; handled EPIPE retains its status. | 1,200-1,800 |
| 4b | **Pipes.** Per-writer rings built from `SharedPipe`, reader merging, relay mode for multiple reading processes, reference counts, readiness, the `runtime_proc` imports. Tests: inherited concurrent writers, inherited readers, kill between a writer's check and publish, output queued before a kill still drained, a delayed publish after a kill never read, zero-length and partial I/O. | 1,000-1,500 |
| 4c | **Process gate for the shell.** The own-shell spike's section 8 gate on real workers: external producer and consumer with a builtin filter, bounded flow and early reader close across workers, interrupt while WASM runs, descendant kill with reaping, an inherited nonstandard fd closed by the parent right after spawn, a background job surviving one command and controlled by the next. Runs against a preview1 fixture until the shell lands. | 500-800 |
| 4d | **IPC.** Node `fork()` and Bun `spawn({ipc})` as a pipe pair on a child fd with newline-delimited JSON; guest send and receive on QuickJS and JSC as well as Bun light. | 400-700 |
| 5 | **Terminal.** Terminal descriptor kind with a foreground owner; cooked mode (echo, line editing, Ctrl+D) ported from brush-web; raw mode passes Ctrl+C through as a byte; resize events. | 600-1,000 |
| 6 | **Network.** One socket namespace shared by all processes (children get networking; loopback works across workers); fetch bridge; bounded connection writes; preview routing split from Bun's module-serving service worker, one registration; the preview client loads only when a preview opens. | 1,000-1,600 |
| 7a | **Engine interruption.** QuickJS's interrupt handler and a JSC trap hook poll fatal cancellation while CPU-bound JS runs, stopping revoked guests in Chromium, Firefox and real Safari. Handled signals stay in the authoritative host pending set until the next event-loop turn, matching Node; engine callbacks never enter JS. Check idle handled-signal wake latency as well as fatal busy-loop interruption. Immediate unhandled default actions already belong to 4a; they do not wait for these engine hooks. | 300-600 |
| 7b | **Bun onto the runtime.** Bun's slots as an adapter over the services; remove the Bun-only spawn restrictions (`spawn.js:49-65`, `subprocess.js:170-179`) and engine inheritance; playground migrated; demo UI out of the runtime import graph; WebKit engine-cache retention fixed. Bun light meets the budgets, measured on real downloads before and after the first spawn. | 1,000-1,500 |
| 8 | **The shell on the runtime.** Owned by the shell track: its `ProcessHost` maps onto the process ABI. This track supplies the ABI, the 4c gate and the milestone's Playwright acceptance tests (`/work/reports/browser-shell-research/pipelines.acceptance.spec.ts`). | shell track |
| 9 | **Interrupt injection for third-party WASM.** Spike first: rewrite a module at load time to call `interrupted` at loop headers and function entries, measuring rewrite time and overhead on a real program; refuse modules it can't instrument; then build it into the loader. | 800-1,500 |

Total for this track: about 13,000-19,000 lines across fifteen PRs, plus the shell track's own
work. Order: 1, then 2 and 3a in parallel; 3b after 3a, 3c after 3b; 4a after 2; 4b after 4a;
4c and 4d after 4b; 5, 6 and 7b after 4b; 7a any time after 1; 9 any time after 2. The shell
track can start its `ProcessHost` against the ABI as soon as 4b lands.

### Before merging runtime PRs

Pause the compatibility wave while the runtime PRs land in order, then resume it (owner,
2026-10-16).

## First milestone acceptance

1. The shell and bun.wasm use the same runtime package, filesystem service and process manager.
2. Executable selection is generic: the shell, bun.wasm and a small preview1 fixture are registered
   programs; the process service has no Bun-only assumption.
3. Pipelines run concurrently: a ticker piped into a filter shows lines before the producer exits;
   a stream larger than 1 MiB completes with bounded memory.
4. Pipe semantics are correct: zero-length reads and writes, partial writes, binary data, EOF after
   duplicated writers close, reader closure, cancellation, simultaneous stdin and stdout.
5. Files are live across processes: one process sees another's completed write before either
   exits. Editor changes go through the same filesystem, and a reload right after a save resolves
   keeps the save.
6. Files survive reload, including metadata, rename, and unlink with an open descriptor.
7. Ctrl+C stops the foreground job and its descendants, including CPU-bound WASM and CPU-bound JS
   in QuickJS, JSC and Bun light, wakes blocked I/O, and returns the shell to the prompt with
   status 130, on Chromium, Firefox and real Safari. Background jobs keep running.
8. Bun previews keep working, routed through the network service.
9. Bun light stays near its budget: runtime JS about 100 KiB minified / 35 KiB gzipped, the
   process layer loaded only on first spawn, and no slower startup. The budget is a guide, not a
   hard gate (owner, 2026-10-16): modest overshoot is fine when it buys something.
10. Verified on Chromium, Firefox and real Safari (owner's Mac); iOS Safari where storage allows.

## References

- `/work/reports/browser-shell-research/browser-runtime.md`: prior art, browser support, coupling
  audit of `web/src`.
- brush-web `plans/001-brush-dev-shell.md`, `plans/004-own-shell.md` and `docs/external-commands.md`.
- Spike reports: `/work/reports/browser-runtime/spikes/`.

## Safari workspace ownership

Status: Approved. Implemented in PR #62, awaiting independent review.

Safari can freeze a cached document's filesystem worker before pagehide or freeze cleanup can
flush and release its Web Lock. A fresh page in the same tab then fails to open the workspace.
The regression reproduced on desktop Safari 26.4 and iOS simulator Safari 26.5.

IndexedDB now requests the workspace lock with `steal: true`. On acquisition, a strict IndexedDB
transaction increments `metadata["epoch"]`. The new backend loads the current persisted tree;
it never inherits the previous page's memory. Each commit reads its captured epoch in the same
strict transaction that writes payloads, appends journals, swaps snapshots and deletes obsolete
journal records or payloads during compaction. A stale epoch aborts the whole transaction.
A transaction that committed before takeover remains part of the new owner's saved state.

Loss of the Web Lock rejects its lifetime promise. The displaced storage owner aborts active
transactions and rejects queued operations. Its worker disposes background checkpoints, reports
ownership loss and closes; the page revokes the service and terminates the worker. Epoch fencing
also rejects a stale writer that resumes before receiving the lock-loss notification. Editor text
stays visible. The complete message says "This workspace was opened in another tab. Reload to
continue here." It also explains that unsaved changes in that tab weren't kept and can be copied
before reloading. Saves acknowledged before takeover remain durable.

OPFS keeps `ifAvailable: true`, without stealing. Its writes use native sync access handles and
cannot be fenced atomically by an IndexedDB transaction. An occupied OPFS workspace explains that
a tab or browser-history page owns it and asks the user to close those tabs before reopening.
IndexedDB uses a separate lock namespace so opening that backend cannot steal an OPFS lock.
The runtime track, bun-wasm-a8, owns review of this persistence boundary.

A cheap cache-header probe found `Cache-Control: no-store` ineffective on isolated localhost
HTTP in both Safari versions. Over private HTTPS, responses with no-store returned a new
document on Back on both platforms. The HTTPS proxy also injected no-store on the requested
control response, so that probe has no cacheable HTTPS control. Static site document headers and
`web/serve.ts` use no-store as a complement. Correctness still comes from fencing, verified while
real Safari restores cached documents on localhost HTTP.

`scripts/test-web.sh` runs the storage fencing and Chromium/WebKit lifecycle regressions.
For real Safari, build the small fixture on the PC through the heavy queue:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
bash /work/tmp/wave-heavy/run.sh --class light safari-lifecycle-assets -- env PATH="$PATH" \
  bun web/tests/browser-filesystem-lifecycle.ts --build /work/tmp/bun-wasm-safari-assets
```

Copy the assets and `web/tests/browser-filesystem-lifecycle.ts` into an owned directory under
Mac `~/tmp`. Reserve `~/tmp/.agent-mac-lock`, record the simulator's boot state and serve the
assets on an explicit free localhost port with COOP same-origin and COEP require-corp. Run:

```sh
export PATH=$HOME/.local/share/mise/shims:$HOME/.bun/bin:$PATH
SAFARI_DRIVER_PORT=43462 SAFARI_OUTPUT=desktop.json \
  bun browser-filesystem-lifecycle.ts safari http://127.0.0.1:43463/
SAFARI_IOS=1 SAFARI_DRIVER_PORT=43462 SAFARI_OUTPUT=ios.json \
  bun browser-filesystem-lifecycle.ts safari http://127.0.0.1:43463/
```

The iOS check uses the booted iPhone 17 Pro simulator. Both platforms cover same-tab reopen,
Reload, restoration of a displaced cached page, Reload after Back with no other tab, newest-wins
two-tab ownership, preserved visible edits, durable saved files and OPFS no-steal recovery.
Stop the server and driver, shut down only a simulator booted by the run, and remove transfers
and the owned lock. Evidence remains under `/work/reports/bun-wasm-safari-fencing-2026-10-17/`
until the coordinator resolves PR #62. Earlier rejected lifecycle approaches remain in
`/work/reports/bun-wasm-safari-lifecycle-2026-10-17/` under the same cleanup owner.
