# Handle asset and worker startup failures

Keep load-failure recovery in the embedding app. Waffle never navigates the page,
replays commands, or retries external effects after a load failure.

## Keep deployed assets available

Publish content-addressed chunks and worker entries before publishing the page that
references them. Retain the complete immutable asset set while live pages can still
reference it. Include lazy process and network chunks, worker dependencies, and Wasm
assets. Serve missing assets as errors, never as the application HTML fallback.

Use an atomic deployment and retain its assets through your live-page retention
window. A cache alone cannot retain a chunk the page has never requested. If you
remove an asset, an existing page's next lazy load can fail. These rules prevent
missing files. They do not require Waffle to support mixed runtime versions or
negotiate an older protocol.

## Observe failures before starting work

Install the consumer's failure UI and listeners before requesting a service or
spawning a worker. Use the existing error paths:

- Catch rejection of `runtime.processes()`, `runtime.network()`, or an explicit
  dynamic import at that load boundary. Record the service or resource and retain
  the original error. A rejection identifies the failed operation, not necessarily
  a missing deployment asset. Initialization can fail for other reasons too.
- Supply `filesystem.onStateChange` in `createRuntime()` options to observe
  filesystem startup failures, including a worker that never evaluates. A failure
  remains `status: "failed"` with its error. See [startup observation](runtime-startup.md).
- For a consumer-owned worker, attach its native `error` listener immediately after
  construction, before posting startup messages. Remove the entry listener only
  after your actual readiness acknowledgement. A missing entry cannot send its own
  diagnostic. BroadcastChannel messages sent before subscription are lost.
- Keep ordinary guest exits, program diagnostics, and runtime execution errors in
  their existing process paths. Do not identify asset failures by matching arbitrary
  error text or treating every nonzero guest exit as a load failure.

The [executable consumer example](examples/asset-load-recovery.ts) supplies
`createLoadRecovery` and `observeWorkerEntry`. It is application code to copy and
adapt, not a runtime API. `load()` reports a lazy-service rejection and rethrows the
same cause. `report()` displays the first failure once. Neither starts recovery.
`observeWorkerEntry()` returns a listener-removal function; the consumer still owns
worker readiness, termination, and lifetime.

## Preserve work before an explicit reload

Wire `reload()` to an explicit user action after displaying the failed operation
and a copy or export action for unsaved work. The example has no automatic reload.

Implement its `preserve()` callback for your application. Stop edits and all writers
first, save editor buffers, then await `runtime.filesystem.flush()`. Keep writers
paused until navigation or explicit cancellation. Memory-backed files require a
separate durable save or export because flushing a memory backend cannot preserve
them across navigation. Acknowledged writes and `drain()` alone are not durable.
See [storage durability](storage.md).

If preservation or flush rejects, display that error, keep the page and runtime
alive, and leave unsaved content available for copying. Do not put navigation in a
`finally` block. If the filesystem worker itself failed, recovery may require
exporting editor buffers rather than flushing that worker. Never assume a failed
flush saved the data.

The example coalesces duplicate failures and reload requests. Its per-tab
`sessionStorage` guard permits one recovery navigation, including when the next
page remains broken. Reading, writing, or confirming the guard can fail; those
failures return `"blocked"` without navigation. The guard is written after
preservation succeeds and before navigation. Choose an application-specific key
when copying the example. Keep it through reloads; do not clear it during startup.
Closing the tab starts a new session. A rejected preservation attempt is not retried
by duplicate notifications in the same page.

If an application later enables automatic recovery, it must keep these preservation
and guard requirements and show any blocked or unsaved state. Never replay guest
commands, form submissions, or external effects on the new page.

## Run the controls

```sh
bun test packages/waffle/tests/asset-load-recovery.test.ts
bun packages/waffle/tests/asset-load-recovery-browser-runner.ts
```

The browser control packs Waffle, bundles an isolated consumer from that archive,
and changes the served asset set after page load. It checks a working lazy service,
then removes lazy chunks before their first use. Separate controls cover missing
and throwing worker entries, duplicate notifications, failed preservation with live
file contents, and a still-broken worker after one reload. Chromium runs this control
in the serial browser CI group. The runner owns its server, browser, and scratch.
