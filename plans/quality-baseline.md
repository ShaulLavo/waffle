# Remove the remaining duplicate baseline

Status: Approved. Owned by runtime quality work, completed incrementally when the listed code changes.

## Remaining clones

The shared-memory integration removed 12 obsolete fingerprints without adding any. The remaining 13 entries are existing regression-fixture setup or the shared checkpoint-cleanup flow in IndexedDB and OPFS. Each retained fingerprint points here rather than silently becoming a permanent exception.

Run `bun run --cwd packages/waffle duplicates` for current locations. Paths below are relative to `packages/waffle`; line numbers are a snapshot. The shared-memory integration reported:

- `tests/browser-process-broker.test.ts:1011` and `tests/browser-process-broker.test.ts:1120`.
- `tests/browser-process-broker.test.ts:1018` and `tests/browser-process-broker.test.ts:1208`.
- `tests/browser-process-broker.test.ts:1421` and `tests/browser-process-broker.test.ts:2041`.
- `tests/browser-worker.test.ts:35` and `tests/child-diagnostic-browser.ts:6`.
- `tests/indexeddb-storage-browser.ts:973` and `tests/indexeddb-storage-browser.ts:1032`.
- `tests/persistence.test.ts:374` and `tests/persistence.test.ts:471`.
- `tests/pipes.test.ts:747` and `tests/pipes.test.ts:1050`.
- `tests/pipes.test.ts:747` and `tests/pipes.test.ts:1077`.
- `tests/pipes.test.ts:1051` and `tests/pipes.test.ts:1078`.
- `tests/process-worker-ownership.test.ts:393` and `tests/process-worker-ownership.test.ts:479`.
- `tests/runtime-facade.test.ts:912` and `tests/runtime-facade.test.ts:1195`.
- `tests/worker-pipes.test.ts:356` and `tests/worker-pipes.test.ts:384`.
- `fs/indexeddb.ts:1058` and `fs/opfs.ts:449`.

Extract shared fixture construction without combining independent assertions. For the IndexedDB and OPFS pair, first compare transaction and failure behavior, then share only the common checkpoint bookkeeping. Do not hide differences behind flags merely to satisfy the duplicate check.

Run the affected unit tests and the storage browser matrix after the checkpoint change. Regenerate the baseline only after the check reports no new clones. Assert that its fingerprint set only shrinks, and retain a one-line reason for every entry left. Do not raise the duplicate allowance.
