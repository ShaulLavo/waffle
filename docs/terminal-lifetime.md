# Terminal consumer lifetime

The runtime broker fences terminal transactions before stopping a process. Entry is
counted against its captured directory, slot and PID before the Session gate CAS.
Quiescence revokes new entry and waits for counted sections to unlock and leave.
The last revoked section wakes the join through the process common sequence.
An adapter's filesystem acknowledgement does not replace this terminal fence.

Signals, selected outcomes, cancellation, collected results and elapsed time do not
prove that a native Worker stopped. Failed physical stops retain their ownership.
The runtime never clears an abandoned gate to make another process enter.

## Hosts that stop native Workers directly

Capture the lifetime before launching the consumer, including every terminal it can
reach and every input buffer its policies use. Keep the capture in trusted host code.
`process` is the exact runtime transport for that native consumer, not its parent.

```ts
import { captureTerminalProcessLifetime } from "waffle/browser/runtime-terminals";

const lifetime = captureTerminalProcessLifetime({
  process,
  terminals: [{ identity: display.identity, inputs: [input] }],
});

// Normal stop: the live consumer must leave its critical sections first.
await lifetime.quiesce();
await nativeHandle.terminate();
lifetime.stopped();
```

For an independently observed native death, call `stopped()` only after that exact
captured handle's physical termination acknowledgement. Then `quiesce()` can settle
without waiting for a finally block that cannot run. A signal claim, error event or
timeout is insufficient. An unreported direct native kill cannot be inferred.

If the dead consumer held a Session gate, that Session closes. If it held a generic
input lock, the matching input transport is poisoned and subsequent pushes and reads
return BADF. The locks remain set, and partially updated bytes are never reused.
An omitted active input in the capture throws and does not acknowledge the stop.
No input lock means a raw input buffer can still be reused by another terminal root.

Each generic input lock has a unique acquisition token. The original Session turn
publishes that token and the buffer nonce before acquiring the input lock. Stop
acknowledgement poisons only a matching held acquisition. A different root's live
holder is untouched even when both roots share the same raw buffer. A poisoned
shared input fails for every user of that transport; unrelated Sessions stay open.

The fence covers operations performed through the actual Session and its original
policy turn. Independent raw `input.push()` calls and direct policy calls outside
that turn are not process-admitted work. Their host must keep the producer alive or
provide its own admission fence. This API does not infer ownership for arbitrary raw
buffer use. Reusing a poisoned input requires a new input transport.
