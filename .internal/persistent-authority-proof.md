# Persistent authority four-page proof

This bounded Chromium scenario checks the private persistent authority against native
IndexedDB. It adds coverage, not a new filesystem or a stronger durability contract.
The existing two-page controls remain unchanged.

## Actual ownership and observation

`tests/persistent-authority-browser-runner.ts` opens four independent top-level pages
in one origin. Page A starts `createPersistentResidentOwner` through the existing
resident-authority fixture. The factory opens `PersistentBackend`, creates its real
root and service, and starts `ResidentAuthorityServer`. Each page attaches its own
workspace connection. No authority root or shared-memory buffer crosses pages.

Page B runs Preview 1 WASI exports and page D runs `runtime_proc` exports through the
existing guest fixture and real worker bootstrap. These are Wasm calls into the
production filesystem bindings, not a second implementation of the operations.
WASI workspace calls use the service path. Nonblocking `runtime_proc` calls use a
prepared private grant.

`tests/fixtures/persistent-authority-observer.ts` captures the factory root when it
activates the workspace. Read-only inspection runs inside that authority worker and
returns copied cuts, receipts, and effects. The observer never creates a replacement
service or hands its capability to a page.

## One fixed history

Each page opens its root once. The fixture has 16 operation slots, so repeated
unnecessary `preopen` mutations would consume receipt capacity rather than test the
intended interleaving.

After creating `/dir/a` with bytes `[10,20,30]` and a replacement target, the runner
records a baseline publication cut and executes this schedule:

1. Page A appends `41`. Page C reads the acknowledged bytes and size.
2. Page D's actual `runtime_proc` append acknowledges `42`. The runner omits its
   final settlement notification. Page C's current read imports the pending outcome.
   Two later settlement requests return the same receipt.
3. Page C renames `a` over `target`. Page A sees the complete replacement namespace.
4. Page B's actual WASI append adds `43` through its retained file. Page D's actual
   `runtime_proc` read sees the current six bytes.
5. Page A appends `[44,45]` with an explicit mutation identity, then submits that
   same identity again. Page C sees one append and the original receipt is unchanged.
6. Page B's actual WASI rename moves `target` to `final`. Other pages read the final
   bytes and see neither obsolete name.

The observer requires exactly six consecutive changed publications in one history,
with six distinct mutation identities. Every append includes its exact byte range,
size, and file metadata. Every rename includes both entry changes and the parent
metadata in one group. The replay adds no publication. All receipts still report
`durability: { kind: "untracked" }`.

## Flush, stop, and explicit reset

The runner completes the real service `flush`, inspects the native saved records,
joins both guest shutdowns, and stops all page clients. It then stops the actual
persistent owner. Native database-close observation must precede the final guard
release, and Playwright must observe the authority worker's native `close` event.
This is a drained stop followed by worker death, not an injected power failure.

Reopening the same database explicitly accepts the v1 reset contract. The runner
requires a new instance and history, a gap for the old cut, and an unknown old
mutation outcome before attaching new peers. It checks the complete notice:

```text
kind: v1-new-history
durablePublicationCut: untracked
oldCapabilities: not-restored
oldMutationOutcomes: not-restored
acknowledgedTail: may-be-lost
```

An old workspace descriptor must fail with errno 11. All four fresh peers then read
`/dir/final` as `[10,20,30,41,42,43,44,45]`, with `a` and `target` absent. The runner
stops the reopened owner, observes its worker death, and deletes its own database.

## Run the bounded check

Use an exclusive installed checkout and the host's canonical browser queue. Reuse
installed Playwright Chromium. On the PC:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
PERSISTENT_AUTHORITY_PORT=$port \
PERSISTENT_AUTHORITY_REPORT=/work/tmp/waffle-persistent-proof.json \
STORAGE_SCRATCH_ROOT=/work/tmp WAFFLE_BROWSER_TIMEOUT=180000 \
bun /work/platform-production/heavy/current/run.js --class browser waffle-persistent-proof -- \
  bun scripts/browser-supervisor.ts 1000 bun tests/persistent-authority-browser-runner.ts
```

The runner requires an explicit free port, bounds each of its 17 steps to 15 seconds,
and uses `BrowserRunnerLifecycle` plus the existing supervisor for teardown. Its JSON
ledger preserves completed, failed, and unrun steps. A failure stops the schedule;
there is no fresh retry inside the runner. Check actual-host processes, ports, and
scratch removal after execution, including after an expected failure.

For the negative control, add `--negative-control` to the runner command and choose
a separate report path. It intentionally uses a fresh identity for the second append.
The expected failure is the exact byte comparison after eight completed steps, with
one failed step and eight unrun. The extra `[44,45]` must be visible. This checks that
the exactly-once oracle detects a real duplicate; it is not a production regression.

## Limits

This proof does not cover freeze and resume, fencing a resumed stale owner, transparent
durable receipt continuity, last-client lifecycle certification, unexpected authority
loss, strict-commit FAST acknowledgments, SAFE, OPFS, or physical power cuts. Native
IndexedDB success here does not certify another engine or browser. A completed flush
preserves this saved snapshot, while the explicit v1 notice still permits an unflushed
acknowledged tail to be lost.
