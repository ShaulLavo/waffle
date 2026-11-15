# Replace a sole-member shared caller with a host continuation

Status: Approved future design, independently reviewed on 2026-11-15. Implementation is not
commissioned. Waffle owns the provider contract and release; Safari memory owns the matching
trusted consumer binding and later qualification. Fold this entry into the next Waffle PR.
It creates no hold on bun-wasm PR 792, releases, pins, or engine qualification. R3's stronger
subtree cancellation remains a separate item. Legacy caller-only KILL remains PID-only.

## Decision and released behavior

The narrow transition is supportable with reviewed future owner contracts under the current
guest exec ABI. It is unsupported on Waffle 0.0.130 and 0.0.131 today. Keep the shared
package caller's existing pre/main/post loop until provider and consumer changes are proved.
A direct command avoids the waiting caller but is not an equivalent package-script route.

Three independent barriers exist. The consumer rejects `request.memoryGroup`, reads only an
exported memory although group PIE imports its memory, and Waffle's authoritative `canExec`
rejects group and threaded source images. The documented NOTSUP is intentional. Removing a
consumer check, clearing a request field, or flipping a provider boolean is insufficient.

The full decision and executable evidence are retained at
`/work/reports/goals/waffle-20261115/shared-caller-host-exec/` in `DESIGN.md`, `REVIEW.md`,
`run-control.sh`, `control.ts`, `control-worker.ts`, `results.json`, and both final logs.
The source assessment is
`/work/reports/goals/safari-memory/package-continuation-shared-scope/RESULT.md`.

Production references use Waffle .130 `b6ce9c22e4032637814a3985fab934915be02bcc`.
The inspected .131 production sources are identical. Consumer references use bun-wasm PR 792
`490ab2b1c5f78fb26caaa705d266f80369c6b34b`, not a moving branch. This decision claims no
successful shared-source exec, Safari allocation repair, GC, or physical backing reclamation.

## Required owner contracts

The resolved successor needs an immutable owner-held host-only launch capability, bound to
the exact program and adapter registration. Resolution must retain that capability through
commit, source stop, and launch. The current registry has a module and opaque adapter string;
Runtime looks up the launcher later. An empty module, familiar executable path, adapter-name
whitelist, or replaced registration cannot prove host-only behavior. No new public signature
is specified here. The future classified image must be unable to launch its own Worker, join
a group, or enter the typed-thread path, while retaining ordinary phase-child spawn.

Source eligibility must be authoritative and atomic. Admit only the exact current non-root
owned Worker image and member incarnation. Account for reserved, retained, and pending group
members, queued transports, earlier source/descendant admission, opaque adapter acquisitions,
and explicit-handle joins. All join paths must consult one owner closing state. A counter
snapshot with one member is not permission. Conservatively refuse when an unresolved intent
could still join this group; preserve earlier reservations rather than cancelling them or
forcing a new group. An unrelated live child in another established group is not a blocker.

After target resolution, recheck source, target, and fatal identity before any signal mutation.
Test sole membership and close new group admissions in one synchronous, non-reentrant owner
transition. Do not freeze admission across asynchronous target lookup and later resume a
rejected caller. Carry the owner token through the existing replacement transaction. A
precommit failure releases only new staging and leaves the source usable. After commit the
source cannot resume; canonical fatal outcomes, late acquisitions, and cleanup failures
retain their existing owners and debt.

## Preserve the existing lifetime and authority

Old-image filesystem/controller quiescence, actual native stop, controller stop, and adapter
cleanup must all succeed before member release and successor entry. A `replaced` message,
logical row, or timeout is not native return. The owner token grants no early release.
Surviving, reserved, or retained members defeat this narrow sole-member branch. Group-owned
pins and publications stay with that group until ordinary end, and cannot transfer by PID.

Preserve PID, parent, root, job, children, waiters, canonical outcome, and observation lifetime.
Only image generation increments. Transfer the original live root and the admitted descriptor
census with rights, shared offsets, flags, pipes, and preopen metadata. Do not reopen `/`,
widen rights, create an EOF gap, or change an admitted child's independent filesystem lifetime.
Do not reparent phases, change jobs, add a controller, or introduce a cyclic child/job stop join.

Preserve HANDLE reset, IGNORE, default actions, pending fatal outcomes, and first-winner
selection through lookup, commit, stop, and target acquisition. The package binding still
rejects caught-handler and filesystem-publication cases until separately proved. Numeric
exit 137 or 143 is not a signal. Caller-only KILL may leave admitted children running under
the accepted legacy contract. Job-wide signals retain their existing single delivery owner.
The consumer must use the trusted executor's actual bound imported memory privately; it must
not manufacture an export or expose group/process authority to the guest.

## Executable boundary and future acceptance

Two unchanged .130 controls passed expected precommit NOTSUP `-58`. They use a real public
Runtime, filesystem Worker, and sole-member imported-memory PIE with no memory export. The
trusted executor invokes the real bootstrap-supplied exec ABI after PIE entry. The registered
held host target never enters, transport generation remains 1, and the source reads a real
filesystem file after refusal. The group stays live until source exit 0; final observation is
`terminated`, the group disappears, and both real Workers return. These are rejection controls,
not proof of the future success path or a literal Wasm exec-import instruction.

The retained reader accepts a stable Git object source after worktree retirement:

```sh
	bash /work/reports/goals/waffle-20261115/shared-caller-host-exec/run-control.sh /work/projects/waffle --verify-source
	bun /work/heavy-runner/current/run.js --host local --class light shared-host-exec-control -- bash /work/reports/goals/waffle-20261115/shared-caller-host-exec/run-control.sh /work/projects/waffle
```

The second command is a reproduction reference, not a new run commissioned by this entry.
It requires the original source-verified .130 cache recorded in the report. If those bytes
are unavailable, restore exact inputs through their owner rather than silently substituting
main. Preserve teardown and generous hang caps. Record durations without speed assertions.

Any separately commissioned implementation must pass the full matrix in `DESIGN.md`, including:

- A held real source native return blocks successor entry and keeps group ownership charged.
  Successful release permits generation + 1 at the same process identity, with no host-image
  group. The process observer stays pending until the held successor finally exits.
- Held/failed filesystem sections, native stop, controllers, cleanup, and late acquisition
  retain ownership and prevent false success. Precommit errors leave the source usable.
- Missing, unclassified, shebang-rewritten, or re-registered targets cannot gain host-only
  permission by name. Exact classified registration remains stable through the transaction.
- Queued/explicit joins, reserved/retained members, typed callers, roots, and unsupported
  publications preserve rejection and prior member/pin/publication ownership.
- Original-root relocation, sparse aliased fds, reduced rights, shared cursor/flags, unlink
  resilience, pipes, pending signals, and fatal races retain existing exec semantics.
- Non-group exec and ordinary PR 792 behavior remain unchanged. No subtree cancellation,
  shared-job kill, new phase job, physical-memory claim, or release hold is introduced.

Start source review with `proc/{abi,worker-client,worker-broker,supervisor,registry}.ts`,
`runtime.ts`, `browser/{process-broker,worker}.ts`, and `group/state.ts`, under
`packages/waffle/`. Exact line ranges and the independent review hashes are in the retained
design packet. There is no supported consumer-only route for this transition on the releases.
