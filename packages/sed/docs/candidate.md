# Sed source candidate

`src/main.rs` calls the frozen upstream sed entry. `third-party/uutils-sed/` is unchanged, including its manifest, MIT license, provenance and local WASI patch. `Cargo.toml` is an isolated native workspace for this candidate, materializing the frozen Bash workspace fields/profile. Cargo may re-express dependency references while pruning unrelated packages; versions, registry sources and checksums remain pinned.

Run the existing source check from the candidate root:

```sh
node --test packages/sed/scripts/test-sed-source.ts
```

The small shared test helper at `tools/source-contract-test.ts` must accompany source checks. `cargo metadata --offline --locked --manifest-path packages/sed/Cargo.toml` resolves this isolated workspace with the installed frozen Rust 1.98.1 toolchain. A bounded native unit slice is `cargo test --offline --locked --manifest-path packages/sed/Cargo.toml -p upstream-sed --lib sed::fast_regex:: -j2` on a reserved build host.

Historical build, installed-package browser test and feature/install documentation remain byte-identical under `provenance/bash/`. They require Waffle's real contracts before becoming current package commands. WASI still rejects execution commands and in-place edits; native upstream behavior differs intentionally. Native tests cannot qualify those WASI restrictions.

The package has no runtime entry, worker or installer. See the candidate root's `programs-search-candidate/INTEGRATION.md` and `BUILD-TOOLS.md` for the exact remaining work and notice requirements.
