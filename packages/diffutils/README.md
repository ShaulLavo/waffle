# Waffle diffutils

GNU `diff` and `cmp` 3.12 as optional WASI programs for Waffle. Import `diffutils` and pass it, or selections from it, to Waffle's program catalog. Neither command is part of the base package.

The build downloads only the checksum-verified GNU release archive. The patched source tree and Wasm artifacts stay out of Git.

```sh
bun run --cwd packages/diffutils prepare:package
bun run --cwd packages/diffutils test
bun run --cwd packages/diffutils test:wasi
```

See [compatibility](docs/compatibility.md), [provenance](docs/provenance.md), and [the source lock](sources.lock.json).
