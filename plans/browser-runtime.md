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

Status: **Implemented, awaiting review**. Reproduced on 2026-10-21 against main
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

Status: **Implemented, awaiting review**. The same baseline reproduced synchronous
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

## Storage and networking

The shared filesystem supports memory, IndexedDB and OPFS backends behind the same capability
protocol. The network helper receives an injected `fetch` implementation and sends framed responses
through shared rings. Preview URL routing and service-worker scope remain consumer choices.

## Verification

The standalone gates run package install and `prepare`, TypeScript checking, unit tests, installed
Node exports, generic browser storage/process acceptance, and the gzip core budget declared in
`tooling/runtime-size.ts`. Generated `dist/` output is ignored and must never be committed.
