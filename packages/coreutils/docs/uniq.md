# Uniq utility

`uniq` runs the upstream uutils adjacent-line filter as its own ordinary WASI guest. Import `installUniq` from `bash-web/utilities/uniq` and install it on the Waffle runtime your shell already uses. The shell core does not include it.

## Supported behavior

The usage suite compares adjacent duplicate removal, `-c` counts, `-d` repeated groups, `-u` unique groups, `-i` case-insensitive matching, named relative inputs, output files, empty input, and unterminated input against GNU uniq with `LC_ALL=C`. Non-adjacent equal lines remain separate. Use `sort | uniq` to group all equal lines. Missing inputs and invalid options retain upstream diagnostics and failure statuses.

```ts
import { installUniq } from "bash-web/utilities/uniq";

const uniq = await installUniq(runtime);
// The first shell invocation of uniq loads its guest.
await uniq.dispose();
```

`wasmUrl` and `workerUrl` override the packaged URLs. Instead of `wasmUrl`, `source` accepts raw `Uint8Array` bytes or a lazy function returning bytes. There is no precompiled-module or cooperative registration. Waffle owns ordinary admission, interruption, files, and descriptors. Uniq loads independently of sort. Disposing its installation does not dispose the borrowed runtime.

## Resource limits

The guest shares the repository's 256 MiB linear-memory cap. Upstream retains record data and may buffer an entire group for group-printing options. An unusually long record or group can exhaust memory. No fixed input-size guarantee or full locale parity is claimed. The tests cover the common C-locale behavior above through real Waffle processes, including redirected files and stdin pipelines.

## Source and verification

`uu_uniq = "=0.12.0"` is an unmodified individual registry library, not a multicall binary. Its source receipt identifies uutils/coreutils revision `dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69`, path `src/uu/uniq`. [The source receipt](sort-uniq-source.json) records the registry checksum. Cargo.lock pins its dependencies. `npm run notices:shell` includes the MIT license and dependency notices.

The wrapper calls `uucore::bin!(uu_uniq)` after setting WASI libc's cwd from `PWD`. It adds no local filtering algorithm. Build and verification commands are shared with [Sort](sort.md#source-and-verification).
