# Process execution observation

`waffle/proc/observation` separates an execution's observation lifetime from ordinary
process authority and consuming waits. This host contract requires
`waffleHostInterface` 2. It adds no guest import.

## Results and canonical sources

`captureProcessObserver(transfer).read()` returns one of these results:

```ts
type ProcessObservation =
  | { readonly kind: "pending" }
  | { readonly kind: "selected"; readonly result: ProcessExit }
  | { readonly kind: "terminated" };
```

A selected result comes from the original canonical outcome word. Directory-backed
processes keep that word in their process row. Standalone roots and direct
supervisor executions keep their existing non-recycled word, including its
external aliases. There is no copied terminal result or second selector.

An observer retains the admitted source, full PID, immutable owner domain, and
one 16-byte shared token. A directory transfer also captures its slot. A standalone
transfer carries the original `OutcomeTransfer`. Lazy supervisor activation reuses
the same association and token. It does not allocate another observation.

Before native return, the observer can read the exact selected result after
consuming collection. After native return, it returns `terminated` without reading
a recycled process row. That result has no exit code or signal. An ordinary exit
of 137 remains an ordinary exit, not evidence of SIGKILL.

The observer is read-only. Ordinary `OutcomeCell`, signal, descriptor, job, and
process operations still require live authority. They cannot use an observer to
act on a collected process or its successor. Existing standalone `readOutcome`
aliases retain their ordinary semantics after observation expiry.

## Native ownership

The owner captures its exact consumer and closes admission before stopping it.
A successful void native return ends that consumer's product lifetime
synchronously. A promise ends it only on fulfillment. Invocation, rejection,
a guest completion message, and removal from a host map do not end it.

An aggregate process joins every accepted initial or late consumer, including
rollback workers and its control-reading service. An arbitrary launcher rejection
cannot prove that no native consumer was constructed. Its uncertain ownership
remains retained and strong cleanup reports failure. A runtime-owned no-agent
rollback can close only after its accepted preparation and exports are reconciled.

An external root captures its admitted transfer before asynchronous entry:

```ts
const pid = processes.reserveRoot({ outcome }, controller);
const observation = processes.rootObservation(pid);
const stop = processes.captureRootStop(pid, () => worker.terminate());
```

The bootstrap request carries `observation` alongside the original outcome.
`stop` is idempotent and remains valid after logical root retirement. It invokes
its captured native consumer, not a fresh PID lookup. The owner must capture an
accepted asynchronous acquisition before it can race shutdown. A controller's
captured `stop` hook remains part of that inventory. After directly terminating that
root consumer successfully, the external owner calls `rootStopped(pid)`. This retires
only the captured controller consumer and releases its stop closure. Other accepted
consumers still need their own returns. If the captured hook is already invoking or
has returned a promise, its result remains authoritative. Reentrant acknowledgement
cannot settle a pending or failed stop. A metadata-only root with no accepted native
consumer does not invent a native-return event.

Native return is a product boundary. It does not prove that every physical reader
has closed, reclaim operating-system memory, or discharge memory-group, GPU,
pipe, shared-control, or filesystem obligations.

## Collection and capacity

A consuming wait still returns the exact result after the existing filesystem and
terminal fences. It does not wait for native termination. Logical collection
immediately forwards ancestry through helpable phase 3. Phase 4 means forwarding
is complete but native-return eligibility may still be pending. It grants no
ordinary process authority and is not an ancestry dependency.

A process row is reusable only after both logical collection and native return.
The token expires before the tagged row flag is published. Both orders work
without delaying collection. Whole-job collection releases its job header and
forwards internal edges without waiting for every member's native promise.

Pending or failed native returns occupy existing process capacity. At full
capacity, another spawn can return `EAGAIN` until a slot becomes reusable.
Successful repeated stops impose no cumulative launch-count quota.

The directory has exactly `32 + P * 89 * 8` bytes. This is 729,120 bytes at
`P = 1,024` and 46,661,664 bytes at `P = 65,536`. Each admitted execution also
allocates its token through the ordinary shared-control allocator. Existing byte
grants charge all sixteen bytes. Logical collection and token expiry refund no
consumed grant bytes. Allocation failure remains `ENOMEM`.

## Bootstrap cleanup

Generic and threaded bootstrap capture one observer before initial authority
acquisition and asynchronous imports. Runtime-owned acquisition failures reread
that same observer. Pending or invalid observation preserves the original error
object. Only an authenticated selected result or the distinct runtime-owned
terminated unwind changes the completion path.

A terminated unwind still releases already owned resources. It cannot claim a new
outcome, infer signal 9, call an executor completion hook, or publish a replacement
exit. Actual local cleanup failures remain failures.

For ordinary process and wait signatures, see [Host ABI](host-abi.md).
For the captured-intrinsic boundary, see [Private process authority](private-authority.md).
