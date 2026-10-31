# Waffle coreutils

WASI core utilities for Waffle. Import `coreutils` and pass it to Waffle's generic program installer.

- Plain WASI sources: `cp`, `env`, `head`, `ls`, `mv`, `rm`, `touch`, `sort`, `uniq`, plus the `cut`, `tr`, `wc` and `clear` crates.
- Cooperative sources: `cat`, `mkdir`, `seq` and `tail`, using `waffle-program-support` only.
- `which` uses Waffle's lookup-only `runtime_proc.access_*` query without loading candidates.
- `env` and the singular `waffle-process-consumer` crate are relocated from qualified Bash `95827ca4ef80e367bf0eef7b548b6a58683c8719`; caller-fatal jobs and wait-flag 2 are unchanged. Only crate/import/path identifiers differ.
- `cooperative-wasi` uses the landed `runtime_proc.inherited_fd` launch descriptor snapshot.

`programs.provisional.json` preserves the source transfer record. The runtime package owns installation, process admission and cleanup.

## Checks

From the scratch workspace, with Rust 1.98.1 and cached dependencies:

```sh
cargo test --offline -p waffle-program-support -p waffle-coreutils -p waffle-clear
node scripts/verify-transfer.ts
node scripts/notices.ts
node scripts/build.ts
```

The full final WASI recipe still needs Waffle's patched sysroot and verifier. Do not substitute Rust's bundled WASI libc for a shipping artifact.
