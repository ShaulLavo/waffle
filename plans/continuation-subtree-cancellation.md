# Retire work admitted by a cancelled continuation

Status: Approved tracking item, scheduled later. No implementation is active. Waffle owns
this future capability and its release. Safari memory owns the consumer design and later
package-continuation qualification. Managing requested this entry on 2026-11-14. Fold it into
the next Waffle PR; do not open a standalone documentation PR.

## Current behavior decision

Managing explicitly retained documented legacy PID-only KILL semantics for bun-wasm PR 792.
The replacement continuation preserves the old loop's behavior: an already admitted phase
can remain live after caller-only KILL, under Waffle's ordinary process ownership. Stronger
descendant cancellation is outside that replacement feature's scope. This item must not block
PR 792, its consumer qualification under that decision, or any release.

The evidence report predates this disposition and still presents the choice as pending. Its
conditional recommendation does not override this later decision. Keep its original results
and R3 history intact. The future behavior below requires an explicit behavior decision and
reviewed design before implementation. Tracking it does not change the released contract.

## Future cancellation contract

The future capability would let caller-only KILL retire all work first admitted by that
continuation generation.
Use a generation-bound reservation-provenance scope with an authoritative native and
filesystem retirement fence. Preserve job identities, unrelated same-job siblings, and
children admitted before the continuation opened its scope.

This is a new lifetime contract, not a demonstrated regression. Released 0.0.130 and 0.0.131
both leave an admitted phase executing after caller-only KILL. Current PID-only cancellation
keeps that child runtime-owned, with its real handle and filesystem identity. Logical exit,
physical native return, sampled worker rows, and physical memory reclamation are distinct.

Receive Safari memory's design before any future implementation. The report's `ownership-signatures.ts`
is an unapplied API sketch, unavailable in the released packages. Its names do not establish
the public API. A new cross-repository contract requires design and independent review through
the normal Waffle workflow.

## Ownership and ordering constraints

- Open the scope synchronously for the exact caller incarnation and continuation generation.
  Stamp membership through Waffle's reservation authority before module resolution or an
  asynchronous admission notice. Guest-supplied worker metadata cannot forge membership.
- Inherit membership across descendants, exec, phase exit, and reap. Cover an earlier phase's
  background descendants. The design must explicitly include jobs created by scoped members
  without changing those jobs' identities or ordinary signal routing.
- Seal admission synchronously before cancellation callbacks. Reject later reservations and
  invalidate in-flight admission from every member, including late resource acquisition.
  Preserve already selected typed outcomes and the existing first-winner arbitration.
- Keep the owner outside its child scope. Its revocation hook aborts local work and requests
  cancellation synchronously. The adapter's `terminate()` joins local work and its own
  filesystem client, without awaiting the child scope or its own job becoming empty.
- Waffle's outer retirement owner starts child cleanup independently, then joins the scope
  after the adapter's own physical/local stop returns. Join captured reservations, transports,
  image/native handles across exec, controllers, and admitted filesystem sections.
- Preserve distinct cleanup failures and still-live ownership. Do not turn a timeout, removed
  observation row, or empty mock handle into cleanup success.
- Disarm on ordinary success or ordinary nonzero script completion before publishing the
  owner's result. Ignored signals do not close the scope. Fatal owner revocation or explicit
  adapter cancellation closes an armed scope. Preserve caller-only versus job-wide signals;
  never substitute `killJob`, a new `caller-fatal` phase job, or numeric-status signal inference.

## Evidence and source entry points

The retained owner report is
`/work/reports/goals/safari-memory/package-phase-retirement/RESULT.md`.
Beside it are `controls.test.ts`, `worker.ts`, `bun-worker.ts`, `run.sh`,
`ownership-signatures.ts`, four `controls-{130,131}-{1,2}.log` files,
`archive-checksums.txt`, and `cleanup-verified.json`. Safari memory owns their retention.

Five controls passed twice on each released package, 31 assertions per selection. They cover
the real Runtime and Worker, joined-job INVAL/28, reservation before delayed admission notice,
the installed QuickJS continuation, and its forced-old-loop arm. The real guest prints a
fresh filesystem nonce written after the caller's signaled-9 result. This proves continued
execution rather than queued output. The exact held phase is then killed during teardown;
that cleanup is not automatic cancellation success. Native-return observation remains held
until the real terminate call returns. The unrelated root-started sibling stays live.

The consumer snapshot is bun-wasm PR 792 commit
`f7cfd689e114221841e3c4cc2ec04a21c73c5de8`. Bash source is
`e6d29598eb0111f16bc3068ad52a9167dac51da7`, not a relabelled release tag. Runtime source is
0.0.130 `b6ce9c22e4032637814a3985fab934915be02bcc` and
0.0.131 `5515535c372ea4b7c93bd90ceda3cf4756ef9373`. Their relevant production sources are
unchanged. Original R3 failures remain under the Safari memory report root in
`pr792-review/RESULT.md` and `package-script-enabled/`.

At Waffle baseline `12d5dbc53099b55df94c34ace7a17869a03c691b`, begin with
`proc/worker-client.ts`, `proc/worker-broker.ts`, `proc/directory.ts`, `proc/supervisor.ts`,
`proc/table.ts`, `proc/types.ts`, and `browser/process-broker.ts`, all under `packages/waffle/`.
Existing job cleanup covers whole jobs; the borrowed Supervisor omits private retirement
methods. Neither a parent-PID walk nor a private stopping promise supplies authoritative
scope membership and closure. Read `docs/concepts.md`, `docs/private-authority.md`, and
`docs/process-observation.md` before changing these contracts.

Use these read-only commands from a fresh exclusive Waffle checkout:

```sh
	git diff waffle-v0.0.130 waffle-v0.0.131 -- packages/waffle/browser packages/waffle/proc packages/waffle/fs packages/waffle/memory
	rg -n 'jobCleanupReady|registerOwnedJobCleanup|retireFencedProcesses|checkedJobLifetime' packages/waffle/proc packages/waffle/browser/process-broker.ts
	sed -n '1,240p' /work/reports/goals/safari-memory/package-phase-retirement/RESULT.md
	cat /work/reports/goals/safari-memory/package-phase-retirement/ownership-signatures.ts
```

## Historical reproducer and prerequisites

The executed command was the following. It is retained for reproduction, not commissioned
by this plan entry.

```sh
	cd /work/worktrees/bun-wasm/t3-6fd0f910
	source env.sh
	bun /work/heavy-runner/current/run.js --host local --class light package-phase-retirement-controls -- bash /work/reports/goals/safari-memory/package-phase-retirement/run.sh
```

`run.sh` hard-codes that checkout and sources its `env.sh`; there is no report-local
`env.sh`. `controls.test.ts` reads the existing producer payload at
`/work/worktrees/bun-wasm/t3-df0aa989/dist`. Before a future run, confirm those inputs and
their current retention owner with Safari memory. If retired, retarget a copy of the report
runner and controls to a fresh exact-source checkout and an explicitly retained producer.
Do not infer availability from this historical command or use different guest bytes silently.

The report records these producer hashes, which future setup must verify:

- QuickJS core: `f401c3ddc8082fd05edbc2c4164bd6d28b4759ffd67a3cbf635ab4966264dc18`.
- QuickJS side: `fc9aa193c9ac8d4a159358408f12250559587ae8d45604b16d18ea76ee9884f2`.
- Bash: `378729ae7717235e82cba6c4282240fddbd24be9e163c868c6ac1e6be0b223a1`.

The runner downloads released runtime archives, verifies hashes against the existing release
readbacks, exports immutable consumer/shell source snapshots, and installs teardown before
setup. It creates no producer build. Preserve that cleanup on success, failure, and interruption.
The original control has a generous 120-second hang cap, records duration, and asserts outcomes.

## Implementation acceptance after design approval

Add deterministic controls for reservation-before-notice, held module and handle acquisition,
descendant spawn during cancellation, reentrant stop, and an earlier phase's background child.
Keep positive controls for the unrelated same-job sibling and a preexisting old-generation
caller child. Cover descendants that create independent jobs, exec, ordinary-exit disarming,
caught and ignored signals, job-wide signals, first-winner outcomes, and distinct cleanup
rejection. Assert physical retirement through the explicit scope/native fence and filesystem
fence, rather than `waitForExit` or sampled memory rows. Repeat short changed tests two or
three times and use generous hang caps without speed assertions.

After independent review, green CI, and a normal Waffle release, Safari memory can connect
one scope to `PackageChildren`'s existing admission path and add an installed regression.
It must register cancellation before its first await and keep local `terminate()` free of
the scope join. Consumer engine qualification stays with Safari memory. These are acceptance
requirements for a separately approved future behavior change, not prerequisites for PR 792
or a release. This entry claims no deep-subtree implementation or physical memory reclamation.
