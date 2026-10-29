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
    linkPlan: plan.toSource(),
  },
  memoryGroup: "new", // or "inherit" (the parent's group), or a handle from memoryGroupOf(pid)
});
```

Admission reserves a member slot before the Worker is constructed. Every member of a group shares its leader's process directory; joining from another directory fails with `EINVAL`. `memoryGroupOf(pid)` returns `{ id, buffer() }` for a launched member: the group's shared bytes, never its growable `Memory`. `memoryGroups()` returns owner-side counters for each live group: members, reserved, retained, pids, regions, pins, holds, watches, `committedBytes`, `freeBytes` and `bypassed`. A settled root membership is dropped by the broker; only unsettled members stay reachable.

An adopted runtime root that runs its own worker calls `admitRootMemoryGroup(pid, join)` before posting its worker request, and transfers the returned `transfer` list with `request` as the worker request's `memoryGroup` field. The root's membership settles when its controller's `stop` succeeds during disposal, or when the embedder calls `stopped()` after its own successful physical stop. An unsettled member makes runtime disposal fail.

The member image is a PIE linked with `-pie --experimental-pic --import-memory --shared-memory --import-table --max-memory=4294967296`. It imports `env.memory`, `env.__indirect_function_table`, `env.__memory_base`, `env.__table_base` and a mutable `env.__stack_pointer`. Waffle reads `dylink.0` memory-info, carves the data chunk and a private stack (`stackBytes`), and gives the image its own table with slot 0 left null. A link plan whose core has `dylink.0` is linked the same way, then its PIC libraries reserve through the core allocator as before. Constant data exports of such a core are relative to its `__memory_base`.

Admission refuses a group image that could grow the shared memory around its owner. The link loader decodes every function body of a PIE core and of each library linked into it, and rejects `memory.grow` and any export of the memory; an opcode it cannot decode is refused too. Growth goes through `runtime_shm.group_grow`: in wasi-libc that is the `sbrk` patch, and a Rust core must route its global allocator there as well. Bootstrap refuses a group member without a link plan. A trusted custom executor still holds the `Memory` object; if anything grows it outside the owner, the owner charges the real size truthfully, reports `bypassed`, and admits nothing more into that group.

`workerMemory()` samples a member's bound memory, which is the whole group memory. Use `memoryGroups()` for a group's committed backing; do not sum worker samples across members.

## Policy

`createRuntime({ memoryGroups })` sets runtime policy. Every limit is configurable.

| Field         | Default | Meaning                                                                       |
| ------------- | ------- | ----------------------------------------------------------------------------- |
| `members`     | 16      | Admitted members per group, including the leader and pending reservations      |
| `parallelism` | 1       | Reported to every member through `runtime_shm.parallelism()`                    |
| `budgetBytes` | 2 GiB   | Committed group backing for the whole page, summed across groups                |
| `maximumPages`| 65536   | Address-space maximum of one group (4 GiB). Declared maximum is not a charge    |
| `regions`, `pins`, `watches` | 4096, 4096, 1024 | Bounded metadata per group                        |
| `groups`      | 64      | Live groups per page                                                            |
| `stackBytes`  | 1 MiB   | Private stack per PIE member image                                              |

A launch beyond `members` fails with `EAGAIN` before any Worker exists and retains nothing. A launch that fails before its Worker is constructed returns its reservation exactly once.

The budget charges what the owner grew: member data, stacks, grown heap, shared regions and region arenas, each once, never once per alias. Page 0 of every group stays reserved so address 0 is never valid. Freed chunks go to the group's free list, are zeroed on reuse, and stay charged until the group ends. A request that does not fit fails without growing: `group_grow` and `shm_create` return `-ENOMEM`. The filesystem's resident storage is accounted separately and is not part of this number.

## Lifetime and physical stop

A member's memory, holds, transit pins, watches and slot return only after the broker's successful physical stop of that exact incarnation: notifications disposed, `Worker.terminate()` returned, and adapter cleanup succeeded. Logical exit, signal selection or filesystem quiescence alone do not release anything. If any stop step fails, cleanup after a failed `terminate` proves nothing: the member is retained as debt, keeps its slot and memory charged, and broker disposal reports it, so the page guard is kept. Late requests from a stopped or indebted incarnation are never answered. A stale incarnation cannot release its replacement.

A member blocked in `futex_wait` is cancelled by that same hard stop. Group state lives with the page-side owner, never in a lock in guest memory, so it survives the stop.

The group ends, and its backing is released, when no member is reserved, launched or retained.

A FUTEX watch is pending until the first `futex_wake` that selects it. The waker claims the hit atomically, so a later or concurrent one-count wake moves on to the next pending watch and never reports progress twice for one watch. A hit watch stays ready until `futex_unwatch`.

Output pointers are checked before an import changes owner state. A misaligned or out-of-bounds output span returns `-EINVAL` and leaves regions, holds and pins as they were.

## Regions and transit pins

A region is freed when it has no holders and no pins. Every pin has exactly one owner, a member incarnation:

- `shm_pin` creates a pin owned by the publisher. A failed or aborted publication unpins it.
- `shm_route(pin, pid)` hands the delivery to the member that will read it. A receiver that moves the port before reading routes it again to the new reader.
- `shm_accept` turns the pin into a hold of the owner. `shm_unpin` discards it (port closed, message dropped).
- The owner's successful physical stop releases every pin it owns. A pin outlives a dead member only when it was routed to a surviving consumer.

There is no group-end-only reclamation: a long-lived group that keeps recycling workers returns to its baseline counters.

## Filesystem

Members borrow the runtime's existing filesystem service through their own identities, exactly as other launched workers do. They see the same tree within their admitted authority, start in the spawn's working directory, and see writes another member completed. Membership grants no additional filesystem authority. The ABI is in [Host ABI](host-abi.md#memory-group-imports).

## Browser gate

`tests/memory-group-browser-runner.ts` runs relocated PIE members through the real runtime, broker, bootstrap and link loader in Chromium. It is part of `bun run test:browser`. CI builds its fixture once in the libc job with the pinned wasi-sdk (`scripts/build-memory-group-fixture.ts`), records a receipt of the exact inputs, and the browser job verifies and runs that artifact through `MEMORY_GROUP_FIXTURE_DIR`. Locally, set `WASI_SDK_PATH` and the runner builds the fixture into its own scratch.
