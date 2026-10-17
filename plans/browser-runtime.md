# Waffle browser runtime

Waffle is the page-owned browser runtime for WebAssembly guests. It provides one shared filesystem,
identity allocator, process admission service, worker bootstrap, preview routing and injected network
transport. Consumers create one `createRuntime()` owner and borrow capabilities for each run; a run
or shell never disposes the page runtime.

## Boundaries

Waffle owns `core/`, `fs/`, `proc/`, `interrupt/` and generic `browser/` services. A consumer owns
guest engines, native bindings, module caches, service-worker registration policy and application
adapters. Consumers pin one exact Waffle Git commit and use the matching package exports.

## Admission and cleanup

Source bytes are instrumented before execution. A compiled module requires explicit cooperative
admission. Process and filesystem identities are retained before worker launch. Revocation selects
a logical outcome immediately; physical termination follows filesystem quiescence and descriptor
cleanup. Disposal fences admitted consumers before closing the filesystem worker and releases the
stable duplicate-bundle ownership guard last.

### Codec-construction failure ownership

Status: **Approved**. Follow-up identified during the 2026-10-18 admission audit; this is not a
reproduction of the ordinary-parent-exit WebKit failure. The relevant baseline is
`b88b6ac1500c61c16411b479531f18df820e81e5`.

`WorkerProcessBroker.spawn()` constructs its descriptor codec before the admission cleanup scope
(`proc/worker-broker.ts:154` at the baseline above, the `this.codec(transport)` call). Browser
codec construction calls `BrowserProcessBroker.filesystem()` (`browser/process-broker.ts:246–253`
at that baseline), which throws `TypeError: runtime process has no filesystem identity` when a
transfer has missing or malformed filesystem metadata. The browser's external rejection cleanup
also constructs this codec before discarding tokens (`browser/process-broker.ts:296–300`). Source inspection shows
that a factory exception can leave a synchronously accepted child with no supervisor record,
no terminal outcome, no confirmation, and retained descriptor tokens. A normal, valid transfer
has not been shown to take this path; no original WebKit root cause is claimed.

Execute the bounded regression in `tests/browser-process-broker.test.ts`: use its existing root,
pipe and `WorkerProcessClient` setup, export a valid child writer, then remove the posted child
transport's filesystem metadata before calling `runtimeMessage`. Bound the rejection wait, and
check the child confirmation word, shared job-pending count, token lifetime and reader readiness.
The suspected failure is confirmation `0`, pending count greater than `0` and an open token
lifetime after the factory rejects; the test still needs to be executed and measured. Install
teardown first and retain the original working codec to discard the test's exported tokens even
when admission cannot construct one. Run the regression with
`bun test tests/browser-process-broker.test.ts --test-name-pattern 'codec construction'`, then
`bun run check && bun test && bun run size` after the fix.

Define who can release every accepted token when codec construction itself fails, including
externally rejected and foreign-directory transfers. Do not publish confirmation until token
cleanup and the filesystem fence succeed, and never discard an already-admitted duplicate's
aliased lifetime. This needs an explicit cleanup capability or equivalent codec contract, not
an outcome-only catch or premature confirmation. Keep ordinary parent exit, accepted-writer
retention and stable-generation EOF unchanged.

### Rejected duplicates during queued admission

Status: **Approved**. A separate pre-existing edge case at the same baseline concerns duplicate
messages, not the no-duplicate WebKit failure. `browser/process-broker.ts:291–295` protects a
registered identity, but `proc/worker-broker.ts:118–127` initially queues admission without adding
that identity to `transports`. A synchronous external rejection of the same transfer can therefore
select SIGKILL and discard the accepted transfer's aliased tokens before its queued admission runs.

Add a bounded regression using the same ownership fixture and this ordering, with no intervening
await: `const accepted = broker.runtimeMessage(spawnMessage, parentPid);`
`broker.rejectRuntimeMessage(spawnMessage, parentPid); await accepted;`. Inspect the child's outcome,
token lifetime, reader readiness and launch count; the suspected result is preselected SIGKILL,
a discarded accepted writer and no launch. This ordering is established by source inspection;
the bounded runtime regression remains to be executed. Run it with
`bun test tests/browser-process-broker.test.ts --test-name-pattern 'queued duplicate'`. Register
cleanup before setup and release any module/activation gate in teardown.

Define synchronously queued ownership by PID **and** shared directory, separately from fully
admitted records. A repeated delivery owns no additional token lifetime and must not discard the
first delivery's resources. Prove rejected foreign directories remain isolated, genuine rejected
transfers still clean up, and disposal releases queued ownership on every outcome. Do not broaden
this into a parent-liveness check or weaken accepted-child writer retention.

## Storage and networking

The shared filesystem supports memory, IndexedDB and OPFS backends behind the same capability
protocol. The network helper receives an injected `fetch` implementation and sends framed responses
through shared rings. Preview URL routing and service-worker scope remain consumer choices.

## Verification

The standalone gates run package install and `prepare`, TypeScript checking, unit tests, installed
Node exports, generic browser storage/process acceptance, and the unchanged 7,168-byte gzip core
budget. Generated `dist/` output is ignored and must never be committed.
