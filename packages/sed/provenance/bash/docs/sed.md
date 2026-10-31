# sed

`bash-web/utilities/sed` installs uutils sed as a separate ordinary WASI program on the caller's Waffle runtime. The shell core does not include sed or its regular-expression dependencies.

## Install and build

```ts
import { installSed } from "bash-web/utilities/sed";

const sed = await installSed(runtime, {
  wasmUrl: new URL("./sed.wasm", import.meta.url),
  workerUrl: new URL("./shell-worker.js", import.meta.url),
});
```

The runtime is the same instance passed to `createShell`. The installer registers `/bin/sed`. Put `/bin` on `PATH`. Installation does not fetch sed. Waffle loads and instruments its source bytes at the first spawn, then reuses the admitted program.

The default executable URL is the package's `dist/sed.wasm`. Bundlers can supply `wasmUrl` explicitly, or supply `source` as a `Uint8Array` or an async bytes loader instead. `source` and `wasmUrl` are mutually exclusive. Ordinary WASI guests do not accept precompiled modules or a cooperative-execution flag. Dispose the installation after its processes stop, or dispose the caller's runtime.

`npm run build:sed` produces `dist/sed.wasm` and the demo copy under `public/programs/`. It uses the existing WASI workspace build, patched Waffle libc, locked dependencies, and a 256 MiB maximum guest memory. `build:utilities`, CI artifact receipts, and final package assembly include the separate executable. `npm run test:installed-sed` packs the package and runs its public entry in Chromium on real Waffle.

## Supported scope

The pinned upstream parser, regular expressions, incremental input reader, and processor provide substitutions, addresses and ranges, BRE captures and backreferences, `-E` extended expressions, script files, stdin, and named files. No whole-stream buffering or replacement sed implementation is added here. Ordinary stdio works through Waffle unchanged. `-u` requests output flushing after each input cycle for interactive streams. Byte mode preserves NUL bytes, non-UTF-8 bytes, and a missing final newline.

Waffle owns cancellation, pipes, descriptors, and filesystem access. Guest memory has a hard maximum, not a promise that an arbitrarily large pattern or hold space fits. Commands that accumulate input can exhaust that limit. Pipe backpressure bounds bytes in transit. Dispose stopped shells to release their worker and pipe records.

## Deliberate restrictions

The WASI guest rejects the `e` command and the `s///e` flag during upstream script compilation. It never invokes a host shell. Named `w` outputs open only after the entire script compiles, so an unsupported execution command later in a script cannot truncate an earlier output. Valid scripts still create and truncate their named outputs before processing input, including outputs whose addresses never match.

All in-place forms are rejected before script compilation, including `-i`, attached backup suffixes, clustered options, and `--in-place`. No backup or replacement file is created. To update a file, redirect to a **different** path, check the result, and replace it through the embedding application's filesystem API. Never redirect sed output onto its input path.

This is a bounded upstream integration, not a claim of complete GNU sed compatibility. Native builds retain upstream execution and in-place behavior. Browser guarantees are limited to the WASI guest and the checked cases.

## Source and license

The vendored source is uutils/sed at `301a2b7ca14e62c687cc4904798d5c72a54ade8f`, licensed under MIT. `third-party/uutils-sed/provenance.json` records the source archive digest, original source hashes, and shipped hashes. `wasi.patch` contains every source delta. The minimal package manifest removes upstream development tools and gates Unix-only dependencies. It does not replace the parser or processor.

The source check rejects changed or additional Rust files. Its test reverses the patch and verifies every original source hash without a network fetch. Vendored upstream code is outside the authored-code lint and duplicate scans. Generated package notices include its license and dependency licenses.
