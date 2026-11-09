# Framework tester trace ownership

The optional framework trace capture preserves the admitted tester until the host
has its final cleanup trace and has joined the evidence consumers. It does not
repair failed reporting, admit a provider command after cancellation, or turn a
selected file into a complete root suite.

## Host contract

`FrameworkHost.captureTesterTrace(options)` arms one capture before `run`, document
instrumentation, or session allocation. `options.collectorResponse` receives a
validated event and the actual collector answer. It can hold that response or
return `"malformed-ack"` to corrupt a task-update acknowledgement. It cannot change
collector acceptance. Its signal cancels fixture gates, not original framework RPCs.

```ts
const host = createFrameworkHost(options);
const capture = host.captureTesterTrace({
  collectorResponse: (observation, signal) => fixture.collectorResponse(observation, signal),
});
const result = await host.run(executeActualInstalledFramework);
```

`capture.checkpoint()` reads the admitted tester's recorded data. One checkpoint
and one independent `capture.releaseOriginalRpc()` may be outstanding. The release
calls only the fixture's bound closure. Neither operation establishes final trace
evidence. Both reject after cancellation or the orchestrator's destruction fence.
A checkpoint after the terminal post reuses the sealed bytes without another read.

## Page contract

`getFrameworkTraceDocument()` comes from
`waffle/testing/page-runner/framework-page`. The source bootstrap installs it only
when capture is armed. The actual tester binds once, before paired admission:

```ts
const trace = getFrameworkTraceDocument();
if (trace?.kind === "tester") {
  trace.bind({ snapshot: encodeRecordedFixtureData, releaseOriginalRpc });
}
```

The snapshot reader returns bounded, already-recorded text. It must not reread raw
framework errors, assimilate update returns, or invoke original RPCs. Fixture
recorders must cap their entries at 1,024 and use a bounded encoder. The SDK reserves
the terminal slot before entering the reader and limits its result to 48 KiB of
UTF-8. The checkpoint has a separate 48 KiB slot. Overflow fails evidence; it does
not truncate and confirm it.

The original orchestrator bridge separates its existing reporting wait from its
existing retirement wait. The new fence goes between them and is independent of
the ordinary reporter's abort signal:

```ts
await observeExistingCleanupResponse();
if (trace?.kind === "orchestrator") await trace.waitForTesterTrace();
await observeExistingNormalRetirement();
```

The SDK captures the native channel instance created by the inspected Vitest client
from its own-data session and role fields. Both physically paired documents must
hold the same session channel before admission. The observer matches the exact
iframe and message identifiers. It reads own data descriptors, not application
getters, and delegates the original post exactly once with its receiver and complete
argument list. Original returns and thrown values are unchanged.

The terminal boundary is the successful original `response:cleanup` post following
the matched cleanup command. The original cleanup catch, trace finishing, error
expressions, and update return stay untouched. Observer or encoding failure cannot
replace the original post result or let an outer reentrant snapshot commit.

## Receipt order

Final bytes arriving at the host do not end the live-control phase. The last
ordinary response gate still runs before the orchestrator enters the named fence.
At that fence, the host closes new fixture admission and joins admitted decisions,
control operations, body readers, and actual response finish or close consumers.

The tester then consumes its terminal acknowledgement, closes its evidence stream
and listener, joins local operations, and sends its receipt. Only physical host
reception and handler settlement allow the top-settlement acknowledgement. The top
closes its own evidence consumers and sends its separate receipt. Its fence remains
held after sending that receipt, regardless of the beacon's return value.

After both receipt handlers and all evidence consumers join, the receiver creates
its private evidence receipt. Only then does the separate, pre-admitted, callback-free
authorization delivery release the page fence. Authorization is not an evidence
consumer awaiting its own permission. The host still joins its delivery for cleanup.
There is one collector listener, two fixed evidence streams, and one authorization
slot, all on the existing framework middleware.

Ingress reserves one body reader and one final receipt reader per role before body
parsing or claimed identity. Collector fixture responses have 64 active slots.
Extra ingress is refused rather than queued, before a body reader exists. The same
64-response bound owns bootstrap collector traffic before paired admission and
ordinary collector traffic after fixture admission closes. Those requests cannot
invoke a fixture decision. Requests admitted before the evidence fence join that
fence. Later ordinary retirement responses remain physically owned until cleanup,
without becoming evidence consumers waiting for their own disposal permission.
Physical closure stops all new admission. Existing 65,536-byte and 2,000 ms body
limits apply. Identical terminal retries reuse the stored text. Conflicting,
foreign, old-generation, or late input cannot overwrite evidence or release a fence.

## Results and containment

`FrameworkResult.trace` is `not-requested`, `confirmed`, or `incomplete`.
A confirmed result names the admitted tester and immutable artifact. Incomplete
results distinguish retained checkpoint prefixes from terminal-unconfirmed bytes.
The first failure stays sticky. Neither a timeout nor queued receipt is a join.
`cleanup.trace` reports physical consumer cleanup separately from trace completeness.
An incomplete requested capture prevents `fileComplete`.

Cancellation immediately revokes provider commands and live fixture admission.
Already admitted terminal delivery remains possible. Trace settlement consumes the
existing 12,000 ms context step, within the original run, file, and 60,000 ms cleanup
ends. Context joining receives only that step's unused allowance. Physical trace
cleanup shares the existing callback-join allowance rather than opening another
window. No source admission means no wait for a hypothetical producer.

On failed containment, destruction starts before joining opaque context or execution
work. A trace that genuinely needs session deletion remains incomplete. The original
no-capture deletion-dependent closer regression is unchanged. Unresolved callbacks
or transport consumers retain scratch; later test cleanup does not rewrite the
saved result.

`cleanupDeadlineAt` is the host's original absolute monotonic cleanup end, always
present. A matching outer Node owner uses only its remainder for dispatcher closure.
It must not unconditionally re-await context or execution already reported
unconfirmed, restart the clock, or close the dispatcher before session deletion.
Runner ownership evidence stays separate from the sealed SDK result.

## Verification limits

Permanent CPU tests exercise the private page owner, actual host, actual middleware,
real loopback responses, held receipts, ingress limits, cancellation, and containment.
Private admission fixtures are not physical DOM admission or installed hook proof.

Matching-consumer integration and installed or native qualification remain separate.
They must retain all 38 matrix cases, the flush case, all three negative cases, all
five modes, the existing 15,000 ms cases and 30,000 ms hooks, zero retries, 180 ms
throttle, 60 ms gate comparison, and 25,000 ms watchdog. Negative collector outcomes
stay unreported even when their separate final trace is confirmed. No native,
original-suite, release, or supported-pin credit follows from CPU controls.
