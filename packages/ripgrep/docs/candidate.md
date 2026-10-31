# Ripgrep source candidate

The actual maintained family payload is its pinned archive/build recipe, WASI patch, source helper, notice generator, fixtures and tests. The generated upstream source tree and binaries are deliberately absent. The archive commit/hash and patch/helper recipe digest are in `build-recipe.json`; the complete original build recipe is byte-identical under `provenance/bash/scripts/build-rg.ts`.

Run the existing source checks from the candidate root:

```sh
node --test packages/ripgrep/scripts/test-rg-source.ts
```

`node packages/ripgrep/scripts/test-rg-wasi.ts --native /absolute/path/to/rg` retains the existing optional native-oracle route. It tests the supplied executable, not the candidate's unbuilt WASI guest. The no-argument WASI mode needs the future generated `dist/rg.wasm` and Wasmtime; it was not run here. Historical Chromium/Firefox shell integration remains unchanged under `provenance/bash/tests/rg.spec.ts` and needs the real shared fixture/installer composition.

The pinned guest remains single-threaded, without mmap or PCRE2. Unsupported execution/archive/hostname options keep their status-2 behavior. The same `--no-default-features`, target, memory cap, patched-libc and final-verifier recipe must survive integration.

`LICENSE.integration` is the original integration/test code's MIT license. Upstream ripgrep is MIT OR Unlicense; its complete texts and locked dependency notices must be collected from the verified archive by `scripts/rg-notices.ts` during the eventual real build. This source-only candidate has no generated upstream license/notices bundle. No installer, adapter, worker or runtime is included.
