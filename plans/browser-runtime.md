# Waffle browser runtime

Waffle is the page-owned browser runtime for WebAssembly guests. It provides one shared filesystem,
identity allocator, process admission service, worker bootstrap, preview routing and injected network
transport. Consumers create one `createRuntime()` owner and borrow capabilities for each run; a run
or shell never disposes the page runtime.

## Boundaries

Waffle owns `core/`, `fs/`, `proc/`, `interrupt/` and generic `browser/` services. A consumer owns
guest engines, native bindings, module caches, service-worker registration policy and application
adapters. Consumers pin one exact Waffle Git commit and use the matching package exports.

## Automatic shared-memory defaults

Status: Idea, deferred by the owner on November 6, 2026. Owner: Waffle runtime track.
Automatic Apple-mobile defaults are not required target behavior. Keep the current omission
contract: omitting `sharedMemory` selects the unbounded default on every browser, without
reading the user agent. Explicit application declarations remain available.

[PR 272](https://github.com/ShaulLavo/waffle/pull/272) is closed as superseded. Its branch
`t3/ios-memory-budget` and head `1600eb044c388a2fb9e9df14252c6a58988b392e` are preserved.
Automatic Apple-mobile defaults were not shipped. Accounting and admission landed separately
in [PR 339](https://github.com/ShaulLavo/waffle/pull/339), and Runtime thread work landed in
[PR 340](https://github.com/ShaulLavo/waffle/pull/340).

There is no demonstrated failure caused by omitted `sharedMemory` reserving too much.
The conditional Nuxt iOS runs consume Waffle 0.0.110, not PR 272 or current main, and do not
qualify current main natively. Browser-specific defaults need a real failure, not browser sniffing
based on assumed capacity. The separate [default-sizing measurement plan](../docs/reservation-defaults-later.md)
does not make automatic mobile defaults required behavior.

Revisit this idea only if an actual iOS or other run fails because omitted `sharedMemory`
reserves too much. Capture the failing allocation, runtime version, browser, and reproduction.
Then design a narrow fix against current main, with an independent review and regression tests
before merge. Do not revive the broad draft or infer backing-memory reclamation from worker exit.

Keep the process-disappearance test-observer correction on its own PR. Nuxt and its iOS SSR fetch
TypeError remain with Engines. This decision changes no source, release, or consumer pin.

## Admission and cleanup

Source bytes are instrumented before execution. A compiled module requires explicit cooperative
admission. Process and filesystem identities are retained before worker launch. Revocation selects
a logical outcome immediately; physical termination follows filesystem quiescence and descriptor
cleanup. Disposal fences admitted consumers before closing the filesystem worker and releases the
stable duplicate-bundle ownership guard last.

### Codec-construction failure ownership

Status: **Merged in [PR41](https://github.com/ShaulLavo/waffle/pull/41)**. Reproduced on 2026-10-21 against main
`15ba700268b6199e22ef61aa0d9464798c0d9562`, with test-only commits `56ae6de` and
`f55598c`. Missing filesystem metadata produced confirmation `0`, job pending `1`,
an open writer lifetime, no reader hangup and no launch. The original diagnostic
was `TypeError: runtime process has no filesystem identity`. These are admission
cleanup defects, not a reproduction of the old ordinary-parent-exit WebKit failure.

The browser supplies an independent descriptor discard capability. It works even
when the import codec cannot be built. Rejection cleanup owns its tokens and fence
before confirmation. A valid filesystem identity must revoke and quiesce successfully.
Invalid metadata permits token-only cleanup only when this broker has acquired no
process record, controller, worker connection, launch or pending launcher for that
directory, slot and monotonic PID. An acquired consumer or failed real fence stays unconfirmed. External rejection
fences remain owned through runtime quiescence and disposal. Valid payload metadata
cannot replace an acquired controller's adapter fence or separate filesystem fence.
Controller registration captures the lifetime when its row exists. A controller
registered before publication binds through this broker's root directory when cleanup
starts. Supervisor reservation captures the admitted lifetime before descriptor import.
Consumer ownership remains retained while records, controllers, workers, launchers or
fences still need it.

Run `bun test tests/browser-process-broker.test.ts --test-name-pattern 'codec construction'`.
Controls cover missing/malformed metadata, an independently throwing import factory,
a held valid filesystem fence, a rejected fence and an already acquired consumer.
Original observations and gate evidence are retained under
`/work/reports/waffle-finish-20261021/admission/`.

### Rejected duplicates during queued admission

Status: **Merged in [PR41](https://github.com/ShaulLavo/waffle/pull/41)**. The same baseline reproduced synchronous
external rejection between `runtimeMessage(spawn, parentPid)` and its first await.
The duplicate selected SIGKILL, closed the accepted writer, cleared job pending
membership and prevented launch. Test-only commit `f55598c` preserves the red control.

Queued ownership now starts synchronously and is keyed by shared directory plus PID.
It is separate from supervisor records and remains owned through rejection cleanup.
Repeated delivery owns no additional lifetime. Both external rejection and a repeated
queued delivery leave the original tokens and outcome alone. Foreign directories
release their own transfers without touching an accepted same-number PID. Disposal
selects queued outcomes and drains admission cleanup before retiring pipe relays.
Sender authentication errors also start rejection cleanup for the incoming transfer,
so malformed queued parents cannot strand an already-published child's writer.

Run `bun test tests/browser-process-broker.test.ts --test-name-pattern 'queued duplicate'`.
Controls cover external duplicates, repeated delivery, foreign-directory PID aliases,
queued disposal with valid/missing metadata, and held queued/external filesystem fences.
Existing accepted-child writer, ordinary-parent-exit and stable-generation EOF tests
remain blocking. No parent-liveness condition or eager supervisor loading was added.

Independent review reproduced three further cases at `d495f731`: bypassed controller
fences, a stranded nested transfer and foreign-directory PID aliasing. Test-only
`47da45f` preserves those reds. The `admission review r1` controls cover their repairs,
prepublication controller ownership, both real filesystem fences and rejected adapter
fences. The nested control captures confirmation words before orphan reclamation and
checks current pending membership instead of reading a collected tagged row. Original
review source and failed runs remain unchanged. Repair evidence is under
`/work/reports/waffle-finish-20261021/admission/repair-r1/`.

The r2 independent control found that incoming rejected transports retained for
cleanup could incorrectly bind an unadmitted local controller to a foreign lifetime.
Deferred controller binding now uses only publication in this broker's adopted root
directories. Successful supervisor admission already records the exact acquired
lifetime through its admission hook. Cleanup retention cannot authenticate either
path. The permanent `admission review r2` controls cover incoming and external
foreign rejection before local admission. Original thirteen-case reviewer controls
and failing-first evidence remain under
`/work/reports/waffle-finish-20261021/admission/repair-r2/`.

PR41 merged as `7be9014cac046daf9c6ab06e367a8c4e03e0521f`. Exact-main CI run
`39519747254` passed all five jobs. These admission repairs do not accept the
remaining storage requirements.

### Logical process identity and exec follow-ups

Status: Approved follow-up, non-blocking notes from the independent review of
[PR 542](https://github.com/ShaulLavo/waffle/pull/542) (merged at `6815eca7`, released in 0.0.140).
Owner: process-lifecycle track.

- Missing test: no test yet covers the interleaving where a spawning thread's row is
  published but its second admission check has not run when exec closes image admission.
  In that case the spawn returns `-ESRCH` even though the caller's image stays current
  (`docs/host-abi.md` says so). Add a deterministic control that pauses the spawn between
  row publication and the second check, runs exec, and asserts `-ESRCH`, an unchanged image
  and no leaked reservation.
- The supervisor option `commitReplacement` (`packages/waffle/proc/supervisor.ts`) is typed
  optional, but it is required for safety whenever the process has a directory row: without
  it, exec does not close directory admission. Either make it required for directory-backed
  processes or assert its presence when the row exists.
- Deliberate difference from Linux, FreeBSD and XNU: those kernels kill sibling threads when
  one thread calls exec. Waffle refuses exec with `-ENOTSUP` while a sibling thread lives and
  neither waits for nor terminates siblings. Keep this unless a consumer needs POSIX
  semantics; changing it needs a design for sibling termination and cleanup ordering.

## Storage and networking

The shared filesystem supports memory, IndexedDB and OPFS backends behind the same capability
protocol. The network helper receives an injected `fetch` implementation and sends framed responses
through shared rings. Preview URL routing and service-worker scope remain consumer choices.

## Verification

The standalone gates run package install and `prepare`, TypeScript checking, unit tests, installed
Node exports, generic browser storage/process acceptance, and the gzip core budget declared in
`tooling/runtime-size.ts`. Generated `dist/` output is ignored and must never be committed.

## Rust socket module lane

Approved, in progress in draft PR105 from exact base `d9973ca6b892ecf4b8a210be5328eb2645207d0d`. The first module moves portable queues, nonblocking stream state, native dual-stack bind/fallback and browser virtual namespace rules into Rust. Waffle owns the reference `socket2` import adapter. Helpers retain the existing rings and guest contracts. The lazy boundary remains `runtime.network()`.

Remaining consumer work belongs to the Bun parent lane: wire the explicit module/import bridge, update the exact Waffle pin, and rerun facade fixtures. Asynchronous bind completions, DNS, TLS and close-linger timers are not delivered by the immediate nonblocking host ABI. No native threads run in WASM.

## Bounded filesystem request IDs

Approved for a later protocol change; nonblocking for PR203. A connection currently allocates positive 29-bit request IDs through 536,870,911, then returns filesystem errno 33 on later allocations. This is an explicit bounded contract, not an elapsed-time limit or a measured endurance claim.

A small reproduction sets `FilesystemRequestAllocator.nextId` to `0x1fffffff`, observes the final valid allocation, and observes errno 33 on the next call. A blind wrap is unsafe: `{completed:id}` and discard controls carry no generation, so a delayed old frame could complete or cancel a replacement with the same ID. Safe reuse therefore needs late-frame generation fencing as well as skipping live IDs.

The follow-up must add generation-tagged completion/discard controls (or an equivalent proof), wrap only after skipping every live ID, and test delayed old completion/discard against a replacement, cancellation, stale descriptors, generation/arena reuse and exact resource accounting. No ID wrap belongs in the retirement and release-accounting corrections.

## Guest watcher full-suite timeout

Approved, unclassified. Found while testing PR226 (head `1116adc`, base `a4d2fec`): `bun run test`
gave 4961 pass, 24 skip, 1 fail. The failure is `packages/waffle/tests/watch-committed.test.ts:418`,
"real guest watcher receives peer direct commit or is forcibly reaped, killed=false", which hit its
10 s timeout. That case runs `tests/watch-direct-worker.ts` in `mode: "watch"`. The worker posts
`ready` after `client.watch()` resolves and only then awaits `watch.next()`; the test writes after it
sees `ready`. Three isolated runs of `bun test tests/watch-committed.test.ts` each gave 29 pass,
0 fail. That shows the failure only in the full suite. It proves nothing about its cause, and load is
not established. The test, its worker and their imports use only filesystem and watch modules, so
they never touch terminal output directly.

Logs and the reproduction command are in
`/work/reports/wave-20261029/waffle/output-credit-rearm/` (`test.log`, `watch-committed-isolated-*.log`).
Next step, before choosing any fix: in the failing full-suite order, record the watch ring sequence
and counter at `ready`, after the peer write, and when `watch.next()` starts waiting. That shows
whether the commit is published before the reader waits and whether it is ever lost. Raising the
timeout is not a fix.

## Serial guest-watch notification stall

The earlier navigation investigation captured the same successful-notify, lost-settlement
signature. Its observations and rerunnable diagnostic are retained in
`/work/reports/wave-20261106/webkit-navigation/GUEST-WATCH.md`. This follow-up is resolved
by [PR 375](https://github.com/ShaulLavo/waffle/pull/375).

Approved; implemented in this change. The serial WebKit proof could hang during a quiet
write even though native notify returned 1. The source counter advanced while the relay's
pending `Atomics.waitAsync` promise never settled. This is separate from navigation and
the unclassified Bun full-suite timeout above.

A standalone three-word native reproduction also stalls and resumes on an unrelated
worker message without a second notify. In Playwright WebKit 2370's pinned WebKit commit
`56453fdfe0b0ca6258c23e6453b34f70b885d13f`, `WorkerDedicatedRunLoop::runInMode` checks
native timers before attaching `addTimerSetNotification`, then sleeps on its message
queue. A notify in that gap schedules promise resolution without waking the worker.
Retaining the promise or its result object cannot close that gap.

The relay now uses one reusable blocking worker per armed word. Each native `Atomics.wait`
checks the original expected generation again when its request arrives, and its message
reply resumes the relay. Disposal terminates these workers; physical parent termination
also terminates its nested workers. This adds up to three workers per guest in exchange
for removing worker native-async timer dispatch from the forwarding path. There is no
polling, deadline extension, or change to existing guest-watch assertions.

`bun packages/waffle/tests/notification-race-browser-runner.ts` drives 200,000 isolated
handoffs and runs in serial browser CI. Before the fix it failed at handoff 13,889 with
notify returning 1; after the fix all 200,000 passed. The unchanged guest-watch case also
passed 200 fresh WebKit contexts: 4,000 quiet writes and 40,000 socket-ordered writes.
The native reproducer and rerunnable context loop are retained in the owner report
`/work/reports/wave-20261106/guest-watch-race/`. Actual Safari acceptance remains separate.

See [Browser workaround evidence](browser-workarounds.md) for the relay's removal check and
other active workarounds.

## Recovering quarantined pipe slots

Status: Approved follow-up. Owner: process-lifecycle track. The pipe-reuse change deliberately
quarantines a ring if a Worker dies while its incarnation word has active sections. The default
pipe has 16 writer and 16 reader slots; each abandoned section can permanently cost one slot.
The default writer exhaustion diagnostic is exactly `pipe write process limit reached: 16 slots
are live, busy or incarnation-exhausted`. Reader exhaustion additionally names unread slots.
No timeout or logical revoke may clear an active count.

Reproduce with `bun test packages/waffle/tests/pipe-reuse-worker.test.ts --test-name-pattern
'physically paused Bun Worker death'`. A real Bun Worker pauses in its publication CAS, the
host revokes and terminates it without releasing the gate, and the raw epoch remains at one
active section. The other slot continues to reclaim. The test owns Worker termination and
controller disposal in `finally`; no native-stop redesign is included in this change.

Recovery needs a trusted, exact native-stop acknowledgement associated with that slot's
incarnation, plus proof that no admitted native copy can still finish. Browser `terminate()`
and registry collection do not provide that proof. Add delayed-copy, stale acknowledgement,
replaced incarnation and physical-death controls before clearing any abandoned count. Keep
finite quarantine if no platform-independent proof is available.

A quarantined writer slot now also keeps the pages its interrupted write mapped: at most 16
shared payload pages (writers leave the pool's last two to deliveries) and one record page.
Its two reserved pages, and every other writer's, are untouched, so the pipe keeps working
with less burst room. Those pages lie ahead of the slot's published cursor, where only a fenced
sweep may free them; recovery runs `Ring.sweep(true)` once it has the same proof.

## Pipe memory and small-write follow-ups

Status: Approved. Owner: process-lifecycle track. The paged-ring change (perf lane "pipes",
2026-11-22) cut a default pipe from 2,622,760 to 266,040 reserved bytes and made a 64-byte
`tryWrite` plus `tryRead` about twice as fast. Guard each step with outcome tests like
`packages/waffle/tests/pipe-pages.test.ts`, measure it with the perf suite's section 4.5 rows,
and record before and after numbers in the PR.

1. **Pipe registry maximum.** Each runtime root's `PipePublicationRegistry` is a growable
   buffer declaring 16,785,424 bytes (1,048,576 append-only cells), which Safari reserves in
   full at construction (`docs/shared-memory.md`). Cells are never reused because a retained raw
   view must never alias another cursor. Design incarnation-tagged cells (or cell pages that a
   collected owner returns once no endpoint can name them) so the declared maximum can drop to
   about 1 MiB without lowering the lifetime pipe count. Check how gVisor and FreeBSD bound
   per-process pipe metadata first. Reproduce the reservation with
   `runtime.sharedMemory.snapshot()` after `createRuntime()` and one root adoption.
2. **Shell pipelines always relay.** A shell holds its read end while it forks the reading
   child, so `retain(child, "read")` sees two reader processes and switches the pipe to relay
   mode for good; every byte of `cat | grep` then crosses the page's relay. Defer the switch
   until a second reader process actually reads, which needs the direct consumer lease
   (`Ring.bind(pid, "consumed")`) to move from the parent to the child when the parent closes.
   The relay 64-byte round trip measured 4.9 µs on main against 1.9 µs direct.
3. **Idle writers' shared pages.** A writer returns a partly used shared page only on its next
   write, so 16 idle writers could each pin one shared page and leave others their reserved
   8 KiB. The last page of every write prefers a reserved page, so this needs an unusual
   pattern; add a pressure test before changing anything.
4. **Remaining small-write costs.** Each write and read still sends two notify pairs
   (`changed` and the service wake), allocates a 64-bit ticket and scans all 16 writer slots
   in `PipeState.source`. A count of occupied writer slots, or one notify word, would remove
   most of the rest. Keep the scan's ceiling rule.
5. **Interleaving harness gaps.** `tests/pipe-interleave-matrix.test.ts` pauses the page or a
   guest realm at every point in `PIPE_PAUSE_POINTS` while another realm runs one of 12
   actions, in direct and relay mode. Injecting each round 1 and round 2 bug back into the
   fixed code, it catches all but two: a retire that frees pages without a wake (another wake
   always follows in its workload; `pipe-page-recovery.test.ts` catches it), and an unfenced
   sweep judging against a stale cursor (unreachable in a test now that laps are full width:
   half the lap space is 2 GiB of traffic). It runs no registry-backed pipes and no real Worker
   termination; add both when the registry or quarantine recovery changes. A tag-back
   (`sweep.retag`) needs an aborted write that wrapped onto unread bytes, which the matrix
   workload never makes; `pipe-interleave.test.ts` pauses there directly.
6. **Mixed-size atomics on page entries.** `PageMap.find` and `reservedBusy` read the low and
   high halves of a 64-bit entry with 32-bit `Atomics.load`, while every write and CAS is 64-bit.
   Tearing is harmless (a producer reads only its own stable entries, and a reader that copies
   through a torn view loses its consuming CAS), and aligned halves are single-copy atomic on
   x86-64 and ARM64, but ECMA-262 calls overlapping mixed-size atomics a data race. If a strict
   memory-model checker (TSan on a JS engine, or a spec-level model) is ever run over the pipe
   suite, switch those reads to 64-bit loads and measure the small-write cost (about one BigInt
   per lookup).

## Non-root openat without a filesystem mutation

Status: Approved follow-up, split out of [PR 600](https://github.com/ShaulLavo/waffle/pull/600)
after three independent review rounds exposed publication-mode and custom-backend edge cases.
Owner: Waffle performance / filesystem track.

Today every `path_open` (`openat`) from a non-root directory descriptor calls `fs.preopen("/")`
inside `resolveDescriptorPath` (`packages/waffle/core/fd-reopen.ts`) to compare the directory's
inode against the filesystem root. Over `FilesystemClient`, `fs.preopen("/")` is a synchronous
IPC mutation that takes the global mutation lock and bumps the shared `epoch`, invalidating every
client read, stat, path, and readdir cache on every subdirectory open.

PR 600 initially tried adding a read-only `FileSystem.isRoot?(handle)` query across `MemFS`,
`MemoryBackend`, `FilesystemService`, and `FilesystemClient` (and earlier tried `table.rootPreopen()`
with a per-description inode `WeakMap` and reading `stat.mode` instead of `fs.permissions`). That
work was reverted out of PR 600 so the safe single-stat and WASI hot-path wins could ship. Any
future design that removes the `fs.preopen("/")` mutation on non-root `openat` must satisfy all
seven constraints surfaced in PR 600 review rounds 1 to 3:

1. **Retained root aliases after closing the `/` preopen.** Opening `.` from the `/` preopen,
   closing the `/` preopen, and then opening `dev/fd/0`, `proc/self/fd/0`, or `dev/null` through
   the retained directory must still resolve those virtual aliases (while regular-file reopen still
   checks the live root preopen for rights).
2. **Subdirectory mapped as the `/` preopen.** With `preopens: { "/": "/volume" }`, opening `.`
   and then `dev/fd/0` through that new descriptor must open the real `/volume/dev/fd/0` file
   rather than shadowing it with stdin.
3. **No stale root cache.** Caching directory inodes in a `WeakMap` or shortcutting on handle
   equality against the preopen keeps aliases active after the backing root inode or `preopen("/")`
   handle changes; root identity must track the live root or invalidate on every root change.
4. **Effective permissions vs `stat.mode`.** `openInode` must keep consulting `fs.permissions`
   because adapters can report effective access and supported-bit masks that disagree with raw
   `stat.mode` bits.
5. **Publication-mode lock and epoch.** In publication mode, `executePublication` wraps requests in
   `beginServiceMutation` / `endServiceMutation`, which takes the global mutation lock and advances
   the epoch by two on every read-only check. The root check must run as a plain read everywhere,
   including publication mode, with no mutation lock and no epoch bump, while still applying
   publication's session, handle and activation authorization checks.
6. **Resident-grant exclusion (`EBUSY`) after rename.** Bypassing `beginServiceMutation` in
   publication mode also bypasses `assertCurrent()`. After a service rename changes a directory's
   `ctime`, `MemoryBackend.check` -> `sync` -> `shared.register` can take the global lock without
   checking an outstanding resident grant, returning `false` where `stat` returns `EBUSY`. The
   serial read path must keep the explicit `assertCurrent()` check and inspect the live directory
   node directly.
7. **Errno preservation for backends without the query.** `FilesystemService` accepts custom
   backends that only implement the existing operation set. Calling an unimplemented query
   unconditionally from `FilesystemClient` turns a subdirectory `ENOENT` (44) into `ENOSYS` (52).
   Carry optional capability discovery across the service boundary or fall back to the existing
   inode comparison without hiding errors from a supported query.
