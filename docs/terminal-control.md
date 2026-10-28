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
    turn.publish(() => members.set(childPid, admitted.value.member));
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
