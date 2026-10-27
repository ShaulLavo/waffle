# Waffle ripgrep

Portable WASI ripgrep for Waffle. Import `ripgrep` and pass it to Waffle's generic program installer. It preserves the frozen ripgrep 15.2.0 archive identity, WASI patch, source/notice/build recipes, integration license, and maintained native/WASI/browser test material from bash-web `9ef027d7b8544beea8adf0b33cd8`.

The upstream source tree is generated during a verified build and is intentionally absent. The generic Waffle runtime owns installation, process admission and cleanup. No installer or adapter is included here.

See [candidate integration](docs/candidate.md) before using the preserved historical recipes or browser tests.
