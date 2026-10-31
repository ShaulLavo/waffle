# Shared-memory reservations

`createRuntime` requires a platform before it allocates filesystem state. Production callers measure once per page. Tests and trusted overrides can declare a platform explicitly.

```ts
import { createRuntime, measureSharedMemory } from "waffle";

const sharedMemory = await measureSharedMemory();
const runtime = createRuntime({ sharedMemory });
```

The measurement fills growable shared buffers in a disposable worker until allocation fails or reaches 16 GiB. It tests fixed buffers, shared Wasm memories, and private Wasm memories separately. The worker is terminated before measurement resolves. Unknown or failed measurements reject. A native allocation refusal on a bounded platform triggers one new measurement. Failure keeps the bounded classification.

## What is charged

The page-wide ledger tracks filesystem roots and segments, request arenas, workspace publication buffers, pipe registries, group memories, Waffle control buffers, and declared guest memory. This is a reservation budget, not a resident-memory measurement. Trusted adapters must declare additional memories they create. Standalone low-level filesystem and process construction outside a page runtime remains an explicit trusted embedding boundary.

The interrupt loader and link-plan loader register memory declarations from the bytes they compile. For cooperative modules you compile yourself, call `declareModuleMemory(module, source)` before launch. Bounded platforms refuse undeclared modules. They do not refuse every real guest and never create a dummy page memory for one.

`SharedMemoryAdmissionError` extends `ProcessError`, with errno 48 and code `ENOMEM`. The existing process startup path reports `start-failed` with `ENOMEM`. Its refusal describes the requested budget, available bytes, and bytes awaiting a reachability receipt.

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

`runtime.sharedMemory.snapshot()` returns tracked holders, their declared sizes and states, available capacity, awaiting-collection bytes, and debt. `check(plan)` is advisory and allocates nothing. Actual launch admission reserves its own headroom.

The ledger keeps no strong references to disposed holders. Page-held backing remains charged until a finalization receipt. That receipt establishes local reachability only, not proof that the operating system returned every reserved byte. An embedder retaining a runtime or an exposed buffer can delay it. Failed-stop debt never clears through finalization.
