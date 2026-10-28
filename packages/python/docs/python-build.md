# Build the Python assets

Run `node scripts/build-python.ts --output dist` with Node 26, Python 3.13 or newer, a native C compiler, make, wasi-sdk 34.0, and Wasmtime on `PATH`. Set `WASI_SDK_PATH` to the SDK directory. The build limits the official helper to two make jobs with Python's `-X cpu_count=2` option. The build uses CPython's official `Platforms/WASI` stages and the existing Waffle patched-libc helper. It does not build the shell or other utilities.

The source is CPython 3.15.2, commit `5e58eaad7c58df58dfa8ea549c87996e01dd1077`. The official source archive SHA-256 is `8b5536d280142ecf6cdfe15d12a21ba1c65e300bbf7b28a8d0cdb849575797de`. The build applies the recorded `patches/cpython-wasi-cwd.patch` startup patch: on WASI, CPython calls libc `chdir(PWD)` before reading argv or running user code, so Waffle's requested process cwd governs `os.getcwd()`, relative scripts, and relative file I/O. It selects the patched sysroot through supported compiler flags and sets an exact 256 MiB memory maximum. Threads, subprocesses, sockets, and native extension loading are outside this slice.

The output directory contains separate `python.wasm` and `python-stdlib.json` assets. The manifest describes every regular file in the full initial `Lib/` tree, the actual `pybuilddir.txt`, and the full generated sysconfig directory. Each entry records a canonical guest path, a URL relative to the manifest, a byte count, and SHA-256. Empty files remain included. The interpreter is not copied into the guest filesystem.

The interpreter's argv0 must be `/cross-build/wasm32-wasip1/python.wasm`. The marker and generated tree retain CPython's build layout so `sysconfig` discovers the actual WASI configuration. The caller owns the Waffle runtime and first-use loading.

`python-build.json` records source, toolchain, imports, exports, memory, and asset identities. `python.NOTICES.txt` retains the upstream license, incorporated-software notices, and bundled-wheel notices. The full stdlib keeps its embedded notices and test data.

To reuse an already built artifact, run `node scripts/build-python.ts --stage /absolute/artifact --output dist`. Staging validates the artifact before copying and does not compile. Run `node --test scripts/test-python-build.ts` for the build-tool checks. Browser acceptance is a separate consumer of this one artifact.

To qualify an existing artifact on the currently prepared runtime, run `node scripts/build-python.ts --qualify /absolute/artifact --output /absolute/runtime-qualification.json`. This writes separate execution evidence and preserves the original producer receipt and every asset. The producer's recorded runtime identifies its original qualification; staging checks the source patch and asset hashes without treating that runtime revision as a compiler input.

Build scratch lives in a fresh owned subdirectory of `.build/python/`, or the parent passed with `--work`. The command removes that scratch on success and failure. The patched libc remains in the existing validated cache, prepared through the singular repository `tools/program-build-tools.ts` recipe with explicit monorepo and `packages/waffle` roots. `node --test scripts/test-python-build.ts` runs only bounded tooling checks with synthetic fixtures; it does not build or qualify CPython. Use `--qualify` for the separate existing-artifact qualification flow. These checks do not replace browser acceptance.

CI has one Python producer. `scripts/python-ci.ts` filters compilation by the contents of the listed Python source, patch, recipe, verifier, SDK setup, and installed Waffle libc build inputs, plus SDK and compiler versions. Unrelated feature paths and dependency changes leave that cache key unchanged. Only a missing exact cache entry compiles CPython. The browser job stages the shared artifact after the demo build, runs `npm run prepare:python:browser` with `BASH_WEB_PYTHON_SHELL_WASM` pointing to its shared shell guest, then includes Python in the existing blocking browser gate. For a local Python-only browser run after staging the assets and workers, use `npm run test:python:browser -- --project=chromium`.

Current monorepo qualifications identify the actual committed `packages/waffle` sibling
by repository commit and runtime subtree Git ID, plus its package version. The audit
rejects uncommitted runtime changes before starting production or qualification, bundles
that sibling's WASI/filesystem entries directly, and records the same identity in the
receipt. Historical producer receipts keep their original external runtime identity.
