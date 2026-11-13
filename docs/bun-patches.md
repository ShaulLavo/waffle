# Waffle source provenance

Waffle owns the reusable browser runtime extracted from bun-wasm. This ledger records copied or adapted implementation that ships in this repository; Bun engine, guest and application adapter provenance remains in bun-wasm. The low-level socket adapter is now Waffle-owned.

| Source                                                                                                                                      | Class                 | Revision and local change                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/page-runner/continuity-lock-diagnostic.ts`, `continuity-lock-control-page.ts` | Original adapter | Waffle page-only Web Locks diagnostic and local controls. No upstream implementation copied. See [Page continuity lock observation](#page-continuity-lock-observation). |
| `tests/page-runner/{inspector-plist,inspector-stream,safari-observer,inspector-endpoint,inspector-endpoint-receipt,browser-observation,host-drive}.ts` | Original adapter      | Original owned-page diagnostic codec and protocol-reference adapters. See [Native page observation sources](#native-page-observation-sources).                                                                                                                                                                                                                                                                               |
| `tests/page-runner/{console-observation,safari-console,playwright-observer}.ts`                                                             | Original adapter      | Original ordinary-page console verdict and browser event adapters. See [Ordinary page console observation](#ordinary-page-console-observation).                                                                                                                                                                                                                                                                              |
| `core/`, `fs/`, `proc/`, `interrupt/`                                                                                                       | Original adapter      | Browser/WASI runtime services developed in bun-wasm through the frozen extraction revision. The current tree is TypeScript source; `dist/` is generated during `prepare` and is never tracked.                                                                                                                                                                                                                               |
| `proc/pipes.ts`                                                                                                                             | Original adapter      | Waffle at `1722b65e81b1b37d3931d9fc1e078ee33d8b4b8d`; counted slot incarnations, append writer reuse and fenced relay-reader recovery. No external upstream implementation copied. See [Pipe slot lifetimes](#pipe-slot-lifetimes).                                                                                                                                                                                          |
| `browser/net/`                                                                                                                              | Original adapter      | Generic ring, HTTP framing, fetch and host transport, including the runtime-scoped loopback namespace and per-helper socket ownership. Fetch and listener policy are injected by the consumer; Bun install/cache policy is not part of Waffle.                                                                                                                                                                               |
| `browser/process-broker.ts`, `browser/worker.ts`                                                                                            | Original adapter      | Generic process admission, typed startup outcomes, descriptor transport, worker bootstrap and lifecycle fences. Guest engines and native slots remain application-owned.                                                                                                                                                                                                                                                     |
| `browser/preview1-{network-types,network,socket}.ts`, socket sections of `core/{wasi,descriptors}.ts`                                       | Original adapter      | Launch-only Preview 1 sockets built on Waffle's N1 connector at `ad4afb4eb2a374a841dbfbcf7136e4c8399e63e6`. No upstream implementation copied. See [Preview 1 launch socket adapter](#preview-1-launch-socket-adapter).                                                                                                                                                                                                      |
| `group/`, memory-group sections of `browser/{process-broker,worker}.ts`, `proc/abi.ts`, `link/{group,metadata,plan}.ts`                     | Original adapter      | Memory groups, written for Engines J1 on Waffle `63ddc5d`, 2026-10-29: page-side group owner, cumulative member-page limits, fresh-growth clearing, member and group pins, `runtime_shm` imports, FUTEX watches and PIE member images. No upstream source copied. See [Memory group sources](#memory-group-sources).                                                                                                         |
| `tests/fixtures/memory-group-member.c`                                                                                                      | Adaptation            | The Engines shared-memory design prototype `member.c` (original Engines code, 2026-10-29, not published elsewhere). Its statics, data relocation, function-pointer table, stack probe, heap churn and atomics are kept; its heap now grows through `runtime_shm.group_grow` and a page-driven command loop, including group-pin conversion, replaces the Node host script.                                                   |
| `proc/node-wasi.ts`                                                                                                                         | Adaptation            | bun-wasm `web/scripts/node-process.ts:188-397` at `c16ff39435cc33465b999ea06c1ee9d20b952354`; descriptor namespace, Node WASI translation, file/pipe routing and mixed polling moved without behavior redesign. Waffle-relative imports and explicit `NodeWasi*` names are local changes. Bun retains process policy, signal exit, worker controls, engine/native stdio, JSON and host APIs.                                 |
| `proc/worker-broker.ts`, `proc/filesystem-codec.ts`, `browser/process-broker.ts`                                                            | Original adapter      | Queued PID/directory ownership, acquired directory/slot/PID lifetimes, metadata-independent token discard and retained rejection fences, based on Waffle `15ba700`.                                                                                                                                                                                                                                                          |
| `fs/opfs.ts`                                                                                                                                | Adaptation            | The sync-access retry constants and retry loop are adapted from SLICC-kernel `src/fs/opfs.ts` at revision `88c5bb3` (Apache-2.0); Waffle's snapshot, payload, quota, queued lock ownership, startup milestones, failed-close ownership, acquisition registration, bounded range reads and pre-attempt cancellation/failed-owner guards are original glue. Attribution is in the source header and `LICENSES/Apache-2.0.txt`. |
| `tests/opfs-close{,-browser-observer}.test.ts`, `tests/opfs-close-browser{,-runner}.ts`, `tests/fixtures/opfs-close-{page,worker}.ts`       | Original adapter      | Waffle failed-close source controls and original-native-object browser observations. Test-only interception and labelled pre-physical-close injection; no upstream source copied.                                                                                                                                                                                                                                            |
| `fs/indexeddb.ts`, `browser/shared-fs.ts`, `runtime.ts`                                                                                     | Original adapter      | Extend the existing startup abort/disposal handshake to every persistent open, including IndexedDB takeover; fence consumers before cleanup, abandon an unresolved database open, close late successes and abort in-flight epoch allocation without publishing ownership.                                                                                                                                                    |
| `fs/vfs.ts`, `browser/{shared-fs,fs-worker,filesystem-worker-backend}.ts`, `fs/{service,indexeddb,opfs}.ts`, `runtime.ts`                   | Original adapter      | FAST/SAFE mode selection, descriptors, persisted format identities and typed startup diagnostics; existing payload layouts, locks and checkpoint algorithms remain unchanged.                                                                                                                                                                                                                                                |
| `browser/shared-fs.ts`, `fs/{service,persistent}.ts`                                                                                        | Original adapter      | Ordinary ready disposal and terminal backend shutdown ownership, integrated from Waffle `e7d4e35` and `6a979e0` onto `93698f1`. Retain the original ACK, section/work joins and failed cleanup reasons; no upstream implementation copied.                                                                                                                                                                                   |
| Inode permission query and enforcement                                                                                                      | Original adapter      | Original Waffle code, 2026-10-21; stored owner read/write, directory search/sticky, shared direct I/O checks and explicit saved-metadata adoption. No upstream source copied.                                                                                                                                                                                                                                                |
| `core/memory-views.ts`                                                                                                                      | Original adapter      | Resizable-memory view helpers with exported TypeScript types; emitted JavaScript retains the runtime ABI's exact view identity.                                                                                                                                                                                                                                                                                              |
| `patches/wasi-libc/preopen-scan.patch`                                                                                                      | Adaptation            | The `__wasilibc_populate_preopens` scan is adapted from wasi-libc `libc-bottom-half/sources/preopens.c` at revision `2e6fb9d8ee0c` (the wasi-sdk 34 source). When `fd_prestat_get` returns `BADF`, the patch probes `fd_fdstat_get` so open inherited descriptors are skipped while the first truly empty descriptor still ends the scan.                                                                                    |
| `network/src/{lib,queue,native}.rs`, `network/tests/`                                                                                       | Adaptation            | bun-wasm PR116 `crates/bunwasm-host/src/net/{tcp,mod}.rs` at `4a734933901f5ff4c403925d1589afc2a4ce2e71`; retain dual-stack bind, fallback, byte queue, graceful output drain, FIN completion and input discard; replace native threads with bounded progress turns and interruptible Unix wait-many.                                                                                                                         |
| `network/src/{abi,module,virtual_net}.rs`, `browser/net/module.ts`                                                                          | Original adapter      | Waffle binary ABI, virtual-only namespace, explicit loader and per-runtime module ownership. No Bun API facade copied.                                                                                                                                                                                                                                                                                                       |
| `browser/net/network.buffer.js` (generated, ignored)                                                                                        | Generated derivation  | Binaryen `src/wasm2js.h` and `src/tools/wasm2js.cpp` at `version_132`, npm `binaryen@132.0.0`. Generated runtime helpers, Apache-2.0. Local changes add only attribution/input header and factory export. See [Binaryen runtime helpers](#binaryen-runtime-helpers).                                                                                                                                                         |
| `tools/licenses/`                                                                                                                           | License copy          | Exact upstream MIT license texts for fluent-langneg 0.13.1, intl_pluralrules 7.0.2, base64-simd and vsimd 0.8.0, and blake2b_simd 1.0.5, omitted from their registry archives. Source commits and SHA-256 records accompany the texts.                                                                                                                                                                                       |
| `packages/findutils/vendor/uutils-xargs/src/lib.rs`                                                                                         | Adaptation            | uutils/findutils `src/xargs/mod.rs` at `505421d4e03586efeb7b9c55adf057599e192e0a`; original Waffle process-consumer adapter, owned EOF stdin, child status mapping, empty byte-delimited items and explicit unsupported-mode checks.                                                                                                                                                                                         |
| `packages/coreutils/crates/date/`                                                                                                           | Original adapter      | Calls unchanged uutils/coreutils `src/uu/date` and `src/uucore` at `07763857f6b9a547742a994b58aef0ccd036198b`. Isolated entry, existing WASI cwd helper, and rejection of clock setting before upstream execution. See [External date entry](#external-date-entry).                                                                                                                                                          |
| `packages/coreutils/crates/echo/`                                                                                                           | Original adapter      | Calls unchanged uutils/coreutils `src/uu/echo` at `07763857f6b9a547742a994b58aef0ccd036198b`; isolated entry and actual WASI write-failure observation, without flag/output logic.                                                                                                                                                                                                                                           |
| `tools/program-locales/patch.ts`                                                                                                            | Adaptation            | Transforms only the hash-pinned uutils/coreutils `src/uucore/build.rs` at `dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69` and `07763857f6b9a547742a994b58aef0ccd036198b`. Retains target aliases and replaces catalog discovery with explicit English inputs.                                                                                                                                                                     |
| `tools/program-locales/{prepare,selection,rustc-wrapper,build}.ts`, `generate.rs`                                                           | Original adapter      | Build-source selection, isolated producer identity, compiler pass-through, transaction lock, catalog generation and receipts. No runtime or command implementation copied.                                                                                                                                                                                                                                                   |
| `packages/diffutils/patches/gnu-wasi.patch`                                                                                                 | Adaptation            | GNU diffutils 3.12 release sources; bounded WASI changes disable unsupported process, signal, timezone and locale recovery APIs. See [GNU diffutils](#gnu-diffutils).                                                                                                                                                                                                                                                        |
| `packages/coreutils/src/bin/nl.rs`, `packages/coreutils/src/bin/nl_bre/`                                                                    | Original adapter      | Calls unchanged uutils/coreutils `src/uu/nl` and `src/uucore` at `07763857f6b9a547742a994b58aef0ccd036198b`. Initializes WASI cwd and translates bounded common BRE styles into upstream's byte regex grammar; no command algorithm copied. See [External nl entry](#external-nl-entry).                                                                                                                                     |
| `packages/coreutils/crates/checksums/`                                                                                                      | Original adapter      | Calls uutils/coreutils checksum packages, `checksum_common` and `uucore` at `07763857f6b9a547742a994b58aef0ccd036198b` through an owned, receipt-sealed dependency patch for selected WASI I/O and escaped checksum records. Isolated workspace, pinned lockfile and runtime-cwd entry; no hashing algorithm copied. See [Checksum entries](#checksum-entries).                                                              |
| `packages/jq/patches/jaq-wasi.patch`, `packages/jq/scripts/`                                                                                | Adaptation            | jaq 3.1.2 at `f7fea9219d8d5364c91c6a0278765eaa0e6fa95e`; target-gate rustyline and the interactive `repl` off WASI. Original Waffle recipe preserves the upstream evaluator and noninteractive CLI, disables mimalloc, and adds packaging, notices, native jq oracle and runtime tests.                                                                                                                                      |
| `tools/program-build-tools.ts`                                                                                                              | Original adapter      | WASI build/verifier helper extracted from bash-web `9ef027d7` scripts `wasi-build.ts` and `verify-wasi-guests.ts`. Waffle adds verified optimization and bounded final-program name stripping with original optimizer/derivation adapters; no external Wasm parser is copied.                                                                                                                                                |
| `packages/awk/patches/wasi-unsupported-ops.patch`, `packages/awk/scripts/`                                                                  | Adaptation            | The One True Awk 20260426 at `5739fd79bcfc75ba7526773d0cf634521f8aca3c`. Preserves the evaluator and real setjmp exit behavior. WASI-only startup and capability guards reject unavailable system commands and command pipes.                                                                                                                                                                                                |
| `packages/tar/patches/wasi.patch`, `packages/tar/producer/`, `packages/tar/scripts/`                                                        | Adaptation            | uutils/tar at `dffa9350f78b3bfbc9b4fc70a0f0205a53a937b6`; standalone locked producer, runtime cwd adapter, `-C`, pure Rust gzip with trailer checks, rejected unsupported helpers/member filters, and explicit WASI metadata failures. Read-only candidate; create/extract are not qualified.                                                                                                                                |
| `packages/program-support/src/{executor,io,runtime}.rs`, `src/runtime/wasi.rs`                                                              | Adaptation            | Neutral guest support from bash-web `shell/engine/src/{executor,io,runtime}.rs` and `runtime/wasi.rs` at `ed31b2bf47fe92afa4c9568868f206f35b9add27`. Public lifetime/cancellation hooks, filesystem adapter and wire decoders; original Waffle timers and read-readiness observations; shell policy stays in bash-web. See [Guest program support](#guest-program-support).                                                  |
| `packages/waffle-relay/src/*webtransport*.ts`, `tcp-byte-channel.ts`, `tcp-target.ts`                                                       | Original adapter      | Original carrier, lifetime, parser and reset adaptation around the public APIs of fails-components/webtransport revision `71d1ba5147c7733fbfd3a375116b9f58484d9f13`, exact npm pair 1.6.11. No upstream implementation is copied. See [WebTransport relay adapter](#webtransport-relay-adapter).                                                                                                                             |
| `browser/gpu/upstream/{webgpu.yml,webgpu.h,LICENSE}`                                                                                        | Unchanged copy        | webgpu-native/webgpu-headers `webgpu.yml`, `webgpu.h` and root `LICENSE` at `a1dc77409bb2b8bd80540cbf4b8db219e123e909`, BSD-3-Clause. Exact hashes are checked by the generator.                                                                                                                                                                                                                                             |
| `browser/gpu/generated/tables.ts`, `tests/fixtures/gpu/waffle_gpu_stream.h`                                                                 | Mechanical derivation | Selected C signatures, descriptor order and numeric enums from the same pinned YAML. Original Waffle opcodes, wire alignment, named lowering metadata and C writer helpers are added explicitly.                                                                                                                                                                                                                             |
| `browser/gpu/stream.json`, `tooling/gpu-stream*.ts`, `tests/gpu-stream.test.ts`, `tests/fixtures/gpu/{expected,enums,scene-expected}.json`  | Original adapter      | Explicit triangle, scene, compute, bundle, query and copy/draw-state selection, C-to-browser policy, schema tooling and independent expected bytes. No browser implementation or WebGPU IDL enum list copied.                                                                                                                                                                                                                |
| `browser/gpu/{codec,lowering,replay}.ts`, `tests/gpu-scene-*`, `tests/fixtures/gpu/scene-*.ts`                                              | Original adapter      | Creation, byte-span uploads, resource unions, explicit layouts, indexed bindings, copy/draw-state and depth/stencil controls against the pinned C schema and browser API. No upstream replay implementation copied.                                                                                                                                                                                                          |
| `browser/gpu/{buffers,payload,metadata}.ts`, `browser/display/{open.ts,generated/graphics-layout.ts}`, `tests/gpu-async-*`                  | Original adapter      | Native mapping epochs, fixed payload ownership, checked C output projection, direct UTF-8 encoding and async controls. No upstream runtime implementation was copied. Geometry constants are generated from original Waffle selection metadata.                                                                                                                                                                              |
| `browser/display/{service-readers,service-protocol,launch-retention}.ts`, `browser/gpu/{access,command-reader}.ts`                          | Original adapter      | Exact-service counted admission, queued grant retirement and original-ticket control charge retention. Original Waffle lifecycle code; no upstream implementation copied.                                                                                                                                                                                                                                                    |
| `browser/gpu/method-coverage.json`                                                                                                          | Mechanical derivation | Individual object method and global function names from the pinned webgpu-headers YAML above, BSD-3-Clause. Coverage categories, pending slices, reasons and selected-call metadata are original Waffle policy; no method implementations copied.                                                                                                                                                                            |
| `tests/page-runner/framework-dom-page.ts`                                                                                                   | Adapted control       | Synthetic viewport CSS/event fixture based on the exact `@vitest/browser` 5.0.2 distribution. It preserves iframe-only completion matching to expose the concurrency limit and uses the synchronous snapshot reporting contract, not an installed framework replacement. See [Framework operation controls](#framework-operation-controls).                                                                                  |
| `tests/page-runner/framework-trace-page.ts`                                                                                                 | Original adapter      | Captured native Vitest cleanup-channel observation and finite evidence ownership. No upstream message handler, cleanup implementation, or RPC expression copied. See [Framework tester trace observer](#framework-tester-trace-observer).                                                                                                                                                                                    |
| `tools/ci-release-download.ts`, `tools/ci-bootstrap-tools.ts`, CI download actions                                                          | Adapted code          | bun-wasm at `1bf9291451587b9b36786513dba817e855d470cb` and `b753bcd1fa4aff3089c304286c248a3da8a6e1e6`. Node-compatible API downloads and tool bootstrap, adapted to Waffle paths and inventory-based cache saving. See [CI release downloads](#ci-release-downloads).                                                                                                                                                        |
| `tools/ci-native-prebuild.ts`                                                                                                               | Adapted code          | Cache filename calculation from `prebuild-install` 7.1.3 `util.js`, with Waffle-owned archive checksum validation. See [CI release downloads](#ci-release-downloads).                                                                                                                                                                                                                                                        |
| `tools/ci-release-cache.ts`, Wasmtime action, CI coverage tests                                                                             | Original adapter      | Waffle-owned complete-asset inventory, pinned Wasmtime setup, and CI download guards. No external implementation copied. See [CI release downloads](#ci-release-downloads).                                                                                                                                                                                                                                                  |
| `fs/{storage-maintenance,idle-owner,publication-attachment}.ts`                                                                             | Original adapter      | Same-context broker release confirmation. No upstream implementation copied. See [Web Locks release confirmation](#web-locks-release-confirmation).                                                                                                                                                                                                                                                                          |

## Web Locks release confirmation

`fs/storage-maintenance.ts` and the lease in `fs/publication-attachment.ts` are original
Waffle interop code, not copied or adapted Chromium implementations. After releasing
a maintenance or publication guard, Waffle joins the original native request and
queries that same context's lock manager once. The idle owner's writer is released
after maintenance cleanup and is confirmed separately. Normal IndexedDB close
releases its writer first, so its subsequent maintenance confirmation covers both.

This restores release-before-settlement ordering on Chromium 156.0.8078.4. The
implementation rationale comes from Chromium's
[`lock.cc`](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/third_party/blink/renderer/modules/locks/lock.cc),
[`lock_manager.mojom`](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/third_party/blink/public/mojom/locks/lock_manager.mojom)
and [Mojo associated-interface ordering](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/mojo/public/cpp/bindings/README.md).
The handle closure and query share an ordered manager channel. The query reply
confirms processing of that closure; an empty snapshot from another context does not.
No upstream implementation was copied, and no acquisition, retry or timer is added.

The query does not inspect or wait for unrelated holders and grants no guest lock
authority. Chromium's contention notification does nothing to active pages and
Workers but may evict unrelated same-origin holders from the back-forward cache.
Confirmation failure rejects the original close or release and is retained on
repeated calls. Independent cleanup failures retain the operation error first.
OPFS's existing waiting lock acquisition is unchanged.

## GNU diffutils

`packages/diffutils` builds `diff` and `cmp` from the GNU diffutils 3.12 release archive (`diffutils-3.12.tar.xz`, SHA-256 `7c8b7f9fc8609141fdea9cece85249d308624391ff61dedaf528fcb337727dfd`). The source paths and patch are recorded in `packages/diffutils/sources.lock.json` and `packages/diffutils/patches/gnu-wasi.patch`. The patch disables unsupported process, signal, timezone and locale recovery APIs for WASI; it does not replace the comparison algorithms. Configure disables NLS and uses byte-order directory sorting. The build, packaging and test adapters are original Waffle code. GNU diffutils is licensed under GPL-3.0-or-later.

## Node WASI descriptor adapter

`proc/node-wasi.ts` is an explicit Node embedding leaf adapted from bun-wasm `web/scripts/node-process.ts:188-397` at `c16ff39435cc33465b999ea06c1ee9d20b952354`. The moved code owns the private Node WASI descriptor marker and lookup, preopen placement, preview1 descriptor translation, native `path_open` result remapping, file and pipe I/O, metadata, rights, flags, seek behavior, close, renumber and native or mixed `poll_oneoff` handling. Native poll temporarily receives the Node descriptor and restores the guest descriptor subscription before returning.

The Waffle API is opt-in at `waffle/proc/node-wasi`. It exports `NodeWasiImports`, `NodeWasiGuard`, `nodeWasiDescriptor` and `installNodeWasiDescriptors`. The module is not re-exported from a root, process index, runtime or browser entry and has no module-initialization work. Bun keeps `createNodeProcess`, signal guard and selected-signal exit, worker controls, native stdio, engine and network policy, JSON and host APIs. Bun replaces only its local descriptor lookup and installer call after the consumer coordinates its caller patch.

The focused fixture runs the real Node `node:wasi` implementation against Waffle's `DescriptorTable`, `WorkerProcessClient`, `WorkerPipeHost` and pipe services. It proves path-open remapping against a colliding pipe descriptor, rights and lifetime behavior, mixed native and pipe poll readiness, and restoration of guest poll subscriptions.

## Portable TCP transport

The `network/` Rust exception starts from Waffle base `d9973ca6b892ecf4b8a210be5328eb2645207d0d`. Bind candidates, `socket2` dual-stack configuration, byte queues and high-water policy are adapted from bun-wasm PR116's `crates/bunwasm-host/src/net/tcp.rs` and `net/mod.rs` at `4a734933901f5ff4c403925d1589afc2a4ce2e71`. The same file at `e46abe68d70ae82f550b7c111e486f0fafbd5323` is byte-identical to that source. Graceful retirement adapts its `Conn::close`, `is_flushing`, `read_loop` and `write_loop` contracts: preserve admitted output, send FIN, discard unread input and expose writer completion. The consumer still chooses linger and exit deadlines. Native accept, reader and writer threads, mutexes, notification objects and wakeup connections are not copied. Single-threaded WASM state advances through immediate nonblocking host calls and host readiness notifications.

`network/src/native.rs` is Waffle's reference OS adapter, compiled only natively. Its interruptible wait-many and socket-pair control wake are original Waffle glue. Outgoing and accepted TCP_NODELAY retains the source's `run_open` default. Unix SO_REUSEADDR restores the native listener-reuse behavior of the source's standard-library listener. The compiled-WASM EOF test adapts the source's stronger pending-accept close assertion; it does not accept reset as success. Seccomp controls run only in disposable test children. Waffle's original module ABI uses typed binary addresses and transport error kinds. Bun retains JSON/error wording, handles, Node/Bun APIs, engine registration and policy. The virtual Rust namespace adapts Waffle's previous `browser/net/namespace.ts` behavior without granting OS sockets to browsers.

## Process admission ownership

`proc/worker-broker.ts`, `proc/filesystem-codec.ts` and `browser/process-broker.ts`
are original Waffle adapters, based on Waffle revision
`15ba700268b6199e22ef61aa0d9464798c0d9562`. This change separates queued ownership
from supervisor records, gives rejection cleanup a codec-independent discard
capability, and retains external rejection fences through quiescence and disposal.
Acquired consumers bind to the directory, slot and monotonic PID at registration or
supervisor admission. Controllers registered before publication bind through this
broker's adopted root directory before rejection cleanup. Transports retained only
for failed cleanup never establish acquisition authority. Already admitted lifetimes
come from the supervisor admission hook. Payload and acquired-controller
filesystem fences both precede confirmation. Sender-validation failure starts cleanup
for the incoming transfer before propagating the error.
A cleanup-only filesystem codec can release shared reservation tokens without a
process identity; importing still requires an identity. No upstream implementation
was copied or adapted, and no filesystem storage implementation changed.

## Original inode permission adapter

`core/{filesystem,wasi}.ts` and `fs/{memory,backend,client,service,shared,storage,persistent}.ts`
implement Waffle's original single-principal inode policy and guest query. No Bun, Node,
WebKit or other upstream implementation was copied. Saved mode-less metadata adopts enforced
0600/0700 defaults on load and records them at checkpoint without changing format identities.
The query is separate from Preview1 filestat and executable-registry admission. Contract and
limits are in [permissions](permissions.md).

## Patched wasi-libc preopen scan

`patches/wasi-libc/preopen-scan.patch` applies to wasi-libc `libc-bottom-half/sources/preopens.c` at revision `2e6fb9d8ee0c`, the source revision recorded by wasi-sdk 34. The adapted branch handles an open non-preopen descriptor in the fd-3 scan: `fd_fdstat_get` success continues to the next descriptor, `BADF` ends discovery at the first empty slot, and every other error follows the existing error path. `scripts/build-wasi-libc.sh` downloads that exact revision, applies this patch, and builds a `wasm32-wasip1` sysroot with wasi-sdk 34. Consumers must use the resulting sysroot and pin the matching Waffle commit; Waffle does not provide a compatibility path for an unpatched libc scan.

## SLICC-kernel Apache-2.0 notice

The sync-access retry fragment in `fs/opfs.ts` is adapted from SLICC-kernel `src/fs/opfs.ts`, revision `88c5bb3`, licensed under the Apache License, Version 2.0. The complete license text is shipped at `LICENSES/Apache-2.0.txt`; the source header identifies the adapted fragment. No SLICC source is generated at build time.

## Extraction provenance

The repository was extracted with its rewritten commit history, including predecessor paths for the WASI shim, filesystem scaffold and memory views.

## Typed process startup failures

The original adapters in `proc/{types,outcome,wait-status,supervisor,abi,worker-client,worker-broker}.ts`
and `browser/{process-broker,worker}.ts` port the generic part of
[bun-wasm pull request 65](https://github.com/ShaulLavo/bun-wasm/pull/65) at
`bed7084763154adc8bd33ee6d06eb48873eab559`, to the extracted runtime. Waffle retains
its diagnostic hooks, quiescence fences and lazy adapters. The port adds a typed
startup outcome and shell-facing wait translation without copying Bun or Node code.

## Waffle landing page

| Source                                                                                         | Class            | Revision and local change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site/src/components/Landing.astro`, `site/src/styles/site.css`, `site/src/scripts/landing.ts` | Adaptation       | Owner-supplied `waffle-website.html`, SHA-256 `f845e81ca6cf60d3f832f88b48f4ceaf0a646c0237fe0f0dedfa31c680774383` (2026-10-18). Redesigned 2026-10-30: the headline, palette, ink outlines, wordmark, terminal cards and the blueprint-to-waffle story are kept; the layout, the scroll story, the copy and the sections after it are new. The page scrolls natively and the step cards dock and stack over a sticky stage, so the script reads one scroll offset per frame and writes no layout styles. No React or custom component runtime ships.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `site/src/scripts/waffle-scene.ts`                                                             | Adaptation       | The same owner-supplied page's embedded `Waffle scene v2`, asset UUID `10822c92-f196-44df-9869-57b07f16162b`. Geometry, shaders and interactions are retained; three.js r158 globals become named imports from `three@0.158.0`. Local changes, rendering: loading waits for an idle moment after first paint; no preserved drawing buffer; pixel density up to 3x within a 5.6-megapixel budget, stepped down when frames run under 42 fps; canvas size from a `ResizeObserver`; waffle normals computed from a precomputed ridge gradient instead of `computeVertexNormals()` each frame; the terminal texture uploads only when its text changes; name tags drawn at twice the resolution; the unused outline post-process is removed; custom layouts no longer drift right and shrink less as the waffle folds; touch moves no longer tilt the camera; `onReady` and `onProgress` callbacks. Local changes, models: ink shells use one averaged direction per corner and thin out on small parts, which removes the spikes on flat-shaded edges; a soft rim light on the toon materials; smoke is inked opaque cloud puffs instead of transparent spheres; the notebook pocket is a Python building with a coiled snake and the packages pocket is a depot with loading bays and a forklift, both labelled as running today; the bakery has a lit shop window; blueberries have one crown each. Local changes, waffle: a cartoon shape with crowned ridges, rounded-square pockets and a puffier rounded border; brighter golden colours and a softer toon ramp; no ink shell on the surface, and instead one thin shader-drawn stroke around each pocket's rim. |
| `site/scripts/*.ts`, optional bundle-analysis hook in `site/astro.config.ts`                   | Original adapter | Reference extraction, native scene visibility checks, performance diagnostics, the landing smoke check and bundle inspection. The pixel parity checker against the supplied page was removed with the redesign.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `site/public/assets/THREE-LICENSE.txt`                                                         | Unchanged copy   | `three@0.158.0` npm package `LICENSE`, upstream `mrdoob/three.js` tag `r158`. Full MIT copyright and permission notice retained separately from the minified runtime bundle; no text changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `site/src/assets/*.woff2`                                                                      | Adaptation       | The owner's embedded Google Fonts latin files: Bricolage Grotesque v9, Fredoka v17 and Martian Mono v6. Subset to Basic Latin, Latin-1 and common punctuation, then instanced with fontTools 4.68.0: Bricolage Grotesque at `wdth` 100, `opsz` 18 and `wght` 400 to 700 (it now sets body text only), Fredoka at `wght` 700 (logo and titles), Martian Mono at `wdth` 100 with `wght` 400 to 700. Together they drop from 199,408 to 64,796 bytes. The SIL Open Font License allows modified versions, and none of the three declares a Reserved Font Name. Notices are in `site/public/assets/FONTS-LICENSE.txt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `site/public/favicon.svg`                                                                      | Original adapter | A waffle icon drawn for the site in the landing palette.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Three.js license notice

`site/public/assets/THREE-LICENSE.txt` is an unchanged copy of `LICENSE` from the pinned `three@0.158.0` npm package (upstream `mrdoob/three.js`, tag `r158`). It accompanies the bundled Three.js implementation because minification removes the module's short license header. The notice is published as a separate text asset without adding a runtime request.

The page has no bitmap images or video: its visuals are inline SVG, CSS and procedural WebGL. Links point to Waffle's GitHub repository and documentation, the Bash Web repository and the `https://bun.sprockt.dev/` Bun sandbox. The program packages listed on the page link to their directories under `packages/`.

## Filesystem startup observation

`fs/startup.ts` and the hooks in `runtime.ts`, `browser/{shared-fs,fs-worker}.ts`,
`fs/{service,indexeddb,opfs}.ts` are original Waffle adapters. They report fixed
startup stages around existing operations without copying upstream implementation
or changing storage policy. The lock milestones are outside the SLICC-kernel
retry fragment in `fs/opfs.ts`; its later ownership additions are described below. See
[runtime-startup.md](runtime-startup.md) for the clock and stage boundaries.

## Filesystem ownership policy

The queued ownership requests, `whenBusy` settings, lifecycle state and abort/disposal
handshake in `fs/{opfs,indexeddb,service}.ts`, `browser/{shared-fs,fs-worker}.ts` and
`runtime.ts` are original Waffle adapters. They change only original ownership glue;
the SLICC-kernel sync-handle retry algorithm at revision `88c5bb3` is retained.
The fragment now also contains the original failed-close guards described below. The original
`browser/filesystem-worker-backend.ts` adapter retains opening errors together with failed
storage cleanup; no upstream implementation was copied. Storage
setup occurs under its lock, and cancellation closes acquired resources before releasing
that ownership. Pending IndexedDB opens now observe the same startup signal under both busy policies; cancellation acknowledges cleanup without waiting for the browser open and closes any late database success before ownership acquisition. No new upstream implementation was copied.

## Quality-gate adoption

`core/memory-views.ts` remains an original Waffle adapter. Exported TypeScript
types replace its separate declaration file. Fallback views initialize eagerly,
and both branches construct the same bounded-range method. View identity and
refresh semantics are unchanged. The original storage glue in `fs/opfs.ts` now validates storage presence
on deletion and shares submission-time batch snapshotting with IndexedDB. Its
SLICC-kernel `src/fs/opfs.ts` revision `88c5bb3` retry algorithm is unchanged, apart
from repository-wide formatting. The owner-supplied scene is excluded from that
formatting pass; owned Astro templates, landing glue and site tooling are formatted.
No new upstream code was copied for the quality tools or failure probes.

## VFS selection contract

The descriptor/selection API in `fs/vfs.ts` and its browser/runtime wiring are original
Waffle adapters, including `fs/vfs-internal.ts` and `fs/vfs-format.ts`. Public selection
uses FAST/SAFE semantics; backend overrides remain internal conformance controls. SAFE
is unsupported until a durable-ACK engine exists. Startup diagnostics retain typed
error names/codes, including invalid established metadata, incompatible database versions
and mismatched format identities. IndexedDB stores its format record in metadata;
OPFS uses a format-named metadata entry. Validated unmarked existing layouts gain an
identity without changing payloads, namespace, database version or lock names. The OPFS
snapshot error is outside the adapted sync-handle retry fragment from SLICC-kernel
`src/fs/opfs.ts` at `88c5bb3` (Apache-2.0). That fragment now includes the original
ownership additions described below; the retry algorithm is unchanged. No upstream
code was copied for this revision. Format-marker adoption is original Waffle glue,
not a new storage engine or an automatic implementation migration.

## Loopback namespace

`browser/net/{namespace,runtime,host,helper,protocol,ring}.ts` are original Waffle adapters.
The namespace shares localhost listeners across worker rings on the existing
helper thread. New synchronous control replies and read-credit notifications
reuse the existing request transport and ring. Socket ownership follows helper
lifetimes, with no global registry, Bun ABI code or copied upstream implementation.
See [network.md](network.md) for the consumer launcher contract and browser tests.

## OPFS failed-close ownership and native observations

The adapter-wide ownership map in `fs/opfs.ts` is original Waffle glue. It retains
each native sync-access original whose close fails, its exact reason and the
existing WebLock. Only successful physical close removes ownership. Cached,
evicted and transient originals share that ownership; terminal failed close is
not retried or treated as successful cleanup.

The acquisition fragment remains adapted from SLICC-kernel `src/fs/opfs.ts` at
`88c5bb3`, Apache-2.0. Its constants, locked-error classification and delay/retry
algorithm are unchanged. Waffle added successful-acquisition registration and a
failed-owner guard before each attempt, including after backoff. Bounded range
reads also check cancellation before an attempt and before another backoff, so an
aborted read cannot start another acquisition. A started acquisition remains joined,
and a late original remains owned for ordinary close. The fragment is therefore not
byte-identical. These guards prevent acquisition after cancellation or known
failed-close debt; they add no retry or upstream recovery algorithm.

`tests/opfs-close{,-browser-observer}.test.ts`, `tests/opfs-close-browser{,-runner}.ts` and
`tests/fixtures/opfs-close-{page,worker}.ts` are original Waffle test adapters.
No upstream implementation was copied for these observations. Native success
and labelled pre-physical-close injection remain distinct; injection does not
prove spontaneous native failure, caller lifetime or natural Worker retirement.
The source-only browser entry requires a separately qualified whole-arm
controller before execution. Its local promise deadlines and the existing
60-second lifecycle emergency fence are not that controller.

See [opfs-close.md](opfs-close.md) for the source checks and the remaining native qualification boundary.

## Ordinary filesystem shutdown

`browser/shared-fs.ts` and `fs/{service,persistent}.ts` are original Waffle adapters.
This integration retains Waffle's page disposal from revision
`e7d4e35d0ef512bd36387a80d87246d8b0231ea9` and service/backend close from
`6a979e034b3419f5545a54ec6952f07bb898fff4`, against main revision
`93698f1009130a2bc7142872e4f02ced06f58272`. No Bun, browser-engine or other
upstream implementation was copied. OPFS's adapted retry fragment is unchanged.

The page publishes one disposal promise before revoking admission. A ready ordinary
persistent caller stops its client and Worker only after the original service ACK
and root section fence. Service shutdown retains admitted work and its failures,
then releases session pins before closing the backend. Backend close joins admitted
reads and checkpoints before the final durable save and native storage close. Failed
drains or saves retain the original failed owner instead of closing storage anyway.

The native fixtures are original test adapters. Their preparation gate and injected
post-close failure are explicit test seams. The ready-caller proof observes a real
SharedFilesystem, Worker, service and IndexedDB backend, joins the original target's
close event before cleanup, and reopens its dirty marker. The post-close failure seam
runs after native close/unlock; it does not prove native failed-close lock retention.
See [storage shutdown](storage.md#ordinary-ready-shutdown) for commands and limits.

## Program dependency license texts

`tools/licenses/fluent-langneg-0.13.1-MIT.txt` is the unchanged `LICENSE-MIT` from
projectfluent/fluent-langneg-rs at `7fdc590466ea63ca2367ac10fb1b881fe561f1a8`.
`tools/licenses/intl_pluralrules-7.0.2-MIT.txt` is the unchanged
`intl_pluralrules/LICENSE-MIT` from zbraniecki/pluralrules at
`d0715d5b7cca72e228d6e6c4de154bd30dfdd06a`. The crates declare a choice of MIT
or Apache-2.0, but their published archives omit those files. Their `.cargo_vcs_info.json`
records identify these commits. The notice generator verifies those recorded revisions
and the copied text hashes before including the MIT texts. No dependency code is changed.

The checksum utilities add three more MIT-only crates whose archives omit license text.
`tools/licenses/nugine-simd-d74c030d-MIT.txt` is the unchanged root `LICENSE` from Nugine/simd at
`d74c030d9dc4f3cae02146d1f497ff62726ef09a`, recorded by both base64-simd 0.8.0 and vsimd 0.8.0.
`tools/licenses/blake2b_simd-1.0.5-MIT.txt` is the unchanged root `LICENSE` from
oconnor663/blake2_simd at `47714dc3c424e82213d7f2eb4a833e3843017be5`.

## Xargs explicit-command adapter

`packages/findutils/vendor/uutils-xargs/src/lib.rs` adapts uutils/findutils
`src/xargs/mod.rs` at `505421d4e03586efeb7b9c55adf057599e192e0a` (MIT).
`vendor/uutils-xargs/provenance.json` records the upstream hash, current files and
reversible `wasi.patch`. The original Waffle adapter calls the singular
`waffle-process-consumer` for executable lookup, exact argv/environment/cwd,
inherited descriptors, typed child outcomes and cancellation/retirement. An owned
closed-writer pipe supplies child EOF for stdin-driven input; `-a` preserves stdin.
The binary initializes libc cwd from runtime identity instead of trusting PWD.
Empty byte-delimited items are retained. Default print-only echo and rejected
replacement/parallel modes remain explicit. No shell, host fallback, copied
process protocol or new runtime controller is introduced. The controlled C test
utility is original test-only code, never a shipped command.

## External echo entry

`packages/coreutils/crates/echo` is an original MIT adapter to unchanged
uutils/coreutils `src/uu/echo` and `src/uucore` at
`07763857f6b9a547742a994b58aef0ccd036198b`. The source receipt and copied root
license are in the coreutils family. An echo-only linker observer records actual
nonempty EBADF writes while preserving syscall results; the existing uucore
post-hook reports the failure that Rust stdout suppresses. It does not parse
arguments or duplicate echo output logic. Native closed-stdout suppression remains
a separately recorded limitation. The runtime, shared process consumer and older
coreutils implementations are unchanged.

## Memory group sources

The memory group owner, member imports and broker integration are original Waffle code. The cumulative member-page policy, fresh-growth clearing rules and member-incarnation-or-group pin ownership in `group/state.ts` are also original adapters, with no upstream implementation copied. `shm_route_group` converts ownership so shared regions can survive their creator's physical stop, using the existing owner request path and quota. The Chromium fixture image is adapted from the Engines track's unpublished 2026-10-29 shared-memory prototype `member.c`, which proved that one PIE image instantiates into one shared `WebAssembly.Memory` at several bases. The adaptation replaces `memory.grow` with `runtime_shm.group_grow`, adds `runtime_shm` region and futex calls, and runs a command loop that the test page drives through the member's own statics. Its group-pin import and command are original Waffle test additions for compiled-import and creator-stop coverage.

## English program catalog build scripts

`tools/program-locales/patch.ts` adapts uutils/coreutils `src/uucore/build.rs`
under the MIT license. The two original file hashes and upstream revisions are
recorded in `tools/program-locales/sources.json`. The generated patched source
retains the original copyright header and, for revision
`07763857f6b9a547742a994b58aef0ccd036198b`, its target configuration aliases.
Waffle replaces the upstream directory scan with its original single-program
English catalog generator. The build wrapper never edits the dependency caches.
Original dependency identities and license notices remain unchanged.

The wrapper, input selection, generation, locking, and proof collection are original
Waffle adapters. They record source and generated hashes separately from final guest
hashes. The shipped command code and uucore language fallback are not patched.
See [English program catalogs](program-locales.md) for coverage and build identities.

## Program artifact finalization

`tools/program-build-tools.ts` originated in bash-web `9ef027d7`, from
`scripts/wasi-build.ts` and `scripts/verify-wasi-guests.ts`. The supported
`waffle/program-build-tools` export packages these canonical sources with their
optimizer and derivation dependencies. Package preparation copies exact source
bytes and emits Node modules; generated copies are not edited. Packaged derivations
bind the original source hashes and Waffle build commit rather than a consumer's
Git checkout. The libc builder and scanner patch still come only from the explicit
`recipe.waffle` directory. Its original byte reader
now rejects integers outside the Wasm u32 range. Waffle's original `stripWasmNames`
removes only complete custom sections whose name is exactly `name`, retaining every
other encoded byte. The original `stageProgram`, `program-optimize.ts` and
`program-derivation.ts` adapters run pinned external Binaryen before the existing
verifier, then apply that byte transform and bind both steps to final staged bytes.
No Binaryen implementation is copied into this repository. Named compiler inputs,
locale proofs and accepted Python producer receipts remain unchanged. Optimized code
is verified while names remain available; final hashes follow stripping. Python's
separate derivation preserves its original producer identity.

## External nl entry

`packages/coreutils/src/bin/nl.rs` is an original MIT adapter to unchanged
uutils/coreutils `src/uu/nl` and `src/uucore` at
`07763857f6b9a547742a994b58aef0ccd036198b`. The pinned dependency owns numbering,
file traversal, byte input/output, help, and diagnostics. The source receipt is
`packages/coreutils/provenance/nl.source.json`; the family notices retain upstream
MIT licenses and production dependency notices.

The original `nl_bre` module normalizes numbering-style arguments with upstream's
option parser. It follows the original Waffle grep adapter's common BRE literal,
operator, and branch-anchor rules at Waffle `19b3a67`. Backreferences are explicitly
rejected, so this does not claim complete GNU BRE parity. Matching is byte-oriented.
There is no native command, Bash, or second-runtime fallback. The nl-only TypeScript
oracle runs GNU separately as a test reference and compares identical inputs.

## jaq WASI packaging

`packages/jq/sources.lock.json` pins the immutable jaq archive and SHA-256. The local patch changes only `jaq/Cargo.toml` and `jaq/src/funs.rs`: rustyline, dirs and `repl` remain native-only, while WASI registers the unchanged noninteractive evaluator. Build, packaging, license staging, Brotli measurement and tests are original Waffle adapters. Known jaq, jq and gojq differences are in `packages/jq/docs/compatibility.md`; no full-parity claim is made.

## Optional upstream tar candidate

`packages/tar/sources.lock.json` pins the uutils tar archive and patch hashes. The
standalone Cargo workspace pins tar-rs 0.4.46, flate2 1.1.10 and uucore 0.9.0.
The Waffle adapter obtains cwd through `runtime_proc.cwd`, adds one `-C`, rejects
member filters and external compressors, validates gzip trailers and numeric
metadata, and excludes native-only writer/extractor code on WASI. Missing UID/GID
and permission restoration cause status 2 before filesystem changes. See
`packages/tar/docs/compatibility.md`; create/extract remain unqualified.

## External date entry

`packages/coreutils/crates/date/src/main.rs` is an original MIT adapter to unchanged
uutils/coreutils `src/uu/date` and `src/uucore` at
`07763857f6b9a547742a994b58aef0ccd036198b`. Upstream owns date parsing,
formatting, timezone resolution, file timestamps, and wall-clock reads. The entry
uses the existing WASI cwd helper and rejects the parsed `set` option on every
target before execution. It cannot set the native host clock during verification.
The optional date-localization feature is disabled under the family's English-only
locale policy. No date parser, timezone data, clock data, or command implementation
is copied or fabricated. The receipt is
`packages/coreutils/provenance/date.source.json`. GNU date is a hash-pinned test
oracle only, never a production fallback. A declared fixed clock belongs only to
the Node WASI comparison fixture. The actual runtime test uses the real clock and
file metadata on the caller's single runtime.

## Checksum entries

`packages/coreutils/crates/checksums` builds `b2sum`, `cksum`, `md5sum`, `sha1sum`, `sha224sum`,
`sha256sum`, `sha384sum`, `sha512sum` and `sum` from uutils/coreutils revision
`07763857f6b9a547742a994b58aef0ccd036198b`, under MIT. The checksum algorithms, streaming reader
and record parser remain upstream. `scripts/prepare-checksum-source.ts` exports that exact revision
into `packages/coreutils/.sources/checksums`, applies
`crates/checksums/patches/selected-io-and-escaped-records.patch` and seals every generated file in
a receipt. The patch makes absent standard descriptors fail only when selected, propagates
verification write errors and decodes escaped checksum records once. Each entry is an original
adapter that enters the runtime's launch cwd through `runtime_proc.cwd`, not `PWD`.

Locale selection embeds only the utility's English catalog, the common uucore catalogs and, for
every utility except legacy `sum`, `checksum_common`. It accepts the owned dependency only through
its receipt hash and keeps the generated catalog source in each proof.
`packages/coreutils/provenance/checksums.source.json` records package paths, upstream hashes, the
patch hash, license and fixture identity. GNU coreutils 9.12 is a version- and hash-checked test
oracle, never a runtime fallback.

## Optional One True Awk

`packages/awk` builds the authoritative onetrueawk/awk archive at `5739fd79bcfc75ba7526773d0cf634521f8aca3c`, SHA-256 `14b636bec87f5817012d883b9b318e808eee28881a7b4388f92ef6b5f940d7ef`. The package retains its Lucent license and upstream FIXES. The WASI-only patch initializes cwd from `PWD`, omits native signal and close-on-exec setup, and rejects unavailable system commands and command pipes. It does not change expression evaluation, parsing, field processing or nonlocal exit. Real `setjmp` and `longjmp` use the exact shared sysroot's `libsetjmp.a` and standard Wasm exception handling. Package notices retain incorporated wasi-libc notices. Native oracle fixtures use the same archive and patch with the WASI guards inactive. Build, tests, catalog and receipts are original Waffle adapters.

## Guest program support

`packages/program-support` owns the neutral executor, cancellation, descriptor and
filesystem code originally extracted from bash-web. The public hooks follow
`shell/engine/src/executor.rs`, `io.rs`, `runtime.rs` and `runtime/wasi.rs` at
`ed31b2bf47fe92afa4c9568868f206f35b9add27`, under the retained MIT license.

The directory page reader, Preview1 filestat decoder, runtime permission decoder,
buffered source and weak endpoint behavior are reused without shell policy.
Waffle makes the existing cancellation and event registrations public, adds a
kind-and-id readiness notification that releases its registry borrow before waking,
and exposes stack measurements only for tests or the opt-in `stack-observation`
feature. `WasiAbi::with_inherited_fds` accepts the embedding's launch metadata and
uses the existing bounded root-preopen scan. Shell process groups, access requests,
signals and prompt imports remain in bash-web. No new guest import is introduced.

Waffle's deadline registry, fused `Sleep`, poll-timeout conversion and
non-consuming read-readiness dispatch are original additions. They extend the
existing executor and descriptors so consumers do not copy scheduling or I/O
internals. Runtime read observation uses one existing kind-0, zero-time
subscription and never dispatches other waiters. No upstream implementation or
new host ABI is copied. The existing `proc/abi.ts` zero-time read scan reports
regular files ready without entering pending-I/O or shared-offset waits;
positive and indefinite poll waits retain their completion semantics.

[Program-support APIs](../packages/program-support/docs/api.md) lists the public
contracts. Native public-API tests cover descriptor lifetime, allocation accounting,
cancellation, reentrant notification, stat and directory decoding. The WASI library
check compiles the import adapter without building any guest program.

## Pipe slot lifetimes

`proc/pipes.ts` extends Waffle's original ring implementation at
`1722b65e81b1b37d3931d9fc1e078ee33d8b4b8d`. Header offset 36 holds a finite incarnation
and a synchronous mutation count. The counter prevents delayed payload, close, revoke and
relay operations from changing a replacement slot. Writer reuse continues cursors and old
committed records; reader reuse waits for full relay recovery. A terminated section owner
quarantines its slot. The registry retains append-only cells and its unchanged default cap.
The earlier wrap/copy scheme originated in Waffle's `browser/worker.ts` SharedPipe, not an
external source. These lifetime rules and host allocation hook are original adapters, with
no upstream code copied or adapted.

## Preview 1 launch socket adapter

`browser/preview1-network.ts`, `browser/preview1-network-types.ts` and
`browser/preview1-socket.ts` are original Waffle adapters based on the injected connector at
`ad4afb4eb2a374a841dbfbcf7136e4c8399e63e6`. They retain the helper on the responsive owner,
carry a ring and MessagePort to the worker, and wrap each NetHost connection in a shared
socket description. The descriptor and WASI changes add standard Preview 1 socket operations,
readiness and directional shutdown. The WAT and C fixtures are original test programs.
No Bun, Node, wasi-libc or other upstream implementation was copied or adapted for this work.
The existing wasi-libc patch remains unchanged.

## WebTransport relay adapter

The optional relay's WebTransport modules are original Waffle adapters. They use `main/lib/server.js`, `main/lib/session.js` and `main/lib/stream.js` from `fails-components/webtransport` revision `71d1ba5147c7733fbfd3a375116b9f58484d9f13` through the exact `@fails-components/webtransport@1.6.11` and `@fails-components/webtransport-transport-http3-quiche@1.6.11` packages. Both dependencies are BSD-3-Clause and remain outside this source tree. No native code or upstream stream implementation is copied or patched.

The private reset adapter translates relay codes 1 through 4 to the dependency's `{ code }` argument and recognizes only its exact bounded reset-message forms. The endpoint owner replaces a stopped server instead of calling `updateCert`, because the pinned native binding does not implement that operation. Certificate rotation resets WebTransport streams and leaves the independently owned WebSocket service running.

## GPU stream schema foundation

`packages/waffle/browser/gpu/upstream/webgpu.yml` is an unchanged copy of
webgpu-native/webgpu-headers `webgpu.yml` at
`a1dc77409bb2b8bd80540cbf4b8db219e123e909`, SHA-256
`9268864efc29edc2e4fa40949643d14ae5bf6664447eadfccdeaefe7e14d130b`.
The adjacent unchanged BSD-3-Clause `LICENSE` has SHA-256
`17420d366df90c474bd70ad474694956cdb7fc64be70387a49a45458c4152d22`.

The checked-in TypeScript tables and C fixture header mechanically derive selected C argument
order, struct members and numeric enums from that source. The C header describes wire bytes,
not native C struct padding, and uses Waffle-prefixed names so it can be included alongside
`webgpu/webgpu.h`. Its cursor writes explicit little-endian bytes. It is fixture support, not a
C client library.

The selection file and generator are original Waffle code. The instance root, callback-result
handles, event callback omission, surface output/status replies, queue property, WGSL chain,
automatic pipeline layout, dictionary names and supported browser enum mappings are explicit
Waffle adaptations. YAML does not supply these browser semantics. Unsupported values remain
classified and rejected by the tooling's lowering checks. No WebGPU IDL list was copied.

The independent expected-byte and enum files were written against the corrected wire contract
and the pinned upstream C declarations before any replay implementation. `check:gpu-stream`
checks both generated outputs and hashes the YAML, license, selection, generator, layout tooling
and independent fixture inputs. This foundation activates no runtime GPU capability.

The textured-scene extension derives buffer, texture, sampler, bind-group and pipeline-layout
descriptors from the same pinned `webgpu.yml`. Upload lowering replaces the C data pointer and
paired size argument with an explicit byte span. Binding-layout arms, bind-group resource unions,
whole-size and copy-stride sentinels require named policies rather than native C layout copies.
The browser member names and policies were checked against `gpuweb/gpuweb` `spec/index.bs` at
`4e829b310ba7381034b93b974eb1a6aabfb464f7`. No specification prose, IDL enum list or browser code
is copied. Independent scene byte vectors extend the generation freshness inputs. Bounded native
controls exercise the generated stream against Chromium WebGPU; they do not substitute for the
compiled guest scene or complete G1.

The compute extension derives synchronous pipeline creation, compute-pass descriptors and the
complete ordinary compute-pass command inventory from the same YAML pin. Its original adapters
reuse constant records, automatic layouts, timestamp sentinels and checked numeric conversion.
Immediate data replaces the C pointer and size with one byte span. Browser names, immediate
layout size and WGSL immediate-address-space controls were checked against the same pinned
`spec/index.bs` and `wgsl/index.bs`. Independent compute vectors are freshness inputs. Native
shader-written readback controls are trusted host observations, not guest G2 mapping support.

The bundle/query extension derives the complete render-bundle encoder inventory, query descriptors
and pipeline binding-layout getters from the same pinned YAML. The generator preserves the C
receiver/result order, array counts, integer alignment and immediate pointer/size pairing. Bundle
records use a typed resumable encoder cursor and bind the guest-owned finish result. Query types
and browser dictionary members use explicit mappings. These are original adapters, not copied
browser code. Independent bundle/query literals are freshness inputs. SwiftShader pixel and query
controls use trusted-host readback only and do not claim G2 mapping or compiled guest acceptance.
The existing compute-native controls are still not CI-wired.

The copy/draw-state extension derives command-encoder copies, clear, debug commands, render-pass
immediates, indirect draws, render state and explicit buffer/texture destruction from the same
pinned `webgpu.yml`. Opcodes 69–88 append to the unchanged 1–68 layouts. The C copy-buffer
layout becomes the browser's flat copy dictionary. Stride and whole-size sentinels use named
policies, and immediate data replaces only the C pointer and size pair. These mappings and tests
are original adapters. The single `depth24_plus_stencil8` format maps explicitly to
`depth24plus-stencil8` for stencil-state controls. Acquired frames expose their actual native
texture, with separate discard bookkeeping. No browser implementation, specification prose or IDL enum list is copied.
Independent copy/draw byte literals are generation freshness inputs. Native SwiftShader controls
use trusted-host readback to check row offsets, draw state and destruction validation. They do
not qualify compiled guests, guest G2 mapping, full G1, or untested hardware. These native controls
are not currently all CI-wired.

## GPU method coverage classification

`packages/waffle/browser/gpu/method-coverage.json` mechanically derives method and global function
names from `webgpu-native/webgpu-headers/webgpu.yml` at
`a1dc77409bb2b8bd80540cbf4b8db219e123e909`, under the adjacent BSD-3-Clause license.
The per-declaration classifications, reasons, pending slices and selected-call metadata are
original Waffle policy. `tooling/gpu-coverage.ts` and `tests/gpu-coverage.test.ts` are original
validation adapters. They parse the pinned YAML with Bun, reject missing or stale entries and
compare selected calls with the existing stream and generated lowering metadata. They copy no
WebGPU implementation and implement no future C client.

## GPU asynchronous output schema

The unchanged `browser/gpu/upstream/webgpu.h` is from webgpu-native/webgpu-headers
`webgpu.h` at `a1dc77409bb2b8bd80540cbf4b8db219e123e909`, under the adjacent BSD-3-Clause
license. The generator checks its hash with the YAML and license. The source-ABI control
compiles against this real header, not a reconstructed sentinel declaration.

The geometry-only `browser/display/generated/graphics-layout.ts` contains original Waffle
arena constants generated from selection metadata, not native C padding or upstream code.
It keeps display and guest startup independent of the full GPU metadata tables.

The G2 tables and generated wire header derive selected calls 107 through 120, completion
kinds 16 through 19 and output structures from the same YAML. Mutable C outputs and callback
signatures are checked before pointer removal. Both kinds of extensible output structure
encode an explicit empty chain. Payload-directory constants and source-size sentinel
normalization are original Waffle protocol rules. Independent literals cover these bytes.

## Framework operation controls

The synthetic viewport controls in `tests/page-runner/framework-dom-page.ts` adapt
`page.viewport` in `@vitest/browser` 5.0.2 `dist/context.js` and the CSS/done/fail
route in `dist/client/__vitest_browser__/orchestrator-M9828UZ-.js`. The exact npm
archive is pinned in `bun.lock` with SHA-512
`nX9xXZ/j8YfU7KTeFa+tpSP331SbI81qBQTASRlcopYeaTgBerNmJryzHXHrFOW0NYldd3Dn5gw651zGnmaQzw==`.
The upstream package uses the MIT license.

The fixture uses a synthetic iframe identifier, local HTTP provider dispatch and
renamed window-message events instead of the framework's BroadcastChannel and
RPC. It retains iframe-only completion matching, CSS resizing and done/fail
ordering. These adaptations isolate sequential sizing, same-size completion,
restoration and the concurrent-call correlation limit without importing original
tests. Its reporting calls now use snapshot factories and await real synthetic lifecycle
boundaries. This changes only the local observation adapter, not the upstream viewport
algorithm or clocks. They do not qualify the installed ordinary page method or an official
screenshot callback. Fixture callback bytes are explicitly not a DOM image.

The shared host operation boundary, callback scopes, recursive joins, local
closure fact, document invalidation and transport ownership checks are original
Waffle adapters. They copy no SDK screenshot, image conversion or filesystem
implementation. Consumer registration and mutable-context integration remain
consumer-owned work.

The reporting reservation, scalar heartbeat failure/cancellation protocol and CPU realm controls
are original Waffle adapters. They copy no Vitest hooks or RPC implementation. The CPU controls
promote the retained reporter-fault reproducer's use of actual reporter, collector and owned host
paths. The later paired consumer owns the exact installed Vitest patch and its provenance.

## GPU reader retirement

The display service fence, grant frame lease and physical read adapter are original Waffle
implementations. No upstream path or revision applies. They preserve the existing ring format
and guest ABI while closing dedicated-service access before page retirement. The ticket receipt
listener and retain-only accounting rules are also original adapters. They retain original charges
across independent shared-buffer clones and late delivery, without identifying backing by wrapper
equality or charging an open clone again.

## Framework tester trace observer

`tests/page-runner/framework-trace-page.ts` is original Waffle code against
`@vitest/browser` 5.0.2. The inspected distribution paths are `dist/client.js`,
`dist/client/__vitest_browser__/orchestrator-M9828UZ-.js`, and
`dist/client/__vitest_browser__/tester-COH68OX9.js`. The client's SHA-256 is
`e5a46a0da670e50e7cce2f3eb367c1403911a8c7459f368c058b177a37604270`.

The adapter uses the actual native channel constructed from the own-data session
identity and matches own-data `event`, `iframeId`, and `messageId` fields. It observes
the successful terminal post after the original cleanup catch and trace finishing.
It copies none of Vitest's handler, cleanup, RPC, or error serialization code.
Waffle owns admission, bounded snapshots, physical receipts, and the distinct final
disposal authorization. [Framework tester trace ownership](framework-tester-trace.md)
describes the contract and its CPU-only verification limits.

## CI release downloads

`tools/ci-release-download.ts` and `tools/ci-bootstrap-tools.ts` adapt bun-wasm
`scripts/ci-release-download.ts` and `scripts/ci-bootstrap-tools.ts` at
`1bf9291451587b9b36786513dba817e855d470cb`. The setup action comes from
`.github/actions/setup-tools/action.yml` at the same revision. The release cache
and Rust cache actions start from bun-wasm `.github/actions/release-downloads/action.yml`
and `.github/actions/rust-build-cache/action.yml` at
`b753bcd1fa4aff3089c304286c248a3da8a6e1e6`.

Waffle changes script paths to `tools/`, keeps the bootstrap installer private,
requires a token for uncached CI release requests, and saves cache snapshots only
after the completed asset inventory grows. The bootstrap restores setup-bun's
`bunx` symlink and safely recreates it when a job provisions Bun again.
The inventory hashes original-URL keys, not temporary signed URLs or credentials.
Warm jobs restore the same snapshot without saving a duplicate. Local non-CI use
retains unauthenticated fetching. Binaryen 133, sccache 0.19.0, wasi-sdk 34,
jq 1.8.2, Wasmtime 49.0.3, Bun 1.4.4, the original Node selectors, relay prebuilds,
relay image archives, and program publication inputs use this transport.
Existing checksums and executable checks remain in their callers.

`tools/ci-native-prebuild.ts` is Waffle's adapter for the pinned WebTransport
1.6.11 Linux x64 archive. Its six-character SHA-512 URL prefix and sanitized cache
filename adapt `prebuild-install` 7.1.3 `util.js` functions `cachedPrebuild` and
`prebuildCache`. It verifies the existing archive SHA-256 before supplying the
standard installer's cache. The installer, native artifact existence check,
loader-shadow rejection, package pins, and addon checksum checks remain active.
No upstream download or extraction implementation is copied.

`tools/ci-release-cache.ts`, the Wasmtime action, and the coverage tests are
original Waffle adapters. `test:ci` loads the transport and coverage tests through
`packages/waffle/tooling/ci-paths.test.ts`. New remote setup actions require an
explicit download audit. Workflow setup restores the release cache before Bun
or Node installation and saves only a changed complete-asset inventory at the end.
The relay image publish job requires the hosted Ubuntu runner's existing Buildx
instead of installing another moving release. GNU FTP, curl.se, codeload, npm
registry traffic, and GitHub artifact transfers are outside the release endpoint
change.

## Page continuity lock observation

The page bootstrap captures the existing manager methods before importing the cross-tab fixture.
The observer records page-owned continuity requests and candidates for their existing release-time
queries. It makes no request or query of its own and never reads query snapshots. The evaluator's
existing diagnostic reply carries the bounded scalar records. Query association uses evaluator job
identity, not a native request identifier. Every query association remains ambiguous, even for one
job and one candidate. A query does not consume a candidate, since another same-job caller may
have issued it. It cannot identify a holder or prove physical Worker survival.

The captured methods receive their original receivers and arguments, except for the transparent
callback wrapper. That wrapper preserves the callback receiver, arguments, return value and thrown
value. Request and query callers receive the original Promise. Nonthrowing Promise observers add
microtasks and mark observed rejections handled, so this diagnostic is not scheduling-neutral.
It does not change the caller's settlement. Arbitrary error text is omitted because it can contain
workspace tokens; only known error names, the thrown value's type and finite errno survive.
Records contain no lock name, Lock object, callback, runtime capability or query snapshot.
The page and projector retain the first eight records and recent records within the 32-record and
8 KiB limits. Aggregate trimming removes records from the largest page first and preserves each
page's prefix as long as its overall bound permits; dropped counts remain explicit.

The Chromium control uses the actual guard and untouched exclusive helper. Injected manager
failures distinguish null acquisition, synchronous throws, pre-grant rejection and granted lifetime
or query failure. These controls validate the observer, not the cause of any native Safari failure.

## Native page observation sources

`tests/page-runner/inspector-plist.ts` adapts the owner's original bounded binary-plist codec from the November 6, 2026 `bun-inspector-owned-page-dev/wir/plist.ts` diagnostic. Its four-byte framing and binary-plist parsing are retained. Equivalent allocation-free ASCII and surrogate checks replace the original regular expression and ES2024 string helper for the repository lint and ES2023 type target. It is not an Apple or Appium implementation copy.

`inspector-endpoint-receipt.ts` adapts the same original diagnostic family's `bun-inspector-native-helper/adapter/receipt.ts`. It retains exact receipt validation and removes control-mode parsing and the hard-coded device. The sole SafariDriver supplies the selected Simulator ID.

`inspector-stream.ts`, `safari-observer.ts`, `inspector-endpoint.ts`, and `browser-observation.ts` are original adapters. WIR selectors, sender/destination keys and target wrappers follow Appium `appium-remote-debugger` revision `cb98aa8766f71a9baed712ee21e6779d8a812b4e`, `lib/rpc/remote-messages.ts` and `lib/rpc/rpc-message-handler.ts`. Domain events follow WebKit revision `4c54bb31e84b34d1ea49748e55bcdbad1499629a`, `Source/JavaScriptCore/inspector/protocol/Worker.json`, `Network.json`, and `InspectorWorkerAgent.cpp`. These are protocol references, not copied implementations or a claim about installed Safari.

The local transport owns actual writes and both inner and outer Target replies through `HostConsumers`. Missing or refused replies fail command settlement, including startup continuation and shutdown. Boundary-aligned EOF is accepted only during owned socket close; unexpected or truncated EOF remains loss. It reduces events before completing a later received reply. It does not use the old diagnostic controller, pause-on-start, Automation, Inspector application execution, cache mutation, or a second WebDriver session. Worker enable's startup wait is released only by the promptly owned `Worker.initialized` handshake. Native endpoint discovery requires an explicit receipt and existing read-only helper path. The adapter invokes that helper for fresh exact-device metadata, compares the live boot/process/socket binding with the receipt and checks the current socket node. It does not scan private profiles or bundle a helper binary. Exact installed event coverage and ordering against WebDriver completion remain unproved until real execution.

The peer-close boundary in `host-drive.ts` and `browser-observation.ts` is an original adapter.
It follows playwright-core 1.64.1, resolved by `bun.lock`: server `Page` close awaits page
closure in `packages/playwright-core/src/server/page.ts`; WebKit `WKPage.closePage` and
`WKBrowser._onPageProxyDestroyed` calling `WKPage.didClose` in `server/webkit/wkPage.ts`
and `wkBrowser.ts` involve no all-Worker termination join. The cached `lib/coreBundle.js`
SHA-256 is `829521b67ed7be90c7d6d6098ff39f2241562d47e4ad7ccab13710924a56001d`.
These are behavior references. No implementation is copied, and they establish no Safari
Worker termination or physical thread-death proof.

## Binaryen runtime helpers

`browser/net/network.buffer.js` derives from owned Rust plus runtime helper implementation emitted by Binaryen [src/wasm2js.h](https://github.com/WebAssembly/binaryen/blob/version_132/src/wasm2js.h) and [src/tools/wasm2js.cpp](https://github.com/WebAssembly/binaryen/blob/version_132/src/tools/wasm2js.cpp) at `version_132`. This is a generated derivation, separate from Waffle's original loader/ABI adapter. The canonical npm package is `binaryen@132.0.0`, integrity and executable digest pinned in `tooling/network-translator.ts` and the isolated tool lockfile. Bun invokes it explicitly. The native Binaryen 133 program optimizer is unrelated.

The producer adds only a fixed attribution/input-SHA header and `export` before the generated factory. It changes no helper implementation or Wasm bytes. The generated header retains Copyright 2015 WebAssembly Community Group participants from both upstream source headers. It names Binaryen, version and Apache-2.0, pointing to the shipped `LICENSES/Apache-2.0.txt`. The selected npm payload contains an Apache-2.0 LICENSE and no NOTICE file. Provision verification checks that condition and fails for a new NOTICE or license mismatch, requiring an attribution audit. Source and dist copies retain the generated header and license in the prepared archive.

### Ordinary page console observation

`tests/page-runner/console-observation.ts`, `safari-console.ts`, and
`playwright-observer.ts` are original adapters. The Console domain and direct-worker
forwarding use WebKit revision `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`,
`Source/JavaScriptCore/inspector/protocol/Console.json`,
`Source/JavaScriptCore/inspector/agents/InspectorConsoleAgent.cpp`, and
`Source/WebCore/inspector/agents/InspectorWorkerAgent.cpp` as protocol references.
Classification follows the original oracle's Playwright 1.64.1 behavior in
`packages/playwright-core/src/server/webkit/wkPage.ts` and `wkWorkers.ts`.
Page JavaScript errors preserve the pageerror classification. Other errors use the
console type mapping, including direct-worker messages. Optional protocol fields
remain optional. No upstream implementation is copied.

The observer records one bounded error and any observation loss. It sends worker
Console enable before the existing initialization handshake, without awaiting the
worker reply. Its final page reply freezes the observed stream synchronously. This
does not drain independent worker channels. The console controls qualify routing
and short worker lifetimes separately; protocol source alone does not establish
native Safari support or desktop parity. Guest code is not instrumented.
