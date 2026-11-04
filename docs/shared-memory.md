# Shared-memory reservations

Every page runtime records its shared backing in one page-wide reservation ledger. By default the ledger is unbounded: it records every holder but admits everything, on every browser and user agent. Startup does not probe, read `navigator`, create a measurement Worker or await classification.

```ts
import { createRuntime } from "waffle";

const runtime = createRuntime();
```

## Explicit bounded declarations

An application that knows its capacity passes an issued declaration:

```ts
import { bytes, createRuntime, declareSharedMemoryPlatform } from "waffle";

const sharedMemory = declareSharedMemoryPlatform({
  kind: "bounded",
  budgetBytes: bytes(3_221_225_472),
  counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
});
const runtime = createRuntime({ sharedMemory });
```

The application asserts the capacity; Waffle does not measure it. The factory requires a positive safe-integer budget and three boolean counted kinds, and throws `TypeError` otherwise. It freezes its result. `declareSharedMemoryPlatform({ kind: "unbounded" })` declares the unbounded policy explicitly.

`createRuntime` accepts only an object issued by that factory. A literal, a spread copy, `null`, or a platform read back from an earlier snapshot is refused with `TypeError` before any backing or Worker exists. Only an omitted or `undefined` option selects the default.

| Policy | Default or explicit unbounded | Explicit bounded |
| --- | --- | --- |
| Admission | No limit, unless a native refusal set a cap | Declared budget |
| Request arena | 2,147,479,552 bytes, with a 64 MiB retry on `RangeError` | 64 MiB, no retry |
| Default group | Growable, 65,536 pages | Fixed, 16,384 pages |
| Worker controls | Unbounded | 64 MiB lifetime quota per Worker |

Snapshots report `source: "default"` for omission and `source: "application"` for a declaration. Neither is a measurement.

## What is charged

The ledger tracks filesystem roots and segments, request arenas, workspace publication buffers, pipe registries, group memories, Waffle control buffers and declared guest memory. It is a reservation budget, not a resident-memory measurement. Standalone low-level filesystem and process construction outside a page runtime remains an explicit trusted embedding boundary.

The interrupt loader and link-plan loader record memory declarations from the bytes they compile. For cooperative modules you compile yourself, call `declareModuleMemory(module, source)` before launch. This is trusted embedder data on the page, not something a guest can call. A bounded runtime refuses undeclared modules.

`SharedMemoryAdmissionError` extends `ProcessError`, with errno 48 and code `ENOMEM`; process startup reports `start-failed` with `ENOMEM`. A counted native `RangeError` refunds the failed construction, records a contradiction and lowers the effective page cap to at most the remaining charges. A failure for an uncounted kind returns `kind: "uncounted-platform"` without changing the cap, debt or history.

## Pools, physical stops and quotas

Filesystem pools own request arenas. Admission tickets reserve construction headroom but never own a pooled backing. Bounded groups have fixed memory; reuse requires an exact shape and zeroes every guest-addressable byte first. Buffers exposed through `MemoryGroupHandle.buffer()` are never recycled.

Guest-memory charges return only after successful physical Worker termination and cleanup. Signals, logical exit and filesystem quiescence do not return them. Failed physical stops and stranded arenas remain charged debt.

Each bounded Worker claims bytes from its own control quota before constructing a control or pipe buffer. A successful physical stop returns unused quota only. Consumed bytes stay as page-lifetime debt, because transferred endpoints can outlive their creator.

## External roots

Root adoption constructs the charged pipe registry and publishes it into `transport.data`. Await `adoptRuntimeRoot(transport, { memory })` before reading `workerProcessPipeRegistry(transport)` or posting a bootstrap request; `memory` lists the root's declared memories, or `[]`. Include `service.rootControlGrant(pid)` as `controlGrant` in the bootstrap request and forward `shared-control-allocation` messages to `service.rootControlAllocated(pid, buffer)`. If the embedder terminates a non-group root itself, call `service.rootStopped(pid)` after successful physical termination.

## Inspect the page

`runtime.sharedMemory.snapshot()` returns tracked holders, their declared sizes and states, available capacity, awaiting-collection bytes and debt. `effectiveBudgetBytes` is the admission cap after counted contradictions. The cap and contradiction history survive runtime disposal and later declarations, including the default. `check(plan)` is advisory and allocates nothing.

Page-held backing stays charged until a finalization receipt, which proves local reachability only. Failed-stop debt never clears through finalization.
