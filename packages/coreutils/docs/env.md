# Print-only env

`env` is a separate upstream uutils WASI program. Import `installEnv` from `bash-web/utilities/env` and install it on the caller-owned Waffle runtime. Installation writes and registers both `/bin/env` and `/usr/bin/env` with the same lazy raw-byte loader for `dist/env.wasm` and the same adapter. `UtilityInstallation.executable` remains `/bin/env`. Installation does not fetch, compile, or start a worker. `WasiUtilityOptions` accepts `wasmUrl`, `workerUrl`, or `source` bytes. Stop active processes before disposing the installation. Disposal releases both registrations and removes only unchanged markers created by that installation. A conflict at either path rolls back the installation without removing foreign entries.

## Supported forms

This utility prints the guest's environment. It supports no program operand, `-i` or `--ignore-environment`, `-u NAME`, `NAME=VALUE`, newline or `-0` NUL termination, `-v` debug output, and `-S` splitting when the resulting arguments contain no program. Upstream owns option parsing, splitting, environment edits, and output.

For example, `env -i -S 'A=one B="two words"'` prints `A=one\nB=two words\n`. `-S` expands `${NAME}` from the inherited guest environment before `-i` clears it. Repeated assignments keep the last value. Unsets precede assignments, so `env -u A A=new` restores A. Environment iteration is not sorted. Edits apply only inside that utility process.

`env -C /` without a program and `env -0 COMMAND` are usage errors with status 125. Help and version are upstream output, not a list of qualified capabilities.

## Unsupported forms reject before input

Every program operand returns status 125 before environment edits, target execution or input consumption. This includes ordinary commands, `-C DIR COMMAND`, `-a ARGV0 COMMAND`, and `-S` strings that produce a program. This is an unsupported-mode error, not a qualified GNU 126/127 lookup result.

The `/usr/bin/env` alias alone does **not** enable `#!/usr/bin/env node`. Generic shebang interpreter resolution belongs to Waffle, and this env guest still rejects the `node` command operand with status 125. Command execution needs a separate env implementation change and the host capabilities below.

Signal options `--ignore-signal`, `--default-signal`, `--block-signal`, and `--list-signal-handling` also return 125. Upstream accepted them without effect on WASI. A small recorded source patch now rejects them, including options produced by `-S`. There is no signal emulation or native host fallback.

## Needs from other tracks

The shared WASI process consumer can encode Waffle's spawn/wait ABI, but the pinned Waffle `d0c5f8a1a9a6723c2f9fccf5df8544b8aad84a00` raw-source loader rejects every existing `runtime_proc` import. An env guest linked to that consumer fails first-use admission with `Cannot instrument WebAssembly: reserved import namespace runtime_proc`, even when asked only to print. The qualified guest therefore keeps only WASI preview1 imports.

Command execution needs source admission for legitimate process imports with automatic interruption intact. The host must also preserve supplied environment and cwd independently: the delivered Shell launcher overwrites `PWD` with cwd, while the generic child starts libc cwd at `/`. An empty replacement environment and a distinct `PWD` value must survive unchanged. Fatal termination must cancel and collect any child jobs even when Rust destructors cannot run. Arbitrary sparse inherited descriptors also need provider enumeration; stdio alone does not establish full descriptor inheritance. These are host capabilities, not env parsing work.

## Source and checks

`uu_env` and `uucore` 0.13.0 come from coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b`. `shell/utilities/env.source.json` records the upstream package, local copy and root MIT license digest. `third-party/uutils-env/provenance.json` records original and shipped file hashes. `wasi.patch` records the WASI-only rejection changes. The notice generator verifies the shipped hashes and collects dependency licenses.

Build this guest with `buildWasiShell(["-p", "shell-utilities", "--bin", "env"])` from `scripts/wasi-build.ts`. It uses wasi-sdk 34.0, Waffle's patched libc, the 256 MiB memory cap and guest verifier.

`cargo test --locked --manifest-path shell/Cargo.toml -p shell-utilities --test env -j2` checks native parser/printing cases and GNU env oracle comparisons. After building the guest and `npm run build:node-harness`, `node --test scripts/test-own-shell-env.ts` checks literal guest environments and lazy installation on Waffle. `npm run build:env:tests && npm run test:env:browser` checks the browser contract, shared input cursor preservation on rejected modes, lazy first use, uninstall and worker cleanup. The browser build needs the env and shell-runtime guests already built and `npm run build:worker` completed. These checks make no whole-shell compatibility score claim.
