# Waffle source provenance

Waffle owns the reusable browser runtime extracted from bun-wasm. This ledger records copied or adapted implementation that ships in this repository; Bun engine, guest, native binding and application adapter provenance remains in bun-wasm.

| Source | Class | Revision and local change |
| --- | --- | --- |
| `core/`, `fs/`, `proc/`, `interrupt/` | Original adapter | Browser/WASI runtime services developed in bun-wasm through the frozen extraction revision. The current tree is TypeScript source; `dist/` is generated during `prepare` and is never tracked. |
| `browser/net/` | Original adapter | Generic ring, HTTP framing, fetch and host transport. Fetch and listener policy are injected by the consumer; Bun install/cache policy is not part of Waffle. |
| `browser/process-broker.ts`, `browser/worker.ts` | Original adapter | Generic process admission, descriptor transport, worker bootstrap and lifecycle fences. Guest engines and native slots remain application-owned. |
| `fs/opfs.ts` | Adaptation | Adapts SLICC-kernel `src/fs/opfs.ts` at revision `88c5bb3` (Apache-2.0) for browser access-handle retries and quota mapping while retaining Waffle's checksummed snapshots, lazy index and bounded cache. The applicable Apache-2.0 notice is retained here. |
| `core/memory-views.js` | Original adapter | Resizable-memory view helpers retained as source JavaScript because the runtime ABI requires their exact view identity. |

## SLICC-kernel Apache-2.0 notice

The OPFS access-handle adaptation is based on SLICC-kernel, revision `88c5bb3`, licensed under the Apache License, Version 2.0. The adaptation is distributed under that license's notice and attribution requirements. No SLICC source is generated at build time.

## Extraction provenance

The history-preserving filter-repo commit map is kept outside the published tree with the cutover evidence. The extracted repository retains the rewritten commit history, including predecessor paths for the WASI shim, filesystem scaffold and memory views.
