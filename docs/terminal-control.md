# Waiting terminal control

Page-owned terminal mutations use `TerminalAuthority.control(work, { signal })`. The kernel waits for a live Session holder without blocking the page. It grants one synchronous turn, runs `work` once, and returns its `TerminalResult`. It never retries the callback or converts lock contention into capacity failure.

```ts
const result = await authority.control(
  (turn) => {
    const created = authority.createGroup({ initialMode: "raw" });
    if (created.kind === "error") return created;
    const admitted = authority.admitExisting({ group: created.value, pid: childPid });
    if (admitted.kind === "error") return admitted;
    const running = authority.startBackground(created.value);
    if (running.kind === "error") return running;
    turn.publish(() => {
      members.set(childPid, admitted.value.member);
    });
    return { kind: "ok", value: created.value };
  },
  { signal },
);
```

Terminal metadata is staged while the gate is held and commits only after successful synchronous work and liveness checks. On error or cancellation, new group/member incarnations are invalidated; reused groups and selection are not rewritten. Policy callbacks can have external effects, which this journal cannot undo. Use `turn.publish` for local bookkeeping that must become visible only after commit. Publication callbacks must only update local state, not call terminal operations. A retained turn expires.

Control is private to the current realm and stack. Same-Session root aliases can reuse that grant; matching a shared PID does not grant reentrancy. Blocking runtime waits and recursive control waits inside a control/policy turn are rejected. Work must remain bounded and synchronous. Promise results are invalid. Large input-drain flows retain their phase/byte progress and release the turn before waiting for input readiness; a failed data read is not a reason to replay a completed control phase.

## Descendant preparation

A root registers its existing claimed terminal authority before any preparation wait:

```ts
await service.adoptRuntimeRoot(root, {
  prepareDescendant: {
    terminal: authority,
    run(descendant, turn) {
      return prepareTerminalMembership(descendant, turn);
    },
  },
});
```

This replaces the bare callback shape. `run` returns a synchronous `TerminalResult<void>`. The kernel pins the exact root and pending preparation before waiting, cancels pending acquisition on root/child revocation or disposal, and checks incarnation, required hook, liveness and winner before adapter entry. `run` is never replayed. Success releases the gate and invokes the adapter in the same page continuation; worker entry still checks its selected outcome. Genuine terminal-table capacity is a resource error. Cancellation and closed-session failures remain distinct from contention.

Waiting duration has no fixed millisecond bound: a live holder can be descheduled or paused. Each acquisition attempt and granted turn is bounded, the page remains responsive, and cancellation wakes the waiter. Elapsed time is not death proof. H1's counted-section/native-stop acknowledgement contract continues to govern physical cleanup; control waiting neither holds an admitted section nor clears a foreign gate.

## Completion and reconciliation

`control` returns `TerminalControlResult<T>`, the ordinary result plus a `receipt`. Its `phase` is `not-entered`, `rolled-back`, or `committed`. `options.settled(receipt)` observes the same phase once before promise settlement, including thrown work. A not-entered receipt has `state: null`; no terminal callback ran and there is no fresh snapshot. Acquired receipts contain a bounded authoritative state snapshot at that completion point, not a continuously live query.

An open receipt's `state.selection` contains kernel-issued group, lease and root-member handles for the current selection. Apply those handles directly. `receipt.group(handle)`, `member(handle)`, and `lease(handle)` classify cached opaque handles against that snapshot. Existing groups/member/editor handles remain valid when rollback did not change them. Provisional created/bound/transferred handles are invalidated; epochs are never guessed or rewound. A closed state gives no usable authority. A subsequent independent control can supersede this snapshot, so preserve expected-lease checks.

The root descriptor's optional synchronous `settled(descendant, completion)` runs once before that process can reach `onChildExit`/retirement. `completion.kind === "rolled-back"` means Kernel owns rollback and publications did not run. Do not remove those provisional handles again. `kind === "committed"` means root ownership published; its `entry` is `not-entered` or `adapter-invoked`. Both committed cases use ordinary exit cleanup exactly once, including failed adapter invocation or cancellation after commit. Preparation settlement is not native termination proof.

## Bounded discard and input waiting

Capture `const observed = input.observe()` before a bounded attempt. Inside `control`, consume at most a fixed byte budget and retain the exact cursor phase and positive consumed-byte count. Byte consumption is irreversible and is not part of terminal metadata rollback. Publish only terminal handle/phase changes with `turn.publish`. Never restart completed group creation, selection, prefix consumption, or editor reset after a later wait.

If the unfinished data read needs retry, release the grant and call `await observed.wait({ signal })`. This one-shot observation watches both the input notification sequence and the actual lock value, so a foreign Session's lock-only release wakes it even without data notification. It consumes no bytes. The wake is advisory; take a new observation before the next bounded attempt. Reusing a completed observation is INVALID. Cancellation/poison retain CANCELED/CLOSED semantics. Both native registrations are joined before the wait promise resolves; the losing registration is notified without changing either word. No timer, private buffer inspection, or inferred dead holder is needed.

The controller owns a lifetime AbortController and tracks its control/input promises. On quiesce: first stop admitting new tasks, then abort the lifetime signal, then await all tracked promises, then dispose owned producer/Session/input state or allow native physical stop. Never cancel the shared input globally just to abort one root's wait. Preserve shared input ownership across Sessions. The broker applies this abort-before-join rule to pending descendant preparation; page discard/restore tasks must use the same controller lifetime signal. Existing H1 terminal sections still govern native stop, and failures retain their ownership.
