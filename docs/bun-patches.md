# Changes to Bun and other upstream source

This ledger covers the Bun patch series, local changes to vendored dependencies, and copied or adapted upstream source outside vendor directories at this revision. Bun is pinned to `9510e74152073d850a18758ca41114d8f214ffa6` by `scripts/sync-bun.sh`. WebKit is Bun's fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`, pinned in `jsc/common.sh`.

Copied implementations include translations into another language and fragments retained inside otherwise original files. Generated upstream bundles and copied data tables are also listed. Directory names do not determine provenance.

Original adapters that call upstream APIs, implement the same public contract, or reproduce observed output without retaining an upstream implementation are bun-wasm source. They do not get a fork entry merely for being inspired by Bun or Node. Mixed files below identify the adapted portions separately from original host code.

Each row has one class. A file with independent changes has separate rows.

- **Port** means the change is required by wasm32, WASI, or the browser. Missing support for this new target is not a Bun bug.
- **Host feature** means bun-wasm adds a hook or behavior for its host.
- **Upstream bug** means the original code is incorrect independently of the new host. This includes incorrect 32-bit algorithms even when the distributed native Bun binary cannot reach them.

| Patch or source | Class | Change |
| --- | --- | --- |
| [Test fake-clock adapter](#test-fake-clock) | Host feature | Original TypeScript scheduler and Date adapter shared by all engines. |
| [`jsc/webkit-wasi.patch`, C-loop host interruption](#engine-interruption) | Host feature | Poll the process host at saved interpreter trap points; preserve native uncatchable termination. |
| [Engine signal adapters](#engine-interruption) | Host feature | Original QuickJS/JSC callbacks poll fatal cancellation without entering JS; handled signals stay pending for ordinary event-loop delivery. |
| [HTMLRewriter adapters and lol-html linkage](#htmlrewriter) | Host feature | Original parser sessions, async handler dispatch and streaming wrappers on all engines. |
| [X509Certificate adapters](#x509certificate) | Host feature | Original BoringSSL data bindings and Node certificate wrapper over existing KeyObjects. |
| [X.509 hostname option matcher](#x509-hostname-option-matcher) | Port | Adapt Bun's OpenSSL-compatible Rust matcher because BoringSSL removed four option behaviors. |
| [X.509 alternative name formatting and Node license](#x509-alternative-name-formatting) | Port | Translate Bun and Node certificate-name quoting to Rust without JSC and retain the Node MIT notices. |
| [Certificate regression fixtures](#certificate-regression-fixtures) | Port | Retain unchanged upstream certificate and test-key data for metadata, signature and escaping checks. |
| [`third_party/licenses/lol-html-LICENSE`](#htmlrewriter) | Port | Retain the vendored parser's BSD license for wasm distribution. |
| [Third-party interrupt instrumentation](#third-party-interrupt-instrumentation) | Host feature | Original TypeScript binary rewriter, content-addressed loader and rescued browser fixtures; module-internal countdowns avoid per-entry host calls. |
| [`crates/bunwasm-jsc/cpp/helpers.cpp`, finalizer dispatch](#jsc-finalizer-dispatch) | Host feature | Original adapter for full collection and deferred cleanup in the wasm event loop. |
| [`scripts/transpile-runtime.ts`, runtime TypeScript](#runtime-typescript) | Host feature | Original build adapter and guest types; preserve runtime factory loading. |
| [Standard output error adapters](#standard-output-errors) | Host feature | Original Rust and worker adapters preserve EPIPE and block on temporary output backpressure. |
| [Worker threads adapters](#worker-threads-adapter) | Host feature | Original TypeScript worker, clone, port-routing, browser module loading and stream adapters over separate host guest instances, with distinct control-pipe and final-signal selectors. |
| [Cross-worker descriptor ownership](#cross-worker-descriptor-ownership) | Host feature | Original process and filesystem adapters transfer open descriptions, preserve shared file offsets and revoke process-owned endpoints before publishing exit. |
| [Process-owned pipe adapters](#process-owned-pipe-adapters) | Host feature | SharedPipe-derived ring copying with original per-process publication, admission-validated EOF, reader relay and descriptor-transfer adapters. |
| [Guest process ABI](#guest-process-abi) | Host feature | Original runtime_proc imports, nonblocking filesystem preparation, preview1 notification waits and lazy browser process integration. |
| [0001](#0001-platform-selection-and-pointer-layout) | Port | Select WASI implementations and support 32-bit layouts and pointer tags. |
| [0002](#0002-filesystem-threading-and-layout) | Port | Add WASI directory iteration, stat, watcher, and single-thread primitives. |
| [0003](#0003-transpiler-dependencies) | Port | Supply WASI wakers, CPU features, crash, and resolver implementations. |
| [0004](#0004-inline-thread-pool) | Port | Drain scheduled tasks on the calling thread. |
| [0005](#0005-monotonic-timer) | Port | Use WASI's monotonic clock instead of the bare-wasm timer stub. |
| [0006](#0006-open-flags-and-file-descriptor-paths) | Port | Adapt WASI open flags and track paths for opened descriptors. |
| [0007](#0007-string-equality) | Upstream bug | Correct string comparisons that skip bytes with 32-bit `usize`. |
| [0008](#0008-await-context-hooks) | Host feature | Add optional printer hooks to preserve browser async context. |
| [0009](#0009-bake-completion) | Port | Complete bake bundles through the synchronous WASI event loop. |
| [0010](#0010-semantic-import-locations) | Host feature | Collect semantic import locations in Bun's scan and print passes for host module linking. |
| [`jsc/webkit-wasi.patch`, platform hunks](#webkit-platform-hunks) | Port | Compile the C-loop interpreter and WTF for WASI. |
| [`jsc/webkit-wasi.patch`, module slots](#webkit-module-import-slots) | Upstream bug | Give import slots a full JSValue stride and initialize the whole slot. |
| [`jsc/webkit-wasi.patch`, non-JIT declarations](#webkit-non-jit-declarations) | Upstream bug | Expose a required enum without DFG and add two missing includes. |
| [`third_party/libc/src/wasi/mod.rs` and `posix_compat.rs`](#libc) | Port | Declare missing WASI POSIX types and functions. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, buffer tags](#quickjs-data-conversion) | Host feature | Query ordinary and shared buffer classes without throwing. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, call locations](#quickjs) | Host feature | Match JSC's call-site stack columns. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, inspection helpers](#quickjs) | Host feature | Inspect keys and iterator entries without consuming them. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, async context](#quickjs) | Host feature | Capture and restore async context in promise reactions. |
| [`third_party/rquickjs-sys/build.rs`](#quickjs) | Host feature | Rebuild when the locally patched C sources or binding header change. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, WASI stack checks](#wasm-stack-guards) | Port | Restore the stack checks on WASI and reserve shadow stack for host frames, so recursion throws before the host wasm stack runs out. |
| [`third_party/rquickjs-sys/quickjs/libregexp.c`, WASI stack reservation](#wasm-stack-guards) | Port | Reserve shadow stack per regexp group nesting level, so the parser's stack check trips before the host wasm stack runs out. |
| [`jsc/webkit-wasi.patch`, `StackBounds.cpp` budget](#wasm-stack-guards) | Port | Bound JSC's native recursion to a host-configurable budget below the host wasm stack. |
| [Console recursion fixture](#wasm-stack-guards) | Port | Adapt Bun's console-constructor stack exhaustion control to a standalone fixture. |
| [`jsc/build-icu.sh`, makefile rewrite](#icu) | Port | Select a usable cross-build makefile without native assembly output. |
| [`jsc/build-icu.sh`, filtered ICU data](#icu) | Port | Reduce the embedded locale data to fit the wasm memory budget. |
| [`scripts/sync-bun.sh`, generated linker config](#nested-bun-dependencies) | Port | Remove Bun configure's generated host linker override. |
| [`vendor/bun/vendor/rust-argon2`, inherited patch](#nested-bun-dependencies) | Host feature | Preserve Bun's low-memory Argon2 hash verification behavior. |
| [`crates/bunwasm-glue/src/bun_native.rs`](#copied-and-generated-bun-source) | Port | Replace standalone parser base64 and zlib stubs with working Rust implementations. |
| [`crates/bunwasm-build/src/lib.rs`](#build-command) | Port | Extract Bun's build command from its JSC runtime. |
| [`crates/bunwasm-build/src/dev_server/facade.rs`, `crates/bunwasm-build/src/dev_server/graph.rs`, `crates/bunwasm-build/src/dev_server/finalize.rs`](#bake-graph-adaptations) | Port | Adapt bake's graph owner, context types, and bundle finalization to synchronous WASI. |
| [`crates/bunwasm-build/generated/bake.client.js`, `crates/bunwasm-build/generated/bake.error.js`](#generated-bake-clients) | Port | Embed Bun's generated browser HMR client and error overlay. |
| [`crates/bunwasm-transpiler/src/lib.rs`, source-map collector](#transpiler-source-map-collector) | Port | Retain Bun's small printer callback outside its runtime crate. |
| [`crates/bunwasm-runtime/src/js/inspect.js`, Bun formatter](#bun-console-formatter) | Port | Translate Bun's formatter and property enumeration to JavaScript. |
| [`crates/bunwasm-runtime/src/js/inspect.js`, Node formatter](#node-inspection) | Port | Adapt Bun's Node inspection implementation to ordinary engine intrinsics. |
| [`crates/bunwasm-runtime/src/js/inspect.js`, host hooks](#inspection-host-hooks) | Host feature | Let the host expose promise, proxy, namespace, and iterator state. |
| [`crates/bunwasm-runtime/src/js/path.js`](#node-path) | Port | Adapt Node's POSIX path implementation to the guest filesystem. |
| [`crates/bunwasm-runtime/src/js/buffer.js`](#node-buffer-fragments) | Port | Adapt Node Buffer construction and concatenation routines over typed arrays. |
| [`crates/bunwasm-runtime/src/js/events.js`](#node-event-emitter) | Port | Adapt Node listener bookkeeping without native async hooks. |
| [`crates/bunwasm-runtime/src/js/events.js`, listener publication](#node-event-emitter) | Host feature | Original mutation hook publishes signal dispositions before user listener-removal callbacks. |
| [`crates/bunwasm-runtime/src/js/util.js`](#node-utility-fragments) | Port | Adapt argument parsing, comparison helpers, and inspection tables. |
| [`crates/bunwasm-runtime/src/js/assert.js`](#node-assertions) | Port | Adapt assertion helpers and messages to the local inspector and equality implementation. |
| [`crates/bunwasm-runtime/src/js/bun_sqlite.js`](#bun-sqlite) | Port | Move Bun's SQLite wrapper and inherited transaction code onto Rust SQLite natives. |
| [`crates/bunwasm-runtime/src/js/array_buffer_sink.js`](#bun-array-buffer-sink) | Port | Adapt Bun's byte sink lifecycle and option parsing to engine-owned typed arrays. |
| [`crates/bunwasm-runtime/src/engine_quickjs.rs`, string boundary](#quickjs-string-boundary) | Host feature | Decode lone UTF-16 surrogates as replacement characters at the native boundary. Original adapter. |
| [`web/src/engine-host.js`, GC hook](#host-gc-hook) | Host feature | Capture host GC before guest code replaces globals. Original adapter. |
| [`crates/bunwasm-runtime/src/js/cookie.js`](#bun-cookies) | Port | Translate Bun's cookie parsing, validation, and binding behavior. |
| [`crates/bunwasm-runtime/src/js/string_decoder.js`](#node-string-decoder) | Port | Translate Node's chunk-decoder state machine to JavaScript. |
| [`crates/bunwasm-runtime/src/js/bun_test.js`, diff formatting](#bun-test-diff-formatting) | Port | Translate Bun's colorless diff rendering around a local line differ. |
| [`crates/bunwasm-runtime/src/js/node_url.js`](#node-url-helpers) | Port | Adapt Node URL helpers around the local URL implementation. |
| [`crates/bunwasm-runtime/src/js/builtins.js`, `crates/bunwasm-runtime/src/js/net.js`, HTTP tables](#http-status-tables) | Port | Retain HTTP status data separately from the original networking adapters. |
| [`crates/bunwasm-runtime/src/js/{builtins,bootstrap}.js`, `web/src/engine-host.js`, caller origin](#caller-source-origin) | Host feature | Read caller origins through the existing engine stack parser. Original adapter. |
| [`crates/bunwasm-runtime/src/js/temporal.js`](#temporal) | Host feature | Package the unmodified Temporal polyfill for engines without Temporal. |
| [`crates/bunwasm-semver/src/lib.rs`](#portable-semver-host-functions) | Port | Compile Bun's semver host functions unchanged against a portable `bun_jsc` subset. |
| [`crates/bunwasm-bun-jsc/`, `crates/bunwasm-bun-jsc-macros/`, runtime semver and host GC adapters](#portable-semver-host-functions) | Host feature | Original adapters connect Bun's host functions to the shared data-native interface and preserve the host GC hook. |
| [`crates/bunwasm-runtime/src/js/stack_trace.js`](#structured-call-sites) | Host feature | Original CallSite adapter for QuickJS and JSC stack capture. |
| [`crates/bunwasm-runtime/src/js/net.js`, HTTP socket state](#http-socket-state) | Host feature | Original HTTP socket writability getter over the host connection state. |
| [`crates/bunwasm-runtime/src/directory.rs`, `src/js/node_fs.js`, `web/src/engine-host.js`, directory cursors](#directory-cursors) | Host feature | Original directory handles, bounded reads, recursive traversal and Node Dir adapters. |

| [`runtime/core/`, `runtime/fs/`, MemFS and pipe adapters](#browser-runtime-core) | Host feature | Original WASI, shared filesystem, IndexedDB persistence, lazy residency, startup diagnostics and descriptor adapters. |
| [`runtime/core/`, `runtime/fs/`, MemFS and pipe adapters](#browser-runtime-core) | Host feature | Original WASI, shared filesystem, IndexedDB persistence, lazy residency and descriptor adapters. |
| [`web/tests/persistence-browser-worker.ts`, persistence corpus](#browser-runtime-core) | Host feature | Original browser test adapter reproduces the local storage spike's generated sizes and synthetic bytes; no package contents or upstream implementation. |
| [`runtime/proc/`, browser and Bun process adapters](#browser-process-service) | Host feature | Original process supervisor, executable registry, jobs, registered signal dispositions including Node/Bun's ignored SIGPIPE default, immutable final-kind query and byte-sized exit statuses. |
| [`runtime/fs/`, filesystem quiescence](#filesystem-quiescence) | Host feature | Original shared admission and revocation fence lets controllers stop workers only after direct filesystem operations finish. |
| [`runtime/fs/opfs.ts`, OPFS access-handle and quota adapters](#opfs-storage-adapter) | Host feature | Original one-file-per-payload storage adapter with guidance for occupied workspaces; adapts SLICC-kernel's Apache-2.0 `src/fs/opfs.ts` at 88c5bb3 for NotReadableError retries and QuotaExceededError mapping while retaining bun-wasm's checksummed snapshots, lazy index and bounded cache. |
| [`scripts/browser-build.ts`](#browser-package-resolution) | Host feature | Resolve the consumer's exported runtime files through an absolute package path that works with Bun's isolated linker. |
| [`web/src/native-stream-state.ts`](#native-browser-stream-completion) | Host feature | Original native completion bridge preserves host hooks on instances as well as prototypes. |
| [Cross-platform web test adapters](#cross-platform-web-tests) | Host feature | Original scratch, child-process cleanup, command-deadline and existing-browser-cache adapters run the same assertions on Linux and macOS. |
| [Wasmi memory identity and growth](#wasmi-memory-identity-and-growth) | Port | Expose stable memory identity and successful growth, including zero-page growth. |
| [esbuild distribution, worker capability, and subprocess adapters](#esbuild-webassembly-distribution) | Host feature | Select the unchanged official wasm distribution, detect unavailable workers, and support asynchronous stdin with live shared filesystem changes and large files. |
| [Rollup distribution and WebAssembly adapters](#rollup-webassembly-distribution) | Host feature | Select an unchanged official wasm distribution and execute it through original interpreter adapters. |
| [`scripts/app-matrix/`](#app-compatibility-fixtures) | Host feature | Original app fixtures and local registry recorder, with no copied framework implementation. |
| [`crates/bunwasm-runtime/generated/builtins/`](#bun-generated-builtins) | Port | Lower Bun-generated JavaScript builtins to a lexical intrinsic table shared by all engines. |
| [`scripts/generate-bun-builtins.mjs`, `src/js/bun_builtins.js`, `src/js/bun_builtin_globals.ts`](#builtin-loader-adapter) | Host feature | Generate the selected builtin closure and load factories through Engine. |
| [`web/src/crypto-host.js`, `crypto-inputs.js`](#native-crypto-capabilities) | Host feature | Preserve native crypto, fill the verified AES-192 gap and enforce the runtime input bound. |
| [`crates/bunwasm-crypto-sys/`, standalone crypto linkage](#standalone-crypto-linkage) | Host feature | Original native archive owner shared by runtime and parser/glue consumers. |
| [`third_party/licenses/boringssl-LICENSE`](#webcrypto-backend) | Port | Retain BoringSSL license notices with the wasm backend. |
| [`crates/bunwasm-runtime/src/crypto.rs`, GCM adapter and `third_party/licenses/aes-gcm-MIT`](#webcrypto-backend) | Port | Adapt RustCrypto GCM to WebCrypto nonce and tag lengths. |
| [`crates/bunwasm-runtime/src/js/crypto_keys.js` and `crypto_host_keys.js`, Node key adapters](#node-crypto-key-adapters) | Host feature | Original Node key objects, encodings and signatures over the WebCrypto backend. |
| [`crates/bunwasm-runtime/src/js/crypto.js`, shared key adapters and `web/src/engine-host.js` provider capture`](#webcrypto-backend) | Host feature | Original WebCrypto validation and opaque keys over RustCrypto. |
| [`crates/bunwasm-runtime/src/js/net_address.js`, IP predicates](#tcp-and-ip-helpers) | Port | Adapt Bun's engine independent IPv4 and IPv6 predicates. |
| [TCP adapters and HTTP upgrade sockets](#tcp-and-ip-helpers) | Host feature | Original adapters add duplex sockets, write-side shutdown and bounded native handle allocation over the existing host ABI. |
| [HTTP request and response framing](#http-framing) | Host feature | Original header state, validation, streaming, Agent pool and upgrade response adapters shared by all engines. |
| [`crates/bunwasm-runtime/src/js/ws_builtin.js`](#portable-ws-builtin) | Port | Bundle the unchanged published ws implementation for the shared Node APIs. |
| [`src/js/loop_scheduler.ts` and callback batching](#fair-loop-scheduling) | Host feature | Original portable I/O turns and bounded immediate batches. |
| [`src/js/fs_watch.ts` and `node_fs.js` wiring](#portable-filesystem-watcher) | Host feature | Original polling watcher over the shared WASI file operations. |
| [`src/js/exit_provenance.ts` and lifecycle hooks](#runtime-exit-provenance) | Host feature | Original opt-in exit diagnostics over the existing event loop and error handlers. |
| [`scripts/generate-ws.sh` and builtin resolution](#portable-ws-builtin) | Host feature | Original module wrapper supplies Bun's builtin ws import and require on every engine. |
| [`crates/bunwasm-runtime/src/js/function.js`](#generated-function-parser-locations) | Host feature | Original generated-function import adapter using parser positions and an intrinsic helper. |
| [`patches/bun/0010-wasm-expose-semantic-dynamic-import-locations-to-the.patch`](#generated-function-parser-locations) | Port | Bun parser and printer import metadata, reused unchanged from the semantic-import lane. |
| [`crates/bunwasm-runtime/src/engine_quickjs.rs`, data conversion; `host.rs`, native-test import gate](#quickjs-data-conversion) | Host feature | Original adapter checks buffer tags before calling a throwing getter. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, buffer tag predicate](#quickjs-data-conversion) | Host feature | Original nonthrowing class query for ordinary and shared buffers. |
| [`crates/bunwasm-runtime/src/js/function.js`](#generated-function-imports) | Host feature | Original generated-function adapter with module-relative dynamic imports. |
| [`src/js/bun_console_constructor.js`](#bun-console-constructor) | Port | Generate Bun's Console constructor with lexical engine-independent hooks. |
| [`scripts/generate-bun-console.mjs`, `src/js/console_constructor.js`, global Console wiring](#bun-console-constructor) | Host feature | Original generation and runtime adapters expose the shared constructor and its streams. |

## Engine interruption

Class **Host feature**. The WebKit patch changes
`Source/JavaScriptCore/llint/{LowLevelInterpreter.asm,LLIntSlowPaths.cpp}` and
`Source/JavaScriptCore/runtime/VMTraps.h` at Bun's WebKit revision
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Single-threaded WASI cannot use a
watchdog thread to publish VM trap bits while JavaScript runs. A per-VM countdown
therefore polls the host every 1,024 ordinary C-loop trap points, including loop
backedges and function entries. The existing trap slow path saves the interpreter
PC and stack before polling; generic exception/unwind checks do not poll the host.
A true callback result requests JSC's distinguished uncatchable termination
exception. Polling is disabled for hosts without optional signal slot 18. This is
a host extension, not an upstream bug.

Original adapters in `crates/bunwasm-runtime/src/{engine,engine_quickjs,engine_jsc,lib,host}.rs`,
`crates/bunwasm-jsc/{cpp/helpers.cpp,src/sys.rs}`,
`crates/bunwasm-host/src/{slots,process/stdio}.rs`, and `web/src/subprocess.ts`
add `(signal=0, mode=4)` to existing slot 18. It observes fatal cancellation
without consuming the authoritative per-signal handled pending set. QuickJS
installs its public `JS_SetInterruptHandler` through rquickjs's interrupt API,
without changing upstream QuickJS, amortizing host calls across eight ordinary
engine polls (about 80,000 backedges/calls). Neither engine callback enters JS.

Handled signals wait for the next ordinary event-loop turn, matching Node. An
earlier design dispatched them inside engine callbacks; review rejected that
because QuickJS also polls during native regexp operations, and reentry can break
native borrowed state or runtime timer invariants. No interpreter-specific
reentry hook or runtime critical-section suppression is needed. The original
`crates/bunwasm-runtime/src/js/{process.js,process_signals.ts}` adapter serializes cooperative dispatch,
including recursive broken-pipe handling. Default signals already have an
immutable host outcome; a fatal checkpoint unwinds Wasm without entering guest
catch/finally blocks, including while a handled callback is CPU-bound. The
browser-native engine needs no new hook and remains covered by worker termination.

The original `runtime/proc/abi.ts` adapter implements the same fatal-only mode 4
for generic process imports. The original `runtime/proc/signals.ts` helper preserves
pending-signal wake hints during cooperative dequeue. The original
`web/src/{runner,worker,subprocess-broker,subprocess}.ts`
adapters share each process's existing budget with its page-side broker. Signal delivery
notifies that budget's wait word and, for generic process polling, the directory wake word;
short timeout rescans are not the signal notification mechanism. Legacy preview1 guests
also receive their root or child's interrupt channel, with cooperative dequeue consuming
its wake hint without consuming another pending signal.

These adapters and the browser proof/benchmark harness are original implementations,
not copied source. JSC polling covers JS safe points, not a single uninterrupted
native operation; QuickJS retains its existing native-operation interrupt polls.

## Third-party interrupt instrumentation

**Class: Host feature (original adapter).** `runtime/interrupt/rewriter.ts`, `loader.ts` and
`check.ts` are original TypeScript source, following the binary-format exploration in our
2026-10-16 spike-5 prototype (`/work/reports/browser-runtime/spikes/5-interrupt-injection/rewriter.js`).
The production implementation replaces the spike's unconditional function-entry host calls
and per-activation loop sampling with one private module-global countdown shared by function
entries and loop headers. It adds native pre/post validation, an explicit supported-feature
allowlist, metadata refusal, a SHA-256 compiled-module cache and fatal-outcome-only host checks.
Bun and the own shell remain cooperative programs and are not rewritten.

Conceptual prior art (no implementation copied): DFINITY's
[New WebAssembly instrumentation](https://medium.com/dfinity/new-webassembly-instrumentation-2c93631e5718)
checks its internal instruction counter at reentrant function/loop entries; paritytech's
[`wasm-instrument` gas metering](https://github.com/paritytech/wasm-instrument/tree/master/src/gas_metering)
and Filecoin's `fvm-wasm-instrument` use internal mutable globals to avoid expensive per-block
host calls. Our countdown counts cancellation checkpoints rather than instruction gas, does
not meter blocks, and traps only after the supervisor has selected signal death.

`runtime/tests/fixtures/interrupt-browser-loops.ts` adapts our own spike-5 `loops.wat` into a
readable TypeScript binary generator, preserving its independent teardown-only rescue word.
`interrupt-browser-workload.ts` freezes our own spike-5 `workload.c`/`workload.wasm` (2026-10-16),
not third-party source. Source SHA-256:
`d3eebbef9920faf0d12f3d2220e0425b80a9fc71f1919206103b3277724ec74c`; binary SHA-256:
`08c117f62e1323401b32ad116c85eab45765a6cffedd68970547bbad462406c8`. It was compiled with wasi-sdk
clang 23.1.0 / LLVM `895aa2c896ada719451be2e3673c83da8ddf1141`, `-O2 -nostdlib`, a WASI
wasm32 target, exported memory and a 16 MiB maximum memory. Source comments preserve exact
flags. The benchmark optionally takes the retained spike rewriter as an external input; it is
bundled only into the disposable measurement app, never into the shipped runtime.


## Browser process service

Class **Host feature**, **original adapters** in `runtime/proc/`,
`web/src/{subprocess,subprocess-broker,worker,runner,shared-fs}.ts`,
`web/src/engine-host.js`, `web/src/net/{host,trampoline}.ts`,
`web/scripts/{node-spawn,node-signals,node-process}.ts`, `web/scripts/node-host.mjs`, `runtime/core/wasi.ts`,
`crates/bunwasm-host/src/{main,slots}.rs`,
`crates/bunwasm-host/src/process/{mod,stdio}.rs`, and
`crates/bunwasm-runtime/src/{host,natives,lib}.rs` plus `src/js/{spawn,process,bootstrap}.js`
and their runtime types. These implement this project's process contract; no upstream
implementation is copied into these original adapters. The separate original mutation hook in
the already-ported EventEmitter is classified under [Node event emitter](#node-event-emitter).
The process slots retain Bun host ABI version 1 and slots 12–15, appending optional signal
slot 18 after the existing networking slots (`docs/host-abi.md`).
The generic service shares compiled modules and keeps process ids separate from job ids.
The browser launcher selects an executable's guest adapter instead of inheriting the
spawning process's engine. A small reservation/activation bridge is separate from the
first-spawn-loaded supervisor. The existing Bun pipe transport remains until step 4b.
The shared guest keeps executable names intact; native and Node host registries explicitly
recognize `bun`, `/bun`, `node`, `/node`, `/usr/local/bin/bun` and `/usr/local/bin/node`
instead of silently running Bun for an arbitrary executable.

Each process has per-signal default, ignored or handled dispositions. An unhandled SIGINT,
SIGTERM or SIGPIPE immediately selects its typed default outcome and revokes; only handled
signals queue for guest delivery and retain the guest's own exit status. Registration/removal
publish synchronously, and removing a pending handler to default takes that action immediately.
A 65-cell signal table couples disposition with a per-signal pending bit, preserving distinct
signals and clearing pending before once-listener removal. Slot 18 supplies registration,
dequeue and self-signals without mandatory Wasm imports. Cooperative guest event-loop turns
pump handlers without keeping an otherwise idle program alive. The original JS process adapter
initializes SIGPIPE as ignored to match observed Node 26.7.0 and Bun 1.4.2 behavior, with no upstream
implementation copied. Registering a SIGPIPE listener selects handled delivery and removing the
last listener restores default (including once listeners), matching both native runtimes.
Removing unrelated listeners preserves the initial ignored disposition. Generic host signal
controllers retain the preview1 default.
EPIPE remains catchable by the guest; an escaping EPIPE follows the ordinary uncaught-error path,
prints the error and exits 1. It does not synthesize SIGPIPE or consume pending signals, even when
a SIGPIPE listener exists. Physical host signals are forwarded separately. Plain preview1 guests retain default
SIGPIPE and its status 141. Typed signal decisions precede worker error hooks, which must not
relabel default signal death as an ordinary worker error. The Node import dispatcher composes process, worker,
network and optional signal slots through the same guarded subprocess adapter.
SIGKILL immediately records 137 and revokes before physical termination; it cannot be caught
or ignored. A shared atomic terminal-result primitive arbitrates guest completion, startup
failures and default actions, preserving the winning status and whether it came from an ordinary
exit or a signal. The native Wasmtime adapter also retains an immutable typed outcome: default
actions select immediately, while handled signals do not take the fatal cancellation path.
The original slot-14 metadata
selector `CHILD_FINAL_SIGNAL = 3` exposes the completed signal kind on every host without
changing slots 12–15 or pipe selectors 0–2. The worker adapters use selectors 4/5
for their two directional control pipes on every host, leaving selector 3 exclusively
for final signal metadata. Native worker completion closes the incoming reader and
outgoing writer before publication, preserving EPIPE/EOF at the correct endpoints.
The shared Bun facade reads that selected kind
rather than guessing from status 143 or a prior kill request. Synchronous spawn error
paths also observe completion before reading the final kind; a forced-stop request is not
proof that signal death won. Worker receivers consult that typed kind before synthesizing
an ordinary uncaught-worker error. Native process, pipe and network allocations check
their disjoint handle ranges before creating resources, returning EAGAIN at exhaustion
instead of wrapping or routing a handle into another service.
The native linker's original
`wasi_snapshot_preview1::proc_exit` adapter preserves ordinary exit codes 126–255, which
Wasmtime 39.0.2's standard preview-1 implementation rejects as traps. The upstream reference
is `bytecodealliance/wasmtime`, `crates/wasi/src/p1.rs` at
`f66a5b61465c937aba66d73cd5d82f763cc3074f`; no implementation is copied. The adapter
uses the launcher's existing byte-sized OS exit convention (for example, -1 becomes 255),
then returns Wasmtime's typed `I32Exit` so normal exits cannot be confused with traps or
negative child-control results. Root and child stores use the same linker setup. The browser
WASI adapter and host-JS engine exit adapter apply the same byte-sized convention before
publishing completion. Original tiny-Wasm and host-engine tests cover negative and oversized
values through the real exit path and child wait/final-signal transport. The original Rust `readStdin` adapter flushes buffered
stdout before blocking, so a parent's readiness-before-input handshake cannot deadlock.
These are original host protocol extensions, not copied upstream implementations.
Filesystem revocation no longer claims
that `Worker.terminate()` proves death: an original admission/critical-section guard in
`runtime/fs/{protocol,client,shared,service}.ts` proves host operations quiescent before lock
reaping and physical termination; an ordinary guest exit acknowledgement also proves quiescence.
Children use independent process revocation identities while
sharing the filesystem service's root revocation word. New browser fixtures and timing
harnesses are original test programs, not copies of the spike implementations.

## Test fake clock

Class **Host feature**, **original adapter** in `crates/bunwasm-runtime/src/js/fake_timers.ts`,
with routing in `bootstrap.js`, `bun_test.js`, `process.js` and `web.js`.
No upstream implementation is copied. The reference contracts are Bun's
`src/runtime/test_runner/timers/FakeTimers.rs` and
`src/jsc/bindings/JSMockFunction.cpp` at `cd95fa7a13b3f13be73e512b38ec111c1c228084`.

Bun's implementation calls its JSC global object, native timer heap and virtual machine.
Those cannot run through the portable builtin loader. The adapter keeps fake timer handles
in a separate queue, advances a nanosecond clock, and exposes the controls through `jest`
and `vi`. Global timers and `node:timers` share scheduling and cancellation. Runtime-owned
callbacks use the real timer interface, so filesystem, worker, crypto, compression, readline, and subprocess
work survives fake-clock restoration. Host wakeups use the captured native clock. Timers
created before fake-clock activation keep their real ownership. A separate running-callback
stack keeps numeric handles discoverable during nested drains. Cancellation and `clearAllTimers`
close those running handles without including them in the pending timer count.

A stable Date constructor wrapper preserves references saved before activation, explicit
constructor arguments, subclasses and Date instances. Its current time also supplies native
Intl formatters when callers omit the date. `setSystemTime` rebases wall time without changing
timer deadlines. Performance and process high-resolution time use the fake monotonic clock.
`runOnlyPendingTimers` uses Bun's latest pending deadline as its horizon. Timer callbacks
drain the runtime-owned `process.nextTick` queue synchronously. Browser native Promise jobs
remain deferred until the synchronous host drain returns. The portable scheduler bounds a single
drain at 100,000 callbacks to reject an endless interval or recursive timer.

## OPFS storage adapter

Class **Host feature**, original adapter in `runtime/fs/opfs.ts`, informed by SLICC-kernel
`src/fs/opfs.ts` at commit `88c5bb3` (Apache-2.0). The SLICC implementation's bounded sync-access
handle retry loop for `NotReadableError`/`InvalidStateError` and its `QuotaExceededError` to
`ENOSPC` mapping are adapted here. The layout, snapshot recovery, Web Lock lifetime, lazy payload
reads, browser-specific create concurrency and 64-handle cache are original bun-wasm behavior;
no SLICC code is copied verbatim.
The original Web Lock refusal now tells the user to close the owning tab and reload;
lock acquisition and the adapted SLICC retry and quota behavior stay unchanged.

## Filesystem quiescence

Class **Host feature**, **original adapters** in `runtime/fs/{protocol,client,shared,service,index}.ts`.
No Bun, Node, WebKit or other upstream implementation is copied; there is no upstream source
path or revision for this host-only protocol.

Each connection owns a shared count of synchronous host sections. Admission increments before
checking revocation and precedes any direct lock acquisition, capability-reference mutation or
page write. Nested operations keep the count nonzero until the outer operation releases its
locks. `waitForFilesystemQuiescence(identity)` revokes first, then observes or asynchronously
waits for zero, proving no future entrant can touch storage even if the worker remains alive.
The service uses this admission proof before releasing pins, rather than sampling lock owners,
which misses an operation between admission and acquisition. Controllers can then reap and stop
the worker without stranding a lock or allowing a write into reclaimed pages. An independently
proven-dead reap also settles pending waiters without resetting the count or losing a wakeup.

No section spans an await or guest Wasm call. Direct reads, writes and appends retain their
existing locks and zero-intermediate-copy paths, with one additional outer admission increment,
revocation check, decrement and final-exit notification. Regression tests cover revocation
between admission and its check, nested metadata operations, service pin retention, and a live
worker paused inside a locked write followed by a rejected late write.

## Standard output errors

Class **Host feature**, **original adapters** in `crates/bunwasm-runtime/src/lib.rs`,
`src/natives.rs`, `src/js/{process,spawn,web}.js`, `web/scripts/node-host.mjs`,
`web/scripts/node-stdio.ts`, `web/src/{subprocess.js,worker.ts}`, and
`crates/bunwasm-host/src/process/{mod,pipe,stdio}.rs`, and its original `net/error.rs` error record.
No Bun or Node implementation is copied or adapted for this change.
Rust output natives return write errors with Node-style `EPIPE`, errno `-32`, and
syscall `write`. The synchronous process writers emit their stream's `error` event.
Failed writes in one batch share the first error object and one stream error event.
All pending write callbacks receive that error on the next tick. The event runs
after ticks scheduled by those callbacks. During failure and callbacks, `writable`
is false; it resets to true before their ticks and the event. `destroyed` stays false,
matching Node v26.7.0's standard-stream reset. A later failure starts a new batch.
An unhandled error ends the guest with status 1. A listener can handle the error.
The Node WASI adapter waits only for temporary `EAGAIN` backpressure and returns
WASI `PIPE` for closed output. Worker child adapters preserve the same error and
close inherited output transports when their downstream reader disappears.
The minimal readable stream invokes its underlying cancellation callback so
canceling a subprocess reader actually closes its pipe.
Native child pipes attach the OS `EPIPE` number to their error. Wasmtime 39.0.2
translates an `ErrorKind::BrokenPipe` without an OS errno to generic WASI `IO`.
Child exit closes its owned stdin reader. Native and worker stdin write errors
retain `code`, `errno`, and `syscall` through the public Bun and Node writers.
Worker hosts retain each pipe's error until the handle is closed, so unrelated
network errors cannot replace it on either the engine or WASI-slot bridge.
The native cancellation wrapper delegates the underlying WASI output stream
instead of wrapping inherited stdio in Wasmtime's asynchronous output queue.
That queue becomes permanently closed after EPIPE and returns generic EIO on
later writes. Direct delegation preserves EPIPE for later batches and retains
cancellation while waiting for child-pipe capacity. No Wasmtime code is copied.

The browser's top-level stdout and stderr write to a terminal through messages,
so they have no OS reader that can close. Browser child pipes do have readers;
the real-browser subprocess check cancels those readers on all three engines.
The regression fixtures and Python OS-pipe driver are original test code.
The driver checks QuickJS and JSC under both the native launcher and Node's
worker host, plus the host engine under Node.
## Fair loop scheduling

Class **Host feature**, **original adapter** in `src/js/loop_scheduler.ts` and
`bootstrap.js`. No upstream implementation is copied, so there is no upstream
path or revision.

The scheduler gives I/O a turn between callback turns, even when callbacks keep
queuing immediates or timers remain due. Immediate callbacks queued during an
existing batch wait for the next batch, so due timers can run. Microtasks still
drain between callback turns. This uses the existing I/O waiter interface and adds
no host ABI slot.

## Portable filesystem watcher

Class **Host feature**, **original adapter** in `src/js/fs_watch.ts`, wired by
`src/js/node_fs.js`. No upstream implementation is copied. Bun's
`src/js/internal/fs/watch.ts` at `cd95fa7a13b3f13be73e512b38ec111c1c228084`
wraps a private native filesystem watcher that these engines cannot call.

The adapter snapshots file identity, size and modification time through the
existing Rust filesystem operations. A referenced 100 ms timer polls for change
and rename events. Recursive traversal does not follow directory symlinks.
`close`, `ref`, `unref`, persistent options and abort signals control the actual
timer. Closing a watcher releases its timer and signal listener. Polling can
coalesce changes between samples and does not promise an OS event count.
`watchFile` and the promise-based watcher remain unsupported.

## Runtime exit provenance

Class **Host feature**, **original adapter** in `src/js/exit_provenance.ts`, with
lifecycle hooks in `bootstrap.js` and `process.js`. No upstream implementation is
copied, so there is no upstream source path or revision.

`BUN_WASM_TRACE_EXIT=1` emits JSON to stderr at explicit exits, fatal errors and
loop completion. Each record contains the guest code, exit reason, JS stack,
refed timers, immediates, ticks, pending I/O, message-port references and network
handle count. The app matrix records the host code and signal separately, along
with timeouts and harness termination. Normal runtime output is unchanged when
the flag is absent.

## Portable ws builtin

`crates/bunwasm-runtime/src/js/ws_builtin.js` is generated from `index.js` and
`lib/*.js` in the published websockets/ws release `v8.18.3`. Its npm tarball
integrity is
`sha512-PEIGCY5tSlUt50cqyMXfCzX+oOPqN0vuGqWzbcJ2xvnkzkq46oOpz7dQaTDBdfICb4N14+GARUDw2XV2N4tvzg==`,
pinned in `docs/bun-test-suite/dependencies/bun.lock`. The original MIT license
is embedded in the generated source and retained in `third_party/ws/LICENSE`.

`scripts/generate-ws.sh` uses native Bun to bundle those CommonJS files without
changing their implementation. Its original wrapper preserves strict mode,
maps Node imports to the runtime builtin registry, and returns module.exports.
Optional native addons remain external and unavailable. The library's existing
JavaScript implementations handle their absence. The Rust resolver recognizes
`ws` as a Bun builtin; no project dependency is injected. The CommonJS dispatcher
uses the builtin factory registry as well as reserved prefixes, so `require("ws")`,
`createRequire` and `import.meta.require` use the same module as an ESM import.

Bun's own `src/js/thirdparty/ws.js` at
`ddab8382bdf6b02f22653758d901fb83ceb85aa8` requires the private C++ WebSocket
constructor and private HTTP upgrade hooks. Those bindings are not available
on our engines. The portable upstream implementation uses the existing
node:net and node:http adapters instead. It adds no host networking path.
See [the ws builtin](ws-builtin.md) for generation and verification.

## TCP and IP helpers

The IP regular expressions in `crates/bunwasm-runtime/src/js/net_address.js` come
from Bun `src/js/internal/net/isIP.ts` at
`4ceda2c2868d3a7703c7737ddd9de7244ec384df`. The port removes TypeScript annotations
and the module export wrapper. The predicates themselves are unchanged.

The other address helpers, `node_net.js`, `bun_tcp.js`, and the changes to
`net.js`, the Rust host and the browser hosts are original adapters. They share
one byte transport with fetch, Bun.serve, and WebSockets. The added host slots
provide write-side shutdown and the local endpoint. HTTP upgrade listeners get
a real Socket with the bytes received after the request header. The original
adapters also own pipe backpressure across multiple destinations, cancellation of queued writes, exact-size
reads, timeout listener cancellation, and bounded HTTP upgrade handshakes.
The native network allocator also rejects handle exhaustion before starting an
operation or consuming an accepted socket, preserving the separate process/pipe
handle range and returning EAGAIN without partial resource creation.
No additional upstream implementation was copied for these corrections.

Bun's `src/js/node/net.ts` depends on native Bun sockets, private stream modules,
and runtime intrinsics. Its BlockList and SocketAddress use native bindings.
These adapters implement the public contracts over our host handles while those
bindings remain unavailable. This is not a switch to Bun's full net module.
The upstream comparisons are recorded in [TCP support](tcp.md).

## Browser runtime core

Class **Host feature**, **original adapters** in `runtime/core/`, `web/src/fs.ts`, `runtime/fs/`, and the `wasiPipe` adapter in `web/src/subprocess.ts`.
The extraction starts from bun-wasm's own
`web/src/{wasi.ts,memory-views.js,fs.ts}` at `8716f92`; there is no copied Bun, Node, WebKit,
brush-web, or browser_wasi_shim implementation in this layer. The preview1 adapter now uses
opaque filesystem handles keyed by object identity (not serialized inode metadata), reference-counted
descriptions and descriptor readiness. The filesystem worker and shared-memory protocol are original TypeScript adapters. Their
memory backend moves the local MemFS implementation from `web/src/fs.ts` at `53a22c6`;
there is no copied upstream implementation. The OPFS spike informed the scheduling choice,
not the implementation. One worker allocates inodes, owns open identities and services all
guests. Ancestor revocation cancels requests and releases each guest's references; bounded
read/stat caches use a shared mutation epoch. Atomic append selects EOF and writes the whole
request under shared mutation and file locks; conditional creation carries the caller's exclusivity intent. Transient
result handles are pinned together before eviction, and rejected cache reads do not touch guest
buffers. Shared ancestor wakeups also cancel blocked and asynchronous guests if the filesystem
worker fails. The sandbox's original network adapters send notification-only file-change events
after a shared-FS save, rather than replaying its old bytes. Copy-at-spawn and merge-at-exit are removed.
The original `runtime/fs/shared.ts` adapter adds shared file metadata, per-inode locks and
service-owned 64 KiB page tables across 16 MiB SAB segments. Original connection adapters
publish zero-byte growable segment references before execution, so service-owned backing
growth is visible even to a synchronous guest that cannot drain port messages. Retained file reads and in-capacity
writes and appends stay in the guest; namespace edits and geometric capacity growth stay
at the backend boundary. A guest read holds the file lock once and copies straight into guest
buffers; writes and appends also hold the global mutation lock. Each checks revocation once
while holding its locks and reads or writes slot fields only under the lock that guards them.
Negative `fd_pread`/`fd_pwrite` offsets return EINVAL. Original per-connection capability tables let cached opens and closes
change atomic local references while the service retains sole ownership of backend pins. The default configurable storage cap is 1 GiB; pool exhaustion uses
WASI ENOSPC and the per-file page-table limit uses EFBIG. Owner-tagged locks let revocation
reclaim abandoned guest locks without changing allocator state. This is original bun-wasm code,
not an adapted upstream allocator or filesystem. Path walking remains a local MemFS detail. Bun's
reserved socket slot bridge stays configured by `web/`, not imported into the generic core.
The persistence layer in `runtime/fs/{storage,indexeddb,persistent}.ts` is also an original adapter,
not copied or translated from PGlite, SQLite, Emscripten, or another upstream. The storage spike
informed its batched scheduling and crash-safety requirements. It adds immutable payloads,
checksummed incremental metadata, dual base snapshots, strict atomic IndexedDB commits, lifetime
Web Locks and lazy data hydration. Shared revision counters capture direct guest writes; clean
persisted data can leave the pool without changing inode identity. The editor adapters wait for
a durable checkpoint before marking a save complete, seed workspaces once, and explicitly reset
sandbox templates. `runtime/core/wasi.ts` routes both preview1 sync calls through this boundary.
The original worker/controller adapters in `runtime/fs/service.ts` and `web/src/shared-fs.ts`
now send startup failures as plain message and stack fields before revoking pending requests.
Unprintable rejection reasons and throwing stack getters still produce a diagnostic, and a
failed diagnostic transfer still dispatches the worker error fallback.
The playground catches startup rejection, displays the complete diagnostic, and offers Reload.
OPFS refuses an occupied Web Lock and explains how to release it. IndexedDB uses an original
takeover adapter. A new holder steals the lock, allocates a persisted epoch, and checks that epoch
inside every write transaction. A displaced page stops persistence and preserves visible editor text.
These changes extend bun-wasm's own adapters at `b14f536f`; no upstream implementation is copied.
The original persistence browser fixtures in `web/tests/persistence-browser-{main,worker}.ts`
and their Playwright/Safari runners exercise these adapters without a wasm build. The corpus
fixture retains only generated package-file sizes from the original local storage spike's
`build-corpus.py` output, identified by its SHA-256 in `fixtures/persistence-corpus.json`.
The worker reproduces the spike's original `fs-worker.js` synthetic seeded-word generator
(SHA-256 `4ea7e6f89a64af1c53b3b5eb5deb30291ff9f2dbbf7222cdee03ca627fe6e3fc`),
including its small-file seeds `17+i` and three large-file seeds `10033+i`. Local changes
add browser-native payload-read counters, incremental checkpoint timings and full-byte
integrity checks. This is original benchmark input, not copied package content or a Bun,
Node, WebKit, PGlite, or SQLite implementation.
Unbundled Node host adapters import the extracted JavaScript memory helper by repository-relative
path so headless CLI workflows remain dependency-free.
The original browser-build adapter resolves declared exports through the consuming app.
It returns equivalent public installed-package paths so encoded isolated-cache directory
names do not trigger Bun's double-dot plugin-path rejection. No upstream code is copied.

## Browser package resolution

Class **Host feature** for the original adapter in `scripts/browser-build.ts`. The adapter resolves
the consuming app's `@bun-wasm/runtime` exports with Bun, then maps the resolved file back through
the consumer's package path. This keeps the returned path absolute without exposing Bun's isolated
package-cache spelling to the build plugin. No upstream source is copied.

## Portable semver host functions

Class **Port** for the source selection in `crates/bunwasm-semver/src/lib.rs`.
The upstream implementation is oven-sh/bun `src/semver_jsc/SemverObject.rs`
at pinned upstream revision `9510e74152073d850a18758ca41114d8f214ffa6`.
The vendored patched tree is `4ceda2c2868d3a7703c7737ddd9de7244ec384df`.
This file is unchanged between those revisions. The adapter compiles it directly with
`#[path]`, so no copy or generated rewrite can drift from the pinned source.
Its `order`, `satisfies`, and `intersects_for_testing` bodies all compile.

Class **Host feature** for the original adapters in `crates/bunwasm-bun-jsc/`,
`crates/bunwasm-bun-jsc-macros/`, `crates/bunwasm-semver/src/lib.rs`, and
`crates/bunwasm-runtime/src/semver.rs`, `crates/bunwasm-runtime/src/js/bun.js`, and
the GC hook in `web/src/engine-host.js`. These implementations are ours.
They provide the source-compatible names and free-host-function macro needed by this
one module. They use call-scoped string slots, immediate boolean and int32 results,
and explicit errors instead of JSC's tagged values and C++ call ABI.
The runtime adapter maps the actual upstream function table to its native names.
`crates/bunwasm-runtime/src/js/builtins.js` exposes the upstream intersection function
through the existing internal test module. JavaScript still owns argument coercion.
The public semver wrapper rejects Symbol primitives with Bun's canonical error
message. The host GC adapter captures the host's original function before user
code can replace it. Bun's upstream harness replaces global `gc` with a wrapper
around `Bun.gc`; looking up global `gc` on every call otherwise recurses.

This replaces our duplicated semver host-function logic, while retaining the existing
pure Bun semver parser used by package installation. See
[the backend spike](bun-jsc-backend.md) for the limits of this subset.

## Structured call sites

`crates/bunwasm-runtime/src/js/stack_trace.js` is an original adapter for the public
`Error.captureStackTrace` and `Error.prepareStackTrace` contracts. It does not copy
Bun, Node or WebKit source. QuickJS-ng at the vendored rquickjs-sys 0.13.0 revision
already supplies structured frames but omits queries used by stack-inspection
packages. The adapter extends that frame prototype. Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb` supplies captured stack text through
`Source/JavaScriptCore/runtime/ErrorConstructor.cpp`. The adapter parses those
frames through our existing inspector before invoking a custom capture formatter.
JSC captures raw frames immediately and selects the formatter only when the stack
is read. Parsed JSC CallSites carry already-mapped locations so their string and
getter forms use the same coordinates. Ordinary JSC Error construction stays native.
QuickJS's private native formatter collects raw CallSites. Its public formatter is
selected lazily by the Error prototype accessor or capture accessor. Successful
results, including non-string values, are memoized; formatter exceptions propagate
at access. A holder without a cached reentrant default permits a later read to retry.
No engine constructor is replaced.
Receiver and method metadata unavailable from these engines returns undefined or
null; eval-origin metadata is unavailable and returns undefined. Engine placeholders such
as `<input>` are not reported as source origins.
The regression fixture uses the public capture API without copying a package.

Successful stack values are memoized in an original WeakMap adapter, independently
of the holder's descriptor. Mutable holders may receive a data property;
frozen and sealed holders keep their accessor. Capture rejects non-extensible
or non-configurable targets before native capture mutates them, matching the
Node/V8 public contract. A single formatting guard covers all errors: reentrant
reads memoize the default stack, successful outer formatters may replace that
value, and throwing formatters clear the guard in finally. These are original
adapters derived from behavior probes, with no Node/V8 implementation copied.

## HTTP socket state

The HTTP server socket facade in `crates/bunwasm-runtime/src/js/net.js` is an
original adapter, with no upstream implementation copied. Its `writable` getter
reads the existing host connection's closed and closing states. Published Koa
3.0.1 checks this Node socket property before sending the response body; an
absent property made a live connection appear unwritable. The lifecycle fixture
checks both an open connection and a connection closed after its response.

## Rollup WebAssembly distribution

`crates/bunwasm-runtime/src/install/resolve.rs` selects the official
`@rollup/wasm-node` npm distribution for Rollup 4 at the same version. The
measured package is 4.64.7, including `dist/native.js`,
`dist/wasm-node/bindings_wasm.js`, and `dist/wasm-node/bindings_wasm_bg.wasm`.
These upstream files remain unchanged inside installed projects. No Rollup
implementation is retained in this repository.

`crates/bunwasm-runtime/src/wasm.rs` and `src/js/webassembly.js` are original
adapters over the public `wasmi` 0.46.0 API and the WebAssembly JavaScript API.
They do not adapt an upstream implementation. The Wasmi dependency has the
small port described below. Resumable host traps let JavaScript imports reenter
wasm without holding a Rust borrow across JavaScript execution. Memory synchronization keeps
JavaScript views and interpreter memory consistent across those calls.
`tests/fixtures/webassembly` is original test code; `tests/rollup/run.mjs`
executes the real published parser and hashes through the recorded registry.


## Wasmi memory identity and growth

Class **Port**. `third_party/wasmi` copies the published Wasmi 0.46.0 crate,
upstream `crates/wasmi` at revision `50ac76771d631f642e8c4c61bf44c99546024461`
from `wasmi-labs/wasmi`. The MIT and Apache license files come from that revision.
Cargo uses this local crate through `[patch.crates-io]`; Wasmi Core and its other
dependencies remain published crates.

Local changes are limited to these files:

- `src/memory/mod.rs` derives equality on store-guarded memory handles and exposes
  the growth generation. Successful public growth increments that generation.
- `src/store/inner.rs` owns a generation counter for each allocated memory.
- `src/store/pruned.rs` increments the counter after successful wasm growth.
- `src/engine/translator/visit.rs` and `src/engine/executor/instrs/memory.rs`
  preserve zero-page growth instead of replacing it with a memory-size read.
- `src/engine/translator/tests/op/memory/memory_grow.rs` updates the corresponding
  translation expectation to retain the zero-page growth instruction.

The JavaScript API requires a new buffer after every successful unshared growth,
even when its size stays the same. Tracking growth inside the interpreter covers
both constant and dynamic wasm instructions, as well as JavaScript calls. Failed
growth does not increment the counter. Store-guarded handle equality lets aliased
exports share one JavaScript object without conflating separate empty memories.
All other retained upstream files are unchanged.


## App compatibility fixtures

`scripts/app-matrix/apps.mjs` contains original minimal projects that use published framework APIs. The dependency versions in that file identify the npm upstream revisions. No template source or upstream implementation is copied or adapted. The runner, registry recorder, network namespace wrapper, shared assertions/classifier, and browser driver are original bun-wasm host adapters. The namespace wrapper uses Linux user/network namespaces without changing any upstream source. Retained diagnostic fixtures under `scripts/app-matrix/review-evidence/` are unmodified logs from the pinned packages in the 2026-10-15 census, including Next 15.5.6, Prisma 6.17.1, Vite 7.1.12 and Rollup 4.64.7; they are regression inputs, not adapted implementations. The browser driver calls the existing playground test helpers. Recorded dependency tarballs remain unmodified in the external cache, verified by SHA-256; registry metadata is rewritten only in loopback responses to point tarballs at that mirror.

## QuickJS data conversion

`engine_quickjs.rs::to_val` is an original adapter over rquickjs 0.13.0 and the
vendored QuickJS-ng API. No upstream source is copied. The adapter now checks
`JS_bunwasm_IsArrayBufferLike` before `ArrayBuffer::from_object`. The latter calls the throwing
`JS_GetArrayBuffer` getter even for non-buffer objects and leaves a TypeError
pending while returning None. Ordinary arrays and objects must cross the native
boundary without creating an exception. Native Rust tests also require the
WASI-only import in the original `host.rs` adapter to be target-gated; native
builds report that import route unsupported rather than linking a WASI symbol. The import-selector regression exposed
this on QuickJS; a native Rust regression also observes the pending exception.
The original helper added to `third_party/rquickjs-sys/quickjs/quickjs.c` checks
both ArrayBuffer and SharedArrayBuffer class tags without invoking a getter.
QuickJS's existing `JS_IsArrayBuffer` recognizes only the first class, so using it
alone would lose the shared-buffer conversion that the getter already supports.
`JS_bunwasm_IsDetachableArrayBuffer` is another original inspection helper. It
checks the ordinary-buffer class and detached flag before a transfer mutates any
buffer. It copies no upstream implementation.

## Generated function imports

`crates/bunwasm-runtime/src/js/function.js` is an original adapter for the public
Function, AsyncFunction, GeneratorFunction and AsyncGeneratorFunction constructors.
It uses the caller-origin helper and Bun parser keyword positions to route
generated dynamic imports through the runtime resolver. No Bun, Node, QuickJS or WebKit implementation is
copied. Native constructors still parse the arguments and construct the function. On QuickJS
and the host engine, native parsing validates the original function before Bun's
parser identifies replacements. Methods named `import` remain intact and invalid
original syntax still throws. Temporary
validation functions are never executed. JSC keeps its native constructors because
its generated imports already preserve the caller origin. The host adapter also
attaches the creating module's source URL to generated bodies. Otherwise the
constructor proxy itself would replace available eval-origin metadata with an
internal runtime location, even in a body without an import. This directive is
visible in generated function source, as is the dynamic-import replacement.
This fixes the published Prettier 3.6.2 CLI's generated import without changing
its package or fixture. Caller-origin lookup temporarily uses the runtime's own
stack formatter so user custom formatters cannot change module resolution.

## Caller source origin

Class **Host feature**. Original bun-wasm adapter for `bun:jsc.callerSourceOrigin`.
The contract is defined by `src/jsc/modules/BunJSCModule.h`, `functionCallerSourceOrigin`,
at Bun revision `4ceda2c2868d3a7703c7737ddd9de7244ec384df`. No upstream implementation is copied.
The native implementation walks JSC call frames. This adapter uses the existing stack parser
for QuickJS, JSC and browser engines, then encodes the calling file as a file URL.
Browser module URL mapping stays in the engine host. Without a caller frame, it returns `null`. Preserve V8 eval creation metadata while formatting call sites. Missing-source user frames remain distinct from native frames. The origin adapter stops at opaque user frames and rejects pseudo filenames such as `<input>` instead of scanning onward to an unrelated module. V8 eval sourceURLs bypass host-frame URL filtering after registered module URLs are resolved. Source-map URLs do not name the calling script. These stack adapters are original implementations.
WebKit's browser engine omits eval source locations even with `sourceURL` directives.
CommonJS uses eval in this host, so its caller origin is `null` there. The adapter stops at
an opaque caller frame instead of reporting a later ES module as the caller. ES modules work
in WebKit, and CommonJS origins work in QuickJS, wasm JSC and the Node host.

## Bun patch series

The filenames below are relative to `patches/bun/`. Their diffs are the complete source of truth, including each affected file. The file inventories are included so a reader can check coverage without applying the patches.

### 0001 platform selection and pointer layout

File `0001-wasm-wasi-arms-for-alloc-core-errno-32-bit-pointer-t.patch`. Class **Port**.

Select the POSIX-like code for WASI, add WASI errno definitions, and keep bare wasm stubs separate. Enable real printing, environment access, number formatting, paths, and I/O. Adapt `SmolStr`'s stored pointer word, allocator tags, and `EncodedSlice` pointer tags to 32 bits. Gate native ABI assertions on 64-bit pointers. The 32-bit encoded pointer scheme requires linear memory below 512 MiB, enforced by our link flags.

Without it the toolchain crates fail to compile for WASI, 64-bit constants overflow, and bare-wasm branches drop output or return incomplete results. These are support additions for a target Bun does not ship. An explicit 64-bit assertion is a target restriction, unlike the silently incorrect algorithm in 0007.

Files touched, relative to `vendor/bun/`:

- `src/ast/e.rs`
- `src/bun_alloc/arena_box.rs`
- `src/bun_alloc/baby_vec.rs`
- `src/bun_alloc/basic.rs`
- `src/bun_alloc/lib.rs`
- `src/bun_core/Global.rs`
- `src/bun_core/debug.rs`
- `src/bun_core/env_var.rs`
- `src/bun_core/lib.rs`
- `src/bun_core/output.rs`
- `src/bun_core/string/SmolStr.rs`
- `src/bun_core/string/mod.rs`
- `src/bun_core/tty.rs`
- `src/bun_core/util.rs`
- `src/crash_handler/lib.rs`
- `src/dotenv/env_loader.rs`
- `src/errno/lib.rs`
- `src/errno/wasi_errno.rs`
- `src/event_loop/SpawnSyncEventLoop.rs`
- `src/glob/GlobWalker.rs`
- `src/io/PipeReader.rs`
- `src/io/PipeWriter.rs`
- `src/io/lib.rs`
- `src/io/openForWriting.rs`
- `src/io/posix_event_loop.rs`
- `src/js_parser/parse/parse_entry.rs`
- `src/js_printer/renamer.rs`
- `src/md/ansi_renderer.rs`
- `src/opaque/lib.rs`
- `src/paths/resolve_path.rs`
- `src/paths/string_paths.rs`
- `src/resolver/fs/stat_hash.rs`
- `src/resolver/lib.rs`
- `src/resolver/resolver.rs`
- `src/semver/lib.rs`
- `src/sourcemap/Mapping.rs`
- `src/spawn_sys/lib.rs`
- `src/spawn_sys/spawn_process.rs`
- `src/sys/PosixStat.rs`
- `src/sys/dir.rs`
- `src/sys/file.rs`
- `src/sys/lib.rs`
- `src/threading/ThreadPool.rs`
- `src/uws_sys/SocketContext.rs`
- `src/windows_sys/externs.rs`

### 0002 filesystem threading and layout

File `0002-wasm-sys-dir-iterator-stat-futex-watcher-spawn-types.patch`. Class **Port**.

Add a `readdir`-based directory iterator, WASI stat timestamps, platform types, errno conversions, and WASI watcher stubs. Supply futex operations for a single-thread runtime and gate further 64-bit AST, FFI, HTTP, parser, and source-map layout assertions. Finish cfg corrections from 0001, including removing its duplicate page-size fallback and separating Unix-only Rust APIs from WASI APIs.

Without it directory resolution is unavailable, platform definitions do not type-check, and layout assertions reject wasm32. The watcher does not create native OS watches. Browser file changes are driven by the host. These are port choices rather than fixes to native Bun behavior.

Files touched, relative to `vendor/bun/`:

- `src/analytics/lib.rs`
- `src/ast/b.rs`
- `src/ast/e.rs`
- `src/ast/expr.rs`
- `src/ast/lib.rs`
- `src/ast/nodes.rs`
- `src/ast/stmt.rs`
- `src/ast/symbol.rs`
- `src/bun_alloc/lib.rs`
- `src/bun_core/lib.rs`
- `src/bun_core/string/SmolStr.rs`
- `src/bun_core/string/immutable.rs`
- `src/bun_core/util.rs`
- `src/cares_sys/c_ares.rs`
- `src/collections/array_hash_map.rs`
- `src/errno/wasi_errno.rs`
- `src/event_loop/ConcurrentTask.rs`
- `src/http_types/h2.rs`
- `src/md/parser.rs`
- `src/paths/lib.rs`
- `src/semver/lib.rs`
- `src/sourcemap/InternalSourceMap.rs`
- `src/sourcemap/Mapping.rs`
- `src/spawn_sys/lib.rs`
- `src/sys/PosixStat.rs`
- `src/sys/fd.rs`
- `src/sys/lib.rs`
- `src/sys/linux_syscall.rs`
- `src/sys/sys_uv.rs`
- `src/threading/Futex.rs`
- `src/threading/ThreadPool.rs`
- `src/uws_sys/Loop.rs`
- `src/uws_sys/SocketContext.rs`
- `src/uws_sys/SocketGroup.rs`
- `src/watcher/INotifyWatcher.rs`
- `src/watcher/WasiWatcher.rs`
- `src/watcher/Watcher.rs`
- `src/watcher/WindowsWatcher.rs`
- `src/watcher/lib.rs`
- `src/windows_sys/externs.rs`

### 0003 transpiler dependencies

File `0003-wasm-io-waker-crash-handler-resolver-bun_transpiler-.patch`. Class **Port**.

Add WASI CPU-feature reporting, crash-handler branches, an inert I/O waker, WASI resolver stat hashing, and platform selection for the mini event loop. Without it the transpiler's dependency graph cannot type-check for WASI or references native platform machinery. WASI has neither native CPUID nor Bun's native wake mechanism.

Files touched, relative to `vendor/bun/`:

- `src/crash_handler/CPUFeatures.rs`
- `src/crash_handler/lib.rs`
- `src/io/lib.rs`
- `src/resolver/fs/stat_hash.rs`
- `src/resolver/lib.rs`

### 0004 inline thread pool

File `0004-wasm-thread-pool-runs-scheduled-tasks-inline-on-sing.patch`. Class **Port**.

`src/threading/ThreadPool.rs` drains its task queue inline on wasm without atomics. Nested schedules on the same pool are handled by the outer drain loop, and `warm` starts no workers. Without it the bundler tries to spawn unsupported threads and cannot complete its parse work. Native thread scheduling is unchanged.

### 0005 monotonic timer

File `0005-wasm-Instant-backed-system-timer-on-wasi.patch`. Class **Port**.

`src/perf/system_timer.rs` selects the existing `Instant` implementation for WASI, leaving the timer stub for bare wasm. Without it the resolver's timer reset takes the unsupported stub path. WASI supplies a monotonic clock, while bare wasm does not require one. Native Bun already uses `Instant`.

### 0006 open flags and file descriptor paths

File `0006-wasm-openat-access-mode-and-fd-paths-on-wasi.patch`. Class **Port**.

`src/sys/lib.rs` supplies `O_RDONLY` when an open has no access-mode bits and calls bun-wasm's fd-path bookkeeping when descriptors open and close. `get_fd_path` reads that bookkeeping. Without it an `O_DIRECTORY`-only open fails with `EINVAL` because WASI's `O_RDONLY` is nonzero, and the resolver cannot recover a descriptor's path. Native targets have different flags and fd-path facilities.

### 0007 string equality

File `0007-wasm-strings-eql-compares-8-byte-words-on-32-bit-tar.patch`. Class **Upstream bug**.

`src/bun_core/string/immutable.rs::eql_long` counts eight-byte words but originally loads and advances by `usize`. It also skips its four-byte tail on 32-bit targets. Read eight-byte words consistently and always check the four-byte tail. Without it different strings can compare equal, causing incorrect identifier matching and minified loop labels.

This classification is a judgment about the algorithm, not a claim that native Bun 1.4.2 ships a broken 32-bit binary. The same Rust function is incorrect on any 32-bit platform. Extracting the exact unpatched function from the pinned source gives `eql(b"abcd", b"wxyz", true) == true` on wasm32 and `false` on native x86_64. The patched function returns `false` on wasm32. The installed native Bun 1.4.2 is 64-bit and does not reach the faulty width case.

The ready-to-file report and complete standalone Rust reproduction are in the owner's `/work/reports/upstream-bugs/README.md` and `bun-wasm-eql/repro.rs` beside it. No upstream issue has been posted.

### 0008 await context hooks

File `0008-wasm-optional-await-hooks-in-the-printer-for-a-host-.patch`. Class **Host feature**.

`src/js_printer/lib.rs` adds `BUNWASM_AWAIT_HOOKS`, off by default. It prints `await x` through `__bunwasm_capture` and `__bunwasm_resume`, and adds matching hooks around `for await` bodies and after loops. Labeled loops keep valid `continue` targets. The browser runtime enables this during its own transpiles, never for ordinary `bun build` output.

Without it browser-engine `AsyncLocalStorage` loses its frame across suspension because that host lacks Bun's engine integration. This adds a host contract, not a repair to Bun's normal printer output.

### 0009 bake completion

File `0009-Drive-bake-completion-from-the-WASI-mini-event-loop.patch`. Class **Port**.

`src/bundler/bundle_v2.rs` exposes `finish_wasi_dev_server` to wait for parsing and call the existing bake completion path. Without it bun-wasm's synchronous mini event loop cannot drive the native asynchronous completion task, so dev-server bundles cannot finish through that path. Native bake already schedules its completion.

### 0010 semantic import locations

File `0010-wasm-expose-semantic-dynamic-import-locations-to-the.patch`. Class **Host feature**.

Upstream paths are `src/js_parser/lib.rs`, `src/js_parser/parse/parse_import_export.rs`, and `src/js_printer/lib.rs` at pinned Bun revision `9510e74152073d850a18758ca41114d8f214ffa6`. A scoped, thread-local parser collector records the original UTF-8 keyword offset when Bun scans a dynamic import expression. A printer collector records emitted UTF-8 spans for static paths and dynamic keywords during the existing transpile pass. Both restore the previous collector on return or unwind. Import.meta and property names never enter the dynamic-import branches. Parsing and printing otherwise behave unchanged.

The original adapters in `crates/bunwasm-transpiler/src/lib.rs`, `crates/bunwasm-cli/src/main.rs`, and `crates/bunwasm-runtime/src/{transpiler,modules,engine_host}.rs` return spans with transpiled code and cache them by source path. Transformed modules are not parsed again for linking. Unchanged JavaScript reuses the AST and dynamic-import locations from the parse already required for module classification, skips printing and keeps original source offsets. For `.mjs` and `.cjs`, whose extensions already decide the format, Bun's scan-only parser supplies imports without a full transform. An absence check for `import` and `from` skips that scan when neither can occur. The scan adapter changes a leading `#!` into `//` before parsing, matching runtime normalization and preserving all UTF-8 byte offsets, including CRLF and Unicode prefixes. Eval sources use Bun's scan-only parser once; an absence check for `import` and `from` skips eval scanning when no import or re-export is possible. The ESM-to-CJS adapter sets a scoped referrer so the bundler printer emits dynamic-import hooks directly, then caches its output. It does not scan the bundle again. Host prologues shift the stored byte spans without parsing. The import arguments remain intact, including import attributes and template substitutions. This is a bun-wasm host requirement, not an upstream Bun bug.

### WebKit platform hunks

File `jsc/webkit-wasi.patch`. The following hunks have class **Port**.

| WebKit file | Change | What breaks without it |
| --- | --- | --- |
| `Source/JavaScriptCore/CMakeLists.txt` | Link the two LLInt extractors with imported memory. | wasm-ld trims trailing zero data that offlineasm expects to scan. |
| `Source/JavaScriptCore/heap/RegisterState.h` | Avoid `setjmp` and provide an inert WASI register-state structure. | WASI has no supported native register-spill API. Wasm locals need the separate spill-pointers finalization. |
| `Source/JavaScriptCore/runtime/JSCBytecodeCacheVersion.cpp` | Exclude `dlfcn.h` for WASI. | The dynamic-loader header is unavailable. |
| `Source/JavaScriptCore/runtime/Options.cpp` | Add the WASI `size_t` parser specialization. | WASI's distinct integer types leave the option parser without an implementation. |
| `Source/WTF/wtf/PlatformHave.h` | Disable the resource-header capability on WASI. | Native resource API assumptions fail. |
| `Source/WTF/wtf/PlatformOS.h` | Define `OS(WASI)` and include it in Unix-like selection. | WASI gets no usable platform selection. |
| `Source/WTF/wtf/PlatformRegisters.h` | Avoid the native ucontext header. | The header is unavailable. |
| `Source/WTF/wtf/RandomDevice.cpp` | Use `getentropy` in chunks of at most 256 bytes. | WASI has no `/dev/urandom` path. |
| `Source/WTF/wtf/RawHex.h` | Include WASI's distinct 32-bit integer overloads. | The integer overload set is incomplete for the WASI ABI. |
| `Source/WTF/wtf/StackBounds.cpp` | Read wasm-ld's shadow-stack bound symbols. | Native pthread stack discovery cannot find the wasm shadow stack. |
| `Source/WTF/wtf/dtoa/utils.h` | Recognize wasm's correct double operations. | double-conversion rejects the unrecognized architecture at compile time. |
| `Source/bmalloc/libpas/src/libpas/pas_lock.h` | Accept WASI in the lock platform selection. | The header rejects this target even though bmalloc is disabled. |
| `Source/cmake/OptionsJSCOnly.cmake` | Disable native API tests for WASI. | The cross-build includes unsupported test targets. |
| `Source/cmake/WebKitCommon.cmake` | Recognize CMake's WASI system name. | Configure rejects the OS. |

`jsc/wasi-jsc.cmake`, `jsc/configure.sh`, and `jsc/shim/wasi-compat.{h,c}` plus `madvise.c` are our **Port** configuration and glue, not edits to upstream source. They select the C-loop interpreter, system malloc, single-thread GC, and disabled JIT/Wasm tiers; supply temporary-file helpers and inert signal/scheduling declarations; and link the WASI support library. Without them the target cannot configure or link. `jsc/finalize.sh` runs Binaryen's `--spill-pointers`, without which conservative GC misses references in wasm locals. See [the JSC notes](../jsc/README.md).

### WebKit module import slots

Files `Source/JavaScriptCore/runtime/JSModuleEnvironment.{h,cpp}` in `jsc/webkit-wasi.patch`. Class **Upstream bug**.

Allocate the module record, import count, and each import slot at a full variable-slot stride. Zero the whole import slot before clearing its pointer. Without this, pointer-sized slots on 32-bit targets overlap when addressed through `importSlotScopeOffset` as JSValue-sized variables. An import can resolve to another imported module's binding. Clearing only the pointer also leaves the rest of a JSValue load uninitialized.

The mismatch concerns pointer width and slot addressing, not a missing WASI API. That is why this is an upstream bug. The installed native Bun 1.4.2 uses 64-bit pointers and passes `tests/fixtures/engine-esm-imports`; it cannot exercise the width mismatch. A native 32-bit WebKit build has not been run. The same slot-size relationship makes that configuration suspect, but this ledger does not claim a native 32-bit reproduction. The ready-to-file report in the owner's upstream list records that limit.

### WebKit non-JIT declarations

Files `Source/JavaScriptCore/dfg/DFGAbstractHeap.h`, `Source/JavaScriptCore/runtime/JSModuleLoader.cpp`, and `Source/JavaScriptCore/runtime/VM.cpp` in `jsc/webkit-wasi.patch`. Class **Upstream bug**.

Move `AbstractHeapKind` outside the DFG-only guard because `DOMJIT::Effect` uses it without DFG. Include `<wtf/Scope.h>` in the two translation units that use its helpers. Without these changes the fork's C-loop configuration fails to compile.

This is a judgment call. The build failures are in a non-JIT configuration and do not depend on WASI syscalls or wasm pointer size. They are upstream configuration bugs, although bun-wasm is what needs that configuration. Running the installed native Bun 1.4.2 cannot test missing compile-time declarations. Its default build does not exercise this configuration. A fresh native C-loop build has not been attempted. The owner's ready-to-file report states the source evidence and the unrun native build check separately.

### libc

`third_party/libc` is libc **0.2.186**, selected by `[patch.crates-io]`. Class **Port**.

Only two source files differ from the published crate. `src/wasi/mod.rs` adds the unused POSIX fields to `rusage`, exposes the existing p2 socket definitions on p1, and exports `posix_compat`. New `src/wasi/posix_compat.rs` declares missing mmap, signal, process, spawn, terminal, resource, scheduling, and socket APIs and constants. `bunwasm-posix` supplies absent symbols. Without this layer Bun's POSIX-oriented crates fail to compile or link for wasip1. These declarations describe bun-wasm's shim contract; they do not establish that upstream libc has the wrong WASI ABI.

The vendored package omits upstream tests and Cargo's `.cargo_vcs_info.json`. Other retained source and build files match the published 0.2.186 crate.

### QuickJS

`third_party/rquickjs-sys` is rquickjs-sys **0.13.0**, with its bundled QuickJS-ng. Every change below has class **Host feature**.

| File and area | Change | What breaks without it |
| --- | --- | --- |
| `quickjs/quickjs.c`, parser call locations | Record the callee, property, or constructor position after parsing arguments. | Stack frames and source maps point to QuickJS's argument position instead of Bun/JSC's call position. This is a compatibility policy, not an ECMAScript violation by QuickJS. |
| `quickjs/quickjs.c`, `JS_bunwasm_OwnKeysInOrder` | Return ordinary-object keys in JSC's inspection order, with integer keys sorted and symbols interleaved by insertion. | Bun-compatible console inspection cannot reproduce that order through `Reflect.ownKeys`. |
| `quickjs/quickjs.c`, `JS_bunwasm_IteratorEntries` | Snapshot remaining Map/Set iterator entries without advancing the iterator. | Console inspection either lacks the entries or consumes the user's iterator. |
| `quickjs/quickjs.c`, async context | Store and trace a context value, capture it in promise reactions, restore it for jobs, and expose get/set functions. | QuickJS `AsyncLocalStorage` loses its store across promise and await boundaries. The original engine has no obligation to implement Node's API. |
| `build.rs` | Add rerun tracking for `quickjs` and `quickjs.bind.h`. | Local C changes can leave Cargo using a stale engine until another input invalidates it. This hook supports our fork. |

No existing binding source or C header is modified. Our Rust engine declares the added functions. The vendored tree keeps Linux x86_64 and wasm32-wasip1 bindings and the C files needed by the library, dropping other targets, shell programs, tests, build tooling, and package metadata. It adds the license copy. These packaging choices do not change retained upstream implementations. Every other retained source file matches the published crate.

### ICU

`jsc/build-icu.sh` builds ICU **78.3**. Class **Port** for each of the following changes.

The script copies `source/config/mh-linux` to `mh-unknown` in the wasm source tree and clears `GENCCODE_ASSEMBLY` there. Without this build-time rewrite ICU has no usable WASI platform makefile and attempts unsupported native assembly output. There are no other local ICU source edits.

The script also filters the embedded data to root and English locales and removes converters, transliterators, and Unicode names. This is a data modification, not a C++ source patch. Without filtering the binary carries substantially more locale data against the 512 MiB wasm limit. Other locales fall back to root. Flags disable mmap, dynamic loading, and native timezone globals. These are port configuration decisions.

### Nested Bun dependencies

`scripts/sync-bun.sh` fetches Bun's pinned `oven-sh/lol-html` and `sru-systems/rust-argon2`. There are no bun-wasm edits to lol-html.

It applies Bun's own `patches/rust-argon2/legacy-low-memory.patch` to rust-argon2's `src/common.rs` and `src/context.rs`. Class **Host feature**. This inherited Bun extension accepts nonzero memory costs below `8 * lanes` and pads allocated memory, so hashes produced by Bun's legacy low-memory behavior can still verify. Without it those hashes are rejected by the dependency. This is Bun's existing application policy, not a new wasm fix or a bug in rust-argon2. The patch also updates the dependency's tests.

Bun's configure generates its normal Rust build options and byte-class tables. `sync-bun.sh` removes the configure-generated `.cargo/config.toml` so its host linker selection does not override ours. That removal is **Port** build configuration. No build script rewrites Bun Rust source beyond the exported patch series. `scripts/wasify.py` is an editing helper, not an invoked build transformation. Its exported edits belong to the patch series above.

### Copied and generated Bun source

`crates/bunwasm-glue/src/bun_native.rs` copies the pinned Bun file `src/sema/standalone/native.rs`. Class **Port**. Its only implementation changes supply base64 length, encode, strict decode, and lenient decode functions and a working `compress2` backed by `miniz_oxide`. The standalone parser intentionally leaves these as stubs. Without replacements wasm bundling paths that need base64 or compression fail. This does not repair the native Bun implementations, which link their real libraries.

All Bun paths in the following sections refer to `oven-sh/bun` at `9510e74152073d850a18758ca41114d8f214ffa6`, the pin above. This includes Node implementations carried in Bun's tree. Bun's original MIT source and its inherited Node and better-sqlite3 code retain their respective upstream provenance.

For direct Node ports, the historical import revision is **not recorded** in the source headers or introducing commit `45671e47b114b16d5953d3ebecee1fbebf2678b5`. The audit compares them with [`nodejs/node` v22.20.0, `caa20e28dc1f21a97f7b2a7134973fd6435b65f0`](https://github.com/nodejs/node/tree/caa20e28dc1f21a97f7b2a7134973fd6435b65f0). That is a reproducible comparison revision, not a claim about the original import. Recognizable adapted fragments are included even when their headers do not declare a port.

### Build command

`crates/bunwasm-build/src/lib.rs`. Class **Port**. Upstream `src/runtime/cli/build_command.rs` and build-option definitions in `src/runtime/cli/Arguments.rs` at the Bun pin.

Retain the option setup, `BundleV2::generate_from_cli` flow, output writing, and summary formatting. Replace the JSC command context with `BuildArgs` and returned `BuildOutput` values. Printing and process exit belong to the caller. Omit native executable compilation, bytecode, app mode, server components, check/watch modes, macros, and plugins. This extraction lets WASI call the real bundler without linking Bun's JSC runtime. The local CLI parsers around it are adapters, not copies of the whole upstream argument parser.

### Bake graph adaptations

`crates/bunwasm-build/src/dev_server/facade.rs`, `crates/bunwasm-build/src/dev_server/graph.rs`, and `crates/bunwasm-build/src/dev_server/finalize.rs`. Class **Port**. Upstream `src/runtime/bake/DevServer.rs`, `src/runtime/bake/dev_server/mod.rs`, and `src/runtime/bake/dev_server/source_map_store.rs` at the Bun pin.

The facade retains graph context and result structures, trace-bit handling, and CSS accumulation. The graph owner adapts bundle extraction, source-map entry shapes, route indices, and the HMR runtime accessor. Finalization translates the host-independent part of `DevServer::finalize_bundle`, including receiving emitted JS/CSS/HTML and updating import edges. These are adapted implementations, not merely original wrappers around unchanged graph modules.

Replace the native server's locks, watchers, route machinery, and scheduling with single-thread state, host notifications, and synchronous output. Keep the frontend bundling path without native server-component execution. `dev_server/mod.rs` and `hooks.rs` wire this state into BundleV2. `cache.rs` adds bun-wasm's dependency-cache format. Those host adapters and the cache implementation are original code.

The incremental graph, packed map, and serialized-failure implementations are compiled directly through `#[path]` from `src/runtime/bake/dev_server/{incremental_graph,packed_map,serialized_failure}.rs`. They are unchanged upstream modules, not additional copied forks.

### Generated bake clients

`crates/bunwasm-build/generated/bake.client.js` and `crates/bunwasm-build/generated/bake.error.js`. Class **Port**. Upstream `src/codegen/bake-codegen.ts` generates these from `src/runtime/bake/hmr-runtime-client.ts`, `src/runtime/bake/hmr-runtime-error.ts`, and their imported client/runtime modules at the Bun pin.

`scripts/generate-bake.sh` runs that generator and copies the resulting bundles without a local source rewrite. They supply Bun's HMR protocol, React refresh integration, and browser error overlay to the WASI dev server. The script is our adapter. The generated JavaScript is upstream code, and `--check` compares both embedded files with fresh generator output.

### Transpiler source-map collector

`crates/bunwasm-transpiler/src/lib.rs`, `ChunkCollector` and its `OnSourceMapChunk` implementation. Class **Port**. Upstream `src/runtime/cli/pm_diff_normalize.rs` at the Bun pin.

Retain the small callback that stores the emitted `bun_sourcemap::Chunk` in an `Option`. The local caller converts its buffer into the returned mappings string. This supplies source maps without the native runtime. The surrounding arena lifecycle, public transpile API, parser module-kind reporting, diagnostic conversion, and await-hook control are local adapters to Bun's parse/print APIs. Module classification uses the pinned parser's export kind, syntax flags and live static import records, rather than searching printed strings. Syntax-free scripts retain package and filename classification, and data loaders report their generated ESM format. `node_fs.js` vectored writes and `natives.rs` counted `write`/`pwrite` calls are original adapters over the host descriptor ABI; no Node implementation is copied. The native vectored operation accumulates complete chunks, returns progress on a short write or a later error, and leaves positioned-write cursors unchanged. Printed CommonJS factories receive Bun's sixth per-module import-meta argument when present; ordinary factories retain five arguments. The parser's real `import.meta` flag takes precedence over `require` and `__dirname` signals when choosing module grammar. They do not copy `src/runtime/api/JSTranspiler.rs` as an implementation.

### Bun console formatter

`crates/bunwasm-runtime/src/js/inspect.js`, the Bun formatting factory. Class **Port**. Upstream `src/jsc/ConsoleObject.rs`, `src/jsc/VirtualMachine.rs` (`print_error_instance_body`), and `src/jsc/bindings/bindings.cpp` (`JSC__JSValue__forEachPropertyImpl` and `JSC__JSValue__forEachPropertyOrdered`) at the Bun pin.

Translate Rust and C++ formatting into JavaScript, retaining the estimated-line-length accounting, type-specific rendering, error frames, and property order. Replace direct JSC operations with intrinsic brand checks and host inspection calls. This preserves Bun's console and `Bun.inspect` output across QuickJS, JSC, and the browser engine without the native console bindings. `console.js` routes output and manages groups, counters, and timers using this formatter. It is an original adapter.

### Node inspection

`crates/bunwasm-runtime/src/js/inspect.js`, `createNodeInspect`. Class **Port**. Upstream `src/js/internal/util/inspect.js` at the Bun pin, itself Node's MIT-licensed inspection implementation.

Retain substantial inspection and format logic, including layout, strings, containers, option handling, and substitution formatting. Replace primordials, Bun intrinsics, internal imports, and native preview helpers with captured ordinary intrinsics, JavaScript emulation, and the local engine hooks. Package the implementation as a factory with `nodeInspect`, `nodeFormat`, and `nodeFormatWithOptions` exports. This makes `node:util` inspection available outside Bun's internal module system. It is distinct from the Bun console formatter in the same file.

### Inspection host hooks

`crates/bunwasm-runtime/src/js/inspect.js`, host integration around both formatters. Class **Host feature**. These are original bun-wasm additions around the Bun sources cited above, not another copied upstream file.

Read promise state/results, proxy targets, namespace brands, ordered keys, and remaining iterator entries through `internal` hooks. Use source-line lookup for error display. These hooks let an engine host expose information ordinary JavaScript cannot inspect reliably or without consuming an iterator. The QuickJS implementations are classified separately in the vendored-engine section.

### Node path

`crates/bunwasm-runtime/src/js/path.js`. Class **Port**. Upstream Node `lib/path.js`, POSIX implementation, at the Node comparison revision above. The import revision is not recorded. Bun's older browser fallback `src/node-fallbacks/path.js` at the Bun pin carries related POSIX code and identifies its own origin as Node v8.11.1. That does not establish bun-wasm's import revision.

Retain the segment scans and POSIX normalize, resolve, relative, dirname, basename, extname, format, and parse algorithms. Extract helpers such as `popSegment` and `scanExt`, replace primordials and validators, accept boxed strings to match Bun, and resolve against guest `process.cwd()`. Export a factory. `win32` reuses the POSIX functions with different separator constants and does not implement Windows paths. The changes avoid host filesystem and native path dependencies.

### Node Buffer fragments

`crates/bunwasm-runtime/src/js/buffer.js`. Class **Port**. Comparison sources are Node `lib/buffer.js` at the Node comparison revision, plus Bun `src/js/builtins/JSBufferConstructor.ts` and `src/node-fallbacks/buffer.js` at the Bun pin. The direct Node import revision is not recorded.

Retain recognizable Buffer constructor dispatch, `fromObject` array-like handling, and concatenation fragments. Adapt the FastBuffer pattern to locally allocated `Uint8Array` storage without Node's native binding, unsafe allocator, or pool. Local codecs, `DataView` numeric access, validation helpers, and factory wiring provide the remaining implementation. This is a mixed file with adapted routines, not an unmodified copy of Node's entire Buffer module.

### Node event emitter

`crates/bunwasm-runtime/src/js/events.js`. Class **Port**. Comparison sources are Node `lib/events.js` at the Node comparison revision and Bun `src/js/node/events.ts` at the Bun pin. The direct Node import revision is not recorded.

Retain listener storage conventions, once-wrapper state, listener removal, and remove-all behavior. Replace primordials, internal validators, and native async-resource or EventTarget integration with local validation and runtime scheduling. The module also supplies local promise and async-iterator helpers. These changes provide Node-style listener semantics on the guest event loop without native async hooks.

The listener-publication hook is a separate **Host feature**, an **original adapter**, not copied
from Node or Bun. It runs immediately after listener storage mutates and before user removal
observers, publishing this host's signal disposition synchronously. It covers prototype calls,
once wrappers, removal, remove-all and reentrant observers without replacing the retained
EventEmitter bookkeeping or adding native async hooks. Its process/stdout consumers are original
host adapters described under [Browser process service](#browser-process-service).

### Node utility fragments

`crates/bunwasm-runtime/src/js/util.js`. Class **Port**. Upstream Node `lib/internal/util/parse_args/{parse_args,utils}.js`, `lib/internal/util/comparisons.js`, `lib/internal/util.js`, and `lib/util.js` at the Node comparison revision. Also compare Bun `src/js/node/util.ts` and inspection tables in `src/js/internal/util/inspect.js` at the Bun pin. The direct Node import revision is not recorded.

Adapt parse-argument tokenization, own-property option lookup, short-option groups, strict validation, defaults, and negative options. Replace internal errors and primordials with local helpers and Bun's messages and token names. Retain comparison helper structure and memo conventions, inheritance and promisification fragments, and inspection option/color/style tables. Replace native type checks with intrinsic brand checks and engine hooks. Formatting delegates to the separate inspection port. Bun's deep-equality variant and the surrounding module wiring are local implementations, not copies of Node's whole utility module.

### Node assertions

`crates/bunwasm-runtime/src/js/assert.js`. Class **Port**. Upstream `src/js/node/assert.ts` and `src/js/internal/assert/assertion_error.ts` at the Bun pin, which carry Node assertion code.

Retain assertion dispatch, expected-exception matching, async rejection helpers, readable operator messages, and assertion-error formatting conventions. Replace internal imports, native diff helpers, and primordials with the local utility inspector, equality functions, and a JavaScript diff renderer. Source-expression recovery is omitted, so `ok(false)` reports `false == true`. This runs assertions without Bun's internal bindings. The adapted helpers are separate from the locally written diff implementation.

### Bun SQLite

`crates/bunwasm-runtime/src/js/bun_sqlite.js`. Class **Port**. Upstream `src/js/bun/sqlite.ts` and the behavior implemented by `src/jsc/bindings/sqlite/JSSQLStatement.cpp` at the Bun pin.

Adapt Database/Statement behavior, constants, named-parameter handling, strict mode, query caching, and transaction wrappers. Replace `$cpp` calls and JSC statement objects with numeric handles and `native.sqlite` operations implemented in Rust in `crates/bunwasm-runtime/src/sqlite.rs`. JavaScript shapes values and rows while Rust binds and steps the unmodified SQLite library. This keeps SQLite usable without Bun's C++ engine bindings. The Rust ABI adapter is original code, not a copy of `JSSQLStatement.cpp`.

The transaction controller and wrapper retain code Bun explicitly attributes to Joshua Wise's better-sqlite3 `lib/methods/transaction.js`. The retained upstream revision is Bun's pin. A separate better-sqlite3 import revision is not recorded in that section. Keep BEGIN/COMMIT, nested savepoints, rollback, and the four transaction modes, replacing statement ownership/preparation with the local native-handle model. This is inherited copied implementation, not an original transaction adapter.

### QuickJS string boundary

Class **Host feature**. Original adapter using QuickJS-ng through rquickjs-sys 0.13.0.
Retain the valid UTF-8 fast path. If QuickJS returns a string containing lone UTF-16
surrogates, read its UTF-16 units through `JS_ToCStringLenUTF16`, replace unpaired units
with Rust's `String::from_utf16_lossy` and release the QuickJS buffer. This prevents
native UTF-8 consumers from receiving `undefined` for a valid JavaScript string.
No upstream implementation is copied or modified.

### Bun ArrayBufferSink

Class **Port**. Upstream `src/runtime/webcore/ArrayBufferSink.rs`,
`src/runtime/webcore/streams.rs` and `src/runtime/webcore/Sink.rs` at Bun
`9510e74152073d850a18758ca41114d8f214ffa6`.

Translate the byte ownership, streaming flush, repeated end, restart and closed-sink behavior
to JavaScript typed arrays. Preserve the start option parser's own-property check, strict
boolean modes, numeric watermark detection and getter ordering before the live-sink check.
The closed-sink error text comes from `Sink.rs`.

The upstream module depends on `bun_jsc`, so it cannot be imported as an independent Rust
crate. Engine-owned buffers let every engine reclaim abandoned sinks without a new native
handle table or finalizer interface. String writes use the existing Rust UTF-8 encoder.
The watermark remains an allocation hint and causes no eager reservation in this adapter.
The callable constructor and private JavaScript storage are original binding adapters.
Detached backing stores produce an owned empty chunk before view bounds are read or a new view is constructed. Capture ArrayBuffer, SharedArrayBuffer, TypedArray and DataView intrinsic getters to extract the real backing buffer and
bounds before copying. Own properties and accessors cannot replace those internal slots.
This byte-view extraction is also an original binding adapter.
The unsupported GC-tuning member is absent from `Bun.unsafe`, so the upstream harness's
capability check can run byte-content tests without requesting unavailable GC controls.

### Host GC hook

Class **Host feature**. Original host adapter. Capture an exposed host collector before
installing guest globals. Bun's `test/harness.ts` at revision
`9510e74152073d850a18758ca41114d8f214ffa6` replaces global `gc` with a call to `Bun.gc`;
looking up that guest wrapper from the host hook recurses. Hosts without an exposed collector
still cannot force collection. No upstream implementation is copied.

### Bun cookies

`crates/bunwasm-runtime/src/js/cookie.js`. Class **Port**. Upstream `src/jsc/bindings/{Cookie,CookieMap}.{cpp,h}` and `src/jsc/bindings/webcore/{JSCookie,JSCookieMap}.cpp` at the Bun pin.

Translate cookie parsing, attribute validation, serialization, CookieMap behavior, and binding coercions into JavaScript. Replace native objects with WeakMap-backed state, use local string/date operations, and route inspection through Bun.inspect. These changes preserve the API without JSC host classes. This is a translated port even though it shares little literal source text with C++.

### Node string decoder

`crates/bunwasm-runtime/src/js/string_decoder.js`. Class **Port**. Upstream Node `src/string_decoder.cc` at the Node comparison revision. The import revision is not recorded.

Translate the buffered/missing-byte state machine into JavaScript using a four-byte `lastChar`, `_buffered`, and `_missing`. Preserve UTF-8 continuation handling, UTF-16 surrogate tails, base64 groups, and flush behavior. Replace native buffers and binding calls with the local Buffer factory, and expose the StringDecoder methods and state getters. This handles split characters without Node's native decoder.

### Bun test diff formatting

`crates/bunwasm-runtime/src/js/bun_test.js`, pretty-value and diff-formatting helpers. Class **Port**. Upstream `src/runtime/test_runner/pretty_format.rs` and `src/runtime/test_runner/diff/printDiff.rs` at the Bun pin.

Translate the colorless formatting path, sorted keys, expected/received sections, context chunking, line prefixes, and agent-mode thresholds to JavaScript. Replace Bun's tuned Myers line differ with a local common-prefix/suffix trim and LCS implementation for small diffs, with a bounded large-diff path. This reproduces useful test diagnostics without the native test runner. Discovery, scopes, matchers, mock tracking, scheduling, and snapshot storage in the rest of the file are local implementations that follow Bun's observable contract.

### Node URL helpers

`crates/bunwasm-runtime/src/js/node_url.js`. Class **Port**. Upstream `src/js/internal/url.ts` (`urlToHttpOptions`) and `src/js/node/url.ts` (legacy Url fields and format fragments) at the Bun pin. Related code also exists in `src/node-fallbacks/url.js`.

Retain HTTP option extraction, IPv6 hostname handling, auth decoding, legacy field initialization, and format escaping. Replace native URL machinery and internal validators with the local WHATWG URL implementation and error helpers. File-URL conversion and the simplified legacy parse/resolve wrapper are local code. This adapts the copied helpers without importing Bun's native URL binding.

### HTTP status tables

`crates/bunwasm-runtime/src/js/builtins.js` (`STATUS_CODES`) and `crates/bunwasm-runtime/src/js/net.js` (`STATUS_TEXT`). Class **Port** for packaging shared HTTP data. Comparison source `src/js/internal/http.ts` at the Bun pin.

The builtins module retains the status-code/reason table. The network module keeps a smaller reason-phrase table for response output. The callable Node `Stream` constructor and descriptor vectored writes are original adapters, not copied Node implementations. These are standard HTTP values rather than a copied server implementation. Networking, streams, request dispatch, and host transport around the tables are original bun-wasm adapters.

### Temporal

`third_party/temporal/entry.js`, `package.json`, and `bun.lock` pin `@js-temporal/polyfill` **0.5.1** and **jsbi 4.3.2**. Class **Host feature** for packaging the fallback.

`scripts/vendor-temporal.py` bundles the unmodified packages, minifies them, and wraps the CommonJS output as a factory in `crates/bunwasm-runtime/src/js/temporal.js`. Without the wrapper our engine cannot load the fallback used for Bun's TOML date values. There are no local changes to either dependency's source. The entry, lockfile, and copied licenses record its provenance.

## Port bugs fixed in bun-wasm's own code

### Zero-length stdin reads waited for EOF

`crates/bunwasm-runtime/src/natives.rs`, native `read` callback. A zero-length stdin read called `std::io::stdin().read` with an empty buffer. Rust's buffered stdin reader fills its internal buffer when empty, causing an 8 KiB WASI read that waits for input or EOF. `fs.readSync(0, new Uint8Array(0), 0, 0, null)` therefore hung on an open pipe. Native Bun 1.4.2 returns `0` immediately.

Return an empty byte result for fd 0 before entering buffered stdin when the requested buffer is empty. Other fds use unbuffered `File::read` after lookup in our fd table, so they do not have this buffered-stdin cause. Their error and seek paths are preserved. Callback `fs.read` and promise `FileHandle.read` delegate to `readSync`, which calls this native. `readv` and `readvSync` are not implemented. Full-stream `readStdin` intentionally reads until EOF and is a different operation.

QuickJS, JSC, and the browser-host engine install the same native table, so the fix applies to all three. No Bun or third-party source changes for this fix. The fixture `tests/fixtures/fs-empty-read` covers empty and nonempty destination buffers with zero requested length, options, regular files, invalid descriptors, callbacks, and promises. `tests/test-empty-stdin.py` holds a pipe open until the guest exits and kills and reaps it on timeout. Closing the pipe as test input would conceal the defect.

The normal `scripts/test.sh` runner uses the open-pipe driver for this fixture. Reproduce under wasmtime with `source env.sh && python3 tests/test-empty-stdin.py`. The same test accepts `--engine native`, `--engine jsc`, and `--engine browser`; browser runs the host-engine wasm through Node's V8 and WASI host. This is an engine-host regression, not a browser UI test.

## Audit method

The inventory comes from `patches/bun/*.patch` and tracked files under `crates/`, `web/`, `sandbox/`, `scripts/`, `jsc/`, `site/`, and `third_party/`. The copied-source pass reads provenance headers, license notices, declared translations, generated-source inputs, and source-write operations. It also compares nontrivial implementation lines and token sequences against Bun's sources, then checks candidates against the exact Bun pin with `git show <pin>:<path>`. Direct Node comparisons use the exact reference revision above. Literal matching alone misses translated ports such as cookies, console formatting, and string decoding.

The sweep includes browser WASI/FS/network/engine bridges, sandbox cache/editor wiring, script runners, JSC FFI declarations and C++ helpers, and build-time shims. These are original adapters, configuration, or API declarations except for the entries explicitly listed above. Shared calendar names, public field layouts, and ordinary API-call boilerplate do not establish copied implementations. For example, the PerformanceEntry field assignments in `web.js` match a public data shape, and the JSC loader callbacks use the engine's required signatures. They are not classified as upstream forks on that basis.

The inventory and marker search can be repeated from the repository root. Marker hits are review candidates, not an automatic proof of copying.

```sh
git ls-files crates web sandbox scripts jsc site third_party
rg -n -i --max-columns 240 'copyright|license|ported|port of|adapted|copied|derived|based on' crates web sandbox scripts jsc site
```

Retained libc and rquickjs-sys files were compared byte-for-byte with the matching published crates in Cargo's registry. The `vendor/bun` working tree must be clean after applying all ten commits. There are no additional unexported Bun source modifications in the audited checkout.

SQLite is supplied by the unmodified `libsqlite3-sys` crate. `.cargo/config.toml` sets its documented compile flags to match Bun where possible and disable unsupported WASI facilities; it does not rewrite the amalgamation. No additional third-party source rewrites were found in crate build scripts. Test fixture npm packages are source inputs for compatibility tests, not runtime forks.

## Bun generated builtins

Class **Port**. Upstream Bun source revision `9510e74152073d850a18758ca41114d8f214ffa6`, generated by `src/codegen/bundle-modules.ts`. The source modules are `src/js/internal/freelist.ts`, `src/js/node/querystring.ts`, and `src/js/node/punycode.ts`. The module-name table comes from the generated internal-module registry and `src/jsc/modules/NativeModuleList.h`. Native-hook identities come from `GeneratedJS2Native.h`. Error-code ordering comes from `src/jsc/bindings/ErrorCode.ts`.

The numbered JavaScript files in `crates/bunwasm-runtime/generated/builtins/` retain Bun's generated implementations. The local generator changes intrinsic identifiers, intrinsic property calls, private property names, and the module export marker. It preserves the module's algorithms. The registry, binding names, and catalog are derived upstream data, rather than handwritten runtime implementations. `scripts/generate-bun-builtins.sh --check` reproduces every generated file. Bun's license is retained alongside the generated sources.

## Builtin loader adapter

Class **Host feature**. `scripts/generate-bun-builtins.mjs`, its shell runner, the selection manifest, and `crates/bunwasm-runtime/src/js/bun_builtins.js` are original adapters. `src/js/bun_builtin_globals.ts` is the original bootstrap capture of intrinsic constructors, before application code can replace public globals. They call Bun's codegen and consume its generated module protocol. They do not copy the codegen implementation. Rust source lookup and Engine natives are original bun-wasm glue. The loader uses lazy factories, isolated caches, explicit unsupported errors, and the existing builtin implementations for dependencies not switched yet. [bun-builtins.md](bun-builtins.md) records its limits and hook status.


## WebCrypto backend

`crates/bunwasm-runtime/src/crypto.rs` links RustCrypto primitives and its maintained JWK,
PKCS#8 and SPKI parsers. Cargo.lock pins the dependency revisions. Bun's BoringSSL pin `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f` handles RSA signing,
verification and OAEP encryption and decryption through the original `crates/bunwasm-crypto-sys/c/rsa.c` adapter.
BoringSSL also owns RSA key generation, component validation and PKCS#1 parsing. The
RustCrypto RSA dependency is excluded because it documents RUSTSEC-2023-0071. The maintained
RustCrypto PKCS#8 and SPKI parsers handle the outer key-format envelopes.
`scripts/sync-crypto.sh` downloads the unmodified source. `third_party/licenses/boringssl-LICENSE`
is the unmodified LICENSE from that pin. The crypto placeholders in `crates/bunwasm-glue/src/extra.rs` are removed so Bun and this
adapter use BoringSSL's real allocator, stack and X.509 interfaces with their correct ABI.
The three SSL session placeholders remain because TLS sessions are outside this adapter. The build disables assembly,
threads and socket BIOs on WASI, as in the earlier successful runtime spike.

The original request adapter
and `src/js/crypto.js` connect them to every Engine through the existing data-native bridge.
Bun's WebCrypto implementation calls JSC and native C++ bindings, so it cannot run as an
engine-independent builtin yet.

The `gcm` helper adapts `aes-gcm` 0.10.3 `src/lib.rs`, `init_ctr`, `compute_tag`, and its
`AeadInPlace` implementation from RustCrypto/AEADs. WebCrypto accepts runtime nonce lengths
and 32-bit and 64-bit tags, while that crate requires a type-level nonce length and tags of at
least 96 bits. The adapter uses the same RustCrypto AES, CTR32 and GHASH implementations,
authenticates before decryption, and compares tags with `subtle::ConstantTimeEq`. Its MIT
license is retained in `third_party/licenses/aes-gcm-MIT`. This is a port, not an upstream bug.

`scripts/generate-crypto-vectors.mjs` and both crypto fixture directories are original test
adapters. Native Node generates signatures, key formats, ciphertext and derived bytes for
comparison with wasm. No upstream test implementation is copied.
## Generated-function parser locations

The generated-function adapter now uses original import-keyword byte positions
from Bun's full parser, then converts them to UTF-16 offsets in each original
constructor argument. It keeps comments, templates, property names, regex literals
and caller strings intact. Native constructors validate the original arguments
before rewriting. A function literal accesses a fixed intrinsic-prototype helper,
so lexical globalThis bindings and with scopes cannot capture the callback.
Specifier conversion occurs once inside an async function and rejects Symbols.
This is original glue, with no package implementation copied.

| File | Classification | Upstream and local changes |
| --- | --- | --- |
| patches/bun/0010-wasm-expose-semantic-dynamic-import-locations-to-the.patch | Upstream patch | Reused unchanged from the semantic-import lane, Bun wasm commit cd95fa7a13b3f13be73e512b38ec111c1c228084. Exposes parser keyword positions and printer metadata. |
| crates/bunwasm-transpiler/src/lib.rs function_imports | Original adapter | Constructs the native function grammar around original argument ranges and translates parser offsets. |

Patch 0010 touches src/js_parser/lib.rs, src/js_parser/parse/parse_import_export.rs
and src/js_printer/lib.rs at upstream Bun revision
9510e74152073d850a18758ca41114d8f214ffa6. The parser collector records only real import
expressions and restores its previous thread-local state on unwind. The printer
metadata is consumed by the semantic-import lane; this adapter consumes only the
parser collector. The existing shared vendor checkout was read, never edited.


## Node crypto key adapters

`src/js/crypto_keys.js` is an original adapter, not copied Bun or Node code. It shares the
WebCrypto backend while providing synchronous Node operations, Writable signing objects,
PEM encoding, encrypted PKCS#8/PKCS#1/SEC1 formats and WebCrypto key conversions. BoringSSL's original PEM and PKCS#8 APIs perform key encryption and decryption in `crates/bunwasm-crypto-sys/c/rsa.c`. `src/crypto.rs` adds Node's PKCS#1 and SEC1
formats through the BoringSSL and RustCrypto parsers and converts ECDSA signatures between DER
and IEEE P1363. Bun's Node crypto builtin requires a native binding, so loading its generated
JavaScript alone cannot supply this behavior. The new fixture is original test code.

`scripts/generate-node-key-vectors.mjs` generates six native Node encrypted-key and signature
vectors for the original Node key fixture. Its synthetic keys and passphrase are test data.

The pinned cipher-name registry references BoringSSL's CFB and Blowfish entry points. The
Node build selects these objects in `crates/bunwasm-crypto-sys/build.rs` and compiles the unchanged `decrepit/cfb/cfb.cc` and `decrepit/blowfish/blowfish.cc`
from the same pin into its own Cargo output directory. The shared prebuilt archive remains
read-only. These are dependency build selections, not copied or patched implementations.

## Bun Console constructor

`crates/bunwasm-runtime/src/js/bun_console_constructor.js` is generated from
Bun's `src/js/builtins/ConsoleObject.ts`, function `createConsoleConstructor`,
at revision `9510e74152073d850a18758ca41114d8f214ffa6`. Bun attributes this
constructor to Node's `lib/internal/console/constructor.js` at
`d2c7c367741bdcb6f7f77f55ce95a745f0b29fef/lib/internal/console/constructor.js`.
The existing generated-builtins directory contains Bun's license.

`scripts/generate-bun-console.mjs` removes TypeScript and lowers dollar intrinsics
to a lexical adapter. It preserves the constructor body, including both overloads,
stream writes, method binding, per-instance state, inspect options, colors,
groups, timers, and tables. `--check` checks reproducibility against the pinned
source. This function is a Bun global-object builtin, outside its module registry.
Bun's `src/js/node/console.ts` only exports the global singleton, so switching
that module's factory cannot supply the missing constructor.

`src/js/console_constructor.js` is an original adapter. It supplies ordinary
JavaScript brand checks, uncurried calls, validation errors, and Bun's existing string-width API. Its public dependencies use the runtime's
builtin module registry. The ordinary polyfill loader compiles the generated
function on first access to `console.Console`. The global singleton keeps its
Bun formatter; new instances use Bun's Node Console and existing Node inspector.
`src/js/console.js` adds the lazy constructor and the global stdio properties.
The original `src/js/bun.js` adapter now derives `Bun.enableANSIColors` from
FORCE_COLOR, NO_COLOR, and stderr's TTY state. Bun's Console reads this flag
when automatic color mode encounters FORCE_COLOR; the old constant false
prevented forced colors on every engine.

The generated constructor also embeds Bun's
`src/js/internal/util/debuglog.ts` time formatter, with its default export
replaced by the constructor's lexical require. The formatter retains Bun's
Node v26.3.0 adaptation, including minute and hour output. No local formatter
approximates the upstream implementation.

The generator also routes the constructor's `Error.captureStackTrace` call to
an original adapter. JSC's bare stack strings omit the Trace name and message;
the adapter prepends them while preserving stack frames. Browser engines
without captureStackTrace use Error.stack. It leaves a native Node-style
header and a custom prepareStackTrace result intact. This supplies the Node
console contract without changing the engine's global Error constructor.

Bootstrap captures its default stack formatter identity for this adapter.
An installed user formatter stays authoritative; the runtime's own default
frame-only formatter still receives the Console Trace header.

### WebCrypto review corrections

The original host adapter captures SubtleCrypto and its key constructors before bootstrap
replaces globals. The browser engine exposes that same provider; QuickJS and wasm JSC use
the shared RustCrypto/BoringSSL adapter. Supported native cryptographic operations stay with the native provider.
SHA-1 JWK identifiers are HS1, RS1 and PS1. HMAC generation validates the required hash
before allocating key material. The ECDSA adapter left-pads short P-384 prehashes with zeros,
preserving the integer defined by ECDSA while meeting ecdsa 0.16.9's prehash input bound.
No upstream source was copied or changed for these corrections.

### Node key review corrections

Class **Host feature**. The original `crypto_host_keys.js` adapter retains the browser's
native provider and connects its asynchronous keys to synchronous Node key records. It
imports wasm keys into that provider before native operations. Matching native KeyObject
roundtrips retain their native CryptoKey. Secret conversion uses raw material instead of
JWK; RSA signatures reject unsupported padding before dispatch. No upstream implementation
was copied or changed for these corrections.
## Native crypto capabilities

Class **Host feature**. Original host adapters. `web/src/crypto-host.js` probes each native
AES algorithm with a valid 192-bit key. Only a confirmed unsupported 192-bit operation uses
the existing RustCrypto backend. Supported native operations retain their provider and keys.
Mixed wrapping uses an exportable native HMAC key as a raw byte container when a native
wrapping key must wrap a wasm AES-192 key. A separate native probe detects AES-KW JWK
alignment gaps; only those calls serialize and pad the JWK before native raw wrapping. The HMAC operation is never used. This preserves
native wrapping with non-extractable, wrap-only keys. `crypto-inputs.js` preserves the runtime's
2 GiB input boundary before native copies, including algorithm-dictionary buffer members.
No upstream cryptographic implementation is copied or changed.


## Directory cursors

Class **Host feature**. `crates/bunwasm-runtime/src/directory.rs` and the directory
APIs in `src/js/node_fs.js` and `web/src/engine-host.js` are original adapters. They implement Node's public
`opendir`, `opendirSync`, `fs.promises.opendir` and `Dir` contract without copying
an upstream implementation. Bun's `src/js/node/fs.ts` at pinned upstream revision
`9510e74152073d850a18758ca41114d8f214ffa6` was read as a reference. Its `Dir` eagerly
collects directory entries through native `fs.readdir`, so it cannot supply bounded
reads over this runtime's WASI directory handles.

Rust owns open `std::fs::ReadDir` cursors and recursive traversal. Each native read
returns at most `bufferSize` entries. Raw filename bytes cross the engine boundary
before JavaScript applies the requested encoding. JavaScript owns the async operation
queue, callback timing, Dirent construction, iteration and explicit disposal.
Closing drops the active native cursor and pending traversal paths. `FinalizationRegistry`
releases abandoned native IDs through an idempotent native release. Its unregister
token is separate from the owner, because the pinned QuickJS stores tokens strongly.
Runtime shutdown clears the remaining cursor table after user exit listeners, including when the host
retains the wasm instance. The browser engine also clears it in `EngineHost.exit`
before notifying the host. This covers `reallyExit`, abort, self-kill and fatal
errors that bypass exit listeners. The release is idempotent across both paths.
Native exits also clear the table before skipping engine teardown.
The public path representation stays separate from the lookup string, so Buffer paths remain Buffers in `Dir.path` and
`Dirent.parentPath`. The async queue keeps a refill operation active through its callback,
while an already-buffered read does not block synchronous work. The fixture is original
test code and runs against Node as a contract control.

Recursive traversal is breadth-first. Node's order can change with buffer size;
this adapter does not promise that order. Directory enumeration order is unspecified.

## JSC finalizer dispatch

Class **Host feature**. The additions to `crates/bunwasm-jsc/cpp/helpers.cpp`,
`src/sys.rs` and `crates/bunwasm-runtime/src/engine_jsc.rs` are original adapters.
They call WebKit's existing full-collection and deferred-work APIs. No upstream
implementation is copied or modified. The references are
`Source/JavaScriptCore/API/JSBase.cpp`, `heap/Heap.cpp`, `runtime/VM.cpp`,
`runtime/DeferredWorkTimer.h` and `runtime/JSFinalizationRegistry.cpp` in Bun's
WebKit fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.

The public `JSGarbageCollect` API reports an abandoned object graph without
forcing collection. The adapter collects synchronously with the VM's atom table
installed, then restores the calling thread's table. Event-loop microtask draining
also dispatches deferred work, which is where JSC schedules registry callbacks.
Without this dispatch, collected directory owners retain their native cursors.

## esbuild WebAssembly distribution

Class **Host feature**. The distribution selector in
`crates/bunwasm-runtime/src/install/resolve.rs` maps `esbuild` to the matching
`esbuild-wasm` version. The original subprocess adapter in
`crates/bunwasm-runtime/src/js/spawn.js` accepts `node` as a guest runtime name.
The original stdin adapters in `crates/bunwasm-runtime/src/js/node_fs.js`,
`crates/bunwasm-runtime/src/natives.rs`,
`crates/bunwasm-host/src/process/mod.rs`, `process/stdin.rs`, `process/stdio.rs`,
its slot and notification hooks,
and `web/src/subprocess.ts` let callback reads wait through the host I/O loop.
The original browser filesystem service in `runtime/fs/`, connected by
`web/src/fs-worker.ts` and `web/src/worker.ts`, gives parents and descendants
one live filesystem identity. Changes are visible before stdin, stdout, or exit
boundaries, including parent edits while a persistent child waits without stdin.
The service replaces the earlier snapshot baselines and filesystem mailboxes;
open descriptors retain their original file identity across removal or replacement.
Native hosts use their shared physical filesystem.
The original shared allocator uses sparse two-level page tables so one file can
span all storage segments within the configured cap. Table blocks are returned
on truncation, removal, or failed growth. Growth reserves tables after choosing
physical capacity, so geometric growth can fall back to the remaining free pages.
Metadata remains within the original
24 MiB connection buffer. Allocation range errors use WASI EFBIG, number 22;
number 27 is EINTR and would make Rust retry a rejected write indefinitely.
The original browser test adapter in `web/tests/stop-shell.ts` waits for an idle
shell before submitting the next command. Ctrl-C text can appear before
asynchronous worker cleanup finishes.
The synchronous path reads the WASI descriptor without Rust stdin prefetching.
The native WASI and host interfaces share a buffer, including bytes read ahead.
This prevents Go's service loop from blocking JavaScript callbacks and preserves
stdin position when callers mix synchronous and callback reads.
No upstream implementation is copied or patched. The published esbuild 0.25.12
files `lib/main.js`, `bin/esbuild`, `wasm_exec_node.js`, `wasm_exec.js`, and
`esbuild.wasm` install unchanged from the official npm tarball. Its source is
`evanw/esbuild` tag `v0.25.12`, including `lib/npm/node.ts`,
`lib/npm/node-platform.ts`, `npm/esbuild-wasm/bin/esbuild`, and the Go compiler runtime.
The package owns that Go runtime revision. Our test fixtures and subprocess
changes are original adapters, separate from those upstream files.

The worker-thread adapter now loads and starts separate guests. SharedArrayBuffer
cannot cross those guest boundaries yet, so esbuild's synchronous worker backend
still needs that follow-up. No package-specific environment override is installed.

Filesystem visibility does not depend on timestamp comparisons or host I/O
polling: the shared service owns namespace changes and the allocator, and shared
file locks and epochs protect direct reads and writes. The original `wasiPipe`
adapter only transports bytes; it has no filesystem synchronization hooks.
The applications select hoisted native Bun installs to avoid the recorded build
plugin path-validation bug; no upstream loader or global package state changes.

## Wasm stack guards

Class **Port**. The upstream files are QuickJS-ng `quickjs/quickjs.c` from
rquickjs-sys 0.13.0, and Bun's WebKit `Source/WTF/wtf/StackBounds.cpp` at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.

QuickJS disables its stack limit on WASI in both `JS_NewRuntime2` and
`update_stack_limit`. Remove those exceptions so the existing guards in the
interpreter, property accessors, JSON serializer, and parser work on the C
shadow stack. A wasm host keeps call frames outside linear memory, so those
guards see only part of each recursion level. The `js_reserve_wasm_frame`
macro, compiled only for WASI, reserves a constant number of shadow-stack bytes
in the recursive functions whose host frames are larger than their shadow
frames: the JSON serializer, parser and reviver, `Array.prototype.flat`, Proxy
traps (through `get_proxy_method`, renamed `get_proxy_method1` behind a
macro), bound and async calls, `ToPrimitive`, `JS_Call`, `JS_CallFree`, and
the expression, unary and statement parsers, and `re_parse_disjunction` in
`libregexp.c` through the same macro there. Sizes are measured per path; no
upstream algorithm or error changes. Our Rust engine adapter requests the
measured stack budget. It is original adapter code and retains no upstream
implementation.

The WebKit WASI port bounds the C shadow stack to a native recursion budget
below the host wasm call-stack limit, read from `BUN_WASM_STACK_KIB` when set,
while retaining JSC's exception reserve. Its separate C-loop JavaScript frame
reservation keeps its existing capacity. This extends the platform hunk in
`jsc/webkit-wasi.patch`; it changes no upstream JavaScript algorithms. The
browser worker's choice of budget in `web/src/worker.ts` is original code.
[Stack limits](stack-limits.md) records the measurements and reproducer.

`tests/fixtures/stack-overflow-console/index.js` adapts the script in Bun's
`test/js/node/console/console-constructor-exception.test.ts` at upstream
`9510e74152073d850a18758ca41114d8f214ffa6`. Class **Port**. The local fixture
runs directly on all engines, verifies the caught error type, and prints a
fixed recovery marker instead of spawning a child test process.

## Runtime TypeScript

Class **Host feature**. `scripts/transpile-runtime.ts`, the runtime embedding build step,
`src/js/runtime.d.ts`, the typecheck configuration and build regression tests are original
bun-wasm adapters. They call the host Node.js `node:module.stripTypeScriptTypes` API in whitespace-preserving
strip mode. No Node implementation is copied. No upstream implementation
is copied or changed. `src/js/glob.ts` and `src/js/bun_builtin_globals.ts` are the existing
original adapters renamed from JavaScript with type annotations. Glob option assembly returns a tuple derived from the positional native contract. The builtin loader adapter
section above records their original role; neither file is an upstream fork.

The host stripper blanks erasable TypeScript during Cargo's build, preserving JavaScript
constructor calls, class fields and source coordinates. The loader still
looks up the same extension-free names. Existing `.js` sources remain raw. No TypeScript parser
or typecheck is added to the wasm runtime.

## Standalone crypto linkage

Class **Host feature**. `crates/bunwasm-crypto-sys/` is the original RSA FFI and build
adapter moved from `crates/bunwasm-runtime/`. It owns the unmodified pinned BoringSSL
archive, libc++ and WASI library search paths. Both the runtime and the WASI parser
support crate depend on it. Removing Bun's crypto placeholders requires this dependency
wherever parser support is linked, including the standalone transpiler example.
The archive is linked once through Cargo's `links` identity. The runtime no longer owns
a second native build. `crates/bunwasm-transpiler/build.rs` and `crates/bunwasm-build/build.rs` supply the standalone
example and bundler WASI startup objects because the shared environment disables Rust's self-contained C runtime.
No upstream implementation changed. `scripts/test-transpiler-example.sh` and its mandatory
invocation from `scripts/build.sh` remain unchanged.

## Worker threads adapter

`crates/bunwasm-runtime/src/js/worker_threads.ts` implements worker metadata,
guest lifecycle and routed port ownership. `worker_codec.ts` serializes cyclic
object graphs and transferable buffers and ports. `worker_channel.ts` frames
control messages over two private host pipes. `worker_stdio.ts` adapts the existing
subprocess streams to Node streams. These are original TypeScript implementations.

The original Rust adapters in `crates/bunwasm-host/src/process/` give each worker
its own Wasmtime instance and control pipes. The original Node host adapter in
`web/scripts/node-host.mjs` starts another physical Node worker. The browser host
adapters in `web/src/{worker.ts,worker-pipes.ts,subprocess.ts}` use Web Workers and
shared pipe buffers. Nested guests share a root port broker and the existing child
budget. Bootstrap, process, spawn and structured-clone hooks connect those
adapters to the guest event loop. No upstream source was copied.

The original loader in `web/src/content-modules.ts` creates blob module URLs for
acyclic browser imports. Only a cycle reserves a named URL before its source is
available. Eval workers need no HTTP module request, so an uncontrolled WebKit
worker cannot bypass the module service worker and get a 404. Named URLs retain
native import cycles. Failed source builds retain unfinished cycle reservations;
recorded dependency edges repair them when retrying the root or a cached child,
without discarding successful reentrant imports. The Node host keeps its existing
named module loader. `web/tests/browser-worker-modules.ts` repeats atomic transfer rollback twenty
times per browser and also starts children outside the module scope.

The inspected upstream implementation is `src/js/node/worker_threads.ts` at Bun
revision `9510e74152073d850a18758ca41114d8f214ffa6`. Its module initialization needs
`Worker.cpp` native bindings and the native web-worker constructor, so it cannot
run through the builtin loader with the hooks currently available.
[Worker threads](worker-threads.md) records supported operations and host limits.

`web/scripts/node-process.ts` is an original adapter that installs the same
subprocess slots through Node WASI for embedded QuickJS and JSC guests. It
composes them with the existing CLI fetch slots and registered signal slot 18 through
one import dispatcher, and shares their wake signal.
The host slot installer uses the runtime memory helper by a relative source
path so unbundled Node hosts still load without installed packages.

The original atomic-transfer native checks the complete buffer list before
detachment. QuickJS uses its public detach operation plus the inspection helper
above. The JSC adapter adds original `JSArrayBuffer` inspection and detach hooks
in `crates/bunwasm-jsc/cpp/helpers.cpp`, against the same pinned WebKit headers as
the existing helpers. The browser adapter in `web/src/buffer-transfer.ts` captures the host's structured
clone operation and tracks native WebAssembly memory buffers through their
buffer getter. It rejects the whole list before Chromium can partially detach
it. WebKit and Node already preserve earlier buffers in this case. Copied
WebAssembly memory buffers are tracked by the original runtime adapter and
rejected as transfers.
No Bun vendor patch is needed for these adapters.

The PR #31 close fixes are retained in the routed adapter. A pending peer-close
sequence preserves an unstarted peer's queue until it drains, without polling.
Local closure suppresses future delivery while selected messages finish, with
promise continuations between messages. BroadcastChannel receive returns
`undefined` without consuming its messages, matching native Bun 1.4.2.

## HTTP framing

Class **Host feature**, **original adapters** in `src/js/net.js`,
`src/js/http_common.ts`, `src/js/http_body.ts`, `src/js/http_agent.ts`, socket-close
completion in `src/js/node_net.js`, and the `node:http` registry
in `src/js/builtins.js`. No upstream implementation is copied or patched.
Bun's `src/js/node/http.ts` depends on native HTTP bindings, so this change keeps
the existing portable adapter over the socket ABI.

The Node v26.7.0 control and Bun's Node test files at
`9510e74152073d850a18758ca41114d8f214ffa6` supply behavioral references.
Header commitment is distinct from flushing bytes. Response framing preserves
explicit length and transfer encoding, streams chunked bodies, omits bodies
for HEAD and bodyless status codes, and writes trailers. HTTP clients use the
same socket transport for ordinary and upgraded responses to preserve raw
header names and trailers. A typed incremental body decoder handles fixed,
chunked, and EOF framing. Header, method, path and status validation occurs
before protocol bytes are written. A 100 Continue response can precede the
request body. Server upgrades expose the parsed request body and its EOF before
handing later bytes to the upgraded socket.

The PR #35 revision checks header coercion and path/method/header validation order
against native Node. Response parsing rejects duplicate lengths, invalid lengths
and transfer-encoding/length conflicts in wire order. Only a final `chunked`
transfer coding selects chunk decoding. Lengths must fit a safe JavaScript integer.
The Agent pool retains framed keep-alive responses after consumption, removes
request parser listeners, unreferences idle sockets, guards unsolicited idle data,
and closes sockets on timeout, remote close or Agent destruction. Requests without
an Agent advertise close. GET, HEAD, DELETE, OPTIONS, TRACE and CONNECT do not get
automatic body framing, including when headers flush before `end()`.

Round 2 uses Node's `test/parallel/test-http-extra-response.js` at the same
upstream revision as a behavioral reference. The decoder returns consumed output
and unconsumed remainder separately. A remainder retires the connection before
pool release, preserves the first response body/end, and reports invalid prefixes
with `HPE_INVALID_CONSTANT`. Bytes after a nonpersistent response produce
`HPE_CLOSED_CONNECTION`. A completed response enters a draining state so incoming
data cannot disappear between parser removal and stream consumption. Empty or
whitespace-only transfer-encoding fields produce `HPE_INVALID_TRANSFER_ENCODING`
before informational, upgrade or bodyless-response dispatch.

The Streams main integration keeps HTTP transport work in Writable lifecycle
hooks. The original TCP adapter defers socket-destroy completion to the check
phase so the completed request stream closes before its socket, as in Node.
`net-http-close-order` compares this order unchanged on Node and all engines.

HTTPS requests continue to use the host's TLS fetch transport. The raw socket
ABI has no TLS capability, so HTTPS upgrades without a caller-supplied connection
fail with `ERR_TLS_NOT_SUPPORTED` instead of opening a plaintext connection.
The caller-supplied connection path retains caller ownership of TLS setup.

[The HTTP compatibility report](http-compatibility.md) records the controls and measurements.

### Round-5 native stream reflection and abort cleanup

Class **Host feature**, original bridge refinement. `web/src/native-stream-state.ts` now rewrites each wrapped native stream prototype's `constructor` descriptor to the wrapper, preserving `instance.constructor === GlobalConstructor` and subclassing while retaining native prototypes and brands. Guest abort signals passed to native `pipeTo` are mirrored through a native controller. The guest listener is detached when the native pipe fulfills or rejects and when the native call throws synchronously. The browser fixture counts add/remove operations across repeated successful pipes.

### Cross-platform web tests

Class **Host feature**, **original adapters**; no upstream implementation is copied
or adapted. `web/tests/{subprocess,playground,browser-net}.mjs` and
`tests/install/run.mjs` use the host temporary directory or `BUN_WASM_TEST_TMP`.
`scripts/test-web.sh` honors that override or `TMPDIR`, installs scratch teardown
before allocation, and waits for its fixture server to exit. Its original
`scripts/run-with-timeout.mts` adapter owns a POSIX process group and kills command
descendants on normal exit, deadline and interruption rather than requiring GNU
timeout on macOS. Browser network teardown uses owned
ChildProcess handles, not Linux-only `/proc` paths. Test assertions are unchanged.
The original `env.sh` host-cache adapter exports `PLAYWRIGHT_BROWSERS_PATH` only
when it is unset and `/work/cache/ms-playwright` exists. It never downloads
browsers; hosts without that directory retain Playwright's native cache lookup,
and explicit overrides (including `0` and empty) are preserved. The isolated
`web/tests/toolchain-env.test.ts` probes cover the default and those overrides.

### Native browser stream completion

Class **Host feature**, original bun-wasm implementation. No upstream source was
copied or adapted for `web/src/native-stream-state.ts`. Chromium and WebKit lack
Node's private closed-promise and controller-error symbols. The host installs
those hooks before the runtime bootstrap; Node-host execution retains Node's
existing hooks and embedded engines retain the reference ponyfill hooks. Detection
checks both the prototype and a closed native stream instance: Node 24/25 assign
own symbol properties in their constructors, while Node 26 exposes prototype
getters. Native instance hooks receive writable prototype capability slots for
the guest bindings' startup check; constructor assignments still create the real
own properties. Installing a getter-only bridge over the former would break
subsequent native construction. The isolated native-stream probes cover both representations
and a host without hooks, even when the test runner itself uses Node 26.

Construction proxies delegate to the browser's native ReadableStream,
WritableStream and TransformStream constructors and capture their controllers.
Native prototypes, instance brands, byte/BYOB queues and algorithms stay native.
The global constructor references change. Frozen underlying dictionaries are
wrapped without mutation, and callbacks retain their original receiver.

Completion comes from actual native reader/writer `closed` promises. Temporary
probes release locks immediately without reading or writing. Releasing a pending
closed promise rejects it in place; releasing a terminal promise replaces it.
That identity change distinguishes terminal observation from release errors.
Notifications from controllers and underlying callbacks trigger another probe.
Pending sink abort promises delay completion. Internally acquired native locks,
such as async iterators and pipeTo, use weak polling with host timers. Session
exit stops the timers. No private stream state or promise status is invented.

Streams created outside the construction bridge, including saved original
constructors and opaque native factory outputs, support completion observation.
Their controllers are unavailable through browser APIs, so the error hook cannot
provide Node-style error injection for those opaque readables. The bridge raises
an explicit error rather than treating cancellation as an errored stream.

`scripts/test-native-stream-interop.mjs` executes the exact runtime stream modules
and this host bridge in Chromium and WebKit. Its minimal process/async-context
boundary is a direct-module test, not a wasm-build claim. The same fixture also
runs through the actual built browser engine in `web/tests/browser-engine.mjs`.
CI runs the direct native-browser proof so Node-host symbols cannot mask a gap.

The copied Node stream licenses retain their text with whitespace-only normalization
of blank EOF lines and one mixed space/tab indent.


### TCP streams after the portable-core merge

Class **Host feature**, original adapters. `node_net.js` retains the TCP transport,
lookup, address, timeout and server behavior from main PR14. Socket now uses the
portable Duplex's actual readable/writable states and `_read`, `_write`, `_final`
and `_destroy` hooks. Its old public write/end/destroy, byte queues and synthetic
state records are removed. Connection callbacks drive stream callbacks and
`push`; the native read waiter pauses when `push` reaches the high-water mark.
This is original API glue, not copied upstream stream logic.

`net.js` retains PR14's Connection shutdown/ref/write callbacks and complete HTTP
upgrade handling. The Streams byte-body producer and HTTP request hooks are
applied to that implementation. Socket and upgrade cleanup run from the real
ClientRequest `_destroy` hook. The host engine releases both native stream
observers and directory cursors at exit. The suite runner retains explicit plain
script selection and opt-in Node assertion scripts without counting registered
Node tests as assertion scripts. The merged TCP fixture exercises successful
Readable.toWeb reads and cancellation of a connected socket.

The original Node-host TCP adapter in `web/scripts/node-net.mjs` now limits each
write to the remaining one-MiB host queue capacity and returns the short byte
count. Checking the queue only before accepting an entire large write allowed
the first write to bypass the limit. The bounded host test fails with that
implementation and passes with capacity-aware writes, including full-queue,
zero-length and owned-copy cases. No upstream implementation is copied.

## Cross-worker descriptor ownership

`runtime/proc/{worker-client,worker-broker,filesystem-codec}.ts` and
`runtime/core/open-file.ts` are original bun-wasm adapters, not copied Bun, Node or WASI host
implementations. They extend the descriptor and filesystem services present at bun-wasm
`52576274` with cloneable process bindings and shared file-description state. The browser
worker installs those bindings into the same table used by preview1 calls.

A spawn reserves independent filesystem capabilities before returning; closing or killing the
parent cannot invalidate an admitted child's open file. Duplicate child bindings share one
open description, including a shared file cursor. Cursor operations participate in filesystem
host sections so revocation and reaping cannot strand a lock. Stream descriptions may create
a fresh process-owned endpoint during inheritance, and termination freezes all capabilities
before making the child waitable. No upstream patch is added by these adapters.

## Process-owned pipe adapters

`runtime/proc/pipes.ts` adapts the bounded ring wrap/copy and notification scheme from this
project's `web/src/subprocess.ts` (`SharedPipe`, bun-wasm revision `52576274`). That source is an
original bun-wasm host adapter, not a copied upstream implementation. The process-owned layer
adds independent producer rings, atomic committed-position/revocation cursors, a host-only
process publication registry, reference-counted endpoints, reader merging and supervisor relay.
These changes prevent a terminated worker's delayed publication from altering the live stream.
EOF also validates the pipe's atomic admission generation around its monotonic closed-ring scan:
a concurrent child reservation in an earlier slot cannot be missed while the parent closes a
later slot. An overlapping scan reports not-EOF and publishes a wake, keeping registry revocation
as the authority for freezing committed output rather than adding a second writer-lifetime count.

`runtime/proc/worker-pipes.ts` is a separate original adapter for cloneable endpoint capabilities,
filesystem-codec composition and supervisor relay ownership. Spawn retains a process endpoint
synchronously; worker and controller imports release that same lifetime idempotently. Stable pipe
identities survive structured cloning without using SharedArrayBuffer wrapper identity. No Bun,
Node, WebKit or third-party pipe implementation is copied or patched by these modules.

## Guest process ABI

`runtime/proc/abi.ts` is an original adapter implementing the process ABI specified in
`plans/browser-runtime.md`, over this project's process, descriptor and filesystem services.
It is not copied from Bun, Node, WebKit, SLICC or another WASI host. Its packed subscription,
event and wait records are the project's own interface; the errno values follow WASI.
Spawn metadata copies the checked guest span into fixed-owned bytes before native UTF-8
decoding: TextDecoder's WebIDL input permits shared buffers, not resizable backing. This is
representation normalization, with no engine/version detection or retry.
`runtime/core/{descriptors,wasi}.ts` adds signed-success descriptor bounds, explicit immediate
terminal methods and notification-aware preview1 polling without replacing the existing
blocking preview1 I/O contract.

`runtime/fs/{client,shared}.ts` extends the original bun-wasm shared filesystem at revision
`9d072068` with nonblocking lock admission and asynchronous preparation for cold reads and
file growth. Preparing an operation never consumes input or commits a write behind EAGAIN.
The browser runner, worker and subprocess broker compose these original adapters lazily,
share one fd table with preview1 and preserve the existing Bun host slots.
`web/src/runtime-terminals.ts` is an original callback-destination codec: it preserves stdout
versus stderr across dup and remapped inherited fds, forwards generic child output to the run's
hooks, and represents this runner's default EOF stdin explicitly. After selecting the immutable
winning outcome, the process supervisor waits for the final ordered host acknowledgment before
confirming an ordinary exit and terminating its worker, so queued terminal output drains first;
fatal outcomes and explicit disposal still
complete without waiting for that acknowledgment. A late kill cannot bypass the drain after an
ordinary outcome has already won. Unknown callback terminals are rejected rather than pretending
their input can be shared. No new upstream patch, copied
implementation or compatibility branch is introduced.

## HTMLRewriter

Class **Host feature**, **original adapters** in `crates/bunwasm-runtime/src/html_rewriter.rs`,
`src/js/html_rewriter.ts`, the native table and global registry.
The runtime links the unchanged `vendor/bun/vendor/lolhtml` Rust crate at Bun revision
`cd95fa7a13b3f13be73e512b38ec111c1c228084`. The vendored crate is lol-html 2.7.2,
including Bun's token suspension support. No vendor file changes.

Each transform owns a parser session. Content handlers suspend the parser and return a
plain-data event. TypeScript invokes the registered handler, waits for its promise for a
Response input, then resumes the parser. String and buffer inputs remain synchronous and
reject handlers that need asynchronous work. Response inputs consume the source reader
incrementally, keep the native-consumer reader lock after completion, forward cancellation
and preserve handler rejection values. Tokens and
attribute iterators detach when their handler ends. The wrapper is original bun-wasm code.
Bun's corresponding implementation, `src/runtime/api/html_rewriter.rs`, depends on Bun's
JSC-specific generated classes and stream sinks and cannot run through the builtin loader.

`third_party/licenses/lol-html-LICENSE` is copied unchanged from that vendored crate.

## X509Certificate

Class **Host feature**, **original adapters** in `crates/bunwasm-crypto-sys/src/x509.rs`,
`crates/bunwasm-runtime/src/x509.rs` except the adapted portions below,
`src/js/x509.ts`, the native table and the Node crypto registry.

BoringSSL remains pinned by `scripts/sync-crypto.sh` to
`41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f`. The Rust declarations call its existing
certificate, name, extension, key and signature functions declared in `include/openssl/`
`{x509,asn1,evp,bio,obj,stack,mem,err}.h`. These declarations contain no
copied implementation. Certificates retain owned DER bytes. Checks parse those bytes and
release their native allocations on every return. Public keys use the existing Node
KeyObject implementation via a SPKI export. No new host slot is used.

Bun's `src/js/node/crypto.ts` exports its native X509Certificate binding. That binding lives
in `src/jsc/bindings/JSX509Certificate*.cpp`, so it cannot be loaded as an engine-independent
JavaScript wrapper. The new TypeScript wrapper implements the same public certificate
contract using the shared native table.

## X.509 alternative name formatting

Class **Port**, **adapted implementation** in `crates/bunwasm-runtime/src/x509.rs`,
`alternative_name`, `general_name`, `ip_name`, and extension-list formatting.
The upstream source is Bun `src/jsc/bindings/ncrypto.cpp`, `IsSafeAltName`, `PrintAltName`,
`PrintGeneralName`, `SafeX509SubjectAltNamePrint`, and `SafeX509InfoAccessPrint` at
`cd95fa7a13b3f13be73e512b38ec111c1c228084`, inherited from Node's ncrypto.

The Rust translation uses BoringSSL accessors and owned strings instead of C++ BIO
writers and JSC strings. It retains JSON-compatible quoting for names containing commas,
quotes, controls or non-ASCII IA5 bytes. Distinguished names keep UTF-8. This prevents one
certificate name from looking like multiple alternative names. BoringSSL's unsupported
otherName, X400 and EDI names retain the upstream unsupported descriptions.

`third_party/licenses/node-X509-LICENSE` retains the Node and Joyent MIT notices.
The two license sections are copied unchanged from Node v26.7.0 `LICENSE`; no Node
implementation is taken from that version.

## Certificate regression fixtures

Class **Port**, **copied upstream fixture data** in `tests/fixtures/crypto-x509/`.
The sources are Bun `test/js/node/test/fixtures/keys/{agent1-cert.pem,agent1-key.pem,
ca1-cert.pem,ca2-cert.pem}` and `test/js/node/test/fixtures/x509-escaping/{alt-0-cert.pem,info-2-cert.pem}`
at `cd95fa7a13b3f13be73e512b38ec111c1c228084`.

The PEM bytes are unchanged. `alt-0-cert.pem` is named `escaped-san.pem`, and
`info-2-cert.pem` is named `unknown-access.pem` locally.
They are public test data, including a test private key. The standalone TypeScript fixture
is original and checks the real wasm parser, certificate names, fingerprints, signatures,
KeyObjects, issuer checks and legacy fields on every engine.

### Certificate check-option regression fixtures

`tests/fixtures/crypto-x509-options/{names,email-only}.pem` are original self-signed
P-256 certificates generated with OpenSSL for PR #41 review. They contain a
fallback common name and either DNS/email SANs or an email-only SAN. No upstream
source or production certificate is copied. The generation key is disposable;
only the public certificates are retained. The fixture runs unchanged on Bun and
Node and covers the five hostname options and standalone issuer metadata.

## X.509 hostname option matcher

Class **Port**, **adapted implementation** in
`crates/bunwasm-runtime/src/x509_hostname.rs` and `x509.rs::check_host`.
The upstream is Bun `src/boringssl/lib.rs`, `match_hostname`,
`openssl_valid_pattern`, `match_dot_subdomain`, and `Bun__X509__checkHost`, at
`cd95fa7a13b3f13be73e512b38ec111c1c228084`.

BoringSSL's pinned headers define ALWAYS_CHECK_SUBJECT, NO_PARTIAL_WILDCARDS,
MULTI_LABEL_WILDCARDS and SINGLE_LABEL_SUBDOMAINS as zero compatibility macros.
Passing OpenSSL's bits to X509_check_host cannot implement these options. Bun
uses a Rust matcher for the same reason. The adaptation retains its OpenSSL
matching path and numeric flags, removes the TLS-only mode and BunString output,
and uses our existing BoringSSL accessors and owned UTF-8 names. SAN parsing
errors suppress subject fallback; an email-only SAN does not suppress a CN
hostname match. The BoringSSL source remains unchanged.
