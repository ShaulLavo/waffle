# Run storage tests on iOS Safari

Use an exclusive checkout on the Mac. Enable Safari's WebDriver support and select an
available iOS Simulator before the run. Coordinate access to the Mac and Simulator
with other test runs.

Run the complete storage suite with the Simulator's exact UDID and an absolute result path:

```sh
IOS_UDID=<simulator-udid> bun packages/waffle/tests/storage-browser-runner.ts ios-safari --result /absolute/storage.json
```

The runner checks the returned Safari, iOS, Simulator, and device capabilities before
using the session. It runs the IndexedDB and OPFS factories with both filesystem
Worker routes. Each case runs in a dedicated Worker in a fresh document. The Worker
timeout remains 45 seconds.

Read the result outside the disposable scratch directory. The result includes the
required and selected cases, outcomes, document retirement cutoffs, exact storage
allocations, session identity, and cleanup dispositions.

Treat any unconfirmed cleanup as a failed run. Stop the recorded consumers before
removing retained scratch or deleting the listed storage entries. Do not delete
storage by prefix or signal Safari, Simulator, or launchd's HTTPService.

Set `STORAGE_TEST_FILTER` to select labels during diagnosis. A filtered run preserves
the complete required inventory and cannot report complete suite success.

The native command exits with these codes:

- `0`: every required case passed, reporting finished, and cleanup was confirmed.
- `1`: test assertions failed, but reporting and cleanup succeeded.
- `2`: a host, protocol, reporting, or cleanup failure occurred.
- `3`: the native platform, UDID, or command arguments failed a precondition.
- `4`: a filtered run completed without a host failure.

Desktop Playwright commands remain unchanged. To run the page reporter's local
failure and real-storage controls, use the cached Playwright engines:

```sh
bun packages/waffle/tests/page-runner/browser-controls-runner.ts chromium webkit --result /absolute/controls.json
```

Set `STORAGE_LIFECYCLE_OBSERVER=1` on the desktop storage runner to log native
IndexedDB and Web Locks lifecycle observations. CI enables it for the parallel
browser group. The observer adds native queries and promise reactions that can
change scheduling. A missing event does not prove a lock was released, and a
passing observed run does not establish what happened in an earlier failure.

These controls test reporting failures, the original Worker timeout, document death,
and exact-name cleanup without deleting foreign-prefix storage. They do not count
as an iOS storage-suite run. The standard browser matrix and CI run these controls
on Chromium and WebKit. Unit and fake-driver controls run under `bun run test`.

## Storage-lock peers

```sh
IOS_UDID=<udid> bun packages/waffle/tests/storage-lock-browser-runner.ts ios-safari --result /absolute/storage-lock.json
```

Storage-lock keeps all nineteen original ordered cases, including both backends and the
retained recovery Worker observation. `STORAGE_LOCK_TEST_FILTER` matches the original
backend-qualified identity. Filtered runs retain omitted rows and exit 4, not whole-command
success. Each operation has its original 15-second bound. The command has one 600-second
clock starting before fixture preparation, not a new clock per case or peer.

A host case can call required `host.openPeer()` and retain its returned `HostPeer`.
Its `script`, `task`, `reload`, and `close` methods bind to that exact document generation.
Reload returns a successor and revokes the old capability. Close does not dispose a fixture.
The page's `HostPageRun.peer(request, allocate)` hook installs its allocation bookkeeping
before construction. `budgets.operation` limits each operation separately from the case.

One command queue owns actual handle selection. Every create, refresh, and close waits for
its source document's actual ordered HTTP acknowledgement. Peers report and heartbeat
independently. Case pass stays provisional until all peers are physically contained and
exact registered storage deletion is acknowledged. An uncertain operation stops dispatch
and preserves storage debt instead of opening another cleanup session.

The driver requires same-session new-window, switch-window, refresh, and close-window support.
The requested tab type is a hint; a valid returned tab or window is accepted.
An unsupported native operation fails the command. Desktop controls do not prove installed
Safari support. Case 18 additionally requires a fresh private-port location reply from its
sole original retained recovery Worker. A timeout, replay, wrong location, or replacement
fails that row. The original desktop Worker enumeration oracle remains unchanged.

## Other page-owned Safari commands

Each command runs its original exported body once and writes its actual result to a separate file. Only storage uses `STORAGE_TEST_FILTER`.

```sh
IOS_UDID=<udid> bun packages/waffle/tests/guest-watch-browser-runner.ts ios-safari --result /absolute/guest-watch.json
IOS_UDID=<udid> bun packages/waffle/tests/fs-socket-browser-runner.ts ios-safari --result /absolute/fs-socket-attachment.json
IOS_UDID=<udid> bun packages/waffle/tests/search-executor-browser-runner.ts ios-safari --result /absolute/search-executor.json
```

The new page-runner case clocks reuse the desktop lifecycle bounds of 120, 60, and 600 seconds. Including list, finish, retirement, and cleanup, their total allowances are 510, 450, and 990 seconds. The bodies retain their shorter internal deadlines. All existing desktop engines and CI rows remain blocking.

## Use the host from a Bun consumer

Test tooling can import `runPageSuite`, `nativeMain`, `ownedDatabase` and the authoritative
`SuiteAdapter`, `RunOptions`, `NativeOptions` and `PreparationContext` types from
`waffle/testing/page-runner`. Browser pages import `isHostedPage`, `startPage` and
`cleanupStorage` from `waffle/testing/page-runner/page`. Local controls explicitly import
`PlaywrightDriver` from `waffle/testing/page-runner/playwright` and supply their own
Playwright development dependency. The host and driver imports are Bun-only, not Node exports.

An adapter's `assets({ scratch, signal })` prepares its complete same-origin asset map below
the owned scratch directory. The callback settles only after its producer has stopped.
Unconfirmed producers retain scratch. File blobs retain their MIME types. `page.path` and
`page.script` select local document and module paths; reserved reporting routes take precedence.
Keep `requireResult: true` in a result-bearing consumer policy. `ownedDatabase(prefix)` accepts
only IndexedDB with the exact name `${prefix}-${run}` during a running case. Await allocation
before opening it, reuse that name sequentially, and finish with exact-ledger cleanup.

Pass a finite same-process `performance.now()` value as `startedAt` to include earlier setup
in the absolute budget. An explicit `port` is validated and probed before preparation, then
bound without fallback. Omit it to retain storage's environment behavior. A consumer may set
`resultWaitMs: 90_000` for its terminal result window after navigation, with `case`, `group`
and `run` budgets of 120,000 milliseconds. The original absolute deadline still wins, including
report draining and finish retirement. Confirmed teardown runs after the execution clock stops.
These test-only exports do not load through the production runtime.

## Drive a case from the host

The Bun entry `waffle/testing/page-runner` exports `SuiteCase`, `HostCase`, and
`HostVerdict`. Add an optional `drive(host)` callback to a case descriptor. It runs
original setup and assertions after receiver admission, under `budgets.case`.
Return compact serializable evidence. Use `host.script(source)` for synchronous
JSON observations or void mutations and `host.task(source)` for asynchronous void
work. `host.sleep(ms)`, `host.signal`, and `host.remainingMs()` share the original
setup/body deadline. Task completion uses ordered reports, not a long WebDriver
request. Scripts return complete values up to the 4 MiB WebDriver response limit.

`await host.allocateDatabase("prompt-costs")` returns exactly `prompt-costs-${run}`.
The adapter must select `allocation: ownedDatabase("prompt-costs")`. Prefixes must
be nonempty and at most 900 characters. The bound page awaits its allocation ACK
and reports task completion before the host returns. Allocation shares the task
slot and setup/body clock. It opens nothing and grants no additional cleanup
policy. Await the returned name before constructing a FAST runtime, dispose its
owner before sequential same-name reuse, and finish with `cleanupStorage(ledger)`.
A failed or late return must not start a constructor. An accepted report whose
ACK was lost still belongs to the exact ledger, even if the page cannot finish.

The page entry exports `HostPageRun`. Supply
`run: { kind: "host", teardown: async (request, verdict) => { /* original hook */ } }`.
The page runs that hook once after the bound verdict, including setup failure.
`budgets.teardown` is a separate hook window. `budgets.caseDocument` bounds the
whole host case document. List and finish keep `budgets.group`. Omitted additions
preserve page-driven behavior. Host callbacks and commands are revoked and joined
before scratch deletion. Unsettled callbacks retain scratch and force exit 2 even
if the browser session was deleted. Failure evidence is saved beside the result
as `.diagnostics.json` before scratch removal.

A known reporting failure revokes ordinary host commands immediately. Document,
heartbeat, and enclosing run deadlines are checked at admission and dispatch, not
only by a timer. After interruption, a still-bound, certain page receives at most
one cleanup verdict under a fresh bound, and its original teardown is awaited.
An unconfirmed in-flight command or teardown requires session containment instead
of navigating away and treating cleanup as complete.

## Framework-owned documents

`waffle/testing/page-runner/framework` is a separate, test-only Node host. Node resolves prepared JavaScript after normal package preparation. The existing Bun host remains Bun-only. The framework host mounts its collector on the real Vite server, retains the exact provider URL, and owns one attached session and one command queue. It does not depend on a framework or browser SDK at runtime.

Call `host.mount(server.middlewares)` in the Vite plugin before creating a session. It rejects duplicate and conflicting reserved routes. The attached provider registers public frame callbacks before connecting. Its command hook calls `host.requestStarted(this)`. Its transport uses `host.guardRequest` and `host.observeResponse`, so swallowed command-hook errors cannot permit HTTP dispatch or erase an uncertain response. Existing navigation, frame, and cleanup strings retain their callback semantics. Consumer glue still rejects unsupported input and CDP operations. Provider close awaits `host.detach()` without deleting the session. The parent deletes it once after joining consumers on success. After a fault, it starts session deletion before joining execution-dependent context close. Cleanup still requires actual consumer settlement; cancelling a wait does not confirm cleanup.

Use callback-free `host.provider({ kind: "viewport", width, height })` after the framework has changed the tester iframe CSS. Waffle verifies actual tester dimensions before and after the operation. Requests accept finite positive numbers, including fractions. A fractional request fails as unrealized when the actual tester dimensions differ; iframe rectangles do not substitute for tester dimensions. Waffle does not resize the physical window, round dimensions, or undo CSS. Same-size calls require no resize event. The startup 414 by 896 geometry remains separate in the result.

Wrap the entire official screenshot callback in `host.provider({ kind: "screenshot", file }, callback)`. The file is the admitted framework file, not an artifact path. Preserve the callback receiver, arguments, result, and rejection values. Consumer registration and mutable-context checks belong to the consumer adapter. Check that context immediately before the official callback starts inside the admitted scope and after it settles. SDK request hooks alone cannot guard the callback's earlier filesystem work.

Both domain operations require exact collection admission and live file content, including file hooks before a case starts. They are root-only. Each invoked callback has a separate scope. Settlement seals that scope without revoking an already-admitted live child. The existing queue recursively joins children and HTTP before its private finalizer checks documents and restores the entry frame. Child failures remain failures even when swallowed. Faults immediately cancel owned request signals; cancellation does not count as settlement. Overlapping sibling frame transitions are rejected.

Ordinary viewport completion supports sequential calls. The framework's unchanged events match only an iframe ID, so concurrent page calls can both resolve on the first done event. Provider serialization does not fix that correlation limit. The synthetic DOM controls exercise a matching CSS/event route, not the installed framework's ordinary page method. A combined admitted real-DOM, official-provider and SDK control remains a consumer integration gate. Separate DOM controls and null-binding installed SDK controls do not satisfy it.

The browser-only `waffle/testing/page-runner/framework-page` entry exposes `getFrameworkObservation()`. The consumer instruments both actual framework documents before modules, preserves original lifecycle calls and RPC, and converts its installed task types into `FrameworkTask` and `FrameworkUpdate` records. List each original case's effective `timeoutMs` in the independent `ExpectedCase` inventory, including an explicit per-case or inherited suite timeout. It must be a positive finite number. Collection requires the actual clock to equal that case's declared clock by file and full name, with `mode: "run"` and zero retries. This metadata does not change the 15,000 ms default test clock, 30,000 ms hook clock, 600,000 ms file deadline or 900,000 ms run deadline. Collection awaits the independent inventory ACK. All record methods return a delivery promise and take synchronous snapshot factories for external data. The adapter awaits genuine lifecycle boundaries outside body and hook timeout wrappers. Update and error tees separately observe reporting rejection while preserving each official callback, RPC and original return expression. Execution flush and cleanup observations close content synchronously before their queued reports. This does not retire reporting or prevent final ACKs and cutoffs. Removed or replaced retained frames and ancestors, and pagehide in either document, permanently invalidate content authority; restoring the same objects cannot revive it. At the automatic viewport call site, await `waitForInitialViewport()` outside the command queue and send its one-use request to `host.initialViewport`. At the original matched cleanup response, await `cleanupResponseReceived()` and then await `waitForRetirement()` before returning the isolated run. `catcherInstalled()` removes the temporary early listeners before the consumer's catcher tee takes over.

The host retains both actual documents through separate acknowledged cutoffs. `fileComplete` requires every expected case to start and pass, a passed framework result, complete requested trace capture, final execution and cleanup ACKs, and confirmed owned cleanup with no host failures. Only a complete selected file exits 4, and it still has `rootBrowserSuiteComplete: false`. Failed, interrupted, skipped, todo, or missing cases and reporting, binding, timeout, or unconfirmed cleanup failures leave `fileComplete: false` and exit 2. `createFrameworkControl` is only for owned loopback HTTP controls and grants no native credit. The existing reporter-controls job discovers the focused `framework-` DOM controls; the installed-package gate runs the real SDK fake separately. Neither proves Safari or the consumer's original tests.

Framework results add up to 128 `commandFailures`, retaining the first failures. Each records
the direct or attached client, queue operation and phase when known, safe method and route,
host monotonic dispatch-boundary and failure-observation times, response stage, status, and
abort source. Direct routes replace the session identifier with `:session`. Unknown routes
are null. Attached request hooks provide no URL or headers/body split, so those facts remain
null or `unknown`. Their original signal is reported as `caller`, not assumed to be an SDK
deadline. Times observe host boundaries, not native execution or wire completion.

Records contain no headers, bodies, script source, rejection text, or private identifiers.
Transport faults retain their original rejection identity and use a fixed diagnostic message
without inspecting the rejection. These facts do not establish a native cause.

### Framework reporting admission and failure

Snapshot factories run immediately after Waffle reserves one of the same 64 outbox slots.
A null case-settlement snapshot releases its slot without a record. Conversion and encoding
reentry fails explicitly. Waffle snapshots the complete logical report once, then commits its
sequence. Reports above the unchanged 48 KiB UTF-8 envelope limit travel in bounded chunks on
`/report`, without shortening assertions. Intermediate ACKs confirm chunk offsets but do not
advance the event watermark. Only complete, validated reassembly applies the event and advances
its ACK once. Retries compare the exact saved text, including after the final ACK is lost.

One logical report is limited to 4 MiB of UTF-8, queued reports share an 8 MiB byte budget, and
collectors reserve at most 8 MiB for incomplete reports. Each collector document retains at most
32 MiB of original report text for replay. Budget exhaustion fails reporting explicitly; it does
not truncate data or invent later records. Cancellation releases incomplete assemblies. The
original retry deadline covers the whole logical report, not a fresh deadline per chunk. These
limits bound Waffle's reporting data, not the framework's own RPC promise list or other output.

Admission failure closes `observation.signal` and refuses further conversion. Already admitted
healthy records can still drain under their original budgets. The existing single-flight
heartbeat carries one sticky failure category independently of report ACKs and provider roots.
Both ordinary and framework collectors return tagged live or cancelled control replies. Host
cancellation or document invalidation can end delivery, leaving admitted but unacknowledged
records incomplete. Abort does not release a slot until actual transport and ACK parsing settle.
Collector acceptance, page ACK, cleanup and both actual document cutoffs remain separate facts.

The CPU controls in `reporting-contract.test.ts`, `framework-reporting.test.ts`,
`large-reporting.test.ts`, `report-chunks.test.ts` and `reporting-host.test.ts` exercise the actual reporter, bootstrap accessor, collector and host.
Their isolated CPU realm is not an installed Vitest runner or browser qualification. A consumer
must also qualify its exact official patch with real installed synthetic cases before native use.

## Observe page Workers and requests

A host-driven `SuiteCase` can declare `observation: "workers-and-requests"` before navigation. Its `HostCase.workers()` returns the current dedicated-Worker set with stable host object identity. `HostCase.onRequest(callback)` passes actual request URLs to the callback in receive order, including repeated URLs and redirect hops. Registration replays the exact case's buffered startup window, then delivers live events. Its returned function revokes callback delivery, waits for all callbacks already invoked and rejects if any callback failed, even before unsubscribe. Observer shutdown joins that retirement before protocol detach. Callback drain is local settlement, not a browser-wide event flush.

The existing driver remains the only session, page action, navigation and window owner. Native observation requires `WAFFLE_SAFARI_INSPECTOR_ENDPOINT` to name a fresh JSON receipt from the existing read-only endpoint helper for the exact selected Simulator. Set `WAFFLE_SAFARI_INSPECTOR_HELPER` to the absolute path of that existing helper binary. Waffle invokes its bounded read-only `discover --udid <selected UUID> --deadline-ms 5000` command at endpoint acceptance, validates both complete receipts, compares boot session, process generation, executable, argv device binding and socket identity, then checks the current socket node and UID. Missing, unavailable or refused live checks fail admission. Waffle neither scans private browser files nor installs a helper. Missing input, ambiguous ownership, refused domains, lost framing, target replacement, missing navigation notification at actual driver completion, callback errors and overflow fail the case. The host does not wait for a desired event before publishing driver completion.

Descriptor aliases may change between complete discoveries during SafariDriver startup.
Their count is diagnostic metadata, while each discovery must still validate one socket
group and its stable descriptor set twice. Cross-receipt socket binding retains the path,
address length and pathname node UID, device and inode checks.

Safari observation is not yet qualified. This source implementation uses a subordinate connection attached to a same-origin inert document owned by SafariDriver. It enables Worker and Network before the original navigation and promptly owns every `Worker.initialized` startup continuation. It uses no target pause controller, Automation, cache mutation, constructor or runtime counters, or Inspector application execution. The one read-only Inspector expression confirms bootstrap identity. Installed request coverage, cache semantics, worker-fetch visibility and delivery ordering against WebDriver remain facts for real execution, not claims from CPU controls. A missing event is not repaired by a no-op, metadata poll, receive drain or sleep.
