# Guest libc and inherited descriptors

Waffle preserves child binding numbers exactly. Before worker instantiation it reserves every incoming target, then places each filesystem preopen in the lowest free descriptor starting at 3. Root is fd 3 normally, fd 4 with an inherited fd 3, and fd 10 with inherited fds 3 through 9. A sparse target such as 1,000,000 does not move root above that target. Multiple preopens fill the remaining lowest gaps in declaration order.

`fd_prestat_get` reports only actual preopens. Open inherited descriptors return `BADF`, not a fabricated preopen or `NOTSUP`. Rights and filesystem ownership remain attached to the moved preopen. Binding placement and installation finish before WebAssembly instantiation, including its start section. Direct `Wasi` callers that install inherited descriptors supply the same targets through `reservedFds` before calling `descriptors.inherit`.

## Why libc must be rebuilt

Unchanged wasi-libc stops preopen discovery at the first `BADF` from `fd_prestat_get`. An inherited fd 3 therefore prevents it from discovering root at fd 4. Waffle cannot fix a precompiled third-party scanner without lying about descriptors or translating guest fd numbers. Ordinary unmodified binaries still work when their preopens precede every non-preopen; fd-3 inheritance requires rebuilding the guest scanner.

The single shared patch is `patches/wasi-libc/preopen-scan.patch`, based on wasi-libc revision `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13`, shipped by wasi-sdk 34.0. After a prestat `BADF` it probes `fd_fdstat_get`: success skips the open non-preopen, `BADF` ends the scan, and other errors take libc's existing fatal error path. Lowest-free placement guarantees all preopens precede the first empty slot. Discovery cost depends on that occupied prefix, never on a sparse high target.

## Build and link

Pin Waffle to an exact merged Git commit in each consumer, keep `waffle` in Bun's `trustedDependencies`, and install with the consumer's lockfile. Do not copy the libc patch into each consumer: invoke the script from that same pinned Waffle checkout.

The script needs wasi-sdk **34.0**, CMake **3.26+**, Ninja, curl, tar, patch, sha256sum, Linux `setsid`, and GNU `timeout`. It verifies the SDK's libc revision and the downloaded source archive's SHA-256. Each command owns a process group, with a 600-second timeout (override `WASI_LIBC_COMMAND_TIMEOUT_SECONDS`). Its uniquely owned source/build/download directory is removed on success, failure, SIGINT and SIGTERM only after descendants stop; if cleanup cannot be verified, the script retains scratch and prints its path. Compiler intermediates use that owned scratch through `TMPDIR`, `TMP`, and `TEMP`. The output must not already exist; the script never deletes an existing output directory. Choose and verify a data-volume scratch root and output before running a build.

On the development PC, with the workload admitted through the normal heavy runner:

```sh
export PATH=/work/cache/wasm-tools/cmake/bin:/work/cache/wasm-tools/ninja:$PATH
export WASI_SDK_PATH=/work/cache/wasi-sdk-34.0-x86_64-linux
export WASI_LIBC_SCRATCH_ROOT=/work/tmp
# Substitute the pinned Waffle checkout and a new consumer-owned output directory.
bash "$WAFFLE_CHECKOUT/scripts/build-wasi-libc.sh" "$PATCHED_SYSROOT"
"$WASI_SDK_PATH/bin/clang" --target=wasm32-wasip1 \
  --sysroot="$PATCHED_SYSROOT" guest.c -o guest.wasm
```

Use that sysroot for the final link, not only for compiling sources. Rust/Bun consumers that explicitly link wasi-sdk libc must disable Rust's self-contained libc selection and point their final linker at this sysroot rather than the SDK's stock libc. Do not layer a second scanner override or synthetic prestat result on top. Consumer-specific engines and shells keep their own language adapters; Waffle owns descriptor placement and this libc patch. The output belongs to the consumer and can be removed after all guest builds using it have finished.

## Regression gate

`bun run test:libc` builds the patched sysroot, compiles the original C fixture against both patched and stock libc, and removes its entire temporary tree afterwards. Set `WASI_SDK_PATH`, `WASI_LIBC_SCRATCH_ROOT`, and `WASMTIME` when their PC defaults are not appropriate. CI runs this gate separately; ordinary `bun test` explicitly skips the real-libc cases if their generated fixtures are absent.

The gate checks all required layouts, multiple preopens, a parent closing its transferred descriptor, root lifetime and rights, bounded discovery with fd 1,000,000, real fdstat errors, literal fd-3 writes, constructors, and a real Wasm start section. Its start-section wrapper preserves LLD's imported-memory initializer before calling libc. Generic worker bootstrap is exercised with the libc guest, not an adapter-side preopen relocation. An unchanged libc guest demonstrates the fd-3 limitation. The patched ordinary guest also runs on unmodified Wasmtime and Node WASI, with no new imports.

Fast controlled-stub tests in `tests/libc-tooling.test.ts` cover direct and nested process-group interruption/timeouts and verify that compiler temporaries remain in owned scratch, not `/tmp`. They run on Linux without downloading or compiling libc.
