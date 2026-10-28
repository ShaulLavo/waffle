# Findutils candidate

The package has two ordinary WASI source guests. `find` keeps the frozen traversal scope and rejects process predicates before reading roots. `xargs` keeps upstream parsing and batching but uses the frozen echo-only process gate. The source receipts and patches are copied from Bash blob `9ef027d7b8544be7d2d84ee59beea8adf0b33cd8`.

Run `cargo test --offline --locked --manifest-path packages/findutils/Cargo.toml -p waffle-findutils-source` for the bounded native controls and the source checks from `packages/findutils/scripts/`. Waffle's real SDK/sysroot, final-code scanner, package exports, installer and browser tests remain parent-owned integration work.
