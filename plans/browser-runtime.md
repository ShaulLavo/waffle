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

## Storage and networking

The shared filesystem supports memory, IndexedDB and OPFS backends behind the same capability
protocol. The network helper receives an injected `fetch` implementation and sends framed responses
through shared rings. Preview URL routing and service-worker scope remain consumer choices.

## Verification

The standalone gates run package install and `prepare`, TypeScript checking, unit tests, installed
Node exports, generic browser storage/process acceptance, and the unchanged 7,168-byte gzip core
budget. Generated `dist/` output is ignored and must never be committed.
