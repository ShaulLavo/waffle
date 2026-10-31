# Starship source candidate

Status: blocked and incomplete. This directory pins upstream Starship 1.27.0 at
`f8e4e2155542cc84f49b342122d371f74e0ad253`. It does not export a program, contain
compiled output, install an executable or enable Starship in a shell.

The source archive, unchanged Cargo lockfile, ISC license and important input
files are identified in `../sources.lock.json`. The lockfile is retained under
`../upstream/`; it is not a new Cargo workspace. `../build-recipe.json` records the
failed minimal diagnostic and the required normal Waffle production route.

Run the source-only controls with:

```sh
node --test packages/starship/scripts/source.test.ts
```

## Why production is blocked

The unmodified minimal `wasm32-wasip1` build fails in `errno` 0.2.8 because it
requests unstable thread-local storage on stable Rust. Scratch-only diagnostic
changes exposed further failures in `guess_host_triple` 0.1.5, `process_control`
5.2.0 and `open` 5.4.4. None of those experimental changes is retained here or
approved as a production adaptation.

Starship also starts Rayon workers, starts a directory-scan thread and executes
external commands through `std::process::Command`. The existing Waffle process
consumer exposes runtime-owned spawn, descriptors, typed waits and cancellation.
It does not replace Rust's standard-library process backend. Bridging those
contracts, preserving scan/command deadlines and classifying unavailable module
authority needs a separate design before implementation continues.

The minimal diagnostic's `--no-default-features` is not a decision to remove
battery or notifications from the delivered feature. Production must explicitly
classify supported effects and report unsupported ones. No module may disappear
silently. No native executable, prompt lookalike or host-command replacement is
an acceptable fallback.

## Admission still required

A supported producer must use the existing patched SDK/libc route, shared size
policy, optimizer and strict derivation checks. Source and dependency licenses
must follow the actual produced closure. No guest receipt, compression output,
notices closure, package export or packed-entry qualification exists yet.

Only after that route works may the program be registered lazily as an optional
package. The end-to-end finish line still requires real
`eval "$(starship init bash)"`, prompt changes after commands and no per-keystroke
prompt execution. That work is not complete.
