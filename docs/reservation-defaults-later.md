# Right-size shared-memory defaults

Status: Approved, scheduled later. This plan is separate from removing throwaway allocations. Do not tune the remaining global defaults until the matched measurements below establish the required capacity on all four platforms.

## Audit baseline

The source audit used commit `5ffb379b14e129e6505b499d91aa743cd80b3d38`, tree `c316550233e37d6de63c212f6944f4ee0a98cc47`, on October 31, 2026. Paths and line numbers below refer to that commit. Use symbol names when lines move.

| Allocation               | Exact source                                                                                                                                                                                 |                                                                        Initial bytes |                                                         Declared maximum or capacity | Multiplicity                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------------------------------------------------------------------------: | -----------------------------------------------------------------------------------: | ------------------------------------------------------------ |
| Filesystem request arena | `packages/waffle/fs/request-memory.ts`, `FILESYSTEM_REQUEST_LIMITS.connectionBytes`, lines 30-36, `createRequestArenaData`, lines 315-322, and `FilesystemRequestPool.create`, lines 378-403 |                                                        0 data, plus 64 control bytes |            2,147,479,552 data bytes, with a 67,108,864-byte retry after `RangeError` | One per connection at the pool's concurrency high-water mark |
| Filesystem data pool     | `packages/waffle/fs/shared-capacity.ts`, `DEFAULT_SHARED_MAX_BYTES`, and `packages/waffle/fs/protocol.ts`, `createFilesystemIdentity`, lines 141-151                                         | One 16,777,216-byte segment embedded in the fixed root, plus 95 zero-length segments | 1,610,612,736 total data capacity. The 95 extra segments declare 1,593,835,520 bytes | One pool per runtime, shared by every identity               |
| Fixed filesystem root    | `packages/waffle/fs/protocol.ts`, `CONNECTION_SHARED_BYTES`, line 70, and `createFilesystemIdentity`, lines 166-167                                                                          |                                                                           67,108,864 |                                                                     67,108,864 bytes | One per ordinary runtime                                     |
| Shared memory group      | `packages/waffle/group/state.ts`, `defaultMemoryGroupPolicy`, lines 37-47, and `MemoryGroupOwner` constructor, line 205. `MAX_GROUP_PAGES` is in `group/protocol.ts`                         |                                                                               65,536 |                                                 65,536 pages, or 4,294,967,296 bytes | One per live group, up to 64 groups by default               |
| Pipe cursor registry     | `packages/waffle/proc/pipes.ts`, `PipePublicationRegistry`, lines 167-193                                                                                                                    |                                                      2,105,360 at the audit baseline |               268,443,664 bytes, including 16,777,216 permanent 16-byte cursor cells | One per root process tree                                    |

## Accepted NOW changes

Worker backend construction borrows the root already present in the first `connect` message. It no longer creates the 62,341,840-byte temporary root from `fs/shared.ts`, `BUFFER_SIZE`, before attaching the real root. Standalone construction and startup-admitted roots keep their existing behavior. Persistent recovery completes before publication attaches, as before.

The default pipe limit is now `1 << 20` permanent cursor cells, down from `1 << 24`. The default declaration falls from 268,443,664 to 16,785,424 bytes. Its 2,105,360-byte initial backing is unchanged. This is an accepted 16-fold reduction in default lifetime cell capacity on every platform, including desktop, not an unchanged-capacity optimization. Explicit `maxCells` options still support up to `1 << 24`, and exhaustion still returns `NFILE`. Cursor cells never recycle. Do not equate the cell count with a fixed number of pipes: endpoint rings and ownership determine cell use.

No additional large first-use deferral is included. Filesystem segments already appear in every identity before guest execution. Request arenas must exist before guests can write requests, and pipe registries enroll owners before descendants run. Delaying those allocations needs a publication or transport change. Memory groups are already created on demand. Workspace publication buffers support startup when the workspace is enabled.

Initial bytes are the buffer's length when constructed. A growable buffer's maximum is its declared reservation, not its current length. Multiplicity counts distinct backing stores, not wrappers or views of one store. Capacity is an admission contract, not observed demand.

Committed bytes are the current grown lengths. Resident bytes require engine or operating-system measurements. Neither equals declared reservation. The request namespace's 8 GiB quota and the memory group's 2 GiB backing budget charge grown bytes. They do not bound declared maxima.

The ordinary root and data segments remain referenced by the page, the filesystem worker, and guest connections. Runtime disposal drops ownership but does not prove that an engine has returned the address reservation. Request pools retain arenas for reuse and strand arenas with retirement errors. Retired controls remain in receipts. Memory groups retain backing until every member stops and the owner drops its references. Measure release rather than assuming that garbage collection has occurred.

## Execute the measurement pass

1. Check out the same reviewed source for each platform. Record the commit, tree, built-asset hashes, browser version, operating system, hardware, and test flags. Keep one source writer and retain the original audit table alongside the results.
2. Install cleanup before setup. Record pre-existing resources. Give each run its own browser profile, test processes, logs, and scratch. Keep shared caches and existing apps. Check cleanup on the execution host after every run.
3. Instrument allocation sites before creating a runtime. Record buffer kind, initial length, declared maximum, owner realm, stable backing identity, caller, and lifetime. Count aliases once. Capture failures and the selected request-arena fallback. Instrumentation must not retain buffers after their owners release them.
4. Run matched cases on Chromium, Firefox, desktop Safari, and iOS Safari. Treat desktop Safari as a separate platform, not an iOS proxy. Use both a fresh page and repeated runtime creation and disposal in one page.
5. Cover empty runtime startup, workspace startup, first spawn, concurrent spawns, shell pipelines, long sequential pipe workloads, fork and socket connections, large filesystem reads and writes, and memory-group creation and growth. Include representative Bun and shell consumers with unchanged guest binaries.
6. Capture per case the number of allocations, sum of declared maxima, current lengths, peak committed bytes, peak resident bytes where available, startup timing, request sizes, connection concurrency, file-pool growth, group demand, and failure site. Record reservations held after disposal and after physical worker termination. Separate observable ownership release from unobservable garbage collection.
7. Re-run existing ownership and capacity regressions on the candidate. Start with `bun test packages/waffle/tests/filesystem-request-memory.test.ts packages/waffle/tests/filesystem-capacity.test.ts packages/waffle/tests/process-pipe-recycling.test.ts`. Run the memory-group tests listed by `find packages/waffle/tests -name 'memory-group*.test.ts'`. Follow `docs/development.md` for preparation and the browser suites. Do not build new guest programs to compare runtime-only changes.
8. Save a before-and-after table for every platform with identical case inputs and repetitions. Reject a change that replaces `RangeError` with silent data loss, an unapproved loss of desktop capacity, stale cursor aliasing, broken cancellation, or stranded ownership.

## Implement only after the measurements

Choose request-arena maxima from measured message sizes and concurrency, including response retention and retirement-error cases. Preserve generation fencing and reuse rules. Decide separately whether a smaller initial choice, shared arena design, or page-wide reservation accounting is required. A quota on grown bytes is not a substitute.

Choose data-segment count and maximum from peak file demand and growth traces. A buffer already sent to another worker cannot have its maximum raised later. Any lazy segment design must publish the same permanent backing to every consumer before use. Do not reduce the pool's existing maximum as a shortcut.

Measure the fixed root's metadata and embedded data layout before changing its 64 MiB allocation. Preserve the node count, page-table capacity, watch offsets, identity words, and workspace-publication readers. Startup-admitted roots use the exact layout size, not the ordinary connection's rounded constant.

Choose memory-group limits from group workloads and per-engine results. Test concurrent members while the owner grows shared memory. Preserve page-zero exclusion, physical-stop debt, member admission, pins, watches, and committed-backing accounting. Do not infer an iOS result from desktop Safari.

The pipe registry's declared maximum is its lifetime cell capacity because raw cursor views never recycle. Any further reduction that preserves lifetime capacity needs a new shared-storage or publication design that keeps permanent cursor identity, owner enrollment, revocation races, cloned handles, atomic updates, and explicit `maxCells` exhaustion. Smaller initial backing alone does not reduce its declared maximum.

Finish with a reviewed source change and matched platform evidence. A lower calculated allocation count proves only that allocation change. Claim startup improvement only after a matched timing run, and claim iOS admission improvement only after an iOS run.
