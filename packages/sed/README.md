# Waffle sed

Portable WASI sed for Waffle. Import `sed` and pass it to Waffle's generic program installer. It preserves the frozen uutils/sed source, receipt, MIT license, WASI patch, build recipe, source verifier, and maintained tests from bash-web `9ef027d7b8544beea8adf0b33cd8`.

The generic Waffle runtime owns installation, process admission and cleanup. No installer or adapter is included here.

See [candidate integration](docs/candidate.md) before using the preserved historical recipes or browser tests.
