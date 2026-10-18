# Development

Waffle is a private, exact-commit Git dependency while its public API is still settling. Consumers
should pin a commit and list `waffle` in Bun's `trustedDependencies` so `prepare` can generate the
Node entry points. Do not rely on an npm tarball or a sibling checkout.

## Setup and checks

Run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun run prepare
bun run check
bun run check:nodenext
bun test ./tests
bun run size
```

The browser storage matrix is:

```sh
bun tests/storage-browser-runner.ts chromium firefox webkit
```

It requires Playwright's three browser engines. Set `STORAGE_SCRATCH_ROOT` to a verified
scratch directory on the data drive; the runner owns its browser/profile cleanup.

## More documentation

- [Architecture and API notes](architecture.md)
- [Guest and host ABI](host-abi.md)
- [Runtime startup](runtime-startup.md)
- [WASI libc notes](wasi-libc.md)
- [Bun provenance and patches](bun-patches.md)
