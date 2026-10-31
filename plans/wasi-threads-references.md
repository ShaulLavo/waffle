# Thread support: research, toolchains, and prior art

Research date: 2026-10-31. Companion to the proposed
[implementation plan](wasi-threads.md). Facts about upstream projects are distinguished from
Waffle recommendations and future qualification. No Waffle threaded release or application port
is established by this document. Recheck producer versions and proposal status when implementing.

## Alternatives and recommendation

| Approach                           | Fit and tradeoff                                                                                                                                                                                                                  | Recommendation                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| WASI Preview 1 `wasi.thread-spawn` | Matches the requested Rust/wasi-libc targets and Waffle's existing WASI adapter. Browser shared memory/atomics provide synchronization; Waffle supplies thread lifecycle and process services. The proposal is explicitly legacy. | Implement now behind a small ABI module over reusable thread ownership.                                                 |
| Emscripten pthread environment     | Mature Worker management, proxying, startup coordination, and memory-view refresh. A C pthread API does not imply Emscripten's emitted imports/runtime match wasi-libc's.                                                         | Borrow implementation lessons. A compatible Emscripten loader is a separate adapter project.                            |
| WASIX / Wasmer SDK                 | Concrete browser worker/task architecture and a broader process/network ABI. Adoption overlaps Waffle's existing Unix-like services and changes the guest/toolchain contract.                                                     | Study it; do not migrate the runtime merely to obtain the spawn primitive. Review exact source licenses before copying. |
| Shared-everything threads          | Future model extends sharing beyond linear memory and adds thread-local facilities and management builtins. Listed at Phase 1 in the inspected proposal index.                                                                    | Track it, but do not make the cross-browser release depend on unqualified engine/toolchain support.                     |
| WASI 0.3 / component model         | Current 0.3.2 material includes component async/future/stream facilities. Those concern component execution/composition; they do not implement the stock Preview 1 pthread ABI or give Rust `Command` a Waffle backend.           | Future direction for composition and I/O; no substitute for this feature's current compatibility work.                  |

Primary status sources, pinned where available:

- [wasi-threads legacy status and design](https://github.com/WebAssembly/wasi-threads/blob/f8ea03cc0ffbde143415e945497de112f6f9fd53/README.md).
- [Shared-everything overview](https://github.com/WebAssembly/shared-everything-threads/blob/de560922268ca89fd3303776c5c1b8f123da2aec/proposals/shared-everything-threads/Overview.md)
  and [proposal phase index](https://github.com/WebAssembly/proposals/blob/df6a2aca1cd9d779eb4f2f3e19dae8277f336015/README.md).
- [WASI 0.3.2 overview](https://github.com/WebAssembly/WASI/blob/463701e0f6c575a5d24ae31c2ec1e0ebf09d28e1/specifications/wasi-0.3.2/Overview.md)
  and [component features](https://github.com/WebAssembly/WASI/blob/463701e0f6c575a5d24ae31c2ec1e0ebf09d28e1/docs/ComponentModelFeatures.md).
- [Emscripten pthread documentation](https://emscripten.org/docs/porting/pthreads.html).

Memory groups are an internal reuse opportunity, not another spelling of threads. Waffle's current
group members have separate process identity, statics, stacks, tables, heap allocation, descriptors,
and filesystem identities in one shared backing, and use a PIE/linking contract. Stock threaded
commands need shared process resources and their compiler's existing static layout. Reuse the
owner/accounting/fence principles, not the group ABI or layout. Source:
[Waffle memory groups](../docs/memory-groups.md).

## ABI and toolchain

### Required host/guest convention

The canonical ABI imports `wasi.thread-spawn(i32 start_arg) -> i32`. Success is a positive TID in
`[1, 2^29)`; failure is negative. The child instance imports the same shared memory and calls
`wasi_thread_start(i32 tid, i32 start_arg) -> ()`. The argument is opaque to the host; do not parse
libc-private structures or allocate a second host-defined TLS/stack layout.

Joining, locking, TLS/TSD, and stack setup belong to guest libc/compiler code using Wasm memory
and atomics. Normal child-entry return ends that thread. A trap or `proc_exit` in any thread ends
the process. Waffle implements that logical behavior while preserving its own host-resource fences
before Worker termination. Sources:
[ABI](https://github.com/WebAssembly/wasi-threads/blob/f8ea03cc0ffbde143415e945497de112f6f9fd53/wasi-threads.abi.md)
and [execution/termination convention](https://github.com/WebAssembly/wasi-threads/blob/f8ea03cc0ffbde143415e945497de112f6f9fd53/README.md).

### Producer entry points to qualify

These are documented build entry points, not commands executed or artifacts qualified by this
planning PR. Pin versions and record actual generated imports/features in S0.

| Producer     | Configuration                                                                                                                                                                                                               | Qualification boundary                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Rust         | `rustup target add wasm32-wasip1-threads`, then `cargo build --target wasm32-wasip1-threads`.                                                                                                                               | Bundled std/libc/CRT as one coherent producer; ordinary `std::thread` without a Waffle-specific spawn wrapper. |
| C            | Matching wasi-sdk compiler/sysroot, threaded WASI target and `-pthread` at compilation/link. Use the target spelling supported by the pinned SDK, including its documented `wasm32-wasi-threads` spelling where applicable. | Real wasi-libc pthreads, not an Emscripten artifact selected solely because source uses pthread APIs.          |
| Mixed Rust/C | Matching external Clang/sysroot with the Rust target's documented external-libc configuration, including `-C target-feature=-crt-static` where required.                                                                    | Separate producer gate; do not combine arbitrary bundled Rust CRT objects and external libc.                   |

Record import/export/shared-memory options and `--max-memory` in the fixture manifest even when
the target supplies them. Rust passes linker options with `-C link-arg=...`; Clang uses `-Wl,...`.
Do not layer conflicting target defaults/overrides. Sources:
[Rust target documentation](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip1-threads.html),
[wasi-sdk](https://github.com/WebAssembly/wasi-sdk), and
[wasi-libc](https://github.com/WebAssembly/wasi-libc).

The inspected published Rust target definition imports/exports shared memory, sets
`singlethread = false`, enables atomics/bulk-memory/mutable-globals, and supplies a declared maximum
of `1073741824` bytes (1 GiB). That is a producer default, not Waffle's mobile policy. The host can
supply a compatible smaller actual maximum. Source:
[Rust target definition](https://doc.rust-lang.org/stable/nightly-rustc/src/rustc_target/spec/targets/wasm32_wasip1_threads.rs.html).

The pthread backend's current minimum default spawned stack is 2 MiB, with configurable alternatives.
Account for the qualified producer's actual stack allocations inside shared memory; do not impose
this Rust value on every language. Default Wasm panic behavior is abort; a child panic must not be
advertised as a recoverable join error under that configuration. Any unwind configuration gets a
separate producer/runtime gate. Sources:
[Rust pthread backend](https://doc.rust-lang.org/src/std/sys/thread/unix.rs.html) and
[Wasm target base](https://doc.rust-lang.org/nightly/nightly-rustc/src/rustc_target/spec/base/wasm.rs.html).

### Build mismatches are not missing Waffle imports

A documented wasi-sdk 34 transition removed libc TLS initialization symbol `__wasi_init_tp`.
Combining an older Rust startup object with that libc can leave an unresolved
`env.__wasi_init_tp` import. The same discussion records another emnapi C helper-signature mismatch.
Pin compiler/sysroot/CRT/archives together and inspect the output; a no-op host stub is not a sound
fix. Use tested combinations rather than an issue's predicted future release boundary. Source:
[napi-rs issue 3491](https://github.com/napi-rs/napi-rs/issues/3491).

Waffle also has an existing, separate libc preopen-scanner patch for inherited FD layouts. Thread
support does not erase that producer requirement or justify synthetic prestat answers. Qualify the
threaded sysroot with the same descriptor-placement contract and keep the scanner patch owned by
the existing build route. The bundled Rust producer is sufficient for baseline fixtures whose
preopens precede all non-preopen descriptors. Inherited fd 3 with root at fd 4 needs the existing
scanner patch and a separately qualified Rust link against a coherent patched threaded libc/sysroot.
Include that producer in inherited-descriptor acceptance; this does not require a std fork.
Source: [Waffle guest libc](../docs/wasi-libc.md).

### Rayon and crate compatibility

Rayon uses Rust standard thread APIs. Its implicit global-pool fallback is specific to thread
creation failing with `Unsupported`; an explicitly built pool returns an error. Resource exhaustion
is not a general promise of fallback, and work that expects independently running workers must not
be treated as equivalent to a one-thread substitute. Test an explicit pool with distinct TIDs and
actual concurrent progress. Sources:
[Rayon API documentation](https://github.com/rayon-rs/rayon/blob/main/rayon-core/src/lib.rs) and
[registry implementation](https://github.com/rayon-rs/rayon/blob/main/rayon-core/src/registry.rs).

Pool sizing normally uses `std::thread::available_parallelism()` unless configured. Browser
`hardwareConcurrency` is not automatically exposed through that guest API. Qualify its actual
result and use explicit application pool sizing or `RAYON_NUM_THREADS` where appropriate. Host caps
remain authoritative. Audit each crate's target cfgs, feature flags, C dependencies, subprocesses,
network assumptions, and panic strategy; the target triple alone is not proof of portability.

## Rust process spawning remains separate

Rust's WASI process backend selects unsupported behavior. A compiled `Command` call that returns
an error internally never reaches a hypothetical host spawn import, so a JavaScript shim cannot
repair it. Sources: [Rust process backend selection](https://doc.rust-lang.org/src/std/sys/process/mod.rs.html)
and [WASI process-spawn discussion](https://github.com/WebAssembly/WASI/issues/414).

Realistic options without a std fork are application-level use of Waffle's
[process-consumer crate](../packages/process-consumer), an application/dependency process abstraction
with a Waffle backend, or upstream work on a process interface and Rust backend. The latter has no
assumed delivery schedule. Recompiling applications with a targeted process adapter is different
from running an unchanged binary. WASI 0.2/0.3 does not currently make stock `Command` call
`runtime_proc`. WASIX is a different guest/runtime commitment, not a patch-free shim for stock
Preview 1; see [its Rust toolchain](https://wasix.org/docs/language-guide/rust/installation/).

Keep this feature independent of a Starship port. The supplied brief reports Starship/gix thread
failures and separate `Command` failures, and says the prompt is being replaced. The referenced
`starship-port-analysis.md` attachment was not available in this checkout; this plan does not claim
to have independently verified its exact source locations or reproduced its results.

## Workload value and remaining gaps

These are candidate benefits, not completed Waffle ports. Distinguish successful creation of
required threads from speedups in code that already has a usable sequential path.

| Candidate                                 | Thread value                                                                       | Remaining boundary / evidence                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt tools / Starship-like dependencies | Removes failures in paths that require thread creation.                            | Project brief supplies the Starship case. Process execution and OS modules remain separate; no renewed Starship port is proposed.                                                                                                   |
| gix / gitoxide                            | Enables configured parallel features and thread-creating integrations.             | Reduced single-thread feature sets exist; transports, subprocess filters, and filesystem assumptions remain. [Feature definitions](https://github.com/GitoxideLabs/gitoxide/blob/main/gix/Cargo.toml).                              |
| ripgrep                                   | Parallel traversal/search can improve multi-file workloads.                        | Sequential search is useful already; preprocessing commands and optional native libraries remain separate. [Upstream FAQ](https://github.com/BurntSushi/ripgrep/blob/master/FAQ.md).                                                |
| SWC                                       | Enables parallel transform/minify paths when the selected build uses them.         | Browser transforms/minification already exist; native-addon/plugin integration is additional. [Browser minification APIs](https://swc.rs/docs/configuration/minification).                                                          |
| Rolldown                                  | An existing threaded WASI distribution demonstrates direct relevance to bundling.  | Its napi-rs/emnapi loader, callbacks, async runtime, and disposal need their own adapter. See the pinned browser loader below.                                                                                                      |
| Oxc                                       | Existing Wasm bindings are a candidate for integration and parallel feature paths. | A threaded artifact does not prove an individual parser operation needs multiple threads. [Maintainer discussion](https://github.com/oxc-project/oxc/discussions/3311).                                                             |
| Lightning CSS                             | Candidate for native-style parallel/bundling work.                                 | Browser transform/minify already exists; omitted browser bundle/visitor features do not automatically appear when threads are added. [Official docs](https://lightningcss.dev/docs.html).                                           |
| SQLite                                    | Supports applications choosing a shared threaded engine configuration.             | SQLite is useful without threads; its canonical Wasm configuration disables thread safety/internal workers. A threaded build/VFS is separate qualification. [Build options](https://sqlite.org/wasm/doc/trunk/module-symbols.html). |
| DuckDB-Wasm                               | Parallel query execution has a concrete COI pthread bundle.                        | Default single-thread operation exists; storage, extensions and memory budgets remain separate. [Instantiation documentation](https://duckdb.org/docs/current/clients/wasm/instantiation).                                          |

SWC's published [swc_core feature definitions](https://docs.rs/crate/swc_core/77.1.2/source/Cargo.toml.orig)
include concurrency/parallel options such as `ecma_minifier_concurrent`, `base_concurrent`,
`parallel_chili`, and `parallel_rayon`. These support the parallel-path candidate separately from
the browser minification API; they do not turn a native-addon build into a plain WASI command.

Prioritize tiny standard-library fixtures, explicit Rayon, and a representative search workload
before large bundlers or engines. Select real ports according to development-environment value,
remaining nonthread blockers, and measured startup/memory cost. No speedup percentage is established
by this research.

## Browser primitives and memory references

- [Core limit matching](https://webassembly.github.io/spec/core/valid/matching.html#limits): supplied
  imported memory can have a smaller compatible maximum.
- [Threads memory.grow semantics](https://webassembly.github.io/threads/core/exec/instructions.html#exec-memory-grow)
  and [current JavaScript API](https://webassembly.github.io/spec/js-api/index.html): distinguish
  native instruction failure from the JS API and refresh current views.
- [WebAssembly threads overview](https://github.com/WebAssembly/threads/blob/main/proposals/threads/Overview.md):
  shared memory/atomics and reservation rationale.
- [MDN SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
  and [WebAssembly.Memory](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript/Reference/Global_Objects/WebAssembly/Memory):
  browser API reference; use specifications and actual engine qualification for correctness.
- [HTML Worker termination](https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker):
  parallel abort and discarded tasks, without a browser exit-acknowledgement API.
- [WebKit reservation discussion](https://bugs.webkit.org/show_bug.cgi?id=218693),
  [iOS reservation regression](https://bugs.webkit.org/show_bug.cgi?id=255103), and
  [Emscripten mobile maximum issue](https://github.com/emscripten-core/emscripten/issues/24078):
  useful failure history, not a present universal safe-cap specification.

## Prior art to clone

Pin the listed revision before comparing behavior. Links identify source, not blanket permission
to copy every bundled dependency. This PR contains original planning prose, with no copied upstream
implementation. Any later adaptation must follow Waffle's `docs/bun-patches.md` provenance rules
and retain the applicable file-specific notices.

### Microsoft VS Code wasm-wasi

Clone: [microsoft/vscode-wasm.git](https://github.com/microsoft/vscode-wasm.git).
Inspected revision: `7585d3902cad4948f2f8852006d3714b2a9afb1f`.

- [Browser process](https://github.com/microsoft/vscode-wasm/blob/7585d3902cad4948f2f8852006d3714b2a9afb1f/wasm-wasi-core/src/web/process.ts):
  Worker creation, shared-memory handoff, thread lifecycle.
- [Common process](https://github.com/microsoft/vscode-wasm/blob/7585d3902cad4948f2f8852006d3714b2a9afb1f/wasm-wasi-core/src/common/process.ts):
  one owner-side descriptor table supplied to per-thread services.
- [Host calls](https://github.com/microsoft/vscode-wasm/blob/7585d3902cad4948f2f8852006d3714b2a9afb1f/wasm-wasi-core/src/common/host.ts)
  and [service dispatch](https://github.com/microsoft/vscode-wasm/blob/7585d3902cad4948f2f8852006d3714b2a9afb1f/wasm-wasi-core/src/common/service.ts):
  synchronous worker waits serviced asynchronously by a responsive owner.
- [Thread worker](https://github.com/microsoft/vscode-wasm/blob/7585d3902cad4948f2f8852006d3714b2a9afb1f/wasm-wasi-core/src/web/threadWorker.ts):
  `wasi_thread_start` entry and normal completion.

Closest browser ownership reference. Copy the ownership/progress separation, while keeping
Waffle's direct file path and stronger filesystem fences. Its immediate termination order does not
provide Waffle's lock-safety guarantee. [MIT license](https://github.com/microsoft/vscode-wasm/blob/7585d3902cad4948f2f8852006d3714b2a9afb1f/wasm-wasi-core/LICENSE.md).

### emnapi

Clone: [toyobayashi/emnapi.git](https://github.com/toyobayashi/emnapi.git).
Inspected revision: `248e308b0af0017f72a070ad2012671e6732aac0`.

- [wasi-threads adapter](https://github.com/toyobayashi/emnapi/blob/248e308b0af0017f72a070ad2012671e6732aac0/packages/wasi-threads/src/wasi-threads.ts):
  spawn integration and `getThreadSpawnResultView` cross-agent refresh.
- [Thread manager](https://github.com/toyobayashi/emnapi/blob/248e308b0af0017f72a070ad2012671e6732aac0/packages/wasi-threads/src/thread-manager.ts)
  and [tests](https://github.com/toyobayashi/emnapi/blob/248e308b0af0017f72a070ad2012671e6732aac0/packages/wasi-threads/test/index.js).

Useful startup/failure and growth regressions. Supplying one shared memory to Workers does not
itself enforce Waffle's aggregate backing budget. Study reuse options after establishing fresh-worker
lifecycle correctness. [MIT license](https://github.com/toyobayashi/emnapi/blob/248e308b0af0017f72a070ad2012671e6732aac0/packages/wasi-threads/LICENSE).

### Emscripten

Clone: [emscripten-core/emscripten.git](https://github.com/emscripten-core/emscripten.git).
Inspected revision: `91d14a4c6729752ed146751416fe96598cac3dc7`.

- [Pthread machinery](https://github.com/emscripten-core/emscripten/blob/91d14a4c6729752ed146751416fe96598cac3dc7/src/lib/libpthread.js).
- [Memory construction](https://github.com/emscripten-core/emscripten/blob/91d14a4c6729752ed146751416fe96598cac3dc7/src/runtime_init_memory.js),
  [growth helpers](https://github.com/emscripten-core/emscripten/blob/91d14a4c6729752ed146751416fe96598cac3dc7/src/lib/libcore.js),
  and [views](https://github.com/emscripten-core/emscripten/blob/91d14a4c6729752ed146751416fe96598cac3dc7/src/runtime_common.js).
- [Pthreads guide](https://emscripten.org/docs/porting/pthreads.html): pooling, proxying, main-thread
  restrictions and startup progress.

Borrow view-refresh and coordination lessons. Waffle already runs guests off the page thread and
can keep its coordinator responsive; prewarming is a latency optimization. Emscripten's generated
JS allocator path is not proof of an aggregate multi-process quota, and standalone growth differs.
License: [MIT or Illinois/NCSA](https://github.com/emscripten-core/emscripten/blob/91d14a4c6729752ed146751416fe96598cac3dc7/LICENSE),
with separately licensed bundled material.

### Wasmer SDK

Clone: [wasmerio/wasmer-sdk.git](https://github.com/wasmerio/wasmer-sdk.git).
Inspected revision: `c352b08566e1564362c747758e3fe440e9d01a33`.

- [Wasm task execution](https://github.com/wasmerio/wasmer-sdk/blob/c352b08566e1564362c747758e3fe440e9d01a33/js/bindgen/src/tasks/task_wasm.rs):
  attaching memory to execution contexts.
- [Architecture notes](https://github.com/wasmerio/wasmer-sdk/blob/c352b08566e1564362c747758e3fe440e9d01a33/docs/phase-1/architecture.md):
  useful ownership/resource distinctions; design prose is not proof that every enforcement path ships.

Useful broader runtime reference, with substantial ABI overlap if adopted wholesale. The inspected
[binding license](https://github.com/wasmerio/wasmer-sdk/blob/c352b08566e1564362c747758e3fe440e9d01a33/js/bindgen/LICENSE)
is titled Modified MIT License and adds a prominent Wasmer-display condition above stated commercial
usage/revenue thresholds. Do not label this revision plain MIT; review the actual terms before
copying implementation.

### Rolldown and napi-rs consumer evidence

Clone: [rolldown/rolldown.git](https://github.com/rolldown/rolldown.git).
Inspected revision: `0960acb437c4e6cd86e530b25fc19679ec844fdd`.

- [Browser WASI loader](https://github.com/rolldown/rolldown/blob/0960acb437c4e6cd86e530b25fc19679ec844fdd/packages/rolldown/src/rolldown-binding.wasi-browser.js):
  real emnapi/Workers/shared-memory integration for relevant tooling.
- [Companion Node/WASI loader](https://github.com/rolldown/rolldown/blob/0960acb437c4e6cd86e530b25fc19679ec844fdd/packages/rolldown/src/rolldown-binding.wasi.cjs):
  crash state, locks abandoned by failed threads, and delayed-callback/cleanup hazards.

Use the failure cases as tests, not a wholesale loader transplant. The browser loader's 1 GiB
initial / 4 GiB maximum memory and hardware-concurrency-derived worker counts are not iPhone
defaults to copy. Node-API support is additional to the plain command ABI.
[License and third-party notices](https://github.com/rolldown/rolldown/blob/0960acb437c4e6cd86e530b25fc19679ec844fdd/LICENSE).

### Wasmtime historical host semantics

Clone: [bytecodealliance/wasmtime.git](https://github.com/bytecodealliance/wasmtime.git).
Historical revision: `ff639ef68baed46aaeda8fefcf3f1bdba9e59bd2`.

- [Historical wasi-threads source](https://github.com/bytecodealliance/wasmtime/blob/ff639ef68baed46aaeda8fefcf3f1bdba9e59bd2/crates/wasi-threads/src/lib.rs):
  shared-memory imports, TIDs, entry validation, and fatal process semantics.
- [Removal commit](https://github.com/bytecodealliance/wasmtime/commit/b4b23fe583173131a047141947a785b4c1c646ae):
  removed on 2026-06-05; identifies v46 as the final ordinary release with support and notes LTS
  retention. The original brief's `main/crates/wasi-threads` link is therefore not a current path.

Useful ABI reference. Native whole-process exit is unsuitable for Waffle embedding and does not
replace per-connection cleanup. If used as a fixture oracle, pin a release retaining this ABI;
never assume latest Wasmtime supports it. License:
[crate metadata](https://github.com/bytecodealliance/wasmtime/blob/ff639ef68baed46aaeda8fefcf3f1bdba9e59bd2/crates/wasi-threads/Cargo.toml)
and [Apache-2.0 with LLVM exception](https://github.com/bytecodealliance/wasmtime/blob/ff639ef68baed46aaeda8fefcf3f1bdba9e59bd2/LICENSE).

## Evidence boundaries

The research used Waffle documentation/source, upstream specifications/source, and documented
consumer failure cases. Proposed architecture and effort are our engineering recommendations.
This planning change did not build threaded guest artifacts, implement Waffle threads, benchmark
Worker overhead, establish an iPhone ceiling, or qualify the named applications. Those results are
required by the implementation plan's gates and must not be inferred from successful source review.
