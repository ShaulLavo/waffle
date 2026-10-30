# awk compatibility

This package runs the pinned 20260426 release of The One True Awk. It is not a handwritten evaluator or a translation into TypeScript. The bounded fixture corpus covers the common agent workflows of field selection, `FS` and `OFS`, patterns and actions, `BEGIN` and `END`, `NR` and `NF`, stdin and file arguments, `-F` and `-v`, arithmetic, formatting, associative arrays, substitutions, regular expressions, multi-file iteration, exit statuses, and diagnostics.

The native oracle is compiled from this same source archive and patch, with the WASI-only guards inactive. It does not invoke system `awk`, `gawk`, `mawk`, or another host implementation. Oracle observations are committed as fixture data and are compared with the actual Wasm guest under Wasmtime. The enabled Waffle acceptance suite also checks the generated guest through the real runtime. The normal `programs:awk` command runs native, Wasmtime and merged-source runtime checks before package archive readback.

## Guest behavior checked with Wasmtime

- Standard onetrue-awk program evaluation, including records, fields, variables, arrays, functions, arithmetic, formatting, regular expressions, `sub` and `gsub`, stdin, and named files.
- `-F`, `-v`, `-f`, and `--version` as provided by the upstream CLI. Upstream also supports `--`; the fixture corpus does not explicitly cover it.
- Preview 1 stdin and file descriptors.

The Waffle suite checks `/usr/bin/awk` and `/bin/awk` as aliases of one lazy program payload. It checks zero-fetch registration, one payload fetch across all fixtures, caller-owned filesystem and process-service reuse, replacement-file preservation and runtime ownership. Removal waits for physical guest stop. The nonterminating guest returns `{ kind: "signaled", code: 2, status: 130 }` after SIGINT.

## Runtime limits

- `system()` and input or output command pipes are rejected with a nonzero diagnostic. Waffle does not provide host process operations, and these features must not become simulated success.
- Host-specific locale, clock, signal, and filesystem behavior follows the WASI runtime rather than a native Unix process.
- The corpus is evidence for the covered behavior, not a claim of complete POSIX or GNU awk parity.
- Every native oracle process has a 15-second maximum deadline. The Waffle acceptance suite bounds its nonterminating control with an interrupt and a 5-second assertion window.

## Source and qualification identity

The upstream evaluator uses `setjmp` and `longjmp` for nonlocal `exit`, including exits from expressions in nested functions and `END`. The package preserves that behavior with wasi-sdk 34's `-mllvm -wasm-enable-sjlj`, standard exception handling via `-mllvm -wasm-use-legacy-eh=false`, and the shared sysroot's `-lsetjmp`.

Runtime PR 254 admits the real standard-EH guest through ordinary source rewriting. Optimizer PR 268 enables standard exception handling in pinned Binaryen 133 and advances the strict finalization policy to `waffle-program-size-v2`. The producer uses the normal `stageProgram` route and declares its derivation, gzip and Brotli outputs. Old policies, flags and transformation-source identities are rejected. Historical derivatives remain historical evidence and must not be relabeled.

Each production run must bind its receipts to the committed source that actually produced the bytes. Qualification covers all 43 committed native observations, three capability refusals, and the original infinite-loop interrupt and physical-stop removal controls. Installed-package checks must consume the actual archive and the matching merged-source runtime. Runtime 0.0.105 predates this exception-handling source, so merged-source qualification does not establish conformance with that published runtime or any consumer pin. No cooperative declaration, source admission bypass or second runtime is part of this package.
