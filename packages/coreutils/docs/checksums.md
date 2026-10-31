# Checksums

The coreutils family includes `b2sum`, `cksum`, `md5sum`, `sha1sum`, `sha224sum`, `sha256sum`, `sha384sum`, `sha512sum`, and `sum` from uutils/coreutils `07763857f6b9a547742a994b58aef0ccd036198b`. Each has a `/usr/bin` path and a `/bin` alias.

The crate has its own workspace and lockfile under `crates/checksums`.

## Build and check

From `packages/coreutils`, with wasi-sdk 34 and pinned Binaryen 133 available:

```sh
export GNU_CHECKSUM_ORACLE_ROOT="$(pwd)/../../.build/gnu-checksum-native-oracle"
GNU_CHECKSUM_ORACLE_SCRATCH_ROOT=/path/to/owned-scratch node scripts/build-native-checksum-oracle.ts
node scripts/build-checksums.ts
node scripts/checksum-oracle.ts --verify
node --test scripts/checksum-source.test.ts scripts/checksum-parser.test.ts
bun test tests/checksums-wasi.test.ts
```

The family build (`bun run build`) builds them too. Each utility gets its own locale-selected Cargo build with the shared patched libc, release settings and verifier. The guest and its locale proof go to the family release directory, and the family stager optimizes them into `dist`. The runtime test loads the registered coreutils entries from `dist`. Set `CHECKSUM_ARTIFACTS` to test a retained guest directory instead.

The fixture preserves the original GNU coreutils 9.12 recording-host versions and hashes. The selected source-built cache has its own GNU source, compiler, recipe and binary receipts, and must reproduce all 37 recorded cases. The runtime test and live regression controls use the same explicitly selected provider. On the exact recording host, `GNU_CHECKSUM_ORACLE=recording-host` can be selected instead of `GNU_CHECKSUM_ORACLE_ROOT`; its binaries must match every recorded hash. Neither selection falls back to an unqualified system binary. The runtime test compares the real guests against the recorded cases. It checks stdin, relative files, seven checksum-verification commands, malformed input, missing paths, binary data and selected flags. It also streams 1 MiB through a bounded live pipe, interrupts a second open pipe, and checks first-use fetch and removal of canonical and alias paths. The caller's runtime remains usable after removal.

## Source and locale preparation

The build first exports the exact pinned Cargo Git source into `.sources/checksums`, applies the owned dependency patch, and seals every generated file and internal symbolic-link target in `waffle-source.json`. The locale boundary verifies the exact owned directory, receipt digest and source contents before asking Cargo for metadata. Reuse fails if any file or link changed. Set `CHECKSUM_UPSTREAM_SOURCE` if that exact checkout is outside Cargo's cache. Never edit the generated dependency or the shared Cargo cache.

Locale selection embeds only the utility's English catalog, the common uucore catalogs and, except for legacy `sum`, the shared `checksum_common` messages. It accepts the patched uucore and `checksum_common` packages only from that sealed source and records the receipt hash in its selection. Each `.locales.json` proof keeps the generated catalog source bytes, and the coreutils artifact receipt hashes the proofs.

## CI scope

The checksum-only CI job uses this same leaf producer once, then checks the named compiler inputs, retained locale source, strict optimizer derivations, compressed copies and staged readbacks before running acceptance. Native GNU inputs and Cargo/toolchain outputs are cached by their inputs. A restored generated source from a different recipe is discarded and recreated, not relabeled. CI retains its own checksum-only proof artifacts; it does not publish the local qualification archive or admit a complete coreutils family or date release.

## Upstream behavior and limits

The upstream digest reader uses `io::copy` over a 32 KiB buffered reader. `sum` uses fixed 8 KiB buffers. The adapter never reads a complete input file into memory or substitutes a host hashing implementation.

Each entry enters the launch cwd from Waffle's `runtime_proc.cwd` import before calling upstream. `PWD` is ordinary environment: a stale or missing value does not change which file a relative name opens.

The dependency patch uses WASI descriptor reads and writes at the selected I/O operation, with initial descriptor errors recorded before named files can reuse a missing descriptor number. Absent descriptors fail instead of becoming empty input or discarded output. Named-file reads do not require stdin. Output-free `--status` verification does not require stdout. The patch also handles escape markers before digest parsing and decodes marked filenames once. The runtime tests generate and verify escaped records for every verification command and compare selected-descriptor and cwd controls with the pinned GNU oracle.

`--zero --check` remains an upstream compatibility limit. GNU rejects this combination, while this pinned uutils accepts it.

Diagnostics, help and version output remain uutils text. Tests compare diagnostic presence rather than GNU wording. MD5, SHA-1 and legacy sums are not suitable for checking authenticity.

[Source provenance](../provenance/checksums.source.json) records package paths, upstream hashes, license identity and local changes.
