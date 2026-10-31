# Shared-memory reservations

`createRuntime()` selects a synchronous built-in memory profile. Startup does not probe, allocate a test pool, create a measurement Worker, or await classification. The ordinary filesystem Worker is unchanged and process services remain lazy.

```ts
import { createRuntime } from "waffle";

const runtime = createRuntime();
```

## Built-in profiles

| Policy | Desktop | iOS and iPadOS WebKit |
| --- | --- | --- |
| Profile | `desktop` | `apple-mobile-webkit` |
| Budget | Uncapped | 3 GiB |
| Assumed pool and margin | Not applicable | 4 GiB minus 1 GiB |
| Counted maxima | All recorded, no admission limit | Fixed shared buffers and shared Wasm memory; not private Wasm maxima |
| Request arena | 2,147,479,552 bytes with the existing 64 MiB fallback | 64 MiB, no fallback |
| Default group | Growable, 65,536 pages | Fixed, 16,384 pages |
| Worker controls | Unbounded | Existing 64 MiB lifetime quota |

The mobile values are policy assumptions, not runtime measurements or per-device guarantees. Private guest maxima remain fully visible in `declaredBytes` but are not charged by this profile. Their current physical size and browser allocations are outside this reservation ledger and must fit within the margin. A group, grant state, pooled arenas, other controls and retained debt add charges beyond the nominal arena and quota pair. The policy does not guarantee a process count or a Nuxt install peak.

`sharedMemoryProfile(environment?)`, exported from `waffle`, is a pure selector when given `{ userAgent, maxTouchPoints }`. Without an argument it reads the current navigator only when called; an absent navigator selects desktop. The rule first requires `AppleWebKit/`. An iPhone, iPad or iPod token selects mobile with `match: "ios-user-agent"`. A Macintosh token with more than one touch point selects mobile with `match: "ipados-desktop-user-agent"`. Other inputs select desktop, including Mac Safari without touch, Android and unknown custom WebViews. No other detection heuristic runs.

## Application override and provenance

An application with better knowledge passes an issued override instead of the default:

```ts
import { bytes, createRuntime, declareSharedMemoryPlatform } from "waffle";

const sharedMemory = declareSharedMemoryPlatform({
  kind: "bounded",
  budgetBytes: bytes(3_221_225_472),
  counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
});
const runtime = createRuntime({ sharedMemory });
```

An explicit override skips environment reads entirely. The application asserts the capacity; Waffle does not measure its truth. The factory requires a positive safe-integer budget and all three boolean counted kinds, and throws `TypeError` on invalid input. It copies allowlisted fields and freezes the outer object and nested counts. Only issued objects are accepted: a literal, spread copy or JSON recreation rejects before backing or Worker construction.

Snapshots identify a built-in choice by `source: "profile"` and its `profile`. Mobile profiles also expose the match, assumed pool and margin. Overrides use `source: "application"`. Neither source is a measurement. Importing source or prepared entries reads no environment and constructs no shared backing, Wasm memory or Worker. The internal `memory/index.ts` is not a public package subpath.

## Research and limits

This is original Waffle selection code informed by these sources, not copied upstream implementation:

- [YurtOS/yurt-playground PR 272](https://github.com/YurtOS/yurt-playground/pull/272), merge `305658a9`, reports roughly 4 GiB shared-Wasm reservation totals on actual iPad, iPhone and Chrome for iOS, versus roughly 30 GiB on macOS. These are observations, not a WebKit constant. Its probe waits 1.5 seconds after termination, calls immediate iOS reclamation unmeasured, and lists full-branch device verification as pending.
- [Automattic/kandelo PR 1410](https://github.com/Automattic/kandelo/pull/1410), merge `1cf3e9ac`, supports a constrained process policy and the Macintosh-with-touch iPadOS signal. Its roughly 6 GiB iOS observation is from a Simulator, not a phone guarantee. Its revised reclamation claims are not Waffle release evidence.
- [WebKit at `c40e5ac6`](https://github.com/WebKit/WebKit/commit/c40e5ac64afe59b027548e190fc490f12ddf5ea4), particularly `WasmMemory.cpp`, `ArrayBuffer.cpp` and `BufferMemoryHandle`, supports maximum reservation for shared Wasm and growable buffers, versus current-size mapping for bounds-checked private memory. This is trunk source, not proof of the installed iOS 26.5 build. Separate RAM-dependent physical accounting still exists, and `Worker.terminate()` returns no physical-release receipt.

An unrecognized mobile WebView can receive the desktop profile; its application must override it. A low-capacity device, private-memory growth or browser demand beyond the margin can still fail. Optional refinement is not implemented and startup never waits for it.

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
