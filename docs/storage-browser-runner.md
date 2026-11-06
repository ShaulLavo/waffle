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

These controls test reporting failures, the original Worker timeout, document death,
and exact-name cleanup without deleting foreign-prefix storage. They do not count
as an iOS storage-suite run. The standard browser matrix and CI run these controls
on Chromium and WebKit. Unit and fake-driver controls run under `bun run test`.

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
