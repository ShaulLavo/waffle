# Filesystem startup observation

`createRuntime({ onStartupStage(stage, timestamp) {} })` optionally reports the initial
filesystem worker's startup. `RuntimeStartupStage` and `RuntimeStartupObserver` are
exported from `waffle` and `waffle/runtime`. The callback receives only a fixed stage
string and a number: no database names, paths, identities, or filesystem contents.
Waffle keeps no event history. Consumers should bound any history they retain.

Timestamps are milliseconds computed as `performance.timeOrigin + performance.now()`
in the realm where the milestone occurs. Worker timestamps are forwarded unchanged,
not replaced with page receipt times. This puts page and worker events on the same
time origin for comparison; message delivery can lag behind the recorded milestone.

| Stage | Emission point |
| --- | --- |
| `filesystem-worker-created` | Page: immediately after the filesystem `Worker` constructor returns. This does not mean its script has loaded. |
| `filesystem-connect-requested` | Page: immediately before posting the initial filesystem connection to that worker. |
| `filesystem-connected` | Worker: handling the initial connection request in the existing startup microtask, immediately before invoking the backend factory. This is connection handling, not backend readiness. |
| `indexeddb-open-requested` | Worker: immediately before starting the existing IndexedDB database-open operation. |
| `indexeddb-open-resolved` | Worker: after the existing database-open promise resolves, before requesting its writer lock. |
| `filesystem-lock-requested` | Worker: immediately before the existing Web Locks writer request. |
| `filesystem-lock-acquired` | Worker: in the granted writer callback, before epoch allocation (IndexedDB) or storage setup (OPFS). A refused OPFS lock does not emit this stage. |
| `filesystem-epoch-requested` | Worker: immediately before creating the existing strict IndexedDB epoch-allocation transaction. |
| `filesystem-epoch-resolved` | Worker: after that transaction's existing completion wait resolves. |
| `filesystem-ready` | Worker: after the backend factory has finished (including persistent-tree recovery) and the initial `FilesystemService.connect` has returned. This is not facade construction or shell/application readiness. |

For IndexedDB, successful startup emits the table's order. In-memory startup emits
only the first three stages and `filesystem-ready`. OPFS also emits the two lock
stages, but no IndexedDB-open or epoch stages. A failure or hang leaves the sequence
at the last milestone reached; completion stages are never synthesized for failures.
Later filesystem identities, forks and connections emit no startup milestones.

Observation does not add an initialization wait, storage operation, retry, timeout,
service owner, or readiness promise. Callbacks are invoked synchronously at their
milestones but never awaited; throws and rejected promise-like returns are ignored.
Observers must not reenter runtime control. Slow synchronous callbacks can delay the
emitting realm, so keep them small. Installing an observer opts the initial worker
connection into fixed-stage diagnostic messages. Without one there are no diagnostic
clock reads, messages, event objects or history allocations. The page validates worker
stage names and finite numeric timestamps before delivering the two scalar arguments.

This is measurement, not a fix for startup stalls. Application leases, shell worker
creation and shell readiness belong in the embedding application's own instrumentation.
