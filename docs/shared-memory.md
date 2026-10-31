# Shared-memory reservations

`createRuntime` requires a platform before it allocates filesystem state. Production callers either classify once per page or explicitly declare trusted capacity before probing.

```ts
import { createRuntime, measureSharedMemory } from "waffle";

const sharedMemory = await measureSharedMemory({
  workerURL: new URL("./probe-worker.js", import.meta.url),
});
const runtime = createRuntime({ sharedMemory });
```

The browser build includes a `probe-worker.ts` entry that imports `waffle/memory/probe-worker`, emitted beside the app as `probe-worker.js`. Include it in the build and pass its emitted URL. [Getting started](getting-started.md#build) shows all three entries. Bundling the app alone does not emit the probe asset.

Measurement classifies the platform, not usable post-probe capacity. The worker first tries a 16 GiB growable shared buffer, halving only before the first success, down to 256 MiB. It then keeps that chunk size until the next refusal or the 16 GiB ceiling. There is no fill phase or counted-kind sub-probe. Reaching the ceiling resolves an unbounded platform. A below-ceiling refusal rejects with `SharedMemoryMeasurementError`, whose `observation` is either `bounded` with scalar `heldBytes` and `chunkBytes`, or `unavailable` if even the smallest chunk refused. Those bytes describe the observation, never a startup budget.

The promise is memoized per page, including rejection. Handlers are cleared and the worker is terminated before settlement, but termination is not a physical-release receipt. No runtime remeasurement runs after an allocation failure.

## Bounded platforms need a trusted declaration

An embedder that has trusted bounded capacity calls `declareSharedMemoryPlatform({ kind: "bounded", budgetBytes, counts })` **instead of** measurement, before any probe runs. The declaration is the embedder's assertion, not capacity verified by Waffle. Waffle supplies no budget, platform selector, retry, or fallback from rejection to a declaration. Declared platforms retain `source: "declared"`; measured unbounded platforms retain `source: "measured"`. A measurement rejection must stop startup unless the embedder has selected a separate trusted policy before probing.

## What is charged

The page-wide ledger tracks filesystem roots and segments, request arenas, workspace publication buffers, pipe registries, group memories, Waffle control buffers, and declared guest memory. This is a reservation budget, not a resident-memory measurement. Trusted adapters must declare additional memories they create. Standalone low-level filesystem and process construction outside a page runtime remains an explicit trusted embedding boundary.

The interrupt loader and link-plan loader register memory declarations from the bytes they compile. For cooperative modules you compile yourself, call `declareModuleMemory(module, source)` before launch. Bounded platforms refuse undeclared modules. They do not refuse every real guest and never create a dummy page memory for one.

`SharedMemoryAdmissionError` extends `ProcessError`, with errno 48 and code `ENOMEM`. The existing process startup path reports `start-failed` with `ENOMEM`. A budget refusal describes requested bytes, available bytes, and bytes awaiting a reachability receipt. A counted native `RangeError` refunds the failed construction, records a contradiction, and lowers the effective page cap to at most the remaining charges. A zero-count failure instead returns `kind: "uncounted-platform"`, including its label, attempted `requestedBytes`, and native cause, without changing the counted cap, debt, or history. The unbounded desktop arena ladder stays unchanged when no contradiction cap exists.

## Pools and physical stops

Filesystem pools own request arenas. Tickets reserve construction headroom but never own a pooled backing, so aborting after reuse cannot drop its charge. Bounded arenas reserve 64 MiB. Desktop arenas retain the 2,147,479,552-byte maximum and the RangeError-only 64 MiB retry.

Bounded groups have fixed initial and maximum memory, with 16,384 pages by default. Explicit group maxima remain configurable. Reuse requires an exact shape and zeroes every guest-addressable byte before handing the memory to another group. Buffers exposed through `MemoryGroupHandle.buffer()` are never recycled. Logical grants are also cleared during an active group. Desktop groups keep their growable 65,536-page default.

Guest-memory charges return only after successful physical worker termination and cleanup. Signals, logical exit, and filesystem quiescence do not return them. Failed physical stops and stranded arenas remain charged debt.

## Guest control quota

Each bounded worker receives a 64 MiB lifetime byte quota for Waffle controls and pipe allocations. Every allocation claims bytes before constructing its shared buffer. Imported pipe backings are not charged twice, but new endpoint control cells use the receiving worker's quota. Desktop workers have no new control limit.

Successful physical stop returns unused quota only. Consumed bytes remain explicit page-lifetime debt because transferred endpoints can outlive their creator, and failed publication does not prove that an allocated backing disappeared. A long-running bounded worker can exhaust its quota through churn. Repeated workers can accumulate consumed debt. The snapshot reports that retained-budget limit; it does not call those bytes reclaimed.

Root adoption constructs the charged pipe registry and publishes its handle into `transport.data`. Await `adoptRuntimeRoot` before reading `workerProcessPipeRegistry(transport)` or posting a bootstrap request. A copy of the old data is not updated. Pre-supplied root registries must have been allocated by the same runtime's reservation authority. The broker also supplies the canonical registry to every child. A worker with an allocation hook must receive this registry; it never creates an uncharged default.

External roots pass their declared memories when adopted. After adoption, include `service.rootControlGrant(pid)` as `controlGrant` in their bootstrap request and forward `shared-control-allocation` messages to `service.rootControlAllocated(pid, buffer)`. Supply the root's physical `stop` callback. If the embedder terminates a non-group root itself, call `service.rootStopped(pid)` after successful physical termination. A group root's membership `stopped()` receipt settles the same reservation.

## Inspect the page

`runtime.sharedMemory.snapshot()` returns tracked holders, their declared sizes and states, available capacity, awaiting-collection bytes, and debt. `budgetBytes` is the latest declared budget, or null for unbounded. `effectiveBudgetBytes` is the admission cap after counted contradictions. `contradictions` records the label, attempted `requestedBytes`, and `totalChargedBytesAfterRefund` for each counted failure. The cap and history survive runtime disposal and later declarations, even an unbounded one. Credits can restore room below the cap but never raise it. `check(plan)` is advisory and allocates nothing. Actual launch admission reserves its own headroom.

The ledger keeps no strong references to disposed holders. Page-held backing remains charged until a finalization receipt. That receipt establishes local reachability only, not proof that the operating system returned every reserved byte. An embedder retaining a runtime or an exposed buffer can delay it. Failed-stop debt never clears through finalization.
