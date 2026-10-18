# Waffle source provenance

Waffle owns the reusable browser runtime extracted from bun-wasm. This ledger records copied or adapted implementation that ships in this repository; Bun engine, guest, native binding and application adapter provenance remains in bun-wasm.

| Source | Class | Revision and local change |
| --- | --- | --- |
| `core/`, `fs/`, `proc/`, `interrupt/` | Original adapter | Browser/WASI runtime services developed in bun-wasm through the frozen extraction revision. The current tree is TypeScript source; `dist/` is generated during `prepare` and is never tracked. |
| `browser/net/` | Original adapter | Generic ring, HTTP framing, fetch and host transport. Fetch and listener policy are injected by the consumer; Bun install/cache policy is not part of Waffle. |
| `browser/process-broker.ts`, `browser/worker.ts` | Original adapter | Generic process admission, typed startup outcomes, descriptor transport, worker bootstrap and lifecycle fences. Guest engines and native slots remain application-owned. |
| `fs/opfs.ts` | Adaptation | The sync-access retry constants and retry loop are adapted from SLICC-kernel `src/fs/opfs.ts` at revision `88c5bb3` (Apache-2.0); Waffle's snapshot, payload, quota implementation and optional startup lock milestones are original. Attribution is in the source header and `LICENSES/Apache-2.0.txt`. |
| `core/memory-views.js` | Original adapter | Resizable-memory view helpers retained as source JavaScript because the runtime ABI requires their exact view identity. |

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

| Source | Class | Revision and local change |
| --- | --- | --- |
| `site/src/components/Landing.astro`, `site/src/scripts/landing.ts` | Adaptation | Owner-supplied `waffle-website.html`, SHA-256 `f845e81ca6cf60d3f832f88b48f4ceaf0a646c0237fe0f0dedfa31c680774383` (2026-10-18). The real landing page is extracted from the first nested bundle; its markup, copy, links and rendering formulas are ported to static Astro and vanilla TypeScript. The design-canvas wrapper, preview boards, decompression loader, React and custom component runtime are omitted. |
| `site/src/scripts/waffle-scene.ts` | Adaptation | The same owner-supplied page's embedded `Waffle scene v2` implementation, asset UUID `10822c92-f196-44df-9869-57b07f16162b`. Scene geometry, shader math and interactions are retained; the global three.js r158 reference becomes named imports from the pinned `three@0.158.0` package and the source is a TypeScript module. Scene loading is deferred until after the first page paint. |
| `site/scripts/*.ts`, optional bundle-analysis hook in `site/astro.config.ts` | Original adapter | Reference extraction, deterministic visual/native-visibility checks, performance diagnostics and bundle inspection written for this conversion. They do not ship the original bundler or React/DC runtime. |
| `site/public/assets/THREE-LICENSE.txt` | Unchanged copy | `three@0.158.0` npm package `LICENSE`, upstream `mrdoob/three.js` tag `r158`. Full MIT copyright and permission notice retained separately from the minified runtime bundle; no text changes. |
| `site/src/assets/*.woff2` | Unchanged copy | The owner's embedded Google Fonts latin subsets: Bricolage Grotesque v9, Fredoka v17 and Martian Mono v6. Bytes are unchanged, emitted through Astro with content hashes, and the full font notices from the supplied document are preserved in `site/public/assets/FONTS-LICENSE.txt`. Unused remote unicode subsets are omitted. |

## Three.js license notice

`site/public/assets/THREE-LICENSE.txt` is an unchanged copy of `LICENSE` from the pinned `three@0.158.0` npm package (upstream `mrdoob/three.js`, tag `r158`). It accompanies the bundled Three.js implementation because minification removes the module's short license header. The notice is published as a separate text asset without adding a runtime request.

The supplied page has no bitmap images or video: its visuals are inline SVG, CSS and procedural WebGL. There are therefore no image transcoding changes. The original placeholder links and `© [YEAR]` text remain intentionally unchanged for exact reference parity.

## Filesystem startup observation

`fs/startup.ts` and the hooks in `runtime.ts`, `browser/{shared-fs,fs-worker}.ts`,
`fs/{service,indexeddb,opfs}.ts` are original Waffle adapters. They report fixed
startup stages around existing operations without copying upstream implementation
or changing storage policy. The SLICC-kernel retry fragment in `fs/opfs.ts` remains
unchanged; the new lock milestones are outside that adapted fragment. See
[runtime-startup.md](runtime-startup.md) for the clock and stage boundaries.
