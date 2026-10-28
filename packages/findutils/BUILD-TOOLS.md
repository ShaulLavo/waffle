# Shared build dependency

The future Waffle shared build-tools owner supplies the wasi-sdk/sysroot preparation, patched wasi-libc and final-guest verifier. This candidate copies none of Bash's builders, workers, runtime, installer or verifier. Keep SDK 34.0, wasi-libc `2e6fb9d8ee0c`, the 256 MiB defined memory maximum, Rust self-contained libc disabled and final-code scanning as shared invariants.

`build-recipe.json` records the historical inputs and output names. It is transfer metadata, not a runnable package command. No WASI binary, notice bundle or producer receipt is claimed here.
