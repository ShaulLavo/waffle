# Waffle source provenance

Waffle owns the reusable browser runtime extracted from bun-wasm. This ledger records copied or adapted implementation that ships in this repository; Bun engine, guest, native binding and application adapter provenance remains in bun-wasm.

| Source                                                                                          | Class            | Revision and local change                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`, `fs/`, `proc/`, `interrupt/`                                                           | Original adapter | Browser/WASI runtime services developed in bun-wasm through the frozen extraction revision. The current tree is TypeScript source; `dist/` is generated during `prepare` and is never tracked.                                                                                                                                               |
| `browser/net/`                                                                                  | Original adapter | Generic ring, HTTP framing, fetch and host transport. Fetch and listener policy are injected by the consumer; Bun install/cache policy is not part of Waffle.                                                                                                                                                                                |
| `browser/process-broker.ts`, `browser/worker.ts`                                                | Original adapter | Generic process admission, typed startup outcomes, descriptor transport, worker bootstrap and lifecycle fences. Guest engines and native slots remain application-owned.                                                                                                                                                                     |
| `proc/worker-broker.ts`, `proc/filesystem-codec.ts`, `browser/process-broker.ts`                | Original adapter | Queued PID/directory ownership, acquired directory/slot/PID lifetimes, metadata-independent token discard and retained rejection fences, based on Waffle `15ba700`.                                                                                                                                                                          |
| `fs/opfs.ts`                                                                                    | Adaptation       | The sync-access retry constants and retry loop are adapted from SLICC-kernel `src/fs/opfs.ts` at revision `88c5bb3` (Apache-2.0); Waffle's snapshot, payload, quota implementation, queued lock ownership/cancellation and optional startup lock milestones are original. Attribution is in the source header and `LICENSES/Apache-2.0.txt`. |
| `fs/indexeddb.ts`, `browser/shared-fs.ts`, `runtime.ts`                                         | Original adapter | Extend the existing startup abort/disposal handshake to every persistent open, including IndexedDB takeover; fence consumers before cleanup, abandon an unresolved database open, close late successes and abort in-flight epoch allocation without publishing ownership.                                                                    |
| `fs/vfs.ts`, `browser/{shared-fs,fs-worker}.ts`, `fs/{service,indexeddb,opfs}.ts`, `runtime.ts` | Original adapter | FAST/SAFE mode selection, descriptors, persisted format identities and typed startup diagnostics; existing payload layouts, locks and checkpoint algorithms remain unchanged.                                                                                                                                                                |
| `core/memory-views.js`                                                                          | Original adapter | Resizable-memory view helpers retained as source JavaScript because the runtime ABI requires their exact view identity.                                                                                                                                                                                                                      |
| `patches/wasi-libc/preopen-scan.patch`                                                          | Adaptation       | The `__wasilibc_populate_preopens` scan is adapted from wasi-libc `libc-bottom-half/sources/preopens.c` at revision `2e6fb9d8ee0c` (the wasi-sdk 34 source). When `fd_prestat_get` returns `BADF`, the patch probes `fd_fdstat_get` so open inherited descriptors are skipped while the first truly empty descriptor still ends the scan.    |

## Process admission ownership

`proc/worker-broker.ts`, `proc/filesystem-codec.ts` and `browser/process-broker.ts`
are original Waffle adapters, based on Waffle revision
`15ba700268b6199e22ef61aa0d9464798c0d9562`. This change separates queued ownership
from supervisor records, gives rejection cleanup a codec-independent discard
capability, and retains external rejection fences through quiescence and disposal.
Acquired consumers bind to the directory, slot and monotonic PID at registration or
supervisor admission. Controllers registered before publication bind through this
broker's root directory before rejection cleanup. Payload and acquired-controller
filesystem fences both precede confirmation. Sender-validation failure starts cleanup
for the incoming transfer before propagating the error.
A cleanup-only filesystem codec can release shared reservation tokens without a
process identity; importing still requires an identity. No upstream implementation
was copied or adapted, and no filesystem storage implementation changed.

## Patched wasi-libc preopen scan

`patches/wasi-libc/preopen-scan.patch` applies to wasi-libc `libc-bottom-half/sources/preopens.c` at revision `2e6fb9d8ee0c`, the source revision recorded by wasi-sdk 34. The adapted branch handles an open non-preopen descriptor in the fd-3 scan: `fd_fdstat_get` success continues to the next descriptor, `BADF` ends discovery at the first empty slot, and every other error follows the existing error path. `scripts/build-wasi-libc.sh` downloads that exact revision, applies this patch, and builds a `wasm32-wasip1` sysroot with wasi-sdk 34. Consumers must use the resulting sysroot and pin the matching Waffle commit; Waffle does not provide a compatibility path for an unpatched libc scan.

## SLICC-kernel Apache-2.0 notice

The sync-access retry fragment in `fs/opfs.ts` is adapted from SLICC-kernel `src/fs/opfs.ts`, revision `88c5bb3`, licensed under the Apache License, Version 2.0. The complete license text is shipped at `LICENSES/Apache-2.0.txt`; the source header identifies the adapted fragment. No SLICC source is generated at build time.

## Extraction provenance

The history-preserving filter-repo commit map is kept outside the published tree with the cutover evidence. The extracted repository retains the rewritten commit history, including predecessor paths for the WASI shim, filesystem scaffold and memory views.

## Typed process startup failures

The original adapters in `proc/{types,outcome,wait-status,supervisor,abi,worker-client,worker-broker}.ts`
and `browser/{process-broker,worker}.ts` port the generic part of
[bun-wasm PR #65](https://github.com/ShaulLavo/bun-wasm/pull/65), reviewed at
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
or changing storage policy. The SLICC-kernel retry fragment in `fs/opfs.ts` remains
unchanged; the new lock milestones are outside that adapted fragment. See
[runtime-startup.md](runtime-startup.md) for the clock and stage boundaries.

## Filesystem ownership policy

The queued ownership requests, `whenBusy` settings, lifecycle state and abort/disposal
handshake in `fs/{opfs,indexeddb,service}.ts`, `browser/{shared-fs,fs-worker}.ts` and
`runtime.ts` are original Waffle adapters. They change only original ownership glue;
the SLICC-kernel sync-handle retry fragment at revision `88c5bb3` is unchanged. Storage
setup occurs under its lock, and cancellation closes acquired resources before releasing
that ownership. Pending IndexedDB opens now observe the same startup signal under both busy policies; cancellation acknowledges cleanup without waiting for the browser open and closes any late database success before ownership acquisition. No new upstream implementation was copied.

## Quality-gate adoption

`core/memory-views.js` remains an original Waffle adapter. Its JSDoc now checks the
cache and view signatures; fallback views initialize eagerly, and both branches
construct the same bounded-range method. View identity and refresh semantics are
unchanged. The original storage glue in `fs/opfs.ts` now validates storage presence
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
`src/fs/opfs.ts` at `88c5bb3` (Apache-2.0); that fragment is unchanged. No upstream
code was copied for this revision. Format-marker adoption is original Waffle glue,
not a new storage engine or an automatic implementation migration.
