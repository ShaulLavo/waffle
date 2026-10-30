# Link a shared-core program

`waffle/link` is optional. Ordinary runtime, core, process and preview1 worker
imports do not load it. A linked process owns one command core and explicit PIC
libraries. Waffle has no engine names or operation numbers.

## Prepare and execute

```ts
import { prepareLinkPlan, linkedWorkerHooks } from "waffle/link";

const plan = await prepareLinkPlan({
  core: {
    id: "core",
    source: coreBytes,
    cooperative: true,
    checkpoint: { module: "checkpoints", name: "poll" },
    initializeMemory: ["initialize_memory", "apply_data_relocs"],
    initialize: ["call_ctors"],
  },
  libraries: [
    {
      id: "engine",
      source: engineBytes,
      cooperative: true,
      checkpoint: { module: "checkpoints", name: "poll" },
      initializeMemory: ["initialize_memory", "apply_data_relocs"],
      initialize: ["call_ctors"],
    },
  ],
  reserve: "bun_core_alloc",
});
// Send both fields as part of the existing worker request.
const requestFields = { module: plan.entryModule, linkPlan: plan.toSource() };
// Inside the existing worker, compose these hooks with the application's executor.
const hooks = linkedWorkerHooks();
```

The executor uses `instantiate`, `initialize`, and `beforeFinish` from `hooks`.
If it already has a `beforeFinish`, it must call the linked hook there too.
Use the ordinary Waffle `bootstrap`, not a separate bootstrap. It installs the
process ABI and descriptors first, then races asynchronous admission against
startup cancellation. Memory binds before any allocation or side constructor.
The existing `instantiated` hook completes before initialization. Entry keeps
its existing final activity check and atomic launch commitment.

`toSource()` returns fresh exact bytes and configuration. The receiving worker
must prepare those bytes again. A cloned prepared object is not admitted.
Preparation snapshots every member before its first asynchronous operation.
Only compiled modules are cached. Each process gets new instances, memory,
table, stack globals, data GOT cells and initialization state.

For direct embedding, `instantiateLinkPlan(plan, {wasi, checkActive, bindMemory})`
returns an owned group. Call `initialize()` before entry and `dispose()` from
the existing owner cleanup path. A failed initializer poisons the group.
Disposal clears reserved table slots without guest destructors, frees or unload.
The whole process heap is discarded after a trap or cancellation.

## Supported emitted profile

The core defines and exports `memory`, `__indirect_function_table`, `_start`,
and the selected `(i32 bytes, i32 alignment) -> i32` reservation function.
Reservation returns a nonzero aligned pointer or zero on allocation failure.
It runs after the core's memory and constructor stages, owns its static/stack/heap exclusions, and
never overlap another live allocation. Waffle checks bounds, alignment and
inter-library overlap. Core owns allocator and memory growth policy, including
both C and Rust allocation families. Side code must not grow memory itself.

Libraries use `dylink.0` memory-info without dependencies. Waffle allocates their
static bytes through core and grows the same table for aligned, nonzero ranges.
`env.memory`, `env.__indirect_function_table`, imported bases, and all other
`env` symbols resolve to those resources or actual core exports. In particular,
a mutable stack global is the identical object, not a copied pointer value.
WASI and `runtime_proc` imports retain their strict process-owned resolution.

Preparation checks each side's `env` function against the core export's complete
Wasm parameter and result types. Core preempts. When core has no export of that
name, the import binds to the same side's own export only if that export is a
defined function (not a re-exported import) of the identical type. wasm-ld emits
this import/export pair for every visible definition in a shared library so the
definition stays preemptible. Such imports go through a generated typed relay
module: each relay export does `call_indirect` with the exact type through a
target slot that Waffle reserves in the shared table and fills with the actual
definition right after the side instantiates, before relocation or
constructors. Target slots are distinct from the side's own element entries,
which may hold the relay itself. No other library or JS object is searched. Supported `dylink.0` import-info records mark
direct `env` functions weak and undefined (`0x11`). A present provider binds
normally. A missing direct weak function remains an error; Waffle supplies no
replacement callable. Imports without a record require a provider.
Records must name an imported `env` function. Other flags, duplicate or
conflicting records, unmatched names, and malformed payloads are rejected.
Global imports retain their Wasm type and mutability. Core globals must match;
the existing data GOT still requires immutable core i32 address exports.

Defined side globals may use `i32.const` or the extended-const form
`global.get <imported base> i32.const k i32.add` with `__memory_base` or
`__table_base`. Relative globals must stay within that base's reservation,
including its one-past address, and their final addresses must not overflow wasm32.
Active default-index segments use their imported base global,
optionally plus a constant, and must lie inside the `dylink.0` reservation
without overlapping each other. Passive data requires a nonempty
`initializeMemory` list. A passive member that exports the generic
`__wasm_apply_data_relocs` must list that function in `initializeMemory`, after
its own memory initialization stage. A PIE core must also declare that
relocation. An active-only library may omit it; Waffle runs the generic
relocation automatically first in that library's memory phase. A declared
relocation is never run automatically. Waffle validates the ordered memory
and constructor lists by function identity, so aliases count as duplicates.
The core's memory stages run before `instantiateLinkPlan` returns. Then the
existing `instantiated` hook runs, `initialize()` runs core constructors and
links libraries in plan order, and the caller owns `_start`. Libraries are
published only after initialization succeeds. Preparation rejects `_start`,
repeated function targets and relocation in the constructor list.

`GOT.mem` names resolve only to immutable core i32 address exports inside the
same memory: nonzero and below the memory size, except the linker stack bounds
`__stack_low` and `__stack_high`, which may equal either edge. Libraries share
mutable data GOT cells initialized with those addresses. Waffle does not
interpret the objects or substitute values.

`GOT.func` cells are per library. A core function provider uses its existing
table slot when one holds that exact function, otherwise a new slot from the
same table allocator; a same-side definition uses its target slot. Export aliases of the same definition
share that slot. A core export of the wrong kind is an error. Other GOT
namespaces, TLS, exception tags, true Wasm start sections, cycles, symbol
searches, dlopen and unload are unsupported and rejected.

## Trust and cancellation

Every member needs explicit cooperative trust and a named checkpoint function
import. The producer must test checkpoints on every unbounded path. Merely
having the import does not prove coverage. This is not hostile-byte admission;
Waffle's ordinary source rewriter still rejects dylink modules. The producer
also owns proof that side code has no independent memory growth or allocator.
Do not label an uninstrumented engine cooperative just to pass admission.
