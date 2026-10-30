# awk compatibility

This package runs the pinned 20260426 release of The One True Awk. It is not a handwritten evaluator or a translation into TypeScript. The bounded fixture corpus covers the common agent workflows of field selection, `FS` and `OFS`, patterns and actions, `BEGIN` and `END`, `NR` and `NF`, stdin and file arguments, `-F` and `-v`, arithmetic, formatting, associative arrays, substitutions, regular expressions, multi-file iteration, exit statuses, and diagnostics.

The native oracle is compiled from this same source archive and patch, with the WASI-only guards inactive. It does not invoke system `awk`, `gawk`, `mawk`, or another host implementation. Oracle observations are committed as fixture data and are compared with the actual Wasm guest under Wasmtime. The enabled Waffle acceptance suite also checks the reviewed guest through the real runtime. Current-finalizer package production has the separate build prerequisite below.

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

## Qualification and build prerequisite

The upstream evaluator uses `setjmp` and `longjmp` for nonlocal `exit`, including exits from expressions in nested functions and `END`. The package preserves that behavior with wasi-sdk 34's `-mllvm -wasm-enable-sjlj`, standard exception handling via `-mllvm -wasm-use-legacy-eh=false`, and the shared sysroot's `-lsetjmp`.

The original runtime at `620da8002cf2dab88862a0a503e228413b52603a` rejected exception tag section 13. Runtime PR 254 resolves that admission failure. The enabled package suite passes against main `a92850661692d9e5c96160d93b62606e0bec5ef2` with the original reviewed guest, SHA-256 `dbc5c6e025f5f07e598c3d685b01fdced0b21b3ad37629398c94dfcfdae939e3`. It preserves all 43 committed native observations, three capability refusals and the original infinite-loop interrupt and removal deadlines. This package uses ordinary source rewriting, without a cooperative declaration or admission bypass.

That guest predates the shared optimizer and remains historical evidence, not a current-finalizer artifact. The current shared finalizer rejects its required `exception-handling` target feature before Binaryen runs. Current package production stays blocked until the shared optimizer supports standard exception handling without changing guest semantics or weakening verification. The producer uses the normal `stageProgram` route and declares its derivation, gzip and Brotli outputs. Old derivatives must not be relabeled to satisfy this gate.
