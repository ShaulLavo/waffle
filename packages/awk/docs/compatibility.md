# awk compatibility

This package runs the pinned 20260426 release of The One True Awk. It is not a handwritten evaluator or a translation into TypeScript. The bounded fixture corpus covers the common agent workflows of field selection, `FS` and `OFS`, patterns and actions, `BEGIN` and `END`, `NR` and `NF`, stdin and file arguments, `-F` and `-v`, arithmetic, formatting, associative arrays, substitutions, regular expressions, multi-file iteration, exit statuses, and diagnostics.

The native oracle is compiled from this same source archive and patch, with the WASI-only guards inactive. It does not invoke system `awk`, `gawk`, `mawk`, or another host implementation. Oracle observations are committed as fixture data and are compared with the actual Wasm guest under Wasmtime. The Waffle runtime acceptance test is present but currently blocked by the runtime prerequisite below.

## Guest behavior checked with Wasmtime

- Standard onetrue-awk program evaluation, including records, fields, variables, arrays, functions, arithmetic, formatting, regular expressions, `sub` and `gsub`, stdin, and named files.
- `-F`, `-v`, `-f`, `--`, and `--version` as provided by the upstream CLI.
- Preview 1 stdin and file descriptors. The Waffle-specific execution path remains blocked as described below.
- `/usr/bin/awk` and `/bin/awk` as aliases of one lazy program payload.

## Runtime limits

- `system()` and input or output command pipes are rejected with a nonzero diagnostic. Waffle does not provide host process operations, and these features must not become simulated success.
- Host-specific locale, clock, signal, and filesystem behavior follows the WASI runtime rather than a native Unix process.
- The corpus is evidence for the covered behavior, not a claim of complete POSIX or GNU awk parity.
- Every native oracle process has a 15-second maximum deadline. The Waffle acceptance suite bounds its nonterminating control with an interrupt and a 5-second assertion window.

## Waffle admission prerequisite

The upstream evaluator uses `setjmp` and `longjmp` for nonlocal `exit`, including exits from expressions in nested functions and `END`. The package preserves that behavior with wasi-sdk 34's `-mllvm -wasm-enable-sjlj`, standard exception handling via `-mllvm -wasm-use-legacy-eh=false`, and the shared sysroot's `-lsetjmp`.

Accepted Waffle main at `620da8002cf2dab88862a0a503e228413b52603a` rejects the guest's exception tag section with `Cannot instrument WebAssembly: unsupported or duplicate section 13`. Safe exception-handling admission and interruption support is a runtime-owned prerequisite. This package does not bypass source admission or claim cooperative execution. Until that prerequisite lands and the real acceptance test passes, this draft is not qualified for Waffle execution.
