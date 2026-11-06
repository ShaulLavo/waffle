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
