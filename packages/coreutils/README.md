# Waffle coreutils

WASI core utilities for Waffle. Import `coreutils` and pass it to Waffle's generic program installer.

- Plain WASI sources: `cp`, `env`, `head`, `ls`, `mv`, `rm`, `touch`, `sort`, `uniq`, plus the `cut`, `tr`, `wc` and `clear` crates.
- Cooperative sources: `cat`, `mkdir`, `seq` and `tail`, using `waffle-program-support` only.
- `which` keeps lookup-only behavior behind the provisional `waffle_executable` host query. No host implementation or Bash executable namespace is included.
- `env` and the singular `waffle-process-consumer` crate are relocated from qualified Bash `95827ca4ef80e367bf0eef7b548b6a58683c8719`; caller-fatal jobs and wait-flag 2 are unchanged. Only crate/import/path identifiers differ.
- `cooperative-wasi` is deliberately not a default feature. It exposes the required generic `waffle_program.inherited_fd` import without carrying over `shell_terminal`. Enable it only when that Waffle contract lands.

`programs.provisional.json` preserves the source transfer record. The runtime package owns installation, process admission and cleanup.

## Checks

From the scratch workspace, with Rust 1.98.1 and cached dependencies:

```sh
cargo test --offline -p waffle-program-support -p waffle-coreutils -p waffle-clear
node scripts/verify-transfer.mjs
node scripts/notices.mjs
node scripts/build.ts
```

The full final WASI recipe still needs Waffle's patched sysroot and verifier. Do not substitute Rust's bundled WASI libc for a shipping artifact.
