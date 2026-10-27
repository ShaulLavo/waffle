# Sort utility

`sort` runs the upstream uutils sorting program as its own ordinary WASI guest. Import `installSort` from `bash-web/utilities/sort` and install it on the Waffle runtime your shell already uses.

## Supported behavior

The usage suite compares default line ordering, `-n`, `-r`, `-u`, combined `-nru`, `-c`, named relative inputs, `-o` output files, standard-input pipelines, empty input, and unterminated input against GNU sort with `LC_ALL=C`. Invalid options and missing files return upstream diagnostics and failure statuses. The upstream argument parser and sorting algorithms are unchanged.

```ts
import { installSort } from "bash-web/utilities/sort";

const sort = await installSort(runtime);
// The first shell invocation of sort loads its guest.
await sort.dispose();
```

`wasmUrl` and `workerUrl` override the packaged URLs. Instead of `wasmUrl`, `source` accepts raw `Uint8Array` bytes or a lazy function returning bytes. Installation does not fetch the guest. Precompiled modules are not accepted, because Waffle needs the bytes to add interruption checks. Disposing this installation removes only sort, not uniq or the borrowed runtime.

## WASI resource limits

Sorting buffers input. Upstream's WASI implementation sorts in memory rather than spilling runs to temporary files. It uses single-threaded sorting and ignores the thread-count option. `-S` is not a hard memory budget on this target, and `-T` does not enable disk-backed sorting. The guest's linear memory has the repository's 256 MiB cap. Record data, indexes, sorting scratch, and the program itself share that memory. Inputs near that size are not guaranteed to fit. Allocation failure can terminate the guest rather than produce a GNU diagnostic.

The browser test uses Waffle's filesystem and ordinary process admission. No native subprocess, thread, external compressor, or host filesystem adapter is supplied. C-locale common cases are tested. Full locale parity, large-input capacity, and external compression are not claimed.

## Source and verification

`uu_sort = "=0.12.0"` is an individual registry library, not the coreutils multicall binary. Its source receipt identifies uutils/coreutils revision `dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69`, path `src/uu/sort`. [The source receipt](sort-uniq-source.json) records the registry checksum. Cargo.lock pins every transitive dependency. The MIT license and dependency licenses are included by `npm run notices:shell`.

The wrapper calls `uucore::bin!(uu_sort)` after setting WASI libc's cwd from `PWD`. It contains no local sorting algorithm. The existing `buildWasiShell` helper supplies patched wasi-sdk 34.0 libc, the memory cap, and guest verification.

Run `cargo test --locked --manifest-path shell/Cargo.toml -p shell-utilities --test sort_uniq` for native frozen-GNU comparisons. After building the shell, utilities, and Node test bundle, run `node --test scripts/test-own-shell-sort-uniq.ts` for real Waffle comparisons and independent lazy-loading and disposal checks. `npm run test:browser -- tests/sort-uniq.spec.ts` exercises the same usage cases in Chromium and Firefox.
