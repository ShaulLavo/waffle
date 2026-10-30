# Checksums

The checksum source crate uses uutils/coreutils `07763857f6b9a547742a994b58aef0ccd036198b`. Its nine commands are `b2sum`, `cksum`, `md5sum`, `sha1sum`, `sha224sum`, `sha256sum`, `sha384sum`, `sha512sum`, and `sum`.

The crate has its own workspace and lockfile under `crates/checksums`. It does not register commands in the public coreutils catalog yet.

## Build and check the source crate

From `packages/coreutils`, with the existing verified patched WASI libc, wasi-sdk 34 and pinned Binaryen 133 available:

```sh
node scripts/build-checksums.ts
node scripts/checksum-oracle.ts --verify
node --test scripts/checksum-source.test.ts
bun test tests/checksums-wasi.test.ts
```

The build uses the shared release settings, verifier, optimizer and name stripping. It builds only these checksum binaries. Output goes to the repository's `.build/coreutils-checksums/dist` directory. Set `CHECKSUM_ARTIFACTS` to that directory to test retained copies elsewhere.

The fixture records GNU coreutils 9.12 executable versions and hashes. The runtime test verifies those identities before comparing 37 cases. It checks stdin, relative files, seven checksum-verification commands, malformed input, missing paths, binary data and selected flags. It also streams 1 MiB through a bounded live pipe, interrupts a second open pipe, and checks first-use fetch and removal of canonical and alias paths. The caller's runtime remains usable after removal.

## Upstream behavior and integration limits

The upstream digest reader uses `io::copy` over a 32 KiB buffered reader. `sum` uses fixed 8 KiB buffers. The adapter never reads a complete input file into memory or substitutes a host hashing implementation. It only sets libc cwd from `PWD` before entering upstream. Keep `PWD` aligned with the requested cwd.

Diagnostics, help and version output remain uutils text. Tests compare diagnostic presence rather than GNU wording. MD5, SHA-1 and legacy sums are not suitable for checking authenticity.

These are source-qualification artifacts, not new published coreutils programs. The parent integration must add per-command English catalogs, including `checksum_common`, before publication. This source-only build still includes upstream catalogs. Catalog registration, family artifact and notice lists, and shared typecheck/test discovery also remain parent-owned.

[Source provenance](../provenance/checksums.source.json) records package paths, upstream hashes, license identity and local changes.
