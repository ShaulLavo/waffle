# Waffle awk

The optional `awk` package runs the real One True Awk evaluator as a WASI guest. Import `awk` and install it on the caller's Waffle runtime; it is not part of the base package.

The build downloads only the pinned, checksum-verified upstream source and compiles it for `wasm32-wasip1`. The package exposes `/usr/bin/awk` with `/bin/awk` as the same program alias.

```sh
bun run --cwd packages/awk prepare:package
bun run --cwd packages/awk test:wasi
bun run --cwd packages/awk test:oracle
```

See [compatibility and limits](docs/compatibility.md), [source provenance](sources.lock.json), and the [build recipe](build-recipe.json).
