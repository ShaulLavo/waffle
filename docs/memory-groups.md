# Memory groups

A memory group is one `shared: true` `WebAssembly.Memory` that several processes run in. Each member process instantiates its own position-independent (PIE) image into the group at its own base. It keeps its own statics, stack, function table, heap, descriptors and filesystem identity. Shared regions are carved from the same memory, so every member addresses a region's bytes at the same address, and `memory.atomic.wait32`/`notify` work across members natively.

Groups are optional and pay-for-use. Nothing is created until a launch asks for one. The worker side (`waffle/group/member`) loads only in members.

## Launch members

A trusted adapter asks for membership in `launchWorker`. Members load through [`waffle/link`](linking.md): the request carries a link plan, and the worker composes `linkedWorkerHooks()`.

```ts
const plan = await prepareLinkPlan({ core, libraries, reserve });
service.launchWorker(context, {
  workerUrl,
  request: {
    module: plan.entryModule,
    args: context.request.argv,
    env: context.request.env,
    linkPlan: plan.shared,
  },
  memoryGroup: "new", // or "inherit" (the parent's group), or a handle from memoryGroupOf(pid)
});
```

Admission reserves a member slot before the Worker is constructed. Every member of a group shares its leader's process directory; joining from another directory fails with `EINVAL`. `memoryGroupOf(pid)` returns `{ id, buffer() }` for a launched member: the group's shared bytes, never its growable `Memory`. `memoryGroups()` returns owner-side counters for each live group: members, reserved, retained, pids, regions, pins, published, holds, watches, `committedBytes`, `memberPages`, `freeBytes` and `bypassed`. A settled root membership is dropped by the broker; only unsettled members stay reachable.

An adopted runtime root that runs its own worker calls `admitRootMemoryGroup(pid, { module: plan.entryModule, linkPlan: plan.shared }, join)` before posting its worker request, and transfers the returned `transfer` list with `request` as the worker request's `memoryGroup` field. Omitting `join` creates a new group. Both root and child admission require the original
page-prepared PIE image paired with its exact core module, before reserving group or
worker resources. Cloned, adopted, forged, missing and non-PIE plans are refused.
The root's membership settles when its controller's `stop` succeeds during disposal, or when the embedder calls `stopped()` after its own successful physical stop. An unsettled member makes runtime disposal fail.

The member image is a PIE linked with `-pie --experimental-pic --import-memory --shared-memory --import-table --max-memory=4294967296`. It imports `env.memory`, `env.__indirect_function_table`, `env.__memory_base`, `env.__table_base` and a mutable `env.__stack_pointer`. Waffle reads `dylink.0` memory-info, carves the data chunk and a private stack (`stackBytes`), and gives the image its own table with slot 0 left null. A link plan whose core has `dylink.0` is linked the same way, then its PIC libraries reserve through the core allocator as before. Constant data exports of such a core are relative to its `__memory_base`.

Admission refuses a group image that could grow the shared memory around its owner. The link loader decodes every function body of a PIE core and of each library linked into it, and rejects `memory.grow` and any export of the memory; an opcode it cannot decode is refused too. Growth goes through `runtime_shm.group_grow`: in wasi-libc that is the `sbrk` patch, and a Rust core must route its global allocator there as well. Bootstrap refuses a group member without a link plan. A trusted custom executor still holds the `Memory` object; if anything grows it outside the owner, the owner charges the real size truthfully, reports `bypassed`, and admits nothing more into that group.

`workerMemory()` samples a member's bound memory, which is the whole group memory. Use `memoryGroups()` for a group's committed backing; do not sum worker samples across members.

## Policy

`createRuntime({ sharedMemory, memoryGroups })` sets runtime policy. [Shared-memory reservations](shared-memory.md) describes the unbounded default and explicit bounded declarations. Every limit is configurable.

| Field                        | Default          | Meaning                                                                      |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `members`                    | 16               | Admitted members per group, including the leader and pending reservations    |
| `parallelism`                | 1                | Reported to every member through `runtime_shm.parallelism()`                 |
| `budgetBytes`                | 2 GiB            | Committed group backing for the whole page, summed across groups             |
| `maximumPages`               | 65536            | Address-space maximum of one group (4 GiB). Declared maximum is not a charge |
| `memberPages`                | `maximumPages`   | Cumulative granted member pages per group; excludes shared regions           |
| `regions`, `pins`, `watches` | 4096, 4096, 1024 | Bounded metadata per group                                                   |
| `publications`               | 4096             | Publications per group. Counts publications, not the references they hold    |
| `groups`                     | 64               | Live groups per page                                                         |
| `stackBytes`                 | 1 MiB            | Private stack per PIE member image                                           |

`memberPages` defaults to the configured effective `maximumPages` during policy normalization, including when a custom maximum is supplied. An explicit cap must be a positive whole page count no greater than `maximumPages`. It counts every granted member chunk across all members: image data, stacks, side allocations, heap and unused worker leases. Shared regions and their arenas do not count toward this cap. A successful placement adds its actual granted pages; a failed placement changes no member charge. A physical stop or partial launch cleanup after physical stop returns those pages once. A failed stop retains its charge. The cap limits aggregate member allocation, not any individual engine heap, and reserves no worker headroom. The separate 2 GiB committed backing budget is unchanged.

A launch beyond `members` fails with `EAGAIN` before any Worker exists and retains nothing. A launch that fails before its Worker is constructed returns its reservation exactly once.

With the default or an unbounded declaration, the budget charges what the owner grew: member data, stacks, grown heap, shared regions and region arenas, each once, never once per alias. Page 0 of every group stays reserved so address 0 is never valid. Freed chunks go to the group's free list, are zeroed on reuse, and stay charged to the backing budget until the group ends. Successful fresh `memory.grow` already supplies zero bytes and is not cleared again. Recycled pages, fixed backing and small-arena suballocations are cleared before reuse. A request that does not fit fails without growing: `group_grow` and `shm_create` return `-ENOMEM`. The filesystem's resident storage is accounted separately and is not part of this number.

With an explicit bounded declaration the group memory is fixed, with 16,384 initial and maximum pages by default. An explicit `maximumPages` overrides that default. The page reservation ledger charges the entire fixed backing before construction. `committedBytes` and the W3 budget count logical pages granted by the owner, not the full addressable fixed buffer. Logical growth clears the granted range without calling `memory.grow`. A stray write above that range does not trap on a fixed backing.

### Heap acquisition and retention

`runtime_shm.group_grow(n)` grants exactly `n` contiguous 64 KiB pages. Every call goes to the owner, which first reuses a free range and otherwise acquires exactly `n` pages. There are no speculative member leases or unused lease remainders. A one-page request adds at most 65,536 bytes to `committedBytes` and the W3 charge, even after earlier large requests. Reuse adds zero. Refusal changes neither backing nor the charge.

For a growable group, this is also the bound on the increase in `memory.buffer.byteLength` per call. It is not a bound on browser reservation or resident memory. The declared memory maximum is separate, and an explicit bounded profile has already reserved its entire fixed backing at group creation. That profile cannot provide a 64 KiB total physical acquisition bound for a small allocator request.

All granted heap pages stay owned by the member until its successful physical stop, even if the guest allocator frees their contents. Failed stops retain those exact pages as debt. After a successful stop, the pages become zeroed-on-reuse free ranges for later members or shared regions. They remain charged at the group's high-water mark until the group ends, since WebAssembly memory cannot shrink. Acquisition adds no pages beyond the caller's request, and retention adds no unused member lease pages. Total W3 backing remains bounded by `budgetBytes` across groups and by `maximumPages * 65,536` within each group, including reserved page 0, data, stacks and shared regions.

Allocators using this profile must account for their own page rounding and retained segments. Exact host grants do not establish an allocator's total waste bound or the browser's physical memory use. In particular, the group profile supports QuickJS heap growth, but these guarantees alone do not prove a 64 KiB bound for the whole QuickJS process.

An unexposed fixed backing can return to its exact-shape pool after every member physically stops. Before another group receives it, every addressable byte is cleared, including pages never logically granted. A buffer returned by `MemoryGroupHandle.buffer()` is exposed and is never recycled. That method throws after its group ends.

## Lifetime and physical stop

A member's memory, holds, member-owned transit pins, watches and slot return only after the broker's successful physical stop of that exact incarnation: notifications disposed, `Worker.terminate()` returned, and adapter cleanup succeeded. Logical exit, signal selection or filesystem quiescence alone do not release anything. If any stop step fails, cleanup after a failed `terminate` proves nothing: the member is retained as debt, keeps its slot and memory charged, and broker disposal reports it, so the page guard is kept. Late requests from a stopped or indebted incarnation are never answered. A stale incarnation cannot release its replacement. Group-owned pins survive every individual member's release.

A member blocked in `futex_wait` is cancelled by that same hard stop. Group state lives with the page-side owner, never in a lock in guest memory, so it survives the stop.

The group ends when no member is reserved, launched, or retained. Publications, region metadata, pins and arenas are retired exactly once at that point, so a retained ended owner reports zero regions, holds, pins, watches and publications. Its `committedBytes` keeps the historical value; the page budget is what returns to zero. Its page-held reservation remains charged until safe pool reuse or a local finalization receipt. An external root receives the memory object in its bootstrap request, so its backing is treated as exposed and is never recycled.

A FUTEX watch is pending until the first `futex_wake` that selects it. The waker claims the hit atomically, so a later or concurrent one-count wake moves on to the next pending watch and never reports progress twice for one watch. A hit watch stays ready until `futex_unwatch`.

Output pointers are checked before an import changes owner state. A misaligned or out-of-bounds output span returns `-EINVAL` and leaves regions, holds and pins as they were.

## Regions and transit pins

A region is freed when it has no holders, pins or publications. Every pin has exactly one owner, either a member incarnation or its containing group:

- `shm_pin` creates a pin owned by the publisher. A failed or aborted publication unpins it.
- `shm_route(pin, pid)` hands the delivery to the member that will read it. A receiver that moves the port before reading routes it again to the new reader.
- `shm_accept` turns the pin into a hold of the owner. `shm_unpin` discards it (port closed, message dropped).
- The member owner's successful physical stop releases every pin it still owns.
- `shm_route_group(pin)` lets the current launched caller hand its own member pin to the group in one owner step. It preserves the ID and takes no new hold or quota charge. Unknown, unowned and already converted pins return `-EBADF` without mutation.
- A group pin survives all individual member releases. Any current launched member of that same group may unpin it, with one success and then `-EBADF`. `shm_route` and `shm_accept` reject group pins with `-EBADF`. Reserved, retained, released and replaced incarnations gain no authority. Ordinary member-pin and publication ownership rules stay unchanged.

Pin IDs are unsigned u32 values local to the caller's group. Coincident numbers in different groups name independent pins. Conversion uses no new ID and cannot bypass the existing total pin limit or identity-exhaustion refusal.

Guests must record a pin ID in surviving shared storage before converting it if survivors need to reclaim it after creator death. A committed conversion survives even if the creator stops before receiving its success reply. If release wins first, the member pin disappears with its owner and the old incarnation cannot convert it. Guests must stop using the bytes before unpinning; an exit report alone does not establish physical stop.

Unpinning returns an otherwise unreferenced region to the zeroed-on-reuse free list. It does not shrink committed backing, change member-page accounting or return a physical reservation. A long-lived group can explicitly reclaim group pins back to baseline. Pins deliberately left outstanding remain until group end, including while a reserved or retained member keeps the group alive.

## Publications

A publication is a group-owned, immutable set of one or two region references that a later member can attach to without an event-loop turn. Waffle treats `kind` as an opaque nonzero adapter tag and `meta` as an opaque u32.

- `shm_publish` needs a hold on `primary`, and on `companion` if it is nonzero and different. It validates everything first, then creates a complete publication in one owner step, or changes nothing.
- A publication holds its regions until it is withdrawn or the group ends. Its publisher's stop does not release it. A member that never reaches `shm_publish` has only member-owned staging holds, which its physical stop returns.
- `shm_publication_open` requires the exact `kind`, takes one hold on each region in one owner step, and returns the owner's own extents. A receiver should validate only the bytes it reads from guest memory.
- `shm_withdraw` succeeds once, and only for the live incarnation that published. A replacement in the same member slot is a different incarnation.

Allocation handles, pin IDs and publication tokens are separate identities. Each is a checked u32 counter that never wraps or repeats; an exhausted counter refuses with `EAGAIN` before charging anything. Handles and pin IDs are per group. Tokens are per page and return only through an output pointer, so a token above `0x7fffffff` is never mistaken for a negative errno. A token withdrawn, or from another group on the page, is `EBADF`. Numeric values from different identity domains may coincide.

The `publications` and `regions` limits are separate. A publication of two regions uses two region slots.

## Filesystem

Members borrow the runtime's existing filesystem service through their own identities, exactly as other launched workers do. They see the same tree within their admitted authority, start in the spawn's working directory, and see writes another member completed. Membership grants no additional filesystem authority. The ABI is in [Host ABI](host-abi.md#memory-group-imports).

## Browser gate

`tests/memory-group-browser-runner.ts` runs relocated PIE members through the real runtime, broker, bootstrap and link loader in Chromium. It is part of `bun run test:browser`. CI builds its fixture once in the libc job with the pinned wasi-sdk (`scripts/build-memory-group-fixture.ts`), records a receipt of the exact inputs, and the browser job verifies and runs that artifact through `MEMORY_GROUP_FIXTURE_DIR`. Locally, set `WASI_SDK_PATH` and the runner builds the fixture into its own scratch.
