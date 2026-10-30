# Waffle source provenance

Waffle owns the reusable browser runtime extracted from bun-wasm. This ledger records copied or adapted implementation that ships in this repository; Bun engine, guest and application adapter provenance remains in bun-wasm. The low-level socket adapter is now Waffle-owned.

| Source                                                                                                                                | Class            | Revision and local change                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`, `fs/`, `proc/`, `interrupt/`                                                                                                 | Original adapter | Browser/WASI runtime services developed in bun-wasm through the frozen extraction revision. The current tree is TypeScript source; `dist/` is generated during `prepare` and is never tracked.                                                                                                                                                                                                                               |
| `browser/net/`                                                                                                                        | Original adapter | Generic ring, HTTP framing, fetch and host transport, including the runtime-scoped loopback namespace and per-helper socket ownership. Fetch and listener policy are injected by the consumer; Bun install/cache policy is not part of Waffle.                                                                                                                                                                               |
| `browser/process-broker.ts`, `browser/worker.ts`                                                                                      | Original adapter | Generic process admission, typed startup outcomes, descriptor transport, worker bootstrap and lifecycle fences. Guest engines and native slots remain application-owned.                                                                                                                                                                                                                                                     |
| `group/`, memory-group sections of `browser/{process-broker,worker}.ts`, `proc/abi.ts`, `link/{group,metadata,plan}.ts`               | Original adapter | Memory groups, written for Engines J1 on Waffle `63ddc5d`, 2026-10-29: page-side group owner, transit pins, `runtime_shm` imports, FUTEX watches and PIE member images. No upstream source copied. See [Memory group sources](#memory-group-sources).                                                                                                                                                                        |
| `tests/fixtures/memory-group-member.c`                                                                                                | Adaptation       | The Engines shared-memory design prototype `member.c` (original Engines code, 2026-10-29, not published elsewhere). Its statics, data relocation, function-pointer table, stack probe, heap churn and atomics are kept; its heap now grows through `runtime_shm.group_grow` and a page-driven command loop replaces the Node host script.                                                                                    |
| `proc/node-wasi.ts`                                                                                                                   | Adaptation       | bun-wasm `web/scripts/node-process.ts:188-397` at `c16ff39435cc33465b999ea06c1ee9d20b952354`; descriptor namespace, Node WASI translation, file/pipe routing and mixed polling moved without behavior redesign. Waffle-relative imports and explicit `NodeWasi*` names are local changes. Bun retains process policy, signal exit, worker controls, engine/native stdio, JSON and host APIs.                                 |
| `proc/worker-broker.ts`, `proc/filesystem-codec.ts`, `browser/process-broker.ts`                                                      | Original adapter | Queued PID/directory ownership, acquired directory/slot/PID lifetimes, metadata-independent token discard and retained rejection fences, based on Waffle `15ba700`.                                                                                                                                                                                                                                                          |
| `fs/opfs.ts`                                                                                                                          | Adaptation       | The sync-access retry constants and retry loop are adapted from SLICC-kernel `src/fs/opfs.ts` at revision `88c5bb3` (Apache-2.0); Waffle's snapshot, payload, quota, queued lock ownership, startup milestones, failed-close ownership, acquisition registration, bounded range reads and pre-attempt cancellation/failed-owner guards are original glue. Attribution is in the source header and `LICENSES/Apache-2.0.txt`. |
| `tests/opfs-close{,-browser-observer}.test.ts`, `tests/opfs-close-browser{,-runner}.ts`, `tests/fixtures/opfs-close-{page,worker}.ts` | Original adapter | Waffle failed-close source controls and original-native-object browser observations. Test-only interception and labelled pre-physical-close injection; no upstream source copied.                                                                                                                                                                                                                                            |
| `fs/indexeddb.ts`, `browser/shared-fs.ts`, `runtime.ts`                                                                               | Original adapter | Extend the existing startup abort/disposal handshake to every persistent open, including IndexedDB takeover; fence consumers before cleanup, abandon an unresolved database open, close late successes and abort in-flight epoch allocation without publishing ownership.                                                                                                                                                    |
| `fs/vfs.ts`, `browser/{shared-fs,fs-worker}.ts`, `fs/{service,indexeddb,opfs}.ts`, `runtime.ts`                                       | Original adapter | FAST/SAFE mode selection, descriptors, persisted format identities and typed startup diagnostics; existing payload layouts, locks and checkpoint algorithms remain unchanged.                                                                                                                                                                                                                                                |
| `browser/shared-fs.ts`, `fs/{service,persistent}.ts`                                                                                  | Original adapter | Ordinary ready disposal and terminal backend shutdown ownership, integrated from Waffle `e7d4e35` and `6a979e0` onto `93698f1`. Retain the original ACK, section/work joins and failed cleanup reasons; no upstream implementation copied.                                                                                                                                                                                   |
| Inode permission query and enforcement                                                                                                | Original adapter | Original Waffle code, 2026-10-21; stored owner read/write, directory search/sticky, shared direct I/O checks and explicit saved-metadata adoption. No upstream source copied.                                                                                                                                                                                                                                                |
| `core/memory-views.ts`                                                                                                                | Original adapter | Resizable-memory view helpers with exported TypeScript types; emitted JavaScript retains the runtime ABI's exact view identity.                                                                                                                                                                                                                                                                                              |
| `patches/wasi-libc/preopen-scan.patch`                                                                                                | Adaptation       | The `__wasilibc_populate_preopens` scan is adapted from wasi-libc `libc-bottom-half/sources/preopens.c` at revision `2e6fb9d8ee0c` (the wasi-sdk 34 source). When `fd_prestat_get` returns `BADF`, the patch probes `fd_fdstat_get` so open inherited descriptors are skipped while the first truly empty descriptor still ends the scan.                                                                                    |
| `network/src/{lib,queue,native}.rs`, `network/tests/`                                                                                 | Adaptation       | bun-wasm PR116 `crates/bunwasm-host/src/net/{tcp,mod}.rs` at `4a734933901f5ff4c403925d1589afc2a4ce2e71`; retain dual-stack bind, fallback, byte queue, graceful output drain, FIN completion and input discard; replace native threads with bounded progress turns and interruptible Unix wait-many.                                                                                                                         |
| `network/src/{abi,module,virtual_net}.rs`, `browser/net/module.ts`                                                                    | Original adapter | Waffle binary ABI, virtual-only namespace, explicit loader and per-runtime module ownership. No Bun API facade copied.                                                                                                                                                                                                                                                                                                       |
| `tools/licenses/`                                                                                                                     | License copy     | Exact upstream MIT license texts for fluent-langneg 0.13.1 and intl_pluralrules 7.0.2, omitted from their registry archives. Source commits and SHA-256 records accompany the texts.                                                                                                                                                                                                                                         |
| `packages/findutils/vendor/uutils-xargs/src/lib.rs`                                                                                   | Adaptation       | uutils/findutils `src/xargs/mod.rs` at `505421d4e03586efeb7b9c55adf057599e192e0a`; original Waffle process-consumer adapter, owned EOF stdin, child status mapping, empty byte-delimited items and explicit unsupported-mode checks.                                                                                                                                                                                         |
| `packages/coreutils/crates/echo/`                                                                                                     | Original adapter | Calls unchanged uutils/coreutils `src/uu/echo` at `07763857f6b9a547742a994b58aef0ccd036198b`; isolated entry and actual WASI write-failure observation, without flag/output logic.                                                                                                                                                                                                                                           |
| `tools/program-locales/patch.ts`                                                                                                      | Adaptation       | Transforms only the hash-pinned uutils/coreutils `src/uucore/build.rs` at `dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69` and `07763857f6b9a547742a994b58aef0ccd036198b`. Retains target aliases and replaces catalog discovery with explicit English inputs.                                                                                                                                                                     |
| `tools/program-locales/{prepare,selection,rustc-wrapper,build}.ts`, `generate.rs`                                                     | Original adapter | Build-source selection, isolated producer identity, compiler pass-through, transaction lock, catalog generation and receipts. No runtime or command implementation copied.                                                                                                                                                                                                                                                   |
| `packages/diffutils/patches/gnu-wasi.patch`                                                                                           | Adaptation       | GNU diffutils 3.12 release sources; bounded WASI changes disable unsupported process, signal, timezone and locale recovery APIs. See [GNU diffutils](#gnu-diffutils).                                                                                                                                                                                                                                                        |
| `packages/coreutils/src/bin/nl.rs`, `packages/coreutils/src/bin/nl_bre/` | Original adapter | Calls unchanged uutils/coreutils `src/uu/nl` and `src/uucore` at `07763857f6b9a547742a994b58aef0ccd036198b`. Initializes WASI cwd and translates bounded common BRE styles into upstream's byte regex grammar; no command algorithm copied. See [External nl entry](#external-nl-entry). |
| `packages/jq/patches/jaq-wasi.patch`, `packages/jq/scripts/` | Adaptation | jaq 3.1.2 at `f7fea9219d8d5364c91c6a0278765eaa0e6fa95e`; target-gate rustyline and the interactive `repl` off WASI. Original Waffle recipe preserves the upstream evaluator and noninteractive CLI, disables mimalloc, and adds packaging, notices, native jq oracle and runtime tests. |
| `tools/program-build-tools.ts`                                                                                                        | Original adapter | WASI build/verifier helper extracted from bash-web `9ef027d7` scripts `wasi-build.ts` and `verify-wasi-guests.ts`. Waffle adds verified optimization and bounded final-program name stripping with original optimizer/derivation adapters; no external Wasm parser is copied.                                                                                                                                                                                                              |

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

| Source                                                                       | Class            | Revision and local change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site/src/components/Landing.astro`, `site/src/scripts/landing.ts`           | Adaptation       | Owner-supplied `waffle-website.html`, SHA-256 `f845e81ca6cf60d3f832f88b48f4ceaf0a646c0237fe0f0dedfa31c680774383` (2026-10-18). The real landing page is extracted from the first nested bundle; its markup, copy and rendering formulas are ported to static Astro and vanilla TypeScript. Placeholder links now point to real documentation, repositories and the verified Bun demo; action labels and documentation captions describe those destinations and the copyright year is 2026. The design-canvas wrapper, preview boards, decompression loader, React and custom component runtime are omitted. |
| `site/src/scripts/waffle-scene.ts`                                           | Adaptation       | The same owner-supplied page's embedded `Waffle scene v2` implementation, asset UUID `10822c92-f196-44df-9869-57b07f16162b`. Scene geometry, shader math and interactions are retained; the global three.js r158 reference becomes named imports from the pinned `three@0.158.0` package and the source is a TypeScript module. Scene loading is deferred until after the first page paint.                                                                                                                                                                                                                 |
| `site/scripts/*.ts`, optional bundle-analysis hook in `site/astro.config.ts` | Original adapter | Reference extraction, deterministic visual/native-visibility checks, performance diagnostics and bundle inspection written for this conversion. They do not ship the original bundler or React/DC runtime.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `site/public/assets/THREE-LICENSE.txt`                                       | Unchanged copy   | `three@0.158.0` npm package `LICENSE`, upstream `mrdoob/three.js` tag `r158`. Full MIT copyright and permission notice retained separately from the minified runtime bundle; no text changes.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `site/src/assets/*.woff2`                                                    | Unchanged copy   | The owner's embedded Google Fonts latin subsets: Bricolage Grotesque v9, Fredoka v17 and Martian Mono v6. Bytes are unchanged, emitted through Astro with content hashes, and the full font notices from the supplied document are preserved in `site/public/assets/FONTS-LICENSE.txt`. Unused remote unicode subsets are omitted.                                                                                                                                                                                                                                                                          |

## Three.js license notice

`site/public/assets/THREE-LICENSE.txt` is an unchanged copy of `LICENSE` from the pinned `three@0.158.0` npm package (upstream `mrdoob/three.js`, tag `r158`). It accompanies the bundled Three.js implementation because minification removes the module's short license header. The notice is published as a separate text asset without adding a runtime request.

The supplied page has no bitmap images or video: its visuals are inline SVG, CSS and procedural WebGL. There are therefore no image transcoding changes. The published page replaces the original placeholder links with Waffle's GitHub repository and documentation, the Bash Web repository, and the verified `https://bun.sprockt.dev/` demo. The action labels now read “Explore Bash Web” and “Try Bun in the browser”, and the launch description distinguishes source from the live demo. Two documentation captions now describe the getting-started page and host ABI accurately, and the footer reads `© 2026 Waffle`. These are intentional publishing corrections, not changes to the supplied layout or rendering formulas. The parity checker applies only these exact corrections to the original reference before comparing text, links and pixels.

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
The fragment now also contains the original failed-close guards described below. Storage
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

The memory group owner, member imports and broker integration are original Waffle code. The Chromium fixture image is adapted from the Engines track's shared-memory prototype, which proved that one PIE image instantiates into one shared `WebAssembly.Memory` at several bases. The adaptation replaces `memory.grow` with `runtime_shm.group_grow`, adds `runtime_shm` region and futex calls, and runs a command loop that the test page drives through the member's own statics.

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
`scripts/wasi-build.ts` and `scripts/verify-wasi-guests.ts`. Its original byte reader
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
