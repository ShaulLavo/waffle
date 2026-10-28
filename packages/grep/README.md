# Waffle grep

WASI grep for Waffle. Import `grep` and pass it to Waffle's generic program installer.

The cooperative guest uses the shared sibling `waffle-program-support` crate. No Bash engine, parser, shell state, adapter, worker or runtime is included.

`programs.provisional.json` preserves the source transfer record. `cooperative-wasi` stays disabled until Waffle's generic inherited-descriptor contract lands.

See [the behavior contract](docs/grep.md) and [source provenance](provenance/grep.source.json). Frozen usage fixtures remain unchanged under `tests/fixtures/`.

```sh
cargo test --offline --locked -p waffle-grep
```
