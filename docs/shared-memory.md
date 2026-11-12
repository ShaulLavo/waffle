# Shared-memory reservations

Every page runtime records its shared backing in one page-wide reservation ledger. By default the ledger is unbounded: it records every holder but admits everything, on every browser and user agent. Startup does not probe, read `navigator`, create a measurement Worker or await classification.

```ts
import { createRuntime } from "waffle";

const runtime = createRuntime();
```

## Size for Safari

Safari allocates requested WebAssembly memory ahead of time; Chrome and Firefox commit lazily. Size memories, shared buffers and workers for Safari.

Safari, especially on iOS, reserves the whole `maxByteLength` of a growable `SharedArrayBuffer` and the whole maximum of a shared WebAssembly memory when it is constructed. A zero initial length is not zero cost. So do not create growable backing ahead of the data it will hold, and count the full declared maximum against the iPhone reservation budget, never `byteLength` or the initial pages. This is a budgeting rule for new code, not an explanation of any particular past failure.

The filesystem follows it. A new tree holds only its fixed root. The filesystem owner builds each further 16 MiB data segment as a fixed buffer when a page in it is first needed, and a tree that stays small never declares the rest. The request arena is the one growable buffer a connection has: it is the transport every guest needs before it runs, and it is counted at its full maximum.

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

`createRuntime` accepts only an object issued by that factory. A literal, a spread copy, `null`, or a default-provenance platform read back from an earlier snapshot is refused with `TypeError` before any backing or Worker exists. Only an omitted or `undefined` option selects the default.

| Policy | Default or explicit unbounded | Explicit bounded |
| --- | --- | --- |
| Admission | No limit, unless a native refusal set a cap | Declared budget |
| Request arena | 134,316,032 bytes, with a 64 MiB retry on `RangeError` | 64 MiB, no retry |
| Default group | Growable, 65,536 pages | Fixed, 16,384 pages |
| Worker controls | Unbounded | 64 MiB lifetime quota per Worker |

Snapshots report `source: "default"` for omission and `source: "application"` for a declaration. Neither is a measurement.

## What is charged

The ledger tracks filesystem roots, request arenas, workspace publication buffers, pipe registries, group memories, Waffle control buffers and declared guest memory. It is a reservation budget, not a resident-memory measurement.

The filesystem's data segments are built later, by the filesystem worker, where the page's ledger cannot see them. The page therefore admits the whole advertised extra capacity once, when the tree is created: one `filesystem-segment` holder with a `capacity-promise` shape for 1,593,835,520 bytes. It is charged in full on every platform, has no buffer behind it and reports `grownBytes: null`. A segment that appears later is not charged again. Standalone low-level filesystem and process construction outside a page runtime remains an explicit trusted embedding boundary.

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

## Runtime network owner

The runtime's private Rust network executes as a nonshared ArrayBuffer factory. It constructs no WebAssembly.Memory or Instance and is never posted into a guest. This avoids WebKit's large fast-memory reservation for this small owner. It does not change guest descriptors, platform caps or memory-group accounting. The public `waffle/network` native adapter still loads real Wasm. See [virtual network allocation](network-memory.md) for resource counts and conditional linear-length bounds; no physical memory or native workload claim follows.
