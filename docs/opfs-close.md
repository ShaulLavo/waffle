# OPFS close ownership and proof limits

`OpfsStorage` retains every acquired sync-access original until physical close succeeds.
A throwing close keeps the original, its exact rejection reason, and the existing writer WebLock.
Terminal close attempts safe siblings but never retries the failed original or releases the writer lock.
Previously admitted work drains on ordinary close. Failed-close debt rejects queued work before it starts.

## Source regression controls

`tests/opfs-close.test.ts` exercises the production adapter with directory, access-handle,
and lock stand-ins. It covers cached and transient originals, eviction, in-flight sibling
acquisition, exact falsy reasons, promise identity, admission, and successful close.
Fixture force-close and force-release steps are cleanup interventions, not adapter success.

`tests/opfs-close-browser-observer.test.ts` executes the actual page and driver source
with labelled Worker and lifecycle stand-ins in isolated subprocesses. Late errors,
including `undefined` and `false`, survive the last request and prevent success.
Termination dispatch runs once. Every registered original gets an independent join result,
including after dispatch failure, timeout, or exhausted budget.

Run these non-browser controls from an installed checkout:

```sh
bun test tests/opfs-close.test.ts tests/opfs-close-browser-observer.test.ts
```

## Native execution remains held

The direct CLI `bun tests/opfs-close-browser-runner.ts` exits unsuccessfully before
starting an arm. No qualified outside controller yet proves the whole arm fits its
45-second allocation-through-descendant-cleanup limit. The local 25-second observation
cutoff, promise races, and lifecycle emergency timer cannot supply that proof.

The prepared native fixture distinguishes ordinary physical close from labelled
injection before physical close. Even a future successful injected arm would not prove
spontaneous platform failure, failed-open caller retention, or natural Worker retirement.
`observations-complete` is not native qualification. Explicit Worker termination and
same-profile recovery are post-intervention observations.

The fleet dispatcher already owns isolated jobs, process identities, cancellation,
and task-path teardown. Its timeout includes staging and queue time, with separate
cleanup allowances. Setting that timeout to 45 seconds would not create an arm-specific
proof. A qualifying controller must start before the arm's first allocation, survive
a blocked driver, and independently record driver exit, descendant stop and joins,
owned-domain and endpoint absence, and task-storage deletion by that same deadline.
Missing receipts or cleanup after the deadline invalidate the sample.

No native arm or new controller is part of this integration. Shared lifecycle helpers
remain unchanged. Source success does not establish native handle lifetime, browser
lock retention, storage-mode qualification, crash durability, or caller shutdown behavior.
