# Waffle jq

A jq-compatible WASI program for Waffle, built from jaq 3.1.2. Import `jq` and pass it to Waffle's program catalog. It is optional and is not part of the base package.

The build downloads only the pinned, checksum-verified upstream source. The generated source tree and Wasm artifacts stay out of Git.

```sh
bun run --cwd packages/jq prepare:package
bun run --cwd packages/jq test
bun run --cwd packages/jq test:oracle
```

See [compatibility and known differences](docs/compatibility.md) and [source provenance](sources.lock.json).
