# Build and verify tar

Use Node for the producer and Bun only for Waffle's runtime tests. No Bun guest
is built. The package has a standalone Cargo workspace and lockfile, so it does
not alter the repository Cargo workspace or build unrelated guests.

The producer verifies the official source archive and local patch hashes before
extraction, then builds offline from exact locked dependencies. It uses Waffle's
shared wasi-sdk 34.0, patched wasi-libc and 256 MiB memory-cap contracts. Supply a
verified shared libc cache and exact-input network asset. Never rebuild the
network just to qualify tar.

Run compilation and quality-11 compression through the execution host's shared
heavy queue. Nuxt and Next have priority. Set `TAR_TARGET_DIR` and `TMPDIR` to a
run-owned data-drive directory. Install teardown before setup and keep fixtures
off the host filesystem exposed to guests.

```sh
node packages/tar/scripts/build-tar.ts --prepare
# Source preparation only. Fetch the exact producer lock with Cargo if needed.
node packages/tar/scripts/build-tar.ts --native
node packages/tar/scripts/build-tar.ts
node packages/tar/scripts/test-native.ts
TAR_CHECK_ARTIFACTS=1 node --test packages/tar/tests/source.test.ts
node tools/program-package.ts pack packages/tar
TAR_PACKAGE_ARCHIVE="$PWD/packages/tar/.build/waffle-tar-0.0.0.tgz" \
  bun test packages/tar/tests/tar-wasi.test.ts
```

The native corpus checks GNU tar 1.35's version and records its executable hash.
It separately verifies the matching native uutils build and records its hash.
Every native command has a 15-second deadline. Guest tests use the real Waffle
worker, owned VFS, actual on-demand registration and alias identity, file and pipe
I/O, negative metadata controls, package-archive listing, and removal/disposal.
These negative controls do not claim that extraction succeeded.

The source-side guest verifier runs before stripping. `stageProgram` on accepted
main strips name sections only. Waffle PR 231 owns size optimization and the
producer/finalizer/compressed-serving contract. No unprovided prerequisite head
or copied finalizer is used here. Brotli in this candidate is a measured package
artifact, not proof that the runtime downloads the compressed representation.
The current public catalog downloads the stripped `.wasm` lazily.

`dist/tar.sizes.json` records raw, stripped and Brotli bytes plus source, producer
lock and output hashes. Notices include upstream tar and the actual WASI
transitive dependency license texts. The package archive must pass shared
admission and exact asset readback; the actual tar guest lists that same archive.

After consumers stop, remove task source extraction, Cargo targets, fixture
directories, temporary package copies and dependency links. Preserve shared SDK,
libc, network inputs and active caches. The parent retains only the clean review
worktree, small evidence and verified `dist` until review finishes.
